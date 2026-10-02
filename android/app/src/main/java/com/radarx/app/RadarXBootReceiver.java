package com.radarx.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public final class RadarXBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !"android.intent.action.BOOT_COMPLETED".equals(intent.getAction())) return;
        if (!RadarXBackgroundMonitorService.isRunning(context)) return;

        Intent service = new Intent(context, RadarXBackgroundMonitorService.class);
        service.setAction(RadarXBackgroundMonitorService.ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) {
            context.startForegroundService(service);
        } else {
            context.startService(service);
        }
    }
}
