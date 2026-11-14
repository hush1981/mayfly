package de.paul42.mayfly.push;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

import de.paul42.mayfly.MainActivity;
import de.paul42.mayfly.R;

/**
 * Receives UnifiedPush events from the distributor (e.g. ntfy).
 *
 * The server only sends an empty wake-up; the push content is ignored on purpose.
 * The notification is created here by Mayfly itself, so the distributor never
 * shows anything and never learns who sent what.
 */
public class MayflyPushService extends PushService {
    static final String PREFS = "mayfly_push";
    static final String KEY_ENDPOINT = "endpoint";
    static final String KEY_STATE = "state";
    static final String CHANNEL_ID = "moments";
    static final int NOTIFICATION_ID = 4711;

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @Override
    public void onNewEndpoint(PushEndpoint endpoint, String instance) {
        prefs(this).edit()
                .putString(KEY_ENDPOINT, endpoint.getUrl())
                .putString(KEY_STATE, "registered")
                .apply();
        UnifiedPushModule.emit("endpoint", endpoint.getUrl());
    }

    @Override
    public void onMessage(PushMessage message, String instance) {
        // The app decides about the notification (it knows the sender and which chats are
        // muted). Running app: JS gets the event. Otherwise a headless JS task is started.
        if (UnifiedPushModule.emit("message", null)) return;
        try {
            startService(new Intent(this, MayflyHeadlessTaskService.class));
            com.facebook.react.HeadlessJsTaskService.acquireWakeLockNow(this);
        } catch (Exception e) {
            // Background start not allowed: fall back to a generic notification.
            showNotification(this, "Mayfly", "New moment or message");
        }
    }

    @Override
    public void onRegistrationFailed(FailedReason reason, String instance) {
        prefs(this).edit().remove(KEY_ENDPOINT).putString(KEY_STATE, "failed:" + reason.name()).apply();
        UnifiedPushModule.emit("failed", reason.name());
    }

    @Override
    public void onUnregistered(String instance) {
        prefs(this).edit().remove(KEY_ENDPOINT).putString(KEY_STATE, "unregistered").apply();
        UnifiedPushModule.emit("unregistered", null);
    }

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Moments", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("New moments from friends");
                ch.setLockscreenVisibility(NotificationCompat.VISIBILITY_PRIVATE);
                nm.createNotificationChannel(ch);
            }
        }
    }

    static void showNotification(Context c, String title, String text) {
        ensureChannel(c);
        Intent open = new Intent(c, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 0, open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL_ID)
                .setSmallIcon(R.drawable.notification_icon)
                .setContentTitle(title)
                .setContentText(text)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setAutoCancel(true)
                .setContentIntent(pi);
        try {
            NotificationManagerCompat.from(c).notify(NOTIFICATION_ID, b.build());
        } catch (SecurityException ignored) {
            // POST_NOTIFICATIONS not granted — nothing to show
        }
    }
}
