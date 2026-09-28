package com.radarx.ai;

import android.net.Uri;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

public final class NativeBinanceStreamHub {
    private static final String[] BASES = {
            "wss://data-stream.binance.vision/stream",
            "wss://stream.binance.com:9443/stream",
            "wss://stream.binance.com:443/stream",
            "wss://stream.binance.com/stream"
    };

    private final OkHttpClient client;
    private final Map<String, Slot> slots = new ConcurrentHashMap<>();
    private final ConcurrentLinkedQueue<Event> events = new ConcurrentLinkedQueue<>();
    // !miniTicker@arr is a full-market snapshot. Keeping every snapshot in the
    // queue causes large JSON bursts on mobile. Retain only the newest ticker
    // snapshot; selected-symbol streams keep their event-by-event semantics.
    private final Map<String, Event> latestSnapshots = new ConcurrentHashMap<>();
    private final ScheduledExecutorService scheduler;

    public NativeBinanceStreamHub(OkHttpClient client) {
        this.client = client;
        this.scheduler = Executors.newSingleThreadScheduledExecutor(new DaemonFactory());
        this.scheduler.scheduleAtFixedRate(this::watchdog, 10, 10, TimeUnit.SECONDS);
    }

    public boolean start(String id, String streams) {
        if (id == null || id.trim().isEmpty() || streams == null || streams.trim().isEmpty()) {
            return false;
        }
        stop(id);
        Slot slot = new Slot(id.trim(), streams.trim());
        slots.put(slot.id, slot);
        connect(slot, 0);
        return true;
    }

    public void stop(String id) {
        if (id == null) return;
        Slot slot = slots.remove(id);
        if (slot != null) {
            slot.stopped = true;
            WebSocket ws = slot.ws;
            if (ws != null) {
                try { ws.close(1000, "RadarX stop"); } catch (Exception ignored) {}
            }
            latestSnapshots.remove(id);
            emit(id, "stopped", "");
        }
    }

    public void stopAll() {
        for (String id : slots.keySet()) stop(id);
        scheduler.shutdownNow();
        events.clear();
        latestSnapshots.clear();
    }

    public String pollJson(int max) {
        int limit = Math.max(1, Math.min(40, max));
        StringBuilder out = new StringBuilder("[");
        int count = 0;
        while (count < limit) {
            Event e = events.poll();
            if (e == null) break;
            if (count++ > 0) out.append(',');
            out.append("{\"id\":\"").append(escape(e.id))
                    .append("\",\"type\":\"").append(escape(e.type))
                    .append("\",\"ts\":").append(e.ts)
                    .append(",\"message\":");
            out.append('"').append(escape(e.payload)).append('"');
            out.append('}');
        }
        // A market-wide ticker snapshot is a replaceable state, not an event
        // stream. Emit at most one latest snapshot per poll cycle.
        if (count < limit) {
            Event snapshot = latestSnapshots.remove("ticker");
            if (snapshot != null) {
                if (count++ > 0) out.append(',');
                out.append("{\"id\":\"").append(escape(snapshot.id))
                        .append("\",\"type\":\"").append(escape(snapshot.type))
                        .append("\",\"ts\":").append(snapshot.ts)
                        .append(",\"message\":\"").append(escape(snapshot.payload)).append("\"}");
            }
        }
        out.append(']');
        return out.toString();
    }

