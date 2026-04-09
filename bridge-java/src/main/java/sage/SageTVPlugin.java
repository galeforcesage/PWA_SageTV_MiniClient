package sage;

import java.util.Map;

/**
 * Stub interface for compiling SageTV plugins.
 * At runtime, the real SageTV server provides this interface.
 */
public interface SageTVPlugin {
    int CONFIG_BOOL = 1;
    int CONFIG_INTEGER = 2;
    int CONFIG_TEXT = 3;
    int CONFIG_CHOICE = 4;
    int CONFIG_MULTICHOICE = 5;
    int CONFIG_FILE = 6;
    int CONFIG_DIRECTORY = 7;
    int CONFIG_BUTTON = 8;
    int CONFIG_PASSWORD = 9;

    void start();
    void stop();
    void destroy();
    String[] getConfigSettings();
    String getConfigValue(String setting);
    String[] getConfigValues(String setting);
    int getConfigType(String setting);
    void setConfigValue(String setting, String value);
    void setConfigValues(String setting, String[] values);
    String[] getConfigOptions(String setting);
    String getConfigHelpText(String setting);
    String getConfigLabel(String setting);
    void resetConfig();
    void sageEvent(String eventName, Map eventVars);
}
