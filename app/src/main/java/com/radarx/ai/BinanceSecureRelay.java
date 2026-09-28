package com.radarx.ai;

import android.net.Uri;
import android.webkit.WebResourceResponse;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

public final class BinanceSecureRelay {
    private static final String[] UPSTREAMS = {
            "https://data-api.binance.vision",
            "https://api.binance.com",
            "https://api-gcp.binance.com",
            "https://api1.binance.com",
            "https://api2.binance.com",
            "https://api3.binance.com",
            "https://api4.binance.com"
    };

    private static final Map<String, Long> TTL = new ConcurrentHashMap<>();
    private static final Map<String, CacheEntry> CACHE = new ConcurrentHashMap<>();

    private final OkHttpClient client;
    private final EndpointHealth[] health;
    private volatile int preferred = 0;

    public BinanceSecureRelay(OkHttpClient client) {
        this.client = client;
        this.health = new EndpointHealth[UPSTREAMS.length];
        for (int i = 0; i < health.length; i++) health[i] = new EndpointHealth();
        TTL.put("/api/v3/exchangeInfo", 300_000L);
        TTL.put("/api/v3/ticker/24hr", 1_200L);
        TTL.put("/api/v3/ticker", 1_200L);
        TTL.put("/api/v3/klines", 1_800L);
        TTL.put("/api/v3/uiKlines", 1_800L);
        TTL.put("/api/v3/depth", 700L);
        TTL.put("/api/v3/aggTrades", 600L);
        TTL.put("/api/v3/trades", 600L);
        TTL.put("/api/v3/time", 1_000L);
        TTL.put("/api/v3/ping", 1_000L);
    }

    public WebResourceResponse intercept(Uri uri) {
        if (uri == null || !"/api/binance".equals(uri.getPath())) return null;

        final String rawPath = uri.getQueryParameter("path");
        if (rawPath == null || !rawPath.startsWith("/api/v3/")) {
            return jsonResponse(400, "{\"code\":-1,\"msg\":\"Invalid Binance path\"}");
        }

        final Uri parsed;
        try {
            parsed = Uri.parse("https://data-api.binance.vision" + rawPath);
        } catch (Exception e) {
            return jsonResponse(400, "{\"code\":-1,\"msg\":\"Invalid Binance URL\"}");
        }

        final String endpoint = parsed.getPath();
        if (!isAllowed(endpoint)) {
            return jsonResponse(403, "{\"code\":-1,\"msg\":\"Endpoint not allowed\"}");
        }

        final String key = parsed.toString();
        CacheEntry fresh = getCache(key, endpoint, false);
        if (fresh != null) {
            return response(
                    200, "OK", "application/json; charset=utf-8",
                    fresh.body,
                    headers("HIT", "cache", fresh.ageMs)
            );
        }

        Exception last = null;
        for (int index : orderedIndexes()) {
            try {
                Uri target = Uri.parse(UPSTREAMS[index] + rawPath);
                long started = System.currentTimeMillis();

                Request request = new Request.Builder()
                        .url(target.toString())
                        .get()
                        .header("Accept", "application/json")
                        .header("User-Agent", "RadarX-Android/6.5")
                        .build();

                try (Response upstream = client.newCall(request).execute()) {
                    long latency = System.currentTimeMillis() - started;
                    byte[] body = upstream.body() == null
                            ? new byte[0]
                            : upstream.body().bytes();

                    if (!upstream.isSuccessful()) {
                        mark(index, false, latency);
                        last = new Exception("HTTP " + upstream.code());
                        continue;
                    }

                    mark(index, true, latency);
                    CacheEntry entry = new CacheEntry(body, System.currentTimeMillis());
                    CACHE.put(key, entry);
                    trimCache();
                    return response(
                            200, "OK", "application/json; charset=utf-8",
                            body,
                            headers("MISS", UPSTREAMS[index], 0)
                    );
                }
            } catch (Exception e) {
                last = e;
                mark(index, false, 0);
            }
        }

        CacheEntry stale = getCache(key, endpoint, true);
        if (stale != null) {
            return response(
                    200, "OK", "application/json; charset=utf-8",
                    stale.body,
                    headers("STALE", "cache", stale.ageMs)
            );
        }

        String body = "{\"code\":-1,\"msg\":\"Binance Spot relay unavailable\","
                + "\"detail\":\"native_relay_failed\",\"status\":502}";
        return jsonResponse(502, body);
    }

