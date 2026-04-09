package sagex.miniclient.pwa;

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

    private Session wsSession;
    private Socket tcpSocket;
    private OutputStream tcpOut;
    private Thread tcpReaderThread;
    private volatile boolean closed = false;
    private String channel;
    private long bytesSentToTcp = 0;
    private long bytesRecvFromTcp = 0;

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
        log.info("[Bridge] WebSocket closed for {} (code={}, sent={}B, recv={}B)",
                channel, statusCode, bytesSentToTcp, bytesRecvFromTcp);
        cleanup();
    }

    @Override
    public void onWebSocketError(Throwable cause) {
        log.error("[Bridge] WebSocket error for {}: {}", channel, cause.getMessage());
        cleanup();
    }

    /**
     * Read loop: TCP socket -> WebSocket binary frames.
     */
    private void readTcpLoop() {
        byte[] buffer = new byte[65536];
        try {
            InputStream in = tcpSocket.getInputStream();
            int bytesRead;
            while (!closed && (bytesRead = in.read(buffer)) != -1) {
                bytesRecvFromTcp += bytesRead;
                if (wsSession != null && wsSession.isOpen()) {
                    wsSession.getRemote().sendBytes(ByteBuffer.wrap(buffer, 0, bytesRead));
                } else {
                    break;
                }
            }
        } catch (IOException e) {
            if (!closed) {
                log.debug("[Bridge] TCP read ended for {}: {}", channel, e.getMessage());
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
