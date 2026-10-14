package com.radarx.ai;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Displays only RadarX's data-only FCM payloads. The backend marks every payload
 * paper-only; this service does not perform or trigger any trading action.
 */
public final class RadarXFirebaseMessagingService extends FirebaseMessagingService {
    private static final String CHANNEL_ID = "radarx-alerts";

    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        FcmDeviceRegistrar.registerToken(getApplicationContext(), token);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        super.onMessageReceived(message);
        Map<String, String> data = message.getData();
        if (data == null || data.isEmpty()) return;

        String type = data.get("type");
        boolean supportedType = "RADARX_RADAR_ALERT".equals(type)
                || "RADARX_SIGNAL".equals(type)
                || "TEST_PUSH_ONLY".equals(type);
        if (!supportedType) return;
        if (!"true".equals(data.get("paper_trading"))
                || !"false".equals(data.get("real_order_execution"))) return;
        if (!notificationsAllowed()) return;

        String title = nonEmpty(data.get("title"), "RadarX • تنبيه جديد");
        String body = nonEmpty(data.get("body"), "وصل تنبيه جديد من RadarX");
        NotificationManager manager = (NotificationManager)
                getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;

        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "RadarX Alerts",
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("تنبيهات RadarX المبكرة ومخاطر السوق");
            channel.enableVibration(true);
            manager.createNotificationChannel(channel);
        }

        Intent openApp = new Intent(this, MainActivity.class);
        openApp.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (data.get("symbol") != null) {
            openApp.putExtra("radarx_notification_symbol", data.get("symbol"));
        }
        if (type != null) {
            openApp.putExtra("radarx_notification_type", type);
        }

        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        String key = nonEmpty(data.get("event_id"), nonEmpty(data.get("signal_id"),
                nonEmpty(data.get("test_id"), Long.toString(System.currentTimeMillis()))));
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this, key.hashCode() & 0x7fffffff, openApp, pendingFlags
        );

        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setPriority(Notification.PRIORITY_HIGH)
                .setVibrate(new long[]{0, 120, 80, 180});

        int notificationId = key.hashCode() & 0x7fffffff;
        manager.notify(notificationId == 0 ? 1 : notificationId, builder.build());
    }

    private boolean notificationsAllowed() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) return false;
        NotificationManager manager = (NotificationManager)
                getSystemService(NOTIFICATION_SERVICE);
        return manager != null && manager.areNotificationsEnabled();
    }

    private static String nonEmpty(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }
}
