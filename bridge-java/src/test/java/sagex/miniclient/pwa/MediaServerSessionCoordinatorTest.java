package sagex.miniclient.pwa;

import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.server.ServerConnector;
import org.eclipse.jetty.servlet.ServletContextHandler;
import org.eclipse.jetty.servlet.ServletHolder;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.*;

class MediaServerSessionCoordinatorTest {
    private final List<AutoCloseable> resources = new ArrayList<>();

    @AfterEach
    void closeResources() throws Exception {
        Collections.reverse(resources);
        for (AutoCloseable resource : resources) resource.close();
    }

    @Test
    void delayedReconnectUsesOneProducerAndContinuesFromCommittedWatermark() throws Exception {
        FakeMediaServer mediaServer = fakeServer(16_384);
        MediaServerSessionCoordinator coordinator = coordinator(
            mediaServer, "session-a", 0, settings(1_024, 1_000, 2_000, 64));
        coordinator.start();
        coordinator.awaitReady();

        byte[] first;
        try (MediaServerSessionCoordinator.Consumer consumer = coordinator.attach()) {
            first = consumer.next(128);
            consumer.commit(first.length, 0);
        }

        Thread.sleep(450);
        byte[] second;
        try (MediaServerSessionCoordinator.Consumer consumer = coordinator.attach()) {
            assertEquals(first.length, consumer.cursor());
            second = consumer.next(128);
            consumer.commit(second.length, 0);
        }

        assertArrayEquals(mediaServer.slice(0, first.length), first);
        assertArrayEquals(mediaServer.slice(first.length, second.length), second);
        assertEquals(1, mediaServer.connections.get());
        assertEquals(1, mediaServer.xcodeSetups.get());
        assertEquals(1, mediaServer.opens.get());
    }

    @Test
    void concurrentStartupProbesShareOneProducerAndKeepIndependentCursors() throws Exception {
        FakeMediaServer mediaServer = fakeServer(16_384);
        MediaServerSessionCoordinator coordinator = coordinator(mediaServer, "session-probes", 0, settings());
        coordinator.start();
        coordinator.awaitReady();

        try (MediaServerSessionCoordinator.Consumer first = coordinator.attach();
             MediaServerSessionCoordinator.Consumer second = coordinator.attach()) {
            byte[] firstBytes = first.next(64);
            byte[] secondBytes = second.next(64);
            first.commit(firstBytes.length, 0);
            second.commit(secondBytes.length, 0);
            assertArrayEquals(firstBytes, secondBytes);
            assertEquals(64, first.cursor());
            assertEquals(64, second.cursor());
        }

        assertEquals(1, mediaServer.connections.get());
        assertEquals(1, mediaServer.xcodeSetups.get());
        assertEquals(1, mediaServer.opens.get());
    }

    @Test
    void failedProbeDoesNotAdvanceDeliveredWatermark() throws Exception {
        FakeMediaServer mediaServer = fakeServer(16_384);
        MediaServerSessionCoordinator coordinator = coordinator(mediaServer, "session-failed-probe", 0, settings());
        coordinator.start();
        coordinator.awaitReady();

        byte[] uncommitted;
        try (MediaServerSessionCoordinator.Consumer probe = coordinator.attach()) {
            uncommitted = probe.next(64);
        }

        try (MediaServerSessionCoordinator.Consumer replacement = coordinator.attach()) {
            assertEquals(0, replacement.cursor());
            byte[] replayed = replacement.next(64);
            replacement.commit(replayed.length, 0);
            assertArrayEquals(uncommitted, replayed);
        }
    }

