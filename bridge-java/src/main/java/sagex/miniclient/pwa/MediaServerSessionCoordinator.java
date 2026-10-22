package sagex.miniclient.pwa;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Owns one MediaServer producer and a bounded replay window for one immutable
 * AVPlay HTTP session. HTTP requests attach as independent consumers; reconnects
 * begin at the last byte successfully written by any prior consumer.
 */
final class MediaServerSessionCoordinator {
    private static final Logger log = LoggerFactory.getLogger(MediaServerSessionCoordinator.class);
    private static final long MIN_GOODPUT_WRITE_MS = 10L;

    static final class Settings {
        final long ringCapacityBytes;
        final long reconnectGraceMs;
        final long staleConsumerMs;
        final long liveIdleTimeoutMs;
        final long pollMs;
        final long adjustIntervalMs;
        final long startupTimeoutMs;
        final long completionStableMs;
        final int readChunkBytes;

        Settings(long ringCapacityBytes, long reconnectGraceMs, long staleConsumerMs,
                 long liveIdleTimeoutMs, long pollMs, long adjustIntervalMs,
                 long startupTimeoutMs, long completionStableMs, int readChunkBytes) {
            this.ringCapacityBytes = ringCapacityBytes;
            this.reconnectGraceMs = reconnectGraceMs;
            this.staleConsumerMs = staleConsumerMs;
            this.liveIdleTimeoutMs = liveIdleTimeoutMs;
            this.pollMs = pollMs;
            this.adjustIntervalMs = adjustIntervalMs;
            this.startupTimeoutMs = startupTimeoutMs;
            this.completionStableMs = completionStableMs;
            this.readChunkBytes = readChunkBytes;
        }

        static Settings defaults() {
            return new Settings(
                32L * 1024L * 1024L,
                5_000L,
                5_000L,
                120_000L,
                10L,
                5_000L,
                5_000L,
                2_000L,
                512 * 1024
            );
        }
    }

    static final class SessionKey {
        final String sessionId;
        final String canonicalPath;
        final String mode;
        final String xcodeSetup;
        final long seekMs;
        final Integer bandwidthSeedKbps;
        final String sink;
        final String clientIp;
        final boolean adaptive;

        SessionKey(String sessionId, String canonicalPath, String mode, String xcodeSetup,
                   long seekMs, Integer bandwidthSeedKbps, String sink, String clientIp,
                   boolean adaptive) {
            this.sessionId = sessionId;
            this.canonicalPath = canonicalPath;
            this.mode = mode;
            this.xcodeSetup = xcodeSetup;
            this.seekMs = seekMs;
            this.bandwidthSeedKbps = bandwidthSeedKbps;
            this.sink = sink;
            this.clientIp = clientIp;
            this.adaptive = adaptive;
        }

        @Override
        public boolean equals(Object other) {
            if (this == other) return true;
            if (!(other instanceof SessionKey)) return false;
            SessionKey that = (SessionKey) other;
            return seekMs == that.seekMs
                && adaptive == that.adaptive
                && Objects.equals(sessionId, that.sessionId)
                && Objects.equals(canonicalPath, that.canonicalPath)
                && Objects.equals(mode, that.mode)
                && Objects.equals(xcodeSetup, that.xcodeSetup)
                && Objects.equals(bandwidthSeedKbps, that.bandwidthSeedKbps)
                && Objects.equals(sink, that.sink)
                && Objects.equals(clientIp, that.clientIp);
        }

        @Override
        public int hashCode() {
            return Objects.hash(sessionId, canonicalPath, mode, xcodeSetup, seekMs,
                bandwidthSeedKbps, sink, clientIp, adaptive);
        }
    }

    static final class Consumer implements AutoCloseable {
        private final MediaServerSessionCoordinator owner;
        private long cursor;
        private long pendingOffset = -1;
        private int pendingLength;
        private long lastProgressAt;
        private IOException detachedError;
        private boolean closed;

        private Consumer(MediaServerSessionCoordinator owner, long cursor) {
            this.owner = owner;
            this.cursor = cursor;
            this.lastProgressAt = System.currentTimeMillis();
        }

