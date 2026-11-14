/**
 * UnifiedPush: a distributor app (e.g. ntfy) keeps one connection open and wakes Mayfly
 * when the server posts an (empty) message to our endpoint. Mayfly then shows its own
 * notification and syncs — the distributor never sees content or sender.
 */
import { AppState, NativeEventEmitter, NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiClient } from '../api/client';
import { syncNow } from '../sync/sync';
import { notifyNew } from '../notifications/notify';

export interface Distributor { packageName: string; label: string }
export interface PushStatus {
  distributor: string | null;
  savedDistributor: string | null;
  endpoint: string | null;
  state: string | null;
  notificationsEnabled: boolean;
}

const Native = NativeModules.MayflyUnifiedPush as
  | {
      getDistributors(): Promise<Distributor[]>;
      getStatus(): Promise<PushStatus>;
      register(pkg: string): Promise<boolean>;
      unregister(): Promise<boolean>;
      clearNotifications(): Promise<boolean>;
    }
  | undefined;

const UPLOADED_KEY = 'mayfly_push_uploaded_endpoint';

export const pushAvailable = Platform.OS === 'android' && !!Native;

export async function getDistributors(): Promise<Distributor[]> {
  return Native ? Native.getDistributors() : [];
}

export async function getPushStatus(): Promise<PushStatus | null> {
  return Native ? Native.getStatus() : null;
}

/** Sends the current endpoint to the server if it changed since the last upload. */
export async function syncEndpointToServer(force = false): Promise<void> {
  if (!Native) return;
  const st = await Native.getStatus();
  const endpoint = st.endpoint ?? '';
  const uploaded = (await AsyncStorage.getItem(UPLOADED_KEY)) ?? '';
  if (!force && endpoint === uploaded) return;
  await apiClient.put('/users/me/push', { endpoint });
  await AsyncStorage.setItem(UPLOADED_KEY, endpoint);
}

export async function enablePush(distributor: string): Promise<void> {
  if (!Native) throw new Error('Push is only available on Android');
  await Native.register(distributor);
  // The endpoint arrives asynchronously via the "endpoint" event.
}

export async function disablePush(): Promise<void> {
  if (!Native) return;
  await Native.unregister();
  try {
    await apiClient.put('/users/me/push', { endpoint: '' });
  } finally {
    await AsyncStorage.removeItem(UPLOADED_KEY);
  }
}

export async function clearPushNotifications(): Promise<void> {
  if (Native) await Native.clearNotifications().catch(() => {});
}

type Listener = (type: string, value?: string) => void;
const listeners = new Set<Listener>();

export function onPushEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let started = false;

/** Wires native push events to the server upload and to an immediate sync. Call once after login. */
export function startPushBridge(): void {
  if (started || !Native) return;
  started = true;
  const emitter = new NativeEventEmitter(NativeModules.MayflyUnifiedPush);
  emitter.addListener('MayflyUnifiedPush', (e: { type: string; value?: string }) => {
    if (e.type === 'endpoint' || e.type === 'unregistered') {
      syncEndpointToServer().catch(() => {});
    } else if (e.type === 'message') {
      // In the foreground the chat list updates itself; in the background we notify.
      syncNow()
        .then((r) => (AppState.currentState !== 'active' ? notifyNew(r.newIncoming, r.notices) : false))
        .catch(() => {});
    }
    listeners.forEach((l) => l(e.type, e.value));
  });
  // Endpoint may have changed while the app was not running.
  syncEndpointToServer().catch(() => {});
}
