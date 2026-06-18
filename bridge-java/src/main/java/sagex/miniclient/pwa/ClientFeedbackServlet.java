package sagex.miniclient.pwa;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Receives runtime capability feedback from the PWA and persists/refines
 * per-client capability profiles.
 *
 * POST /api/client-feedback
 * GET  /api/client-feedback[?clientId=...]
 */
public class ClientFeedbackServlet extends HttpServlet {
    private static final Logger log = LoggerFactory.getLogger(ClientFeedbackServlet.class);

    private final ClientCapabilityProfileStore profileStore;
    private final ObjectMapper mapper;

    public ClientFeedbackServlet(ClientCapabilityProfileStore profileStore) {
        this.profileStore = profileStore;
        this.mapper = new ObjectMapper()
                .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
    }

    @Override
    protected void doPost(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        resp.setContentType("application/json");
        resp.setCharacterEncoding("UTF-8");

        ClientFeedbackRequest payload;
        try {
            payload = mapper.readValue(req.getInputStream(), ClientFeedbackRequest.class);
        } catch (Exception e) {
            resp.setStatus(HttpServletResponse.SC_BAD_REQUEST);
            writeJson(resp, mapOf(
                    "ok", Boolean.FALSE,
                    "error", "invalid_json",
                    "message", e.getMessage()
            ));
            return;
        }

        if (payload == null || payload.type == null || payload.type.trim().isEmpty()) {
            resp.setStatus(HttpServletResponse.SC_BAD_REQUEST);
            writeJson(resp, mapOf(
                    "ok", Boolean.FALSE,
                    "error", "missing_type"
            ));
            return;
        }

        payload.payload = payload.payload == null ? new LinkedHashMap<>() : payload.payload;

        ClientCapabilityProfileStore.ClientCapabilityProfile profile = profileStore.applyFeedback(payload);

        log.info("[ClientFeedback] type={} clientId={} host={} port={} failures={} pushFailures={} retryPolicy={}",
                payload.type,
                profile.clientId,
                profile.serverHost,
                profile.serverPort,
                profile.playbackFailureCount,
                profile.pushFailureCount,
                profile.refinement.get("retryPolicy"));

        writeJson(resp, mapOf(
            "ok", Boolean.TRUE,
                "clientId", profile.clientId,
                "updatedAtEpochMs", profile.updatedAtEpochMs,
                "playbackFailureCount", profile.playbackFailureCount,
                "pushFailureCount", profile.pushFailureCount,
                "refinement", profile.refinement
        ));
    }

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        resp.setContentType("application/json");
        resp.setCharacterEncoding("UTF-8");

        String clientId = req.getParameter("clientId");
        if (clientId != null && !clientId.trim().isEmpty()) {
            ClientCapabilityProfileStore.ClientCapabilityProfile profile = profileStore.getProfile(clientId);
            if (profile == null) {
                resp.setStatus(HttpServletResponse.SC_NOT_FOUND);
                writeJson(resp, mapOf("ok", Boolean.FALSE, "error", "not_found", "clientId", clientId));
                return;
            }
            writeJson(resp, profile);
            return;
        }

        List<ClientCapabilityProfileStore.ClientCapabilityProfile> profiles = profileStore.listProfiles();
        writeJson(resp, mapOf("ok", Boolean.TRUE, "count", profiles.size(), "profiles", profiles));
    }

    private void writeJson(HttpServletResponse resp, Object body) throws IOException {
        mapper.writerWithDefaultPrettyPrinter().writeValue(resp.getWriter(), body);
    }

    private Map<String, Object> mapOf(Object... entries) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i + 1 < entries.length; i += 2) {
            map.put(String.valueOf(entries[i]), entries[i + 1]);
        }
        return map;
    }

    public static class ClientFeedbackRequest {
        public String type;
        public String clientId;
        public String serverHost;
        public int serverPort;
        public Map<String, Object> payload;
    }
}