    public WebResourceResponse interceptHealth(Uri uri) {
        if (uri == null || !"/api/health".equals(uri.getPath())) return null;

        JSONObject binance = new JSONObject();
        try {
            int idx = preferred;
            long started = System.currentTimeMillis();

            Request request = new Request.Builder()
                    .url(UPSTREAMS[idx] + "/api/v3/ping")
                    .get()
                    .header("Accept", "application/json")
                    .header("User-Agent", "RadarX-Android/6.5")
                    .build();

            try (Response r = client.newCall(request).execute()) {
                boolean ok = r.isSuccessful();
                long latency = System.currentTimeMillis() - started;
                mark(idx, ok, latency);
                binance.put("id", "binance");
                binance.put("label", "Binance Spot");
                binance.put("family", "crypto");
                binance.put("ok", ok);
                binance.put("latencyMs", latency);
                binance.put("checkedAt", System.currentTimeMillis());
                binance.put("httpStatus", r.code());
                binance.put("hasData", ok);
                if (!ok) binance.put("error", "HTTP " + r.code());
            }
        } catch (Exception e) {
            binance.put("id", "binance");
            binance.put("label", "Binance Spot");
            binance.put("family", "crypto");
            binance.put("ok", false);
            binance.put("latencyMs", 0);
            binance.put("checkedAt", System.currentTimeMillis());
            binance.put("error", safe(e.getMessage()));
        }

        JSONObject root = new JSONObject();
        org.json.JSONArray results = new org.json.JSONArray();
        results.put(binance);

        try {
            String[] others = {"okx", "bybit", "gate", "coinbase", "coingecko", "binanceFutures", "yahoo"};
            String[] labels = {"OKX", "Bybit", "Gate", "Coinbase", "CoinGecko", "Binance Futures", "Yahoo Finance"};
            String[] family = {"crypto", "crypto", "crypto", "crypto", "global", "derivatives", "global"};
            for (int i = 0; i < others.length; i++) {
                JSONObject x = new JSONObject();
                x.put("id", others[i]);
                x.put("label", labels[i]);
                x.put("family", family[i]);
                x.put("ok", false);
                x.put("latencyMs", 0);
                x.put("checkedAt", System.currentTimeMillis());
                x.put("error", "native_binance_relay_only");
                results.put(x);
            }
            root.put("ok", true);
            root.put("checkedAt", System.currentTimeMillis());
            root.put("durationMs", 0);
            root.put("total", results.length());
            root.put("online", binance.optBoolean("ok", false) ? 1 : 0);
            root.put("cryptoOnline", binance.optBoolean("ok", false) ? 1 : 0);
            root.put("metalsOnline", 0);
            root.put("results", results);
        } catch (Exception ignored) {
        }

        return response(
                200, "OK", "application/json; charset=utf-8",
                root.toString().getBytes(StandardCharsets.UTF_8),
                headers("LOCAL", "native", 0)
        );
    }

    private int[] orderedIndexes() {
        int[] out = new int[UPSTREAMS.length];
        int p = 0;
        out[p++] = preferred;
        EndpointScore[] scores = new EndpointScore[UPSTREAMS.length - 1];
        int s = 0;
        for (int i = 0; i < UPSTREAMS.length; i++) {
            if (i == preferred) continue;
            scores[s++] = new EndpointScore(i, health[i].score());
        }
        java.util.Arrays.sort(scores, (a, b) -> Double.compare(b.score, a.score));
        for (EndpointScore x : scores) out[p++] = x.index;
        return out;
    }

