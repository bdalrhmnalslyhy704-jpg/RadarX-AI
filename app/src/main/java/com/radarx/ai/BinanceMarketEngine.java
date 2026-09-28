package com.radarx.ai;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

public final class BinanceMarketEngine {
    public static final String[] SYMBOLS = {
            "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT",
            "XRPUSDT", "DOGEUSDT", "ADAUSDT", "LINKUSDT",
            "SUIUSDT", "XLMUSDT", "STXUSDT", "WAXPUSDT"
    };

    public enum State {
        STOPPED,
        CONNECTING,
        LIVE,
        DEGRADED,
        OFFLINE
    }

    public static final class Snapshot {
        public final String symbol;
        public final double lastTrade;
        public final double bid;
        public final double ask;
        public final double dayChangePercent;
        public final double quoteVolume;
        public final long eventTimeMs;
        public final long receivedAtMs;
        public final long updateCount;
        public final int reconnectCount;
        public final boolean bootstrap;

        Snapshot(
                String symbol,
                double lastTrade,
                double bid,
                double ask,
                double dayChangePercent,
                double quoteVolume,
                long eventTimeMs,
                long receivedAtMs,
                long updateCount,
                int reconnectCount,
                boolean bootstrap
        ) {
            this.symbol = symbol;
            this.lastTrade = lastTrade;
            this.bid = bid;
            this.ask = ask;
            this.dayChangePercent = dayChangePercent;
            this.quoteVolume = quoteVolume;
            this.eventTimeMs = eventTimeMs;
            this.receivedAtMs = receivedAtMs;
            this.updateCount = updateCount;
            this.reconnectCount = reconnectCount;
            this.bootstrap = bootstrap;
        }

        public long latencyMs() {
            if (eventTimeMs <= 0L || receivedAtMs <= 0L) return -1L;
            return Math.max(0L, receivedAtMs - eventTimeMs);
        }

        public double mid() {
            if (bid > 0.0 && ask > 0.0) return (bid + ask) * 0.5;
            return lastTrade;
        }

        public double spread() {
            if (bid <= 0.0 || ask <= 0.0) return 0.0;
            return Math.max(0.0, ask - bid);
        }
    }

    private static final class Quote {
        final String symbol;
        volatile double lastTrade;
        volatile double bid;
        volatile double ask;
        volatile double dayChangePercent;
        volatile double quoteVolume;
        volatile long eventTimeMs;
        volatile long receivedAtMs;

        Quote(String symbol) {
            this.symbol = symbol;
        }
    }

    public interface Listener {
        void onSnapshot(Snapshot snapshot);
        void onState(State state, String detail);
    }

    private static final String REST_URL =
            "https://api.binance.com/api/v3/ticker/24hr"
                    + "?symbols=%5B%22BTCUSDT%22%2C%22ETHUSDT%22%2C%22BNBUSDT%22%2C%22SOLUSDT%22"
                    + "%2C%22XRPUSDT%22%2C%22DOGEUSDT%22%2C%22ADAUSDT%22%2C%22LINKUSDT%22"
                    + "%2C%22SUIUSDT%22%2C%22XLMUSDT%22%2C%22STXUSDT%22%2C%22WAXPUSDT%22%5D";

