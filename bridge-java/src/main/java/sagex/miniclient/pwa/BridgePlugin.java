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
    private static final String PROP_HWACCEL = "pwa_miniclient/hwaccel";
    private static final String PROP_USERNAME = "pwa_miniclient/username";
    private static final String PROP_PASSWORD = "pwa_miniclient/password";
    private static final int DEFAULT_PORT = 8099;

    private final sage.SageTVPluginRegistry registry;
    private BridgeServer server;

    public BridgePlugin(sage.SageTVPluginRegistry registry) {
        this.registry = registry;
    }

    @Override
    public void start() {
        // Pre-set MCFullyConfigured so PWA clients skip the Configuration Wizard.
        // GetProperty() for MiniClients falls back to this global value when no
        // client-specific property exists for the connecting MAC address.
        try {
            sage.Sage.put("ConfigWiz/MCFullyConfigured", "true");
        } catch (Exception e) {
            log.warn("Failed to set ConfigWiz/MCFullyConfigured", e);
        }

        // ── Requirement checks ──────────────────────────────────
        if (!checkRequirements()) {
            log.error("PWA MiniClient plugin cannot start — requirements not met");
            return;
        }

        int port = DEFAULT_PORT;
        String webRoot = "";

        try {
            String portStr = sage.Sage.get(PROP_PORT, String.valueOf(DEFAULT_PORT));
            port = Integer.parseInt(portStr);
        } catch (Exception e) {
            log.warn("Invalid port setting, using default {}", DEFAULT_PORT);
        }

        try {
            webRoot = sage.Sage.get(PROP_WEB_ROOT, "");
        } catch (Exception e) {
            // ignore
        }

        String ffmpegPath = "ffmpeg";
        try {
            String val = sage.Sage.get(PROP_FFMPEG_PATH, "");
            if (val != null && !val.isEmpty()) ffmpegPath = val;
        } catch (Exception e) {
            // ignore
        }

        String hwAccel = "auto";
        try {
            String val = sage.Sage.get(PROP_HWACCEL, "auto");
            if (val != null && !val.isEmpty()) hwAccel = val;
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

        // Read auth credentials
        String username = sage.Sage.get(PROP_USERNAME, "");
        String password = sage.Sage.get(PROP_PASSWORD, "");

        try {
            server = new BridgeServer(port, webRoot, ffmpegPath, hwAccel, username, password);
            server.start();
            log.info("PWA MiniClient plugin started on port {}", port);
            if (username != null && !username.isEmpty()) {
                log.info("Basic authentication enabled for user: {}", username);
            } else {
                log.warn("No username/password configured — PWA is accessible without authentication");
            }
        } catch (Exception e) {
            log.error("Failed to start PWA MiniClient bridge", e);
        }
    }

    private boolean checkRequirements() {
        boolean ok = true;

        // 1. Jetty (embedded in shadow JAR — relocated to pwa.shadow.org.eclipse.jetty)
        try {
            Class.forName("org.eclipse.jetty.server.Server");
            log.info("Requirement OK: Jetty server available");
        } catch (ClassNotFoundException e) {
            log.error("Requirement FAILED: Jetty server classes not found on classpath. "
                    + "Ensure pwa-miniclient-bridge.jar is in JARs/");
            ok = false;
        }

        // 2. SageTV API (sage.Sage class with get/put methods)
        try {
            sage.Sage.get("pwa_miniclient/port", "8099");
            log.info("Requirement OK: SageTV API accessible");
        } catch (Exception e) {
            log.error("Requirement FAILED: Cannot access SageTV API (sage.Sage): {}", e.getMessage());
            ok = false;
        }

        // 3. Web root directory
        String webRoot = "";
        try {
            webRoot = sage.Sage.get(PROP_WEB_ROOT, "");
        } catch (Exception e) {
            // ignore
        }
        if (webRoot == null || webRoot.isEmpty()) {
            java.io.File sageDir = new java.io.File(System.getProperty("user.dir", "."));
            java.io.File pluginDir = new java.io.File(sageDir, "pwa-miniclient/public");
            if (pluginDir.isDirectory()) {
                log.info("Requirement OK: Web root found at {}", pluginDir.getAbsolutePath());
            } else {
                log.warn("Web root not found at {} — static file serving will be disabled", pluginDir.getAbsolutePath());
            }
        } else {
            java.io.File f = new java.io.File(webRoot);
            if (f.isDirectory()) {
                log.info("Requirement OK: Custom web root at {}", f.getAbsolutePath());
            } else {
                log.warn("Configured web root does not exist: {}", webRoot);
            }
        }

        // 4. Port availability
        int port = DEFAULT_PORT;
        try {
            port = Integer.parseInt(sage.Sage.get(PROP_PORT, String.valueOf(DEFAULT_PORT)));
        } catch (Exception e) {
            // use default
        }
        try (java.net.ServerSocket ss = new java.net.ServerSocket(port)) {
            ss.close();
            log.info("Requirement OK: Port {} is available", port);
        } catch (java.io.IOException e) {
            log.error("Requirement FAILED: Port {} is already in use", port);
            ok = false;
        }

        return ok;
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
        return new String[]{PROP_PORT, PROP_WEB_ROOT, PROP_FFMPEG_PATH, PROP_HWACCEL, PROP_USERNAME, PROP_PASSWORD};
    }

    @Override
    public String getConfigValue(String setting) {
        if (PROP_PORT.equals(setting)) {
            return sage.Sage.get(PROP_PORT, String.valueOf(DEFAULT_PORT));
        }
        if (PROP_WEB_ROOT.equals(setting)) {
            return sage.Sage.get(PROP_WEB_ROOT, "");
        }
        if (PROP_FFMPEG_PATH.equals(setting)) {
            return sage.Sage.get(PROP_FFMPEG_PATH, "");
        }
        if (PROP_HWACCEL.equals(setting)) {
            return sage.Sage.get(PROP_HWACCEL, "auto");
        }
        if (PROP_USERNAME.equals(setting)) {
            return sage.Sage.get(PROP_USERNAME, "");
        }
        if (PROP_PASSWORD.equals(setting)) {
            return sage.Sage.get(PROP_PASSWORD, "");
        }
        return "";
    }

    @Override
    public String[] getConfigValues(String setting) {
        return new String[0];
    }

    @Override
    public int getConfigType(String setting) {
        if (PROP_HWACCEL.equals(setting)) return CONFIG_CHOICE;
        if (PROP_PASSWORD.equals(setting)) return CONFIG_PASSWORD;
        return CONFIG_TEXT;
    }

    @Override
    public void setConfigValue(String setting, String value) {
        sage.Sage.put(setting, value);
        if (PROP_PORT.equals(setting)) {
            log.info("Port changed to {} — restart plugin to apply", value);
        }
        if (PROP_FFMPEG_PATH.equals(setting)) {
            log.info("FFmpeg path changed to {} — restart plugin to apply", value);
        }
        if (PROP_HWACCEL.equals(setting)) {
            log.info("Hardware acceleration changed to {}", value);
        }
        if (PROP_USERNAME.equals(setting) || PROP_PASSWORD.equals(setting)) {
            log.info("Auth credentials changed — restart plugin to apply");
        }
    }

    @Override
    public void setConfigValues(String setting, String[] values) {
        // not used
    }

    @Override
    public String[] getConfigOptions(String setting) {
        if (PROP_HWACCEL.equals(setting)) {
            return new String[]{"auto", "nvenc", "qsv", "vaapi", "videotoolbox", "none"};
        }
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
        if (PROP_HWACCEL.equals(setting)) {
            return "Hardware acceleration for transcoding. 'auto' probes GPU at startup (nvenc/qsv/vaapi). "
                    + "Or force: 'nvenc' (NVIDIA), 'qsv' (Intel QuickSync), 'vaapi' (AMD/Intel Linux), "
                    + "'videotoolbox' (macOS), 'none' (software x264). Requires plugin restart.";
        }
        if (PROP_USERNAME.equals(setting)) {
            return "Username for PWA access. Leave blank to disable authentication. Requires plugin restart.";
        }
        if (PROP_PASSWORD.equals(setting)) {
            return "Password for PWA access. Both username and password must be set to enable auth. Requires plugin restart.";
        }
        return "";
    }

    @Override
    public String getConfigLabel(String setting) {
        if (PROP_PORT.equals(setting)) return "Bridge Port";
        if (PROP_WEB_ROOT.equals(setting)) return "Web Root Path";
        if (PROP_FFMPEG_PATH.equals(setting)) return "FFmpeg Path";
        if (PROP_HWACCEL.equals(setting)) return "Hardware Acceleration";
        if (PROP_USERNAME.equals(setting)) return "Username";
        if (PROP_PASSWORD.equals(setting)) return "Password";
        return setting;
    }

    @Override
    public void resetConfig() {
        sage.Sage.put(PROP_PORT, String.valueOf(DEFAULT_PORT));
        sage.Sage.put(PROP_WEB_ROOT, "");
        sage.Sage.put(PROP_FFMPEG_PATH, "");
        sage.Sage.put(PROP_USERNAME, "");
        sage.Sage.put(PROP_PASSWORD, "");
    }

    @Override
    public void sageEvent(String eventName, java.util.Map eventVars) {
        // no events handled
    }
}
