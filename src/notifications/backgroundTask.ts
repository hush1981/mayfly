import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import { PermissionsAndroid, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { initServerUrl } from '../api/client';
import { syncNow } from '../sync/sync';
import { getToken } from '../store/session';
import { flushChatStore } from '../store/chatStore';
import { notifyNew } from './notify';

export const INBOX_CHECK_TASK = 'MAYFLY_INBOX_CHECK';
const LAST_SEEN_KEY = 'mayfly_last_seen_at';



TaskManager.defineTask(INBOX_CHECK_TASK, async () => {
  try {
    // Ensure server URL is loaded before making API calls
    await initServerUrl();

    const token = await getToken();
    if (!token) return BackgroundFetch.BackgroundFetchResult.NoData;

    const { newIncoming, notices } = await syncNow();
    await flushChatStore();

    const lastSeenStr = await AsyncStorage.getItem(LAST_SEEN_KEY);
    const lastSeen = lastSeenStr ? new Date(lastSeenStr).getTime() : 0;
    const fresh = newIncoming.filter((s) => new Date(s.createdAt).getTime() > lastSeen);
    if (fresh.length === 0 && notices.length === 0) return BackgroundFetch.BackgroundFetchResult.NoData;

    if (fresh.length > 0) {
      const newest = fresh.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
      await AsyncStorage.setItem(LAST_SEEN_KEY, newest.createdAt);
    }

    const shown = await notifyNew(fresh, notices);
    return shown ? BackgroundFetch.BackgroundFetchResult.NewData : BackgroundFetch.BackgroundFetchResult.NoData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export async function registerBackgroundFetch(): Promise<void> {
  // Android 13+: ask for the notification permission (no Google / Firebase involved).
  if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
    const res = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    if (res !== PermissionsAndroid.RESULTS.GRANTED) return;
  }

  await BackgroundFetch.registerTaskAsync(INBOX_CHECK_TASK, {
    minimumInterval: 15 * 60, // 15 minutes (Android minimum)
    stopOnTerminate: false,
    startOnBoot: true,
  });
}

export async function updateLastSeen(): Promise<void> {
  await AsyncStorage.setItem(LAST_SEEN_KEY, new Date().toISOString());
}