    private static final String WS_URL = buildWsUrl();

    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(10L, TimeUnit.SECONDS)
            .readTimeout(0L, TimeUnit.MILLISECONDS)
            .writeTimeout(10L, TimeUnit.SECONDS)
            .pingInterval(20L, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build();

    private final ScheduledExecutorService scheduler =
            Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "RadarX-Market");
                t.setDaemon(true);
                return t;
            });

    private final ConcurrentHashMap<String, Quote> quotes = new ConcurrentHashMap<>();

    private volatile Listener listener;
    private volatile boolean running;
    private volatile boolean networkAvailable = true;

    private final Object socketLock = new Object();
    private WebSocket socket;
    private long socketGeneration;
    private int reconnectAttempt;
    private int reconnectCount;
    private long updateCount;
    private ScheduledFuture<?> reconnectFuture;

    public BinanceMarketEngine() {
        for (String symbol : SYMBOLS) {
            quotes.put(symbol, new Quote(symbol));
        }
    }

    public void setListener(Listener listener) {
        this.listener = listener;
    }

    public void setNetworkAvailable(boolean available) {
        networkAvailable = available;
        if (!available) {
            closeSocket(false);
            emitState(State.OFFLINE, "الشبكة غير متاحة");
            return;
        }
        if (running) {
            scheduleReconnect(250L);
        }
    }

    public void start() {
        if (running) return;
        running = true;
        reconnectAttempt = 0;
        reconnectCount = 0;
        updateCount = 0L;

        emitState(networkAvailable ? State.CONNECTING : State.OFFLINE,
                networkAvailable ? "تهيئة 12 زوجًا عبر قناة واحدة..." : "بانتظار الشبكة...");

        bootstrapRest();
        if (networkAvailable) connectNow();
    }

    public void stop() {
        running = false;
        if (reconnectFuture != null) {
            reconnectFuture.cancel(false);
            reconnectFuture = null;
        }
        closeSocket(true);
        emitState(State.STOPPED, "تم إيقاف الاتصال");
    }

    public void destroy() {
        stop();
        client.dispatcher().executorService().shutdown();
        client.connectionPool().evictAll();
        scheduler.shutdownNow();
    }

    private void bootstrapRest() {
        Request request = new Request.Builder()
                .url(REST_URL)
                .header("Cache-Control", "no-cache")
                .get()
                .build();

        client.newCall(request).enqueue(new Callback() {
            @Override public void onFailure(Call call, IOException e) {
                if (running) {
                    emitState(networkAvailable ? State.DEGRADED : State.OFFLINE,
                            "لقطة البداية تعذرت؛ ننتظر القناة الحية");
                }
            }

            @Override public void onResponse(Call call, Response response) throws IOException {
                try (Response r = response) {
                    if (!r.isSuccessful() || r.body() == null) {
                        if (running) emitState(State.DEGRADED, "تعذر الحصول على لقطة السوق");
                        return;
                    }

                    String body = r.body().string();
                    JSONArray array = new JSONArray(body);
                    for (int i = 0; i < array.length(); i++) {
                        JSONObject item = array.optJSONObject(i);
                        if (item == null) continue;

                        String symbol = item.optString("symbol", "").toUpperCase(Locale.US);
                        Quote q = quotes.get(symbol);
                        if (q == null) continue;

                        q.lastTrade = positive(item.optDouble("lastPrice", 0.0));
                        q.dayChangePercent = finite(item.optDouble("priceChangePercent", 0.0));
                        q.quoteVolume = positive(item.optDouble("quoteVolume", 0.0));
                        q.receivedAtMs = System.currentTimeMillis();

                        emitSnapshot(true, q);
                    }
                } catch (Exception e) {
                    if (running) emitState(State.DEGRADED, "لقطة السوق غير قابلة للقراءة");
                }
            }
        });
    }

    private void connectNow() {
        if (!running || !networkAvailable) return;

        final long generation;
        synchronized (socketLock) {
            generation = ++socketGeneration;
            if (socket != null) {
                socket.cancel();
                socket = null;
            }
        }

        emitState(State.CONNECTING,
                reconnectAttempt == 0
                        ? "فتح WebSocket واحد لـ 12 زوجًا..."
                        : "إعادة فتح قناة السوق...");

        Request request = new Request.Builder()
                .url(WS_URL)
                .header("Cache-Control", "no-cache")
                .build();

        WebSocket newSocket = client.newWebSocket(request, new WebSocketListener() {
            @Override public void onOpen(WebSocket webSocket, Response response) {
                if (!isCurrent(generation) || !running) {
                    webSocket.close(1000, "stale");
                    return;
                }

                synchronized (socketLock) {
                    socket = webSocket;
                }
                reconnectAttempt = 0;
                emitState(State.LIVE, "12 زوجًا حيًا • WebSocket واحد");
            }

            @Override public void onMessage(WebSocket webSocket, String text) {
                if (!isCurrent(generation) || !running) return;
                handleMessage(text);
            }

            @Override public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                if (!isCurrent(generation) || !running) return;
                synchronized (socketLock) {
                    if (socket == webSocket) socket = null;
                }
                reconnectCount++;
                emitState(networkAvailable ? State.DEGRADED : State.OFFLINE,
                        networkAvailable
                                ? "انقطاع القناة؛ إعادة اتصال تلقائية"
                                : "القناة متوقفة حتى عودة الشبكة");
                scheduleReconnect(networkAvailable ? backoffMs() : 0L);
            }

            @Override public void onClosed(WebSocket webSocket, int code, String reason) {
                if (!isCurrent(generation) || !running) return;
                synchronized (socketLock) {
                    if (socket == webSocket) socket = null;
                }
                reconnectCount++;
                emitState(networkAvailable ? State.DEGRADED : State.OFFLINE,
                        networkAvailable
                                ? "القناة أُغلقت؛ إعادة اتصال تلقائية"
                                : "القناة مغلقة حتى عودة الشبكة");
                scheduleReconnect(networkAvailable ? backoffMs() : 0L);
            }
        });

        synchronized (socketLock) {
            if (generation == socketGeneration && running) {
                socket = newSocket;
            } else {
                newSocket.cancel();
            }
        }
    }

    private void handleMessage(String raw) {
        try {
            JSONObject root = new JSONObject(raw);
            JSONObject data = root.has("data") && root.opt("data") instanceof JSONObject
                    ? root.getJSONObject("data") : root;

            String eventType = data.optString("e", "");
            String symbol = data.optString("s", "").toUpperCase(Locale.US);
            Quote q = quotes.get(symbol);
            if (q == null) return;

            long received = System.currentTimeMillis();
            long event = data.optLong("E", received);

            if ("trade".equals(eventType)) {
                double price = positive(data.optDouble("p", 0.0));
                if (price > 0.0) q.lastTrade = price;
            } else if ("bookTicker".equals(eventType)) {
                double nextBid = positive(data.optDouble("b", 0.0));
                double nextAsk = positive(data.optDouble("a", 0.0));
                if (nextBid > 0.0) q.bid = nextBid;
                if (nextAsk > 0.0) q.ask = nextAsk;
            } else {
                return;
            }

            q.eventTimeMs = event;
            q.receivedAtMs = received;
            updateCount++;
            emitSnapshot(false, q);
        } catch (Exception ignored) {
            // A malformed market frame is ignored without touching the socket.
        }
    }

    private void emitSnapshot(boolean bootstrap, Quote q) {
        Listener l = listener;
        if (l == null) return;

        Snapshot snapshot = new Snapshot(
                q.symbol,
                finite(q.lastTrade),
                finite(q.bid),
                finite(q.ask),
                finite(q.dayChangePercent),
                finite(q.quoteVolume),
                q.eventTimeMs,
                q.receivedAtMs,
                updateCount,
                reconnectCount,
                bootstrap
        );
        l.onSnapshot(snapshot);
    }

    private void scheduleReconnect(long requestedDelayMs) {
        if (!running || !networkAvailable) return;
        if (reconnectFuture != null && !reconnectFuture.isDone()) return;

        reconnectAttempt = Math.min(reconnectAttempt + 1, 8);
        long delay = Math.max(requestedDelayMs, backoffMs());
        long jitter = ThreadLocalRandom.current().nextLong(0L, 350L);

        reconnectFuture = scheduler.schedule(() -> {
            reconnectFuture = null;
            if (running && networkAvailable) connectNow();
        }, delay + jitter, TimeUnit.MILLISECONDS);
    }

    private long backoffMs() {
        int shift = Math.max(0, Math.min(6, reconnectAttempt - 1));
        return Math.min(30000L, 1000L * (1L << shift));
    }

    private void closeSocket(boolean userStop) {
        synchronized (socketLock) {
            socketGeneration++;
            if (socket != null) {
                socket.close(1000, userStop ? "user_stop" : "network_lost");
                socket = null;
            }
        }
    }

    private boolean isCurrent(long generation) {
        synchronized (socketLock) {
            return generation == socketGeneration;
        }
    }

    private void emitState(State state, String detail) {
        Listener l = listener;
        if (l != null) l.onState(state, detail);
    }

    private static String buildWsUrl() {
        StringBuilder streams = new StringBuilder();
        for (String symbol : SYMBOLS) {
            if (streams.length() > 0) streams.append("/");
            String lower = symbol.toLowerCase(Locale.US);
            streams.append(lower).append("@trade/");
            streams.append(lower).append("@bookTicker");
        }
        return "wss://stream.binance.com:9443/stream?streams=" + streams;
    }

    private static double positive(double value) {
        return Double.isFinite(value) && value > 0.0 ? value : 0.0;
    }

    private static double finite(double value) {
        return Double.isFinite(value) ? value : 0.0;
    }
}
