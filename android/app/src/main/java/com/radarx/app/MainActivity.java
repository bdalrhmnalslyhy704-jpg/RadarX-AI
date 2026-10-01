package com.radarx.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.View;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;

@SuppressLint("SetJavaScriptEnabled")
public final class MainActivity extends Activity {
    private static final String APP_URL =
            "https://appassets.androidplatform.net/assets/index.html";
    private static final String APP_ORIGIN =
            "https://appassets.androidplatform.net";
    private static final String BACKEND_ORIGIN =
            "https://radarx-ai-production.up.railway.app";

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

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                return !(isAllowedAppUri(uri) || isAllowedBackendUri(uri));
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                WebResourceResponse local = assetLoader.shouldInterceptRequest(uri);
                if (local != null) {
                    return local;
                }
                if (isAllowedBackendUri(uri)) {
                    return super.shouldInterceptRequest(view, request);
                }
                return blockedResponse("Network destination blocked");
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
    }

    private static boolean isAllowedAppUri(Uri uri) {
        return uri != null
                && "https".equalsIgnoreCase(uri.getScheme())
                && APP_ORIGIN.equalsIgnoreCase(uri.getScheme() + "://" + uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    private static boolean isAllowedBackendUri(Uri uri) {
        return uri != null
                && "https".equalsIgnoreCase(uri.getScheme())
                && BACKEND_ORIGIN.equalsIgnoreCase(uri.getScheme() + "://" + uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443);
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

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
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
