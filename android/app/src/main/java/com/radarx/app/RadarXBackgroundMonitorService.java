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
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.Locale;

public final class RadarXBackgroundMonitorService extends Service {
    public static final String ACTION_START = "com.radarx.app.action.START_BACKGROUND_MONITOR";
    public static final String ACTION_STOP = "com.radarx.app.action.STOP_BACKGROUND_MONITOR";

    private static final String TAG = "RadarXBackground";
    private static final String BACKEND_MOVE =
            "https://radarx-ai-production.up.railway.app/api/move-radar?quote=USDT&limit=50";
    private static final String BACKEND_STRONG =
            "https://radarx-ai-production.up.railway.app/api/strong-move-radar?quote=USDT&limit=50";

    private static final String CHANNEL_STATUS = "radarx_background_status";
    private static final String CHANNEL_ALERTS = "radarx_move_alerts";
    private static final String CHANNEL_STRONG_ALERTS = "radarx_strong_move_alerts";
    private static final int STATUS_NOTIFICATION_ID = 41001;
    private static final int ALERT_NOTIFICATION_BASE = 42000;
    private static final int STRONG_ALERT_NOTIFICATION_BASE = 43000;
    private static final long SCAN_MS = 15_000L;
    private static final long ALERT_COOLDOWN_MS = 30 * 60_000L;

    private ScheduledExecutorService executor;
    private volatile boolean stopping;
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

        scheduleScan();
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
        int moveCount = 0;
        int strongCount = 0;
        int universe = 0;
        boolean moveOk = false;
        boolean strongOk = false;
        try {
            JSONObject root = fetchMoveFeed();
            JSONObject meta = root.optJSONObject("meta");
            if (meta != null && meta.optBoolean("live", false) &&
                meta.optBoolean("paper_trading", true) &&
                !meta.optBoolean("real_order_execution", false)) {
                JSONArray alerts = root.optJSONArray("alerts");
                moveCount = notifyNewMoveAlerts(alerts == null ? new JSONArray() : alerts);
                JSONObject monitoring = root.optJSONObject("monitoring");
                universe = monitoring == null ? 0 : monitoring.optInt("universe", 0);
                moveOk = true;
            }
        } catch (Throwable error) {
            Log.w(TAG, "Background move-radar fetch failed", error);
        }
        try {
            JSONObject root = fetchStrongMoveFeed();
            JSONObject meta = root.optJSONObject("meta");
            if (meta != null && meta.optBoolean("live", false) &&
                meta.optBoolean("paper_trading", true) &&
                !meta.optBoolean("real_order_execution", false)) {
                JSONArray alerts = root.optJSONArray("alerts");
                strongCount = notifyNewStrongMoveAlerts(alerts == null ? new JSONArray() : alerts);
                JSONObject monitoring = root.optJSONObject("monitoring");
                if (monitoring != null) universe = Math.max(universe, monitoring.optInt("universe", 0));
                strongOk = true;
            }
        } catch (Throwable error) {
            Log.w(TAG, "Background strong-move radar fetch failed", error);
        }

