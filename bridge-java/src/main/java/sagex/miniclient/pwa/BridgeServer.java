package sagex.miniclient.pwa;

import org.eclipse.jetty.server.HttpConfiguration;
import org.eclipse.jetty.server.HttpConnectionFactory;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.server.ServerConnector;
import org.eclipse.jetty.server.SecureRequestCustomizer;
import org.eclipse.jetty.server.SslConnectionFactory;
import org.eclipse.jetty.security.ConstraintMapping;
import org.eclipse.jetty.security.ConstraintSecurityHandler;
import org.eclipse.jetty.security.HashLoginService;
import org.eclipse.jetty.security.UserStore;
import org.eclipse.jetty.security.authentication.BasicAuthenticator;
import org.eclipse.jetty.servlet.DefaultServlet;
import org.eclipse.jetty.servlet.ServletContextHandler;
import org.eclipse.jetty.servlet.ServletHolder;
import org.eclipse.jetty.util.security.Constraint;
import org.eclipse.jetty.util.security.Password;
import org.eclipse.jetty.util.ssl.SslContextFactory;
import org.eclipse.jetty.websocket.server.config.JettyWebSocketServletContainerInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.time.Duration;

/**
 * PWA MiniClient Bridge Server.
 * <p>
 * Provides three services:
 * <ul>
 *   <li>Static file serving for the PWA (HTML/CSS/JS)</li>
 *   <li>WebSocket relay at /gfx and /media - bridges browser to SageTV TCP</li>
 *   <li>HTTP transcode endpoint at /transcode - spawns ffmpeg for media playback</li>
 * </ul>
 */
public class BridgeServer {
    private static final Logger log = LoggerFactory.getLogger(BridgeServer.class);
    private static final String TLS_KEYSTORE_PATH = "pwa-miniclient/ssl/pwa-miniclient.p12";
    private static final String TLS_KEYSTORE_PASSWORD = "changeit";

    private final int port;
    private final String webRoot;
    private final String ffmpegPath;
    private final String hwAccel;
    private final String username;
    private final String password;
    private Server server;

    public BridgeServer(int port, String webRoot, String ffmpegPath, String hwAccel,
                        String username, String password) {
        this.port = port;
        this.webRoot = webRoot;
        this.ffmpegPath = ffmpegPath;
        this.hwAccel = hwAccel;
        this.username = username;
        this.password = password;
    }

    public void start() throws Exception {
        server = new Server();

        ServerConnector connector = createHttpsConnector(server, port);
        server.addConnector(connector);

        ServletContextHandler context = new ServletContextHandler(ServletContextHandler.SESSIONS);
        context.setContextPath("/");

        // Basic authentication — if username and password are both configured
        if (username != null && !username.isEmpty() && password != null && !password.isEmpty()) {
            ConstraintSecurityHandler security = new ConstraintSecurityHandler();

            // Define a "user" role constraint on all paths
            Constraint constraint = new Constraint();
            constraint.setName("auth");
            constraint.setAuthenticate(true);
            constraint.setRoles(new String[]{"user"});

            ConstraintMapping mapping = new ConstraintMapping();
            mapping.setPathSpec("/*");
            mapping.setConstraint(constraint);
            security.addConstraintMapping(mapping);

            // In-memory user store with the configured credentials
            HashLoginService loginService = new HashLoginService("PWA MiniClient");
            UserStore userStore = new UserStore();
            userStore.addUser(username, new Password(password), new String[]{"user"});
            loginService.setUserStore(userStore);

            security.setLoginService(loginService);
            security.setAuthenticator(new BasicAuthenticator());

            context.setSecurityHandler(security);
            log.info("Basic authentication enabled");
        }

        server.setHandler(context);

        // WebSocket endpoints at /gfx and /media
        JettyWebSocketServletContainerInitializer.configure(context, (servletContext, wsContainer) -> {
            wsContainer.setMaxBinaryMessageSize(65536);
            wsContainer.setMaxTextMessageSize(65536);
            wsContainer.setIdleTimeout(Duration.ofMinutes(30));
            wsContainer.addMapping("/gfx", (upgradeRequest, upgradeResponse) -> new BridgeWebSocket());
            wsContainer.addMapping("/media", (upgradeRequest, upgradeResponse) -> new BridgeWebSocket());
            wsContainer.addMapping("/reconnect", (upgradeRequest, upgradeResponse) -> new BridgeWebSocket());
            wsContainer.addMapping("/transcode/push-stream", (upgradeRequest, upgradeResponse) ->
                    new PushTranscodeWebSocket(ffmpegPath));
        });

        // Transcode servlet
        context.addServlet(new ServletHolder("transcode", new TranscodeServlet(ffmpegPath, hwAccel)), "/transcode");
        context.addServlet(new ServletHolder("transcode-stop", new TranscodeStopServlet()), "/transcode/stop");

        // Server info API — probes ffmpeg capabilities for profile auto-detection
        context.addServlet(new ServletHolder("server-info", new ServerInfoServlet(ffmpegPath)), "/api/server-info");

        // Secure proxy for Sage transfer download endpoints.
        context.addServlet(new ServletHolder("transfer-proxy", new TransferProxyServlet("localhost", 31099)), "/api/transfers/*");

        // Static file serving for PWA
        String resourceBase = resolveWebRoot();
        if (resourceBase != null) {
            ServletHolder staticHolder = new ServletHolder("static", new DefaultServlet());
            staticHolder.setInitParameter("resourceBase", resourceBase);
            staticHolder.setInitParameter("dirAllowed", "false");
            staticHolder.setInitParameter("welcomeFiles", "index.html");
            staticHolder.setInitParameter("cacheControl", "no-cache, no-store, must-revalidate");
            context.addServlet(staticHolder, "/");
        } else {
            log.warn("No web root found — static file serving disabled");
        }

        server.start();
        log.info("PWA MiniClient Bridge running on port {}", port);
        log.info("PWA at https://localhost:{}/", port);
        log.info("WebSocket endpoints: wss://localhost:{}/gfx, /media", port);
        log.info("Transcode endpoint:  https://localhost:{}/transcode?file=<path>&seek=<sec>", port);
    }

