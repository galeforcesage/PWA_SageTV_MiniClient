package sagex.miniclient.pwa;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Persists per-client capability profiles and applies basic refinement rules
 * from runtime feedback events.
 */
public class ClientCapabilityProfileStore {
    private static final Logger log = LoggerFactory.getLogger(ClientCapabilityProfileStore.class);

    private final Path storePath;
    private final Path tempPath;
    private final ObjectMapper mapper;
    private final ConcurrentHashMap<String, ClientCapabilityProfile> profiles = new ConcurrentHashMap<>();

    public ClientCapabilityProfileStore(Path storePath) {
        this.storePath = storePath;
        this.tempPath = Path.of(storePath.toString() + ".tmp");
        this.mapper = new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT);
        load();
    }

    public synchronized ClientCapabilityProfile applyFeedback(ClientFeedbackServlet.ClientFeedbackRequest req) {
        String clientId = sanitizeClientId(req.clientId, req.serverHost, req.serverPort);
        long now = System.currentTimeMillis();

        ClientCapabilityProfile profile = profiles.computeIfAbsent(clientId, id -> {
            ClientCapabilityProfile created = new ClientCapabilityProfile();
            created.clientId = id;
            created.createdAtEpochMs = now;
            created.updatedAtEpochMs = now;
            created.serverHost = safe(req.serverHost);
            created.serverPort = req.serverPort;
            created.refinement.put("preferredTransport", "dynamic");
            created.refinement.put("retryPolicy", "default");
            return created;
        });

        profile.updatedAtEpochMs = now;
        if (req.serverHost != null && !req.serverHost.isBlank()) {
            profile.serverHost = req.serverHost;
        }
        if (req.serverPort > 0) {
            profile.serverPort = req.serverPort;
        }

        if ("CAPABILITY_UPDATE".equalsIgnoreCase(req.type)) {
            applyCapabilityUpdate(profile, req.payload);
        } else if ("PLAYBACK_FAILURE".equalsIgnoreCase(req.type)) {
            applyPlaybackFailure(profile, req.payload);
        } else {
            profile.lastEventType = req.type;
            profile.lastEventPayload = req.payload == null ? Map.of() : req.payload;
            profile.observations.put("lastUnhandledEventType", safe(req.type));
        }

        save();
        return profile;
    }

    public synchronized List<ClientCapabilityProfile> listProfiles() {
        return new ArrayList<>(profiles.values());
    }

    public synchronized ClientCapabilityProfile getProfile(String clientId) {
        if (clientId == null) return null;
        return profiles.get(clientId);
    }

    private void applyCapabilityUpdate(ClientCapabilityProfile profile, Map<String, Object> payload) {
        profile.lastEventType = "CAPABILITY_UPDATE";
        profile.lastEventPayload = payload == null ? Map.of() : payload;

        Map<String, Object> patch = extractPatch(payload);
        deepMerge(profile.capabilityHints, patch);

        Object reason = payload == null ? null : payload.get("reason");
        if (reason != null) {
            profile.observations.put("lastCapabilityUpdateReason", String.valueOf(reason));
        }
        profile.observations.put("lastCapabilityUpdateAt", Instant.ofEpochMilli(profile.updatedAtEpochMs).toString());
    }

    private void applyPlaybackFailure(ClientCapabilityProfile profile, Map<String, Object> payload) {
        profile.lastEventType = "PLAYBACK_FAILURE";
        profile.lastEventPayload = payload == null ? Map.of() : payload;

        profile.playbackFailureCount++;
        String reason = payload == null ? "UNKNOWN" : String.valueOf(payload.getOrDefault("reason", "UNKNOWN"));
        String mode = payload == null ? "" : String.valueOf(payload.getOrDefault("mode", ""));

        profile.observations.put("lastPlaybackFailureReason", reason);
        profile.observations.put("lastPlaybackFailureMode", mode);
        profile.observations.put("lastPlaybackFailureAt", Instant.ofEpochMilli(profile.updatedAtEpochMs).toString());

        if (isPushFailure(reason, mode)) {
            profile.pushFailureCount++;
            ensureMap(profile.capabilityHints, "playbackHints").put("canTransmuxTsPush", false);
            profile.refinement.put("preferredTransport", "pull");
            profile.refinement.put("retryPolicy", "fallback_pull_h264_aac");
            profile.refinement.put("lastDowngrade", "push_disabled_by_failures");
            if (profile.pushFailureCount >= 2) {
                profile.refinement.put("disablePush", true);
            }
            return;
        }

        if ("HLS_NOT_SUPPORTED".equals(reason) || "HLS_FATAL_ERROR".equals(reason)) {
            ensureMap(profile.capabilityHints, "playbackHints").put("canPlayHLS", false);
            profile.refinement.put("retryPolicy", "fallback_mp4_h264_aac");
            profile.refinement.put("lastDowngrade", "hls_disabled_by_failures");
            return;
        }

        if ("MEDIA_SOURCE_UNAVAILABLE".equals(reason)) {
            Map<String, Object> playback = ensureMap(profile.capabilityHints, "playbackHints");
            playback.put("canUseMediaSource", false);
            playback.put("canTransmuxTsPush", false);
            profile.refinement.put("preferredTransport", "pull");
            profile.refinement.put("retryPolicy", "direct_pull_mp4_h264_aac");
            profile.refinement.put("lastDowngrade", "mse_unavailable");
            return;
        }

        profile.refinement.put("retryPolicy", "fallback_safe_profile");
    }

    private boolean isPushFailure(String reason, String mode) {
        if (mode != null && mode.equalsIgnoreCase("push")) {
            return true;
        }
        return Objects.equals(reason, "PUSH_CODEC_MISMATCH")
                || Objects.equals(reason, "PUSH_TRANSMUX_STALL")
                || Objects.equals(reason, "UNSUPPORTED_PUSH_FORMAT")
                || Objects.equals(reason, "PUSH_TRANSMUXER_UNAVAILABLE")
                || Objects.equals(reason, "SOURCEBUFFER_APPEND_ERROR");
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> extractPatch(Map<String, Object> payload) {
        if (payload == null) return new LinkedHashMap<>();
        Object patch = payload.get("patch");
        if (patch instanceof Map) {
            return new LinkedHashMap<>((Map<String, Object>) patch);
        }
        return new LinkedHashMap<>(payload);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> ensureMap(Map<String, Object> root, String key) {
        Object existing = root.get(key);
        if (existing instanceof Map) {
            return (Map<String, Object>) existing;
        }
        Map<String, Object> created = new LinkedHashMap<>();
        root.put(key, created);
        return created;
    }

    @SuppressWarnings("unchecked")
    private void deepMerge(Map<String, Object> target, Map<String, Object> patch) {
        if (patch == null) return;
        for (Map.Entry<String, Object> entry : patch.entrySet()) {
            String key = entry.getKey();
            Object value = entry.getValue();

            if (value instanceof Map) {
                Map<String, Object> childTarget = ensureMap(target, key);
                deepMerge(childTarget, (Map<String, Object>) value);
            } else {
                target.put(key, value);
            }
        }
    }

    private String sanitizeClientId(String clientId, String host, int port) {
        if (clientId != null && !clientId.isBlank()) return clientId.trim();
        String safeHost = (host == null || host.isBlank()) ? "unknown-host" : host.replaceAll("[^A-Za-z0-9._-]", "_");
        int safePort = port > 0 ? port : 0;
        return "unknown-" + safeHost + "-" + safePort;
    }

    private String safe(String value) {
        return value == null ? "" : value;
    }

    private synchronized void load() {
        try {
            if (!Files.exists(storePath)) {
                return;
            }
            byte[] bytes = Files.readAllBytes(storePath);
            List<ClientCapabilityProfile> loaded = mapper.readValue(bytes, new TypeReference<List<ClientCapabilityProfile>>() {});
            for (ClientCapabilityProfile profile : loaded) {
                if (profile != null && profile.clientId != null && !profile.clientId.isBlank()) {
                    profile.ensureDefaults();
                    profiles.put(profile.clientId, profile);
                }
            }
            log.info("[ClientFeedback] Loaded {} client capability profiles from {}", profiles.size(), storePath);
        } catch (Exception e) {
            log.warn("[ClientFeedback] Failed to load profile store {}: {}", storePath, e.getMessage());
        }
    }

    private synchronized void save() {
        try {
            Path parent = storePath.getParent();
            if (parent != null && !Files.exists(parent)) {
                Files.createDirectories(parent);
            }

            List<ClientCapabilityProfile> snapshot = new ArrayList<>(profiles.values());
            byte[] bytes = mapper.writeValueAsBytes(snapshot);
            Files.write(tempPath, bytes);
            Files.move(tempPath, storePath, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            log.warn("[ClientFeedback] Failed to persist profile store {}: {}", storePath, e.getMessage());
        }
    }

    public static class ClientCapabilityProfile {
        public String clientId;
        public String serverHost;
        public int serverPort;
        public long createdAtEpochMs;
        public long updatedAtEpochMs;

        public int playbackFailureCount;
        public int pushFailureCount;

        public String lastEventType;
        public Map<String, Object> lastEventPayload = new LinkedHashMap<>();

        public Map<String, Object> capabilityHints = new LinkedHashMap<>();
        public Map<String, Object> observations = new LinkedHashMap<>();
        public Map<String, Object> refinement = new LinkedHashMap<>();

        public void ensureDefaults() {
            if (lastEventPayload == null) lastEventPayload = new LinkedHashMap<>();
            if (capabilityHints == null) capabilityHints = new LinkedHashMap<>();
            if (observations == null) observations = new LinkedHashMap<>();
            if (refinement == null) refinement = new LinkedHashMap<>();
            refinement.putIfAbsent("preferredTransport", "dynamic");
            refinement.putIfAbsent("retryPolicy", "default");
        }
    }
}
