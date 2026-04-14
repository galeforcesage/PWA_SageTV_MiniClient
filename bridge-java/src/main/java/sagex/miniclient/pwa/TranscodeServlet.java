package sagex.miniclient.pwa;

import jakarta.servlet.AsyncContext;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.List;

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

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        String filePath = req.getParameter("file");
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

        if (filePath == null || filePath.isEmpty()) {
            resp.sendError(400, "Missing file parameter");
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

        log.info("[Transcode] Starting: file={} seek={}s session={} hwaccel={} live={} exists={} canRead={}",
                filePath, seekSec, sessionId, hwAccel.name, isLive, file.exists(), file.canRead());

        List<String> ffmpegArgs = buildArgs(filePath, seekSec, hwAccel, isLive);
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

        // For live pipe input, don't use -ss (feeder thread handles position)
        if (!isLive && seekSec > 0) {
            args.add("-ss");
            args.add(String.valueOf(seekSec));
        }

        // For live pipe input, specify input format explicitly since ffmpeg can't seek to probe
        if (isLive) {
            String fmt = detectInputFormat(filePath);
            if (fmt != null) {
                args.addAll(List.of("-f", fmt));
            }
        }

        args.addAll(List.of(
                "-probesize", "5000000",
                "-analyzeduration", "5000000",
                "-err_detect", "ignore_err",
                "-ec", "deblock+guess_mvs",
                "-v", "warning",
                "-y",
                "-threads", "4",
                "-sn",
                "-i", isLive ? "pipe:0" : filePath,
                "-f", "mp4"
        ));

        // Video encoder and its flags
        args.addAll(List.of("-c:v", accel.videoEncoder));
        args.addAll(accel.encoderFlags);

        // Scaling: hardware filter or software -s flag
        if (accel.scaleFilter != null) {
            args.addAll(List.of("-vf", accel.scaleFilter));
        } else {
            args.addAll(List.of("-s", "1280x720"));
        }

        // Common video params
        args.addAll(List.of(
                "-b:v", "2000000",
                "-maxrate", "2500000",
                "-bufsize", "4000000",
                "-r", "30",
                "-g", "60",
                "-bf", "0"
        ));

        // Audio + container
        args.addAll(List.of(
                "-acodec", "aac",
                "-b:a", "128000",
                "-ar", "48000",
                "-ac", "2",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                "pipe:1"
        ));

        return args;
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
