package sagex.miniclient.pwa;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.util.*;
import java.util.concurrent.TimeUnit;

/**
 * Detects and configures ffmpeg hardware acceleration across platforms.
 * <p>
 * Supported backends (priority order for "auto"):
 * <ul>
 *   <li><b>nvenc</b>  — NVIDIA GPU (Linux + Windows, requires nvidia drivers)</li>
 *   <li><b>qsv</b>    — Intel QuickSync (Linux + Windows, requires Intel GPU)</li>
 *   <li><b>vaapi</b>  — VA-API (Linux AMD/Intel, requires /dev/dri/renderD128)</li>
 *   <li><b>videotoolbox</b> — macOS hardware encoder</li>
 *   <li><b>none</b>   — Software libx264 (always works)</li>
 * </ul>
 * <p>
 * Set hwaccel to "auto" to probe at startup and pick the best available.
 */
public class HwAccel {
    private static final Logger log = LoggerFactory.getLogger(HwAccel.class);

    /** Detected backend name (e.g. "nvenc", "vaapi", "qsv", "none"). */
    public final String name;

    /** Human-readable description for logs. */
    public final String description;

    // ffmpeg flags for this backend
    final List<String> inputFlags;   // before -i
    final String videoEncoder;       // -c:v value
    final List<String> encoderFlags; // after -c:v, before audio
    final String scaleFilter;        // -vf value (null → use -s instead)

    private HwAccel(String name, String description,
                    List<String> inputFlags, String videoEncoder,
                    List<String> encoderFlags, String scaleFilter) {
        this.name = name;
        this.description = description;
        this.inputFlags = inputFlags;
        this.videoEncoder = videoEncoder;
        this.encoderFlags = encoderFlags;
        this.scaleFilter = scaleFilter;
    }

    /** Software-only fallback — always available. */
    static HwAccel software() {
        return new HwAccel("none", "Software (libx264)",
                List.of(),
                "libx264",
                List.of("-preset", "veryfast", "-tune", "zerolatency"),
                null);
    }

    static HwAccel vaapi() {
        return new HwAccel("vaapi", "VA-API (AMD/Intel GPU)",
                List.of("-hwaccel", "vaapi",
                        "-hwaccel_device", "/dev/dri/renderD128",
                        "-hwaccel_output_format", "vaapi"),
                "h264_vaapi",
                List.of(),
                "scale_vaapi=w=1280:h=720");
    }

    static HwAccel nvenc() {
        return new HwAccel("nvenc", "NVIDIA NVENC",
                List.of("-hwaccel", "cuda",
                        "-hwaccel_output_format", "cuda"),
                "h264_nvenc",
                List.of("-preset", "p4", "-tune", "ll"),
                "scale_cuda=w=1280:h=720");
    }

    static HwAccel qsv() {
        return new HwAccel("qsv", "Intel QuickSync",
                List.of("-hwaccel", "qsv",
                        "-hwaccel_output_format", "qsv"),
                "h264_qsv",
                List.of("-preset", "veryfast"),
                "scale_qsv=w=1280:h=720");
    }

    static HwAccel videoToolbox() {
        return new HwAccel("videotoolbox", "macOS VideoToolbox",
                List.of("-hwaccel", "videotoolbox"),
                "h264_videotoolbox",
                List.of("-realtime", "1"),
                null);
    }

    /**
     * Detect the best available hardware encoder.
     *
     * @param ffmpegPath path to ffmpeg binary
     * @param preference user setting: "auto", "nvenc", "vaapi", "qsv", "videotoolbox", or "none"
     * @return resolved HwAccel (never null, falls back to software)
     */
    public static HwAccel detect(String ffmpegPath, String preference) {
        String pref = (preference == null) ? "auto" : preference.trim().toLowerCase();

        if ("none".equals(pref) || pref.isEmpty()) {
            HwAccel sw = software();
            log.info("[HwAccel] Using software encoding (configured)");
            return sw;
        }

        // Specific backend requested
        if (!"auto".equals(pref)) {
            HwAccel accel = byName(pref);
            if (accel == null) {
                log.warn("[HwAccel] Unknown backend '{}', falling back to software", pref);
                return software();
            }
            if (probe(ffmpegPath, accel)) {
                log.info("[HwAccel] Using {} — {}", accel.name, accel.description);
                return accel;
            }
            log.warn("[HwAccel] Requested '{}' not available, falling back to software", pref);
            return software();
        }

        // Auto-detect: try each in priority order
        log.info("[HwAccel] Auto-detecting hardware acceleration...");
        String os = System.getProperty("os.name", "").toLowerCase();

        List<HwAccel> candidates = new ArrayList<>();
        if (os.contains("mac")) {
            candidates.add(videoToolbox());
        } else {
            // NVENC works on both Linux and Windows
            candidates.add(nvenc());
            // QSV works on both Linux and Windows
            candidates.add(qsv());
            if (!os.contains("win")) {
                // VAAPI is Linux-only
                candidates.add(vaapi());
            }
        }

        for (HwAccel accel : candidates) {
            if (probe(ffmpegPath, accel)) {
                log.info("[HwAccel] Auto-detected: {} — {}", accel.name, accel.description);
                return accel;
            }
            log.debug("[HwAccel] {} not available, trying next...", accel.name);
        }

        log.info("[HwAccel] No hardware acceleration available, using software encoding");
        return software();
    }

    private static HwAccel byName(String name) {
        switch (name) {
            case "vaapi":        return vaapi();
            case "nvenc":        return nvenc();
            case "qsv":          return qsv();
            case "videotoolbox": return videoToolbox();
            default:             return null;
        }
    }

    /**
     * Probe whether a backend actually works by running a quick ffmpeg test encode.
     * Encodes 1 frame of generated video — if ffmpeg exits 0, the backend is usable.
     */
    private static boolean probe(String ffmpegPath, HwAccel accel) {
        try {
            List<String> cmd = new ArrayList<>();
            cmd.add(ffmpegPath);
            cmd.addAll(accel.inputFlags);
            cmd.addAll(List.of(
                    "-f", "lavfi", "-i", "color=black:s=64x64:d=0.04:r=25",
                    "-frames:v", "1",
                    "-c:v", accel.videoEncoder
            ));
            cmd.addAll(accel.encoderFlags);
            if (accel.scaleFilter != null) {
                cmd.addAll(List.of("-vf", accel.scaleFilter));
            }
            cmd.addAll(List.of("-f", "null", "-"));

            log.debug("[HwAccel] Probing {}: {}", accel.name, String.join(" ", cmd));

            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            Process proc = pb.start();

            // Drain output to prevent blocking
            try (BufferedReader r = new BufferedReader(new InputStreamReader(proc.getInputStream()))) {
                while (r.readLine() != null) { /* drain */ }
            }

            boolean finished = proc.waitFor(10, TimeUnit.SECONDS);
            if (!finished) {
                proc.destroyForcibly();
                log.debug("[HwAccel] Probe {} timed out", accel.name);
                return false;
            }

            boolean ok = proc.exitValue() == 0;
            log.debug("[HwAccel] Probe {} exit={} ok={}", accel.name, proc.exitValue(), ok);
            return ok;
        } catch (Exception e) {
            log.debug("[HwAccel] Probe {} error: {}", accel.name, e.getMessage());
            return false;
        }
    }
}
