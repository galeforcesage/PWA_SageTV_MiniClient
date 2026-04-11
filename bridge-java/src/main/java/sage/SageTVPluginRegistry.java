package sage;

/**
 * Stub interface for compiling SageTV plugins.
 * At runtime, the real SageTV server provides this interface.
 */
public interface SageTVPluginRegistry {
    void eventSubscribe(SageTVEventListener listener, String eventName);
    void eventUnsubscribe(SageTVEventListener listener, String eventName);
    void postEvent(String eventName, java.util.Map eventVars);
    void postEvent(String eventName, java.util.Map eventVars, boolean wait);
}
