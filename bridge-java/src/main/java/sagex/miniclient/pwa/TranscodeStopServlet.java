package sagex.miniclient.pwa;

import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

import java.io.IOException;

/**
 * Stop endpoint for active transcode sessions.
 * Usage: GET /transcode/stop?session=abc
 */
public class TranscodeStopServlet extends HttpServlet {

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        String sessionId = req.getParameter("session");
        if (sessionId == null || sessionId.isEmpty()) sessionId = "default";

        TranscodeManager.getInstance().kill(sessionId);

        resp.setStatus(200);
        resp.setContentType("text/plain");
        resp.setHeader("Access-Control-Allow-Origin", "*");
        resp.getWriter().write("OK");
    }

    @Override
    protected void doOptions(HttpServletRequest req, HttpServletResponse resp) {
        resp.setStatus(204);
        resp.setHeader("Access-Control-Allow-Origin", "*");
        resp.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        resp.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
}
