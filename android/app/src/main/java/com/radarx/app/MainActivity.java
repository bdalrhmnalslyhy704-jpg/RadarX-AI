package com.radarx.app;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.SharedPreferences;
import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Build;
import android.Manifest;
import android.widget.Toast;
import android.util.Log;
import android.view.View;
import android.webkit.SslErrorHandler;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

@SuppressLint("SetJavaScriptEnabled")
public final class MainActivity extends Activity {
    private static final String APP_URL =
            "https://appassets.androidplatform.net/assets/index.html";
    private static final String APP_ORIGIN =
            "https://appassets.androidplatform.net";
    private static final String BACKEND_ORIGIN =
            "https://radarx-ai-triple-production.up.railway.app";
    private static final String BACKEND_FALLBACK_ORIGIN =
            "https://radarx-ai-production.up.railway.app";
    private static final int REQUEST_POST_NOTIFICATIONS = 7301;
    private static final String PREFS_BACKGROUND = "radarx_background";
    private static final String PREF_AUTO_ENABLED = "auto_enabled";
    private static final String PREF_NOTIFICATION_PROMPTED = "notification_permission_prompted";
    private boolean pendingBackgroundStart;

    private WebView webView;
    private WebViewAssetLoader assetLoader;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().setStatusBarColor(Color.rgb(7, 16, 24));
        getWindow().setNavigationBarColor(Color.rgb(7, 16, 24));

        assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(7, 16, 24));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        webView.addJavascriptInterface(new RadarXSmokeBridge(), "RadarXSmoke");
        webView.addJavascriptInterface(new RadarXNativeBridge(), "RadarXNative");
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                Log.i("RadarXWeb", consoleMessage.messageLevel() + ":"
                        + consoleMessage.message() + "@" + consoleMessage.sourceId()
                        + ":" + consoleMessage.lineNumber());
                return true;
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isAllowedAppUri(request.getUrl());
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse local = assetLoader.shouldInterceptRequest(request.getUrl());
                if (local != null) return local;

                // WebView asset origins cannot rely on CORS headers from the public API.
                // Proxy only the two explicitly allow-listed RadarX HTTPS GET endpoints.
                if (isAllowedBackendUri(request.getUrl())) {
                    if (!"GET".equalsIgnoreCase(request.getMethod())) {
                        return blockedResponse("Read-only backend proxy allows GET only");
                    }
                    return fetchBackend(request);
                }
                return null;
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                showErrorPage("تعذر الاتصال الآمن بالخادم، تحقق من الإنترنت.");
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showErrorPage("تعذر تحميل واجهة RadarX.");
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
                if (request.isForMainFrame()) {
                    showErrorPage("تعذر تحميل واجهة RadarX (" + errorResponse.getStatusCode() + ").");
                }
            }
        });

        setContentView(webView);
        webView.loadUrl(APP_URL);

        // Start monitoring from the native Activity lifecycle, not from page readiness.
        // WebView rendering or a pending notification permission must not gate scanner startup.
        ensureContinuousMonitoring();
        webView.postDelayed(this::ensureContinuousMonitoring, 1400);
    }

    private static boolean isAllowedAppUri(Uri uri) {
        return uri != null
                && "https".equalsIgnoreCase(uri.getScheme())
                && APP_ORIGIN.equalsIgnoreCase(uri.getScheme() + "://" + uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    private static boolean isAllowedBackendUri(Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())) return false;
        String origin = uri.getScheme() + "://" + uri.getHost();
        return (BACKEND_ORIGIN.equalsIgnoreCase(origin) || BACKEND_FALLBACK_ORIGIN.equalsIgnoreCase(origin))
                && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    private static WebResourceResponse fetchBackend(WebResourceRequest request) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(request.getUrl().toString());
            if (!isAllowedBackendUri(Uri.parse(request.getUrl().toString()))) {
                return blockedResponse("Backend destination blocked");
            }
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(60000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Accept-Encoding", "identity");

            int status = connection.getResponseCode();
            InputStream source = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            byte[] body = source == null ? new byte[0] : readAll(source);
            if (source != null) source.close();

            String contentType = connection.getContentType();
            String mime = "application/json";
            String charset = "UTF-8";
            if (contentType != null && !contentType.isEmpty()) {
                String[] parts = contentType.split(";");
                if (parts.length > 0 && parts[0].contains("/")) mime = parts[0].trim();
                for (String part : parts) {
                    String p = part.trim();
                    if (p.toLowerCase().startsWith("charset=")) charset = p.substring(8).trim();
                }
            }

            Map<String, String> headers = new HashMap<>();
            headers.put("Access-Control-Allow-Origin", APP_ORIGIN);
            headers.put("Access-Control-Allow-Methods", "GET, OPTIONS");
            headers.put("Cache-Control", "no-store");
            headers.put("Vary", "Origin");
            return new WebResourceResponse(
                    mime,
                    charset,
                    status,
                    connection.getResponseMessage() == null ? "HTTP " + status : connection.getResponseMessage(),
                    headers,
                    new ByteArrayInputStream(body)
            );
        } catch (Exception error) {
            String body = "{\"status\":503,\"error\":\"BACKEND_CONNECTION_FAILED\"}";
            Map<String, String> headers = new HashMap<>();
            headers.put("Access-Control-Allow-Origin", APP_ORIGIN);
            headers.put("Cache-Control", "no-store");
            return new WebResourceResponse(
                    "application/json",
                    "UTF-8",
                    503,
                    "Backend Unavailable",
                    headers,
                    new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8))
            );
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static byte[] readAll(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer)) != -1) {
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private static WebResourceResponse blockedResponse(String message) {
        return new WebResourceResponse(
                "text/plain",
                "UTF-8",
                403,
                "Blocked",
                null,
                new ByteArrayInputStream(message.getBytes(StandardCharsets.UTF_8))
        );
    }

    private void showErrorPage(String message) {
        if (webView == null) return;
        String html = "<!doctype html><html lang='ar' dir='rtl'><meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<style>body{margin:0;min-height:100vh;background:#071018;color:#eaf5f8;font-family:system-ui;padding:24px;box-sizing:border-box}"
                + ".card{max-width:520px;margin:18vh auto 0;background:#0b1820;border:1px solid #9b4651;border-radius:18px;padding:20px}"
                + "button{width:100%;min-height:50px;border:1px solid #2a4c58;border-radius:12px;background:#08131a;color:#fff;font:inherit;font-weight:900;margin-top:14px}</style>"
                + "<div class='card'><h2>RadarX</h2><p>" + message + "</p>"
                + "<p>تعذر الاتصال بالخادم، تحقق من الإنترنت</p>"
                + "<button onclick=\"location.href='" + APP_URL + "'\">إعادة المحاولة</button></div></html>";
        webView.loadDataWithBaseURL(APP_URL, html, "text/html", "UTF-8", null);
    }


    private void startBackgroundMonitor() {
        startBackgroundMonitor(true);
    }

    private void startBackgroundMonitor(boolean userInitiated) {
        Log.i("RadarXBackground", userInitiated ? "BACKGROUND_START_REQUEST" : "BACKGROUND_AUTO_START_REQUEST");
        getSharedPreferences(PREFS_BACKGROUND, MODE_PRIVATE).edit().putBoolean(PREF_AUTO_ENABLED, true).apply();
        try {
            Intent intent = new Intent(this, RadarXBackgroundMonitorService.class);
            intent.setAction(RadarXBackgroundMonitorService.ACTION_START);
            if (Build.VERSION.SDK_INT >= 26) {
                startForegroundService(intent);
            } else {
                startService(intent);
            }
            if (userInitiated) {
                Toast.makeText(this, "تم تشغيل مراقبة RadarX في الخلفية", Toast.LENGTH_SHORT).show();
            }
        } catch (Exception error) {
            Log.e("RadarXBackground", "Unable to start background monitor", error);
            Toast.makeText(this, "تعذر تشغيل المراقبة الخلفية", Toast.LENGTH_LONG).show();
        }
    }

    private void requestNotificationPermissionAndStart() {
        if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            pendingBackgroundStart = true;
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_POST_NOTIFICATIONS);
            return;
        }
        startBackgroundMonitor(true);
    }

    private void ensureContinuousMonitoring() {
        Log.i("RadarXBackground", "BACKGROUND_AUTO_START_CHECK");
        if (RadarXBackgroundMonitorService.isRunning(this)) {
            Log.i("RadarXBackground", "BACKGROUND_SERVICE_ALREADY_RUNNING");
            return;
        }
        SharedPreferences prefs = getSharedPreferences(PREFS_BACKGROUND, MODE_PRIVATE);
        if (!prefs.getBoolean(PREF_AUTO_ENABLED, true)) return;
        if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            if (!prefs.getBoolean(PREF_NOTIFICATION_PROMPTED, false)) {
                prefs.edit().putBoolean(PREF_NOTIFICATION_PROMPTED, true).apply();
                // Ask for notification permission, but do not block local monitoring.
                // Android can run a foreground service without drawer notifications;
                // queued alerts can be delivered once the user grants notification access.
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_POST_NOTIFICATIONS);
            }
            Log.i("RadarXBackground", "POST_NOTIFICATIONS_MISSING_MONITOR_STILL_STARTED");
            startBackgroundMonitor(false);
            return;
        }
        startBackgroundMonitor(false);
    }

    private void stopBackgroundMonitor() {
        getSharedPreferences(PREFS_BACKGROUND, MODE_PRIVATE).edit().putBoolean(PREF_AUTO_ENABLED, false).apply();
        Intent intent = new Intent(this, RadarXBackgroundMonitorService.class);
        intent.setAction(RadarXBackgroundMonitorService.ACTION_STOP);
        if (Build.VERSION.SDK_INT >= 26) {
            startService(intent);
        } else {
            startService(intent);
        }
        Toast.makeText(this, "تم إيقاف مراقبة RadarX في الخلفية", Toast.LENGTH_SHORT).show();
    }

    private final class RadarXNativeBridge {
        @JavascriptInterface
        public void startBackgroundMonitor() {
            Log.i("RadarXBackground", "BRIDGE_START_BACKGROUND");
            runOnUiThread(() -> requestNotificationPermissionAndStart());
        }

        @JavascriptInterface
        public void stopBackgroundMonitor() {
            Log.i("RadarXBackground", "BRIDGE_STOP_BACKGROUND");
            runOnUiThread(() -> stopBackgroundMonitor());
        }

        @JavascriptInterface
        public boolean isBackgroundMonitorRunning() {
            return RadarXBackgroundMonitorService.isRunning(MainActivity.this);
        }

        @JavascriptInterface
        public void openTradli() {
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(MainActivity.this, TradliActivity.class);
                    startActivity(intent);
                } catch (Exception error) {
                    Log.e("RadarXTradli", "Unable to open TRADLI", error);
                    Toast.makeText(MainActivity.this, "تعذر فتح TRADLI", Toast.LENGTH_LONG).show();
                }
            });
        }

        @JavascriptInterface
        public void openBottomRadar() {
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(MainActivity.this, BottomRadarActivity.class);
                    startActivity(intent);
                } catch (Exception error) {
                    Log.e("RadarXBottomRadar", "Unable to open Bottom Radar", error);
                    Toast.makeText(MainActivity.this, "تعذر فتح Bottom Radar", Toast.LENGTH_LONG).show();
                }
            });
        }
    }

    private final class RadarXSmokeBridge {
        @JavascriptInterface
        public void state(String value) {
            Log.i("RadarXSmoke", String.valueOf(value));
        }
    }


    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_POST_NOTIFICATIONS) {
            boolean granted = grantResults.length > 0 &&
                    grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED;
            if (pendingBackgroundStart && granted) {
                pendingBackgroundStart = false;
                startBackgroundMonitor(false);
            } else if (pendingBackgroundStart) {
                pendingBackgroundStart = false;
                Toast.makeText(this, "تم رفض إشعارات المراقبة؛ لم يتم تشغيلها", Toast.LENGTH_LONG).show();
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null) {
            // Let WebView perform the real navigation lifecycle itself.
            // Do not dispatch a synthetic pagehide: standalone radar pages
            // use the real pagehide/pageshow events to clean up polling.
            webView.stopLoading();
            if (webView.canGoBack()) {
                webView.goBack();
                return;
            }
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}