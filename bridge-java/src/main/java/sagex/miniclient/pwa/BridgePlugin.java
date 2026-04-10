package sagex.miniclient.pwa;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * SageTV Plugin implementation.
 * <p>
 * SageTV calls start()/stop()/destroy() on this class automatically.
 * The plugin starts the embedded bridge server on port 8099.
 * <p>
 * Configure via Sage.properties:
 * <pre>
 *   pwa_miniclient/port=8099
 *   pwa_miniclient/web_root=          (optional, defaults to SageTV/pwa-miniclient/public)
 * </pre>
 */
public class BridgePlugin implements sage.SageTVPlugin {
    private static final Logger log = LoggerFactory.getLogger(BridgePlugin.class);
    private static final String PROP_PORT = "pwa_miniclient/port";
    private static final String PROP_WEB_ROOT = "pwa_miniclient/web_root";
    private static final String PROP_FFMPEG_PATH = "pwa_miniclient/ffmpeg_path";
    private static final int DEFAULT_PORT = 8099;

    private final sage.SageTVPluginRegistry registry;
    private BridgeServer server;

    public BridgePlugin(sage.SageTVPluginRegistry registry) {
        this.registry = registry;
    }

    @Override
    public void start() {
        int port = DEFAULT_PORT;
        String webRoot = "";

        try {
            String portStr = registry.getSetting(PROP_PORT, String.valueOf(DEFAULT_PORT));
            port = Integer.parseInt(portStr);
        } catch (Exception e) {
            log.warn("Invalid port setting, using default {}", DEFAULT_PORT);
        }

        try {
            webRoot = registry.getSetting(PROP_WEB_ROOT, "");
        } catch (Exception e) {
            // ignore
        }

        String ffmpegPath = "ffmpeg";
        try {
            String val = registry.getSetting(PROP_FFMPEG_PATH, "");
            if (val != null && !val.isEmpty()) ffmpegPath = val;
        } catch (Exception e) {
            // ignore
        }

        // Default web root to SageTV/pwa-miniclient/public
        if (webRoot == null || webRoot.isEmpty()) {
            java.io.File sageDir = new java.io.File(System.getProperty("user.dir", "."));
            java.io.File pluginDir = new java.io.File(sageDir, "pwa-miniclient/public");
            if (pluginDir.isDirectory()) {
                webRoot = pluginDir.getAbsolutePath();
            }
        }

        try {
            server = new BridgeServer(port, webRoot, ffmpegPath);
            server.start();
            log.info("PWA MiniClient plugin started on port {}", port);
        } catch (Exception e) {
            log.error("Failed to start PWA MiniClient bridge", e);
        }
    }

    @Override
    public void stop() {
        if (server != null) {
            try {
                server.stop();
            } catch (Exception e) {
                log.error("Error stopping PWA MiniClient bridge", e);
            }
            server = null;
        }
    }

    @Override
    public void destroy() {
        stop();
    }

    // ── SageTVPlugin configuration interface ────────────────

    @Override
    public String[] getConfigSettings() {
        return new String[]{PROP_PORT, PROP_WEB_ROOT, PROP_FFMPEG_PATH};
    }

    @Override
    public String getConfigValue(String setting) {
        if (PROP_PORT.equals(setting)) {
            return registry.getSetting(PROP_PORT, String.valueOf(DEFAULT_PORT));
        }
        if (PROP_WEB_ROOT.equals(setting)) {
            return registry.getSetting(PROP_WEB_ROOT, "");
        }
        if (PROP_FFMPEG_PATH.equals(setting)) {
            return registry.getSetting(PROP_FFMPEG_PATH, "");
        }
        return "";
    }

    @Override
    public String[] getConfigValues(String setting) {
        return new String[0];
    }

    @Override
    public int getConfigType(String setting) {
        return CONFIG_TEXT; // text input for both
    }

    @Override
    public void setConfigValue(String setting, String value) {
        registry.setSetting(setting, value);
        if (PROP_PORT.equals(setting)) {
            log.info("Port changed to {} — restart plugin to apply", value);
        }
        if (PROP_FFMPEG_PATH.equals(setting)) {
            log.info("FFmpeg path changed to {} — restart plugin to apply", value);
        }
    }

    @Override
    public void setConfigValues(String setting, String[] values) {
        // not used
    }

    @Override
    public String[] getConfigOptions(String setting) {
        return new String[0];
    }

    @Override
    public String getConfigHelpText(String setting) {
        if (PROP_PORT.equals(setting)) {
            return "HTTP/WebSocket port for the PWA MiniClient (default: 8099). Requires plugin restart to take effect.";
        }
        if (PROP_WEB_ROOT.equals(setting)) {
            return "Path to PWA static files (leave blank for default: SageTV/pwa-miniclient/public)";
        }
        if (PROP_FFMPEG_PATH.equals(setting)) {
            return "Path to ffmpeg executable (leave blank to use 'ffmpeg' from system PATH)";
        }
        return "";
    }

    @Override
    public String getConfigLabel(String setting) {
        if (PROP_PORT.equals(setting)) return "Bridge Port";
        if (PROP_WEB_ROOT.equals(setting)) return "Web Root Path";
        if (PROP_FFMPEG_PATH.equals(setting)) return "FFmpeg Path";
        return setting;
    }

    @Override
    public void resetConfig() {
        registry.setSetting(PROP_PORT, String.valueOf(DEFAULT_PORT));
        registry.setSetting(PROP_WEB_ROOT, "");
        registry.setSetting(PROP_FFMPEG_PATH, "");
    }

    @Override
    public void sageEvent(String eventName, java.util.Map eventVars) {
        // no events handled
    }
}
