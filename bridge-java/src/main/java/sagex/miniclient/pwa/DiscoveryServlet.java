package sagex.miniclient.pwa;

import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.PrintWriter;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * GET /discover — LAN scan for SageTV servers.
 * <p>
 * Mirrors the Node bridge's {@code bridge/discovery.js}: broadcasts two UDP
 * probes that match what {@code sage.SageTV.launchExtraServers} and
 * {@code sage.SageTV.launchMiniDiscoveryServer} listen for, parses both reply
 * shapes, and returns a merged JSON list. Browsers cannot do UDP, so the
 * bridge runs the locator on their behalf.
 * <ul>
 *   <li>UDP 8270 — fat-client locator. Probe = {@code 'S','T','V', maj, min, micro}
 *       (32 bytes). Reply layout: {@code 'S','T','V', maj, min, micro, portHi,
 *       portLo, nameLen, name…}. Gives hostname + SageTV client port (7818
 *       by default).</li>
 *   <li>UDP 31100 — mini-client locator. Probe = {@code 'S','T','V', 0x01}
 *       (10 bytes). Reply (15 bytes): {@code 'S','T','V', 0x02, 0x01,
 *       guid[8], portHi, portLo}. Gives systemGuid + Placeshifter port
 *       (31099 by default).</li>
 * </ul>
 * Replies are matched by source IP and merged into a single entry.
 * <p>
 * Query params:
 * <pre>
 *   force=1       Bypass the cache and rescan now.
 *   timeout=2000  How long to wait for replies (ms, clamped 500–6000).
 * </pre>
 * Response (same shape as Node bridge):
 * <pre>
 * {
 *   "servers": [
 *     { "host":"192.0.2.10","port":31099,"name":"MySageTV",
 *       "guid":"0000000000000000","sageVersion":"10.0.16",
 *       "sagePort":42024,"sources":["fat","mini"] }
 *   ],
 *   "cached": false,
 *   "age": 0
 * }
 * </pre>
 */
public class DiscoveryServlet extends HttpServlet {
    private static final Logger log = LoggerFactory.getLogger(DiscoveryServlet.class);

    private static final long CACHE_TTL_MS = 30_000L;
    private static final long AUTO_SCAN_INTERVAL_MS = 30_000L;
    private static final int AUTO_SCAN_TIMEOUT_MS = 2000;

    // Probe version reported to the fat-client locator. Must be >= the
    // server's CLIENT_COMPATIBLE_*_VERSION (currently 9.0.14 in Sage.java)
    // or the server silently drops the probe. 9.9.99 leaves headroom.
    private static final byte PROBE_MAJOR = 9;
    private static final byte PROBE_MINOR = 9;
    private static final byte PROBE_MICRO = 99;

    private final Object lock = new Object();
    private long cacheAt = 0L;
    private List<Server> cachedServers = Collections.emptyList();

    private ScheduledExecutorService scanner;
    private ScheduledFuture<?> scannerTask;

