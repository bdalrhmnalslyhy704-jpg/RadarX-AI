package com.radarx.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.os.Build;
import android.os.IBinder;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.DecimalFormat;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.Locale;

public final class RadarXBackgroundMonitorService extends Service {
    public static final String ACTION_START = "com.radarx.app.action.START_BACKGROUND_MONITOR";
    public static final String ACTION_STOP = "com.radarx.app.action.STOP_BACKGROUND_MONITOR";

    private static final String TAG = "RadarXBackground";
    private static final String BACKEND_RADAR_ALERTS =
            "https://radarx-ai-triple-production.up.railway.app/api/radar-alerts?radar=ALL&limit=50";
    private static final String BACKEND_RADAR_ALERTS_FALLBACK =
            "https://radarx-ai-production.up.railway.app/api/radar-alerts?radar=ALL&limit=50";
    private static final String BACKEND_FALCON_ALERTS =
            "https://radarx-ai-triple-production.up.railway.app/api/falcon-eye-radar";
    private static final String BACKEND_FALCON_ALERTS_FALLBACK =
            "https://radarx-ai-production.up.railway.app/api/falcon-eye-radar";
    // Compatibility routes kept as immutable read-only references; active polling uses the unified feed above.
    private static final String BACKEND_MOVE_RADAR =
            "https://radarx-ai-triple-production.up.railway.app/api/move-radar?quote=USDT&limit=50";
    private static final String BACKEND_STRONG_MOVE_RADAR =
            "https://radarx-ai-triple-production.up.railway.app/api/strong-move-radar?quote=USDT&limit=50";
    private static final String BACKEND_ROTATION_RADAR =
            "https://radarx-ai-triple-production.up.railway.app/api/rotation-radar?quote=USDT&limit=50";

    // Legacy per-radar cursor key retained for migration/backward-compatible local state.
    private static final String ROTATION_ALERT_CURSOR_KEY = "rotation_alert_cursor_at";

    private static final String CHANNEL_STATUS = "radarx_background_status";
    private static final String CHANNEL_ALERTS = "radarx_move_alerts";
    private static final String CHANNEL_STRONG_ALERTS = "radarx_strong_move_alerts";
    private static final String CHANNEL_ROTATION_ALERTS = "radarx_rotation_alerts";
    private static final String CHANNEL_RADAR_ALERTS = "radarx_radar_alerts_v2";
    private static final int STATUS_NOTIFICATION_ID = 41001;
    private static final int ALERT_NOTIFICATION_BASE = 42000;
    private static final int STRONG_ALERT_NOTIFICATION_BASE = 43000;
    private static final int ROTATION_ALERT_NOTIFICATION_BASE = 44000;
    private static final long SCAN_MS = 15_000L;
    private static final String PENDING_ALERTS_KEY = "radar_alert_pending_json";
    private static final String FALCON_CURSOR_KEY = "falcon_eye_alert_cursor_at";
    private static final int MAX_PENDING_ALERTS = 300;

