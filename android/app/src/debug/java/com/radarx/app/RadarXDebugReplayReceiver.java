package com.radarx.app;

import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.util.Log;

/**
 * CI-only bridge for the background durable-replay regression.
 * It is declared only by src/debug/AndroidManifest.xml, not the Release variant.
 */
public final class RadarXDebugReplayReceiver extends BroadcastReceiver {
    public static final String ACTION_STOP_BACKGROUND =
            "com.radarx.app.action.DEBUG_REPLAY_STOP_BACKGROUND";
    private static final String TAG = "RadarXBackground";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_STOP_BACKGROUND.equals(intent.getAction())) return;
        if ((context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0) {
            Log.w(TAG, "REPLAY_TEST_STOP_REJECTED_NON_DEBUG_BUILD");
            return;
        }

        Log.i(TAG, "REPLAY_TEST_STOP_BROADCAST_RECEIVED");
        Intent stopIntent = new Intent(context, RadarXBackgroundMonitorService.class);
        stopIntent.setAction(RadarXBackgroundMonitorService.ACTION_STOP);
        try {
            ComponentName result = context.startService(stopIntent);
            if (result != null) Log.i(TAG, "REPLAY_TEST_STOP_REQUEST_SENT");
            else Log.e(TAG, "REPLAY_TEST_STOP_REQUEST_NO_COMPONENT");
        } catch (Exception error) {
            Log.e(TAG, "REPLAY_TEST_STOP_REQUEST_FAILED", error);
        }
    }
}
