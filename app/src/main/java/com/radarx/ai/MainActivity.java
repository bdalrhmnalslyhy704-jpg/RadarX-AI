package com.radarx.ai;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.Gravity;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceResponse;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.util.Locale;

public final class MainActivity extends Activity {
    private static final String APP_URL = "https://radar-x-ai.vercel.app/?app=android&runtime=6.1&v=6.1.0";
    private static final int MAX_AUTO_RETRIES = 3;
    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView webView;
    private ProgressBar progress;
    private TextView status;
    private TextView retryView;
    private int autoRetries = 0;
    private boolean loadingMainFrame = false;

    @SuppressLint({"SetJavaScriptEnabled", "RequiresFeature"})
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(5, 10, 15));
        getWindow().setNavigationBarColor(Color.rgb(5, 10, 15));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(5, 10, 15));

        status = new TextView(this);
        status.setText("RadarX 6.1 • تجهيز المحرك الحي…");
        status.setTextColor(Color.LTGRAY);
        status.setTextSize(11);
        status.setPadding(14, 8, 14, 8);
        root.addView(status, new LinearLayout.LayoutParams(-1, -2));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setIndeterminate(true);
        root.addView(progress, new LinearLayout.LayoutParams(-1, 3));

        retryView = new TextView(this);
        retryView.setText("إعادة الاتصال");
        retryView.setTextColor(Color.WHITE);
        retryView.setTextSize(13);
        retryView.setGravity(Gravity.CENTER);
        retryView.setPadding(18, 18, 18, 18);
        retryView.setVisibility(View.GONE);
        retryView.setOnClickListener(v -> loadApp(true));
        root.addView(retryView, new LinearLayout.LayoutParams(-1, -2));

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportMultipleWindows(false);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " RadarXAndroid/6.1.0");

        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                android.net.Uri u = request.getUrl();
                String host = u.getHost() == null ? "" : u.getHost();
                if ("radar-x-ai.vercel.app".equalsIgnoreCase(host)) return false;
                try { startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true;
            }

            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                loadingMainFrame = true;
                progress.setIndeterminate(true);
                retryView.setVisibility(View.GONE);
                status.setText(hasNetwork()
                    ? "RadarX 6.1 • اتصال حي — تشغيل المحرك…"
                    : "RadarX 6.1 • لا يوجد اتصال — نستخدم أفضل حالة محفوظة");
            }

            @Override public void onPageFinished(WebView view, String url) {
                loadingMainFrame = false;
                autoRetries = 0;
                progress.setIndeterminate(false);
                progress.setProgress(100);
                retryView.setVisibility(View.GONE);
                status.setText(hasNetwork()
                    ? "RadarX 6.1 • متصل"
                    : "RadarX 6.1 • متصل من الكاش — بانتظار الشبكة");
            }

            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                loadingMainFrame = false;
                scheduleRecovery("تعذر فتح RadarX. إعادة المحاولة تلقائيًا…");
            }

            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
                if (!request.isForMainFrame()) return;
                int code = errorResponse != null ? errorResponse.getStatusCode() : 0;
                if (code >= 500) scheduleRecovery("خادم RadarX مشغول مؤقتًا — إعادة المحاولة…");
            }
        });

        root.addView(webView, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);

        if (state == null) loadApp(false);
        else webView.restoreState(state);
    }

    private void loadApp(boolean manual) {
        retryView.setVisibility(View.GONE);
        loadingMainFrame = true;
        if (manual) autoRetries = 0;
        if (!hasNetwork() && webView.getUrl() == null) {
            scheduleRecovery("لا يوجد اتصال بالإنترنت. فعّل البيانات/الواي فاي ثم اضغط إعادة الاتصال.");
            return;
        }
        webView.loadUrl(APP_URL);
    }

    private void scheduleRecovery(String message) {
        main.removeCallbacksAndMessages(null);
        if (hasNetwork() && autoRetries < MAX_AUTO_RETRIES) {
            final int attempt = ++autoRetries;
            long delay = Math.min(8000L, 1500L * (1L << Math.max(0, attempt - 1)));
            status.setText(message + " (" + attempt + "/" + MAX_AUTO_RETRIES + ")");
            progress.setIndeterminate(true);
            main.postDelayed(() -> {
                if (!isFinishing()) webView.loadUrl(APP_URL);
            }, delay);
        } else {
            progress.setIndeterminate(false);
            retryView.setText("↻  إعادة الاتصال الآن");
            retryView.setVisibility(View.VISIBLE);
            status.setText(message);
        }
    }

    private boolean hasNetwork() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        NetworkCapabilities n = cm.getNetworkCapabilities(cm.getActiveNetwork());
        return n != null && (n.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
            || n.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
            || n.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET));
    }

    @Override protected void onSaveInstanceState(Bundle out) {
        if (webView != null) webView.saveState(out);
        super.onSaveInstanceState(out);
    }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }
}
