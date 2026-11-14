/**
 * Encryption at rest for app data in AsyncStorage (chat history, text messages, outbox).
 * XSalsa20-Poly1305 (nacl.secretbox) with a random 32-byte key kept in SecureStore
 * (Android Keystore-backed). Format: "e1:" + base64(nonce || ciphertext).
 * Plain JSON written by older versions is still read and re-encrypted on the next write.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';
import { decodeBase64, decodeUTF8, encodeBase64, encodeUTF8 } from 'tweetnacl-util';

const KEY_NAME = 'mayfly_store_key_v1';
const PREFIX = 'e1:';
let key: Uint8Array | null = null;

async function storeKey(): Promise<Uint8Array> {
  if (key) return key;
  const existing = await SecureStore.getItemAsync(KEY_NAME);
  if (existing) {
    key = decodeBase64(existing);
  } else {
    key = nacl.randomBytes(nacl.secretbox.keyLength);
    await SecureStore.setItemAsync(KEY_NAME, encodeBase64(key), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
  return key;
}

export async function getSecureJson<T>(name: string): Promise<T | null> {
  const raw = await AsyncStorage.getItem(name);
  if (!raw) return null;
  if (!raw.startsWith(PREFIX)) {
    try { return JSON.parse(raw) as T; } catch { return null; } // legacy plain JSON
  }
  const bytes = decodeBase64(raw.slice(PREFIX.length));
  const nonce = bytes.subarray(0, nacl.secretbox.nonceLength);
  const plain = nacl.secretbox.open(bytes.subarray(nacl.secretbox.nonceLength), nonce, await storeKey());
  if (!plain) return null; // wrong key (e.g. after reinstall) or tampered
  return JSON.parse(encodeUTF8(plain)) as T;
}

export async function setSecureJson(name: string, value: unknown): Promise<void> {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(decodeUTF8(JSON.stringify(value)), nonce, await storeKey());
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  await AsyncStorage.setItem(name, PREFIX + encodeBase64(out));
}

/** Forgets the at-rest key (logout): anything still encrypted with it becomes unreadable. */
export async function forgetStoreKey(): Promise<void> {
  key = null;
  await SecureStore.deleteItemAsync(KEY_NAME).catch(() => {});
}
