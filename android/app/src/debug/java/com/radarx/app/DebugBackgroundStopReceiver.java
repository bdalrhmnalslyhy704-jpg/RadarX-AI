package com.radarx.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.util.Log;

/**
 * Test-only bridge for CI to request a graceful service stop through the app UID.
 * This class and its receiver declaration live in src/debug only and are not
 * packaged into release builds.
 */
public final class DebugBackgroundStopReceiver extends BroadcastReceiver {
    public static final String ACTION = "com.radarx.app.DEBUG_STOP_BACKGROUND_MONITOR";
    private static final String TAG = "RadarXSmoke";

    @Override
    public void onReceive(Context context, Intent intent) {
        if ((context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0) {
            Log.w(TAG, "DEBUG_STOP_RECEIVER_IGNORED_NON_DEBUG_BUILD");
            return;
        }
        if (intent == null || !ACTION.equals(intent.getAction())) {
            Log.w(TAG, "DEBUG_STOP_RECEIVER_IGNORED_INVALID_ACTION");
            return;
        }

        Log.i(TAG, "TEST_STOP_BACKGROUND_MONITOR_REQUEST");
        Intent stop = new Intent(context, RadarXBackgroundMonitorService.class);
        stop.setAction(RadarXBackgroundMonitorService.ACTION_STOP);
        try {
            context.startService(stop);
        } catch (RuntimeException error) {
            Log.e(TAG, "TEST_STOP_BACKGROUND_MONITOR_DISPATCH_FAILED", error);
        }
    }
}
