package sagex.miniclient.pwa.ngcontext;

/**
 * Provider abstraction for NG Playback Context bridge-side metadata.
 * <p>
 * Implementations supply the current playback context for an active session.
 * The bridge uses whichever provider is configured at startup:
 * <ul>
 *   <li>{@link NoopNgPlaybackContextBridgeProvider} — always returns unavailable (default)</li>
 *   <li>{@code HttpNgPlaybackContextBridgeProvider} — future: calls SageTV server
 *       GET /ng/playback-context/{sessionId}</li>
 *   <li>{@code InJvmNgPlaybackContextBridgeProvider} — future: direct JVM access
 *       to NgPlaybackContextService (only when bridge runs inside SageTV JVM)</li>
 * </ul>
 */
public interface NgPlaybackContextBridgeProvider {

    /**
     * Get the current playback context for the active session.
     *
     * @return a result containing either the context payload or an unavailable reason
     */
    Result getCurrent();

    /**
     * Result of a context lookup — either available (with context JSON) or unavailable.
     */
    final class Result {
        private final boolean available;
        private final String sessionId;
        private final String contextJson;
        private final String unavailableReason;

        private Result(boolean available, String sessionId, String contextJson, String unavailableReason) {
            this.available = available;
            this.sessionId = sessionId;
            this.contextJson = contextJson;
            this.unavailableReason = unavailableReason;
        }

        /**
         * Create an available result with context data.
         *
         * @param sessionId   opaque session identifier (never the internal sessionKey)
         * @param contextJson JSON object string with context fields
         */
        public static Result available(String sessionId, String contextJson) {
            return new Result(true, sessionId, contextJson, null);
        }

        /**
         * Create an unavailable result.
         *
         * @param reason one of: "no_active_session", "server_not_supported", "bridge_not_wired", "unknown_session"
         */
        public static Result unavailable(String reason) {
            return new Result(false, null, null, reason);
        }

        public boolean isAvailable() { return available; }
        public String getSessionId() { return sessionId; }
        public String getContextJson() { return contextJson; }
        public String getUnavailableReason() { return unavailableReason; }
    }
}
