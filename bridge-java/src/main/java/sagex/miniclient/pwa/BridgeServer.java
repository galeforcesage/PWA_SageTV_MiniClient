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
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import sagex.miniclient.pwa.ngcontext.ActivePlaybackSessionTracker;
import sagex.miniclient.pwa.ngcontext.InJvmNgPlaybackContextBridgeProvider;
import sagex.miniclient.pwa.ngcontext.NgPlaybackContextBridgeProvider;
import sagex.miniclient.pwa.ngcontext.NgPlaybackContextServlet;
import sagex.miniclient.pwa.ngcontext.NoopNgPlaybackContextBridgeProvider;

import java.io.File;
import java.io.IOException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

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
    /** Offset from the primary TLS port for the plain-HTTP companion listener.
     *  Cert-strict WebViews (Tizen wgt, iOS PWA without the CA installed) can't
     *  accept our self-signed cert, so they connect over ws://host:(port+HTTP_PORT_OFFSET). */
    private static final int HTTP_PORT_OFFSET = 1;

    private final int port;
    private final String webRoot;
    private final String ffmpegPath;
    private final String hwAccel;
    private final String username;
    private final String password;
    private Server server;
    private DiscoveryServlet discoveryServlet;
    private ActivePlaybackSessionTracker sessionTracker;

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

        ServerConnector tlsConnector = createHttpsConnector(server, port);
        server.addConnector(tlsConnector);

        int httpPort = port + HTTP_PORT_OFFSET;
        ServerConnector httpConnector = createHttpConnector(server, httpPort);
        server.addConnector(httpConnector);

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
        context.addServlet(new ServletHolder("ws-gfx",
            new DelegatingWebSocketServlet(BridgeWebSocket::new)), "/gfx");
        context.addServlet(new ServletHolder("ws-media",
            new DelegatingWebSocketServlet(BridgeWebSocket::new)), "/media");
        context.addServlet(new ServletHolder("ws-reconnect",
            new DelegatingWebSocketServlet(BridgeWebSocket::new)), "/reconnect");

        // Transcode servlet — browser MSE fallback for codecs a browser can't
        // decode natively (the TV uses AVPlay direct-play instead). The legacy
        // push-transcode WebSocket was removed: the PWA is pull-only
        // (PUSH_AV_CONTAINERS=NONE), so nothing ever connected to it.
        context.addServlet(new ServletHolder("transcode", new TranscodeServlet(ffmpegPath, hwAccel)), "/transcode");
        context.addServlet(new ServletHolder("transcode-stop", new TranscodeStopServlet()), "/transcode/stop");

        // Raw file pass-through for DIRECT_PLAY compatible sources — browser-safe
        // equivalent of SageTV's port 7818 pull socket protocol used by fork clients.
        context.addServlet(new ServletHolder("rawmedia", new RawMediaServlet()), "/rawmedia");

        // Thin proxy over SageTV's MediaServer :7818 pull protocol — server-side
        // remux/transcode (legacy + NG), zero bridge ffmpeg. Handles live
        // (in-progress) recordings by following SIZE growth. On NG this carries
        // the server's per-stream verdict (server-authoritative); on legacy the
        // client picks the mode (client-authoritative).
        context.addServlet(new ServletHolder("msproxy", new MediaServerProxyServlet()), "/msproxy");

        // Server info API — probes ffmpeg capabilities for profile auto-detection
        context.addServlet(new ServletHolder("server-info", new ServerInfoServlet(ffmpegPath)), "/api/server-info");

        // Runtime client capability feedback and persisted profile refinement.
        Path feedbackStorePath = Paths.get("pwa-miniclient", "data", "client-capability-profiles.json");
        ClientCapabilityProfileStore profileStore = new ClientCapabilityProfileStore(feedbackStorePath);
        context.addServlet(new ServletHolder("client-feedback", new ClientFeedbackServlet(profileStore)), "/api/client-feedback");

        // Secure proxy for Sage transfer download endpoints.
        context.addServlet(new ServletHolder("transfer-proxy", new TransferProxyServlet("localhost", 31099)), "/api/transfers/*");

        // NG Playback Context metadata endpoint — returns current context for
        // the active PWA session, or unavailable with a reason. Uses the in-JVM
        // provider to call NgPlaybackContextService directly (reflection-based,
        // graceful fallback if service not deployed).
        sessionTracker = new ActivePlaybackSessionTracker();
        sessionTracker.start();
        BridgeWebSocket.setSessionTracker(sessionTracker);

        NgPlaybackContextBridgeProvider ngProvider = new InJvmNgPlaybackContextBridgeProvider(sessionTracker);
        NgPlaybackContextServlet ngContextServlet = new NgPlaybackContextServlet(ngProvider);
        context.addServlet(new ServletHolder("ng-context", ngContextServlet), "/ng/*");

        // LAN discovery — broadcasts SageTV locator probes so the PWA can
        // populate its server picker without needing UDP itself. Purely
        // ON-DEMAND: the bridge scans only when a client calls /discover, and
        // the client bounds the window (~3s on open, ~5s on Find-on-LAN). No
        // perpetual background scanning when nobody is asking.
        DiscoveryServlet discoveryServlet = new DiscoveryServlet();
        this.discoveryServlet = discoveryServlet;
        context.addServlet(new ServletHolder("discover", discoveryServlet), "/discover");

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
        int httpListenPort = port + HTTP_PORT_OFFSET;
        log.info("PWA MiniClient Bridge running on ports {} (TLS) and {} (plain HTTP)", port, httpListenPort);
        log.info("PWA at https://localhost:{}/  (or http://localhost:{}/ for cert-strict WebViews)", port, httpListenPort);
        log.info("WebSocket endpoints: wss://localhost:{}/gfx,/media  or  ws://localhost:{}/gfx,/media", port, httpListenPort);
        log.info("Transcode endpoint:  https://localhost:{}/transcode?file=<path>&seek=<sec>", port);
    }

    public void stop() throws Exception {
        if (discoveryServlet != null) {
            discoveryServlet.stopBackgroundScanner();
        }
        if (sessionTracker != null) {
            sessionTracker.stop();
        }
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
     * Create a plain HTTP/1.1 connector. Used as a companion to the TLS listener
     * so cert-strict WebViews (Tizen wgt, iOS PWA installs without our CA) can
     * connect over ws://.
     */
    private ServerConnector createHttpConnector(Server server, int httpPort) {
        ServerConnector connector = new ServerConnector(
            server,
            new HttpConnectionFactory(new HttpConfiguration())
        );
        connector.setPort(httpPort);
        connector.setIdleTimeout(300000);
        return connector;
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
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) != -1) {
                out.write(buffer, 0, n);
            }
            output = out.toString("UTF-8");
        }
        int exitCode = process.waitFor();
        if (exitCode != 0) {
            throw new IOException("keytool failed to generate TLS keystore (exit " + exitCode + "): " + output);
        }
        log.info("Generated self-signed TLS keystore at {}", keystoreFile.getAbsolutePath());
    }
}
