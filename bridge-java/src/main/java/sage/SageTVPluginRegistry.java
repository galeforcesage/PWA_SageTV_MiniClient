package sage;

/**
 * Stub interface for compiling SageTV plugins.
 * At runtime, the real SageTV server provides this interface.
 */
public interface SageTVPluginRegistry {
    String getSetting(String key, String defaultValue);
    void setSetting(String key, String value);
}
