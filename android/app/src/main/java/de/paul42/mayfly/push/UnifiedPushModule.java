package de.paul42.mayfly.push;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationManagerCompat;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import org.unifiedpush.android.connector.UnifiedPush;

import java.lang.ref.WeakReference;
import java.util.List;

/** JS bridge for UnifiedPush: choose a distributor, register/unregister, read the endpoint. */
public class UnifiedPushModule extends ReactContextBaseJavaModule {
    static final String INSTANCE = "default";
    private static WeakReference<ReactApplicationContext> current = new WeakReference<>(null);

    UnifiedPushModule(ReactApplicationContext ctx) {
        super(ctx);
        current = new WeakReference<>(ctx);
    }

    @NonNull
    @Override
    public String getName() {
        return "MayflyUnifiedPush";
    }

    /**
     * Forwards a push event to JS if the app is running (otherwise JS reads the state on start).
     * Returns false when no JS instance was there to receive it.
     */
    static boolean emit(String type, @Nullable String value) {
        ReactApplicationContext ctx = current.get();
        if (ctx == null || !ctx.hasActiveReactInstance()) return false;
        WritableMap m = Arguments.createMap();
        m.putString("type", type);
        if (value != null) m.putString("value", value);
        try {
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("MayflyUnifiedPush", m);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    /** Posts Mayfly's notification (text chosen by JS: sender names, muted chats left out). */
    @ReactMethod
    public void showNotification(String title, String text, Promise promise) {
        MayflyPushService.showNotification(getReactApplicationContext(), title, text);
        promise.resolve(true);
    }

    @ReactMethod
    public void getDistributors(Promise promise) {
        Context c = getReactApplicationContext();
        PackageManager pm = c.getPackageManager();
        WritableArray out = Arguments.createArray();
        List<String> pkgs = UnifiedPush.getDistributors(c);
        for (String p : pkgs) {
            if (p.equals(c.getPackageName())) continue;
            WritableMap m = Arguments.createMap();
            m.putString("packageName", p);
            String label = p;
            try {
                ApplicationInfo ai = pm.getApplicationInfo(p, 0);
                label = pm.getApplicationLabel(ai).toString();
            } catch (PackageManager.NameNotFoundException ignored) {
            }
            m.putString("label", label);
            out.pushMap(m);
        }
        promise.resolve(out);
    }

    @ReactMethod
    public void getStatus(Promise promise) {
        Context c = getReactApplicationContext();
        WritableMap m = Arguments.createMap();
        m.putString("distributor", UnifiedPush.getAckDistributor(c));
        m.putString("savedDistributor", UnifiedPush.getSavedDistributor(c));
        m.putString("endpoint", MayflyPushService.prefs(c).getString(MayflyPushService.KEY_ENDPOINT, null));
        m.putString("state", MayflyPushService.prefs(c).getString(MayflyPushService.KEY_STATE, null));
        m.putBoolean("notificationsEnabled", NotificationManagerCompat.from(c).areNotificationsEnabled());
        promise.resolve(m);
    }

    @ReactMethod
    public void register(String distributor, Promise promise) {
        Context c = getReactApplicationContext();
        try {
            MayflyPushService.ensureChannel(c);
            UnifiedPush.saveDistributor(c, distributor);
            UnifiedPush.register(c, INSTANCE, "Mayfly", null);
            MayflyPushService.prefs(c).edit().putString(MayflyPushService.KEY_STATE, "pending").apply();
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("register_failed", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void unregister(Promise promise) {
        Context c = getReactApplicationContext();
        try {
            UnifiedPush.unregister(c, INSTANCE);
            UnifiedPush.removeDistributor(c);
        } catch (Exception ignored) {
        }
        MayflyPushService.prefs(c).edit().clear().apply();
        promise.resolve(true);
    }

    /** Removes Mayfly's own notifications (e.g. when the app is opened). */
    @ReactMethod
    public void clearNotifications(Promise promise) {
        NotificationManagerCompat.from(getReactApplicationContext()).cancel(MayflyPushService.NOTIFICATION_ID);
        promise.resolve(true);
    }

    // Required for NativeEventEmitter on Android
    @ReactMethod
    public void addListener(String eventName) {
    }

    @ReactMethod
    public void removeListeners(double count) {
    }
}
