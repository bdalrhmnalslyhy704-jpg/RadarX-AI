package com.radarx.ai;

import android.net.Uri;
import android.webkit.WebResourceResponse;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
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
    private final OkHttpClient bulkClient;
    private final ExecutorService bulkExecutor = Executors.newFixedThreadPool(8);
    private final ExecutorService bulkHttpExecutor = Executors.newFixedThreadPool(32);
    private final EndpointHealth[] health;
    private volatile int preferred = 0;

    public BinanceSecureRelay(OkHttpClient client) {
        this.client = client;
        this.bulkClient = client.newBuilder().callTimeout(3500, TimeUnit.MILLISECONDS).build();
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
                    .header("User-Agent", "RadarX-Android/6.8.1")
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
                        .header("User-Agent", "RadarX-Android/6.8.1")
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
        if ("/api/radarx-smart".equals(path)) return interceptSmartBulk(uri, false);
        if ("/api/radarx-smart-deep".equals(path)) return interceptSmartBulk(uri, true);
        if ("/api/radarx-context".equals(path)) return interceptContext(uri);
        if ("/api/radarx-news".equals(path)) return interceptNews(uri);
        if ("/api/radarx-onchain".equals(path)) return interceptOnchain(uri);
        if ("/api/radarx-social".equals(path)) return interceptSocial(uri);
        if ("/api/metals".equals(path)) return interceptMetals(uri);
        return null;
    }

    private WebResourceResponse interceptSmartBulk(Uri uri, boolean deep) {
        String raw = uri.getQueryParameter("symbols");
        if (raw == null || raw.trim().isEmpty()) {
            return jsonResponse(400, "{\"ok\":false,\"error\":\"NO_SYMBOLS\"}");
        }
        String[] parts = raw.split(",");
        List<String> symbols = new ArrayList<>();
        for (String part : parts) {
            String sym = cleanSymbol(part);
            if (!sym.isEmpty() && sym.endsWith("USDT") && sym.length() >= 6 && sym.length() <= 24
                    && !sym.matches("^(USDC|USDP|FDUSD|TUSD|DAI|USDE|USDS|BUSD)USDT$")
                    && !sym.matches(".*(UP|DOWN|BULL|BEAR)USDT$") && !symbols.contains(sym)) {
                symbols.add(sym);
            }
        }
        int max = deep ? 8 : 40;
        if (symbols.size() > max) symbols = new ArrayList<>(symbols.subList(0, max));
        if (symbols.isEmpty()) {
            return jsonResponse(400, "{\"ok\":false,\"error\":\"NO_VALID_SYMBOLS\"}");
        }

        final List<String> finalSymbols = symbols;
        try {
            JSONObject root = new JSONObject();
            root.put("ok", true);
            root.put("provider", "binance");
            root.put("source", "native-binance-bulk");
            root.put("checkedAt", System.currentTimeMillis());
            JSONObject bySymbol = new JSONObject();

            if (!deep) {
                List<Future<BulkResult>> futures = new ArrayList<>();
                for (String sym : finalSymbols) {
                    futures.add(bulkExecutor.submit(() -> {
                        byte[] r1 = bulkFetch("/api/v3/klines?symbol=" + Uri.encode(sym) + "&interval=1m&limit=96");
                        byte[] r5 = bulkFetch("/api/v3/klines?symbol=" + Uri.encode(sym) + "&interval=5m&limit=144");
                        if (r1 == null || r5 == null) return null;
                        JSONObject item = new JSONObject();
                        item.put("symbol", sym);
                        item.put("rows1m", normalizeKlines(r1));
                        item.put("rows5m", normalizeKlines(r5));
                        return new BulkResult(sym, item);
                    }));
                }
                for (Future<BulkResult> future : futures) {
                    try {
                        BulkResult result = future.get(5000, TimeUnit.MILLISECONDS);
                        if (result != null) bySymbol.put(result.symbol, result.value);
                    } catch (Exception ignored) {
                    }
                }
            } else {
                List<Future<BulkResult>> futures = new ArrayList<>();
                for (String sym : finalSymbols) {
                    futures.add(bulkExecutor.submit(() -> {
                        Future<byte[]> fd = bulkHttpExecutor.submit(() -> bulkFetch("/api/v3/depth?symbol=" + Uri.encode(sym) + "&limit=100"));
                        Future<byte[]> ft = bulkHttpExecutor.submit(() -> bulkFetch("/api/v3/aggTrades?symbol=" + Uri.encode(sym) + "&limit=500"));
                        Future<byte[]> f15 = bulkHttpExecutor.submit(() -> bulkFetch("/api/v3/klines?symbol=" + Uri.encode(sym) + "&interval=15m&limit=90"));
                        Future<byte[]> f1h = bulkHttpExecutor.submit(() -> bulkFetch("/api/v3/klines?symbol=" + Uri.encode(sym) + "&interval=1h&limit=90"));
                        byte[] depth = fd.get(4500, TimeUnit.MILLISECONDS);
                        byte[] trades = ft.get(4500, TimeUnit.MILLISECONDS);
                        byte[] rows15 = f15.get(4500, TimeUnit.MILLISECONDS);
                        byte[] rows1h = f1h.get(4500, TimeUnit.MILLISECONDS);
                        if (depth == null || trades == null || rows15 == null || rows1h == null) return null;
                        JSONObject item = new JSONObject();
                        item.put("symbol", sym);
                        item.put("depth", normalizeDepth(depth));
                        item.put("trades", normalizeTrades(trades));
                        item.put("rows15m", normalizeKlines(rows15));
                        item.put("rows1h", normalizeKlines(rows1h));
                        return new BulkResult(sym, item);
                    }));
                }
                for (Future<BulkResult> future : futures) {
                    try {
                        BulkResult result = future.get(10000, TimeUnit.MILLISECONDS);
                        if (result != null) bySymbol.put(result.symbol, result.value);
                    } catch (Exception ignored) {
                    }
                }
            }

            root.put("returned", bySymbol.length());
            root.put("requested", finalSymbols.size());
            root.put("bySymbol", bySymbol);
            return response(200, "OK", "application/json; charset=utf-8",
                    root.toString().getBytes(StandardCharsets.UTF_8),
                    headers("BULK", "native-binance-bulk", 0));
        } catch (Exception e) {
            return jsonResponse(502, "{\"ok\":false,\"error\":\"SMART_BULK_FAILED\"}");
        }
    }

    private byte[] bulkFetch(String path) {
        for (int index : orderedIndexes()) {
            try {
                Request req = new Request.Builder()
                        .url(UPSTREAMS[index] + path)
                        .get()
                        .header("Accept", "application/json")
                        .header("User-Agent", "RadarX-Android/6.9.1")
                        .build();
                try (Response r = bulkClient.newCall(req).execute()) {
                    byte[] body = r.body() == null ? new byte[0] : r.body().bytes();
                    if (r.isSuccessful() && looksLikeJson(body)) {
                        mark(index, true, 0L);
                        return body;
                    }
                    mark(index, false, 0L);
                }
            } catch (Exception ignored) {
                mark(index, false, 0L);
            }
        }
        return null;
    }

    private static String cleanSymbol(String s) {
        return s == null ? "" : s.trim().toUpperCase().replaceAll("[^A-Z0-9]", "");
    }

    private static JSONArray normalizeKlines(byte[] body) throws Exception {
        JSONArray raw = new JSONArray(new String(body, StandardCharsets.UTF_8));
        JSONArray out = new JSONArray();
        long now = System.currentTimeMillis();
        for (int i = 0; i < raw.length(); i++) {
            JSONArray r = raw.optJSONArray(i);
            if (r == null || r.length() < 10) continue;
            JSONObject x = new JSONObject();
            x.put("t", r.optLong(0));
            x.put("o", r.optDouble(1));
            x.put("h", r.optDouble(2));
            x.put("l", r.optDouble(3));
            x.put("c", r.optDouble(4));
            x.put("v", r.optDouble(5));
            x.put("q", r.optDouble(7));
            x.put("trades", r.optLong(8));
            x.put("tb", r.optDouble(9));
            x.put("closed", r.optLong(6) <= now);
            out.put(x);
        }
        return out;
    }

    private static JSONObject normalizeDepth(byte[] body) throws Exception {
        JSONObject raw = new JSONObject(new String(body, StandardCharsets.UTF_8));
        JSONObject out = new JSONObject();
        out.put("bids", normalizeLevels(raw.optJSONArray("bids")));
        out.put("asks", normalizeLevels(raw.optJSONArray("asks")));
        return out;
    }

    private static JSONArray normalizeLevels(JSONArray raw) {
        JSONArray out = new JSONArray();
        if (raw == null) return out;
        for (int i = 0; i < raw.length(); i++) {
            JSONArray r = raw.optJSONArray(i);
            if (r == null || r.length() < 2) continue;
            JSONArray x = new JSONArray();
            x.put(r.optDouble(0));
            x.put(r.optDouble(1));
            out.put(x);
        }
        return out;
    }

    private static JSONArray normalizeTrades(byte[] body) throws Exception {
        JSONArray raw = new JSONArray(new String(body, StandardCharsets.UTF_8));
        JSONArray out = new JSONArray();
        for (int i = 0; i < raw.length(); i++) {
            JSONObject r = raw.optJSONObject(i);
            if (r == null) continue;
            JSONObject x = new JSONObject();
            x.put("id", r.optLong("a"));
            x.put("price", r.optDouble("p"));
            x.put("amount", r.optDouble("q"));
            x.put("buy", !r.optBoolean("m"));
            x.put("t", r.optLong("T"));
            out.put(x);
        }
        return out;
    }

    private static final class BulkResult {
        final String symbol;
        final JSONObject value;
        BulkResult(String symbol, JSONObject value) {
            this.symbol = symbol;
            this.value = value;
        }
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
                    .header("User-Agent", "RadarX-Android/6.8.1")
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
                    .header("User-Agent", "RadarX-Android/6.8.1")
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


    private WebResourceResponse interceptSocial(Uri uri) {
        String q = uri.getQuery();
        String url = "https://radar-x-ai.vercel.app/api/radarx-social" + (q == null || q.isEmpty() ? "" : "?" + q);
        try {
            Request req = new Request.Builder()
                    .url(url)
                    .get()
                    .header("Accept", "application/json")
                    .header("User-Agent", "RadarX-Android/6.8.1")
                    .build();
            try (Response r = client.newCall(req).execute()) {
                byte[] body = r.body() == null ? new byte[0] : r.body().bytes();
                if (r.isSuccessful() && looksLikeJson(body)) {
                    return response(200, "OK", "application/json; charset=utf-8",
                            body, headers("MISS", "radarx-social-cloud", 0));
                }
                return jsonResponse(r.code(), body.length == 0
                        ? "{\"error\":\"SOCIAL_SOURCE_UNAVAILABLE\"}"
                        : new String(body, StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) {
            return jsonResponse(502, "{\"error\":\"SOCIAL_SOURCE_UNAVAILABLE\"}");
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
                    .header("User-Agent", "RadarX-Android/6.8.1")
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
                    .header("User-Agent", "RadarX-Android/6.8.1")
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
                    .header("User-Agent", "RadarX-Android/6.8.1")
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
                    .header("User-Agent", "RadarX-Android/6.8.1")
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
                    .header("User-Agent", "RadarX-Android/6.8.1")
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
                    .header("User-Agent", "RadarX-Android/6.8.1")
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
                    .header("User-Agent", "RadarX-Android/6.8.1")
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
                    .header("User-Agent", "RadarX-Android/6.8.1")
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
