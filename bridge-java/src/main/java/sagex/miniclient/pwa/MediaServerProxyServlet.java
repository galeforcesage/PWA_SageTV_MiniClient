package sagex.miniclient.pwa;

import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Thin byte proxy in front of SageTV's MediaServer {@code :7818} pull protocol.
 * <p>
 * The bridge runs <b>no ffmpeg</b> for this path: it opens one TCP connection to
 * the in-container MediaServer per client stream, tells the server how to
 * condition the stream ({@code XCODE_SETUP}), then relays bytes to the browser /
 * TV over HTTP. All remux/transcode work is done by the SageTV server (legacy
 * <b>and</b> NG); on NG the same connection additionally carries live
 * bandwidth-adaptive bitrate via {@code XCODE_ADJUST}.
 * <p>
 * Control model (see docs/mediaserver-xcode-proxy-spec.md):
 * <ul>
 *   <li><b>NG (server-authoritative)</b> — the PWA honors the server's per-stream
 *       verdict and passes it here as {@code mode}; this servlet just relays.</li>
 *   <li><b>Legacy (client-authoritative)</b> — the PWA sniffs the codec and
 *       chooses {@code mode} itself (or falls back to {@code /transcode}).</li>
 * </ul>
 * Either way the servlet is mode-agnostic: it does what {@code mode} says.
 * <p>
 * {@code GET /msproxy?path=<abs>|mfid=<id>&mode=<direct|remux:ps|remux:ts|xcode:<q>>&seek=<sec>}
 * <p>
 * {@code :7818} grammar (verified against sage.MediaServer):
 * <pre>
 *   OPEN &lt;path&gt;          -> OK\r\n | NO_EXIST\r\n | NON_MEDIA\r\n
 *   SIZE                  -> &lt;avail&gt; &lt;total&gt;\r\n   (avail==total => static file;
 *                                                    avail!=total => growing/live/xcode)
 *   READ &lt;off&gt; &lt;len&gt;     -> exactly len raw bytes (0xFF-padded past EOF)
 *   XCODE_SETUP &lt;mode&gt;   -> OK\r\n   (must precede OPEN so the transcoder starts)
 *   XCODE_ADJUST &lt;kbps&gt;  -> &lt;newKbps&gt;\r\n (NG) | NO_INIT\r\n | PARAM_ERROR\r\n
 *   CLOSE                 -> OK\r\n
 * </pre>
 */
public class MediaServerProxyServlet extends HttpServlet {
    private static final Logger log = LoggerFactory.getLogger(MediaServerProxyServlet.class);

    /** Same recording / library roots the raw pass-through allows. */
    private static final String[] ALLOWED_PREFIXES = new String[] {
        "/media/", "/var/media/", "/opt/sagetv/", "/var/lib/sagetv/", "/mnt/", "/srv/"
    };

    private static final int COPY_BUF = 64 * 1024;
    /** Max idle (no new bytes appearing) before we give up on a live stream. */
    private static final long LIVE_IDLE_TIMEOUT_MS = 30_000L;
    private static final long LIVE_POLL_MS = 100L;

    private final String host;
    private final int port;

    public MediaServerProxyServlet() {
        this("127.0.0.1", resolveMediaServerPort());
    }

    public MediaServerProxyServlet(String host, int port) {
        this.host = (host == null || host.trim().isEmpty()) ? "127.0.0.1" : host;
        this.port = port <= 0 ? 7818 : port;
    }

    /** {@code sage.Sage.getInt("media_server_port", 7818)} via reflection (bridge runs in-JVM). */
    private static int resolveMediaServerPort() {
        try {
            Class<?> sage = Class.forName("sage.Sage");
            Object v = sage.getMethod("getInt", String.class, int.class)
                .invoke(null, "media_server_port", 7818);
            if (v instanceof Integer) return (Integer) v;
        } catch (Throwable ignore) {
            // stub / not running inside SageTV — fall back to the default port
        }
        return 7818;
    }

