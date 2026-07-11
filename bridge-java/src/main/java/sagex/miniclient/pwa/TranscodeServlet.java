package sagex.miniclient.pwa;

import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * HTTP servlet that spawns ffmpeg to transcode a media file and streams
 * fragmented MP4 output to the browser for MSE playback.
 * <p>
 * Usage: GET /transcode?file=/path/to/media.ts&seek=10&session=abc
 */
public class TranscodeServlet extends HttpServlet {
    private static final Logger log = LoggerFactory.getLogger(TranscodeServlet.class);

    private final String ffmpegPath;
    private volatile HwAccel hwAccel;

    public TranscodeServlet(String ffmpegPath, String hwAccelPref) {
        this.ffmpegPath = ffmpegPath;
        // Detect GPU on construction — runs a quick probe
        this.hwAccel = HwAccel.detect(ffmpegPath, hwAccelPref);
        log.info("[Transcode] Hardware acceleration: {} ({})", hwAccel.name, hwAccel.description);
    }

    /** Re-detect hardware acceleration (called when config changes). */
    public void setHwAccel(String preference) {
        this.hwAccel = HwAccel.detect(ffmpegPath, preference);
        log.info("[Transcode] Hardware acceleration changed: {} ({})", hwAccel.name, hwAccel.description);
    }

    /**
     * Resolve a SageTV MediaFile ID to its on-disk absolute path using the
     * in-process SageTV core. Reflection is used so the bridge doesn't need
     * compile-time stubs for sage.Wizard / sage.MediaFile (only sage.Sage is
     * stubbed); the real classes are always present at runtime because the
     * bridge runs as a SageTV plugin inside the server JVM.
     *
     * sage.Wizard.getInstance().getFileForID(id).getFile(0).getAbsolutePath()
     */
    private static String resolveMediaFilePath(int mfid) {
        try {
            Class<?> wizardCls = Class.forName("sage.Wizard");
            Object wizard = wizardCls.getMethod("getInstance").invoke(null);
            Object mf = wizardCls.getMethod("getFileForID", int.class).invoke(wizard, mfid);
            if (mf == null) return null;
            Object f = mf.getClass().getMethod("getFile", int.class).invoke(mf, 0);
            if (f instanceof File) {
                File file = (File) f;
                return file.getAbsolutePath();
            }
        } catch (Throwable t) {
            log.warn("[Transcode] MFID {} resolution failed: {}", mfid, t.toString());
        }
        return null;
    }

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        String filePath = req.getParameter("file");
        String mfidStr = req.getParameter("mfid");
        String seekStr = req.getParameter("seek");
        String sessionId = req.getParameter("session");

        if (sessionId == null || sessionId.isEmpty()) sessionId = "default";
        double seekSec = 0;
        if (seekStr != null) {
            try {
                seekSec = Double.parseDouble(seekStr);
            } catch (NumberFormatException e) {
                // ignore
            }
        }

        // Preferred path (Protocol 2.1 / Option B): the client passes a SageTV
        // MediaFile ID instead of a raw path. We resolve it to the on-disk file
        // via the in-process SageTV core, then transcode/remux to HD fMP4 —
        // completely bypassing the legacy HTTPLS/iosstream 480x272 subsystem.
        if ((filePath == null || filePath.isEmpty()) && mfidStr != null && !mfidStr.isEmpty()) {
            int mfid;
            try {
                mfid = Integer.parseInt(mfidStr.trim());
            } catch (NumberFormatException e) {
                resp.sendError(400, "Invalid mfid");
                return;
            }
            filePath = resolveMediaFilePath(mfid);
            if (filePath == null) {
                resp.sendError(404, "MediaFile " + mfid + " not found or has no file");
                return;
            }
            log.info("[Transcode] Resolved mfid {} -> {}", mfid, filePath);
        }

        if (filePath == null || filePath.isEmpty()) {
            resp.sendError(400, "Missing file or mfid parameter");
            return;
        }

        // Security: only allow absolute paths
        File file = new File(filePath);
        if (!file.isAbsolute()) {
            resp.sendError(400, "File path must be absolute");
            return;
        }

        // Kill any existing transcode for this session
        TranscodeManager.getInstance().kill(sessionId);

