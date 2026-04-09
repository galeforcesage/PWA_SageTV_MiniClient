package sagex.miniclient.pwa;

/**
 * Standalone entry point for running the bridge outside SageTV.
 * <p>
 * Usage: java -jar pwa-miniclient-bridge.jar [--port 8099] [--web-root /path/to/public]
 */
public class BridgeMain {

    public static void main(String[] args) throws Exception {
        int port = 8099;
        String webRoot = null;

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--port":
                    if (i + 1 < args.length) port = Integer.parseInt(args[++i]);
                    break;
                case "--web-root":
                    if (i + 1 < args.length) webRoot = args[++i];
                    break;
            }
        }

        BridgeServer server = new BridgeServer(port, webRoot);
        server.start();

        // Shutdown hook for clean exit
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            try {
                server.stop();
            } catch (Exception e) {
                e.printStackTrace();
            }
        }));

        server.join();
    }
}
