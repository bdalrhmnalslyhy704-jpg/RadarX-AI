package com.radarx.ai;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.webkit.WebViewAssetLoader;

import java.util.Locale;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;

public final class MainActivity extends Activity {
    private static final int BG = Color.rgb(5, 10, 15);
    private static final String APP_URL =
            "https://appassets.androidplatform.net/assets/index.html";
    private static final String VERSION = "6.6.0";

    private WebView webView;
    private TextView statusView;
    private BinanceSecureRelay binanceRelay;
    private NativeBinanceStreamHub streamHub;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);

        OkHttpClient relayClient = new OkHttpClient.Builder()
                .connectTimeout(5_200L, TimeUnit.MILLISECONDS)
                .readTimeout(5_200L, TimeUnit.MILLISECONDS)
                .writeTimeout(5_200L, TimeUnit.MILLISECONDS)
                .retryOnConnectionFailure(true)
                .build();
        binanceRelay = new BinanceSecureRelay(relayClient);

        OkHttpClient wsClient = new OkHttpClient.Builder()
                .connectTimeout(8_000L, TimeUnit.MILLISECONDS)
                .readTimeout(0L, TimeUnit.MILLISECONDS)
                .writeTimeout(8_000L, TimeUnit.MILLISECONDS)
                .pingInterval(20L, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build();
        streamHub = new NativeBinanceStreamHub(wsClient);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);

        webView = new WebView(this);
        configureWebView(webView);

        statusView = new TextView(this);
        statusView.setText(
                "RadarX\nجاري تشغيل الواجهة الأصلية وتهيئة اتصال Binance الآمن…"
        );
        statusView.setTextColor(Color.rgb(190, 220, 232));
        statusView.setTextSize(13);
        statusView.setGravity(android.view.Gravity.CENTER);
        statusView.setBackgroundColor(BG);
        statusView.setVisibility(android.view.View.VISIBLE);

        ProgressBar progress = new ProgressBar(this);
        progress.setIndeterminate(true);

        root.addView(
                webView,
                new FrameLayout.LayoutParams(-1, -1)
        );
        root.addView(
                statusView,
                new FrameLayout.LayoutParams(-1, -1)
        );
        FrameLayout.LayoutParams progressLp =
                new FrameLayout.LayoutParams(
                        dp(42), dp(42),
                        android.view.Gravity.CENTER
                );
        root.addView(progress, progressLp);
        setContentView(root);

        webView.addJavascriptInterface(new RadarXAndroidBridge(this, streamHub), "RadarXAndroid");
        webView.loadUrl(APP_URL);
    }

    private void configureWebView(WebView view) {
        view.setBackgroundColor(BG);
        view.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
        view.setVerticalScrollBarEnabled(false);
        view.setHorizontalScrollBarEnabled(false);

        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadsImagesAutomatically(true);
        s.setBlockNetworkImage(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setDefaultTextEncodingName("UTF-8");
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);

        final WebViewAssetLoader assetLoader =
                new WebViewAssetLoader.Builder()
                        .addPathHandler(
                                "/assets/",
                                new WebViewAssetLoader.AssetsPathHandler(this)
                        )
                        .build();

        view.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(
                    WebView v,
                    WebResourceRequest request
            ) {
                Uri uri = request.getUrl();

                WebResourceResponse local = assetLoader.shouldInterceptRequest(uri);
                if (local != null) return local;

                WebResourceResponse relay = binanceRelay.intercept(uri);
                if (relay != null) return relay;

                WebResourceResponse health = binanceRelay.interceptHealth(uri);
                if (health != null) return health;

                return super.shouldInterceptRequest(v, request);
            }

            @Override
            @SuppressWarnings("deprecation")
            public WebResourceResponse shouldInterceptRequest(
                    WebView v,
                    String url
            ) {
                Uri uri = Uri.parse(url);

                WebResourceResponse local = assetLoader.shouldInterceptRequest(uri);
                if (local != null) return local;

                WebResourceResponse relay = binanceRelay.intercept(uri);
                if (relay != null) return relay;

                WebResourceResponse health = binanceRelay.interceptHealth(uri);
                if (health != null) return health;

                return super.shouldInterceptRequest(v, url);
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                super.onPageFinished(v, url);
                hideLoading();
                injectNativeHost(v);
            }

            @Override
            public void onReceivedError(
                    WebView v,
                    WebResourceRequest request,
                    WebResourceError error
            ) {
                super.onReceivedError(v, request, error);
                if (request != null && request.isForMainFrame()) {
                    showError(
                            "تعذر تشغيل واجهة RadarX الأصلية.\n" +
                            (error == null ? "" :
                                    String.valueOf(error.getDescription()))
                    );
                }
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                return true;
            }
        });
    }

    private void injectNativeHost(WebView v) {
        String js =
                "(function(){try{" +
                "window.RadarXAndroidHost={" +
                "native:true," +
                "version:'6.6.0'," +
                "shell:'native-web-core'," +
                "localAssets:true," +
                "binanceRelay:'native-failover'," +
                "};" +
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
        if (streamHub != null) {
            streamHub.stopAll();
            streamHub = null;
        }
        if (binanceRelay != null) binanceRelay = null;
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    public static final class RadarXAndroidBridge {
        private final Context context;
        private final NativeBinanceStreamHub streamHub;

        RadarXAndroidBridge(Context context, NativeBinanceStreamHub streamHub) {
            this.context = context.getApplicationContext();
            this.streamHub = streamHub;
        }

        @android.webkit.JavascriptInterface
        public String getVersion() {
            return VERSION;
        }

        @android.webkit.JavascriptInterface
        public boolean isNativeShell() {
            return true;
        }

        @android.webkit.JavascriptInterface
        public boolean startMarketStream(String id, String streams) {
            return streamHub != null && streamHub.start(id, streams);
        }

        @android.webkit.JavascriptInterface
        public void stopMarketStream(String id) {
            if (streamHub != null) streamHub.stop(id);
        }

        @android.webkit.JavascriptInterface
        public String pollMarketStreams() {
            return streamHub == null ? "[]" : streamHub.pollJson(80);
        }

        @android.webkit.JavascriptInterface
        public boolean isNetworkAvailable() {
            ConnectivityManager cm =
                    (ConnectivityManager) context.getSystemService(
                            Context.CONNECTIVITY_SERVICE
                    );
            if (cm == null) return false;
            android.net.Network network = cm.getActiveNetwork();
            if (network == null) return false;
            android.net.NetworkCapabilities caps =
                    cm.getNetworkCapabilities(network);
            return caps != null &&
                    caps.hasCapability(
                            android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET
                    );
        }

        @android.webkit.JavascriptInterface
        public String locale() {
            return Locale.getDefault().toLanguageTag();
        }
    }
}