        byte[] next(int maxBytes) throws IOException {
            return owner.next(this, maxBytes);
        }

        void commit(int length, long writeMs) throws IOException {
            owner.commit(this, length, writeMs);
        }

        long cursor() {
            synchronized (owner.lock) {
                return cursor;
            }
        }

        @Override
        public void close() {
            owner.detach(this);
        }
    }

    private static final class Chunk {
        final long start;
        final byte[] data;

        Chunk(long start, byte[] data) {
            this.start = start;
            this.data = data;
        }

        long end() {
            return start + data.length;
        }
    }

    private final Object lock = new Object();
    private final String host;
    private final int port;
    private final SessionKey key;
    private final Settings settings;
    private final Runnable terminationCallback;
    private final Deque<Chunk> ring = new ArrayDeque<>();
    private final List<Consumer> consumers = new ArrayList<>();
    private final CountDownLatch ready = new CountDownLatch(1);
    private final AtomicBoolean closeSent = new AtomicBoolean();

    private volatile boolean started;
    private volatile boolean terminated;
    private volatile IOException terminalError;
    private long ringBytes;
    private long producerOffset;
    private long available;
    private long deliveredWatermark;
    private long zeroConsumerSince;
    private long intervalWriteMs;
    private long intervalMaxWriteMs;
    private long intervalDeliveredBytes;
    private boolean intervalRingConstrained;
    private boolean intervalConsumerEvicted;
    private long readCount;
    private long sizeQueryCount;

    MediaServerSessionCoordinator(String host, int port, SessionKey key, Settings settings,
                                  Runnable terminationCallback) {
        this.host = host;
        this.port = port;
        this.key = key;
        this.settings = settings;
        this.terminationCallback = terminationCallback;
    }

    SessionKey key() {
        return key;
    }

    boolean isTerminated() {
        return terminated;
    }

    void start() {
        synchronized (lock) {
            if (started) return;
            started = true;
        }
        Thread producer = new Thread(this::runProducer, "msproxy-" + key.sessionId);
        producer.setDaemon(true);
        producer.start();
    }