        if (!file.exists()) {
            resp.sendError(404, "File not found");
            return;
        }

        // Detect live/growing files (recordings in progress)
        boolean isLive = isFileGrowing(file);

        // Protocol 2.1 remux fast path: if source codecs are already fMP4-compatible
        // (H.264 video + AAC audio), skip re-encoding and just repackage into fMP4.
        // This mirrors the cheap-remux savings the old push+mux.js pipeline provided,
        // without the client-side transmuxer. Skipped on live/growing files because
        // ffprobe on a partial file is fragile; live paths take the full transcode
        // route which streams via pipe:0 feeder.
        String[] sourceCodecs = null;
        boolean useRemux = false;
        if (!isLive) {
            sourceCodecs = probeSourceCodecs(filePath);
            useRemux = canRemuxToFmp4(sourceCodecs);
            if (useRemux) {
                log.info("[Transcode] Fast path: source is H.264+{} - using -c copy remux",
                        sourceCodecs[1] == null ? "<no audio>" : "AAC");
            } else if (sourceCodecs != null) {
                log.info("[Transcode] Source codecs (video={}, audio={}) require full transcode",
                        sourceCodecs[0], sourceCodecs[1]);
            }
        }

        log.info("[Transcode] Starting: file={} seek={}s session={} hwaccel={} live={} exists={} canRead={} remux={}",
                filePath, seekSec, sessionId, hwAccel.name, isLive, file.exists(), file.canRead(), useRemux);

        List<String> ffmpegArgs = useRemux
                ? buildRemuxArgs(filePath, seekSec)
                : buildArgs(filePath, seekSec, hwAccel, isLive);
        log.info("[Transcode] ffmpeg command: {}", String.join(" ", ffmpegArgs));

        ProcessBuilder pb = new ProcessBuilder(ffmpegArgs);
        pb.redirectErrorStream(false);

        Process ffmpeg;
        try {
            ffmpeg = pb.start();
        } catch (IOException e) {
            log.error("[Transcode] ffmpeg spawn error: {}", e.getMessage());
            resp.sendError(500, "ffmpeg error: " + e.getMessage());
            return;
        }

        // If hw accel failed and we detected one, retry with software
        if (!ffmpeg.isAlive() && !"none".equals(hwAccel.name)) {
            log.warn("[Transcode] {} failed (exit {}), falling back to software encoding",
                    hwAccel.name, ffmpeg.exitValue());
            ffmpegArgs = buildArgs(filePath, seekSec, HwAccel.software(), isLive);
            log.info("[Transcode] ffmpeg fallback command: {}", String.join(" ", ffmpegArgs));
            pb = new ProcessBuilder(ffmpegArgs);
            pb.redirectErrorStream(false);
            try {
                ffmpeg = pb.start();
            } catch (IOException e2) {
                log.error("[Transcode] ffmpeg fallback spawn error: {}", e2.getMessage());
                resp.sendError(500, "ffmpeg error: " + e2.getMessage());
                return;
            }
        }

        TranscodeManager.getInstance().register(sessionId, ffmpeg);

        // For live files, start a feeder thread that pipes the growing file to ffmpeg stdin
        Thread fileFeeder = null;
        if (isLive) {
            fileFeeder = startFileFeeder(file, ffmpeg);
        }

        // Log stderr in background
        final String sid = sessionId;
        final Process ffmpegProc = ffmpeg;
        Thread stderrThread = new Thread(() -> {
            try (InputStream stderr = ffmpegProc.getErrorStream()) {
                byte[] buf = new byte[4096];
                int n;
                StringBuilder sb = new StringBuilder();
                while ((n = stderr.read(buf)) != -1) {
                    sb.append(new String(buf, 0, n));
                    if (sb.length() < 2000) {
                        String[] lines = sb.toString().split("\n");
                        for (String line : lines) {
                            if (!line.trim().isEmpty()) {
                                log.debug("[ffmpeg:{}] {}", sid, line.trim());
                            }
                        }
                        sb.setLength(0);
                    }
                }
            } catch (IOException e) {
                // stream closed
            }
        }, "ffmpeg-stderr-" + sessionId);
        stderrThread.setDaemon(true);
        stderrThread.start();

