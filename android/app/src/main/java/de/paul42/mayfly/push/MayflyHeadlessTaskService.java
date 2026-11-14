package de.paul42.mayfly.push;

import android.content.Intent;

import androidx.annotation.Nullable;

import com.facebook.react.HeadlessJsTaskService;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.jstasks.HeadlessJsTaskConfig;

/**
 * Runs the JS task "MayflyPushTask" when a push arrives while the app is not running:
 * it syncs, decides which chats are muted and posts the notification itself.
 */
public class MayflyHeadlessTaskService extends HeadlessJsTaskService {
    @Override
    protected @Nullable HeadlessJsTaskConfig getTaskConfig(Intent intent) {
        return new HeadlessJsTaskConfig("MayflyPushTask", Arguments.createMap(), 30000, true);
    }
}