    /**
     * Start a background scan loop so the cache is always warm and
     * {@code /discover} returns instantly. Safe to call multiple times —
     * subsequent calls are no-ops.
     */
    public synchronized void startBackgroundScanner() {
        if (scanner != null) return;
        scanner = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "DiscoveryAutoScan");
            t.setDaemon(true);
            return t;
        });
        scannerTask = scanner.scheduleWithFixedDelay(() -> {
            try {
                List<Server> servers = scan(AUTO_SCAN_TIMEOUT_MS);
                synchronized (lock) {
                    cachedServers = servers;
                    cacheAt = System.currentTimeMillis();
                }
                log.debug("[Discovery] auto-scan found {} server(s)", servers.size());
            } catch (Throwable e) {
                log.warn("[Discovery] auto-scan failed: {}", e.toString());
            }
        }, 0L, AUTO_SCAN_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    /** Stop the background scan loop. Safe to call multiple times. */
    public synchronized void stopBackgroundScanner() {
        if (scannerTask != null) {
            scannerTask.cancel(true);
            scannerTask = null;
        }
        if (scanner != null) {
            scanner.shutdownNow();
            scanner = null;
        }
    }

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        boolean force = "1".equals(req.getParameter("force"));
        int timeoutMs = parseClampedInt(req.getParameter("timeout"), 2000, 500, 6000);

        resp.setContentType("application/json");
        resp.setCharacterEncoding("UTF-8");
        resp.setHeader("Cache-Control", "no-store");
        resp.setHeader("Access-Control-Allow-Origin", "*");

        long now = System.currentTimeMillis();
        List<Server> servers;
        boolean fromCache = false;
        long age = 0L;

        synchronized (lock) {
            if (!force && cacheAt != 0 && (now - cacheAt) < CACHE_TTL_MS) {
                servers = cachedServers;
                fromCache = true;
                age = now - cacheAt;
            } else {
                try {
                    servers = scan(timeoutMs);
                    cachedServers = servers;
                    cacheAt = System.currentTimeMillis();
                } catch (Exception e) {
                    log.warn("[Discovery] scan failed: {}", e.toString());
                    resp.setStatus(500);
                    try (PrintWriter w = resp.getWriter()) {
                        w.write("{\"error\":" + jsonString(e.getMessage()) + "}");
                    }
                    return;
                }
            }
        }

        // Filter loopback + dedupe multi-homed replies by GUID, preferring the
        // address on the requesting client's subnet so the tile shows the IP
        // the user already knows their SageTV by.
        servers = filterAndDedupe(servers, req.getRemoteAddr());

        try (PrintWriter w = resp.getWriter()) {
            w.write(toJson(servers, fromCache, age));
        }
    }

    private static int parseClampedInt(String s, int def, int min, int max) {
        if (s == null || s.isEmpty()) return def;
        try {
            int v = Integer.parseInt(s);
            return Math.max(min, Math.min(max, v));
        } catch (NumberFormatException e) {
            return def;
        }
    }

    /**
     * Strip loopback replies and collapse multi-homed responses (same GUID from
     * several interfaces) into a single tile. When there's a choice, pick the
     * address on the requesting client's subnet so the user sees the IP they
     * already know their SageTV by.
     */
    private static List<Server> filterAndDedupe(List<Server> raw, String clientIp) {
        // 1. Drop pure loopback replies — they're useless as a display value,
        //    and the bridge always sees at least one when it broadcasts on
        //    the loopback interface. If every reply happens to be loopback
        //    (e.g. all-localhost dev setup), keep one as a last resort.
        List<Server> nonLoop = new ArrayList<>();
        for (Server s : raw) {
            if (!isLoopback(s.host)) nonLoop.add(s);
        }
        if (nonLoop.isEmpty() && !raw.isEmpty()) {
            return Collections.singletonList(raw.get(0));
        }

        // 2. Group by GUID (fallback: hostname if no guid, so pre-GUID SageTVs
        //    still work).
        Map<String, List<Server>> byKey = new LinkedHashMap<>();
        for (Server s : nonLoop) {
            String key = s.guid != null ? "guid:" + s.guid : "host:" + s.host;
            byKey.computeIfAbsent(key, k -> new ArrayList<>()).add(s);
        }

        // 3. For each group pick the entry whose host shares the longest
        //    /8/16/24 prefix with the client, merging sources across the group.
        List<Server> out = new ArrayList<>(byKey.size());
        for (List<Server> group : byKey.values()) {
            Server best = group.get(0);
            int bestScore = subnetScore(best.host, clientIp);
            for (int i = 1; i < group.size(); i++) {
                int score = subnetScore(group.get(i).host, clientIp);
                if (score > bestScore) {
                    best = group.get(i);
                    bestScore = score;
                }
            }
            for (Server other : group) {
                if (other != best) best.sources.addAll(other.sources);
            }
            out.add(best);
        }
        out.sort((a, b) -> a.name.compareToIgnoreCase(b.name));
        return out;
    }

    private static boolean isLoopback(String host) {
        return host != null && (host.startsWith("127.") || "::1".equals(host));
    }

    /** IPv4 shared-prefix octet count vs the client's IP (0..4). */
    private static int subnetScore(String serverIp, String clientIp) {
        if (serverIp == null || clientIp == null) return 0;
        String[] a = serverIp.split("\\.");
        String[] b = clientIp.split("\\.");
        if (a.length != 4 || b.length != 4) return 0;
        int match = 0;
        for (int i = 0; i < 4; i++) {
            if (!a[i].equals(b[i])) break;
            match++;
        }
        return match;
    }

    /**
     * Run both UDP probes in parallel and collect replies for {@code timeoutMs}.
     */
    private List<Server> scan(int timeoutMs) throws Exception {
        Set<String> targets = new LinkedHashSet<>();
        targets.add("255.255.255.255");
        targets.addAll(localBroadcastAddrs());

        Map<String, Server> byHost = new TreeMap<>();
        Object byHostLock = new Object();

        Thread fatThread = startProbe(byHost, byHostLock, targets, timeoutMs, /*mini=*/false);
        Thread miniThread = startProbe(byHost, byHostLock, targets, timeoutMs, /*mini=*/true);

        fatThread.join(timeoutMs + 500L);
        miniThread.join(timeoutMs + 500L);

        synchronized (byHostLock) {
            List<Server> out = new ArrayList<>(byHost.values());
            // Sort by name (stable, friendly order for the PWA).
            out.sort((a, b) -> a.name.compareToIgnoreCase(b.name));
            return out;
        }
    }

    private Thread startProbe(Map<String, Server> byHost, Object byHostLock,
                              Set<String> targets, int timeoutMs, boolean mini) {
        Thread t = new Thread(() -> {
            try (DatagramSocket sock = new DatagramSocket()) {
                sock.setBroadcast(true);
                sock.setSoTimeout(250);

                byte[] probe = mini ? buildMiniProbe() : buildFatProbe();
                int destPort = mini ? 31100 : 8270;
                for (String dst : targets) {
                    try {
                        InetAddress addr = InetAddress.getByName(dst);
                        sock.send(new DatagramPacket(probe, probe.length, addr, destPort));
                    } catch (Exception e) {
                        log.debug("[Discovery] {} probe → {} failed: {}",
                            mini ? "mini" : "fat", dst, e.getMessage());
                    }
                }

                long deadline = System.currentTimeMillis() + timeoutMs;
                byte[] buf = new byte[512];
                while (System.currentTimeMillis() < deadline) {
                    DatagramPacket reply = new DatagramPacket(buf, buf.length);
                    try {
                        sock.receive(reply);
                    } catch (SocketTimeoutException ste) {
                        continue;
                    }
                    String host = reply.getAddress().getHostAddress();
                    Server parsed = mini ? parseMiniReply(reply, host)
                                         : parseFatReply(reply, host);
                    if (parsed == null) continue;
                    synchronized (byHostLock) {
                        Server existing = byHost.get(host);
                        if (existing == null) {
                            byHost.put(host, parsed);
                        } else {
                            existing.merge(parsed);
                        }
                    }
                }
            } catch (Exception e) {
                log.warn("[Discovery] {} probe thread error: {}",
                    mini ? "mini" : "fat", e.toString());
            }
        }, mini ? "DiscoveryMini" : "DiscoveryFat");
        t.setDaemon(true);
        t.start();
        return t;
    }

    private static byte[] buildFatProbe() {
        byte[] probe = new byte[32];
        probe[0] = 'S'; probe[1] = 'T'; probe[2] = 'V';
        probe[3] = PROBE_MAJOR;
        probe[4] = PROBE_MINOR;
        probe[5] = PROBE_MICRO;
        return probe;
    }

    private static byte[] buildMiniProbe() {
        byte[] probe = new byte[10];
        probe[0] = 'S'; probe[1] = 'T'; probe[2] = 'V';
        probe[3] = 0x01; // request marker
        return probe;
    }

    private static Server parseFatReply(DatagramPacket pkt, String host) {
        if (pkt.getLength() < 9) return null;
        byte[] data = pkt.getData();
        int off = pkt.getOffset();
        if (data[off] != 'S' || data[off + 1] != 'T' || data[off + 2] != 'V') return null;
        int major = data[off + 3] & 0xFF;
        int minor = data[off + 4] & 0xFF;
        int micro = data[off + 5] & 0xFF;
        int sagePort = ((data[off + 6] & 0xFF) << 8) | (data[off + 7] & 0xFF);
        int nameLen = data[off + 8] & 0xFF;
        String name = host;
        if (nameLen > 0 && pkt.getLength() >= 9 + nameLen) {
            name = new String(data, off + 9, nameLen, java.nio.charset.StandardCharsets.UTF_8);
            // Trim any trailing NULs.
            int end = name.length();
            while (end > 0 && name.charAt(end - 1) == '\0') end--;
            name = name.substring(0, end);
            if (name.isEmpty()) name = host;
        }
        Server s = new Server(host);
        s.name = name;
        s.sageVersion = major + "." + minor + "." + micro;
        s.sagePort = sagePort > 0 ? sagePort : null;
        s.sources.add("fat");
        return s;
    }

    private static Server parseMiniReply(DatagramPacket pkt, String host) {
        if (pkt.getLength() < 15) return null;
        byte[] data = pkt.getData();
        int off = pkt.getOffset();
        if (data[off] != 'S' || data[off + 1] != 'T' || data[off + 2] != 'V') return null;
        if (data[off + 3] != 0x02) return null;
        StringBuilder guid = new StringBuilder(16);
        for (int i = 0; i < 8; i++) {
            int b = data[off + 5 + i] & 0xFF;
            if (b < 0x10) guid.append('0');
            guid.append(Integer.toHexString(b));
        }
        int port = ((data[off + 13] & 0xFF) << 8) | (data[off + 14] & 0xFF);
        Server s = new Server(host);
        s.guid = guid.toString();
        s.port = port > 0 ? port : 31099;
        s.sources.add("mini");
        return s;
    }

    /**
     * Subnet-directed broadcast addresses for every non-loopback IPv4
     * interface. Windows and some Linux configurations don't reliably
     * deliver {@code 255.255.255.255} on multi-NIC hosts; broadcasting to
     * each interface's local broadcast works regardless.
     */
    private static List<String> localBroadcastAddrs() {
        List<String> out = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            while (ifaces != null && ifaces.hasMoreElements()) {
                NetworkInterface ni = ifaces.nextElement();
                if (ni.isLoopback() || !ni.isUp()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress bcast = ia.getBroadcast();
                    if (bcast != null) out.add(bcast.getHostAddress());
                }
            }
        } catch (Exception e) {
            log.debug("[Discovery] could not enumerate interfaces: {}", e.toString());
        }
        return out;
    }

    private static String toJson(List<Server> servers, boolean cached, long age) {
        StringBuilder sb = new StringBuilder(256);
        sb.append("{\"servers\":[");
        for (int i = 0; i < servers.size(); i++) {
            if (i > 0) sb.append(',');
            servers.get(i).appendJson(sb);
        }
        sb.append("],\"cached\":").append(cached);
        sb.append(",\"age\":").append(age);
        sb.append('}');
        return sb.toString();
    }

    private static String jsonString(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder(s.length() + 2);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
        return sb.toString();
    }

    /** Single discovered server record. Mutable so probe threads can merge. */
    private static final class Server {
        final String host;
        String name;
        Integer port;
        String guid;
        String sageVersion;
        Integer sagePort;
        final Set<String> sources = new LinkedHashSet<>();

        Server(String host) {
            this.host = host;
            this.name = host;
            this.port = 31099;
        }

        void merge(Server other) {
            if (other.name != null && !other.name.equals(other.host)) this.name = other.name;
            if (other.port != null) this.port = other.port;
            if (other.guid != null) this.guid = other.guid;
            if (other.sageVersion != null) this.sageVersion = other.sageVersion;
            if (other.sagePort != null) this.sagePort = other.sagePort;
            this.sources.addAll(other.sources);
        }

        void appendJson(StringBuilder sb) {
            sb.append('{');
            sb.append("\"host\":").append(jsonString(host));
            sb.append(",\"port\":").append(port != null ? port : 31099);
            sb.append(",\"name\":").append(jsonString(name));
            sb.append(",\"guid\":").append(guid != null ? jsonString(guid) : "null");
            sb.append(",\"sageVersion\":").append(sageVersion != null ? jsonString(sageVersion) : "null");
            sb.append(",\"sagePort\":").append(sagePort != null ? String.valueOf(sagePort) : "null");
            sb.append(",\"sources\":[");
            int i = 0;
            for (String src : sources) {
                if (i++ > 0) sb.append(',');
                sb.append(jsonString(src));
            }
            sb.append("]");
            sb.append('}');
        }
    }
}
