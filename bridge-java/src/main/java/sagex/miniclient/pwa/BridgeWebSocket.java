package sagex.miniclient.pwa;

import sagex.miniclient.pwa.ngcontext.ActivePlaybackSessionTracker;

import org.eclipse.jetty.websocket.api.Session;
import org.eclipse.jetty.websocket.api.WebSocketListener;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.net.URI;
import java.nio.ByteBuffer;

/**
 * WebSocket-to-TCP relay.
 * <p>
 * Bridges a browser WebSocket connection to a SageTV server TCP socket.
 * Binary frames are forwarded in both directions. Text frames are handled
 * as JSON control messages (ping/pong).
 */
public class BridgeWebSocket implements WebSocketListener {
    private static final Logger log = LoggerFactory.getLogger(BridgeWebSocket.class);
    private static final int DEFAULT_SAGE_PORT = 31099;

    // ── TCP→WS coalescing (BRIDGE1) ─────────────────────────────────────────
    // During a SageTV GFX burst the server emits many small TCP writes. Sending
    // one WebSocket binary frame per TCP read floods the browser with onmessage
    // events — a measurable main-thread cost on iPad Safari and Samsung Tizen
    // during menu repaint. Coalescing accumulates the burst into fewer, larger
    // frames. It is a transparent byte-pipe optimization: payload bytes and
    // order are never altered, so it needs no SageTV protocol cooperation.
    //
    // The batch is flushed when it reaches COALESCE_MAX_BYTES or when the socket
    // has no more immediately-available data (end of burst). Flushing on drain
    // means frame-boundary bytes (e.g. FLIPBUFFER) are never delayed — the
    // coalescing adds zero latency, it only removes redundant tiny frames.
    //
    // Tunable via env var (preferred) or -D system property; set max bytes <= 0
    // to disable and restore the original one-frame-per-read behavior.
    private static final int COALESCE_MAX_BYTES =
            cfgInt("WS_COALESCE_MAX_BYTES", "pwa.ws.coalesceMaxBytes", 262144);
    private static final boolean COALESCE_ENABLED = COALESCE_MAX_BYTES > 0;

    private Session wsSession;
    private Socket tcpSocket;
    private OutputStream tcpOut;
    private Thread tcpReaderThread;
    private volatile boolean closed = false;
    private String channel;
    private String connectionId;
    private long bytesSentToTcp = 0;
    private long bytesRecvFromTcp = 0;
    private long tcpReads = 0;
    private long wsFramesOut = 0;

    // Shared session tracker — set via static setter (singleton per bridge instance)
    private static volatile ActivePlaybackSessionTracker sessionTracker;

    /** Set the shared session tracker (called once at bridge startup). */
    public static void setSessionTracker(ActivePlaybackSessionTracker tracker) {
        sessionTracker = tracker;
    }

    /** Resolve an int knob from env var, then -D system property, then default. */
    private static int cfgInt(String envName, String propName, int defaultValue) {
        String raw = System.getenv(envName);
        if (raw == null || raw.trim().isEmpty()) {
            raw = System.getProperty(propName);
        }
        if (raw != null && !raw.trim().isEmpty()) {
            try {
                return Integer.parseInt(raw.trim());
            } catch (NumberFormatException e) {
                log.warn("[Bridge] Invalid {}='{}', using default {}", envName, raw, defaultValue);
            }
        }
        return defaultValue;
    }

    @Override
    public void onWebSocketConnect(Session session) {
        this.wsSession = session;
        URI uri = session.getUpgradeRequest().getRequestURI();
        this.channel = uri.getPath(); // /gfx, /media, or /reconnect

        // Parse host and port from query params
        String query = uri.getQuery();
        String sageHost = getQueryParam(query, "host", "");
        int sagePort = Integer.parseInt(getQueryParam(query, "port", String.valueOf(DEFAULT_SAGE_PORT)));

        if (sageHost.isEmpty()) {
            log.error("[Bridge] Missing host parameter for {}", channel);
            try {
                session.close(4001, "Missing host parameter");
            } catch (Exception e) {
                // ignore
            }
            return;
        }

        log.info("[Bridge] New {} connection -> {}:{}", channel, sageHost, sagePort);

        // Register with session tracker
        if (sessionTracker != null) {
            connectionId = sessionTracker.onConnect(channel);
        }

        // Connect to SageTV TCP
        try {
            tcpSocket = new Socket(sageHost, sagePort);
            tcpSocket.setTcpNoDelay(true);
            tcpOut = tcpSocket.getOutputStream();
            log.info("[Bridge] TCP connected to {}:{} for {}", sageHost, sagePort, channel);
        } catch (IOException e) {
            log.error("[Bridge] TCP connect failed for {}: {}", channel, e.getMessage());
            try {
                session.close(4003, "TCP connect failed: " + e.getMessage());
            } catch (Exception ex) {
                // ignore
            }
            return;
        }

        // Start thread to read TCP -> WebSocket
        tcpReaderThread = new Thread(() -> readTcpLoop(), "tcp-reader-" + channel);
        tcpReaderThread.setDaemon(true);
        tcpReaderThread.start();
    }

    @Override
    public void onWebSocketBinary(byte[] payload, int offset, int len) {
        if (tcpOut == null || closed) return;

        try {
            tcpOut.write(payload, offset, len);
            tcpOut.flush();
            bytesSentToTcp += len;
        } catch (IOException e) {
            log.error("[Bridge] TCP write error for {}: {}", channel, e.getMessage());
            cleanup();
        }
    }

