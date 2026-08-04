package sagex.miniclient.pwa;

import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.util.Locale;

/**
 * HTTP servlet that serves raw local media files with byte-range support
 * (RFC 7233). This is the browser-safe equivalent of SageTV's port 7818
 * pull protocol (OPEN/SIZE/READ used by fork clients through
 * {@code SimplePullDataSource}): the fork's Android/desktop clients get a
 * {@code stv://<host>/<path>} URL and stream it via a raw socket; a browser
 * cannot open raw TCP sockets, so we expose an HTTP endpoint that streams
 * the same file bytes to the {@code <video>} element via native decode.
 * <p>
 * Usage: GET /rawmedia?path=/absolute/path/to/file.mp4
 * <p>
 * Only absolute paths that resolve to a regular readable file below
 * {@link #ALLOWED_PREFIXES} are served — this prevents arbitrary local
 * disclosure through path traversal.
 */
public class RawMediaServlet extends HttpServlet {
    private static final Logger log = LoggerFactory.getLogger(RawMediaServlet.class);

    // Only allow serving from typical SageTV recording / library roots.
    // Adjust here (or via env) if your install uses different mount points.
    private static final String[] ALLOWED_PREFIXES = new String[] {
        "/media/", "/var/media/", "/opt/sagetv/", "/var/lib/sagetv/", "/mnt/", "/srv/"
    };

    private static final int COPY_BUF = 64 * 1024;
    /** Poll interval while following a growing recording's EOF. */
    private static final long LIVE_POLL_MS = 100L;
    /** Stop following after this long with no growth (recording ended / client gone). */
    private static final long LIVE_IDLE_TIMEOUT_MS = 30_000L;
    /** How long to sample the file length to decide static-vs-growing. */
    private static final long GROWTH_PROBE_MS = 400L;

