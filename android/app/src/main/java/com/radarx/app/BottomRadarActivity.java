package com.radarx.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

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
public final class BottomRadarActivity extends Activity {
    private static final String APP_URL =
            "https://appassets.androidplatform.net/assets/bottom-radar.html";
    private static final String APP_ORIGIN =
            "https://appassets.androidplatform.net";
    private static final String BACKEND_ORIGIN =
            "https://radarx-ai-production.up.railway.app";

    private WebView webView;
    private WebViewAssetLoader assetLoader;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(5, 12, 22));
        getWindow().setNavigationBarColor(Color.rgb(5, 12, 22));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(5, 12, 22));

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setOrientation(LinearLayout.HORIZONTAL);
        toolbar.setGravity(android.view.Gravity.CENTER_VERTICAL);
        toolbar.setPadding(10, 8, 10, 8);
        toolbar.setBackgroundColor(Color.rgb(7, 17, 31));

        Button back = new Button(this);
        back.setText("‹");
        back.setTextColor(Color.WHITE);
        back.setTextSize(22f);
        back.setAllCaps(false);
        back.setBackgroundColor(Color.TRANSPARENT);
        back.setOnClickListener(v -> finish());

        TextView title = new TextView(this);
        title.setText("Bottom Reversal Radar");
        title.setTextColor(Color.WHITE);
        title.setTextSize(16f);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        title.setPadding(8, 0, 8, 0);

        toolbar.addView(back, new LinearLayout.LayoutParams(
                54, 52
        ));
        toolbar.addView(title, new LinearLayout.LayoutParams(
                0, 52, 1f
        ));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(5, 12, 22));
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
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                android.util.Log.i("RadarXBottomRadarWeb", message.message());
                return true;
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                return !(isAllowedAppUri(uri) || isAllowedBackendUri(uri));
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(
                    WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                WebResourceResponse local = assetLoader.shouldInterceptRequest(uri);
                if (local != null) return local;
                if (isAllowedBackendUri(uri)) return fetchBackend(request);
                return blockedResponse("Network destination blocked");
            }

            @Override
            public void onReceivedSslError(WebView view, android.webkit.SslErrorHandler handler, SslError error) {
                handler.cancel();
                showErrorPage("تعذر الاتصال الآمن بالخادم.");
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showErrorPage("تعذر تحميل Bottom Radar.");
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse error) {
                if (request.isForMainFrame()) showErrorPage("تعذر تحميل TRADLI (" + error.getStatusCode() + ").");
            }
        });

        root.addView(toolbar, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 52
        ));
        root.addView(webView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f
        ));
        setContentView(root);

        webView.loadUrl(APP_URL);
    }

    private static boolean isAllowedAppUri(Uri uri) {
        return uri != null &&
                "https".equalsIgnoreCase(uri.getScheme()) &&
                APP_ORIGIN.equalsIgnoreCase(uri.getScheme() + "://" + uri.getHost()) &&
                (uri.getPort() == -1 || uri.getPort() == 443);
    }

    private static boolean isAllowedBackendUri(Uri uri) {
        return uri != null &&
                "https".equalsIgnoreCase(uri.getScheme()) &&
                BACKEND_ORIGIN.equalsIgnoreCase(uri.getScheme() + "://" + uri.getHost()) &&
                (uri.getPort() == -1 || uri.getPort() == 443);
    }

    private static WebResourceResponse fetchBackend(WebResourceRequest request) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(request.getUrl().toString());
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
            byte[] body = ("{\"status\":503,\"error\":\"" +
                    error.getClass().getSimpleName() + "\"}").getBytes(StandardCharsets.UTF_8);
            Map<String, String> headers = new HashMap<>();
            headers.put("Access-Control-Allow-Origin", APP_ORIGIN);
            headers.put("Cache-Control", "no-store");
            return new WebResourceResponse(
                    "application/json", "UTF-8", 503, "Backend Unavailable",
                    headers, new ByteArrayInputStream(body)
            );
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static byte[] readAll(InputStream input) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = input.read(buf)) != -1) out.write(buf, 0, n);
        return out.toByteArray();
    }

    private static WebResourceResponse blockedResponse(String message) {
        return new WebResourceResponse(
                "text/plain", "UTF-8", 403, "Blocked", null,
                new ByteArrayInputStream(message.getBytes(StandardCharsets.UTF_8))
        );
    }

    private void showErrorPage(String message) {
        if (webView == null) return;
        webView.loadDataWithBaseURL(APP_URL,
                "<!doctype html><html lang='ar' dir='rtl'><meta name='viewport' content='width=device-width,initial-scale=1'><body style='margin:0;background:#050c16;color:#fff;font-family:system-ui;padding:22px'><div style='margin-top:18vh;background:#0b1826;border:1px solid #6f4751;border-radius:18px;padding:18px'><h2>Bottom Radar</h2><p>" +
                message + "</p><button onclick='location.reload()' style='width:100%;min-height:48px;border-radius:12px;background:#35c9ff;border:0;font:inherit;font-weight:900'>إعادة المحاولة</button></div></body></html>",
                "text/html", "UTF-8", null);
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
