/**
 * Session token storage. The JWT lives in the Android Keystore-backed SecureStore,
 * never in plain AsyncStorage; an in-memory copy avoids a keystore hit per request.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'mayfly_auth_token';
const LEGACY_KEY = 'mayfly_auth_token';
/** When the current token was issued (ms) — decides when to renew it. */
const TOKEN_AT_KEY = 'mayfly_auth_token_at';

let cached: string | null | undefined;
let issuedAt: number | undefined;

export async function getToken(): Promise<string | null> {
  if (cached !== undefined) return cached;
  let t = await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);
  if (!t) {
    // One-time migration from versions ≤ 1.7 that kept it in AsyncStorage.
    const legacy = await AsyncStorage.getItem(LEGACY_KEY);
    if (legacy) {
      await setToken(legacy);
      t = legacy;
    }
  }
  cached = t ?? null;
  return cached;
}

export async function setToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await AsyncStorage.removeItem(LEGACY_KEY).catch(() => {});
  cached = token;
  issuedAt = Date.now();
  await AsyncStorage.setItem(TOKEN_AT_KEY, String(issuedAt)).catch(() => {});
}

export async function clearToken(): Promise<void> {
  cached = null;
  issuedAt = undefined;
  await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
  await AsyncStorage.removeItem(LEGACY_KEY).catch(() => {});
  await AsyncStorage.removeItem(TOKEN_AT_KEY).catch(() => {});
}

/** The token in memory, without touching the keystore (undefined = not loaded yet). */
export function tokenInMemory(): string | null | undefined {
  return cached;
}

/** When the current token was issued (0 = unknown, e.g. a login from an older version). */
export async function tokenIssuedAt(): Promise<number> {
  if (issuedAt === undefined) {
    const v = Number(await AsyncStorage.getItem(TOKEN_AT_KEY).catch(() => null));
    issuedAt = Number.isFinite(v) && v > 0 ? v : 0;
  }
  return issuedAt;
}

// ---- session ended by the server ---------------------------------------------------------

const expiredListeners = new Set<() => void>();

/** Called when the server no longer accepts the session (expired, password changed elsewhere). */
export function onSessionExpired(fn: () => void): () => void {
  expiredListeners.add(fn);
  return () => { expiredListeners.delete(fn); };
}

/**
 * The server rejected `usedToken` as a session. Only the token is dropped — chats, keys and
 * everything else on the phone stay, so logging in again continues where it stopped.
 * A stale request that still carried an older token must not end a newer session.
 */
export async function reportSessionExpired(usedToken: string): Promise<void> {
  const current = await getToken();
  if (!current || current !== usedToken) return;
  await clearToken();
  expiredListeners.forEach((fn) => { try { fn(); } catch (_) {} });
}

/** Own user id (stored at login by AuthProvider). */
export async function getUserId(): Promise<string> {
  const id = await AsyncStorage.getItem('mayfly_user_id');
  if (!id) throw new Error('Not logged in');
  return id;
}
