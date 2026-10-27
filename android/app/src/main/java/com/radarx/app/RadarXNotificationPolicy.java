package com.radarx.app;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;

/**
 * A cross-process, fail-closed phone-notification budget shared by the polling
 * background service and Firebase receiver. Early/watch-only candidates must be
 * filtered before reaching this class.
 */
final class RadarXNotificationPolicy {
    static final int RESERVED = 0;
    static final int DUPLICATE = 1;
    static final int RATE_LIMITED = 2;
    static final int STORAGE_ERROR = 3;

    private static final String TAG = "RadarXNotifyPolicy";
    private static final Object PROCESS_LOCK = new Object();
    private static final long ONE_MINUTE_MS = 60_000L;
    private static final long FIFTEEN_MINUTES_MS = 15 * 60_000L;
    private static final long DEDUP_TTL_MS = 24 * 60 * 60_000L;
    private static final long SYMBOL_COOLDOWN_MS = 10 * 60_000L;
    private static final int MAX_PUSHES_PER_WINDOW = 3;
    private static final int MAX_REMEMBERED_EVENTS = 2000;
    private static final long MAX_STATE_BYTES = 1024 * 1024L;
    private static final String STATE_FILE = "radarx-notification-policy-v1.json";
    private static final String LOCK_FILE = "radarx-notification-policy-v1.lock";

    static final class Reservation {
        final int status;
        final String eventId;
        final long at;

        Reservation(int status, String eventId, long at) {
            this.status = status;
            this.eventId = eventId == null ? "" : eventId;
            this.at = at;
        }
    }

    private RadarXNotificationPolicy() {}

    static Reservation reserve(Context context, String rawEventId, String rawSymbol, long requestedAt) {
        String eventId = rawEventId == null ? "" : rawEventId.trim();
        if (eventId.isEmpty()) return new Reservation(STORAGE_ERROR, "", 0L);
        String symbol = rawSymbol == null ? "" : rawSymbol.trim().toUpperCase(java.util.Locale.ROOT);
        long now = requestedAt > 0L ? requestedAt : System.currentTimeMillis();
        synchronized (PROCESS_LOCK) {
            File dir = context.getFilesDir();
            File stateFile = new File(dir, STATE_FILE);
            File lockFile = new File(dir, LOCK_FILE);
            try (RandomAccessFile lockHandle = new RandomAccessFile(lockFile, "rw");
                 FileChannel lockChannel = lockHandle.getChannel();
                 FileLock ignored = lockChannel.lock()) {
                JSONObject state = readState(stateFile);
                JSONArray oldAttempts = state.optJSONArray("attempts");
                JSONArray attempts = new JSONArray();
                long lastAttempt = 0L;
                if (oldAttempts != null) {
                    for (int i = 0; i < oldAttempts.length(); i++) {
                        JSONObject row = oldAttempts.optJSONObject(i);
                        if (row == null) continue;
                        long at = row.optLong("at", 0L);
                        if (at <= 0L || at > now + 5000L || now - at >= FIFTEEN_MINUTES_MS) continue;
                        attempts.put(row);
                        lastAttempt = Math.max(lastAttempt, at);
                    }
                }

                JSONArray oldEvents = state.optJSONArray("events");
                JSONArray events = new JSONArray();
                boolean duplicate = false;
                if (oldEvents != null) {
                    for (int i = 0; i < oldEvents.length(); i++) {
                        JSONObject row = oldEvents.optJSONObject(i);
                        if (row == null) continue;
                        long at = row.optLong("at", 0L);
                        if (at <= 0L || at > now + 5000L || now - at >= DEDUP_TTL_MS) continue;
                        events.put(row);
                        if (eventId.equals(row.optString("id", ""))) duplicate = true;
                        String previousSymbol = row.optString("symbol", "").toUpperCase(java.util.Locale.ROOT);
                        long age = now - at;
                        if (!symbol.isEmpty() && symbol.equals(previousSymbol) &&
                                age >= 0L && age < SYMBOL_COOLDOWN_MS) duplicate = true;
                    }
                }
                if (duplicate) return new Reservation(DUPLICATE, eventId, 0L);
                if ((lastAttempt > 0L && now - lastAttempt < ONE_MINUTE_MS) ||
                        attempts.length() >= MAX_PUSHES_PER_WINDOW) {
                    return new Reservation(RATE_LIMITED, eventId, 0L);
                }

                JSONObject attempt = new JSONObject();
                attempt.put("id", eventId);
                attempt.put("at", now);
                attempts.put(attempt);
                JSONObject event = new JSONObject();
                event.put("id", eventId);
                event.put("symbol", symbol);
                event.put("at", now);
                events.put(event);
                while (events.length() > MAX_REMEMBERED_EVENTS) events.remove(0);

                state.put("version", 1);
                state.put("attempts", attempts);
                state.put("events", events);
                state.put("updated_at", now);
                writeStateAtomically(stateFile, state);
                return new Reservation(RESERVED, eventId, now);
            } catch (Exception error) {
                Log.w(TAG, "NOTIFICATION_BUDGET_STORAGE_ERROR; failing closed", error);
                return new Reservation(STORAGE_ERROR, eventId, 0L);
            }
        }
    }

