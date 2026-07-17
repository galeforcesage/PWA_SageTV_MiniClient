package sagex.miniclient.pwa.ngcontext;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Tracks active playback sessions for the bridge/proxy.
 * <p>
 * Maps browser WebSocket connections to opaque session identifiers (when known)
 * and provides lifecycle hooks for connect, media open/close, and disconnect.
 * <p>
 * <b>Security:</b>
 * <ul>
 *   <li>Never stores or exposes internal SageTV sessionKey</li>
 *   <li>Never stores clientName:mediaFileId:openGeneration</li>
 *   <li>Never enumerates all server sessions</li>
 *   <li>Only tracks bridge-assigned opaque connectionId → sessionId mapping</li>
 * </ul>
 * <p>
 * <b>Thread safety:</b> All public methods are thread-safe (ConcurrentHashMap + atomics).
 */
public class ActivePlaybackSessionTracker {
    private static final Logger log = LoggerFactory.getLogger(ActivePlaybackSessionTracker.class);
    private static final long DEFAULT_STALE_TIMEOUT_MS = 120_000; // 2 minutes
    private static final long STALE_CHECK_INTERVAL_MS = 30_000;

    private final ConcurrentHashMap<String, TrackedSession> sessions = new ConcurrentHashMap<>();
    private final AtomicLong idCounter = new AtomicLong(0);
    private final long staleTimeoutMs;
    private ScheduledExecutorService reaper;

    public ActivePlaybackSessionTracker() {
        this(DEFAULT_STALE_TIMEOUT_MS);
    }

    public ActivePlaybackSessionTracker(long staleTimeoutMs) {
        this.staleTimeoutMs = staleTimeoutMs;
    }

