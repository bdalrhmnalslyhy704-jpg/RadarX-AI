package com.radarx.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

public final class RadarXFirebaseMessagingService extends FirebaseMessagingService {
    private static final String TAG = "RadarXPush";
    private static final String CHANNEL_ID = "radarx_radar_alerts_v2";

    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        RadarXPushRegistration.registerToken(getApplicationContext(), token);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        super.onMessageReceived(message);
        String serverAt = dataValue(message.getData(), "sent_at",
                dataValue(message.getData(), "server_processed_at", ""));
        try {
            long timestamp = Long.parseLong(serverAt);
            long latency = System.currentTimeMillis() - timestamp;
            if (timestamp > 0L && latency >= 0L) Log.i(TAG, "FCM_DEVICE_RECEIVED_LATENCY_MS=" + latency);
        } catch (NumberFormatException ignored) {
            // External provider acceptance is not a device-receipt guarantee; log only measured values.
        }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
            Log.i(TAG, "FCM_MESSAGE_SUPPRESSED_NOTIFICATION_PERMISSION");
            return;
        }
        createChannel();
        RemoteMessage.Notification remoteNotification = message.getNotification();
        String title = remoteNotification != null ? remoteNotification.getTitle() : null;
        String body = remoteNotification != null ? remoteNotification.getBody() : null;
        if (title == null || title.trim().isEmpty()) {
            title = dataValue(message.getData(), "title", "");
            if (title.trim().isEmpty()) {
                String radar = dataValue(message.getData(), "radar_name", "RadarX");
                String symbol = dataValue(message.getData(), "symbol", "تنبيه");
                title = radar + " • " + symbol;
            }
        }
        if (body == null || body.trim().isEmpty()) {
            body = dataValue(message.getData(), "body", "");
            if (body.trim().isEmpty()) {
                String symbol = dataValue(message.getData(), "symbol", "");
                String event = dataValue(message.getData(), "event", "اكتشاف جديد");
                body = (symbol.isEmpty() ? event : symbol + " • " + event)
                        + " | تداول ورقي فقط";
            }
        }

        String symbol = dataValue(message.getData(), "symbol", "");
        String radar = dataValue(message.getData(), "radar", "");
        Intent openApp = new Intent(this, MainActivity.class);
        openApp.setAction("com.radarx.app.OPEN_RADAR_ALERT");
        openApp.putExtra("radarx_push_open", true);
        openApp.putExtra("radarx_alert_symbol", symbol);
        openApp.putExtra("radarx_alert_radar", radar);
        openApp.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int requestCode = Math.abs((symbol + "|" + radar + "|" + message.getMessageId()).hashCode());
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this, requestCode, openApp,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setSmallIcon(android.R.drawable.stat_notify_more)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_EVENT)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE);

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(requestCode == 0 ? 42099 : requestCode, builder.build());
            Log.i(TAG, "FCM_NOTIFICATION_POSTED");
        }
    }

    private static String dataValue(java.util.Map<String, String> data, String key, String fallback) {
        String value = data == null ? null : data.get(key);
        return value == null ? fallback : value;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "تنبيهات رادارات RadarX", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("تنبيهات سوق Spot من رادارات RadarX");
        channel.enableVibration(true);
        manager.createNotificationChannel(channel);
    }
}