        // Stream ffmpeg stdout -> HTTP response
        resp.setStatus(200);
        resp.setContentType("video/mp4");
        resp.setHeader("Cache-Control", "no-cache, no-store");
        resp.setHeader("Access-Control-Allow-Origin", "*");

        // Commit headers immediately so the browser's fetch() resolves with 200
        // before ffmpeg produces its first bytes
        resp.flushBuffer();
        log.info("[Transcode] Response committed, waiting for ffmpeg data session={}", sessionId);

        long totalWritten = 0;
        try (InputStream ffmpegOut = ffmpeg.getInputStream()) {
            OutputStream httpOut = resp.getOutputStream();
            byte[] buffer = new byte[65536];
            int bytesRead;
            while ((bytesRead = ffmpegOut.read(buffer)) != -1) {
                httpOut.write(buffer, 0, bytesRead);
                httpOut.flush();
                if (totalWritten == 0) {
                    log.info("[Transcode] First chunk: {} bytes, session={}", bytesRead, sessionId);
                }
                totalWritten += bytesRead;
                // Log progress every ~2MB
                if (totalWritten > 0 && (totalWritten % (2 * 1024 * 1024)) < bytesRead) {
                    log.info("[Transcode] Progress: {}KB streamed, session={}", totalWritten / 1024, sessionId);
                }
            }
        } catch (IOException e) {
            // Client disconnected — kill ffmpeg
            log.info("[Transcode] Client disconnected after {}KB, killing session {}", totalWritten / 1024, sessionId);
        } finally {
            // Stop the file feeder thread if active
            if (fileFeeder != null) {
                fileFeeder.interrupt();
            }
            // Only kill our own process — a newer request may have replaced us
            if (ffmpeg.isAlive()) {
                ffmpeg.destroyForcibly();
            }
            TranscodeManager.getInstance().removeIfSame(sessionId, ffmpeg);
        }

        int exitCode = -1;
        try {
            exitCode = ffmpeg.waitFor();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        log.info("[Transcode] ffmpeg exited (code={}) total={}KB session={}", exitCode, totalWritten / 1024, sessionId);
    }

    @Override
    protected void doOptions(HttpServletRequest req, HttpServletResponse resp) {
        resp.setStatus(204);
        resp.setHeader("Access-Control-Allow-Origin", "*");
        resp.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        resp.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }

