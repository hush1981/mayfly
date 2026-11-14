package de.paul42.mayfly.call;

import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.facebook.react.bridge.ActivityEventListener;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import de.paul42.mayfly.MainActivity;
import de.paul42.mayfly.R;

/**
 * Native side of calls (the media itself is WebRTC in JS):
 * - ringing: in-app ringtone + vibration, or a full-screen "incoming call" notification when
 *   the app is in the background (Answer / Decline open the app with the action);
 * - audio: communication mode, speaker / earpiece, proximity screen-off for voice calls;
 * - a foreground service so a running call is not killed when the app goes to the background.
 */
public class CallModule extends ReactContextBaseJavaModule implements ActivityEventListener {
    static final String CHANNEL_RING = "calls_ring";
    static final String CHANNEL_ONGOING = "calls";
    static final int RING_ID = 4712;
    static final String EXTRA_ACTION = "mayfly_call_action";
    static final String EXTRA_CALL = "mayfly_call_id";
    static final String EXTRA_TOKEN = "mayfly_call_token";

    /**
     * Random value carried by the intents of the current "incoming call" notification.
     * MainActivity is exported (launcher), so any app could start it with the call extras;
     * only an intent with this value may show the app over the lock screen or act on a call.
     */
    private static volatile String ringToken;

    /** True if the intent comes from our own incoming-call notification that is still valid. */
    public static boolean isRing(Intent i) {
        String t = ringToken;
        return i != null && t != null && i.hasExtra(EXTRA_ACTION) && t.equals(i.getStringExtra(EXTRA_TOKEN));
    }