    private void mark(int index, boolean ok, long latencyMs) {
        EndpointHealth h = health[index];
        synchronized (h) {
            if (ok) {
                h.ok++;
                h.lastOk = System.currentTimeMillis();
                if (latencyMs > 0) h.latencyMs = latencyMs;
                preferred = index;
            } else {
                h.fail++;
                h.lastFail = System.currentTimeMillis();
            }
        }
    }

    private CacheEntry getCache(String key, String endpoint, boolean allowStale) {
        CacheEntry entry = CACHE.get(key);
        if (entry == null) return null;
        long age = System.currentTimeMillis() - entry.ts;
        long ttl = TTL.getOrDefault(endpoint, 1_000L);
        long staleTtl = Math.max(ttl * 12L, 3_000L);
        if (age <= ttl || (allowStale && age <= staleTtl)) {
            entry.ageMs = age;
            return entry;
        }
        CACHE.remove(key);
        return null;
    }

    private void trimCache() {
        if (CACHE.size() <= 350) return;
        int remove = 80;
        for (String key : CACHE.keySet()) {
            CACHE.remove(key);
            if (--remove <= 0) break;
        }
    }

    private boolean isAllowed(String path) {
        return "/api/v3/ping".equals(path)
                || "/api/v3/time".equals(path)
                || "/api/v3/exchangeInfo".equals(path)
                || "/api/v3/ticker".equals(path)
                || "/api/v3/ticker/24hr".equals(path)
                || "/api/v3/ticker/bookTicker".equals(path)
                || "/api/v3/ticker/price".equals(path)
                || "/api/v3/klines".equals(path)
                || "/api/v3/uiKlines".equals(path)
                || "/api/v3/depth".equals(path)
                || "/api/v3/aggTrades".equals(path)
                || "/api/v3/trades".equals(path);
    }

    private WebResourceResponse jsonResponse(int status, String body) {
        return response(
                status,
                status == 200 ? "OK" : "BAD_GATEWAY",
                "application/json; charset=utf-8",
                body.getBytes(StandardCharsets.UTF_8),
                headers("MISS", "native", 0)
        );
    }

    private Map<String, String> headers(String cache, String upstream, long age) {
        Map<String, String> h = new java.util.HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        h.put("Access-Control-Allow-Methods", "GET, OPTIONS");
        h.put("Access-Control-Allow-Headers", "Content-Type, Accept");
        h.put("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        h.put("X-RadarX-Relay", "binance-spot-native");
        h.put("X-RadarX-Cache", cache);
        h.put("X-RadarX-Upstream", upstream);
        h.put("X-RadarX-Data-Age-Ms", Long.toString(age));
        return h;
    }

    private WebResourceResponse response(
            int status, String reason, String mime, byte[] body, Map<String, String> headers
    ) {
        return new WebResourceResponse(
                mime,
                "UTF-8",
                status,
                reason,
                headers,
                new ByteArrayInputStream(body == null ? new byte[0] : body)
        );
    }

    private static String safe(String s) {
        return s == null || s.isEmpty() ? "upstream_unavailable" : s;
    }

    private static final class CacheEntry {
        final byte[] body;
        final long ts;
        volatile long ageMs;
        CacheEntry(byte[] body, long ts) {
            this.body = body;
            this.ts = ts;
        }
    }

    private static final class EndpointHealth {
        long ok;
        long fail;
        long lastOk;
        long lastFail;
        long latencyMs;
        double score() {
            return (ok - fail * 2.0) * 0.4
                    + (lastOk > 0 && System.currentTimeMillis() - lastOk < 30_000L ? 20 : 0)
                    - (latencyMs > 0 ? latencyMs / 300.0 : 0);
        }
    }

    private static final class EndpointScore {
        final int index;
        final double score;
        EndpointScore(int index, double score) {
            this.index = index;
            this.score = score;
        }
    }
}
