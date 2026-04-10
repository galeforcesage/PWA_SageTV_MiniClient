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

    public TranscodeServlet(String ffmpegPath) {
        this.ffmpegPath = ffmpegPath;
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

        log.info("[Transcode] Starting: file={} seek={}s session={} exists={} canRead={}",
                filePath, seekSec, sessionId, file.exists(), file.canRead());

        List<String> ffmpegArgs = new ArrayList<>();
        ffmpegArgs.add(ffmpegPath);

        if (seekSec > 0) {
            ffmpegArgs.add("-ss");
            ffmpegArgs.add(String.valueOf(seekSec));
        }

        ffmpegArgs.addAll(List.of(
                "-probesize", "5000000",
                "-analyzeduration", "5000000",
                "-err_detect", "ignore_err",
                "-ec", "deblock+guess_mvs",
                "-v", "warning",
                "-y",
                "-threads", "4",
                "-sn",
                "-i", filePath,
                "-f", "mp4",
                "-vcodec", "libx264",
                "-preset", "veryfast",
                "-tune", "zerolatency",
                "-b:v", "2000000",
                "-maxrate", "2500000",
                "-bufsize", "4000000",
                "-r", "30",
                "-s", "1280x720",
                "-g", "60",
                "-bf", "0",
                "-acodec", "aac",
                "-b:a", "128000",
                "-ar", "48000",
                "-ac", "2",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                "pipe:1"
        ));

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

        TranscodeManager.getInstance().register(sessionId, ffmpeg);

        // Log stderr in background
        final String sid = sessionId;
        Thread stderrThread = new Thread(() -> {
            try (InputStream stderr = ffmpeg.getErrorStream()) {
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
}
