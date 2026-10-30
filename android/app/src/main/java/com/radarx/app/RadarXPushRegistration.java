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
import java.net.URLEncoder;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class RadarXPushRegistration {
    private static final String TAG = "RadarXPush";
    private static final String PREFS = "radarx_push";
    private static final String INSTALLATION_ID = "installation_id";
    private static final String REGISTRATION_STATE = "registration_state";
    private static final String REGISTRATION_UPDATED_AT = "registration_updated_at";
    private static final String TEST_STATE = "test_state";
    private static final String TEST_UPDATED_AT = "test_updated_at";
    private static final String TEST_EVENT_ID = "test_event_id";
    private static final String TEST_ID = "test_id";
    private static final String DELIVERY_VERIFIED = "delivery_verified";
    private static volatile long lastSyncAttemptAtMs = 0L;
    private static final long SYNC_RETRY_MIN_INTERVAL_MS = 60_000L;
    private static final String BACKEND = "https://radarx-backend.dhdtech.site";
    private static final ExecutorService NETWORK = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "RadarX-Push-Registration");
        thread.setDaemon(true);
        return thread;
    });

    private RadarXPushRegistration() {}

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static void registrationState(Context context, String state) {
        preferences(context).edit().putString(REGISTRATION_STATE, state)
                .putLong(REGISTRATION_UPDATED_AT, System.currentTimeMillis()).apply();
    }

    private static void testState(Context context, String state) {
        preferences(context).edit().putString(TEST_STATE, state)
                .putLong(TEST_UPDATED_AT, System.currentTimeMillis()).apply();
    }

    static String statusJson(Context rawContext) {
        Context context = rawContext.getApplicationContext();
        SharedPreferences prefs = preferences(context);
        JSONObject value = new JSONObject();
        try {
            String state = prefs.getString(REGISTRATION_STATE, "NOT_CHECKED");
            value.put("registration_state", state);
            value.put("registered", "REGISTERED".equals(state));
            value.put("notifications_allowed", notificationsAllowed(context));
            value.put("firebase_configured", !FirebaseApp.getApps(context).isEmpty());
            value.put("registration_updated_at", prefs.getLong(REGISTRATION_UPDATED_AT, 0L));
            value.put("test_state", prefs.getString(TEST_STATE, "NOT_TESTED"));
            value.put("test_updated_at", prefs.getLong(TEST_UPDATED_AT, 0L));
            value.put("delivery_verified", prefs.getBoolean(DELIVERY_VERIFIED, false));
        } catch (Exception ignored) {
            try { value.put("registration_state", "STATUS_UNAVAILABLE"); } catch (Exception ignoredAgain) {}
        }
        return value.toString();
    }

    static void refreshServerStatus(Context rawContext) {
        Context context = rawContext.getApplicationContext();
        if (FirebaseApp.getApps(context).isEmpty()) {
            registrationState(context, "FIREBASE_NOT_CONFIGURED");
            return;
        }
        NETWORK.execute(() -> {
            HttpURLConnection connection = null;
            try {
                SharedPreferences prefs = preferences(context);
                String installationId = installationId(context);
                String eventId = prefs.getString(TEST_EVENT_ID, "");
                String query = "installation_id=" + URLEncoder.encode(installationId, "UTF-8");
                if (eventId != null && !eventId.isEmpty()) {
                    query += "&event_id=" + URLEncoder.encode(eventId, "UTF-8");
                }
                connection = (HttpURLConnection) new URL(BACKEND + "/api/push/device/status?" + query).openConnection();
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(3500);
                connection.setReadTimeout(4500);
                connection.setInstanceFollowRedirects(false);
                int status = connection.getResponseCode();
                InputStream input = status >= 200 && status < 400
                        ? connection.getInputStream() : connection.getErrorStream();
                String response = readResponse(input);
                if (status == 200) {
                    JSONObject data = new JSONObject(response);
                    boolean registered = data.optBoolean("registered", false);
                    registrationState(context, registered ? "REGISTERED" : "DEVICE_NOT_REGISTERED");
                    boolean delivered = data.optBoolean("delivery_verified", false);
                    if (delivered) {
                        prefs.edit().putBoolean(DELIVERY_VERIFIED, true).apply();
                        testState(context, "DEVICE_RECEIPT_VERIFIED");
                    } else if (!prefs.getString(TEST_EVENT_ID, "").isEmpty()
                            && "TEST_SENT_TO_FCM".equals(prefs.getString(TEST_STATE, ""))) {
                        // FCM accepted the send, but the device receipt has not yet arrived.
                        prefs.edit().putBoolean(DELIVERY_VERIFIED, false).apply();
                    }
                } else if (status == 404) {
                    registrationState(context, "STATUS_ENDPOINT_UNAVAILABLE");
                } else {
                    registrationState(context, "STATUS_CHECK_HTTP_" + status);
                }
            } catch (Exception error) {
                registrationState(context, "STATUS_CHECK_FAILED");
                Log.w(TAG, "FCM_STATUS_CHECK_FAILED");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    static void requestTestPush(Context rawContext) {
        Context context = rawContext.getApplicationContext();
        if (!notificationsAllowed(context)) {
            testState(context, "NOTIFICATION_PERMISSION_REQUIRED");
            return;
        }
        if (FirebaseApp.getApps(context).isEmpty()) {
            testState(context, "FIREBASE_NOT_CONFIGURED");
            return;
        }
        NETWORK.execute(() -> {
            HttpURLConnection connection = null;
            try {
                String installationId = installationId(context);
                String testId = UUID.randomUUID().toString().replace("-", "");
                JSONObject body = new JSONObject();
                body.put("installation_id", installationId);
                body.put("test_id", testId);
                connection = (HttpURLConnection) new URL(BACKEND + "/api/push/device/test").openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(3500);
                connection.setReadTimeout(5500);
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
                String response = readResponse(status >= 200 && status < 400
                        ? connection.getInputStream() : connection.getErrorStream());
                if (status == 202) {
                    JSONObject data = new JSONObject(response);
                    String eventId = data.optString("event_id", "");
                    preferences(context).edit()
                            .putString(TEST_ID, testId)
                            .putString(TEST_EVENT_ID, eventId)
                            .putBoolean(DELIVERY_VERIFIED, false)
                            .apply();
                    testState(context, "TEST_SENT_TO_FCM");
                    refreshServerStatus(context);
                } else if (status == 409) {
                    testState(context, "NO_ACTIVE_FCM_DEVICE");
                    registrationState(context, "DEVICE_NOT_REGISTERED");
                } else if (status == 429) {
                    testState(context, "TEST_RATE_LIMITED");
                } else {
                    testState(context, "TEST_REJECTED_HTTP_" + status);
                }
            } catch (Exception error) {
                testState(context, "TEST_REQUEST_FAILED");
                Log.w(TAG, "FCM_TEST_REQUEST_FAILED");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private static String readResponse(InputStream input) throws Exception {
        if (input == null) return "";
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[1024];
            int count;
            while ((count = stream.read(buffer)) != -1) {
                output.write(buffer, 0, count);
                if (output.size() > 16 * 1024) throw new IllegalStateException("FCM_STATUS_RESPONSE_TOO_LARGE");
            }
            return output.toString("UTF-8");
        }
    }

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
            registrationState(context, "NOTIFICATION_PERMISSION_REQUIRED");
            Log.i(TAG, "FCM_REGISTRATION_SKIPPED_NOTIFICATION_PERMISSION");
            return;
        }
        if (FirebaseApp.getApps(context).isEmpty()) {
            registrationState(context, "FIREBASE_NOT_CONFIGURED");
            // The checked-in source intentionally contains no Firebase project
            // credentials. Existing polling/local notifications remain available
            // until the operator adds this app's google-services.json.
            Log.i(TAG, "FCM_NOT_CONFIGURED_LOCAL_NOTIFICATION_FALLBACK_ACTIVE");
            return;
        }
        synchronized (RadarXPushRegistration.class) {
            long now = System.currentTimeMillis();
            if (now - lastSyncAttemptAtMs < SYNC_RETRY_MIN_INTERVAL_MS) {
                Log.i(TAG, "FCM_REGISTRATION_SYNC_THROTTLED");
                return;
            }
            lastSyncAttemptAtMs = now;
        }
        registrationState(context, "FETCHING_FCM_TOKEN");
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (!task.isSuccessful() || task.getResult() == null || task.getResult().isEmpty()) {
                    registrationState(context, "FCM_TOKEN_FETCH_FAILED");
                    Log.w(TAG, "FCM_TOKEN_FETCH_FAILED");
                    return;
                }
                registerToken(context, task.getResult());
            });
        } catch (RuntimeException error) {
            registrationState(context, "FCM_TOKEN_FETCH_UNAVAILABLE");
            Log.w(TAG, "FCM_TOKEN_FETCH_UNAVAILABLE", error);
        }
    }

    static void acknowledgeReceipt(Context rawContext, String eventId, String event, String symbol, String radar) {
        Context context = rawContext.getApplicationContext();
        if (eventId == null || eventId.trim().isEmpty() || FirebaseApp.getApps(context).isEmpty()) return;
        final String safeEventId = eventId.trim();
        if (safeEventId.length() > 256) return;
        NETWORK.execute(() -> {
            for (int attempt = 1; attempt <= 3; attempt++) {
                HttpURLConnection connection = null;
                try {
                    JSONObject body = new JSONObject();
                    body.put("installation_id", installationId(context));
                    body.put("event_id", safeEventId);
                    body.put("device_received_at_ms", System.currentTimeMillis());
                    if (event != null && !event.isEmpty()) body.put("event", event.substring(0, Math.min(120, event.length())));
                    if (symbol != null && !symbol.isEmpty()) body.put("symbol", symbol.substring(0, Math.min(40, symbol.length())));
                    if (radar != null && !radar.isEmpty()) body.put("radar", radar.substring(0, Math.min(120, radar.length())));
                    connection = (HttpURLConnection) new URL(BACKEND + "/api/push/device/receipt").openConnection();
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
                        Log.i(TAG, "FCM_DEVICE_RECEIPT_ACKNOWLEDGED");
                        return;
                    }
                    // A very fast FCM delivery can race the server's notification-audit write.
                    // Retry transient/unmatched responses briefly while the FCM message is fresh.
                    if (status != 404 && status != 429 && status < 500) {
                        Log.w(TAG, "FCM_DEVICE_RECEIPT_REJECTED_HTTP_" + status);
                        return;
                    }
                } catch (Exception error) {
                    // Never log the event payload or the device's FCM credential.
                    Log.w(TAG, "FCM_DEVICE_RECEIPT_ATTEMPT_FAILED");
                } finally {
                    if (connection != null) connection.disconnect();
                }
                if (attempt < 3) {
                    try { Thread.sleep(500L * attempt); }
                    catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); return; }
                }
            }
            Log.w(TAG, "FCM_DEVICE_RECEIPT_ACK_FAILED");
        });
    }

    static void registerToken(Context rawContext, String token) {
        Context context = rawContext.getApplicationContext();
        if (token == null || token.isEmpty() || !notificationsAllowed(context)
                || FirebaseApp.getApps(context).isEmpty()) return;
        final String installationId = installationId(context);
        registrationState(context, "REGISTERING_DEVICE");
        NETWORK.execute(() -> {
            for (int attempt = 1; attempt <= 4; attempt++) {
                HttpURLConnection connection = null;
                boolean retry = false;
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
                        registrationState(context, "REGISTERED");
                        Log.i(TAG, "FCM_DEVICE_REGISTERED");
                        refreshServerStatus(context);
                        return;
                    }
                    if (status == 503) {
                        registrationState(context, "FCM_PROVIDER_NOT_READY");
                        Log.i(TAG, "FCM_PROVIDER_NOT_READY; LOCAL_NOTIFICATION_FALLBACK_ACTIVE");
                    } else {
                        registrationState(context, "REGISTRATION_HTTP_" + status);
                        Log.w(TAG, "FCM_DEVICE_REGISTRATION_HTTP_" + status + " attempt=" + attempt);
                    }
                    retry = status == 429 || status >= 500;
                    if (!retry) return;
                } catch (Exception error) {
                    registrationState(context, "REGISTRATION_NETWORK_RETRY");
                    // Never log the registration token; it is a send credential.
                    Log.w(TAG, "FCM_DEVICE_REGISTRATION_ATTEMPT_FAILED attempt=" + attempt);
                    retry = true;
                } finally {
                    if (connection != null) connection.disconnect();
                }
                if (retry && attempt < 4) {
                    try { Thread.sleep(750L * attempt * attempt); }
                    catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
            }
            registrationState(context, "REGISTRATION_RETRIES_EXHAUSTED");
            Log.w(TAG, "FCM_DEVICE_REGISTRATION_RETRIES_EXHAUSTED; LOCAL_NOTIFICATION_FALLBACK_ACTIVE");
        });
    }
}
