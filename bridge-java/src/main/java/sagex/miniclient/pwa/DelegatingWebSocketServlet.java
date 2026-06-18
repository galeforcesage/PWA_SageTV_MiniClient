package sagex.miniclient.pwa;

import org.eclipse.jetty.websocket.servlet.WebSocketServlet;
import org.eclipse.jetty.websocket.servlet.WebSocketServletFactory;

/**
 * WebSocket servlet that delegates endpoint instance creation.
 */
public class DelegatingWebSocketServlet extends WebSocketServlet {
    private static final long serialVersionUID = 1L;

    public interface EndpointFactory {
        Object create();
    }

    private final EndpointFactory endpointFactory;

    public DelegatingWebSocketServlet(EndpointFactory endpointFactory) {
        this.endpointFactory = endpointFactory;
    }

    @Override
    public void configure(WebSocketServletFactory factory) {
        factory.getPolicy().setMaxBinaryMessageSize(65536);
        factory.getPolicy().setMaxTextMessageSize(65536);
        factory.getPolicy().setIdleTimeout(30L * 60L * 1000L);
        factory.setCreator((req, resp) -> endpointFactory.create());
    }
}