    /**
     * Build the ffmpeg argument list using the given HwAccel profile.
     * @param isLive true if the file is actively growing (recording in progress);
     *               ffmpeg reads from pipe:0 instead of the file directly.
     */
    private List<String> buildArgs(String filePath, double seekSec, HwAccel accel, boolean isLive) {
        List<String> args = new ArrayList<>();
        args.add(ffmpegPath);

        // Hardware-specific input flags (hwaccel device, output format)
        args.addAll(accel.inputFlags);

        // Seek: for VOD we do a TWO-STAGE seek so audio and video land at the
        // SAME timestamp. A single input -ss on MPEG-2 lands audio and video at
        // slightly different points (no accurate seek) -> A/V drift. Coarse
        // input -ss lands a few seconds BEFORE the target keyframe (fast); a
        // fine OUTPUT -ss after -i then trims to the exact point with A/V
        // aligned. Live uses the feeder thread for positioning, no -ss.
        final double PREROLL_SEC = 10.0;
        boolean doSeek = !isLive && seekSec > 0;
        double fineSs = 0;
        if (doSeek) {
            double coarseSs = Math.max(0, seekSec - PREROLL_SEC);
            fineSs = seekSec - coarseSs;
            if (coarseSs > 0) {
                args.add("-ss");
                args.add(String.valueOf(coarseSs));
            }
        }

        // For live pipe input, specify input format explicitly since ffmpeg can't seek to probe
        if (isLive) {
            String fmt = detectInputFormat(filePath);
            if (fmt != null) {
                args.addAll(java.util.Arrays.asList("-f", fmt));
            }
        }

        args.addAll(java.util.Arrays.asList(
                "-probesize", "5000000",
                "-analyzeduration", "5000000",
                "-err_detect", "ignore_err",
                "-ec", "deblock+guess_mvs",
                "-v", "warning",
                "-y",
                "-threads", "4",
                "-sn",
                "-i", isLive ? "pipe:0" : filePath
        ));

        // Fine OUTPUT seek (accurate, A/V-aligned) — see the two-stage seek note
        // above. Placed after -i so it decodes from the coarse keyframe and
        // discards up to the exact target, keeping audio and video together.
        if (doSeek && fineSs > 0) {
            args.add("-ss");
            args.add(String.valueOf(fineSs));
        }

        args.addAll(java.util.Arrays.asList("-f", "mp4"));

        // Video encoder and its flags. For VOD, drop latency tuning
        // (-tune zerolatency / -tune ll): it strips the buffering/lookahead
        // that keeps A/V aligned and is only appropriate for live streaming.
        args.addAll(java.util.Arrays.asList("-c:v", accel.videoEncoder));
        args.addAll(isLive ? accel.encoderFlags : stripTune(accel.encoderFlags));

        // Scaling: hardware filter or software -s flag
        if (accel.scaleFilter != null) {
            args.addAll(java.util.Arrays.asList("-vf", accel.scaleFilter));
        } else {
            args.addAll(java.util.Arrays.asList("-s", "1280x720"));
        }

        // Common video params
        args.addAll(java.util.Arrays.asList(
            // Keep H.264 output broadly compatible with Safari/iPad decoders.
            "-pix_fmt", "yuv420p",
            "-profile:v", "main",
            "-level", "3.1",
                "-b:v", "2000000",
                "-maxrate", "2500000",
                "-bufsize", "4000000",
                "-r", "30",
                "-vsync", "1",
                "-g", "60",
                "-bf", "0"
        ));

        // Audio + container
        args.addAll(java.util.Arrays.asList(
                "-acodec", "aac",
                // Correct gradual audio drift: resample audio to follow the
                // video timeline (async=1) and pin the first sample to pts 0.
                // Without this MPEG-2 AC3 slowly slips out of sync, worsening
                // after each seek-driven transcode restart.
                "-af", "aresample=async=1:first_pts=0",
                "-b:a", "128000",
                "-ar", "48000",
                "-ac", "2",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                "pipe:1"
        ));

        return args;
    }

    /**
     * Remove a latency-oriented "-tune X" pair (e.g. zerolatency / ll) from an
     * encoder-flags list. Used for VOD, where such tunes hurt A/V sync.
     */
    private static List<String> stripTune(List<String> flags) {
        List<String> out = new ArrayList<>(flags.size());
        for (int i = 0; i < flags.size(); i++) {
            if ("-tune".equals(flags.get(i))) { i++; continue; } // skip flag + value
            out.add(flags.get(i));
        }
        return out;
    }

