package com.radarx.ai;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.os.Bundle;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.util.Locale;

public final class MainActivity extends Activity {
    private static final int BG = Color.rgb(5, 10, 15);
    private WebView webView;
    private TextView statusView;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);

        webView = new WebView(this);
        configureWebView(webView);

        statusView = new TextView(this);
        statusView.setText(
                "RadarX\nجاري تحميل النسخة الأصلية ومحركات التحليل…"
        );
        statusView.setTextColor(Color.rgb(190, 220, 232));
        statusView.setTextSize(13);
        statusView.setGravity(android.view.Gravity.CENTER);
        statusView.setBackgroundColor(BG);
        statusView.setVisibility(View.VISIBLE);

        ProgressBar progress = new ProgressBar(this);
        progress.setIndeterminate(true);

        FrameLayout.LayoutParams webLp =
                new FrameLayout.LayoutParams(-1, -1);
        FrameLayout.LayoutParams statusLp =
                new FrameLayout.LayoutParams(-1, -1);
        FrameLayout.LayoutParams progressLp =
                new FrameLayout.LayoutParams(
                        dp(42), dp(42),
                        android.view.Gravity.CENTER
                );

        root.addView(webView, webLp);
        root.addView(statusView, statusLp);
        root.addView(progress, progressLp);
        setContentView(root);

        webView.addJavascriptInterface(new RadarXAndroidBridge(this), "RadarXAndroid");
        webView.loadUrl("file:///android_asset/index.html");
    }

    private void configureWebView(WebView view) {
        view.setBackgroundColor(BG);
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);
        view.setVerticalScrollBarEnabled(false);
        view.setHorizontalScrollBarEnabled(false);

        android.webkit.WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadsImagesAutomatically(true);
        s.setBlockNetworkImage(false);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setDefaultTextEncodingName("UTF-8");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);

        view.addJavascriptInterface(new RadarXAndroidBridge(this), "RadarXAndroid");

        view.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView v, String url) {
                super.onPageFinished(v, url);
                hideLoading();
                injectNativeHost(v);
            }

            @Override public void onReceivedError(
                    WebView v,
                    WebResourceRequest request,
                    WebResourceError error
            ) {
                super.onReceivedError(v, request, error);
                if (request != null && request.isForMainFrame()) {
                    showError(
                            "تعذر تشغيل واجهة RadarX الأصلية.\n" +
                            (error == null ? "" : String.valueOf(error.getDescription()))
                    );
                }
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage cm) {
                return true;
            }
        });
    }

    private void injectNativeHost(WebView v) {
        String js =
                "(function(){try{" +
                "window.RadarXAndroidHost={native:true,version:'6.5.0'," +
                "shell:'native-web-core',localAssets:true};" +
                "}catch(e){}})();";
        v.evaluateJavascript(js, null);
    }

    private void hideLoading() {
        if (statusView != null) statusView.setVisibility(View.GONE);
        View parent = statusView == null ? null : (View) statusView.getParent();
        if (parent instanceof FrameLayout) {
            FrameLayout frame = (FrameLayout) parent;
            if (frame.getChildCount() > 0) {
                View last = frame.getChildAt(frame.getChildCount() - 1);
                if (last instanceof ProgressBar) last.setVisibility(View.GONE);
            }
        }
    }

    private void showError(String message) {
        if (statusView == null) return;
        statusView.setText(message + "\n\nأعد تشغيل التطبيق للمحاولة مرة أخرى.");
        statusView.setTextColor(Color.rgb(255, 150, 165));
        statusView.setVisibility(View.VISIBLE);
    }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.loadUrl("about:blank");
            webView.clearHistory();
            webView.removeAllViews();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    public static final class RadarXAndroidBridge {
        private final Context context;

        RadarXAndroidBridge(Context context) {
            this.context = context.getApplicationContext();
        }

        @JavascriptInterface
        public String getVersion() {
            return "6.5.0";
        }

        @JavascriptInterface
        public boolean isNativeShell() {
            return true;
        }

        @JavascriptInterface
        public boolean isNetworkAvailable() {
            ConnectivityManager cm =
                    (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            android.net.Network network = cm.getActiveNetwork();
            return network != null &&
                    cm.getNetworkCapabilities(network) != null &&
                    cm.getNetworkCapabilities(network)
                            .hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET);
        }

        @JavascriptInterface
        public String locale() {
            return Locale.getDefault().toLanguageTag();
        }
    }
}
