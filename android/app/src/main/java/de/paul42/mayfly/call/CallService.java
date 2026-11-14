package de.paul42.mayfly.call;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import de.paul42.mayfly.MainActivity;
import de.paul42.mayfly.R;

/** Keeps a running call alive while the app is in the background (ongoing notification). */
public class CallService extends Service {
    static final int ID = 4713;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        CallModule.ensureChannels(this);
        String title = intent != null ? intent.getStringExtra("title") : null;
        boolean video = intent != null && intent.getBooleanExtra("video", false);
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        Notification n = new NotificationCompat.Builder(this, CallModule.CHANNEL_ONGOING)
                .setSmallIcon(R.drawable.notification_icon)
                .setContentTitle(title != null ? title : "Mayfly")
                .setOngoing(true)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setContentIntent(PendingIntent.getActivity(this, 5, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
                .build();
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                if (video) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
                startForeground(ID, n, type);
            } else {
                startForeground(ID, n);
            }
        } catch (Exception e) {
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
