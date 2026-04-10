package sagex.miniclient.pwa;

import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.server.ServerConnector;
import org.eclipse.jetty.servlet.DefaultServlet;
import org.eclipse.jetty.servlet.ServletContextHandler;
import org.eclipse.jetty.servlet.ServletHolder;
import org.eclipse.jetty.websocket.server.config.JettyWebSocketServletContainerInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

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

    private final int port;
    private final String webRoot;
    private final String ffmpegPath;
    private Server server;

    public BridgeServer(int port, String webRoot, String ffmpegPath) {
        this.port = port;
        this.webRoot = webRoot;
        this.ffmpegPath = ffmpegPath;
    }

    public void start() throws Exception {
        server = new Server();

        ServerConnector connector = new ServerConnector(server);
        connector.setPort(port);
        connector.setIdleTimeout(300000); // 5 minutes — transcode streams are long-lived
        server.addConnector(connector);

        ServletContextHandler context = new ServletContextHandler(ServletContextHandler.SESSIONS);
        context.setContextPath("/");
        server.setHandler(context);

        // WebSocket endpoints at /gfx and /media
        JettyWebSocketServletContainerInitializer.configure(context, (servletContext, wsContainer) -> {
            wsContainer.setMaxBinaryMessageSize(65536);
            wsContainer.setMaxTextMessageSize(65536);
            wsContainer.setIdleTimeout(Duration.ofMinutes(30));
            wsContainer.addMapping("/gfx", (upgradeRequest, upgradeResponse) -> new BridgeWebSocket());
            wsContainer.addMapping("/media", (upgradeRequest, upgradeResponse) -> new BridgeWebSocket());
            wsContainer.addMapping("/reconnect", (upgradeRequest, upgradeResponse) -> new BridgeWebSocket());
        });

        // Transcode servlet
        context.addServlet(new ServletHolder("transcode", new TranscodeServlet(ffmpegPath)), "/transcode");
        context.addServlet(new ServletHolder("transcode-stop", new TranscodeStopServlet()), "/transcode/stop");

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
        log.info("PWA at http://localhost:{}/", port);
        log.info("WebSocket endpoints: ws://localhost:{}/gfx, /media", port);
        log.info("Transcode endpoint:  http://localhost:{}/transcode?file=<path>&seek=<sec>", port);
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
}
