package com.radarx.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.Manifest;

public final class RadarXBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !"android.intent.action.BOOT_COMPLETED".equals(intent.getAction())) return;
        boolean autoEnabled = context.getSharedPreferences("radarx_background", Context.MODE_PRIVATE)
                .getBoolean("auto_enabled", true);
        if (!autoEnabled) return;
        if (Build.VERSION.SDK_INT >= 33 &&
                context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) return;

        Intent service = new Intent(context, RadarXBackgroundMonitorService.class);
        service.setAction(RadarXBackgroundMonitorService.ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) {
            context.startForegroundService(service);
        } else {
            context.startService(service);
        }
    }
}