    static void release(Context context, Reservation reservation) {
        if (reservation == null || reservation.status != RESERVED ||
                reservation.eventId.isEmpty() || reservation.at <= 0L) return;
        synchronized (PROCESS_LOCK) {
            File dir = context.getFilesDir();
            File stateFile = new File(dir, STATE_FILE);
            File lockFile = new File(dir, LOCK_FILE);
            try (RandomAccessFile lockHandle = new RandomAccessFile(lockFile, "rw");
                 FileChannel lockChannel = lockHandle.getChannel();
                 FileLock ignored = lockChannel.lock()) {
                JSONObject state = readState(stateFile);
                JSONArray attempts = state.optJSONArray("attempts");
                JSONArray updatedAttempts = new JSONArray();
                boolean removedAttempt = false;
                if (attempts != null) {
                    for (int i = 0; i < attempts.length(); i++) {
                        JSONObject row = attempts.optJSONObject(i);
                        if (row == null) continue;
                        boolean match = !removedAttempt &&
                                reservation.eventId.equals(row.optString("id", "")) &&
                                reservation.at == row.optLong("at", -1L);
                        if (match) removedAttempt = true;
                        else updatedAttempts.put(row);
                    }
                }
                JSONArray events = state.optJSONArray("events");
                JSONArray updatedEvents = new JSONArray();
                boolean removedEvent = false;
                if (events != null) {
                    for (int i = 0; i < events.length(); i++) {
                        JSONObject row = events.optJSONObject(i);
                        if (row == null) continue;
                        boolean match = !removedEvent &&
                                reservation.eventId.equals(row.optString("id", "")) &&
                                reservation.at == row.optLong("at", -1L);
                        if (match) removedEvent = true;
                        else updatedEvents.put(row);
                    }
                }
                if (removedAttempt || removedEvent) {
                    state.put("attempts", updatedAttempts);
                    state.put("events", updatedEvents);
                    state.put("updated_at", System.currentTimeMillis());
                    writeStateAtomically(stateFile, state);
                }
            } catch (Exception error) {
                Log.w(TAG, "NOTIFICATION_BUDGET_RELEASE_FAILED; keeping conservative reservation", error);
            }
        }
    }

    private static JSONObject readState(File stateFile) throws IOException, JSONException {
        if (!stateFile.exists() || stateFile.length() == 0L) return new JSONObject();
        long length = stateFile.length();
        if (length > MAX_STATE_BYTES) throw new IOException("NOTIFICATION_BUDGET_STATE_TOO_LARGE");
        byte[] bytes = new byte[(int) length];
        try (FileInputStream input = new FileInputStream(stateFile)) {
            int offset = 0;
            while (offset < bytes.length) {
                int count = input.read(bytes, offset, bytes.length - offset);
                if (count < 0) break;
                offset += count;
            }
            if (offset != bytes.length) throw new IOException("NOTIFICATION_BUDGET_STATE_TRUNCATED");
        }
        String raw = new String(bytes, StandardCharsets.UTF_8).trim();
        if (raw.isEmpty()) return new JSONObject();
        return new JSONObject(raw);
    }

    private static void writeStateAtomically(File stateFile, JSONObject state) throws IOException {
        File tempFile = new File(stateFile.getParentFile(), STATE_FILE + ".tmp");
        byte[] bytes = state.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_STATE_BYTES) throw new IOException("NOTIFICATION_BUDGET_STATE_TOO_LARGE");
        try (FileOutputStream output = new FileOutputStream(tempFile, false)) {
            output.write(bytes);
            output.getFD().sync();
        }
        // The lock is held while replacing the state; rename is atomic on the app's
        // private filesystem. If replacement fails, the caller fails closed.
        if (!tempFile.renameTo(stateFile)) throw new IOException("NOTIFICATION_BUDGET_STATE_RENAME_FAILED");
    }
}
