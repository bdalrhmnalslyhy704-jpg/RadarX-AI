package com.radarx.ai;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.os.Build;

public final class NetworkMonitor {
    public interface Listener {
        void onNetworkChanged(boolean available);
    }

    private final ConnectivityManager manager;
    private final Listener listener;
    private ConnectivityManager.NetworkCallback callback;

    public NetworkMonitor(Context context, Listener listener) {
        manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        this.listener = listener;
    }

    public boolean isAvailable() {
        if (manager == null) return false;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Network network = manager.getActiveNetwork();
            if (network == null) return false;
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
            return capabilities != null && hasUsableTransport(capabilities);
        }

        @SuppressWarnings("deprecation")
        NetworkInfo info = manager.getActiveNetworkInfo();
        return info != null && info.isConnected();
    }

    public void start() {
        if (manager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;
        if (callback != null) return;

        callback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) {
                listener.onNetworkChanged(true);
            }

            @Override public void onLost(Network network) {
                listener.onNetworkChanged(isAvailable());
            }
        };

        try {
            manager.registerDefaultNetworkCallback(callback);
        } catch (Exception ignored) {
            callback = null;
        }
    }

    public void stop() {
        if (manager == null || callback == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;
        try {
            manager.unregisterNetworkCallback(callback);
        } catch (Exception ignored) {
        }
        callback = null;
    }

    private boolean hasUsableTransport(NetworkCapabilities capabilities) {
        return capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
                || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
                || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
    }
}