    @Override
    protected void doHead(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        serve(req, resp, true);
    }

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        serve(req, resp, false);
    }

    private void serve(HttpServletRequest req, HttpServletResponse resp, boolean headOnly) throws IOException {
        String rawPath = req.getParameter("path");
        if (rawPath == null || rawPath.isEmpty()) {
            resp.sendError(400, "Missing path parameter");
            return;
        }

        File file = new File(rawPath);
        String canonical;
        try {
            canonical = file.getCanonicalPath().replace('\\', '/');
        } catch (IOException e) {
            resp.sendError(400, "Bad path");
            return;
        }

        boolean allowed = false;
        for (String prefix : ALLOWED_PREFIXES) {
            if (canonical.startsWith(prefix)) { allowed = true; break; }
        }
        if (!allowed) {
            log.warn("[RawMedia] Rejected path outside allowed roots: {}", canonical);
            resp.sendError(403, "Forbidden");
            return;
        }
        if (!file.isFile() || !file.canRead()) {
            resp.sendError(404, "Not found");
            return;
        }

        long total = file.length();
        String contentType = guessContentType(canonical);

        long start = 0;
        long end = total > 0 ? total - 1 : 0;
        boolean partial = false;
        // An "open-ended" request (no Range, or "bytes=N-" with no explicit end)
        // is a play-to-end / live-edge read — the only kind that can turn into a
        // live-follow for an in-progress recording. Explicit ranges (real seeks)
        // never do, so VOD byte-range seeking stays byte-for-byte unchanged.
        boolean openEnded = false;

        String range = req.getHeader("Range");
        if (range == null) {
            openEnded = true;
        } else if (range.toLowerCase(Locale.ROOT).startsWith("bytes=")) {
            String spec = range.substring(6).trim();
            int comma = spec.indexOf(',');
            if (comma > 0) spec = spec.substring(0, comma).trim();
            int dash = spec.indexOf('-');
            if (dash < 0) {
                sendRangeNotSatisfiable(resp, total);
                return;
            }
            try {
                String s = spec.substring(0, dash).trim();
                String e = spec.substring(dash + 1).trim();
                if (s.isEmpty()) {
                    long suffix = Long.parseLong(e);
                    if (suffix <= 0) { sendRangeNotSatisfiable(resp, total); return; }
                    start = suffix >= total ? 0 : total - suffix;
                    end = total - 1;
                } else {
                    start = Long.parseLong(s);
                    end = e.isEmpty() ? total - 1 : Long.parseLong(e);
                    openEnded = e.isEmpty();
                }
            } catch (NumberFormatException nfe) {
                sendRangeNotSatisfiable(resp, total);
                return;
            }
            if (start < 0 || start >= total || end < start) {
                sendRangeNotSatisfiable(resp, total);
                return;
            }
            if (end >= total) end = total - 1;
            partial = true;
        }

        // Live-follow: an in-progress recording (growing file) served open-ended
        // must NOT advertise a finite Content-Length, or AVPlay/<video> reads to
        // the current EOF, gets a clean stream end, and STOPS (the freeze-after-a-
        // few-seconds bug on live DIRECT_PLAY). Stream it without a fixed length
        // and follow EOF until the file stops growing. The client may assert
        // liveness with ?live=1 (from the NG isLive context); otherwise we infer
        // it with a short growth probe. HEAD and explicit-range seeks are never
        // followed — they use the static path below (VOD unchanged).
        if (!headOnly && openEnded) {
            String liveParam = req.getParameter("live");
            boolean liveHint = liveParam != null
                && (liveParam.equals("1") || liveParam.equalsIgnoreCase("true"));
            if (liveHint || isGrowing(file, total)) {
                serveGrowing(resp, file, start, contentType);
                return;
            }
        }

        long length = (end >= start) ? (end - start + 1) : 0;

        resp.setStatus(partial ? 206 : 200);
        resp.setHeader("Accept-Ranges", "bytes");
        resp.setHeader("Cache-Control", "no-store");
        resp.setContentType(contentType);
        if (partial) {
            resp.setHeader("Content-Range", "bytes " + start + "-" + end + "/" + total);
        }
        // Use header form so values > Integer.MAX_VALUE (large recordings) stay accurate.
        resp.setHeader("Content-Length", Long.toString(length));

        if (headOnly || length == 0) {
            resp.flushBuffer();
            return;
        }

        try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
            raf.seek(start);
            OutputStream out = resp.getOutputStream();
            byte[] buf = new byte[COPY_BUF];
            long remaining = length;
            while (remaining > 0) {
                int want = (int) Math.min(remaining, buf.length);
                int n = raf.read(buf, 0, want);
                if (n < 0) break;
                out.write(buf, 0, n);
                remaining -= n;
            }
            out.flush();
        } catch (IOException ioe) {
            // Client-side aborts (seek / close) are normal — log at debug.
            log.debug("[RawMedia] transfer aborted for {}: {}", canonical, ioe.toString());
        }
    }

    /**
     * Probe whether a file is an in-progress (growing) recording by sampling its
     * length across a short window. Only called for open-ended requests, so it
     * never delays VOD seeks.
     */
    private static boolean isGrowing(File file, long len0) {
        try {
            Thread.sleep(GROWTH_PROBE_MS);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            return false;
        }
        return file.length() > len0;
    }

    /**
     * Stream a growing (in-progress recording) file from {@code start} WITHOUT a
     * finite Content-Length, following EOF as the recording grows. This is the
     * raw-file analogue of {@link MediaServerProxyServlet}'s growing-source
     * stream: AVPlay/&lt;video&gt; then treats the response as a live stream and
     * keeps reading instead of stopping at the current EOF. Bounded: we stop
     * after {@link #LIVE_IDLE_TIMEOUT_MS} with no growth (recording ended), or
     * when the client disconnects.
     */
    private void serveGrowing(HttpServletResponse resp, File file, long start,
                              String contentType) throws IOException {
        resp.setStatus(200);
        resp.setHeader("Cache-Control", "no-store");
        // No byte-range semantics for a live stream, and deliberately NO
        // Content-Length: the final size is unknown while recording.
        resp.setHeader("Accept-Ranges", "none");
        resp.setContentType(contentType);

        try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
            if (start > 0) raf.seek(start);
            OutputStream out = resp.getOutputStream();
            byte[] buf = new byte[COPY_BUF];
            long offset = start;
            long frontier = file.length();
            long lastGrowthAt = System.currentTimeMillis();

            while (true) {
                if (offset >= frontier) {
                    long nf = file.length();
                    if (nf > frontier) {
                        frontier = nf;
                        lastGrowthAt = System.currentTimeMillis();
                        continue;
                    }
                    if (System.currentTimeMillis() - lastGrowthAt > LIVE_IDLE_TIMEOUT_MS) {
                        log.info("[RawMedia] live stream idle {}ms after {} bytes, ending",
                            LIVE_IDLE_TIMEOUT_MS, offset);
                        break;
                    }
                    try {
                        Thread.sleep(LIVE_POLL_MS);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                    continue;
                }
                int want = (int) Math.min(frontier - offset, buf.length);
                int n = raf.read(buf, 0, want);
                if (n < 0) {
                    // frontier said bytes exist but the write isn't flushed yet —
                    // re-poll rather than treat as EOF.
                    try {
                        Thread.sleep(LIVE_POLL_MS);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                    continue;
                }
                out.write(buf, 0, n);
                offset += n;
            }
            out.flush();
        } catch (IOException ioe) {
            // Client aborts (channel change / close) are normal.
            log.debug("[RawMedia] live transfer aborted: {}", ioe.toString());
        }
    }

    private static void sendRangeNotSatisfiable(HttpServletResponse resp, long total) throws IOException {
        resp.setStatus(416);
        resp.setHeader("Content-Range", "bytes */" + total);
        resp.setContentLength(0);
        resp.flushBuffer();
    }

    private static String guessContentType(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        int dot = lower.lastIndexOf('.');
        String ext = dot >= 0 ? lower.substring(dot + 1) : "";
        switch (ext) {
            case "mp4": case "m4v": case "mov": return "video/mp4";
            case "mkv": return "video/x-matroska";
            case "webm": return "video/webm";
            case "ts": case "m2ts": case "mts": return "video/mp2t";
            case "mpg": case "mpeg": case "mp2": case "vob": case "m2v": return "video/mpeg";
            case "avi": return "video/x-msvideo";
            case "flv": return "video/x-flv";
            case "wmv": case "asf": return "video/x-ms-wmv";
            case "m3u8": return "application/vnd.apple.mpegurl";
            case "mp3": return "audio/mpeg";
            case "aac": return "audio/aac";
            case "flac": return "audio/flac";
            case "wav": return "audio/wav";
            case "ogg": case "oga": return "audio/ogg";
            case "opus": return "audio/opus";
            default: return "application/octet-stream";
        }
    }
}
