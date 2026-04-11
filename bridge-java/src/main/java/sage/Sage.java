package sage;

/**
 * Stub class for compiling SageTV plugins.
 * At runtime, the real SageTV server provides this class with
 * property storage backed by Sage.properties.
 */
public class Sage {
    public static String get(String key, String defaultValue) {
        return defaultValue;
    }

    public static void put(String key, String value) {
    }

    public static int getInt(String key, int defaultValue) {
        return defaultValue;
    }

    public static void putInt(String key, int value) {
    }

    public static boolean getBoolean(String key, boolean defaultValue) {
        return defaultValue;
    }

    public static void putBoolean(String key, boolean value) {
    }

    public static void savePrefs() {
    }
}
