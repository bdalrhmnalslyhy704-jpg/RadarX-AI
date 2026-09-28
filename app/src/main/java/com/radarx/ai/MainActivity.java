package com.radarx.ai;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private static final String APP_URL = "https://radar-x-ai.vercel.app/?app=android&runtime=6.0";
    private WebView webView;
    private ProgressBar progress;
    private TextView status;

    @SuppressLint("SetJavaScriptEnabled")
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(5, 10, 15));
        getWindow().setNavigationBarColor(Color.rgb(5, 10, 15));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(5, 10, 15));

        status = new TextView(this);
        status.setText("RadarX • جاري الاتصال…");
        status.setTextColor(Color.LTGRAY);
        status.setTextSize(11);
        status.setPadding(14, 8, 14, 8);
        root.addView(status, new LinearLayout.LayoutParams(-1, -2));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setIndeterminate(true);
        root.addView(progress, new LinearLayout.LayoutParams(-1, 3));

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
        s.setUserAgentString(s.getUserAgentString() + " RadarXAndroid/6.0.0");

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u=request.getUrl();
                String host=u.getHost()==null?"":u.getHost();
                if ("radar-x-ai.vercel.app".equalsIgnoreCase(host)) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW,u)); } catch (Exception ignored) {}
                return true;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                status.setText(hasNetwork() ? "RadarX • اتصال الشبكة متاح" : "RadarX • لا يوجد اتصال");
                progress.setIndeterminate(true);
            }
            @Override public void onPageFinished(WebView view, String url) {
                progress.setIndeterminate(false);
                progress.setProgress(100);
                status.setText(hasNetwork() ? "RadarX • متصل" : "RadarX • وضع عدم الاتصال");
            }
        });

        root.addView(webView, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);

        if (state == null) webView.loadUrl(APP_URL);
        else webView.restoreState(state);
    }

    private boolean hasNetwork() {
        ConnectivityManager cm=(ConnectivityManager)getSystemService(CONNECTIVITY_SERVICE);
        if (cm==null) return false;
        NetworkCapabilities n=cm.getNetworkCapabilities(cm.getActiveNetwork());
        return n!=null && (n.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
            || n.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
            || n.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET));
    }

    @Override protected void onSaveInstanceState(Bundle out) {
        webView.saveState(out);
        super.onSaveInstanceState(out);
    }

    @Override public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        if (webView!=null) { webView.stopLoading(); webView.destroy(); }
        super.onDestroy();
    }
}
