package com.radarx.ai;

import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Notification;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Vibrator;
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
    private static final String VERSION = "6.8.2";

    private WebView webView;
    private TextView statusView;
    private BinanceSecureRelay binanceRelay;
    private NativeBinanceStreamHub streamHub;
    private NativeBinanceHttpQueue httpQueue;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);

        OkHttpClient relayClient = new OkHttpClient.Builder()
                .connectTimeout(5_200L, TimeUnit.MILLISECONDS)
                .readTimeout(5_200L, TimeUnit.MILLISECONDS)
                .writeTimeout(5_200L, TimeUnit.MILLISECONDS)
                .retryOnConnectionFailure(true)
                .dns(new RadarXDohDns())
                .build();
        binanceRelay = new BinanceSecureRelay(relayClient);

        OkHttpClient wsClient = new OkHttpClient.Builder()
                .connectTimeout(8_000L, TimeUnit.MILLISECONDS)
                .readTimeout(0L, TimeUnit.MILLISECONDS)
                .writeTimeout(8_000L, TimeUnit.MILLISECONDS)
                .pingInterval(20L, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .dns(new RadarXDohDns())
                .build();
        streamHub = new NativeBinanceStreamHub(wsClient);
        httpQueue = new NativeBinanceHttpQueue(relayClient);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);

        webView = new WebView(this);
        configureWebView(webView);

        statusView = new TextView(this);
        statusView.setText(
                "RadarX\nجاري تشغيل الواجهة وتهيئة اتصال Binance…"
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

        webView.addJavascriptInterface(new RadarXAndroidBridge(this, streamHub, httpQueue), "RadarXAndroid");
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
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
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

                WebResourceResponse secondary = binanceRelay.interceptSecondary(uri);
                if (secondary != null) return secondary;

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

                WebResourceResponse secondary = binanceRelay.interceptSecondary(uri);
                if (secondary != null) return secondary;

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
                "version:'6.8.1'," +
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
        if (httpQueue != null) {
            httpQueue.shutdown();
            httpQueue = null;
        }
        if (binanceRelay != null) binanceRelay = null;
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    public static final class RadarXAndroidBridge {
        private final Activity activity;
        private final Context context;
        private final NativeBinanceStreamHub streamHub;
        private final NativeBinanceHttpQueue httpQueue;

        RadarXAndroidBridge(Context context, NativeBinanceStreamHub streamHub, NativeBinanceHttpQueue httpQueue) {
            this.activity = (context instanceof Activity) ? (Activity) context : null;
            this.context = context.getApplicationContext();
            this.streamHub = streamHub;
            this.httpQueue = httpQueue;
        }

        @android.webkit.JavascriptInterface
        public String getVersion() {
            return VERSION;
        }


        @android.webkit.JavascriptInterface
        public boolean requestNativeNotifications() {
            try {
                if (Build.VERSION.SDK_INT >= 33 &&
                        activity != null &&
                        activity.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                                != PackageManager.PERMISSION_GRANTED) {
                    if (activity != null) {
                        activity.requestPermissions(
                                new String[]{"android.permission.POST_NOTIFICATIONS"},
                                9017
                        );
                    }
                }
                return true;
            } catch (Exception ignored) {
                return false;
            }
        }

        @android.webkit.JavascriptInterface
        public boolean postNativeNotification(String title, String body) {
            try {
                NotificationManager manager =
                        (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
                if (manager == null) return false;

                final String channelId = "radarx-alerts";
                if (Build.VERSION.SDK_INT >= 26) {
                    NotificationChannel channel = new NotificationChannel(
                            channelId,
                            "RadarX Alerts",
                            NotificationManager.IMPORTANCE_HIGH
                    );
                    channel.setDescription("RadarX early-move and risk alerts");
                    channel.enableVibration(true);
                    manager.createNotificationChannel(channel);
                }

                Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                        ? new Notification.Builder(context, channelId)
                        : new Notification.Builder(context);

                builder.setSmallIcon(R.drawable.ic_launcher)
                        .setContentTitle(String.valueOf(title == null ? "RadarX" : title))
                        .setContentText(String.valueOf(body == null ? "" : body))
                        .setAutoCancel(true)
                        .setCategory(Notification.CATEGORY_ALARM)
                        .setPriority(Notification.PRIORITY_HIGH)
                        .setVibrate(new long[]{0, 120, 80, 180});

                manager.notify((int) (System.currentTimeMillis() & 0x7fffffff), builder.build());
                return true;
            } catch (SecurityException ignored) {
                return false;
            } catch (Exception ignored) {
                return false;
            }
        }

        @android.webkit.JavascriptInterface
        public void vibrate(int milliseconds) {
            try {
                Vibrator vibrator = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
                if (vibrator == null) return;
                long ms = Math.max(20L, Math.min(1000L, milliseconds));
                if (Build.VERSION.SDK_INT >= 26) {
                    vibrator.vibrate(android.os.VibrationEffect.createOneShot(
                            ms, android.os.VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    vibrator.vibrate(ms);
                }
            } catch (Exception ignored) {
            }
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
        public String startBinanceHttp(String path) {
            return httpQueue == null ? "" : httpQueue.start(path);
        }

        @android.webkit.JavascriptInterface
        public String pollBinanceHttp() {
            return httpQueue == null ? "[]" : httpQueue.pollJson(12);
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