    /**
     * Check if a file is actively growing (being recorded).
     * Checks size twice with a 500ms delay.
     */
    private boolean isFileGrowing(File file) {
        long size1 = file.length();
        try {
            Thread.sleep(500);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
        long size2 = file.length();
        boolean growing = size2 > size1;
        if (growing) {
            log.info("[Transcode] File is growing: {}B -> {}B (+{}B)", size1, size2, size2 - size1);
        }
        return growing;
    }

    /**
     * Protocol 2.1 remux fast-path helpers.
     *
     * The pwa_mse surface consumes fMP4 via MediaSource. When the source's
     * codecs are already MSE-compatible (H.264 video + AAC audio, or H.264
     * video with no audio) we can skip the ffmpeg re-encode entirely and
     * just repackage into fMP4 with -c copy. Cost is roughly disk+network
     * I/O; no GPU/CPU decode+encode.
     */
    private String[] probeSourceCodecs(String filePath) {
        String ffprobePath = deriveFfprobePath();
        if (ffprobePath == null) {
            log.debug("[Transcode] ffprobe not found next to ffmpeg; skipping remux fast path");
            return null;
        }
        String video = runFfprobe(ffprobePath, filePath, "v:0");
        String audio = runFfprobe(ffprobePath, filePath, "a:0");
        return new String[]{video, audio};
    }

    private String deriveFfprobePath() {
        File f = new File(ffmpegPath);
        if (!f.isAbsolute()) {
            // ffmpeg is on PATH; assume ffprobe is too
            return "ffprobe";
        }
        File parent = f.getParentFile();
        if (parent == null) return null;
        for (String name : new String[]{"ffprobe", "ffprobe.exe"}) {
            File probe = new File(parent, name);
            if (probe.exists() && probe.canExecute()) return probe.getAbsolutePath();
        }
        return null;
    }

    private String runFfprobe(String ffprobePath, String file, String streamSelector) {
        try {
            ProcessBuilder pb = new ProcessBuilder(ffprobePath,
                    "-v", "error",
                    "-select_streams", streamSelector,
                    "-show_entries", "stream=codec_name",
                    "-of", "default=noprint_wrappers=1:nokey=1",
                    file);
            pb.redirectErrorStream(true);
            Process p = pb.start();
            String line;
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                line = r.readLine();
            }
            if (!p.waitFor(3, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                return null;
            }
            if (line == null) return null;
            String v = line.trim().toLowerCase(java.util.Locale.ROOT);
            return v.isEmpty() ? null : v;
        } catch (Exception e) {
            log.debug("[Transcode] ffprobe {} on {} failed: {}", streamSelector, file, e.getMessage());
            return null;
        }
    }

    private boolean canRemuxToFmp4(String[] codecs) {
        if (codecs == null || codecs[0] == null) return false;
        if (!"h264".equals(codecs[0])) return false;
        // No audio stream OR AAC audio -> safe to -c copy.
        return codecs[1] == null || "aac".equals(codecs[1]);
    }

    /**
     * Build ffmpeg args for the remux fast path: -c copy on both streams,
     * fMP4 output to stdout. No hwaccel needed (no decode/encode).
     */
    private List<String> buildRemuxArgs(String filePath, double seekSec) {
        List<String> args = new ArrayList<>();
        args.add(ffmpegPath);
        args.addAll(java.util.Arrays.asList("-v", "warning", "-y"));
        // -ss BEFORE -i = input seek (fast, no re-decode). Correct for -c copy.
        if (seekSec > 0) {
            args.add("-ss");
            args.add(String.valueOf(seekSec));
        }
        args.addAll(java.util.Arrays.asList(
                "-i", filePath,
                "-c:v", "copy",
                "-c:a", "copy",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                "-f", "mp4",
                "pipe:1"
        ));
        return args;
    }

    /**
     * Detect ffmpeg input format from file extension for pipe input.
     */
    private String detectInputFormat(String filePath) {
        String lower = filePath.toLowerCase();
        if (lower.endsWith(".ts")) return "mpegts";
        if (lower.endsWith(".mpg") || lower.endsWith(".mpeg")) return "mpeg";
        return null;
    }

    /**
     * Start a thread that continuously reads a growing file and pipes data to ffmpeg stdin.
     * This allows ffmpeg to transcode a file that is still being recorded (live TV).
     * The thread exits when ffmpeg stops, the file stops growing for 30 seconds,
     * or the thread is interrupted.
     */
    private Thread startFileFeeder(File file, Process ffmpeg) {
        Thread t = new Thread(() -> {
            long totalFed = 0;
            try (RandomAccessFile raf = new RandomAccessFile(file, "r");
                 OutputStream out = ffmpeg.getOutputStream()) {

                byte[] buf = new byte[65536];
                int staleCount = 0;
                while (ffmpeg.isAlive() && staleCount < 150) { // 150 * 200ms = 30s timeout
                    int n = raf.read(buf);
                    if (n > 0) {
                        out.write(buf, 0, n);
                        out.flush();
                        totalFed += n;
                        staleCount = 0;
                    } else {
                        Thread.sleep(200);
                        staleCount++;
                    }
                }
                log.info("[Transcode] File feeder done: {}KB fed, stale={}, ffmpegAlive={}",
                        totalFed / 1024, staleCount, ffmpeg.isAlive());
            } catch (IOException e) {
                log.debug("[Transcode] File feeder pipe closed: {} ({}KB fed)", e.getMessage(), totalFed / 1024);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                log.debug("[Transcode] File feeder interrupted ({}KB fed)", totalFed / 1024);
            }
        }, "file-feeder");
        t.setDaemon(true);
        t.start();
        return t;
    }
}
