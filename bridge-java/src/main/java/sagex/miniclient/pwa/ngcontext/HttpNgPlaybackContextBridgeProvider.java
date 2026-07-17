package sagex.miniclient.pwa.ngcontext;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Future HTTP-based provider that calls the SageTV server's NG context endpoint.
 * <p>
 * Intended for use when the bridge runs outside the SageTV JVM and must call:
 * <pre>
 *   GET http://{sageHost}:{sagePort}/ng/playback-context/{sessionId}
 * </pre>
 * <p>
 * <b>Phase 1 status:</b> This class exists as a skeleton. It cannot be used until:
 * <ol>
 *   <li>The SageTV server exposes an NG playback context HTTP endpoint</li>
 *   <li>Active session ID mapping is wired in the bridge (see TODO below)</li>
 * </ol>
 *
 * TODO: Wire active session ID mapping — the bridge must know which PWA connection
 *       corresponds to which SageTV MiniClient session. This mapping does not currently
 *       exist. Possible sources:
 *       - BridgeWebSocket could track the MAC/clientId from the initial handshake
 *       - The PWA client could send its session identifier via a control message
 *       - The bridge could maintain a registry of active WebSocket→sessionId mappings
 */
public class HttpNgPlaybackContextBridgeProvider implements NgPlaybackContextBridgeProvider {
    private static final Logger log = LoggerFactory.getLogger(HttpNgPlaybackContextBridgeProvider.class);
    private static final int CONNECT_TIMEOUT_MS = 2000;
    private static final int READ_TIMEOUT_MS = 3000;

    private final String sageHost;
    private final int sagePort;

    /**
     * @param sageHost SageTV server hostname
     * @param sagePort SageTV server HTTP API port
     */
    public HttpNgPlaybackContextBridgeProvider(String sageHost, int sagePort) {
        this.sageHost = sageHost;
        this.sagePort = sagePort;
    }

    @Override
    public Result getCurrent() {
        // TODO: Resolve active session ID for the requesting PWA client.
        // Until session mapping is wired, we cannot determine which session to query.
        // Return unavailable with a clear reason.
        String activeSessionId = resolveActiveSessionId();
        if (activeSessionId == null) {
            return Result.unavailable("no_active_session");
        }

        try {
            String url = String.format("http://%s:%d/ng/playback-context/%s", sageHost, sagePort, activeSessionId);
            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestProperty("Accept", "application/json");

            int status = conn.getResponseCode();
            if (status == 200) {
                String body = readBody(conn.getInputStream());
                return Result.available(activeSessionId, body);
            } else if (status == 404) {
                return Result.unavailable("no_active_session");
            } else {
                log.warn("[NgContext] Server returned HTTP {}", status);
                return Result.unavailable("server_not_supported");
            }
        } catch (Exception e) {
            log.warn("[NgContext] HTTP request failed: {}", e.getMessage());
            return Result.unavailable("server_not_supported");
        }
    }

    /**
     * TODO: Implement active session resolution.
     * This must map the current PWA client request to a specific SageTV session ID.
     * Must NOT enumerate all sessions. Must NOT expose internal sessionKey.
     *
     * @return opaque session ID or null if mapping not available
     */
    private String resolveActiveSessionId() {
        // Phase 1: no mapping exists yet
        return null;
    }

    private String readBody(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) != -1) {
            out.write(buf, 0, n);
        }
        return out.toString("UTF-8");
    }
}