    @Override
    public void onWebSocketText(String message) {
        // Handle JSON control messages (ping/pong)
        if (message.contains("\"ping\"")) {
            try {
                wsSession.getRemote().sendString("{\"type\":\"pong\"}");
            } catch (IOException e) {
                log.warn("[Bridge] Failed to send pong: {}", e.getMessage());
            }
        } else {
            log.warn("[Bridge] Unexpected text frame on {}: {}",
                    channel, message.length() > 80 ? message.substring(0, 80) : message);
        }
    }

    @Override
    public void onWebSocketClose(int statusCode, String reason) {
        // wsFramesOut vs tcpReads shows the coalescing ratio (lower frames =
        // fewer browser onmessage events per GFX burst).
        log.info("[Bridge] WebSocket closed for {} (code={}, sent={}B, recv={}B, tcpReads={}, wsFrames={})",
                channel, statusCode, bytesSentToTcp, bytesRecvFromTcp, tcpReads, wsFramesOut);
        cleanup();
    }

    @Override
    public void onWebSocketError(Throwable cause) {
        log.error("[Bridge] WebSocket error for {}: {}", channel, cause.getMessage());
        cleanup();
    }

    /**
     * Read loop: TCP socket -> WebSocket binary frames.
     * <p>
     * When coalescing is enabled, consecutive TCP reads that arrive back-to-back
     * (a GFX burst) are merged into a single WebSocket binary frame, bounded by
     * COALESCE_MAX_BYTES, and flushed as soon as the socket drains. Byte order
     * and payload are preserved exactly.
     * <p>
     * Backpressure is inherent: {@code sendBytes} is a blocking call, so a slow
     * browser stalls this reader, which in turn stops draining the SageTV TCP
     * socket and lets TCP flow control push back on the server. There is no
     * unbounded server-side send queue to guard.
     */
    private void readTcpLoop() {
        final byte[] buffer = new byte[65536];
        // Reusable batch accumulator (grows if a single read exceeds it). Wrapped
        // without copying for the blocking send, then reset after the send returns.
        byte[] batchBuf = new byte[COALESCE_ENABLED ? COALESCE_MAX_BYTES : 65536];
        int batchLen = 0;
        try {
            InputStream in = tcpSocket.getInputStream();
            int bytesRead;
            while (!closed && (bytesRead = in.read(buffer)) != -1) {
                bytesRecvFromTcp += bytesRead;
                tcpReads++;
                if (wsSession == null || !wsSession.isOpen()) {
                    break;
                }

                if (!COALESCE_ENABLED) {
                    // Original behavior: one WebSocket frame per TCP read.
                    wsSession.getRemote().sendBytes(ByteBuffer.wrap(buffer, 0, bytesRead));
                    wsFramesOut++;
                    continue;
                }

                // Append this read to the pending batch (grow if needed).
                if (batchLen + bytesRead > batchBuf.length) {
                    int grown = Math.max(batchBuf.length * 2, batchLen + bytesRead);
                    batchBuf = java.util.Arrays.copyOf(batchBuf, grown);
                }
                System.arraycopy(buffer, 0, batchBuf, batchLen, bytesRead);
                batchLen += bytesRead;

                // Flush when the batch is large enough, or when the socket has no
                // more immediately-available data (end of the current burst).
                boolean full = batchLen >= COALESCE_MAX_BYTES;
                boolean drained = in.available() <= 0;
                if (full || drained) {
                    wsSession.getRemote().sendBytes(ByteBuffer.wrap(batchBuf, 0, batchLen));
                    wsFramesOut++;
                    batchLen = 0;
                }
            }
        } catch (IOException e) {
            if (!closed) {
                log.debug("[Bridge] TCP read ended for {}: {}", channel, e.getMessage());
            }
        } finally {
            // Flush any residual batched bytes before the socket closes.
            if (batchLen > 0 && wsSession != null && wsSession.isOpen()) {
                try {
                    wsSession.getRemote().sendBytes(ByteBuffer.wrap(batchBuf, 0, batchLen));
                    wsFramesOut++;
                } catch (IOException ignore) {
                    // connection is going away anyway
                }
            }
        }

        // TCP closed — close WebSocket too
        if (wsSession != null && wsSession.isOpen()) {
            try {
                wsSession.close(1000, "TCP connection closed");
            } catch (Exception e) {
                // ignore
            }
        }
    }

    private void cleanup() {
        closed = true;
        // Disconnect from session tracker (idempotent)
        if (sessionTracker != null && connectionId != null) {
            sessionTracker.onDisconnect(connectionId);
        }
        try {
            if (tcpSocket != null && !tcpSocket.isClosed()) {
                tcpSocket.close();
            }
        } catch (IOException e) {
            // ignore
        }
        if (tcpReaderThread != null) {
            tcpReaderThread.interrupt();
        }
    }

    private static String getQueryParam(String query, String name, String defaultValue) {
        if (query == null) return defaultValue;
        for (String param : query.split("&")) {
            String[] kv = param.split("=", 2);
            if (kv.length == 2 && kv[0].equals(name)) {
                return kv[1];
            }
        }
        return defaultValue;
    }
}