    void awaitReady() throws IOException {
        try {
            if (!ready.await(settings.startupTimeoutMs, TimeUnit.MILLISECONDS)) {
                throw new IOException("Timed out starting MediaServer session");
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted starting MediaServer session", interrupted);
        }
        if (terminalError != null) throw terminalError;
        if (terminated) throw new IOException("MediaServer session ended during startup");
    }

    Consumer attach() throws IOException {
        synchronized (lock) {
            if (terminalError != null) throw terminalError;
            if (terminated) throw new IOException("MediaServer session is closed");
            Consumer consumer = new Consumer(this, deliveredWatermark);
            consumers.add(consumer);
            zeroConsumerSince = 0;
            lock.notifyAll();
            log.info("[MsProxy] consumer attached session={} cursor={} consumers={}",
                key.sessionId, consumer.cursor, consumers.size());
            return consumer;
        }
    }

    private byte[] next(Consumer consumer, int maxBytes) throws IOException {
        synchronized (lock) {
            while (true) {
                checkConsumer(consumer);
                if (consumer.pendingOffset >= 0) {
                    throw new IOException("Consumer requested data before committing prior write");
                }
                Chunk chunk = findChunk(consumer.cursor);
                if (chunk != null) {
                    int chunkOffset = (int) (consumer.cursor - chunk.start);
                    int length = Math.min(Math.max(1, maxBytes), chunk.data.length - chunkOffset);
                    consumer.pendingOffset = consumer.cursor;
                    consumer.pendingLength = length;
                    return Arrays.copyOfRange(chunk.data, chunkOffset, chunkOffset + length);
                }
                if (terminalError != null) throw terminalError;
                if (terminated) return null;
                waitLocked(settings.pollMs);
            }
        }
    }

    private void commit(Consumer consumer, int length, long writeMs) throws IOException {
        synchronized (lock) {
            checkConsumer(consumer);
            if (consumer.pendingOffset != consumer.cursor || length != consumer.pendingLength) {
                throw new IOException("Invalid consumer commit");
            }
            consumer.cursor += length;
            consumer.pendingOffset = -1;
            consumer.pendingLength = 0;
            consumer.lastProgressAt = System.currentTimeMillis();
            deliveredWatermark = Math.max(deliveredWatermark, consumer.cursor);
            intervalDeliveredBytes += length;
            intervalWriteMs += Math.max(0, writeMs);
            intervalMaxWriteMs = Math.max(intervalMaxWriteMs, Math.max(0, writeMs));
            evictConsumedLocked();
            lock.notifyAll();
        }
    }

    private void detach(Consumer consumer) {
        synchronized (lock) {
            if (consumer.closed) return;
            consumer.closed = true;
            consumers.remove(consumer);
            if (consumers.isEmpty()) zeroConsumerSince = System.currentTimeMillis();
            evictConsumedLocked();
            lock.notifyAll();
            log.info("[MsProxy] consumer detached session={} cursor={} consumers={}",
                key.sessionId, consumer.cursor, consumers.size());
        }
    }

    private void checkConsumer(Consumer consumer) throws IOException {
        if (consumer.detachedError != null) throw consumer.detachedError;
        if (consumer.closed) throw new IOException("Consumer is closed");
    }

    private Chunk findChunk(long cursor) {
        for (Chunk chunk : ring) {
            if (cursor >= chunk.start && cursor < chunk.end()) return chunk;
        }
        return null;
    }

    private void runProducer() {
        Socket socket = null;
        try {
            socket = new Socket();
            socket.setSoTimeout((int) Math.min(Integer.MAX_VALUE, settings.liveIdleTimeoutMs + 5_000L));
            socket.connect(new InetSocketAddress(host, port), 5_000);
            InputStream in = socket.getInputStream();
            OutputStream out = socket.getOutputStream();

            if (key.clientIp != null && !key.clientIp.isEmpty()) {
                MediaServerProxyServlet.sendLine(out, "CLIENT_ORIGIN " + key.clientIp);
                MediaServerProxyServlet.readLine(in);
            }

            MediaServerProxyServlet.sendLine(out, key.xcodeSetup);
            String setupAck = MediaServerProxyServlet.readLine(in);
            if (!"OK".equals(setupAck)) {
                throw new IOException("MediaServer rejected transcode setup: " + setupAck);
            }

            MediaServerProxyServlet.sendLine(out, "OPEN " + key.canonicalPath);
            String openAck = MediaServerProxyServlet.readLine(in);
            if (!"OK".equals(openAck)) {
                throw new IOException("MediaServer OPEN failed: " + openAck);
            }

            long[] size = MediaServerProxyServlet.querySize(out, in);
            synchronized (lock) {
                available = size[0];
                zeroConsumerSince = System.currentTimeMillis();
                lock.notifyAll();
            }
            log.info("[MsProxy] producer ready session={} mode={} seekMs={}",
                key.sessionId, key.mode, key.seekMs);
            ready.countDown();

            produce(in, out);
        } catch (IOException failure) {
            synchronized (lock) {
                terminalError = failure;
                lock.notifyAll();
            }
            log.info("[MsProxy] producer failed session={}: {}", key.sessionId, failure.toString());
        } finally {
            ready.countDown();
            if (socket != null) closeProducer(socket);
            synchronized (lock) {
                terminated = true;
                lock.notifyAll();
            }
            if (terminationCallback != null) terminationCallback.run();
        }
    }

    private void produce(InputStream in, OutputStream out) throws IOException {
        byte[] readBuffer = new byte[settings.readChunkBytes];
        long lastGrowthAt = System.currentTimeMillis();
        long streamStart = lastGrowthAt;
        long lastReportAt = lastGrowthAt;
        long lastReportWatermark = 0;
        boolean adjustEnabled = key.adaptive;

        while (true) {
            synchronized (lock) {
                evictStaleConsumersLocked();
                if (shouldEndForNoConsumersLocked()) return;
            }

            if (producerOffset < available) {
                int wanted = (int) Math.min(available - producerOffset, readBuffer.length);
                MediaServerProxyServlet.sendLine(out, "READ " + producerOffset + " " + wanted);
                MediaServerProxyServlet.readFully(in, readBuffer, wanted);
                byte[] bytes = Arrays.copyOf(readBuffer, wanted);
                append(bytes);
                producerOffset += wanted;
                readCount++;
            } else {
                sizeQueryCount++;
                long[] size = MediaServerProxyServlet.querySize(out, in);
                long newAvailable = size[0];
                long newTotal = size[1];
                if (newAvailable > available) {
                    available = newAvailable;
                    lastGrowthAt = System.currentTimeMillis();
                } else {
                    long now = System.currentTimeMillis();
                    boolean done = newAvailable > 0 && newAvailable == newTotal
                        && producerOffset >= newAvailable
                        && now - lastGrowthAt > settings.completionStableMs;
                    synchronized (lock) {
                        if (consumers.isEmpty()) done = false;
                    }
                    if (done) return;
                    if (now - lastGrowthAt > settings.liveIdleTimeoutMs) {
                        throw new IOException("Live stream idle for " + settings.liveIdleTimeoutMs + "ms");
                    }
                    sleep(settings.pollMs);
                }
            }

            long now = System.currentTimeMillis();
            if (now - lastReportAt >= settings.adjustIntervalMs) {
                long watermark;
                long writeMs;
                long maxWriteMs;
                long committedBytes;
                int consumerCount;
                long ringSize;
                boolean pendingWrite;
                boolean ringConstrained;
                boolean consumerEvicted;
                synchronized (lock) {
                    evictStaleConsumersLocked();
                    watermark = deliveredWatermark;
                    writeMs = intervalWriteMs;
                    maxWriteMs = intervalMaxWriteMs;
                    committedBytes = intervalDeliveredBytes;
                    pendingWrite = hasPendingWriteLocked();
                    ringConstrained = intervalRingConstrained;
                    consumerEvicted = intervalConsumerEvicted;
                    intervalWriteMs = 0;
                    intervalMaxWriteMs = 0;
                    intervalDeliveredBytes = 0;
                    intervalRingConstrained = false;
                    intervalConsumerEvicted = false;
                    consumerCount = consumers.size();
                    ringSize = ringBytes;
                }
                long elapsedMs = now - lastReportAt;
                long deliveredBytes = watermark - lastReportWatermark;
                long deliveryKbps = elapsedMs > 0
                    ? Math.round((deliveredBytes * 8.0) / elapsedMs) : 0;
                long measuredKbps = burstGoodputKbps(
                    committedBytes, elapsedMs, writeMs, maxWriteMs, settings.staleConsumerMs,
                    ringSize, settings.ringCapacityBytes, consumerCount, pendingWrite,
                    ringConstrained, consumerEvicted);
                log.info("[MsProxy] STREAM_PROGRESS session={} deliveredBytes={} producerBytes={} "
                        + "ringBytes={} intervalBytes={} intervalMs={} deliveryKbps={} adjustKbps={} "
                        + "writeBlockedMs={} maxWriteMs={} ringConstrained={} consumerEvicted={} "
                        + "pendingWrite={} reads={} sizeQueries={} consumers={} elapsedMs={}",
                    key.sessionId, watermark, producerOffset, ringSize, deliveredBytes, elapsedMs,
                    deliveryKbps, measuredKbps, writeMs, maxWriteMs, ringConstrained,
                    consumerEvicted, pendingWrite, readCount, sizeQueryCount, consumerCount,
                    now - streamStart);

                if (adjustEnabled && measuredKbps > 0) {
                    MediaServerProxyServlet.sendLine(out, "XCODE_ADJUST " + measuredKbps);
                    String adjusted = MediaServerProxyServlet.readLine(in);
                    try {
                        long applied = Long.parseLong(adjusted.trim());
                        if (applied > 0) {
                            log.info("[MsProxy] XCODE_ADJUST measured={}kbps applied={}kbps session={}",
                                measuredKbps, applied, key.sessionId);
                        } else {
                            adjustEnabled = false;
                        }
                    } catch (NumberFormatException unsupported) {
                        adjustEnabled = false;
                        log.info("[MsProxy] XCODE_ADJUST unsupported session={} reply={}",
                            key.sessionId, adjusted);
                    }
                }
                lastReportAt = now;
                lastReportWatermark = watermark;
            }
        }
    }

    private void append(byte[] bytes) throws IOException {
        synchronized (lock) {
            while (ringBytes + bytes.length > settings.ringCapacityBytes) {
                intervalRingConstrained = true;
                evictConsumedLocked();
                if (ringBytes + bytes.length <= settings.ringCapacityBytes) break;
                if (evictStaleConsumersLocked()) continue;
                if (shouldEndForNoConsumersLocked()) {
                    throw new IOException("Reconnect grace expired");
                }
                waitLocked(settings.pollMs);
            }
            ring.addLast(new Chunk(producerOffset, bytes));
            ringBytes += bytes.length;
            lock.notifyAll();
        }
    }

    private void evictConsumedLocked() {
        long retainFrom = deliveredWatermark;
        for (Consumer consumer : consumers) {
            retainFrom = Math.min(retainFrom, consumer.cursor);
        }
        while (!ring.isEmpty() && ring.peekFirst().end() <= retainFrom) {
            ringBytes -= ring.removeFirst().data.length;
        }
    }

    private boolean evictStaleConsumersLocked() {
        if (consumers.size() <= 1) return false;

        long now = System.currentTimeMillis();
        boolean evicted = false;
        for (Consumer consumer : new ArrayList<>(consumers)) {
            if (consumer.cursor >= producerOffset) continue;
            if (now - consumer.lastProgressAt < settings.staleConsumerMs) continue;
            consumer.detachedError = new IOException("Consumer evicted after falling behind replay window");
            consumers.remove(consumer);
            evicted = true;
            intervalConsumerEvicted = true;
            log.warn("[MsProxy] evicted stale consumer session={} cursor={} producer={}",
                key.sessionId, consumer.cursor, producerOffset);
        }
        if (consumers.isEmpty() && zeroConsumerSince == 0) zeroConsumerSince = now;
        if (evicted) {
            evictConsumedLocked();
            lock.notifyAll();
        }
        return evicted;
    }

    private boolean hasPendingWriteLocked() {
        for (Consumer consumer : consumers) {
            if (consumer.pendingOffset >= 0) return true;
        }
        return false;
    }

    static long burstGoodputKbps(long deliveredBytes, long elapsedMs, long writeMs,
                                 long maxWriteMs, long stallThresholdMs, long ringSize,
                                 long ringCapacityBytes, int consumerCount,
                                 boolean pendingWrite, boolean ringConstrained,
                                 boolean consumerEvicted) {
        if (deliveredBytes <= 0 || elapsedMs <= 0 || writeMs < MIN_GOODPUT_WRITE_MS) return 0;
        if (consumerCount != 1 || pendingWrite || ringConstrained || consumerEvicted) return 0;
        if (ringCapacityBytes > 0 && ringSize * 4L >= ringCapacityBytes * 3L) return 0;
        if (writeMs * 2L >= elapsedMs) return 0;
        if (maxWriteMs * 2L >= stallThresholdMs) return 0;
        return Math.round((deliveredBytes * 8.0) / writeMs);
    }

    private boolean shouldEndForNoConsumersLocked() {
        return consumers.isEmpty() && zeroConsumerSince > 0
            && System.currentTimeMillis() - zeroConsumerSince >= settings.reconnectGraceMs;
    }

    private void closeProducer(Socket socket) {
        if (closeSent.compareAndSet(false, true)) {
            try {
                MediaServerProxyServlet.sendLine(socket.getOutputStream(), "CLOSE");
            } catch (IOException ignored) {
                // The producer may already have failed or the server may close first.
            }
        }
        try { socket.close(); } catch (IOException ignored) {}
    }

    private void waitLocked(long millis) throws IOException {
        try {
            lock.wait(Math.max(1L, millis));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted", interrupted);
        }
    }

    private static void sleep(long millis) throws IOException {
        try {
            Thread.sleep(Math.max(1L, millis));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted", interrupted);
        }
    }
}
