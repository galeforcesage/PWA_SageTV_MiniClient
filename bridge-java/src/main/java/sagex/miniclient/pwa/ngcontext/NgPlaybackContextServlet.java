package sagex.miniclient.pwa.ngcontext;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;

/**
 * HTTP servlet that exposes the NG Playback Context for the active PWA session.
 * <p>
 * Endpoint: GET /ng/playback-context/current
 * <p>
 * Success response (200):
 * <pre>{@code
 * {
 *   "type": "NG_PLAYBACK_CONTEXT",
 *   "sessionId": "...",
 *   "context": { ... }
 * }
 * }</pre>
 * <p>
 * Unavailable response (200):
 * <pre>{@code
 * {
 *   "type": "NG_PLAYBACK_CONTEXT_UNAVAILABLE",
 *   "reason": "no_active_session|server_not_supported|bridge_not_wired|unknown_session"
 * }
 * }</pre>
 * <p>
 * Security:
 * <ul>
 *   <li>Never exposes internal sessionKey values</li>
 *   <li>Never exposes clientName:mediaFileId:openGeneration internals</li>
 *   <li>Never enumerates all server sessions</li>
 *   <li>Only returns context for the single active PWA session (when mapping is wired)</li>
 * </ul>
 */
public class NgPlaybackContextServlet extends HttpServlet {
    private static final Logger log = LoggerFactory.getLogger(NgPlaybackContextServlet.class);

    private volatile NgPlaybackContextBridgeProvider provider;

    public NgPlaybackContextServlet(NgPlaybackContextBridgeProvider provider) {
        this.provider = provider != null ? provider : new NoopNgPlaybackContextBridgeProvider();
    }

    /**
     * Replace the active provider at runtime (e.g. when session mapping becomes available).
     */
    public void setProvider(NgPlaybackContextBridgeProvider provider) {
        this.provider = provider != null ? provider : new NoopNgPlaybackContextBridgeProvider();
    }

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        resp.setContentType("application/json");
        resp.setCharacterEncoding("UTF-8");
        resp.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        resp.setHeader("Access-Control-Allow-Origin", "*");

        // Route within /ng/* prefix mapping
        String pathInfo = req.getPathInfo();
        if (pathInfo == null) pathInfo = "";
        // Also check servletPath for exact-match deployments
        String servletPath = req.getServletPath();
        String fullPath = servletPath + pathInfo;

        // Accept both /ng/playback-context/current (prefix) and the full path (exact)
        if (!"/playback-context/current".equals(pathInfo)
                && !"/ng/playback-context/current".equals(fullPath)
                && !"/ng/playback-context/current".equals(servletPath)) {
            // Unknown /ng/* route — return JSON 404, never HTML
            resp.setStatus(HttpServletResponse.SC_NOT_FOUND);
            resp.getWriter().write("{\"type\":\"NG_PLAYBACK_CONTEXT_UNAVAILABLE\",\"reason\":\"unknown_ng_route\"}");
            return;
        }

        NgPlaybackContextBridgeProvider.Result result;
        try {
            result = provider.getCurrent();
        } catch (Exception e) {
            log.error("[NgContext] Provider threw exception", e);
            result = NgPlaybackContextBridgeProvider.Result.unavailable("bridge_not_wired");
        }

        String json;
        if (result.isAvailable()) {
            json = buildAvailableResponse(result.getSessionId(), result.getContextJson());
        } else {
            json = buildUnavailableResponse(result.getUnavailableReason());
        }

        resp.getWriter().write(json);
    }

    @Override
    protected void doOptions(HttpServletRequest req, HttpServletResponse resp) {
        resp.setStatus(HttpServletResponse.SC_NO_CONTENT);
        resp.setHeader("Access-Control-Allow-Origin", "*");
        resp.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        resp.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }

    private String buildAvailableResponse(String sessionId, String contextJson) {
        StringBuilder sb = new StringBuilder(256);
        sb.append("{\"type\":\"NG_PLAYBACK_CONTEXT\"");
        sb.append(",\"sessionId\":\"").append(escapeJson(sessionId)).append("\"");
        sb.append(",\"context\":").append(contextJson != null ? contextJson : "{}");
        sb.append("}");
        return sb.toString();
    }

    private String buildUnavailableResponse(String reason) {
        return "{\"type\":\"NG_PLAYBACK_CONTEXT_UNAVAILABLE\",\"reason\":\"" + escapeJson(reason) + "\"}";
    }

    /** Minimal JSON string escape (no external deps). */
    private static String escapeJson(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.toString();
    }
}
