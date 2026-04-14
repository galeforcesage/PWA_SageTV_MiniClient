package sagex.miniclient.pwa;

import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.TimeUnit;

/**
 * REST endpoint returning JSON describing the SageTV server's ffmpeg
 * capabilities so the PWA can choose the right transcoding profile.
 * <p>
 * GET /api/server-info
 * <p>
 * Response:
 * <pre>
 * {
 *   "serverType": "standard" | "modern",
 *   "serverFfmpeg": {
 *     "path": "/opt/sagetv/server/ffmpeg",
 *     "version": "git-8090fdcc" | "6.6.2",
 *     "encoders": ["libx264","libx265","aac","libopus", ...]
 *   },
 *   "bridgeFfmpeg": {
 *     "path": "ffmpeg",
 *     "version": "4.4.2",
 *     "encoders": ["libx264","libx265","aac","libopus", ...]
 *   }
 * }
 * </pre>
 */
public class ServerInfoServlet extends HttpServlet {
    private static final Logger log = LoggerFactory.getLogger(ServerInfoServlet.class);

    /** Paths to check for the SageTV server's own ffmpeg binary. */
    private static final String[] SERVER_FFMPEG_PATHS = {
            "/opt/sagetv/server/sagetvffmpeg",
            "/opt/sagetv/server/ffmpeg",
    };

    private final String bridgeFfmpegPath;

    /** Cached result — probed once at first request. */
    private volatile String cachedJson;

    public ServerInfoServlet(String bridgeFfmpegPath) {
        this.bridgeFfmpegPath = bridgeFfmpegPath;
    }

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        resp.setContentType("application/json");
        resp.setCharacterEncoding("UTF-8");
        resp.setHeader("Cache-Control", "no-cache");

