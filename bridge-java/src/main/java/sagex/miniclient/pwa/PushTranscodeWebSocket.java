package sagex.miniclient.pwa;

import org.eclipse.jetty.websocket.api.Session;
import org.eclipse.jetty.websocket.api.WebSocketListener;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

/**
 * WebSocket endpoint that transcodes pushed MPEG data to fMP4 in real time.
 * <p>
 * The browser sends raw MPEG-PS/TS bytes (from SageTV push mode) over WebSocket.
 * This class pipes them into ffmpeg stdin. ffmpeg outputs fragmented MP4 which
 * is sent back over the same WebSocket as binary frames.
 * <p>
 * This enables live TV playback: SageTV pushes live MPEG data to the PWA client,
 * the client relays it here, and we transcode to browser-playable fMP4.
 */
public class PushTranscodeWebSocket implements WebSocketListener {
    private static final Logger log = LoggerFactory.getLogger(PushTranscodeWebSocket.class);

    private Session wsSession;
    private Process ffmpeg;
    private OutputStream ffmpegStdin;
    private Thread ffmpegReaderThread;
    private Thread ffmpegStderrThread;
    private volatile boolean closed = false;
    private long bytesIn = 0;
    private long bytesOut = 0;
    private final String ffmpegPath;

    public PushTranscodeWebSocket(String ffmpegPath) {
        this.ffmpegPath = ffmpegPath;
    }

    @Override
    public void onWebSocketConnect(Session session) {
        this.wsSession = session;
        log.info("[PushTranscode] WebSocket connected");

        // Detect hardware acceleration
        HwAccel accel = HwAccel.detect(ffmpegPath, "auto");
        log.info("[PushTranscode] Using {} ({})", accel.name, accel.description);

        List<String> args = buildArgs(accel);
        log.info("[PushTranscode] ffmpeg command: {}", String.join(" ", args));

        ProcessBuilder pb = new ProcessBuilder(args);
        pb.redirectErrorStream(false);

        try {
            ffmpeg = pb.start();
        } catch (IOException e) {
            log.error("[PushTranscode] ffmpeg spawn error: {}", e.getMessage());
            closeSession(4002, "ffmpeg spawn failed");
            return;
        }

        ffmpegStdin = ffmpeg.getOutputStream();

        // Read ffmpeg stdout (fMP4) and send back over WebSocket
        ffmpegReaderThread = new Thread(this::readFfmpegOutput, "push-transcode-reader");
        ffmpegReaderThread.setDaemon(true);
        ffmpegReaderThread.start();

        // Log ffmpeg stderr
        ffmpegStderrThread = new Thread(this::readFfmpegStderr, "push-transcode-stderr");
        ffmpegStderrThread.setDaemon(true);
        ffmpegStderrThread.start();
    }

    @Override
    public void onWebSocketBinary(byte[] payload, int offset, int len) {
        if (ffmpegStdin == null || closed) return;

        try {
            ffmpegStdin.write(payload, offset, len);
            ffmpegStdin.flush();
            bytesIn += len;
        } catch (IOException e) {
            log.debug("[PushTranscode] ffmpeg stdin write error: {}", e.getMessage());
            cleanup();
        }
    }

    @Override
    public void onWebSocketText(String message) {
        // Ignore text frames
    }

    @Override
    public void onWebSocketClose(int statusCode, String reason) {
        log.info("[PushTranscode] WebSocket closed (code={}, in={}KB, out={}KB)",
                statusCode, bytesIn / 1024, bytesOut / 1024);
        cleanup();
    }

    @Override
    public void onWebSocketError(Throwable cause) {
        log.error("[PushTranscode] WebSocket error: {}", cause.getMessage());
        cleanup();
    }

    private void readFfmpegOutput() {
        try (InputStream stdout = ffmpeg.getInputStream()) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = stdout.read(buf)) != -1 && !closed) {
                bytesOut += n;
                if (wsSession != null && wsSession.isOpen()) {
                    wsSession.getRemote().sendBytes(ByteBuffer.wrap(buf, 0, n));
                }
                if (bytesOut == n) {
                    log.info("[PushTranscode] First output chunk: {}B", n);
                }
                // Log progress every ~2MB
                if (bytesOut > 0 && (bytesOut % (2 * 1024 * 1024)) < n) {
                    log.info("[PushTranscode] Progress: in={}KB out={}KB", bytesIn / 1024, bytesOut / 1024);
                }
            }
        } catch (IOException e) {
            if (!closed) {
                log.debug("[PushTranscode] ffmpeg stdout read ended: {}", e.getMessage());
            }
        }
        log.info("[PushTranscode] ffmpeg output stream ended, total out={}KB", bytesOut / 1024);
    }

    private void readFfmpegStderr() {
        try (InputStream stderr = ffmpeg.getErrorStream()) {
            byte[] buf = new byte[4096];
            int n;
            StringBuilder sb = new StringBuilder();
            while ((n = stderr.read(buf)) != -1) {
                sb.append(new String(buf, 0, n));
                // Log first 2KB of stderr then discard
                if (sb.length() < 2000) {
                    String[] lines = sb.toString().split("\n");
                    for (String line : lines) {
                        if (!line.trim().isEmpty()) {
                            log.debug("[ffmpeg:push] {}", line.trim());
                        }
                    }
                    sb.setLength(0);
                }
            }
        } catch (IOException e) {
            // stream closed
        }
    }

    private void cleanup() {
        if (closed) return;
        closed = true;

        // Close ffmpeg stdin to signal EOF
        if (ffmpegStdin != null) {
            try { ffmpegStdin.close(); } catch (IOException e) { /* ignore */ }
        }

        if (ffmpeg != null && ffmpeg.isAlive()) {
            ffmpeg.destroyForcibly();
        }

        closeSession(1000, "done");
    }

    private void closeSession(int code, String reason) {
        if (wsSession != null && wsSession.isOpen()) {
            try { wsSession.close(code, reason); } catch (Exception e) { /* ignore */ }
        }
    }

    private List<String> buildArgs(HwAccel accel) {
        List<String> args = new ArrayList<>();
        args.add(ffmpegPath);

        // Hardware-specific input flags
        args.addAll(accel.inputFlags);

        args.addAll(List.of(
                "-probesize", "500000",
                "-analyzeduration", "500000",
                "-fflags", "+nobuffer+flush_packets",
                "-flags", "+low_delay",
                "-err_detect", "ignore_err",
                "-ec", "deblock+guess_mvs",
                "-v", "warning",
                "-y",
                "-threads", "4",
                "-sn",
                "-f", "mpeg",
                "-i", "pipe:0",
                "-f", "mp4"
        ));

        // Video encoder
        args.addAll(List.of("-c:v", accel.videoEncoder));
        args.addAll(accel.encoderFlags);

        // Scaling
        if (accel.scaleFilter != null) {
            args.addAll(List.of("-vf", accel.scaleFilter));
        } else {
            args.addAll(List.of("-s", "1280x720"));
        }

        // Video params — lower latency for live
        args.addAll(List.of(
                "-b:v", "2000000",
                "-maxrate", "2500000",
                "-bufsize", "1000000",
                "-r", "30",
                "-g", "30",
                "-bf", "0"
        ));

        // Audio + fragmented MP4 output
        args.addAll(List.of(
                "-acodec", "aac",
                "-b:a", "128000",
                "-ar", "48000",
                "-ac", "2",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                "-frag_duration", "500000",
                "pipe:1"
        ));

        return args;
    }
}