        if (moveOk || strongOk) {
            updateStatus(
                "Radar 1 Early-Wake/Pre-Explosion: " + moveCount +
                " • Radar 2 Strong-Move: " + strongCount +
                " • " + universe + " عملة"
            );
        } else {
            updateStatus("الراداران • لا يوجد اتصال الآن؛ سيُستكمل التنبيه عند عودة الإنترنت");
        }
    }

    private JSONObject fetchStrongMoveFeed() throws Exception {
        long cursor = prefs().getLong("strong_move_alert_cursor_at", 0L);
        String url = BACKEND_STRONG + (cursor > 0L ? "&since=" + cursor : "");
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(12_000);
            connection.setReadTimeout(60_000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Accept-Encoding", "identity");
            int status = connection.getResponseCode();
            if (status != 200) throw new IllegalStateException("HTTP_" + status);
            return new JSONObject(new String(readAll(connection.getInputStream()), StandardCharsets.UTF_8));
        } finally {
            connection.disconnect();
        }
    }

    private JSONObject fetchMoveFeed() throws Exception {
        long cursor = prefs().getLong("move_alert_cursor_at", 0L);
        String url = BACKEND_MOVE + (cursor > 0L ? "&since=" + cursor : "");
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(12_000);
            connection.setReadTimeout(60_000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Accept-Encoding", "identity");
            int status = connection.getResponseCode();
            if (status != 200) throw new IllegalStateException("HTTP_" + status);
            return new JSONObject(new String(readAll(connection.getInputStream()), StandardCharsets.UTF_8));
        } finally {
            connection.disconnect();
        }
    }

    private int notifyNewMoveAlerts(JSONArray alerts) {
        Set<String> seen = new HashSet<>(prefs().getStringSet("move_alert_seen_ids", new HashSet<>()));
        long cursor = prefs().getLong("move_alert_cursor_at", 0L);
        long maxAt = cursor;
        int count = 0;
        for (int i = alerts.length() - 1; i >= 0; i--) {
            JSONObject alert = alerts.optJSONObject(i);
            if (alert == null) continue;
            String event = alert.optString("event", "");
            long at = alert.optLong("processed_at", 0L);
            boolean supportedEarlyEvent =
                "EARLY_WAKE_ALERT".equals(event) ||
                "PRE_EXPLOSION_ALERT".equals(event);
            if (!supportedEarlyEvent) {
                if (at > maxAt) maxAt = at;
                continue;
            }
            if (!alert.optBoolean("eligible", false)) {
                if (at > maxAt) maxAt = at;
                continue;
            }
            String id = alert.optString("id", "");
            if (at > maxAt) maxAt = at;
            if (id.isEmpty() || seen.contains(id)) continue;
            notifyMoveAlert(alert);
            seen.add(id);
            count++;
        }
        while (seen.size() > 200) seen.remove(seen.iterator().next());
        prefs().edit().putLong("move_alert_cursor_at", maxAt)
            .putStringSet("move_alert_seen_ids", seen).apply();
        return count;
    }

    private int notifyNewStrongMoveAlerts(JSONArray alerts) {
        Set<String> seen = new HashSet<>(prefs().getStringSet("strong_move_alert_seen_ids", new HashSet<>()));
        long cursor = prefs().getLong("strong_move_alert_cursor_at", 0L);
        long maxAt = cursor;
        int count = 0;
        for (int i = alerts.length() - 1; i >= 0; i--) {
            JSONObject alert = alerts.optJSONObject(i);
            if (alert == null) continue;
            if (!"STRONG_MOVE_ALERT".equals(alert.optString("event", ""))) {
                long at = alert.optLong("processed_at", 0L);
                if (at > maxAt) maxAt = at;
                continue;
            }
            if (!alert.optBoolean("eligible", false)) {
                long at = alert.optLong("processed_at", 0L);
                if (at > maxAt) maxAt = at;
                continue;
            }
            String id = alert.optString("id", "");
            long at = alert.optLong("processed_at", 0L);
            if (at > maxAt) maxAt = at;
            if (id.isEmpty() || seen.contains(id)) continue;
            notifyStrongMoveAlert(alert);
            seen.add(id);
            count++;
        }
        while (seen.size() > 200) seen.remove(seen.iterator().next());
        prefs().edit().putLong("strong_move_alert_cursor_at", maxAt)
            .putStringSet("strong_move_alert_seen_ids", seen).apply();
        return count;
    }

    private void notifyStrongMoveAlert(JSONObject alert) {
        String symbol = alert.optString("symbol", "UNKNOWN");
        String direction = alert.optString("direction", "UP_SURGE");
        double move = alert.optDouble("price_change_24h", 0.0);
        double score = alert.optDouble("opportunity_score", 0.0);
        String stage = alert.optString("potential_label", "STRONG_MOVE");
        JSONObject strong = alert.optJSONObject("strong_move");
        JSONArray reasons = alert.optJSONArray("reasons");
        long detectedAt = alert.optLong("detected_at", alert.optLong("processed_at", 0L));
        long sentAt = System.currentTimeMillis();

        StringBuilder reasonText = new StringBuilder();
        if (reasons != null) {
            for (int i = 0; i < Math.min(4, reasons.length()); i++) {
                if (i > 0) reasonText.append(" • ");
                reasonText.append(reasons.optString(i, ""));
            }
        }

        String title = "UP_SURGE".equals(direction)
            ? "RadarX • ⚡ حركة قوية بدأت"
            : "RadarX • ⚡ حركة هابطة قوية";
        String body = symbol + " • 24h " + scoreFmt.format(move) + "% • Burst Score " +
            scoreFmt.format(score) + " • " + stage;
        String timing = "اكتشاف: " + formatTimestamp(detectedAt) +
            " • إشعار: " + formatTimestamp(sentAt);

        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(
            this, STRONG_ALERT_NOTIFICATION_BASE + Math.abs(symbol.hashCode()),
            open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification.Builder builder = notificationBuilder(CHANNEL_STRONG_ALERTS)
            .setSmallIcon(com.radarx.app.R.drawable.ic_radarx)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(
                body + " • " + (reasonText.length() > 0 ? reasonText : "توسع زخم وحجم") +
                " • " + timing +
                " • رادار مستقل عن رادار Early-Wake" +
                " • شموع مغلقة فقط • Paper Trading فقط • ليس ضمانًا لاستمرار الحركة"
            ))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_EVENT)
            .setPriority(Notification.PRIORITY_HIGH);

        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(
                STRONG_ALERT_NOTIFICATION_BASE + Math.abs(symbol.hashCode() % 10000),
                builder.build()
            );
        }
    }

    private void notifyMoveAlert(JSONObject alert) {
        String event = alert.optString("event", "");
        String symbol = alert.optString("symbol", "UNKNOWN");
        String direction = alert.optString("direction", "UP_MOVE");
        double move = alert.optDouble("price_change_24h", 0.0);
        double score = alert.optDouble("opportunity_score", 0.0);
        double potential = alert.optDouble("expansion_potential", 0.0);
        String label = alert.optString("potential_label", "EARLY_MOVE");
        JSONArray reasons = alert.optJSONArray("reasons");
        long detectedAt = alert.optLong("detected_at", alert.optLong("processed_at", 0L));
        long sentAt = System.currentTimeMillis();
        String detectedText = detectedAt > 0L ? formatTimestamp(detectedAt) : "غير متوفر";
        String sentText = formatTimestamp(sentAt);
        StringBuilder reasonText = new StringBuilder();
        if (reasons != null) {
            for (int i = 0; i < Math.min(4, reasons.length()); i++) {
                if (i > 0) reasonText.append(" • ");
                reasonText.append(reasons.optString(i, ""));
            }
        }

        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(
            this, ALERT_NOTIFICATION_BASE + Math.abs(symbol.hashCode()),
            open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        String title;
        int confirmationCount = 0;
        int leaderCount = 0;
        if ("EARLY_WAKE_ALERT".equals(event)) {
            title = "UP_MOVE".equals(direction)
                ? "RadarX • بداية حركة مبكرة"
                : "RadarX • تنبيه حركة مبكرة";
            JSONObject earlyWake = alert.optJSONObject("early_wake");
            leaderCount = earlyWake == null ? 0 : earlyWake.optInt("leader_count", 0);
        } else {
            title = "UP_MOVE".equals(direction)
                ? "RadarX • قبل الانفجار"
                : "RadarX • قبل الانفجار (اتجاه غير صاعد)";
            JSONObject preExplosion = alert.optJSONObject("pre_explosion");
            confirmationCount = preExplosion == null ? 0 : preExplosion.optInt("confirmation_count", 0);
        }
        String stageText = "EARLY_WAKE_ALERT".equals(event)
            ? leaderCount + " عوامل قيادة"
            : confirmationCount + " تأكيد";
        String body = symbol + " • حركة 24h " + scoreFmt.format(move) + "% • Score " +
            scoreFmt.format(score) + " • " + label + " • " + stageText;
        String timing = "وقت اكتشاف الخادم: " + detectedText +
            " • وقت إرسال الإشعار: " + sentText;

        Notification.Builder builder = notificationBuilder(CHANNEL_ALERTS)
            .setSmallIcon(com.radarx.app.R.drawable.ic_radarx)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(
                body + " • Expansion " + scoreFmt.format(potential) +
                " • " + (reasonText.length() > 0 ? reasonText : "توافق متعدد العوامل") +
                " • " + timing +
                " • الحالة: رادار مبكر متعدد المراحل؛ العملات الممتدة تُستبعد" +
                " • عند انقطاع الإنترنت: حُفظ التنبيه على الخادم ثم أُرسل عند عودة الاتصال" +
                " • ليس توقعًا مضمونًا"
            ))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_EVENT)
            .setPriority(Notification.PRIORITY_HIGH);

        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(ALERT_NOTIFICATION_BASE +
                Math.abs(symbol.hashCode() % 10000), builder.build());
        }
    }

    private static String formatTimestamp(long epochMs) {
        if (epochMs <= 0L) return "غير متوفر";
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US);
        format.setTimeZone(java.util.TimeZone.getDefault());
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
            .setContentTitle("RadarX • Move Radar 24/7")
            .setContentText("راداران مستقلان: Early-Wake + Strong-Move يعملان في الخلفية")
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setColor(Color.rgb(53, 201, 255))
            .setPriority(Notification.PRIORITY_LOW);

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(
                STATUS_NOTIFICATION_ID,
                builder.build(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            );
        } else if (Build.VERSION.SDK_INT >= 29) {
            startForeground(
                STATUS_NOTIFICATION_ID,
                builder.build(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            );
        } else {
            startForeground(STATUS_NOTIFICATION_ID, builder.build());
        }
        saveRunning(true);
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