    @Test
    void zeroConsumerGraceClosesProducerExactlyOnce() throws Exception {
        FakeMediaServer mediaServer = fakeServer(1_000_000);
        AtomicInteger terminations = new AtomicInteger();
        MediaServerSessionCoordinator coordinator = coordinator(
            mediaServer, "session-close", 0, settings(1_024, 40, 200, 64), terminations::incrementAndGet);
        coordinator.start();
        coordinator.awaitReady();
        try (MediaServerSessionCoordinator.Consumer ignored = coordinator.attach()) {
            // Attach and immediately detach.
        }

        await(() -> mediaServer.closes.get() == 1 && terminations.get() == 1, 2_000);
        assertEquals(1, mediaServer.connections.get());
        assertEquals(1, mediaServer.closes.get());
        assertTrue(coordinator.isTerminated());
    }

    @Test
    void boundedRingEvictsStaleLaggingConsumer() throws Exception {
        FakeMediaServer mediaServer = fakeServer(1_000_000);
        MediaServerSessionCoordinator.Settings settings = settings(256, 500, 25, 64);
        MediaServerSessionCoordinator coordinator = coordinator(
            mediaServer, "session-ring", 0, settings);
        coordinator.start();
        coordinator.awaitReady();

        try (MediaServerSessionCoordinator.Consumer active = coordinator.attach();
             MediaServerSessionCoordinator.Consumer stale = coordinator.attach()) {
            for (int i = 0; i < 20; i++) {
                byte[] bytes = active.next(64);
                active.commit(bytes.length, 0);
                Thread.sleep(3);
            }
            Thread.sleep(100);
            assertThrows(IOException.class, () -> stale.next(64));
        }
    }

    @Test
    void eofPropagatesAfterBufferedBytesDrain() throws Exception {
        FakeMediaServer mediaServer = fakeServer(512);
        MediaServerSessionCoordinator coordinator = coordinator(
            mediaServer, "session-eof", 0, settings(2_048, 500, 200, 64));
        coordinator.start();
        coordinator.awaitReady();

        ByteArrayOutputStream received = new ByteArrayOutputStream();
        try (MediaServerSessionCoordinator.Consumer consumer = coordinator.attach()) {
            byte[] bytes;
            while ((bytes = consumer.next(64)) != null) {
                received.write(bytes);
                consumer.commit(bytes.length, 0);
            }
        }
        assertArrayEquals(mediaServer.data, received.toByteArray());
    }

    @Test
    void producerReadFailurePropagatesAfterReplayDrain() throws Exception {
        FakeMediaServer mediaServer = fakeServer(4_096);
        mediaServer.failReadAt = 256;
        MediaServerSessionCoordinator coordinator = coordinator(
            mediaServer, "session-error", 0, settings(1_024, 500, 200, 64));
        coordinator.start();
        coordinator.awaitReady();

        try (MediaServerSessionCoordinator.Consumer consumer = coordinator.attach()) {
            int delivered = 0;
            IOException failure = null;
            while (failure == null) {
                try {
                    byte[] bytes = consumer.next(64);
                    if (bytes == null) fail("Expected producer error");
                    delivered += bytes.length;
                    consumer.commit(bytes.length, 0);
                } catch (IOException expected) {
                    failure = expected;
                }
            }
            assertEquals(256, delivered);
        }
    }

    @Test
    void newSeekSessionCreatesIndependentProducer() throws Exception {
        FakeMediaServer mediaServer = fakeServer(16_384);
        MediaServerSessionCoordinator first = coordinator(mediaServer, "seek-1", 10_000, settings());
        MediaServerSessionCoordinator second = coordinator(mediaServer, "seek-2", 20_000, settings());
        first.start();
        second.start();
        first.awaitReady();
        second.awaitReady();
        try (MediaServerSessionCoordinator.Consumer ignored1 = first.attach();
             MediaServerSessionCoordinator.Consumer ignored2 = second.attach()) {
            assertEquals(2, mediaServer.connections.get());
            assertEquals(2, mediaServer.xcodeSetups.get());
            List<String> commands;
            synchronized (mediaServer.commands) {
                commands = new ArrayList<>(mediaServer.commands);
            }
            assertTrue(commands.stream().anyMatch(value -> value.contains(";ss=10000")));
            assertTrue(commands.stream().anyMatch(value -> value.contains(";ss=20000")));
        }
    }

