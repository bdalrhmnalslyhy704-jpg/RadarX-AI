package com.radarx.ai;

import android.net.Uri;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletionService;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorCompletionService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

public final class NativeBinanceHttpQueue {
    private static final String REMOTE_RELAY =
            "https://radar-x-ai.vercel.app/api/binance";

    private static final String[] UPSTREAMS = {
            "https://api.binance.com",
            "https://data-api.binance.vision",
            "https://api-gcp.binance.com",
            "https://api1.binance.com",
            "https://api2.binance.com",
            "https://api3.binance.com",
            "https://api4.binance.com"
    };

    private static final List<String> ALLOWED = Collections.unmodifiableList(Arrays.asList(
            "/api/v3/ping",
            "/api/v3/time",
            "/api/v3/exchangeInfo",
            "/api/v3/ticker",
            "/api/v3/ticker/24hr",
            "/api/v3/ticker/bookTicker",
            "/api/v3/ticker/price",
            "/api/v3/klines",
            "/api/v3/uiKlines",
            "/api/v3/depth",
            "/api/v3/aggTrades",
            "/api/v3/trades"
    ));

    private final OkHttpClient cloudClient;
    private final OkHttpClient directClient;
    private final ExecutorService executor;
    private final ExecutorService probeExecutor;
    private final AtomicLong sequence = new AtomicLong(0);
    private final AtomicInteger preferredIndex = new AtomicInteger(0);
    private final Map<String, Result> completed = new ConcurrentHashMap<>();

    public NativeBinanceHttpQueue(OkHttpClient baseClient) {
        this.cloudClient = baseClient.newBuilder()
                .connectTimeout(6_500L, java.util.concurrent.TimeUnit.MILLISECONDS)
                .readTimeout(6_500L, java.util.concurrent.TimeUnit.MILLISECONDS)
                .writeTimeout(6_500L, java.util.concurrent.TimeUnit.MILLISECONDS)
                .retryOnConnectionFailure(true)
                .build();

        this.directClient = baseClient.newBuilder()
                .connectTimeout(3_200L, java.util.concurrent.TimeUnit.MILLISECONDS)
                .readTimeout(5_000L, java.util.concurrent.TimeUnit.MILLISECONDS)
                .writeTimeout(6_000L, java.util.concurrent.TimeUnit.MILLISECONDS)
                .retryOnConnectionFailure(true)
                // Inherit the shared DoH-enabled DNS from baseClient.
                .build();

        int ioThreads = Math.max(3, Math.min(4, Runtime.getRuntime().availableProcessors()));
        this.executor = Executors.newFixedThreadPool(ioThreads, new DaemonFactory("RadarX-Binance-HTTP"));
        this.probeExecutor = Executors.newFixedThreadPool(4, new DaemonFactory("RadarX-Binance-Probe"));
    }

    public String start(String rawPath) {
        final String path = rawPath == null ? "" : rawPath.trim();
        final String id = "bx-" + sequence.incrementAndGet();

        if (!isValidPath(path)) {
            completed.put(id, new Result(
                    400,
                    "Invalid Binance path",
                    "application/json; charset=utf-8"
            ));
            return id;
        }

        executor.execute(() -> completed.put(id, perform(path)));
        return id;
    }

    public String pollJson(int max) {
        int limit = Math.max(1, Math.min(30, max));
        StringBuilder out = new StringBuilder("[");
        int count = 0;

        for (Map.Entry<String, Result> entry : completed.entrySet()) {
            if (count >= limit) break;
            Result result = completed.remove(entry.getKey());
            if (result == null) continue;

            if (count++ > 0) out.append(',');
            out.append("{\"id\":\"").append(escape(entry.getKey()))
                    .append("\",\"status\":").append(result.status)
                    .append(",\"mime\":\"").append(escape(result.mime))
                    .append("\",\"bodyB64\":\"")
                    .append(encode(result.body))
                    .append("\",\"route\":\"").append(escape(result.route))
                    .append("\"}");
        }

        out.append(']');
        return out.toString();
    }

    public void shutdown() {
        executor.shutdownNow();
        probeExecutor.shutdownNow();
        completed.clear();
    }

