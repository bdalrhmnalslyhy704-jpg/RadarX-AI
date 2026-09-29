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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
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
    private final AtomicLong sequence = new AtomicLong(0);
    private final Map<String, Result> completed = new ConcurrentHashMap<>();

    public NativeBinanceHttpQueue(OkHttpClient baseClient) {
        this.cloudClient = baseClient.newBuilder()
                .connectTimeout(6_500L, java.util.concurrent.TimeUnit.MILLISECONDS)
                .readTimeout(6_500L, java.util.concurrent.TimeUnit.MILLISECONDS)
                .writeTimeout(6_500L, java.util.concurrent.TimeUnit.MILLISECONDS)
                .retryOnConnectionFailure(true)
                .build();

        this.directClient = baseClient.newBuilder()
                .connectTimeout(5_000L, java.util.concurrent.TimeUnit.MILLISECONDS)
                .readTimeout(6_000L, java.util.concurrent.TimeUnit.MILLISECONDS)
                .writeTimeout(6_000L, java.util.concurrent.TimeUnit.MILLISECONDS)
                .retryOnConnectionFailure(true)
                .dns(new RadarXDohDns())
                .build();

        this.executor = Executors.newFixedThreadPool(3, new DaemonFactory());
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
        completed.clear();
    }

    private Result perform(String rawPath) {
        // Prefer a direct Spot endpoint with resilient DoH DNS. Use the
        // deployed relay only when direct Binance access is unavailable.
        Throwable last = null;

        for (int pass = 0; pass < 2; pass++) {
            if (pass == 0) {
                for (String base : UPSTREAMS) {
                    try {
                        Request direct = new Request.Builder()
                                .url(base + rawPath)
                                .get()
                                .header("Accept", "application/json")
                                .header("User-Agent", "RadarX-Android/6.8.1")
                                .build();

                        try (Response r = directClient.newCall(direct).execute()) {
                            byte[] body = r.body() == null ? new byte[0] : r.body().bytes();
                            if (r.isSuccessful() && looksLikeJson(body)) {
                                return new Result(r.code(), "OK", "application/json; charset=utf-8", body, base);
                            }
                            last = new RuntimeException("HTTP " + r.code());
                        }
                    } catch (Throwable t) {
                        last = t;
                    }
                }
            } else {
                try {
                    Request cloud = new Request.Builder()
                            .url(REMOTE_RELAY + "?path=" + Uri.encode(rawPath))
                            .get()
                            .header("Accept", "application/json")
                            .header("User-Agent", "RadarX-Android/6.8.1")
                            .build();

                    try (Response r = cloudClient.newCall(cloud).execute()) {
                        byte[] body = r.body() == null ? new byte[0] : r.body().bytes();
                        if (r.isSuccessful() && looksLikeJson(body)) {
                            return new Result(r.code(), "OK", "application/json; charset=utf-8", body, "radarx-cloud-relay");
                        }
                        last = new RuntimeException("Cloud HTTP " + r.code());
                    }
                } catch (Throwable t) {
                    last = t;
                }
            }
        }

        String message = last == null || last.getMessage() == null
                ? "Binance Spot unavailable"
                : last.getMessage();
        String body = "{\"code\":-1,\"msg\":\"Binance Spot unavailable\","
                + "\"detail\":\"" + escape(message) + "\",\"status\":502}";
        return new Result(502, "BAD_GATEWAY", "application/json; charset=utf-8",
                body.getBytes(StandardCharsets.UTF_8), "none");
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
        @Override public Thread newThread(Runnable r) {
            Thread t = new Thread(r, "RadarX-Binance-HTTP");
            t.setDaemon(true);
            return t;
        }
    }
}
