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
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

public final class RadarXBackgroundMonitorService extends Service {
    public static final String ACTION_START = "com.radarx.app.action.START_BACKGROUND_MONITOR";
    public static final String ACTION_STOP = "com.radarx.app.action.STOP_BACKGROUND_MONITOR";

    private static final String TAG = "RadarXBackground";
    private static final String BACKEND =
            "https://radarx-ai-production.up.railway.app/api/market-radar?quote=USDT&limit=20";

    private static final String CHANNEL_STATUS = "radarx_background_status";
    private static final String CHANNEL_ALERTS = "radarx_prebreakout_alerts";
    private static final int STATUS_NOTIFICATION_ID = 41001;
    private static final int ALERT_NOTIFICATION_BASE = 42000;
    private static final long SCAN_MS = 90_000L;
    private static final long ALERT_COOLDOWN_MS = 30 * 60_000L;
    private static final double ALERT_THRESHOLD = 78.0;

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
        try {
            ScanResult result = scanMarket();
            if (result.bestSymbol != null) {
                updateStatus(
                    "مراقبة الخلفية • " + result.bestSymbol +
                    " • Early " + scoreFmt.format(result.bestScore)
                );
            } else {
                updateStatus("مراقبة الخلفية • لا يوجد مرشح مبكر صالح");
            }
        } catch (Throwable error) {
            Log.w(TAG, "Background scan failed", error);
            updateStatus("مراقبة الخلفية • تعذر الاتصال، إعادة المحاولة");
        }
    }

    private ScanResult scanMarket() throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(BACKEND).openConnection();
        try {
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(15_000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Accept-Encoding", "identity");

            int status = connection.getResponseCode();
            if (status != 200) throw new IllegalStateException("HTTP_" + status);

            byte[] body = readAll(connection.getInputStream());
            JSONObject root = new JSONObject(new String(body, StandardCharsets.UTF_8));
            if (root.optBoolean("meta", false)) {
                // no-op: retained for compatibility with malformed payloads.
            }
            JSONObject meta = root.optJSONObject("meta");
            if (meta == null ||
                !meta.optBoolean("live", false) ||
                !meta.optBoolean("paper_trading", true) ||
                meta.optBoolean("real_order_execution", false)) {
                throw new IllegalStateException("PAPER_ONLY_CONTRACT_INVALID");
            }

            JSONArray candidates = root.optJSONArray("candidates");
            if (candidates == null) throw new IllegalStateException("NO_CANDIDATES");

            ScanResult best = new ScanResult();
            for (int i = 0; i < candidates.length(); i++) {
                JSONObject c = candidates.optJSONObject(i);
                if (c == null) continue;
                CandidateScore scored = scoreCandidate(c);
                if (!scored.eligible) continue;

                if (scored.score > best.bestScore) {
                    best.bestScore = scored.score;
                    best.bestSymbol = scored.symbol;
                }
                if (scored.score >= ALERT_THRESHOLD) {
                    notifyEarlyAlert(scored);
                }
            }
            return best;
        } finally {
            connection.disconnect();
        }
    }

    private CandidateScore scoreCandidate(JSONObject c) {
        String symbol = c.optString("symbol", "").trim().toUpperCase();
        JSONObject fp = c.optJSONObject("pre_breakout_fingerprint");
        double dq = c.optDouble("data_quality", 0.0);
        double lq = c.optDouble("liquidity_quality", 0.0);
        if (symbol.isEmpty() || fp == null || dq < 70.0 || lq < 60.0) {
            return CandidateScore.ineligible(symbol);
        }

        String stage = fp.optString("stage", "NORMAL");
        if (!("BUILDING".equals(stage) || "PRE-BREAKOUT".equals(stage) ||
              "PRE_BREAKOUT".equals(stage))) {
            return CandidateScore.ineligible(symbol);
        }

        double fpScore = clamp(fp.optDouble("score", 0.0));
        double trapRisk = clamp(fp.optDouble("trapRisk", 100.0));
        double evidence = clamp(fp.optDouble("evidenceCount", 0.0) / 8.0 * 100.0);

        JSONObject evidenceRoot = fp.optJSONObject("evidence");
        double compression = statusScore(evidenceRoot, "compression");
        double volume = statusScore(evidenceRoot, "volume");
        double relativePower = statusScore(evidenceRoot, "relative_power");
        double orderFlow = statusScore(evidenceRoot, "order_flow");
        double structure = statusScore(evidenceRoot, "structure");
        double resistance = statusScore(evidenceRoot, "resistance");
        double regime = statusScore(evidenceRoot, "regime");

        double trapQuality = 100.0 - trapRisk;
        double confluence =
                compression * 0.18 +
                volume * 0.16 +
                relativePower * 0.14 +
                orderFlow * 0.14 +
                structure * 0.12 +
                resistance * 0.10 +
                regime * 0.06 +
                lq * 0.05 +
                dq * 0.05;

        double strategyBonus = strategyBonus(c.optJSONArray("accepted_strategies"));
        double earlyScore = clamp(
            fpScore * 0.38 +
            evidence * 0.16 +
            trapQuality * 0.14 +
            confluence * 0.22 +
            strategyBonus * 0.10
        );

        boolean eligible = trapRisk <= 45.0 && fp.optBoolean("detected", true) &&
                           fp.optInt("evidenceCount", 0) >= 5;
        String reasons = buildReasons(compression, volume, relativePower, orderFlow, structure, resistance);
        return new CandidateScore(true, eligible, symbol, earlyScore, trapRisk, fp.optInt("evidenceCount", 0), reasons);
    }

    private double strategyBonus(JSONArray strategies) {
        if (strategies == null) return 0.0;
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < strategies.length(); i++) ids.add(strategies.optString(i, ""));
        int hits = 0;
        String[] preferred = {
            "PRE_BREAKOUT_FINGERPRINT",
            "BOLLINGER_BAND_COMPRESSION",
            "VCP_PRE_BREAKOUT",
            "RELATIVE_VOLUME_AWAKENING",
            "EMA_RIBBON_ALIGNMENT",
            "VWAP_POSITION"
        };
        for (String id : preferred) if (ids.contains(id)) hits++;
        return clamp(hits / (double) preferred.length * 100.0);
    }

    private double statusScore(JSONObject root, String key) {
        if (root == null) return 50.0;
        JSONObject item = root.optJSONObject(key);
        if (item == null) return 50.0;
        String status = item.optString("status", "UNKNOWN").toUpperCase();
        if (status.contains("STRONG") || status.contains("CONFIRMED") || status.contains("INCREAS")) return 100.0;
        if (status.contains("OK") || status.contains("PRESENT") || status.contains("RISING") ||
            status.contains("HOLD") || status.contains("TEST")) return 82.0;
        if (status.contains("BUILD") || status.contains("EMERGING") || status.contains("AWAKEN")) return 78.0;
        if (status.contains("WEAK") || status.contains("LOW")) return 35.0;
        if (status.contains("FAIL") || status.contains("HIGH_RISK")) return 15.0;
        return 55.0;
    }

    private String buildReasons(
        double compression, double volume, double relativePower,
        double orderFlow, double structure, double resistance
    ) {
        StringBuilder b = new StringBuilder();
        appendReason(b, compression >= 78, "ضغط");
        appendReason(b, volume >= 78, "استيقاظ حجم");
        appendReason(b, relativePower >= 78, "قوة نسبية");
        appendReason(b, orderFlow >= 78, "تدفق شراء");
        appendReason(b, structure >= 78, "هيكل");
        appendReason(b, resistance >= 78, "مقاومة تُختبر");
        return b.length() == 0 ? "توافق مبكر" : b.toString();
    }

    private void appendReason(StringBuilder b, boolean ok, String text) {
        if (!ok) return;
        if (b.length() > 0) b.append(" • ");
        b.append(text);
    }

    private void notifyEarlyAlert(CandidateScore s) {
        SharedPreferences prefs = prefs();
        long now = System.currentTimeMillis();
        long last = prefs.getLong("alert_" + s.symbol, 0L);
        if (now - last < ALERT_COOLDOWN_MS) return;
        prefs.edit().putLong("alert_" + s.symbol, now).apply();

        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(
            this, ALERT_NOTIFICATION_BASE + Math.abs(s.symbol.hashCode()),
            open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ALERTS)
            .setSmallIcon(com.radarx.app.R.drawable.ic_radarx)
            .setContentTitle("RadarX • إنذار ما قبل الاختراق")
            .setContentText(
                s.symbol + " • Early " + scoreFmt.format(s.score) +
                " • Evidence " + s.evidence + "/8"
            )
            .setStyle(new Notification.BigTextStyle().bigText(
                "بصمة مبكرة مرشحة قبل الحركة الكبيرة. " + s.reasons +
                " • Trap " + scoreFmt.format(s.trapRisk) + "%"
            ))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setColor(Color.rgb(53, 201, 255))
            .setCategory(Notification.CATEGORY_EVENT)
            .setPriority(Notification.PRIORITY_HIGH);

        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(ALERT_NOTIFICATION_BASE + Math.abs(s.symbol.hashCode() % 10000), builder.build());
        }
    }

    private void startAsForeground() {
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_STATUS)
            .setSmallIcon(com.radarx.app.R.drawable.ic_radarx)
            .setContentTitle("RadarX • مراقبة الخلفية")
            .setContentText("يفحص السوق بحثًا عن بصمات ما قبل الاختراق")
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setColor(Color.rgb(53, 201, 255))
            .setPriority(Notification.PRIORITY_LOW);

        if (Build.VERSION.SDK_INT >= 29) {
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
        status.setDescription("حالة مراقبة السوق في الخلفية");
        manager.createNotificationChannel(status);

        NotificationChannel alerts = new NotificationChannel(
            CHANNEL_ALERTS, "RadarX Pre-Breakout Alerts", NotificationManager.IMPORTANCE_HIGH
        );
        alerts.setDescription("تنبيهات إنذار مبكر قبل اختراق محتمل");
        manager.createNotificationChannel(alerts);
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