    @Test
    void conflictingSessionIdentityReturns409WithoutSecondProducer() throws Exception {
        FakeMediaServer mediaServer = fakeServer(1_000_000);
        TestHttpServer http = httpServer(mediaServer, settings(4_096, 500, 5_000, 256));

        HttpURLConnection first = http.open(
            "/msproxy?path=C%3A%2Fmedia%2Ftest.mpg&mode=xcode:browserhd&session=conflict");
        assertEquals(200, first.getResponseCode());
        resources.add(first::disconnect);

        HttpURLConnection conflicting = http.open(
            "/msproxy?path=C%3A%2Fmedia%2Ftest.mpg&mode=xcode:browserhd&seek=10&session=conflict");
        assertEquals(409, conflicting.getResponseCode());
        conflicting.disconnect();
        assertEquals(1, mediaServer.connections.get());
        assertEquals(1, mediaServer.xcodeSetups.get());
    }

    @Test
    void staticRangeRetainsRfc7233Semantics() throws Exception {
        FakeMediaServer mediaServer = fakeServer(512);
        TestHttpServer http = httpServer(mediaServer, settings());
        HttpURLConnection connection = http.open(
            "/msproxy?path=C%3A%2Fmedia%2Ftest.mpg&mode=direct");
        connection.setRequestProperty("Range", "bytes=10-19");

        assertEquals(206, connection.getResponseCode());
        assertEquals("bytes", connection.getHeaderField("Accept-Ranges"));
        assertEquals("bytes 10-19/512", connection.getHeaderField("Content-Range"));
        assertArrayEquals(mediaServer.slice(10, 10), readAll(connection.getInputStream()));
        connection.disconnect();
    }

    @Test
    void liveXcodeIgnoresRangeAndStartsAtCoordinatorWatermark() throws Exception {
        FakeMediaServer mediaServer = fakeServer(512);
        TestHttpServer http = httpServer(mediaServer, settings(2_048, 500, 200, 64));
        HttpURLConnection connection = http.open(
            "/msproxy?path=C%3A%2Fmedia%2Ftest.mpg&mode=xcode:browserhd&session=range-live");
        connection.setRequestProperty("Range", "bytes=100-");

        assertEquals(200, connection.getResponseCode());
        byte[] first = new byte[64];
        int read = connection.getInputStream().read(first);
        assertEquals(64, read);
        assertEquals("none", connection.getHeaderField("Accept-Ranges"));
        assertArrayEquals(mediaServer.slice(0, 64), first);
        connection.disconnect();
    }

    @Test
    void sameSessionHttpReconnectDoesNotOpenCompetingProducer() throws Exception {
        FakeMediaServer mediaServer = fakeServer(32 * 1024 * 1024);
        mediaServer.growing = true;
        TestHttpServer http = httpServer(mediaServer, settings(4_096, 300, 5_000, 256));
        String path = "/msproxy?path=C%3A%2Fmedia%2Ftest.mpg&mode=xcode:browserhd&session=reconnect";

        HttpURLConnection first = http.open(path);
        assertEquals(200, first.getResponseCode());
        byte[] bytes = new byte[128];
        assertTrue(first.getInputStream().read(bytes) > 0);
        first.disconnect();

        Thread.sleep(30);
        HttpURLConnection second = http.open(path);
        assertEquals(200, second.getResponseCode());
        assertTrue(second.getInputStream().read(bytes) > 0);
        second.disconnect();

        assertEquals(1, mediaServer.connections.get());
        assertEquals(1, mediaServer.xcodeSetups.get());
        assertEquals(1, mediaServer.opens.get());
    }