    private void connect(final Slot slot, final int attempt) {
        if (slot.stopped || slots.get(slot.id) != slot) return;

        int baseIndex = Math.floorMod(attempt, BASES.length);
        String url = BASES[baseIndex] + "?streams=" + Uri.encode(slot.streams);

        Request request = new Request.Builder()
                .url(url)
                .header("Accept", "application/json")
                .header("User-Agent", "RadarX-Android/6.8.1")
                .build();

        try {
            slot.lastConnectAttempt = System.currentTimeMillis();
            slot.ws = client.newWebSocket(request, new WebSocketListener() {
                @Override public void onOpen(WebSocket webSocket, Response response) {
                    if (!isCurrent(slot)) {
                        webSocket.close(1000, "stale");
                        return;
                    }
                    slot.attempt = 0;
                    slot.lastMessage = System.currentTimeMillis();
                    slot.open = true;
                    emit(slot.id, "open", "base=" + BASES[baseIndex]);
                }

                @Override public void onMessage(WebSocket webSocket, String text) {
                    if (!isCurrent(slot)) return;
                    slot.open = true;
                    slot.lastMessage = System.currentTimeMillis();
                    if ("ticker".equals(slot.id)) {
                        latestSnapshots.put("ticker", new Event(slot.id, "message", text));
                    } else {
                        emit(slot.id, "message", text);
                    }
                }

                @Override public void onClosing(WebSocket webSocket, int code, String reason) {
                    if (isCurrent(slot)) emit(slot.id, "closing", reason == null ? "" : reason);
                }

                @Override public void onClosed(WebSocket webSocket, int code, String reason) {
                    if (!isCurrent(slot)) return;
                    slot.open = false;
                    slot.ws = null;
                    emit(slot.id, "close", "code=" + code + ";reason=" + (reason == null ? "" : reason));
                    scheduleReconnect(slot);
                }

                @Override public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                    if (!isCurrent(slot)) return;
                    slot.open = false;
                    slot.ws = null;
                    String message = t == null ? "WS_FAILURE"
                            : String.valueOf(t.getMessage());
                    emit(slot.id, "error", message == null ? "WS_FAILURE" : message);
                    scheduleReconnect(slot);
                }
            });
        } catch (Exception e) {
            slot.ws = null;
            slot.open = false;
            emit(slot.id, "error", String.valueOf(e.getMessage()));
            scheduleReconnect(slot);
        }
    }

    private void scheduleReconnect(Slot slot) {
        if (!isCurrent(slot)) return;
        int attempt = Math.min(slot.attempt + 1, 12);
        slot.attempt = attempt;
        long delay = Math.min(60_000L, 1_500L + (long) Math.pow(2, Math.min(attempt, 6)) * 500L);
        scheduler.schedule(() -> connect(slot, attempt), delay, TimeUnit.MILLISECONDS);
    }

    private void watchdog() {
        long now = System.currentTimeMillis();
        for (Slot slot : slots.values()) {
            if (slot.stopped) continue;
            if (slot.open && slot.lastMessage > 0 && now - slot.lastMessage > 30_000L) {
                emit(slot.id, "watchdog", "silent_for_ms=" + (now - slot.lastMessage));
                slot.open = false;
                WebSocket ws = slot.ws;
                slot.ws = null;
                if (ws != null) {
                    try { ws.close(1001, "silent watchdog"); } catch (Exception ignored) {}
                }
                scheduleReconnect(slot);
            }
        }
    }

    private boolean isCurrent(Slot slot) {
        return !slot.stopped && slots.get(slot.id) == slot;
    }

    private void emit(String id, String type, String payload) {
        if (events.size() >= 400) events.poll();
        events.offer(new Event(id, type, payload == null ? "" : payload));
    }

    private static String escape(String value) {
        return String.valueOf(value)
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\r", "\\r")
                .replace("\n", "\\n");
    }

    private static final class Slot {
        final String id;
        final String streams;
        volatile WebSocket ws;
        volatile boolean stopped;
        volatile boolean open;
        volatile long lastMessage;
        volatile long lastConnectAttempt;
        volatile int attempt;

        Slot(String id, String streams) {
            this.id = id;
            this.streams = streams;
        }
    }

    private static final class Event {
        final String id;
        final String type;
        final String payload;
        final long ts = System.currentTimeMillis();

        Event(String id, String type, String payload) {
            this.id = id;
            this.type = type;
            this.payload = payload;
        }
    }

    private static final class DaemonFactory implements ThreadFactory {
        @Override public Thread newThread(Runnable r) {
            Thread t = new Thread(r, "RadarX-Binance-WS");
            t.setDaemon(true);
            return t;
        }
    }
}