    /** {@code sage.Wizard.getInstance().getFileForID(id).getFile(0).getAbsolutePath()}. */
    private static String resolveMediaFilePath(int mfid) {
        try {
            Class<?> wizardCls = Class.forName("sage.Wizard");
            Object wizard = wizardCls.getMethod("getInstance").invoke(null);
            Object mf = wizardCls.getMethod("getFileForID", int.class).invoke(wizard, mfid);
            if (mf == null) return null;
            Object f = mf.getClass().getMethod("getFile", int.class).invoke(mf, 0);
            if (f instanceof File) return ((File) f).getAbsolutePath();
        } catch (Throwable t) {
            log.warn("[MsProxy] MFID {} resolution failed: {}", mfid, t.toString());
        }
        return null;
    }

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        String path = req.getParameter("path");
        String mfidStr = req.getParameter("mfid");
        if ((path == null || path.isEmpty()) && mfidStr != null && !mfidStr.isEmpty()) {
            int mfid;
            try {
                mfid = Integer.parseInt(mfidStr.trim());
            } catch (NumberFormatException e) {
                resp.sendError(400, "Invalid mfid");
                return;
            }
            path = resolveMediaFilePath(mfid);
            if (path == null) {
                resp.sendError(404, "MediaFile " + mfid + " not found or has no file");
                return;
            }
        }
        if (path == null || path.isEmpty()) {
            resp.sendError(400, "Missing path or mfid parameter");
            return;
        }