    @Test
    void completedCoordinatorCleanupAllowsSessionIdReuse() throws Exception {
        FakeMediaServer mediaServer = fakeServer(512);
        TestHttpServer http = httpServer(mediaServer, settings(2_048, 60, 200, 64));
        String path = "/msproxy?path=C%3A%2Fmedia%2Ftest.mpg&mode=xcode:browserhd&session=reuse";

        HttpURLConnection first = http.open(path);
        assertEquals(200, first.getResponseCode());
        assertArrayEquals(mediaServer.data, readAll(first.getInputStream()));
        first.disconnect();
        await(() -> mediaServer.closes.get() == 1, 2_000);

        HttpURLConnection second = http.open(path);
        assertEquals(200, second.getResponseCode());
        assertTrue(second.getInputStream().read() >= 0);
        second.disconnect();
        assertEquals(2, mediaServer.connections.get());
        assertEquals(2, mediaServer.xcodeSetups.get());
        assertEquals(2, mediaServer.opens.get());
    }

    private FakeMediaServer fakeServer(int size) throws IOException {
        FakeMediaServer server = new FakeMediaServer(size);
        resources.add(server);
        return server;
    }

    private TestHttpServer httpServer(FakeMediaServer mediaServer,
                                      MediaServerSessionCoordinator.Settings settings) throws Exception {
        TestHttpServer server = new TestHttpServer(mediaServer.port(), settings);
        resources.add(server);
        return server;
    }

    private MediaServerSessionCoordinator coordinator(FakeMediaServer mediaServer,
                                                      String sessionId, long seekMs,
                                                      MediaServerSessionCoordinator.Settings settings) {
        return coordinator(mediaServer, sessionId, seekMs, settings, () -> {});
    }

    private MediaServerSessionCoordinator coordinator(FakeMediaServer mediaServer,
                                                      String sessionId, long seekMs,
                                                      MediaServerSessionCoordinator.Settings settings,
                                                      Runnable onTermination) {
        String setup = "XCODE_SETUP browserhd" + (seekMs > 0 ? ";ss=" + seekMs : "");
        MediaServerSessionCoordinator.SessionKey key =
            new MediaServerSessionCoordinator.SessionKey(
                sessionId, "/media/test.mpg", "xcode:browserhd", setup,
                seekMs, null, null, "127.0.0.1", false);
        return new MediaServerSessionCoordinator(
            "127.0.0.1", mediaServer.port(), key, settings, onTermination);
    }

    private static MediaServerSessionCoordinator.Settings settings() {
        return settings(1_024, 500, 200, 64);
    }

    private static MediaServerSessionCoordinator.Settings settings(
        long ringBytes, long graceMs, long staleMs, int chunkBytes) {
        return new MediaServerSessionCoordinator.Settings(
            ringBytes, graceMs, staleMs, 2_000, 2, 10_000, 1_000, 30, chunkBytes);
    }

    private static byte[] readAll(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[256];
        int read;
        while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
        return output.toByteArray();
    }

