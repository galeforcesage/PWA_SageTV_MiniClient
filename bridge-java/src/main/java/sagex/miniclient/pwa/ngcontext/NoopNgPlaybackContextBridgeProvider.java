package sagex.miniclient.pwa.ngcontext;

/**
 * Default no-op provider — always returns NG_PLAYBACK_CONTEXT_UNAVAILABLE.
 * <p>
 * Used when:
 * <ul>
 *   <li>No active session mapping is wired (phase 1 — this is the current state)</li>
 *   <li>The SageTV server does not support NG Playback Context</li>
 *   <li>The bridge has not been configured with a real provider</li>
 * </ul>
 */
public class NoopNgPlaybackContextBridgeProvider implements NgPlaybackContextBridgeProvider {

    private final String reason;

    /**
     * @param reason the unavailable reason to return (e.g. "bridge_not_wired")
     */
    public NoopNgPlaybackContextBridgeProvider(String reason) {
        this.reason = reason != null ? reason : "bridge_not_wired";
    }

    public NoopNgPlaybackContextBridgeProvider() {
        this("bridge_not_wired");
    }

    @Override
    public Result getCurrent() {
        return Result.unavailable(reason);
    }
}
