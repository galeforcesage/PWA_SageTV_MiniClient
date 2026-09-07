package sagex.miniclient.pwa;

import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Same-origin CORS proxy for the SageTV CMAF/fMP4 HLS endpoint.
 * <p>
 * The SageTV {@code HTTPLSServer} serves CMAF playlists and segments at
 * {@code /iosstream_*_fmp4.m3u8}, {@code *_init.mp4}, and {@code *_N.m4s} on
 * the MediaServer HTTP port (:31099). Those responses lack CORS headers, so
 * hls.js XHR from a different origin (the bridge at :8099) is blocked.
 * <p>
 * This servlet proxies requests through the bridge origin so all CMAF fetches
 * are same-origin. Native Safari {@code <video src>} doesn't need this (simple
 * requests bypass CORS), but it works through this proxy too.
 * <p>
 * {@code GET /cmaf/iosstream_<clientName>_<mfId>_<seg>_<bw>_fmp4.m3u8}
 * {@code GET /cmaf/iosstream_<clientName>_<mfId>_<seg>_<bw>_init.mp4}
 * {@code GET /cmaf/iosstream_<clientName>_<mfId>_<seg>_<bw>_<N>.m4s}
 * <p>
 * Forwards {@code X-Forwarded-For} so the server can distinguish local/remote
 * clients for bitrate policy.
 */
public class CmafProxyServlet extends HttpServlet {
    private static final Logger log = LoggerFactory.getLogger(CmafProxyServlet.class);

    private static final int COPY_BUF = 64 * 1024;

    private final String backendHost;
    private final int backendPort;

    public CmafProxyServlet() {
        this("127.0.0.1", resolveMediaServerHttpPort());
    }

    public CmafProxyServlet(String backendHost, int backendPort) {
        this.backendHost = (backendHost == null || backendHost.trim().isEmpty()) ? "127.0.0.1" : backendHost;
        this.backendPort = backendPort <= 0 ? 31099 : backendPort;
    }

    /** {@code sage.Sage.getInt("http_media_server_port", 31099)} via reflection. */
    private static int resolveMediaServerHttpPort() {
        try {
            Class<?> sage = Class.forName("sage.Sage");
            Object v = sage.getMethod("getInt", String.class, int.class)
                .invoke(null, "http_media_server_port", 31099);
            if (v instanceof Integer) return (Integer) v;
        } catch (Throwable ignore) {
            // Not running inside SageTV — fall back to default
        }
        return 31099;
    }

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        String path = req.getRequestURI();
        // Strip /cmaf/ prefix to get the iosstream_* path
        if (path == null || !path.startsWith("/cmaf/")) {
            resp.sendError(404, "Not found");
            return;
        }
        String iosstreamPath = "/" + path.substring("/cmaf/".length());

        // Validate: must be an iosstream CMAF request
        if (!iosstreamPath.startsWith("/iosstream_")) {
            resp.sendError(400, "Invalid CMAF path");
            return;
        }

        String query = req.getQueryString();
        String target = "http://" + backendHost + ":" + backendPort + iosstreamPath
            + (query == null || query.isEmpty() ? "" : "?" + query);

        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(target).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(30000);
            conn.setInstanceFollowRedirects(false);

            // Forward real client IP
            String clientIp = MediaServerProxyServlet.resolveClientIp(req);
            if (clientIp != null && !clientIp.isEmpty()) {
                conn.setRequestProperty("X-Forwarded-For", clientIp);
            }

            // Forward playback session ID if present (hls.js can send this)
            String sessionId = req.getHeader("x-playback-session-id");
            if (sessionId != null && !sessionId.isEmpty()) {
                conn.setRequestProperty("x-playback-session-id", sessionId);
            }

            int status = conn.getResponseCode();
            resp.setStatus(status);

            // Pass through content type from upstream
            String contentType = conn.getContentType();
            if (contentType != null) {
                resp.setContentType(contentType);
            }

            // Pass through content length (skip for m3u8 — rewriting changes size)
            if (!iosstreamPath.endsWith(".m3u8")) {
                long contentLength = conn.getContentLengthLong();
                if (contentLength >= 0) {
                    resp.setContentLengthLong(contentLength);
                }
            }

            // Init segments and finalized .m4s are immutable — cache aggressively
            if (iosstreamPath.endsWith("_init.mp4") || iosstreamPath.endsWith(".m4s")) {
                resp.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            }

            if (status >= 400) {
                InputStream err = conn.getErrorStream();
                if (err != null) {
                    try (InputStream src = err; OutputStream out = resp.getOutputStream()) {
                        byte[] buf = new byte[COPY_BUF];
                        int n;
                        while ((n = src.read(buf)) != -1) out.write(buf, 0, n);
                    }
                }
                return;
            }

            // For m3u8 playlists: rewrite absolute URLs inside the playlist body
            // to route through this proxy. The server emits absolute URLs like
            // http://<host>:31099/iosstream_..._init.mp4 which would bypass the
            // bridge (CORS failure on hls.js). Rewrite them to /cmaf/iosstream_...
            // so hls.js fetches everything same-origin through this proxy.
            if (iosstreamPath.endsWith(".m3u8")) {
                byte[] body;
                try (InputStream src = conn.getInputStream();
                     java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream()) {
                    byte[] tmp = new byte[COPY_BUF];
                    int n;
                    while ((n = src.read(tmp)) != -1) bos.write(tmp, 0, n);
                    body = bos.toByteArray();
                }
                String playlist = new String(body, java.nio.charset.StandardCharsets.UTF_8);
                // Rewrite absolute iosstream URLs to bridge-relative /cmaf/ paths
                String backendBase = "http://" + backendHost + ":" + backendPort + "/";
                playlist = playlist.replace(backendBase + "iosstream_", "/cmaf/iosstream_");
                // Also handle HOSTNAME placeholder (server may emit before substitution)
                playlist = playlist.replace("http://HOSTNAME/iosstream_", "/cmaf/iosstream_");
                byte[] rewritten = playlist.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                resp.setContentLength(rewritten.length);
                resp.getOutputStream().write(rewritten);
                return;
            }

            try (InputStream src = conn.getInputStream(); OutputStream out = resp.getOutputStream()) {
                byte[] buf = new byte[COPY_BUF];
                int n;
                while ((n = src.read(buf)) != -1) {
                    out.write(buf, 0, n);
                }
            }
        } catch (IOException ioe) {
            log.debug("[CmafProxy] stream error for {}: {}", iosstreamPath, ioe.toString());
            if (!resp.isCommitted()) {
                resp.sendError(502, "CMAF proxy error");
            }
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