    private ScheduledExecutorService executor;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback connectivityCallback;
    private volatile boolean stopping;
    private volatile boolean loggedFirstScan;
    private volatile boolean offlineLogged;
    private final DecimalFormat scoreFmt = new DecimalFormat("0.0");
    private final DecimalFormat priceFmt = new DecimalFormat("0.################", java.text.DecimalFormatSymbols.getInstance(Locale.US));

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        executor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "RadarX-Background");
            t.setDaemon(true);
            return t;
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (ACTION_STOP.equals(intent != null ? intent.getAction() : null)) {
            stopMonitoring();
            return START_NOT_STICKY;
        }

        if (stopping) {
            stopping = false;
        }

        try {
            startAsForeground();
        } catch (Throwable error) {
            Log.e(TAG, "Foreground service failed", error);
            saveRunning(false);
            stopSelf();
            return START_NOT_STICKY;
        }

        registerConnectivityCallback();
        try {
            scheduleScan();
        } catch (Throwable error) {
            Log.e(TAG, "Background scheduler failed; keeping foreground service alive", error);
            try {
                updateStatus("تم تشغيل خدمة الخلفية؛ تعذر بدء جدولة الفحص وستتم إعادة المحاولة.");
            } catch (Throwable ignored) {
                Log.e(TAG, "Unable to publish scheduler failure status", ignored);
            }
        }
        return START_STICKY;
    }

    private void scheduleScan() {
        if (executor == null || executor.isShutdown()) return;
        executor.shutdownNow();
        executor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "RadarX-Background");
            t.setDaemon(true);
            return t;
        });
        executor.scheduleWithFixedDelay(this::scanOnceSafe, 0L, SCAN_MS, TimeUnit.MILLISECONDS);
    }

    private void scanOnceSafe() {
        if (stopping) return;
        deliverPendingAlerts();
        if (!hasValidatedInternetConnection()) {
            if (!offlineLogged) {
                offlineLogged = true;
                Log.i(TAG, "BACKGROUND_OFFLINE_WAIT");
            }
            updateStatus("عين الصقر تعمل في الخلفية وتنتظر الإنترنت. لا يمكن جلب أسعار أو اكتشافات سوق جديدة دون اتصال؛ التنبيهات المحفوظة محليًا ستبقى في قائمة الانتظار.");
            return;
        }

        offlineLogged = false;
        try {
            long cursor = prefs().getLong("radar_alert_cursor_at", 0L);
            JSONObject root = fetchRadarAlertsFeed(cursor);
            JSONObject meta = root.optJSONObject("meta");
            boolean policyValid = meta != null
                && meta.optBoolean("paper_trading", true)
                && !meta.optBoolean("real_order_execution", false);
            if (!policyValid) {
                updateStatus("البيانات غير جاهزة أو سياسة القراءة فقط غير مؤكدة؛ لم يتم إصدار اكتشاف.");
                return;
            }
            if (!loggedFirstScan) {
                loggedFirstScan = true;
                Log.i(TAG, "BACKGROUND_SCAN_OK");
            } else {
                Log.i(TAG, "BACKGROUND_SCAN_COMPLETED");
            }

            JSONArray alerts = root.optJSONArray("alerts");
            int queued = notifyNewRadarAlerts(alerts == null ? new JSONArray() : alerts);
            long falconNextCursor = root.optLong("falcon_eye_next_cursor_at", 0L);
            long falconCursor = prefs().getLong(FALCON_CURSOR_KEY, 0L);
            if (falconNextCursor > falconCursor) {
                if (!prefs().edit().putLong(FALCON_CURSOR_KEY, falconNextCursor).commit()) {
                    Log.e(TAG, "FALCON_EYE_CURSOR_SAVE_FAILED");
                }
            }

            int delivered = deliverPendingAlerts();
            JSONArray radars = root.optJSONArray("radars");
            updateStatus("عين الصقر + الرادارات المستقلة • محفوظة بانتظار الإشعار: " +
                getPendingAlertCount() + " • أُرسل الآن: " + delivered +
                " • اكتشافات حُفظت: " + queued);
            if (queued > 0) Log.i(TAG, "BACKGROUND_ALERTS_QUEUED:" + queued);
            if (delivered > 0) Log.i(TAG, "BACKGROUND_ALERTS_NOTIFIED:" + delivered);
        } catch (Throwable error) {
            Log.w(TAG, "Background radar fetch failed", error);
            deliverPendingAlerts();
            if (!hasValidatedInternetConnection()) {
                offlineLogged = true;
                Log.i(TAG, "BACKGROUND_OFFLINE_WAIT");
                updateStatus("انقطع الإنترنت أثناء الفحص. بقيت خدمة الخلفية وقائمة التنبيهات المحفوظة؛ سيُعاد جلب تنبيهات الخادم عند عودة الاتصال.");
            } else {
                updateStatus("الاتصال متاح لكن خادم الرادار لم يستجب؛ بقيت الخدمة وقائمة التنبيهات محفوظة وستتم إعادة المحاولة.");
            }
        }
    }

    private JSONObject fetchRadarAlertsFeed(long cursor) throws Exception {
        Exception last = null;
        String[] unifiedBases = {BACKEND_RADAR_ALERTS, BACKEND_RADAR_ALERTS_FALLBACK};
        for (String base : unifiedBases) {
            HttpURLConnection connection = null;
            try {
                String target = base + (base.contains("?") ? "&since=" : "?since=") + cursor;
                connection = (HttpURLConnection) new URL(target).openConnection();
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(6_000);
                connection.setReadTimeout(12_000);
                connection.setInstanceFollowRedirects(false);
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("Accept-Encoding", "identity");
                int status = connection.getResponseCode();
                if (status == 404) {
                    last = new IllegalStateException("HTTP_404");
                    continue;
                }
                if (status != 200) throw new IllegalStateException("HTTP_" + status);
                JSONObject root = new JSONObject(new String(readAll(connection.getInputStream()), StandardCharsets.UTF_8));
                appendFalconEyeAlerts(root);
                return root;
            } catch (Exception e) {
                last = e;
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
        JSONObject root = fetchIndividualRadarAlerts(cursor, last);
        appendFalconEyeAlerts(root);
        return root;
    }

    /**
     * Falcon Eye is fetched through its own append-only alert log and own durable cursor.
     * It is not inferred from the combined-feed cursor or from a price observed later.
     */
    private void appendFalconEyeAlerts(JSONObject root) {
        long cursor = prefs().getLong(FALCON_CURSOR_KEY, 0L);
        String[] endpoints = {BACKEND_FALCON_ALERTS, BACKEND_FALCON_ALERTS_FALLBACK};
        for (String endpoint : endpoints) {
            HttpURLConnection connection = null;
            try {
                String target = endpoint + "?since=" + cursor + "&limit=50&scan=0";
                connection = (HttpURLConnection) new URL(target).openConnection();
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(5_000);
                connection.setReadTimeout(9_000);
                connection.setInstanceFollowRedirects(false);
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("Accept-Encoding", "identity");
                int status = connection.getResponseCode();
                if (status != 200) {
                    Log.w(TAG, "FALCON_EYE_FEED_HTTP_" + status);
                    continue;
                }

                JSONObject body = new JSONObject(new String(readAll(connection.getInputStream()), StandardCharsets.UTF_8));
                JSONObject meta = body.optJSONObject("meta");
                if (meta == null || !meta.optBoolean("paper_trading", false)
                        || meta.optBoolean("real_order_execution", true)
                        || !"UNKNOWN".equals(meta.optString("confidence_score", ""))) {
                    Log.e(TAG, "FALCON_EYE_FEED_POLICY_REJECTED");
                    return;
                }

                JSONArray sourceAlerts = body.optJSONArray("alerts");
                JSONArray combined = root.optJSONArray("alerts");
                if (combined == null) combined = new JSONArray();
                JSONArray radars = root.optJSONArray("radars");
                if (radars == null) radars = new JSONArray();
                Set<String> existingIds = new HashSet<>();
                for (int i = 0; i < combined.length(); i++) {
                    JSONObject existing = combined.optJSONObject(i);
                    if (existing == null) continue;
                    String id = existing.optString("id", "");
                    if (!id.isEmpty()) existingIds.add(id);
                }

                long nextCursor = cursor;
                int appended = 0;
                if (sourceAlerts != null) {
                    for (int i = 0; i < sourceAlerts.length(); i++) {
                        JSONObject row = sourceAlerts.optJSONObject(i);
                        if (row == null) continue;
                        long at = alertTimestamp(row);
                        if (at <= cursor) continue;
                        if (at > nextCursor) nextCursor = at;

                        JSONObject copy = new JSONObject(row.toString());
                        if (copy.optString("radar", "").isEmpty()) copy.put("radar", "FALCON_EYE_RADAR");
                        if (copy.optString("radar_name", "").isEmpty()) copy.put("radar_name", "Radar 9 — عين الصقر");
                        double price = detectionPrice(copy);
                        if (price > 0 && !copy.has("price_at_detection")) copy.put("price_at_detection", price);
                        if (!copy.has("detected_at") && at > 0) copy.put("detected_at", at);
                        String id = copy.optString("id", "");
                        if (id.isEmpty()) {
                            id = "FALCON:" + copy.optString("symbol", "UNKNOWN") + ":" + at;
                            copy.put("id", id);
                        }
                        if (!existingIds.contains(id)) {
                            combined.put(copy);
                            existingIds.add(id);
                            appended++;
                        }
                    }
                }

                root.put("alerts", combined);
                boolean hasRadar = false;
                for (int i = 0; i < radars.length(); i++) {
                    if ("FALCON_EYE_RADAR".equals(radars.optString(i, ""))) hasRadar = true;
                }
                if (!hasRadar) radars.put("FALCON_EYE_RADAR");
                root.put("radars", radars);
                if (nextCursor > cursor) root.put("falcon_eye_next_cursor_at", nextCursor);
                Log.i(TAG, "FALCON_EYE_FEED_OK alerts=" + appended + " cursor=" + cursor);
                return;
            } catch (Exception error) {
                Log.w(TAG, "FALCON_EYE_FEED_FETCH_FAILED:" + endpoint, error);
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
    }

    private void registerConnectivityCallback() {
        if (Build.VERSION.SDK_INT < 24 || connectivityCallback != null) return;
        connectivityManager = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (connectivityManager == null) return;
        connectivityCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                if (!hasValidatedInternetConnection()) return;
                offlineLogged = false;
                Log.i(TAG, "BACKGROUND_NETWORK_AVAILABLE");
                updateStatus("عاد الإنترنت؛ يجري جلب تنبيهات عين الصقر المحفوظة وإرسال سعرها ووقت اكتشافها الأصليين.");
                requestImmediateScan();
            }

            @Override
            public void onLost(Network network) {
                if (!hasValidatedInternetConnection()) {
                    Log.i(TAG, "BACKGROUND_NETWORK_LOST");
                    requestImmediateScan();
                }
            }
        };
        try {
            connectivityManager.registerDefaultNetworkCallback(connectivityCallback);
        } catch (Throwable error) {
            connectivityCallback = null;
            Log.w(TAG, "NETWORK_CALLBACK_REGISTER_FAILED", error);
        }
    }

    private void unregisterConnectivityCallback() {
        if (Build.VERSION.SDK_INT < 24 || connectivityManager == null || connectivityCallback == null) return;
        try {
            connectivityManager.unregisterNetworkCallback(connectivityCallback);
        } catch (Throwable ignored) {
            Log.w(TAG, "NETWORK_CALLBACK_UNREGISTER_FAILED");
        }
        connectivityCallback = null;
    }

    private void requestImmediateScan() {
        ScheduledExecutorService current = executor;
        if (stopping || current == null || current.isShutdown()) return;
        try {
            current.execute(() -> {
                if (stopping) return;
                deliverPendingAlerts();
                scanOnceSafe();
            });
        } catch (Throwable error) {
            Log.w(TAG, "IMMEDIATE_SCAN_SCHEDULE_FAILED", error);
        }
    }

    private boolean hasValidatedInternetConnection() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        if (Build.VERSION.SDK_INT >= 23) {
            Network active = cm.getActiveNetwork();
            if (active == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(active);
            return caps != null
                && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        }
        android.net.NetworkInfo info = cm.getActiveNetworkInfo();
        return info != null && info.isConnected();
    }

    private JSONObject fetchIndividualRadarAlerts(long cursor, Exception prior) throws Exception {
        String base = "https://radarx-ai-triple-production.up.railway.app";
        String[] paths = {
            "/api/move-radar?quote=USDT&limit=50",
            "/api/strong-move-radar?quote=USDT&limit=50",
            "/api/rotation-lag-radar?quote=USDT&limit=50",
            "/api/liquidity-absorption-radar?quote=USDT&limit=50",
            "/api/kahir-radar?quote=USDT&limit=50",
            "/api/doomsday-radar?quote=USDT&limit=50",
            "/api/professor-radar?quote=USDT&limit=50",
            "/api/almuqawim-radar?quote=USDT&limit=50",
            "/api/early-expansion-radar?quote=USDT&limit=50",
            "/api/coin-hunter-radar?quote=USDT&limit=50&scan=0"
        };
        JSONArray merged = new JSONArray();
        JSONArray radarNames = new JSONArray();
        boolean any200 = false;
        Exception last = prior;
        for (String path : paths) {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(base + path).openConnection();
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(8_000);
                connection.setReadTimeout(20_000);
                connection.setInstanceFollowRedirects(false);
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("Accept-Encoding", "identity");
                int status = connection.getResponseCode();
                if (status != 200 && status != 503) throw new IllegalStateException("HTTP_" + status + "_" + path);
                if (status == 200) {
                    any200 = true;
                    JSONObject body = new JSONObject(new String(readAll(connection.getInputStream()), StandardCharsets.UTF_8));
                    JSONObject name = body.optJSONObject("meta");
                    if (name != null) {
                        String radarName = name.optString("radar", "");
                        if (!radarName.isEmpty()) radarNames.put(radarName);
                    }
                    JSONArray candidates = body.optJSONArray("alerts");
                    if (candidates == null) candidates = body.optJSONArray("discoveries");
                    if (candidates == null) candidates = body.optJSONArray("candidates");
                    if (candidates != null) {
                        for (int i = 0; i < candidates.length(); i++) {
                            JSONObject row = candidates.optJSONObject(i);
                            if (row == null) continue;
                            long at = row.optLong("processed_at", row.optLong("detected_at", row.optLong("detectedAt", 0L)));
                            if (at > cursor) merged.put(row);
                        }
                    }
                }
            } catch (Exception e) {
                last = e;
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
        if (!any200) throw last == null ? new IllegalStateException("BACKEND_UNAVAILABLE") : last;
        JSONObject root = new JSONObject();
        JSONObject meta = new JSONObject();
        meta.put("paper_trading", true);
        meta.put("real_order_execution", false);
        meta.put("confidence_score", "UNKNOWN");
        root.put("meta", meta);
        root.put("alerts", merged);
        root.put("radars", radarNames);
        return root;
    }

    private int notifyNewRadarAlerts(JSONArray alerts) {
        Set<String> seen = new HashSet<>(prefs().getStringSet("radar_alert_seen_ids", new HashSet<>()));
        JSONArray pending = loadPendingAlerts();
        Set<String> queuedIds = pendingAlertIds(pending);
        long cursor = prefs().getLong("radar_alert_cursor_at", 0L);
        long maxAt = cursor;
        int added = 0;

        for (int i = 0; i < alerts.length(); i++) {
            JSONObject alert = alerts.optJSONObject(i);
            if (alert == null) continue;
            long at = alertTimestamp(alert);
            if (!alert.optBoolean("eligible", true)) {
                if (at > maxAt) maxAt = at;
                continue;
            }

            String id = alert.optString("id", "").trim();
            if (id.isEmpty()) id = "RADAR:" + alert.optString("radar", "UNKNOWN") + ":"
                + alert.optString("symbol", "UNKNOWN") + ":" + at + ":" + detectionPrice(alert);
            if (seen.contains(id) || queuedIds.contains(id)) {
                if (at > maxAt) maxAt = at;
                continue;
            }
            if (pending.length() >= MAX_PENDING_ALERTS) {
                // Do not advance past an alert that was not queued. It will be returned again
                // after the existing durable queue drains.
                Log.e(TAG, "PENDING_ALERT_QUEUE_FULL; preserving cursor before undispatched alert");
                break;
            }
            pending.put(compactAlert(alert, id, at));
            queuedIds.add(id);
            if (at > maxAt) maxAt = at;
            added++;
        }

        if (!prefs().edit().putString(PENDING_ALERTS_KEY, pending.toString())
                .putLong("radar_alert_cursor_at", maxAt).commit()) {
            throw new IllegalStateException("RADAR_ALERT_QUEUE_PERSIST_FAILED");
        }
        return added;
    }

    private JSONArray loadPendingAlerts() {
        try {
            return new JSONArray(prefs().getString(PENDING_ALERTS_KEY, "[]"));
        } catch (Exception error) {
            Log.e(TAG, "PENDING_ALERT_QUEUE_INVALID_JSON", error);
            return new JSONArray();
        }
    }

    private Set<String> pendingAlertIds(JSONArray pending) {
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < pending.length(); i++) {
            JSONObject alert = pending.optJSONObject(i);
            if (alert == null) continue;
            String id = alert.optString("id", "");
            if (!id.isEmpty()) ids.add(id);
        }
        return ids;
    }

    private int getPendingAlertCount() {
        return loadPendingAlerts().length();
    }

    private int deliverPendingAlerts() {
        JSONArray pending = loadPendingAlerts();
        if (pending.length() == 0) return 0;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return 0;
        if (Build.VERSION.SDK_INT >= 24 && !manager.areNotificationsEnabled()) {
            Log.w(TAG, "PENDING_ALERTS_WAITING_FOR_NOTIFICATION_PERMISSION:" + pending.length());
            return 0;
        }
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = manager.getNotificationChannel(CHANNEL_RADAR_ALERTS);
            if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) {
                Log.w(TAG, "PENDING_ALERTS_WAITING_FOR_ENABLED_CHANNEL:" + pending.length());
                return 0;
            }
        }

        Set<String> seen = new HashSet<>(prefs().getStringSet("radar_alert_seen_ids", new HashSet<>()));
        JSONArray remaining = new JSONArray();
        int delivered = 0;
        for (int i = 0; i < pending.length(); i++) {
            JSONObject alert = pending.optJSONObject(i);
            if (alert == null) continue;
            String id = alert.optString("id", "");
            if (!id.isEmpty() && seen.contains(id)) continue;
            try {
                if (notifyRadarAlert(alert)) {
                    if (!id.isEmpty()) seen.add(id);
                    delivered++;
                } else {
                    remaining.put(alert);
                }
            } catch (Throwable error) {
                Log.w(TAG, "PENDING_ALERT_NOTIFY_FAILED:" + id, error);
                remaining.put(alert);
            }
        }
        while (seen.size() > 500) seen.remove(seen.iterator().next());
        if (!prefs().edit().putString(PENDING_ALERTS_KEY, remaining.toString())
                .putStringSet("radar_alert_seen_ids", seen).commit()) {
            Log.e(TAG, "PENDING_ALERT_DELIVERY_STATE_SAVE_FAILED");
        }
        return delivered;
    }

    private JSONObject compactAlert(JSONObject source, String id, long at) {
        JSONObject out = new JSONObject();
        try {
            out.put("id", id);
            out.put("radar", source.optString("radar", "UNKNOWN_RADAR"));
            out.put("radar_name", source.optString("radar_name", radarNameFor(source.optString("radar", ""))));
            out.put("symbol", source.optString("symbol", "UNKNOWN"));
            out.put("event", source.optString("event", "RADAR_ALERT"));
            out.put("market", source.optString("market", "SPOT"));
            out.put("direction", source.optString("direction", "UNKNOWN"));
            out.put("opportunity_score", source.optDouble("opportunity_score", source.optDouble("setup_score", 0.0)));
            out.put("potential_label", source.optString("potential_label", source.optString("stage", "RADAR_ALERT")));
            out.put("detected_at", source.optLong("detected_at", at));
            out.put("processed_at", source.optLong("processed_at", at));
            out.put("detected_at_iso", source.optString("detected_at_iso", ""));
            out.put("detected_time_12h", source.optString("detected_time_12h", ""));
            out.put("detected_timezone", source.optString("detected_timezone", "Asia/Aden"));
            double price = detectionPrice(source);
            out.put("price_at_detection", price);
            out.put("price_change_24h", source.optDouble("price_change_24h", 0.0));
            out.put("source", source.optString("source", "Binance Public REST"));
            out.put("eligible", source.optBoolean("eligible", true));
            out.put("paper_trading", true);
            out.put("real_order_execution", false);
            out.put("confidence_score", "UNKNOWN");
            out.put("queued_at_ms", System.currentTimeMillis());
            JSONArray reasons = source.optJSONArray("reasons");
            if (reasons != null) {
                JSONArray copied = new JSONArray();
                for (int i = 0; i < Math.min(5, reasons.length()); i++) copied.put(reasons.optString(i, ""));
                out.put("reasons", copied);
            }
            JSONArray risks = source.optJSONArray("risk_flags");
            if (risks != null) {
                JSONArray copied = new JSONArray();
                for (int i = 0; i < Math.min(5, risks.length()); i++) copied.put(risks.optString(i, ""));
                out.put("risk_flags", copied);
            }
        } catch (Exception error) {
            Log.w(TAG, "ALERT_COMPACTION_FAILED", error);
        }
        return out;
    }

    private static long alertTimestamp(JSONObject alert) {
        if (alert == null) return 0L;
        long detected = alert.optLong("detected_at", alert.optLong("detectedAt", 0L));
        return detected > 0L ? detected : alert.optLong("processed_at", 0L);
    }

    private static double detectionPrice(JSONObject alert) {
        if (alert == null) return 0.0;
        String[] keys = {"price_at_detection", "detected_price", "price", "last_price", "lastPrice", "entry_price", "reference_price"};
        double value = positiveNumber(alert, keys);
        if (value > 0.0) return value;
        String[] nested = {"falcon_eye", "snapshot", "market", "metrics", "deep_scan"};
        for (String key : nested) {
            JSONObject object = alert.optJSONObject(key);
            value = positiveNumber(object, keys);
            if (value > 0.0) return value;
            value = positiveNumber(object == null ? null : object.optJSONObject("metrics"), keys);
            if (value > 0.0) return value;
        }
        return 0.0;
    }

    private static double positiveNumber(JSONObject object, String[] keys) {
        if (object == null) return 0.0;
        for (String key : keys) {
            double value = object.optDouble(key, 0.0);
            if (Double.isFinite(value) && value > 0.0) return value;
        }
        return 0.0;
    }

    private static int notificationId(String id) {
        return ALERT_NOTIFICATION_BASE + Math.abs(id.hashCode() % 1_000_000);
    }

    private boolean notifyRadarAlert(JSONObject alert) {
        String radar = alert.optString("radar", "UNKNOWN_RADAR");
        String radarName = alert.optString("radar_name", radarNameFor(radar));
        String symbol = alert.optString("symbol", "UNKNOWN");
        double score = alert.has("opportunity_score")
            ? alert.optDouble("opportunity_score", 0.0)
            : alert.optDouble("setup_score", 0.0);
        String stage = alert.optString("potential_label", alert.optString("event", "RADAR_ALERT"));
        long detectedAt = alertTimestamp(alert);
        String detectedText = alert.optString("detected_time_12h", "");
        if (detectedText.isEmpty()) detectedText = formatTimestamp12h(detectedAt);
        double detectedPrice = detectionPrice(alert);
        String priceText = detectedPrice > 0.0 ? priceFmt.format(detectedPrice) : "غير مسجل في لقطة الاكتشاف";

        JSONArray reasons = alert.optJSONArray("reasons");
        StringBuilder reasonText = new StringBuilder();
        if (reasons != null) {
            for (int i = 0; i < Math.min(4, reasons.length()); i++) {
                if (i > 0) reasonText.append(" • ");
                reasonText.append(reasons.optString(i, ""));
            }
        }

        String title = "RadarX • " + radarName + " • " + symbol;
        String body = "الرادار: " + radarName + " • " + symbol +
            " • سعر وقت الاكتشاف: " + priceText +
            " • Score " + scoreFmt.format(score) + " • " + stage;
        String timing = "وقت الاكتشاف: " + detectedText + " • وقت وصول الإشعار للهاتف: " +
            formatTimestamp12h(System.currentTimeMillis()) + " • Asia/Aden • 12h";

        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(
            this, 45000 + Math.abs(symbol.hashCode()),
            open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification.Builder builder = notificationBuilder(CHANNEL_RADAR_ALERTS)
            .setSmallIcon(com.radarx.app.R.drawable.ic_radarx)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(
                body + " • " + (reasonText.length() > 0 ? reasonText : "إشعار من رادار مستقل") +
                " • " + timing +
                " • السعر هو لقطة وقت الاكتشاف، وليس السعر الحالي بعد التأخير" +
                " • شموع مغلقة فقط • Paper Trading فقط • لا يوجد أمر تداول حقيقي"
            ))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_EVENT)
            .setPriority(Notification.PRIORITY_HIGH);

        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return false;
        String alertId = alert.optString("id", radar + ":" + symbol + ":" + detectedAt);
        manager.notify(notificationId(alertId), builder.build());
        return true;
    }

    private static String radarNameFor(String radar) {
        switch (radar) {
            case "EARLY_MOVE_RADAR": return "Radar 1 — Early-Wake";
            case "STRONG_MOVE_RADAR": return "Radar 2 — Strong-Move";
            case "ROTATION_LAG_RADAR": return "Radar 3 — Rotation/Lag";
            case "LIQUIDITY_ABSORPTION_RADAR": return "Radar 4 — Liquidity Absorption";
            case "WHALE_ACCUMULATION_RADAR": return "🐋 تجمع الحيتان";
            case "KAHIR_RADAR": return "Radar 5 — القاهر";
            case "DOOMSDAY_RADAR": return "Radar 6 — يوم القيامة";
            case "ALMUQAWIM_RADAR": return "Radar 7 — المقاوم";
            case "EARLY_EXPANSION_RADAR": return "Radar 8 — البرق";
            case "COIN_HUNTER_RADAR": return "🎯 صائد العملات";
            case "FALCON_EYE_RADAR": return "Radar 9 — عين الصقر";
            default: return "RadarX";
        }
    }

    private static String formatTimestamp12h(long epochMs) {
        if (epochMs <= 0L) return "غير متوفر";
        SimpleDateFormat format = new SimpleDateFormat("dd/MM/yyyy h:mm:ss a", Locale.US);
        format.setTimeZone(java.util.TimeZone.getTimeZone("Asia/Aden"));
        return format.format(new Date(epochMs));
    }

    private Notification.Builder notificationBuilder(String channel) {
        return Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, channel)
            : new Notification.Builder(this);
    }

    private void startAsForeground() {
        Notification.Builder builder = notificationBuilder(CHANNEL_STATUS)
            .setSmallIcon(com.radarx.app.R.drawable.ic_radarx)
            .setContentTitle("RadarX • الرادارات المستقلة")
            .setContentText("الرادارات المستقلة • إشعار واحد من الخلاصة الموحدة")
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setColor(Color.rgb(53, 201, 255))
            .setPriority(Notification.PRIORITY_LOW);

        if (Build.VERSION.SDK_INT >= 29) {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(
                    STATUS_NOTIFICATION_ID,
                    builder.build(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                );
            } else {
                startForeground(
                    STATUS_NOTIFICATION_ID,
                    builder.build(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                );
            }
        } else {
            startForeground(STATUS_NOTIFICATION_ID, builder.build());
        }
        saveRunning(true);
        Log.i(TAG, "BACKGROUND_SERVICE_READY");
    }

    private void updateStatus(String text) {
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_STATUS)
            .setSmallIcon(com.radarx.app.R.drawable.ic_radarx)
            .setContentTitle("RadarX • مراقبة الخلفية")
            .setContentText(text)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setColor(Color.rgb(53, 201, 255))
            .setPriority(Notification.PRIORITY_LOW);
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(STATUS_NOTIFICATION_ID, builder.build());
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel status = new NotificationChannel(
            CHANNEL_STATUS, "RadarX Background Monitor", NotificationManager.IMPORTANCE_LOW
        );
        status.setDescription("حالة خدمة الخلفية؛ تنتظر عند انقطاع الإنترنت وتستأنف جلب التنبيهات عند عودته");
        manager.createNotificationChannel(status);

        NotificationChannel alerts = new NotificationChannel(
            CHANNEL_ALERTS, "RadarX Early-Wake Alerts", NotificationManager.IMPORTANCE_HIGH
        );
        alerts.setDescription("تنبيهات الرادار الأول: Early-Wake وPre-Explosion");
        manager.createNotificationChannel(alerts);

        NotificationChannel strongAlerts = new NotificationChannel(
            CHANNEL_STRONG_ALERTS, "RadarX Strong-Move Alerts", NotificationManager.IMPORTANCE_HIGH
        );
        strongAlerts.setDescription("تنبيهات الرادار الثاني للحركة القوية والانفجار اللحظي");
        manager.createNotificationChannel(strongAlerts);

        NotificationChannel rotationAlerts = new NotificationChannel(
            CHANNEL_ROTATION_ALERTS, "RadarX Rotation-Lag Alerts", NotificationManager.IMPORTANCE_HIGH
        );
        rotationAlerts.setDescription("تنبيهات الرادار الثالث لاكتشاف دوران السوق والعملات المتأخرة");
        manager.createNotificationChannel(rotationAlerts);

        NotificationChannel radarAlerts = new NotificationChannel(
            CHANNEL_RADAR_ALERTS, "RadarX Independent Radar Alerts", NotificationManager.IMPORTANCE_HIGH
        );
        radarAlerts.setDescription("تنبيهات موحدة للرادارات المستقلة، بما فيها صائد العملات");
        manager.createNotificationChannel(radarAlerts);
    }

    private void stopMonitoring() {
        stopping = true;
        unregisterConnectivityCallback();
        if (executor != null) executor.shutdownNow();
        saveRunning(false);
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        stopping = true;
        unregisterConnectivityCallback();
        if (executor != null) executor.shutdownNow();
        saveRunning(false);
        super.onDestroy();
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        Log.w(TAG, "Android 15 FGS timeout; stopping cleanly");
        updateStatus("المراقبة توقفت تلقائيًا بحد نظام Android 15؛ افتح التطبيق لاستئنافها");
        saveRunning(false);
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private SharedPreferences prefs() {
        return getSharedPreferences("radarx_background", Context.MODE_PRIVATE);
    }

    private void saveRunning(boolean running) {
        prefs().edit().putBoolean("running", running).apply();
    }

    public static boolean isRunning(Context context) {
        return context.getSharedPreferences("radarx_background", Context.MODE_PRIVATE)
            .getBoolean("running", false);
    }

    private static byte[] readAll(java.io.InputStream input) throws Exception {
        BufferedInputStream in = new BufferedInputStream(input);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
        return out.toByteArray();
    }

    private static double clamp(double value) {
        return Math.max(0.0, Math.min(100.0, value));
    }

    private static final class ScanResult {
        String bestSymbol;
        double bestScore;
    }

    private static final class CandidateScore {
        final boolean parsed;
        final boolean eligible;
        final String symbol;
        final double score;
        final double trapRisk;
        final int evidence;
        final String reasons;

        CandidateScore(
            boolean parsed, boolean eligible, String symbol, double score,
            double trapRisk, int evidence, String reasons
        ) {
            this.parsed = parsed;
            this.eligible = eligible;
            this.symbol = symbol;
            this.score = score;
            this.trapRisk = trapRisk;
            this.evidence = evidence;
            this.reasons = reasons;
        }

        static CandidateScore ineligible(String symbol) {
            return new CandidateScore(false, false, symbol, 0.0, 100.0, 0, "");
        }
    }
}
