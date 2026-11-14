/**
 * Update notice: asks the Mayfly server for the newest release (it reads the F-Droid
 * index) and compares it with the installed version. Checked at most every 6 hours;
 * a dismissed version is not shown again.
 */
import { useEffect, useState } from 'react';
import { Linking, NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiClient } from '../api/client';

const KEY = 'mayfly_update_v1';
const EVERY_MS = 6 * 3600 * 1000;

interface Stored { checkedAt: number; latestCode?: number; latestName?: string; dismissed?: number }

export const installed: { code: number; name: string } = {
  code: Number(NativeModules.MayflyApp?.versionCode ?? 0),
  name: String(NativeModules.MayflyApp?.versionName ?? ''),
};

async function read(): Promise<Stored> {
  try {
    return JSON.parse((await AsyncStorage.getItem(KEY)) ?? '') as Stored;
  } catch {
    return { checkedAt: 0 };
  }
}

async function write(s: Stored) {
  await AsyncStorage.setItem(KEY, JSON.stringify(s)).catch(() => {});
}

/** Returns the newer version's name, or null. */
export async function checkForUpdate(force = false): Promise<string | null> {
  const st = await read();
  if (force || Date.now() - (st.checkedAt ?? 0) > EVERY_MS) {
    try {
      const res = await apiClient.get('/version');
      const code = Number(res.data?.version_code);
      const name = String(res.data?.version_name ?? '');
      if (Number.isFinite(code) && /^[0-9A-Za-z.+-]{1,32}$/.test(name)) {
        st.latestCode = code;
        st.latestName = name;
      }
    } catch (_) {
      // server without update info, offline … try again later
    }
    st.checkedAt = Date.now();
    await write(st);
  }
  if (!installed.code || !st.latestCode || st.latestCode <= installed.code) return null;
  if (st.dismissed === st.latestCode) return null;
  return st.latestName ?? 'new';
}

export async function dismissUpdate() {
  const st = await read();
  st.dismissed = st.latestCode;
  await write(st);
}

/** Opens Mayfly in F-Droid (or another store app that handles market:// links). */
export function openUpdate() {
  Linking.openURL('market://details?id=de.paul42.mayfly').catch(() =>
    Linking.openURL('https://mayfly.paul42.de/#installieren').catch(() => {}),
  );
}

/** [newer version name or null, dismiss] — checks once when the screen mounts. */
export function useUpdateNotice(): [string | null, () => void] {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    checkForUpdate().then(setName).catch(() => {});
  }, []);
  return [name, () => { setName(null); dismissUpdate(); }];
}
