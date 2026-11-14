import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import * as SecureStore from 'expo-secure-store';

const PRIVATE_KEY_STORAGE_KEY = 'mayfly_private_key_b64';

/**
 * Generates a new X25519 keypair, stores the private key in the device's
 * secure enclave, and returns the base64-encoded public key for registration.
 */
export async function generateAndStoreKeyPair(): Promise<string> {
  const keyPair = nacl.box.keyPair();
  await SecureStore.setItemAsync(
    PRIVATE_KEY_STORAGE_KEY,
    encodeBase64(keyPair.secretKey),
    { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
  );
  return encodeBase64(keyPair.publicKey);
}

/**
 * Loads the private key from secure storage. Throws if not found
 * (user must re-register on this device).
 */
export async function loadPrivateKey(): Promise<Uint8Array> {
  const b64 = await SecureStore.getItemAsync(PRIVATE_KEY_STORAGE_KEY);
  if (!b64) throw new Error('Private key not found — please log in again');
  return decodeBase64(b64);
}

export async function hasPrivateKey(): Promise<boolean> {
  const b64 = await SecureStore.getItemAsync(PRIVATE_KEY_STORAGE_KEY);
  return b64 !== null;
}

export async function deletePrivateKey(): Promise<void> {
  await SecureStore.deleteItemAsync(PRIVATE_KEY_STORAGE_KEY);
}

/** Derives the own X25519 public key (base64) from the stored private key. */
export async function getOwnPublicKey(): Promise<string> {
  const secret = await loadPrivateKey();
  return encodeBase64(nacl.box.keyPair.fromSecretKey(secret).publicKey);
}

/** Generates a keypair without storing it (used for key rotation: store only after upload). */
export function generateKeyPair(): { publicKey: string; secretKey: string } {
  const kp = nacl.box.keyPair();
  return { publicKey: encodeBase64(kp.publicKey), secretKey: encodeBase64(kp.secretKey) };
}

export async function storePrivateKey(secretKeyB64: string): Promise<void> {
  await SecureStore.setItemAsync(PRIVATE_KEY_STORAGE_KEY, secretKeyB64, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}
