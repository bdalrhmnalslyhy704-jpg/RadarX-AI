package com.radarx.ai;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

public final class RadarXDohDns implements okhttp3.Dns {
    private final okhttp3.Dns system = okhttp3.Dns.SYSTEM;
    private final OkHttpClient dohClient;

    public RadarXDohDns() {
        dohClient = new OkHttpClient.Builder()
                .connectTimeout(2_500L, java.util.concurrent.TimeUnit.MILLISECONDS)
                .readTimeout(2_500L, java.util.concurrent.TimeUnit.MILLISECONDS)
                .writeTimeout(2_500L, java.util.concurrent.TimeUnit.MILLISECONDS)
                .retryOnConnectionFailure(true)
                .build();
    }

    @Override
    public List<InetAddress> lookup(String hostname) throws UnknownHostException {
        if (hostname == null || hostname.trim().isEmpty()) {
            throw new UnknownHostException("empty hostname");
        }

        // Fast path: Android's normal resolver.
        try {
            List<InetAddress> local = system.lookup(hostname);
            if (local != null && !local.isEmpty()) return local;
        } catch (Exception ignored) {
            // Continue with DoH.
        }

        List<InetAddress> addresses = new ArrayList<>();
        for (String endpoint : Arrays.asList(
                "https://cloudflare-dns.com/dns-query?name=" + encode(hostname) + "&type=A",
                "https://dns.google/resolve?name=" + encode(hostname) + "&type=A"
        )) {
            try {
                okhttp3.Request request = new okhttp3.Request.Builder()
                        .url(endpoint)
                        .get()
                        .header("Accept", "application/dns-json")
                        .header("User-Agent", "RadarX-Android/6.6.0")
                        .build();

                try (Response response = dohClient.newCall(request).execute()) {
                    if (!response.isSuccessful() || response.body() == null) continue;
                    String raw = response.body().string();
                    JSONObject root = new JSONObject(raw);
                    JSONArray answer = root.optJSONArray("Answer");
                    if (answer == null) continue;

                    for (int i = 0; i < answer.length(); i++) {
                        JSONObject row = answer.optJSONObject(i);
                        if (row == null) continue;
                        String data = row.optString("data", "").trim();
                        if (data.matches("\\d{1,3}(?:\\.\\d{1,3}){3}")) {
                            try {
                                InetAddress ip = InetAddress.getByName(data);
                                if (!addresses.contains(ip)) addresses.add(ip);
                            } catch (Exception ignored) {}
                        }
                    }
                    if (!addresses.isEmpty()) return addresses;
                }
            } catch (Exception ignored) {
                // Try the next public DoH provider.
            }
        }

        throw new UnknownHostException("DNS resolution failed for " + hostname);
    }

    private static String encode(String value) {
        try {
            return java.net.URLEncoder.encode(value, StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            return value;
        }
    }
}
