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
import java.util.ArrayList;
import java.util.Collections;
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
    private static final long ALERT_COOLDOWN_MS = 30 * 60_000L;
    private static final String HEARTBEAT_KEY = "monitor_heartbeat_at_ms";
    private static final long HEARTBEAT_STALE_MS = 5 * 60_000L;

    private ScheduledExecutorService executor;
    private volatile boolean stopping;
    private volatile boolean loggedFirstScan;
    private final DecimalFormat scoreFmt = new DecimalFormat("0.0");

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
        touchHeartbeat();
        try {
            long cursor = currentAlertCursor();
            JSONObject root = fetchRadarAlertsFeed(cursor);
            JSONObject meta = root.optJSONObject("meta");
            boolean live = meta != null && meta.optBoolean("paper_trading", true)
                && !meta.optBoolean("real_order_execution", false);
            if (live) {
                if (!loggedFirstScan) { loggedFirstScan = true; Log.i(TAG, "BACKGROUND_SCAN_OK"); }
                JSONArray alerts = root.optJSONArray("alerts");
                int count = notifyNewRadarAlerts(alerts == null ? new JSONArray() : alerts);
                JSONArray radars = root.optJSONArray("radars");
                updateStatus("رادارات مستقلة • " + (radars == null ? 6 : radars.length()) +
                    " • اكتشافات جديدة: " + count);
            } else {
                updateStatus("الرادارات المستقلة غير متاحة حاليًا؛ لا يتم توليد بيانات صناعية");
            }
        } catch (Throwable error) {
            if (!loggedFirstScan) { loggedFirstScan = true; Log.w(TAG, "BACKGROUND_SCAN_ERROR", error); }
            Log.w(TAG, "Background unified radar fetch failed", error);
            updateStatus("لا يوجد اتصال بالخادم الآن • تعذر التحقق من التنبيهات • ستستأنف المراقبة ويُراجع السجل الدائم عند عودة الاتصال");
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
                connection.setConnectTimeout(12_000);
                connection.setReadTimeout(30_000);
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
                mergeFalconEyeHistory(root, cursor);
                return root;
            } catch (Exception e) {
                last = e;
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
        return fetchIndividualRadarAlerts(cursor, last);
    }

    /** Initialize a new install at the current time, but preserve a cursor from older app versions. */
    private long currentAlertCursor() {
        SharedPreferences p = prefs();
        if (!p.contains("radar_alert_cursor_at")) {
            long now = System.currentTimeMillis();
            p.edit().putLong("radar_alert_cursor_at", now)
                .putBoolean("radar_alert_cursor_initialized", true).apply();
            Log.i(TAG, "BACKGROUND_ALERT_CURSOR_INITIALIZED_AT_START");
            return now;
        }
        long cursor = p.getLong("radar_alert_cursor_at", 0L);
        if (!p.getBoolean("radar_alert_cursor_initialized", false)) {
            if (cursor <= 0L) cursor = System.currentTimeMillis();
            p.edit().putLong("radar_alert_cursor_at", cursor)
                .putBoolean("radar_alert_cursor_initialized", true).apply();
        }
        return cursor;
    }

    /**
     * Poll Radar 9's durable history independently of the combined feed. This protects
     * background replay if the combined feed's limit or an older backend feed omits it.
     */
    private void mergeFalconEyeHistory(JSONObject root, long cursor) {
        try {
            JSONArray history = fetchFalconEyeHistory(cursor);
            JSONArray primary = root.optJSONArray("alerts");
            JSONArray combined = new JSONArray();
            Set<String> ids = new HashSet<>();
            appendRecentAlerts(primary, cursor, combined, ids);
            appendRecentAlerts(history, cursor, combined, ids);

            ArrayList<JSONObject> sorted = new ArrayList<>();
            for (int i = 0; i < combined.length(); i++) {
                JSONObject row = combined.optJSONObject(i);
                if (row != null) sorted.add(row);
            }
            Collections.sort(sorted, (a, b) -> Long.compare(alertTimestamp(b), alertTimestamp(a)));
            JSONArray result = new JSONArray();
            for (JSONObject row : sorted) result.put(row);
            root.put("alerts", result);
        } catch (Exception error) {
            // The primary feed remains usable even when the dedicated Radar 9 route is unavailable.
            Log.w(TAG, "Falcon Eye history poll failed; keeping combined radar feed", error);
        }
    }

    private JSONArray fetchFalconEyeHistory(long cursor) throws Exception {
        Exception last = null;
        String[] bases = {
            "https://radarx-ai-triple-production.up.railway.app",
            "https://radarx-ai-production.up.railway.app"
        };
        for (String base : bases) {
            HttpURLConnection connection = null;
            try {
                touchHeartbeat();
                String target = base + "/api/falcon-eye-radar?since=" + cursor + "&limit=50&scan=0";
                connection = (HttpURLConnection) new URL(target).openConnection();
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(8_000);
                connection.setReadTimeout(12_000);
                connection.setInstanceFollowRedirects(false);
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("Accept-Encoding", "identity");
                int status = connection.getResponseCode();
                if (status != 200) {
                    last = new IllegalStateException("HTTP_" + status + "_FALCON_EYE_HISTORY");
                    continue;
                }
                JSONObject body = new JSONObject(new String(readAll(connection.getInputStream()), StandardCharsets.UTF_8));
                JSONArray alerts = body.optJSONArray("alerts");
                return alerts == null ? new JSONArray() : alerts;
            } catch (Exception error) {
                last = error;
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
        throw last == null ? new IllegalStateException("FALCON_EYE_HISTORY_UNAVAILABLE") : last;
    }

    private static void appendRecentAlerts(JSONArray source, long cursor, JSONArray target, Set<String> ids) {
        if (source == null) return;
        for (int i = 0; i < source.length(); i++) {
            JSONObject row = source.optJSONObject(i);
            if (row == null || alertTimestamp(row) <= cursor) continue;
            String id = row.optString("id", "");
            if (id.isEmpty()) {
                id = row.optString("radar", "") + "|" + row.optString("symbol", "") + "|" + alertTimestamp(row);
            }
            if (ids.add(id)) target.put(row);
        }
    }

    private static long alertTimestamp(JSONObject alert) {
        return alert.optLong("processed_at", alert.optLong("detected_at", alert.optLong("detectedAt", 0L)));
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
        mergeFalconEyeHistory(root, cursor);
        return root;
    }

    private int notifyNewRadarAlerts(JSONArray alerts) {
        Set<String> seen = new HashSet<>(prefs().getStringSet("radar_alert_seen_ids", new HashSet<>()));
        long cursor = prefs().getLong("radar_alert_cursor_at", 0L);
        long maxAt = cursor;
        int count = 0;
        for (int i = alerts.length() - 1; i >= 0; i--) {
            JSONObject alert = alerts.optJSONObject(i);
            if (alert == null) continue;
            long at = alert.optLong("processed_at", alert.optLong("detected_at", 0L));
            if (at > maxAt) maxAt = at;
            if (!alert.optBoolean("eligible", true)) continue;
            String id = alert.optString("id", "");
            if (id.isEmpty() || seen.contains(id)) continue;
            notifyRadarAlert(alert);
            seen.add(id);
            count++;
        }
        while (seen.size() > 300) seen.remove(seen.iterator().next());
        prefs().edit().putLong("radar_alert_cursor_at", maxAt)
            .putStringSet("radar_alert_seen_ids", seen).apply();
        return count;
    }

    private void notifyRadarAlert(JSONObject alert) {
        String radar = alert.optString("radar", "UNKNOWN_RADAR");
        String radarName = alert.optString("radar_name", radarNameFor(radar));
        String symbol = alert.optString("symbol", "UNKNOWN");
        double score = alert.has("opportunity_score")
            ? alert.optDouble("opportunity_score", 0.0)
            : alert.optDouble("setup_score", 0.0);
        String stage = alert.optString("potential_label", alert.optString("event", "RADAR_ALERT"));
        long detectedAt = alert.optLong("detected_at", alert.optLong("processed_at", 0L));
        String detectedText = alert.optString("detected_time_12h", "");
        if (detectedText.isEmpty()) detectedText = formatTimestamp12h(detectedAt);

        JSONArray reasons = alert.optJSONArray("reasons");
        StringBuilder reasonText = new StringBuilder();
        if (reasons != null) {
            for (int i = 0; i < Math.min(4, reasons.length()); i++) {
                if (i > 0) reasonText.append(" • ");
                reasonText.append(reasons.optString(i, ""));
            }
        }

        String title = "RadarX • " + radarName + " • " + symbol;
        double detectedPrice = alertPrice(alert);
        String priceText = detectedPrice > 0.0 && !Double.isNaN(detectedPrice) && !Double.isInfinite(detectedPrice)
            ? formatPrice(detectedPrice) : "غير متوفر";
        String body = "الرادار: " + radarName + " • " + symbol +
            " • السعر وقت الكشف: " + priceText + " • " + detectedText +
            " • Score " + scoreFmt.format(score) + " • " + stage;
        String timing = "وقت اكتشاف الخادم/العملة: " + detectedText + " • وقت إرسال الإشعار: " + formatTimestamp12h(System.currentTimeMillis()) + " • Asia/Aden • 12h";

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
                " • شموع مغلقة فقط • Paper Trading فقط • لا يوجد أمر تداول حقيقي"
            ))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_EVENT)
            .setPriority(Notification.PRIORITY_HIGH);

        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(45000 + Math.abs(symbol.hashCode() % 10000), builder.build());
        }
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
            default: return "RadarX";
        }
    }

    private static double alertPrice(JSONObject alert) {
        String[] keys = {"price", "price_at_detection", "detection_price", "last_price", "lastPrice"};
        for (String key : keys) {
            if (!alert.has(key) || alert.isNull(key)) continue;
            double value = alert.optDouble(key, Double.NaN);
            if (value > 0.0 && !Double.isNaN(value) && !Double.isInfinite(value)) return value;
        }
        return Double.NaN;
    }

    private static String formatPrice(double price) {
        DecimalFormat format = new DecimalFormat("0.############", new java.text.DecimalFormatSymbols(Locale.US));
        format.setGroupingUsed(false);
        return format.format(price);
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
        touchHeartbeat();
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
        status.setDescription("حالة متابعة رادار الحركة في الخلفية");
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
        if (executor != null) executor.shutdownNow();
        saveRunning(false);
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        stopping = true;
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

    private void touchHeartbeat() {
        prefs().edit().putLong(HEARTBEAT_KEY, System.currentTimeMillis()).apply();
    }

    private void saveRunning(boolean running) {
        SharedPreferences.Editor editor = prefs().edit().putBoolean("running", running);
        if (running) editor.putLong(HEARTBEAT_KEY, System.currentTimeMillis());
        else editor.remove(HEARTBEAT_KEY);
        editor.apply();
    }

    public static boolean isRunning(Context context) {
        SharedPreferences p = context.getSharedPreferences("radarx_background", Context.MODE_PRIVATE);
        if (!p.getBoolean("running", false)) return false;
        long heartbeat = p.getLong(HEARTBEAT_KEY, 0L);
        long age = System.currentTimeMillis() - heartbeat;
        return heartbeat > 0L && age >= 0L && age < HEARTBEAT_STALE_MS;
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
