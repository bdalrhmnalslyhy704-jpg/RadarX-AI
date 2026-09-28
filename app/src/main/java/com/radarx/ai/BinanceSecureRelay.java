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
    private static final String REMOTE_RELAY = "https://radar-x-ai.vercel.app/api/binance";

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

        // Regional/cloud fallback: the deployed RadarX relay can reach Binance
        // even when the handset cannot resolve or route to Binance directly.
        try {
            Request cloud = new Request.Builder()
                    .url(REMOTE_RELAY + "?path=" + Uri.encode(rawPath))
                    .get()
                    .header("Accept", "application/json")
                    .header("User-Agent", "RadarX-Android/6.8.0")
                    .build();
            long started = System.currentTimeMillis();
            try (Response upstream = client.newCall(cloud).execute()) {
                long latency = System.currentTimeMillis() - started;
                byte[] body = upstream.body() == null ? new byte[0] : upstream.body().bytes();
                if (upstream.isSuccessful() && looksLikeJson(body)) {
                    CACHE.put(key, new CacheEntry(body, System.currentTimeMillis()));
                    trimCache();
                    return response(
                            200, "OK", "application/json; charset=utf-8",
                            body,
                            headers("MISS", "radarx-cloud-relay", latency)
                    );
                }
            }
        } catch (Exception ignored) {
            // Continue with direct Binance upstreams.
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
                        .header("User-Agent", "RadarX-Android/6.8.0")
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


    /**
     * Native gateway for every secondary public market source used by the web
     * core. Relative /api/market and /api/radarx-context routes would otherwise
     * resolve to appassets.androidplatform.net inside the native shell.
     */
    public WebResourceResponse interceptSecondary(Uri uri) {
        if (uri == null) return null;
        String path = uri.getPath();
        if ("/api/market".equals(path)) return interceptMarket(uri);
        if ("/api/radarx-context".equals(path)) return interceptContext(uri);
        if ("/api/radarx-news".equals(path)) return interceptNews(uri);
        if ("/api/radarx-onchain".equals(path)) return interceptOnchain(uri);
        if ("/api/metals".equals(path)) return interceptMetals(uri);
        return null;
    }

    private WebResourceResponse interceptMarket(Uri uri) {
        final String provider = safe(uri.getQueryParameter("provider")).trim();
        final String raw = safe(uri.getQueryParameter("path"));
        if (provider.isEmpty() || raw.isEmpty()) {
            return jsonResponse(400, "{\"error\":\"UNKNOWN_PROVIDER\"}");
        }

        String path;
        try {
            path = Uri.decode(raw);
        } catch (Exception e) {
            path = raw;
        }
        if (!path.startsWith("/") || path.contains("://") || path.contains("\\\\")) {
            return jsonResponse(400, "{\"error\":\"BAD_PATH\"}");
        }

        final String base;
        if ("okx".equals(provider)) {
            if (!path.startsWith("/api/v5/market/") && !path.startsWith("/api/v5/public/")) {
                return jsonResponse(403, "{\"error\":\"PATH_NOT_ALLOWED\"}");
            }
            base = "https://www.okx.com";
        } else if ("bybit".equals(provider)) {
            if (!path.startsWith("/v5/market/")) {
                return jsonResponse(403, "{\"error\":\"PATH_NOT_ALLOWED\"}");
            }
            base = "https://api.bybit.com";
        } else if ("gate".equals(provider)) {
            if (!path.startsWith("/api/v4/spot/")) {
                return jsonResponse(403, "{\"error\":\"PATH_NOT_ALLOWED\"}");
            }
            base = "https://api.gateio.ws";
        } else if ("coinbase".equals(provider)) {
            if (!path.startsWith("/products")) {
                return jsonResponse(403, "{\"error\":\"PATH_NOT_ALLOWED\"}");
            }
            base = "https://api.exchange.coinbase.com";
        } else if ("coingecko".equals(provider)) {
            if (!path.startsWith("/api/v3/")) {
                return jsonResponse(403, "{\"error\":\"PATH_NOT_ALLOWED\"}");
            }
            base = "https://api.coingecko.com";
        } else if ("binanceFutures".equals(provider)) {
            if (!path.startsWith("/fapi/v1/") && !path.startsWith("/futures/data/")) {
                return jsonResponse(403, "{\"error\":\"PATH_NOT_ALLOWED\"}");
            }
            base = "https://fapi.binance.com";
        } else {
            return jsonResponse(400, "{\"error\":\"UNKNOWN_PROVIDER\"}");
        }

        final String key = "secondary:" + provider + ":" + path;
        CacheEntry fresh = getSecondaryCache(key, provider, false);
        if (fresh != null) {
            return response(
                    200, "OK", "application/json; charset=utf-8",
                    fresh.body,
                    headers("HIT", provider, fresh.ageMs)
            );
        }

        // Cloud gateway first: useful on restricted/regional mobile networks.
        try {
            Request cloud = new Request.Builder()
                    .url(REMOTE_RELAY.replace("/api/binance", "/api/market")
                            + "?provider=" + Uri.encode(provider)
                            + "&path=" + Uri.encode(path))
                    .get()
                    .header("Accept", "application/json")
                    .header("User-Agent", "RadarX-Android/6.8.0")
                    .build();
            long started = System.currentTimeMillis();
            try (Response r = client.newCall(cloud).execute()) {
                long latency = System.currentTimeMillis() - started;
                byte[] body = r.body() == null ? new byte[0] : r.body().bytes();
                if (r.isSuccessful() && looksLikeJson(body)) {
                    CacheEntry entry = new CacheEntry(body, System.currentTimeMillis());
                    SECONDARY_CACHE.put(key, entry);
                    trimSecondaryCache();
                    return response(
                            200, "OK", "application/json; charset=utf-8",
                            body, headers("MISS", "radarx-cloud-market", latency)
                    );
                }
            }
        } catch (Exception ignored) {
        }

        // Direct provider fallback.
        try {
            long started = System.currentTimeMillis();
            Request request = new Request.Builder()
                    .url(base + path)
                    .get()
                    .header("Accept", "application/json")
                    .header("User-Agent", "RadarX-Android/6.8.0")
                    .build();
            try (Response r = client.newCall(request).execute()) {
                long latency = System.currentTimeMillis() - started;
                byte[] body = r.body() == null ? new byte[0] : r.body().bytes();
                if (r.isSuccessful() && looksLikeJson(body)) {
                    CacheEntry entry = new CacheEntry(body, System.currentTimeMillis());
                    SECONDARY_CACHE.put(key, entry);
                    trimSecondaryCache();
                    return response(
                            200, "OK", "application/json; charset=utf-8",
                            body, headers("MISS", base, latency)
                    );
                }
                return jsonResponse(r.code(), body.length == 0
                        ? "{\"error\":\"UPSTREAM_UNAVAILABLE\"}"
                        : new String(body, StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            CacheEntry stale = getSecondaryCache(key, provider, true);
            if (stale != null) {
                return response(
                        200, "OK", "application/json; charset=utf-8",
                        stale.body, headers("STALE", provider, stale.ageMs)
                );
            }
            return jsonResponse(502, "{\"error\":\"UPSTREAM_UNAVAILABLE\",\"provider\":\""
                    + jsonEscape(provider) + "\"}");
        }
    }


    private WebResourceResponse interceptOnchain(Uri uri) {
        String q = uri.getQuery();
        String url = "https://radar-x-ai.vercel.app/api/radarx-onchain" + (q == null || q.isEmpty() ? "" : "?" + q);
        try {
            Request req = new Request.Builder()
                    .url(url)
                    .get()
                    .header("Accept", "application/json")
                    .header("User-Agent", "RadarX-Android/6.8.0")
                    .build();
            try (Response r = client.newCall(req).execute()) {
                byte[] body = r.body() == null ? new byte[0] : r.body().bytes();
                if (r.isSuccessful() && looksLikeJson(body)) {
                    return response(200, "OK", "application/json; charset=utf-8",
                            body, headers("MISS", "radarx-onchain-cloud", 0));
                }
                return jsonResponse(r.code(), body.length == 0
                        ? "{\"error\":\"ONCHAIN_SOURCE_UNAVAILABLE\"}"
                        : new String(body, StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) {
            return jsonResponse(502, "{\"error\":\"ONCHAIN_SOURCE_UNAVAILABLE\"}");
        }
    }

    private WebResourceResponse interceptNews(Uri uri) {
        String q = uri.getQuery();
        String url = "https://radar-x-ai.vercel.app/api/radarx-news" + (q == null || q.isEmpty() ? "" : "?" + q);
        try {
            Request req = new Request.Builder()
                    .url(url)
                    .get()
                    .header("Accept", "application/json")
                    .header("User-Agent", "RadarX-Android/6.8.0")
                    .build();
            try (Response r = client.newCall(req).execute()) {
                byte[] body = r.body() == null ? new byte[0] : r.body().bytes();
                if (r.isSuccessful() && looksLikeJson(body)) {
                    return response(200, "OK", "application/json; charset=utf-8",
                            body, headers("MISS", "radarx-news-cloud", 0));
                }
                return jsonResponse(r.code(), body.length == 0
                        ? "{\"error\":\"NEWS_SOURCE_UNAVAILABLE\"}"
                        : new String(body, StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) {
            return jsonResponse(502, "{\"error\":\"NEWS_SOURCE_UNAVAILABLE\"}");
        }
    }

    private WebResourceResponse interceptContext(Uri uri) {
        final String key = "context";
        CacheEntry fresh = getSecondaryCache(key, "context", false);
        if (fresh != null) {
            return response(200, "OK", "application/json; charset=utf-8",
                    fresh.body, headers("HIT", "context-cache", fresh.ageMs));
        }

        // Prefer the deployed RadarX context aggregator because it already
        // normalizes global market data and Fear & Greed sources.
        try {
            Request req = new Request.Builder()
                    .url("https://radar-x-ai.vercel.app/api/radarx-context")
                    .get()
                    .header("Accept", "application/json")
                    .header("User-Agent", "RadarX-Android/6.8.0")
                    .build();
            try (Response r = client.newCall(req).execute()) {
                byte[] body = r.body() == null ? new byte[0] : r.body().bytes();
                if (r.isSuccessful() && looksLikeJson(body)) {
                    SECONDARY_CACHE.put(key, new CacheEntry(body, System.currentTimeMillis()));
                    trimSecondaryCache();
                    return response(200, "OK", "application/json; charset=utf-8",
                            body, headers("MISS", "radarx-context-cloud", 0));
                }
            }
        } catch (Exception ignored) {
        }

        // Minimal no-key fallback: CoinGecko global + Alternative.me F&G.
        Double btcDominance = null;
        Double marketCap = null;
        Double marketCapChange = null;
        Double fearGreed = null;
        String fearGreedLabel = null;
        boolean cgOk = false;
        boolean fgOk = false;

        try {
            Request req = new Request.Builder()
                    .url("https://api.coingecko.com/api/v3/global")
                    .get()
                    .header("Accept", "application/json")
                    .header("User-Agent", "RadarX-Android/6.8.0")
                    .build();
            try (Response r = client.newCall(req).execute()) {
                byte[] body = r.body() == null ? new byte[0] : r.body().bytes();
                if (r.isSuccessful() && looksLikeJson(body)) {
                    JSONObject root = new JSONObject(new String(body, StandardCharsets.UTF_8));
                    JSONObject data = root.optJSONObject("data");
                    if (data != null) {
                        JSONObject pct = data.optJSONObject("market_cap_percentage");
                        JSONObject cap = data.optJSONObject("total_market_cap");
                        btcDominance = pct == null ? null : nullableDouble(pct, "btc");
                        marketCap = cap == null ? null : nullableDouble(cap, "usd");
                        marketCapChange = nullableDouble(data, "market_cap_change_percentage_24h_usd");
                        cgOk = true;
                    }
                }
            }
        } catch (Exception ignored) {
        }

        try {
            Request req = new Request.Builder()
                    .url("https://api.alternative.me/fng/?limit=1")
                    .get()
                    .header("Accept", "application/json")
                    .header("User-Agent", "RadarX-Android/6.8.0")
                    .build();
            try (Response r = client.newCall(req).execute()) {
                byte[] body = r.body() == null ? new byte[0] : r.body().bytes();
                if (r.isSuccessful() && looksLikeJson(body)) {
                    JSONObject root = new JSONObject(new String(body, StandardCharsets.UTF_8));
                    org.json.JSONArray data = root.optJSONArray("data");
                    if (data != null && data.length() > 0) {
                        JSONObject row = data.optJSONObject(0);
                        if (row != null) {
                            fearGreed = nullableDouble(row, "value");
                            fearGreedLabel = row.optString("value_classification", null);
                            fgOk = fearGreed != null;
                        }
                    }
                }
            }
        } catch (Exception ignored) {
        }

        try {
            JSONObject out = new JSONObject();
            out.put("ok", cgOk || fgOk);
            out.put("btcDominance", btcDominance == null ? JSONObject.NULL : btcDominance);
            out.put("totalMarketCapUsd", marketCap == null ? JSONObject.NULL : marketCap);
            out.put("marketCapChange24h", marketCapChange == null ? JSONObject.NULL : marketCapChange);
            out.put("fearGreed", fearGreed == null ? JSONObject.NULL : fearGreed);
            out.put("fearGreedLabel", fearGreedLabel == null ? JSONObject.NULL : fearGreedLabel);
            out.put("availableSources", new org.json.JSONArray()
                    .put(cgOk ? "coingecko" : JSONObject.NULL)
                    .put(fgOk ? "alternative.me" : JSONObject.NULL));
            out.put("sources", new JSONObject()
                    .put("coingecko", cgOk)
                    .put("fearGreed", fgOk));
            byte[] body = out.toString().getBytes(StandardCharsets.UTF_8);
            if (cgOk || fgOk) SECONDARY_CACHE.put(key, new CacheEntry(body, System.currentTimeMillis()));
            return response(200, "OK", "application/json; charset=utf-8",
                    body, headers("MISS", "native-context-fallback", 0));
        } catch (Exception e) {
            return jsonResponse(502, "{\"error\":\"CONTEXT_UNAVAILABLE\"}");
        }
    }

    private WebResourceResponse interceptMetals(Uri uri) {
        final String cloudUrl = "https://radar-x-ai.vercel.app/api/metals"
                + (uri.getQuery() == null ? "" : "?" + uri.getQuery());
        try {
            Request req = new Request.Builder()
                    .url(cloudUrl)
                    .get()
                    .header("Accept", "application/json")
                    .header("User-Agent", "RadarX-Android/6.8.0")
                    .build();
            try (Response r = client.newCall(req).execute()) {
                byte[] body = r.body() == null ? new byte[0] : r.body().bytes();
                if (r.isSuccessful() && looksLikeJson(body)) {
                    return response(200, "OK", "application/json; charset=utf-8",
                            body, headers("MISS", "radarx-metals-cloud", 0));
                }
            }
        } catch (Exception ignored) {
        }
        return jsonResponse(502, "{\"error\":\"METALS_SOURCE_UNAVAILABLE\"}");
    }

    private static Double nullableDouble(JSONObject object, String key) {
        if (object == null || !object.has(key) || object.isNull(key)) return null;
        try {
            return object.getDouble(key);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static final Map<String, Long> SECONDARY_TTLS = new ConcurrentHashMap<>();
    private static final Map<String, CacheEntry> SECONDARY_CACHE = new ConcurrentHashMap<>();

    private static long secondaryTtl(String provider) {
        if ("coingecko".equals(provider)) return 15_000L;
        if ("binanceFutures".equals(provider)) return 2_500L;
        if ("context".equals(provider)) return 12_000L;
        return 3_500L;
    }

    private static CacheEntry getSecondaryCache(String key, String provider, boolean allowStale) {
        CacheEntry entry = SECONDARY_CACHE.get(key);
        if (entry == null) return null;
        long age = System.currentTimeMillis() - entry.ts;
        long ttl = secondaryTtl(provider);
        long staleTtl = Math.max(ttl * 8L, 5_000L);
        if (age <= ttl || (allowStale && age <= staleTtl)) {
            entry.ageMs = age;
            return entry;
        }
        SECONDARY_CACHE.remove(key);
        return null;
    }

    private static void trimSecondaryCache() {
        if (SECONDARY_CACHE.size() <= 240) return;
        int remove = 60;
        for (String key : SECONDARY_CACHE.keySet()) {
            SECONDARY_CACHE.remove(key);
            if (--remove <= 0) break;
        }
    }

    public WebResourceResponse interceptHealth(Uri uri) {
        if (uri == null || !"/api/health".equals(uri.getPath())) return null;

        // Ask the deployed gateway first so the native health panel reports the
        // same real provider status used by the browser deployment.
        try {
            Request cloud = new Request.Builder()
                    .url("https://radar-x-ai.vercel.app/api/health")
                    .get()
                    .header("Accept", "application/json")
                    .header("User-Agent", "RadarX-Android/6.8.0")
                    .build();
            try (Response r = client.newCall(cloud).execute()) {
                byte[] body = r.body() == null ? new byte[0] : r.body().bytes();
                if (r.isSuccessful() && looksLikeJson(body)) {
                    return response(
                            200, "OK", "application/json; charset=utf-8",
                            body, headers("MISS", "radarx-health-cloud", 0)
                    );
                }
            }
        } catch (Exception ignored) {
        }

        int idx = preferred;
        boolean ok = false;
        long latency = 0L;
        String route = "none";
        try {
            long started = System.currentTimeMillis();
            Request request = new Request.Builder()
                    .url(UPSTREAMS[idx] + "/api/v3/ping")
                    .get()
                    .header("Accept", "application/json")
                    .header("User-Agent", "RadarX-Android/6.8.0")
                    .build();
            try (Response r = client.newCall(request).execute()) {
                latency = System.currentTimeMillis() - started;
                ok = r.isSuccessful();
                if (ok) route = UPSTREAMS[idx];
                mark(idx, ok, latency);
            }
        } catch (Exception ignored) {
            mark(idx, false, 0L);
        }

        long checkedAt = System.currentTimeMillis();
        String root = "{\"ok\":true,\"checkedAt\":" + checkedAt
                + ",\"durationMs\":" + latency
                + ",\"total\":1,\"online\":" + (ok ? 1 : 0)
                + ",\"cryptoOnline\":" + (ok ? 1 : 0)
                + ",\"results\":[{\"id\":\"binance\",\"label\":\"Binance Spot\","
                + "\"family\":\"crypto\",\"ok\":" + ok
                + ",\"latencyMs\":" + latency
                + ",\"checkedAt\":" + checkedAt
                + ",\"hasData\":" + ok
                + ",\"route\":\"" + jsonEscape(route) + "\"}]}";
        return response(
                200, "OK", "application/json; charset=utf-8",
                root.getBytes(StandardCharsets.UTF_8),
                headers("LOCAL", "native-binance-ping", 0)
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

    private static boolean looksLikeJson(byte[] body) {
        if (body == null || body.length == 0) return false;
        String s = new String(body, StandardCharsets.UTF_8).trim();
        return s.startsWith("{") || s.startsWith("[");
    }

    private static String jsonEscape(String value) {
        return String.valueOf(value)
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\r", "\\r")
                .replace("\n", "\\n");
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
