package com.radarx.app;

import android.webkit.JavascriptInterface;

/** Read-only, validated-at-build-time backend configuration exposed to local WebView assets. */
final class RadarXBackendConfigBridge {
    @JavascriptInterface
    public String getBackendOrigin() {
        return BuildConfig.RADARX_BACKEND_ORIGIN;
    }

    @JavascriptInterface
    public String getBackendFallbackOrigin() {
        return BuildConfig.RADARX_BACKEND_FALLBACK_ORIGIN;
    }
}