    private Result perform(String rawPath) {
        int preferred = Math.floorMod(preferredIndex.get(), UPSTREAMS.length);
        int[] firstDirect = nextDistinct(preferred, 3);

        // Fast race: several Binance routes and the RadarX relay are tested
        // together. A healthy path wins without waiting for blocked routes.
        List<Callable<Result>> firstWave = new ArrayList<>();
        firstWave.add(() -> requestDirect(rawPath, firstDirect[0]));
        firstWave.add(() -> requestDirect(rawPath, firstDirect[1]));
        firstWave.add(() -> requestDirect(rawPath, firstDirect[2]));
        firstWave.add(() -> requestCloud(rawPath));

        Result winner = race(firstWave, 5_800L);
        if (winner != null) return winner;

        // Only on a total first-wave failure do we probe the remaining mirrors.
        List<Callable<Result>> secondWave = new ArrayList<>();
        for (int i = 0; i < UPSTREAMS.length; i++) {
            boolean used = false;
            for (int direct : firstDirect) if (direct == i) { used = true; break; }
            if (!used) {
                final int index = i;
                secondWave.add(() -> requestDirect(rawPath, index));
            }
        }
        winner = race(secondWave, 5_600L);
        if (winner != null) return winner;

        String body = "{\"code\":-1,\"msg\":\"Binance Spot unavailable\","
                + "\"detail\":\"ALL_BINANCE_ROUTES_FAILED\",\"status\":502}";
        return new Result(
                502,
                "BAD_GATEWAY",
                "application/json; charset=utf-8",
                body.getBytes(StandardCharsets.UTF_8),
                "none"
        );
    }

    private Result race(List<Callable<Result>> jobs, long timeoutMs) {
        if (jobs == null || jobs.isEmpty()) return null;
        CompletionService<Result> completion = new ExecutorCompletionService<>(probeExecutor);
        List<Future<Result>> futures = new ArrayList<>(jobs.size());
        for (Callable<Result> job : jobs) futures.add(completion.submit(job));

        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        try {
            for (int done = 0; done < futures.size(); done++) {
                long remaining = deadline - System.nanoTime();
                if (remaining <= 0) break;
                Future<Result> future = completion.poll(remaining, TimeUnit.NANOSECONDS);
                if (future == null) break;
                try {
                    Result result = future.get();
                    if (result != null && result.status < 300 && looksLikeJson(result.body)) {
                        cancelAll(futures);
                        return result;
                    }
                } catch (ExecutionException ignored) {
                    // A single failed route must never block the remaining routes.
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            cancelAll(futures);
        }
        return null;
    }

    private void cancelAll(List<Future<Result>> futures) {
        for (Future<Result> f : futures) {
            if (f != null && !f.isDone()) f.cancel(true);
        }
    }

    private int[] nextDistinct(int preferred, int count) {
        int n = Math.max(1, Math.min(count, UPSTREAMS.length));
        int[] out = new int[n];
        int size = 0;
        for (int step = 0; step < UPSTREAMS.length && size < n; step++) {
            int idx = Math.floorMod(preferred + step, UPSTREAMS.length);
            boolean duplicate = false;
            for (int j = 0; j < size; j++) if (out[j] == idx) duplicate = true;
            if (!duplicate) out[size++] = idx;
        }
        return out;
    }

    private boolean isValidPath(String rawPath) {
        if (!rawPath.startsWith("/api/v3/")) return false;
        int q = rawPath.indexOf('?');
        String pathname = q >= 0 ? rawPath.substring(0, q) : rawPath;
        return ALLOWED.contains(pathname);
    }

    private boolean looksLikeJson(byte[] body) {
        if (body == null || body.length == 0) return false;
        String s = new String(body, StandardCharsets.UTF_8).trim();
        return s.startsWith("{") || s.startsWith("[");
    }

    private String encode(byte[] body) {
        return Base64.encodeToString(body == null ? new byte[0] : body, Base64.NO_WRAP);
    }

    private static String escape(String value) {
        return String.valueOf(value)
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\r", "\\r")
                .replace("\n", "\\n");
    }

    private static final class Result {
        final int status;
        final String reason;
        final String mime;
        final byte[] body;
        final String route;

        Result(int status, String reason, String mime) {
            this(status, reason, mime,
                    ("{\"code\":-1,\"msg\":\"" + escape(reason) + "\"}")
                            .getBytes(StandardCharsets.UTF_8),
                    "local");
        }

        Result(int status, String reason, String mime, byte[] body, String route) {
            this.status = status;
            this.reason = reason;
            this.mime = mime;
            this.body = body == null ? new byte[0] : body;
            this.route = route == null ? "none" : route;
        }
    }

    private static final class DaemonFactory implements ThreadFactory {
        private final String name;
        DaemonFactory(String name) { this.name = name; }
        @Override public Thread newThread(Runnable r) {
            Thread t = new Thread(r, name);
            t.setDaemon(true);
            return t;
        }
    }
}
