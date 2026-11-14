package de.paul42.mayfly.app;

import android.content.Context;
import android.content.Intent;

import androidx.annotation.NonNull;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.uimanager.ViewManager;

import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** App-level helpers: own version (for the update notice) and restart (to apply a new theme). */
public class AppRestartModule extends ReactContextBaseJavaModule {
    AppRestartModule(ReactApplicationContext ctx) {
        super(ctx);
    }

    @NonNull
    @Override
    public String getName() {
        return "MayflyApp";
    }

    @Override
    public Map<String, Object> getConstants() {
        Map<String, Object> m = new HashMap<>();
        m.put("versionCode", de.paul42.mayfly.BuildConfig.VERSION_CODE);
        m.put("versionName", de.paul42.mayfly.BuildConfig.VERSION_NAME);
        return m;
    }

    @ReactMethod
    public void restart() {
        Context c = getReactApplicationContext();
        Intent i = c.getPackageManager().getLaunchIntentForPackage(c.getPackageName());
        if (i != null) {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
            c.startActivity(i);
        }
        Runtime.getRuntime().exit(0);
    }

    public static class Package implements ReactPackage {
        @NonNull
        @Override
        public List<NativeModule> createNativeModules(@NonNull ReactApplicationContext ctx) {
            return Collections.singletonList(new AppRestartModule(ctx));
        }

        @NonNull
        @Override
        public List<ViewManager> createViewManagers(@NonNull ReactApplicationContext ctx) {
            return Collections.emptyList();
        }
    }
}
