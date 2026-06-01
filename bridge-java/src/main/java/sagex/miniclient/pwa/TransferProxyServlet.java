package sagex.miniclient.pwa;

import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * HTTPS proxy for SageTV transfer endpoints.
 *
 * Browser downloads happen from the bridge origin (https://host:8099) while
 * this servlet forwards to the Sage transfer server (http://127.0.0.1:31099).
 */
public class TransferProxyServlet extends HttpServlet {
    private static final Logger log = LoggerFactory.getLogger(TransferProxyServlet.class);

    private final String backendHost;
    private final int backendPort;

    public TransferProxyServlet(String backendHost, int backendPort) {
        this.backendHost = (backendHost == null || backendHost.isBlank()) ? "127.0.0.1" : backendHost;
        this.backendPort = backendPort <= 0 ? 31099 : backendPort;
    }

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        proxy(req, resp, false);
    }

    @Override
    protected void doHead(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        proxy(req, resp, true);
    }

    private void proxy(HttpServletRequest req, HttpServletResponse resp, boolean headOnly) throws IOException {
        String path = req.getRequestURI();
        if (path == null || !path.startsWith("/api/transfers/")) {
            resp.sendError(404, "Not found");
            return;
        }

        String query = req.getQueryString();
        String target = "http://" + backendHost + ":" + backendPort + path + (query == null || query.isEmpty() ? "" : "?" + query);

        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(target).openConnection();
            conn.setRequestMethod(headOnly ? "HEAD" : "GET");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(60000);
            conn.setInstanceFollowRedirects(false);

            String range = req.getHeader("Range");
            if (range != null && !range.isEmpty()) {
                conn.setRequestProperty("Range", range);
            }

            String token = req.getHeader("X-Transfer-Token");
            if (token != null && !token.isEmpty()) {
                conn.setRequestProperty("X-Transfer-Token", token);
            }

            int status = conn.getResponseCode();
            resp.setStatus(status);

            copyHeader(conn, resp, "Content-Type");
            copyHeader(conn, resp, "Content-Disposition");
            copyHeader(conn, resp, "Content-Length");
            copyHeader(conn, resp, "Content-Range");
            copyHeader(conn, resp, "Accept-Ranges");
            copyHeader(conn, resp, "Cache-Control");

            if (headOnly) {
                return;
            }

            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (in == null) {
                return;
            }

            try (InputStream src = in; OutputStream out = resp.getOutputStream()) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = src.read(buf)) != -1) {
                    out.write(buf, 0, n);
                }
            }
        } catch (IOException e) {
            log.warn("[TransferProxy] Failed forwarding {}: {}", target, e.getMessage());
            if (!resp.isCommitted()) {
                resp.sendError(502, "Transfer proxy backend unavailable");
            }
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private static void copyHeader(HttpURLConnection conn, HttpServletResponse resp, String name) {
        String val = conn.getHeaderField(name);
        if (val != null && !val.isEmpty()) {
            resp.setHeader(name, val);
        }
    }
}