        if (cachedJson == null) {
            cachedJson = buildServerInfo();
        }
        resp.getWriter().write(cachedJson);
    }

    private String buildServerInfo() {
        // 1. Find and probe the SageTV server ffmpeg
        FfmpegInfo serverInfo = probeServerFfmpeg();

        // 2. Probe the bridge's own ffmpeg
        FfmpegInfo bridgeInfo = probeFfmpeg(bridgeFfmpegPath);

        // 3. Determine server type
        String serverType = detectServerType(serverInfo);

        // Build JSON manually to avoid adding a JSON library dependency
        StringBuilder sb = new StringBuilder();
        sb.append("{\n");
        sb.append("  \"serverType\": ").append(jsonStr(serverType)).append(",\n");
        sb.append("  \"serverFfmpeg\": ").append(infoToJson(serverInfo)).append(",\n");
        sb.append("  \"bridgeFfmpeg\": ").append(infoToJson(bridgeInfo)).append("\n");
        sb.append("}");

        String json = sb.toString();
        log.info("[ServerInfo] Detected server type: {} (server ffmpeg: {}, bridge ffmpeg: {})",
                serverType,
                serverInfo != null ? serverInfo.version : "not found",
                bridgeInfo != null ? bridgeInfo.version : "not found");
        return json;
    }

    /**
     * Find the SageTV server's own ffmpeg by checking known paths.
     */
    private FfmpegInfo probeServerFfmpeg() {
        for (String path : SERVER_FFMPEG_PATHS) {
            if (Files.isExecutable(Path.of(path))) {
                FfmpegInfo info = probeFfmpeg(path);
                if (info != null) return info;
            }
        }
        return null;
    }

    /**
     * Run ffmpeg to get version and encoder list.
     */
    private FfmpegInfo probeFfmpeg(String path) {
        if (path == null || path.isEmpty()) return null;

        try {
            // Get version
            String version = runCommand(path, "-version");
            if (version == null) return null;

            // Parse version string from first line
            // "FFmpeg version git-8090fdcc" or "ffmpeg version 6.6.2"
            String parsedVersion = parseVersion(version);

            // Get encoders
            String encodersOutput = runCommand(path, "-encoders");
            List<String> encoders = parseEncoders(encodersOutput);

            FfmpegInfo info = new FfmpegInfo();
            info.path = path;
            info.version = parsedVersion;
            info.versionFull = version.split("\n")[0]; // First line only
            info.encoders = encoders;
            return info;
        } catch (Exception e) {
            log.warn("[ServerInfo] Error probing ffmpeg at {}: {}", path, e.getMessage());
            return null;
        }
    }

    private String runCommand(String... cmd) {
        try {
            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            Process proc = pb.start();

            StringBuilder output = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(proc.getInputStream()))) {
                String line;
                int lineCount = 0;
                while ((line = r.readLine()) != null && lineCount < 500) {
                    output.append(line).append("\n");
                    lineCount++;
                }
            }

            proc.waitFor(10, TimeUnit.SECONDS);
            return output.toString();
        } catch (Exception e) {
            log.debug("[ServerInfo] Command failed: {}", e.getMessage());
            return null;
        }
    }

    /**
     * Parse version from ffmpeg -version output.
     * Handles: "FFmpeg version git-8090fdcc", "ffmpeg version 6.6.2", "ffmpeg version 4.4.2-0ubuntu..."
     */
    private String parseVersion(String output) {
        if (output == null) return "unknown";
        String firstLine = output.split("\n")[0].toLowerCase();
        // Look for "version X" pattern
        int idx = firstLine.indexOf("version ");
        if (idx >= 0) {
            String rest = firstLine.substring(idx + 8).trim();
            // Take until first space or comma
            int end = rest.indexOf(' ');
            int comma = rest.indexOf(',');
            if (comma >= 0 && (end < 0 || comma < end)) end = comma;
            if (end > 0) rest = rest.substring(0, end);
            return rest;
        }
        return "unknown";
    }

    /**
     * Parse encoder names from ffmpeg -encoders output.
     * Lines look like: " V..... libx264              ..."
     */
    private List<String> parseEncoders(String output) {
        List<String> encoders = new ArrayList<>();
        if (output == null) return encoders;

        // Encoders we care about for transcoding decisions
        Set<String> interesting = Set.of(
                "libx264", "libx265", "h264_nvenc", "hevc_nvenc",
                "h264_vaapi", "hevc_vaapi", "h264_qsv", "hevc_qsv",
                "h264_videotoolbox", "hevc_videotoolbox",
                "libvpx", "libvpx-vp9", "libaom-av1", "libsvtav1",
                "aac", "libfdk_aac", "libfaac", "libopus", "ac3", "eac3",
                "libmp3lame", "libvorbis", "flac", "pcm_s16le"
        );

        for (String line : output.split("\n")) {
            line = line.trim();
            // Skip header lines — encoder lines start with [VASFXDB]
            if (line.length() < 8 || line.charAt(0) == '=') continue;
            if (!" VASFXD".contains(String.valueOf(line.charAt(0)))) continue;

            // Format: "V..... name     description"
            String[] parts = line.substring(7).trim().split("\\s+", 2);
            if (parts.length > 0) {
                String name = parts[0].trim();
                if (interesting.contains(name)) {
                    encoders.add(name);
                }
            }
        }
        return encoders;
    }

    /**
     * Determine if this server has a modern SageTVffmpeg (6.x+) or the
     * legacy/stock build (~2010, libx264 only).
     * <p>
     * Returns "modern" for SageTVffmpeg 6.x+ (libx265, libfdk_aac, etc.)
     * or "standard" for legacy builds.
     */
    private String detectServerType(FfmpegInfo serverInfo) {
        if (serverInfo == null) return "unknown";

        // Check for modern version (5.x+)
        if (serverInfo.version != null && !serverInfo.version.startsWith("git-")) {
            try {
                int major = Integer.parseInt(serverInfo.version.split("[\\.-]")[0]);
                if (major >= 5) return "modern";
            } catch (NumberFormatException ignored) {}
        }

        // Check for HEVC encoder presence — definitive sign of modern build
        if (serverInfo.encoders != null) {
            for (String enc : serverInfo.encoders) {
                if (enc.contains("x265") || enc.contains("hevc") || enc.contains("svtav1") || enc.contains("aom")) {
                    return "modern";
                }
            }
        }

        return "standard";
    }

    private String infoToJson(FfmpegInfo info) {
        if (info == null) return "null";
        StringBuilder sb = new StringBuilder();
        sb.append("{\n");
        sb.append("    \"path\": ").append(jsonStr(info.path)).append(",\n");
        sb.append("    \"version\": ").append(jsonStr(info.version)).append(",\n");
        sb.append("    \"versionFull\": ").append(jsonStr(info.versionFull)).append(",\n");
        sb.append("    \"encoders\": [");
        for (int i = 0; i < info.encoders.size(); i++) {
            if (i > 0) sb.append(", ");
            sb.append(jsonStr(info.encoders.get(i)));
        }
        sb.append("]\n");
        sb.append("  }");
        return sb.toString();
    }

    /** JSON-escape a string value. */
    private String jsonStr(String s) {
        if (s == null) return "null";
        return "\"" + s.replace("\\", "\\\\")
                       .replace("\"", "\\\"")
                       .replace("\n", "\\n")
                       .replace("\r", "\\r")
                       .replace("\t", "\\t") + "\"";
    }

    private static class FfmpegInfo {
        String path;
        String version;
        String versionFull;
        List<String> encoders = new ArrayList<>();
    }
}