    private static void await(BooleanSupplier condition, long timeoutMs) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (!condition.getAsBoolean()) {
            if (System.currentTimeMillis() >= deadline) fail("Condition not met within timeout");
            Thread.sleep(5);
        }
    }

    private static final class TestHttpServer implements AutoCloseable {
        private final Server server;
        private final int port;

        TestHttpServer(int mediaServerPort,
                       MediaServerSessionCoordinator.Settings settings) throws Exception {
            server = new Server();
            ServerConnector connector = new ServerConnector(server);
            connector.setHost("127.0.0.1");
            connector.setPort(0);
            server.addConnector(connector);
            ServletContextHandler context = new ServletContextHandler();
            context.setContextPath("/");
            context.addServlet(new ServletHolder(
                new MediaServerProxyServlet("127.0.0.1", mediaServerPort, settings)), "/msproxy");
            server.setHandler(context);
            server.start();
            port = connector.getLocalPort();
        }

        HttpURLConnection open(String path) throws IOException {
            HttpURLConnection connection =
                (HttpURLConnection) new URL("http://127.0.0.1:" + port + path).openConnection();
            connection.setConnectTimeout(2_000);
            connection.setReadTimeout(2_000);
            return connection;
        }

        @Override
        public void close() throws Exception {
            server.stop();
            server.join();
        }
    }

    private static final class FakeMediaServer implements AutoCloseable {
        final byte[] data;
        final AtomicInteger connections = new AtomicInteger();
        final AtomicInteger xcodeSetups = new AtomicInteger();
        final AtomicInteger opens = new AtomicInteger();
        final AtomicInteger closes = new AtomicInteger();
        final List<String> commands = Collections.synchronizedList(new ArrayList<>());
        volatile long failReadAt = -1;
        volatile boolean growing;

        private final ServerSocket serverSocket;
        private final AtomicBoolean running = new AtomicBoolean(true);
        private final CountDownLatch stopped = new CountDownLatch(1);
        private final List<Socket> sockets = Collections.synchronizedList(new ArrayList<>());
        private final Thread acceptThread;

        FakeMediaServer(int size) throws IOException {
            data = new byte[size];
            for (int i = 0; i < data.length; i++) data[i] = (byte) (i & 0xff);
            serverSocket = new ServerSocket(0, 50, java.net.InetAddress.getLoopbackAddress());
            acceptThread = new Thread(this::acceptLoop, "fake-mediaserver");
            acceptThread.setDaemon(true);
            acceptThread.start();
        }

        int port() {
            return serverSocket.getLocalPort();
        }

        byte[] slice(int offset, int length) {
            byte[] result = new byte[length];
            System.arraycopy(data, offset, result, 0, length);
            return result;
        }

        private void acceptLoop() {
            try {
                while (running.get()) {
                    Socket socket = serverSocket.accept();
                    sockets.add(socket);
                    connections.incrementAndGet();
                    Thread handler = new Thread(() -> handle(socket), "fake-mediaserver-client");
                    handler.setDaemon(true);
                    handler.start();
                }
            } catch (IOException ignored) {
                // Closing the server socket ends the accept loop.
            } finally {
                stopped.countDown();
            }
        }

        private void handle(Socket socket) {
            try {
                InputStream input = socket.getInputStream();
                OutputStream output = socket.getOutputStream();
                while (true) {
                    String command = MediaServerProxyServlet.readLine(input);
                    commands.add(command);
                    if (command.startsWith("CLIENT_ORIGIN ")) {
                        line(output, "OK");
                    } else if (command.startsWith("XCODE_SETUP ")) {
                        xcodeSetups.incrementAndGet();
                        line(output, "OK");
                    } else if (command.startsWith("OPEN ")) {
                        opens.incrementAndGet();
                        line(output, "OK");
                    } else if ("SIZE".equals(command)) {
                        line(output, data.length + " " + (growing ? data.length + 1L : data.length));
                    } else if (command.startsWith("READ ")) {
                        String[] parts = command.split(" ");
                        int offset = Integer.parseInt(parts[1]);
                        int length = Integer.parseInt(parts[2]);
                        if (failReadAt >= 0 && offset >= failReadAt) {
                            socket.close();
                            return;
                        }
                        output.write(data, offset, length);
                        output.flush();
                    } else if (command.startsWith("XCODE_ADJUST ")) {
                        line(output, "28000");
                    } else if ("CLOSE".equals(command)) {
                        closes.incrementAndGet();
                        line(output, "OK");
                        return;
                    } else {
                        line(output, "PARAM_ERROR");
                    }
                }
            } catch (IOException ignored) {
                // Tests intentionally disconnect clients and inject read failures.
            } finally {
                try { socket.close(); } catch (IOException ignored) {}
            }
        }

        private static void line(OutputStream output, String value) throws IOException {
            output.write((value + "\r\n").getBytes(StandardCharsets.UTF_8));
            output.flush();
        }

        @Override
        public void close() throws Exception {
            running.set(false);
            serverSocket.close();
            synchronized (sockets) {
                for (Socket socket : sockets) {
                    try { socket.close(); } catch (IOException ignored) {}
                }
            }
            stopped.await(1, TimeUnit.SECONDS);
        }
    }
}
