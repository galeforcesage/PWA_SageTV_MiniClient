package sagex.miniclient.pwa.ngcontext;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * In-JVM provider that calls NgPlaybackContextService directly.
 * <p>
 * Used when the bridge runs inside the SageTV JVM (the normal plugin deployment).
 * Resolves the clientName from the session tracker, then calls the server-side
 * service to get the current playback context JSON.
 * <p>
 * If NgPlaybackContextService is not available (older server, or the NG context
 * plugin is not loaded), falls back to unavailable with "server_not_supported".
 */
public class InJvmNgPlaybackContextBridgeProvider implements NgPlaybackContextBridgeProvider {
    private static final Logger log = LoggerFactory.getLogger(InJvmNgPlaybackContextBridgeProvider.class);

    private final ActivePlaybackSessionTracker tracker;

    public InJvmNgPlaybackContextBridgeProvider(ActivePlaybackSessionTracker tracker) {
        this.tracker = tracker;
    }

    @Override
    public Result getCurrent() {
        // Resolve the active clientName from the session tracker
        String clientName = tracker.getActiveClientName();
        if (clientName == null) {
            return Result.unavailable(tracker.getUnavailableReason());
        }

        // Attempt to call NgPlaybackContextService via reflection (the service
        // may not be deployed on this server). This avoids a hard compile-time
        // dependency on the NG context server plugin.
        try {
            Class<?> serviceClass = Class.forName("sagex.miniclient.ngcontext.NgPlaybackContextService");
            Object instance = serviceClass.getMethod("getInstance").invoke(null);

            // Check if there's an active session for this clientName
            Boolean hasActive = (Boolean) serviceClass
                    .getMethod("hasActiveSessionForClientName", String.class)
                    .invoke(instance, clientName);

            if (!Boolean.TRUE.equals(hasActive)) {
                return Result.unavailable("no_active_session");
            }

            // Get the context JSON
            String contextJson = (String) serviceClass
                    .getMethod("getCurrentContextJsonForClientName", String.class)
                    .invoke(instance, clientName);

            if (contextJson == null || contextJson.isEmpty()) {
                return Result.unavailable("no_active_session");
            }

            // Get the sessionId (opaque, not the internal sessionKey)
            String sessionId = (String) serviceClass
                    .getMethod("getCurrentSessionIdForClientName", String.class)
                    .invoke(instance, clientName);

            // Use an opaque identifier — never expose the raw sessionId if it
            // contains internal format. Wrap it to be safe.
            String opaqueSessionId = sessionId != null ? sanitizeSessionId(sessionId) : "unknown";

            return Result.available(opaqueSessionId, contextJson);

        } catch (ClassNotFoundException e) {
            log.debug("[NgContext] NgPlaybackContextService not available (class not found)");
            return Result.unavailable("server_not_supported");
        } catch (Exception e) {
            log.warn("[NgContext] Error calling NgPlaybackContextService: {}", e.getMessage());
            return Result.unavailable("server_not_supported");
        }
    }

    /**
     * Sanitize the session ID to ensure it never exposes internal formats.
     * If the sessionId contains ':' (internal sessionKey format like
     * "clientName:mediaFileId:openGeneration"), strip it.
     */
    private String sanitizeSessionId(String sessionId) {
        if (sessionId == null) return "unknown";
        // If it looks like an internal key (contains ':'), do not expose it
        if (sessionId.contains(":")) {
            log.warn("[NgContext] Session ID appears to be internal key format — masking");
            return "session-" + Integer.toHexString(sessionId.hashCode());
        }
        return sessionId;
    }
}