    public void stop() throws Exception {
        if (server != null) {
            server.stop();
            TranscodeManager.getInstance().killAll();
            log.info("Bridge server stopped");
        }
    }

    public void join() throws InterruptedException {
        if (server != null) {
            server.join();
        }
    }

    /**
     * Resolve the web root directory for static files.
     * Priority: external webRoot parameter > adjacent "public" dir > classpath resource
     */
    private String resolveWebRoot() {
        // 1. Explicit path passed in
        if (webRoot != null && !webRoot.isEmpty()) {
            java.io.File f = new java.io.File(webRoot);
            if (f.isDirectory()) {
                log.info("Serving static files from: {}", f.getAbsolutePath());
                return f.getAbsolutePath();
            }
        }

        // 2. "public" directory next to the JAR
        java.io.File adjacent = new java.io.File("public");
        if (adjacent.isDirectory()) {
            log.info("Serving static files from: {}", adjacent.getAbsolutePath());
            return adjacent.getAbsolutePath();
        }

        // 3. Embedded in JAR classpath
        java.net.URL classpathResource = getClass().getClassLoader().getResource("pwa-public/index.html");
        if (classpathResource != null) {
            String cpBase = classpathResource.toExternalForm().replace("/index.html", "");
            log.info("Serving static files from classpath: {}", cpBase);
            return cpBase;
        }

        return null;
    }

    /**
     * Create a TLS connector. If no keystore exists yet, generate a local self-signed
     * certificate so browsers can use https:// and wss:// immediately.
     */
    private ServerConnector createHttpsConnector(Server server, int port) throws Exception {
        File keystoreFile = new File(TLS_KEYSTORE_PATH);
        ensureKeystoreExists(keystoreFile);

        SslContextFactory.Server sslContextFactory = new SslContextFactory.Server();
        sslContextFactory.setKeyStorePath(keystoreFile.getAbsolutePath());
        sslContextFactory.setKeyStorePassword(TLS_KEYSTORE_PASSWORD);
        sslContextFactory.setKeyManagerPassword(TLS_KEYSTORE_PASSWORD);

        HttpConfiguration httpConfig = new HttpConfiguration();
        httpConfig.addCustomizer(new SecureRequestCustomizer());

        ServerConnector connector = new ServerConnector(
            server,
            new SslConnectionFactory(sslContextFactory, "http/1.1"),
            new HttpConnectionFactory(httpConfig)
        );
        connector.setPort(port);
        connector.setIdleTimeout(300000); // 5 minutes — transcode streams are long-lived
        return connector;
    }

    /**
     * Generate a local self-signed PKCS#12 keystore if it doesn't already exist.
     */
    private void ensureKeystoreExists(File keystoreFile) throws IOException, InterruptedException {
        if (keystoreFile.isFile()) {
            return;
        }

        File parent = keystoreFile.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("Could not create TLS keystore directory: " + parent.getAbsolutePath());
        }

        String san = "dns:localhost";
        List<String> command = new ArrayList<>();
        command.add(new File(System.getProperty("java.home"), "bin/keytool").getAbsolutePath());
        command.add("-genkeypair");
        command.add("-alias");
        command.add("pwa-miniclient");
        command.add("-keyalg");
        command.add("RSA");
        command.add("-keysize");
        command.add("2048");
        command.add("-validity");
        command.add("3650");
        command.add("-storetype");
        command.add("PKCS12");
        command.add("-keystore");
        command.add(keystoreFile.getAbsolutePath());
        command.add("-storepass");
        command.add(TLS_KEYSTORE_PASSWORD);
        command.add("-keypass");
        command.add(TLS_KEYSTORE_PASSWORD);
        command.add("-dname");
        command.add("CN=localhost, OU=SageTV, O=SageTV, L=Local, ST=Local, C=US");
        command.add("-ext");
        command.add("SAN=" + san);
        command.add("-noprompt");

        ProcessBuilder pb = new ProcessBuilder(command);
        pb.redirectErrorStream(true);
        Process process = pb.start();
        String output;
        try (java.io.InputStream in = process.getInputStream()) {
            output = new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
        int exitCode = process.waitFor();
        if (exitCode != 0) {
            throw new IOException("keytool failed to generate TLS keystore (exit " + exitCode + "): " + output);
        }
        log.info("Generated self-signed TLS keystore at {}", keystoreFile.getAbsolutePath());
    }
}