    private static String newToken() {
        byte[] b = new byte[16];
        new java.security.SecureRandom().nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    private Ringtone ringtone;
    private PowerManager.WakeLock proximity;
    private String pendingAction;
    private String pendingCall;

    public CallModule(ReactApplicationContext ctx) {
        super(ctx);
        ctx.addActivityEventListener(this);
    }

    @NonNull
    @Override
    public String getName() {
        return "MfCall";
    }

    // ---- actions from the notification -----------------------------------------------------

    private void handleIntent(Intent i) {
        if (i == null || !i.hasExtra(EXTRA_ACTION)) return;
        boolean ours = isRing(i);
        String action = i.getStringExtra(EXTRA_ACTION);
        String call = i.getStringExtra(EXTRA_CALL);
        i.removeExtra(EXTRA_ACTION);
        i.removeExtra(EXTRA_TOKEN);
        if (!ours) return; // not from our notification (another app, or an old one)
        cancelRing(getReactApplicationContext());
        if (getReactApplicationContext().hasActiveReactInstance()) {
            WritableMap m = Arguments.createMap();
            m.putString("action", action);
            m.putString("callId", call);
            getReactApplicationContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("MfCallAction", m);
        }
        pendingAction = action;
        pendingCall = call;
    }

    @Override
    public void onNewIntent(Intent intent) {
        handleIntent(intent);
    }

    @Override
    public void onActivityResult(Activity activity, int requestCode, int resultCode, Intent data) {
    }

    /** Action the app was opened with (answer / decline / open), once. */
    @ReactMethod
    public void takeLaunchAction(Promise p) {
        Activity a = getCurrentActivity();
        if (a != null) handleIntent(a.getIntent());
        if (pendingAction == null) {
            p.resolve(null);
            return;
        }
        WritableMap m = Arguments.createMap();
        m.putString("action", pendingAction);
        m.putString("callId", pendingCall);
        pendingAction = null;
        pendingCall = null;
        p.resolve(m);
    }

    @ReactMethod
    public void addListener(String event) {
    }

    @ReactMethod
    public void removeListeners(double count) {
    }

    // ---- ringing ---------------------------------------------------------------------------

    @ReactMethod
    public void startRinging() {
        stopRinging();
        Context c = getReactApplicationContext();
        AudioManager am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
        if (am != null && am.getRingerMode() == AudioManager.RINGER_MODE_NORMAL) {
            Uri uri = RingtoneManager.getActualDefaultRingtoneUri(c, RingtoneManager.TYPE_RINGTONE);
            if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            ringtone = RingtoneManager.getRingtone(c, uri);
            if (ringtone != null) {
                if (Build.VERSION.SDK_INT >= 28) ringtone.setLooping(true);
                ringtone.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
                ringtone.play();
            }
        }
        if (am == null || am.getRingerMode() != AudioManager.RINGER_MODE_SILENT) {
            Vibrator v = (Vibrator) c.getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null && v.hasVibrator()) {
                long[] pattern = {0, 700, 900};
                if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createWaveform(pattern, 0));
                else v.vibrate(pattern, 0);
            }
        }
    }

    @ReactMethod
    public void stopRinging() {
        if (ringtone != null) {
            try { ringtone.stop(); } catch (Exception ignored) { }
            ringtone = null;
        }
        Vibrator v = (Vibrator) getReactApplicationContext().getSystemService(Context.VIBRATOR_SERVICE);
        if (v != null) v.cancel();
    }

    static void ensureChannels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL_RING) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_RING, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
            ch.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            ch.enableVibration(true);
            ch.setVibrationPattern(new long[]{0, 700, 900});
            ch.setLockscreenVisibility(NotificationCompat.VISIBILITY_PRIVATE);
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel(CHANNEL_ONGOING) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ONGOING, "Ongoing calls", NotificationManager.IMPORTANCE_LOW);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }
    }

    private static PendingIntent open(Context c, String action, String callId, int code) {
        Intent i = new Intent(c, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_ACTION, action)
                .putExtra(EXTRA_CALL, callId)
                .putExtra(EXTRA_TOKEN, ringToken);
        return PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** Incoming call while the app is not on screen (posted from the push / headless task). */
    @ReactMethod
    public void showIncoming(String callId, String title, String text, String answerLabel, String declineLabel) {
        Context c = getReactApplicationContext();
        ensureChannels(c);
        ringToken = newToken();
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL_RING)
                .setSmallIcon(R.drawable.notification_icon)
                .setContentTitle(title)
                .setContentText(text)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setOngoing(true)
                .setAutoCancel(true)
                .setTimeoutAfter(50_000)
                .setContentIntent(open(c, "open", callId, 1))
                .setFullScreenIntent(open(c, "open", callId, 2), true)
                .addAction(0, declineLabel, open(c, "decline", callId, 3))
                .addAction(0, answerLabel, open(c, "answer", callId, 4));
        android.app.Notification n = b.build();
        n.flags |= android.app.Notification.FLAG_INSISTENT;
        try {
            NotificationManagerCompat.from(c).notify(RING_ID, n);
        } catch (SecurityException ignored) {
        }
    }

    static void cancelRing(Context c) {
        NotificationManagerCompat.from(c).cancel(RING_ID);
    }

    @ReactMethod
    public void cancelIncoming() {
        cancelRing(getReactApplicationContext());
    }

    // ---- during a call ---------------------------------------------------------------------

    @ReactMethod
    public void startCall(String title, boolean video, boolean speaker) {
        Context c = getReactApplicationContext();
        stopRinging();
        cancelRing(c);
        AudioManager am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
        if (am != null) {
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            am.setSpeakerphoneOn(speaker);
        }
        setProximity(!video && !speaker);
        Intent s = new Intent(c, CallService.class).putExtra("title", title).putExtra("video", video);
        try {
            ContextCompat.startForegroundService(c, s);
        } catch (Exception ignored) {
            // not allowed right now (background start): the call still runs while visible
        }
    }

    @ReactMethod
    public void setSpeaker(boolean on, boolean video) {
        AudioManager am = (AudioManager) getReactApplicationContext().getSystemService(Context.AUDIO_SERVICE);
        if (am != null) am.setSpeakerphoneOn(on);
        setProximity(!video && !on);
    }

    private void setProximity(boolean on) {
        PowerManager pm = (PowerManager) getReactApplicationContext().getSystemService(Context.POWER_SERVICE);
        if (on) {
            if (proximity == null && pm != null && pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
                proximity = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "mayfly:call");
                proximity.acquire(4 * 3600_000L);
            }
        } else if (proximity != null) {
            try { proximity.release(); } catch (Exception ignored) { }
            proximity = null;
        }
    }

    // ---- lock screen ------------------------------------------------------------------------

    private boolean deviceLocked() {
        android.app.KeyguardManager km = (android.app.KeyguardManager)
                getReactApplicationContext().getSystemService(Context.KEYGUARD_SERVICE);
        return km != null && km.isKeyguardLocked();
    }

    /** True while the phone is locked (the call screen is then shown over the lock screen). */
    @ReactMethod
    public void isDeviceLocked(Promise p) {
        p.resolve(deviceLocked());
    }

    /**
     * Ends "show over the lock screen". Only the call screen may ever be visible on a locked
     * phone: JS calls this whenever another screen is shown and when a call is over. If the
     * phone is still locked, the app goes behind the lock screen again.
     */
    @ReactMethod
    public void relock() {
        final Activity a = getCurrentActivity();
        if (a == null) return;
        a.runOnUiThread(() -> {
            try {
                if (Build.VERSION.SDK_INT >= 27) {
                    a.setShowWhenLocked(false);
                    a.setTurnScreenOn(false);
                }
                if (deviceLocked()) a.moveTaskToBack(true);
            } catch (Exception ignored) {
            }
        });
    }

    @ReactMethod
    public void endCall() {
        Context c = getReactApplicationContext();
        ringToken = null;
        relock();
        stopRinging();
        cancelRing(c);
        setProximity(false);
        AudioManager am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
        if (am != null) {
            am.setSpeakerphoneOn(false);
            am.setMode(AudioManager.MODE_NORMAL);
        }
        c.stopService(new Intent(c, CallService.class));
    }
}