    /**
     * Start the stale-session reaper. Call once on bridge startup.
     */
    public void start() {
        if (reaper != null) return;
        reaper = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "ng-session-reaper");
            t.setDaemon(true);
            return t;
        });
        reaper.scheduleAtFixedRate(this::reapStale, STALE_CHECK_INTERVAL_MS, STALE_CHECK_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    /**
     * Stop the reaper and clear all sessions. Call on bridge shutdown.
     */
    public void stop() {
        if (reaper != null) {
            reaper.shutdownNow();
            reaper = null;
        }
        sessions.clear();
    }

    /**
     * Register a new browser connection. Returns a unique connectionId.
     *
     * @param channel the WebSocket channel path (e.g. "/gfx", "/media")
     * @return unique connectionId
     */
    public String onConnect(String channel) {
        String connectionId = "conn-" + idCounter.incrementAndGet() + "-" + Long.toString(System.currentTimeMillis(), 36);
        TrackedSession session = new TrackedSession(connectionId, channel);
        sessions.put(connectionId, session);
        log.debug("[SessionTracker] Registered connection {} on {}", connectionId, channel);
        return connectionId;
    }

    /**
     * Set the opaque sessionId for a connection.
     * <p>
     * TODO: Wire this call. The bridge currently cannot learn sessionId because:
     * <ol>
     *   <li>The binary protocol bytes are opaque (encrypted handshake, no inspection)</li>
     *   <li>No query param currently carries session identity from the PWA client</li>
     *   <li>No server-side callback mechanism exists yet</li>
     * </ol>
     * <p>
     * Possible future sources:
     * <ul>
     *   <li>PWA client sends {"type":"session_identity","sessionId":"..."} text frame</li>
     *   <li>Server calls bridge HTTP callback on session start</li>
     *   <li>Bridge reads MAC from WS query params (if PWA adds the param)</li>
     * </ul>
     *
     * @param connectionId the connection identifier
     * @param sessionId    opaque session ID (NEVER the internal sessionKey)
     */
    public void setSessionId(String connectionId, String sessionId) {
        TrackedSession s = sessions.get(connectionId);
        if (s == null) return;
        s.sessionId = sessionId;
        s.lastActivityAt = System.currentTimeMillis();
    }

    /** Mark playback started for a connection. */
    public void onPlaybackStart(String connectionId) {
        TrackedSession s = sessions.get(connectionId);
        if (s == null) return;
        s.playbackActive = true;
        s.state = SessionState.PLAYING;
        s.lastActivityAt = System.currentTimeMillis();
    }

    /** Mark playback stopped for a connection. */
    public void onPlaybackStop(String connectionId) {
        TrackedSession s = sessions.get(connectionId);
        if (s == null) return;
        s.playbackActive = false;
        s.state = SessionState.CONNECTED;
        s.lastActivityAt = System.currentTimeMillis();
    }

    /** Record activity (prevents stale timeout). */
    public void onActivity(String connectionId) {
        TrackedSession s = sessions.get(connectionId);
        if (s == null) return;
        if (s.state == SessionState.STALE) {
            s.state = s.playbackActive ? SessionState.PLAYING : SessionState.CONNECTED;
        }
        s.lastActivityAt = System.currentTimeMillis();
    }

    /**
     * Handle browser disconnect or SageTV socket close/error.
     * Clears mapping. Idempotent — safe to call multiple times.
     */
    public void onDisconnect(String connectionId) {
        TrackedSession s = sessions.remove(connectionId);
        if (s != null) {
            s.state = SessionState.DISCONNECTED;
            s.playbackActive = false;
            s.sessionId = null;
            log.debug("[SessionTracker] Disconnected {}", connectionId);
        }
    }

    /**
     * Get the current active session with known sessionId.
     *
     * @return the most recently active session, or null if none
     */
    public ActiveSessionInfo getActiveSession() {
        TrackedSession best = null;
        for (TrackedSession s : sessions.values()) {
            if (s.state == SessionState.DISCONNECTED || s.state == SessionState.STALE) continue;
            if (s.sessionId == null) continue;
            if (best == null || s.lastActivityAt > best.lastActivityAt) {
                best = s;
            }
        }
        if (best == null) return null;
        return new ActiveSessionInfo(best.connectionId, best.sessionId, best.state.name().toLowerCase());
    }

    /**
     * Get the unavailable reason if no active session is available.
     */
    public String getUnavailableReason() {
        if (sessions.isEmpty()) return "no_active_session";
        for (TrackedSession s : sessions.values()) {
            if (s.state != SessionState.DISCONNECTED) {
                return "session_id_unknown";
            }
        }
        return "no_active_session";
    }

    /** Get count of tracked connections. */
    public int size() {
        return sessions.size();
    }

    private void reapStale() {
        long now = System.currentTimeMillis();
        for (Map.Entry<String, TrackedSession> entry : sessions.entrySet()) {
            TrackedSession s = entry.getValue();
            if (s.state == SessionState.DISCONNECTED) {
                sessions.remove(entry.getKey());
                continue;
            }
            if (now - s.lastActivityAt > staleTimeoutMs) {
                if (s.state != SessionState.STALE) {
                    log.info("[SessionTracker] Connection {} went stale ({}s idle)",
                            s.connectionId, (now - s.lastActivityAt) / 1000);
                    s.state = SessionState.STALE;
                }
            }
        }
    }

    // ── Inner types ─────────────────────────────────────────────

    enum SessionState {
        CONNECTED, PLAYING, STALE, DISCONNECTED
    }

    static class TrackedSession {
        final String connectionId;
        final String channel;
        volatile String sessionId;
        volatile boolean playbackActive;
        volatile long lastActivityAt;
        volatile SessionState state;

        TrackedSession(String connectionId, String channel) {
            this.connectionId = connectionId;
            this.channel = channel;
            this.lastActivityAt = System.currentTimeMillis();
            this.state = SessionState.CONNECTED;
        }
    }

    /** Immutable result for getActiveSession(). */
    public static class ActiveSessionInfo {
        public final String connectionId;
        public final String sessionId;
        public final String state;

        ActiveSessionInfo(String connectionId, String sessionId, String state) {
            this.connectionId = connectionId;
            this.sessionId = sessionId;
            this.state = state;
        }
    }
}