        File file = new File(path);
        if (!file.isAbsolute()) {
            resp.sendError(400, "File path must be absolute");
            return;
        }
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
            log.warn("[MsProxy] Rejected path outside allowed roots: {}", canonical);
            resp.sendError(403, "Forbidden");
            return;
        }

        String mode = req.getParameter("mode");
        if (mode == null || mode.isEmpty()) mode = "direct";
        String xcodeMode = mapModeToXcodeQuality(mode);   // null => direct (no XCODE_SETUP)

        Socket socket = null;
        try {
            socket = new Socket();
            socket.setSoTimeout((int) (LIVE_IDLE_TIMEOUT_MS + 5_000L));
            socket.connect(new InetSocketAddress(host, port), 5_000);
            InputStream in = socket.getInputStream();
            OutputStream sockOut = socket.getOutputStream();

            // 1) Condition the stream (transcode / remux) BEFORE OPEN so the
            //    server starts the transcoder against the file.
            if (xcodeMode != null) {
                sendLine(sockOut, "XCODE_SETUP " + xcodeMode);
                String ack = readLine(in);
                if (!"OK".equals(ack)) {
                    log.warn("[MsProxy] XCODE_SETUP {} rejected: {}", xcodeMode, ack);
                    resp.sendError(502, "MediaServer rejected transcode setup");
                    return;
                }
            }

            // 2) OPEN the file.
            sendLine(sockOut, "OPEN " + path);
            String openAck = readLine(in);
            if (!"OK".equals(openAck)) {
                log.warn("[MsProxy] OPEN {} -> {}", canonical, openAck);
                resp.sendError("NO_EXIST".equals(openAck) ? 404 : 502,
                    "MediaServer OPEN failed: " + openAck);
                return;
            }

            // 3) SIZE tells us static-vs-growing.
            long[] sz = querySize(sockOut, in);
            long avail = sz[0];
            long total = sz[1];
            boolean growing = (avail != total) || xcodeMode != null;

            String contentType = contentTypeForMode(mode, canonical);

            if (!growing) {
                serveStatic(req, resp, in, sockOut, total, contentType);
            } else {
                serveStream(req, resp, in, sockOut, avail, total, contentType);
            }
        } catch (IOException ioe) {
            log.debug("[MsProxy] stream aborted for {}: {}", canonical, ioe.toString());
            if (!resp.isCommitted()) {
                resp.sendError(502, "MediaServer proxy error");
            }
        } finally {
            if (socket != null) {
                try { sendLine(socket.getOutputStream(), "CLOSE"); } catch (IOException ignore) {}
                try { socket.close(); } catch (IOException ignore) {}
            }
        }
    }

    /**
     * Static (completed) file: full RFC 7233 byte-range support, backed by
     * {@code READ}. Equivalent to {@code /rawmedia} but the bytes come through
     * the MediaServer (respecting its file-access policy and, for remux modes,
     * conditioning).
     */
    private void serveStatic(HttpServletRequest req, HttpServletResponse resp,
                             InputStream in, OutputStream sockOut,
                             long total, String contentType) throws IOException {
        long start = 0;
        long end = total > 0 ? total - 1 : 0;
        boolean partial = false;

        String range = req.getHeader("Range");
        if (range != null && range.toLowerCase(Locale.ROOT).startsWith("bytes=")) {
            long[] r = parseRange(range, total);
            if (r == null) {
                resp.setStatus(416);
                resp.setHeader("Content-Range", "bytes */" + total);
                resp.setContentLength(0);
                resp.flushBuffer();
                return;
            }
            start = r[0];
            end = r[1];
            partial = true;
        }

        long length = (end >= start) ? (end - start + 1) : 0;
        resp.setStatus(partial ? 206 : 200);
        resp.setHeader("Accept-Ranges", "bytes");
        resp.setHeader("Cache-Control", "no-store");
        resp.setContentType(contentType);
        if (partial) {
            resp.setHeader("Content-Range", "bytes " + start + "-" + end + "/" + total);
        }
        resp.setHeader("Content-Length", Long.toString(length));
        if (length == 0) { resp.flushBuffer(); return; }

        OutputStream out = resp.getOutputStream();
        byte[] buf = new byte[COPY_BUF];
        long offset = start;
        long remaining = length;
        while (remaining > 0) {
            int want = (int) Math.min(remaining, buf.length);
            sendLine(sockOut, "READ " + offset + " " + want);
            readFully(in, buf, want);
            out.write(buf, 0, want);
            offset += want;
            remaining -= want;
        }
        out.flush();
    }

    /**
     * Growing source: an in-progress recording <i>or</i> a live transcode. The
     * response is streamed (no Content-Length); we follow {@code SIZE.avail} as
     * it grows and never {@code READ} past it (past-avail bytes come back as
     * 0xFF padding). Bounded: we stop after {@link #LIVE_IDLE_TIMEOUT_MS} with no
     * growth, when the transcode completes, or when the client disconnects.
     */
    private void serveStream(HttpServletRequest req, HttpServletResponse resp,
                             InputStream in, OutputStream sockOut,
                             long avail, long total, String contentType) throws IOException {
        // For a growing raw recording a client may seek by byte offset; for a
        // transcode the output offset is stream position (start from 0).
        long offset = 0;
        String range = req.getHeader("Range");
        if (range != null && range.toLowerCase(Locale.ROOT).startsWith("bytes=")) {
            long dash = -1;
            try {
                String spec = range.substring(6).trim();
                int d = spec.indexOf('-');
                if (d > 0) dash = Long.parseLong(spec.substring(0, d).trim());
            } catch (RuntimeException ignore) { /* stream from 0 */ }
            if (dash > 0 && dash < avail) offset = dash;
        }

        resp.setStatus(200);
        resp.setHeader("Cache-Control", "no-store");
        resp.setHeader("Accept-Ranges", "none");
        resp.setContentType(contentType);

        OutputStream out = resp.getOutputStream();
        byte[] buf = new byte[COPY_BUF];
        long lastGrowthAt = System.currentTimeMillis();

        while (true) {
            if (offset >= avail) {
                // Refresh the frontier.
                long[] sz = querySize(sockOut, in);
                long newAvail = sz[0];
                long newTotal = sz[1];
                boolean done = (newAvail == newTotal) && offset >= newAvail;
                if (newAvail > avail) {
                    avail = newAvail;
                    total = newTotal;
                    lastGrowthAt = System.currentTimeMillis();
                    continue;
                }
                if (done) break; // transcode finished / file complete
                if (System.currentTimeMillis() - lastGrowthAt > LIVE_IDLE_TIMEOUT_MS) {
                    log.debug("[MsProxy] live stream idle {}ms, ending", LIVE_IDLE_TIMEOUT_MS);
                    break;
                }
                try { Thread.sleep(LIVE_POLL_MS); } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                }
                continue;
            }

            int want = (int) Math.min(avail - offset, buf.length);
            sendLine(sockOut, "READ " + offset + " " + want);
            readFully(in, buf, want);
            try {
                out.write(buf, 0, want);
                out.flush();
            } catch (IOException clientGone) {
                log.debug("[MsProxy] client disconnected mid-stream");
                break;
            }
            offset += want;
        }
    }

    // ---- :7818 helpers --------------------------------------------------

    private static void sendLine(OutputStream out, String line) throws IOException {
        out.write(line.getBytes(StandardCharsets.UTF_8));
        out.write('\r');
        out.write('\n');
        out.flush();
    }

    /** Read one CRLF- (or LF-) terminated ASCII control line. */
    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder(32);
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c == '\r') continue;
            sb.append((char) c);
        }
        if (c == -1 && sb.length() == 0) throw new IOException("MediaServer closed the connection");
        return sb.toString();
    }

    /** Send SIZE, parse {@code <avail> <total>}. */
    private static long[] querySize(OutputStream out, InputStream in) throws IOException {
        sendLine(out, "SIZE");
        String line = readLine(in);
        int sp = line.indexOf(' ');
        if (sp <= 0) throw new IOException("Bad SIZE reply: " + line);
        try {
            long avail = Long.parseLong(line.substring(0, sp).trim());
            long total = Long.parseLong(line.substring(sp + 1).trim());
            return new long[] { avail, total };
        } catch (NumberFormatException nfe) {
            throw new IOException("Unparseable SIZE reply: " + line);
        }
    }

    /** READ replies with exactly {@code len} raw bytes — read them all. */
    private static void readFully(InputStream in, byte[] buf, int len) throws IOException {
        int got = 0;
        while (got < len) {
            int n = in.read(buf, got, len - got);
            if (n < 0) throw new IOException("MediaServer closed mid-READ (" + got + "/" + len + ")");
            got += n;
        }
    }

    // ---- mode / range / content-type ------------------------------------

    /**
     * Map a client {@code mode} to a {@code media_server/transcode_quality/*}
     * key, or {@code null} for direct play (no {@code XCODE_SETUP}).
     */
    private static String mapModeToXcodeQuality(String mode) {
        String m = mode.toLowerCase(Locale.ROOT);
        if (m.equals("direct")) return null;
        if (m.equals("remux:ts") || m.equals("remux")) return "mpeg2tsremux";
        if (m.equals("remux:ps")) return "mpeg2psremux";
        if (m.startsWith("xcode:")) {
            String q = mode.substring("xcode:".length()).trim();
            return q.isEmpty() ? "browserhd" : q;
        }
        // Unknown token: treat as a raw quality name for forward-compat.
        return mode;
    }

    private static String contentTypeForMode(String mode, String path) {
        String m = mode.toLowerCase(Locale.ROOT);
        if (m.startsWith("xcode:") || m.equals("xcode")) return "video/mp4";      // browserhd = fMP4
        if (m.equals("remux:ts") || m.equals("remux")) return "video/mp2t";
        if (m.equals("remux:ps")) return "video/mpeg";
        return guessContentType(path);
    }

    private static long[] parseRange(String range, long total) {
        String spec = range.substring(6).trim();
        int comma = spec.indexOf(',');
        if (comma > 0) spec = spec.substring(0, comma).trim();
        int dash = spec.indexOf('-');
        if (dash < 0) return null;
        try {
            String s = spec.substring(0, dash).trim();
            String e = spec.substring(dash + 1).trim();
            long start, end;
            if (s.isEmpty()) {
                long suffix = Long.parseLong(e);
                if (suffix <= 0) return null;
                start = suffix >= total ? 0 : total - suffix;
                end = total - 1;
            } else {
                start = Long.parseLong(s);
                end = e.isEmpty() ? total - 1 : Long.parseLong(e);
            }
            if (start < 0 || start >= total || end < start) return null;
            if (end >= total) end = total - 1;
            return new long[] { start, end };
        } catch (NumberFormatException nfe) {
            return null;
        }
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
            default: return "application/octet-stream";
        }
    }
}
