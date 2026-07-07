package sagex.miniclient.pwa;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Tracks active ffmpeg transcode processes across sessions.
 */
public class TranscodeManager {
    private static final Logger log = LoggerFactory.getLogger(TranscodeManager.class);
    private static final TranscodeManager INSTANCE = new TranscodeManager();

    private final Map<String, Process> activeTranscodes = new ConcurrentHashMap<>();

    public static TranscodeManager getInstance() {
        return INSTANCE;
    }

    /**
     * Kill any existing transcode for this session and register a new one.
     */
    public void register(String sessionId, Process process) {
        kill(sessionId);
        activeTranscodes.put(sessionId, process);
    }

    /**
     * Kill the transcode process for a given session.
     */
    public void kill(String sessionId) {
        Process existing = activeTranscodes.remove(sessionId);
        if (existing != null && existing.isAlive()) {
            // NOTE: no Process.pid() — that's a Java 9 API and this plugin
            // targets Java 8. isAlive()/destroyForcibly() are both Java 8.
            log.info("[Transcode] Killing session {}", sessionId);
            existing.destroyForcibly();
        }
    }

    /**
     * Remove the session only if it still points to the given process.
     * Prevents a finishing request from killing a newer replacement.
     */
    public void removeIfSame(String sessionId, Process process) {
        activeTranscodes.remove(sessionId, process);
    }

    /**
     * Kill all active transcodes.
     */
    public void killAll() {
        for (Map.Entry<String, Process> entry : activeTranscodes.entrySet()) {
            if (entry.getValue().isAlive()) {
                log.info("[Transcode] Killing session {}", entry.getKey());
                entry.getValue().destroyForcibly();
            }
        }
        activeTranscodes.clear();
    }
}
