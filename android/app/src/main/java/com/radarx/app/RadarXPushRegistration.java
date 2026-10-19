package com.radarx.app;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class RadarXPushRegistration {
    private static final String TAG = "RadarXPush";
    private static final String PREFS = "radarx_push";
    private static final String INSTALLATION_ID = "installation_id";
    private static final String BACKEND = BuildConfig.RADARX_BACKEND_ORIGIN;
    private static final ExecutorService NETWORK = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "RadarX-Push-Registration");
        thread.setDaemon(true);
        return thread;
    });

    private RadarXPushRegistration() {}

    static boolean notificationsAllowed(Context context) {
        return Build.VERSION.SDK_INT < 33
                || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED;
    }

    static String installationId(Context context) {
        SharedPreferences prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String current = prefs.getString(INSTALLATION_ID, "");
        if (current != null && current.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) {
            return current;
        }
        String created = UUID.randomUUID().toString();
        prefs.edit().putString(INSTALLATION_ID, created).commit();
        return created;
    }

    static void syncIfConfigured(Context rawContext) {
        Context context = rawContext.getApplicationContext();
        if (!notificationsAllowed(context)) {
            Log.i(TAG, "FCM_REGISTRATION_SKIPPED_NOTIFICATION_PERMISSION");
            return;
        }
        if (FirebaseApp.getApps(context).isEmpty()) {
            // The checked-in source intentionally contains no Firebase project
            // credentials. Existing polling/local notifications remain available
            // until the operator adds this app's google-services.json.
            Log.i(TAG, "FCM_NOT_CONFIGURED_LOCAL_NOTIFICATION_FALLBACK_ACTIVE");
            return;
        }
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (!task.isSuccessful() || task.getResult() == null || task.getResult().isEmpty()) {
                    Log.w(TAG, "FCM_TOKEN_FETCH_FAILED");
                    return;
                }
                registerToken(context, task.getResult());
            });
        } catch (RuntimeException error) {
            Log.w(TAG, "FCM_TOKEN_FETCH_UNAVAILABLE", error);
        }
    }

    static void registerToken(Context rawContext, String token) {
        Context context = rawContext.getApplicationContext();
        if (token == null || token.isEmpty() || !notificationsAllowed(context)
                || FirebaseApp.getApps(context).isEmpty()) return;
        final String installationId = installationId(context);
        NETWORK.execute(() -> {
            HttpURLConnection connection = null;
            try {
                JSONObject body = new JSONObject();
                body.put("installation_id", installationId);
                body.put("token", token);
                body.put("notifications_enabled", true);
                connection = (HttpURLConnection) new URL(BACKEND + "/api/push/device/register").openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(3500);
                connection.setReadTimeout(4500);
                connection.setInstanceFollowRedirects(false);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                connection.setRequestProperty("Accept", "application/json");
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(bytes);
                }
                int status = connection.getResponseCode();
                if (status == 200 || status == 201) {
                    Log.i(TAG, "FCM_DEVICE_REGISTERED");
                } else if (status == 503) {
                    Log.i(TAG, "FCM_PROVIDER_NOT_READY; LOCAL_NOTIFICATION_FALLBACK_ACTIVE");
                } else {
                    Log.w(TAG, "FCM_DEVICE_REGISTRATION_HTTP_" + status);
                }
            } catch (Exception error) {
                // Never log the registration token; it is a send credential.
                Log.w(TAG, "FCM_DEVICE_REGISTRATION_FAILED");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }
}
