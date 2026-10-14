package com.radarx.ai;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.io.IOException;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Registers this Android installation with RadarX's existing FCM device endpoint.
 * This class never sends FCM tokens to logs or returns them to the app UI.
 */
final class FcmDeviceRegistrar {
    private static final String TAG = "RadarXFCM";
    private static final String SERVER_ORIGIN =
            "https://radarx-ai-triple-production.up.railway.app";
    private static final String REGISTER_URL = SERVER_ORIGIN + "/api/push/device/register";
    private static final String DEVICE_URL = SERVER_ORIGIN + "/api/push/device/";
    private static final String PREFS = "radarx_fcm_device";
    private static final String INSTALLATION_ID = "installation_id";
    private static final String REGISTERED_TOKEN = "registered_token";
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static final OkHttpClient HTTP = new OkHttpClient.Builder()
            .connectTimeout(5L, TimeUnit.SECONDS)
            .readTimeout(8L, TimeUnit.SECONDS)
            .writeTimeout(8L, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build();

    private FcmDeviceRegistrar() {}

    static void syncIfAllowed(Context context) {
        Context app = context.getApplicationContext();
        if (!notificationsEnabled(app)) {
            unregisterIfNeeded(app);
            return;
        }

        final FirebaseApp firebaseApp;
        try {
            if (FirebaseApp.getApps(app).isEmpty()) return;
            firebaseApp = FirebaseApp.getInstance();
        } catch (IllegalStateException notConfigured) {
            // A project-specific app/google-services.json is required to activate FCM.
            // Keep non-FCM builds working; never crash RadarX because config is absent.
            return;
        }

        FirebaseMessaging.getInstance(firebaseApp).getToken()
                .addOnSuccessListener(token -> registerToken(app, token))
                .addOnFailureListener(error ->
                        Log.w(TAG, "Could not obtain Firebase registration token"));
    }

    static void registerToken(Context context, String token) {
        Context app = context.getApplicationContext();
        if (token == null || token.trim().length() < 100 || !notificationsEnabled(app)) {
            if (!notificationsEnabled(app)) unregisterIfNeeded(app);
            return;
        }

        SharedPreferences prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String registered = prefs.getString(REGISTERED_TOKEN, "");
        if (token.equals(registered)) return;

        String installationId = getInstallationId(app);
        JSONObject payload = new JSONObject();
        try {
            payload.put("installation_id", installationId);
            payload.put("token", token);
            payload.put("notifications_enabled", true);
        } catch (Exception ignored) {
            return;
        }

        RequestBody body = RequestBody.create(JSON, payload.toString());
        Request request = new Request.Builder()
                .url(REGISTER_URL)
                .post(body)
                .header("Accept", "application/json")
                .build();

        HTTP.newCall(request).enqueue(new Callback() {
            @Override public void onFailure(Call call, IOException error) {
                // No token or credential details are written to logs.
                Log.w(TAG, "RadarX FCM device registration request failed");
            }

            @Override public void onResponse(Call call, Response response) {
                try (Response result = response) {
                    if (result.isSuccessful()) {
                        prefs.edit().putString(REGISTERED_TOKEN, token).apply();
                    } else {
                        Log.w(TAG, "RadarX FCM device registration rejected: HTTP " + result.code());
                    }
                }
            }
        });
    }

    static boolean notificationsEnabled(Context context) {
        if (Build.VERSION.SDK_INT >= 33 &&
                context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        NotificationManager manager = (NotificationManager)
                context.getSystemService(Context.NOTIFICATION_SERVICE);
        return manager != null && manager.areNotificationsEnabled();
    }

    private static synchronized String getInstallationId(Context context) {
        SharedPreferences prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String current = prefs.getString(INSTALLATION_ID, "");
        if (current.matches("(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")) {
            return current;
        }
        String generated = UUID.randomUUID().toString();
        prefs.edit().putString(INSTALLATION_ID, generated).apply();
        return generated;
    }

    private static void unregisterIfNeeded(Context context) {
        Context app = context.getApplicationContext();
        SharedPreferences prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (prefs.getString(REGISTERED_TOKEN, "").isEmpty()) return;

        String installationId = getInstallationId(app);
        Request request = new Request.Builder()
                .url(DEVICE_URL + installationId)
                .delete()
                .header("Accept", "application/json")
                .build();
        HTTP.newCall(request).enqueue(new Callback() {
            @Override public void onFailure(Call call, IOException error) {
                Log.w(TAG, "RadarX FCM device removal request failed");
            }

            @Override public void onResponse(Call call, Response response) {
                try (Response result = response) {
                    if (result.isSuccessful() || result.code() == 404) {
                        prefs.edit().remove(REGISTERED_TOKEN).apply();
                    }
                }
            }
        });
    }
}
