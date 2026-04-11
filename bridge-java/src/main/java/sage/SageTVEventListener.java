package sage;

import java.util.Map;

/**
 * Stub interface for compiling SageTV plugins.
 * At runtime, the real SageTV server provides this interface.
 */
public interface SageTVEventListener {
    void sageEvent(String eventName, Map eventVars);
}
