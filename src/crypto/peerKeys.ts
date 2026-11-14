/**
 * Trust-on-first-use tracking of friends' public keys, plus a "security code" that two
 * people can compare in person to rule out a server swapping keys (MITM).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import nacl from 'tweetnacl';
import { decodeBase64 } from 'tweetnacl-util';
import { getUserPublicKey } from '../api/users';
import { getOwnPublicKey } from './keys';
import { peerName, username } from '../store/chatStore';
import { getSecureJson, setSecureJson } from '../store/secureJson';
import { t } from '../i18n';

const KEY = 'mayfly_known_keys_v1';

interface Known {
  /** The key we trust for this friend (first seen, accepted or verified). */
  key: string;
  firstSeen: string;
  /** Set when the server returned a different key than the trusted one. */
  changedAt?: string;
  /** The key the server offers instead — NOT used until the user accepts or verifies it. */
  pendingKey?: string;
  /** The key that was verified in person (QR scan or code comparison). */
  verifiedKey?: string;
}

/**
 * Thrown when a friend's key changed on the server. Nothing is encrypted to the new key
 * and nothing signed with it is accepted until the user accepts or re-verifies it — so a
 * compromised server cannot silently swap keys to read along or impersonate a friend.
 */
export class KeyChangedError extends Error {
  constructor(public peerId: string, public wasVerified: boolean) {
    super(t("{name}'s security key changed. Open the chat with {name} and confirm or verify the new key first.", {
      name: peerName(peerId) ?? '?',
    }));
  }
}

let cache: Record<string, Known> | null = null;

async function load(): Promise<Record<string, Known>> {
  if (cache) return cache;
  try {
    cache = (await getSecureJson<Record<string, Known>>(KEY)) ?? {};
  } catch {
    cache = {};
  }
  return cache!;
}

async function save() {
  if (cache) await setSecureJson(KEY, cache).catch(() => {});
}

/** Records what the server offers right now; returns the server key and the trusted state. */
async function observe(peerId: string): Promise<{ serverKey: string; entry: Known }> {
  const serverKey = await getUserPublicKey(peerId);
  const known = await load();
  await applyScannedKey(peerId, serverKey, known);
  const now = new Date().toISOString();
  const prev = known[peerId];
  if (!prev) {
    // Trust on first use.
    known[peerId] = { key: serverKey, firstSeen: now };
    await save();
  } else if (prev.key === serverKey) {
    if (prev.pendingKey || prev.changedAt) {
      known[peerId] = { ...prev, pendingKey: undefined, changedAt: undefined };
      await save();
    }
  } else if (prev.pendingKey !== serverKey) {
    known[peerId] = { ...prev, pendingKey: serverKey, changedAt: prev.changedAt ?? now };
    await save();
  }
  return { serverKey, entry: known[peerId] };
}

/**
 * The trusted public key of a friend, for encrypting to them and checking their messages.
 * Throws KeyChangedError while the server offers a different, not yet accepted key.
 */
export async function getPeerKey(peerId: string): Promise<string> {
  const { entry } = await observe(peerId);
  if (entry.pendingKey) throw new KeyChangedError(peerId, entry.verifiedKey === entry.key);
  return entry.key;
}

/** The key we currently trust for a friend, from the local store only (no server call). */
export async function trustedKeyLocal(peerId: string): Promise<string | undefined> {
  return (await load())[peerId]?.key;
}

/** Pending key change: when it was noticed and whether the old key had been verified. */
export async function pendingKeyChange(peerId: string): Promise<{ since: string; wasVerified: boolean } | null> {
  const k = (await load())[peerId];
  if (!k?.pendingKey) return null;
  return { since: k.changedAt ?? '', wasVerified: !!k.verifiedKey && k.verifiedKey === k.key };
}

export async function keyChangedAt(peerId: string): Promise<string | undefined> {
  const k = (await load())[peerId];
  return k?.pendingKey ? k.changedAt : undefined;
}

/** Accepts the key the server offers now (the user decided to trust it without checking). */
export async function acceptNewKey(peerId: string): Promise<void> {
  const { serverKey } = await observe(peerId);
  const known = await load();
  known[peerId] = { ...known[peerId], key: serverKey, pendingKey: undefined, changedAt: undefined };
  await save();
}

export async function forgetKnownKeys() {
  cache = {};
  await AsyncStorage.removeItem(KEY).catch(() => {});
  await AsyncStorage.removeItem(SCANNED_KEY).catch(() => {});
}

function cmp(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * Security code for a pair of keys — identical on both phones. 30 digits in 6 groups.
 * Derived from SHA-512 over both public keys (sorted), so it changes if either key changes.
 */
export function securityCode(keyA: string, keyB: string): string {
  const a = decodeBase64(keyA);
  const b = decodeBase64(keyB);
  const [x, y] = cmp(a, b) <= 0 ? [a, b] : [b, a];
  const buf = new Uint8Array(x.length + y.length);
  buf.set(x, 0);
  buf.set(y, x.length);
  const h = nacl.hash(buf);
  const groups: string[] = [];
  for (let i = 0; i < 6; i++) {
    // 5 bytes → number mod 100000 (bias is negligible for a comparison code)
    let n = 0;
    for (let j = 0; j < 5; j++) n = (n * 256 + h[i * 5 + j]) % 100000;
    groups.push(String(n).padStart(5, '0'));
  }
  return groups.join(' ');
}

/** Security code with the key the server offers now (also while a change is pending). */
export async function securityCodeWith(peerId: string): Promise<string> {
  const [mine, { serverKey }] = await Promise.all([getOwnPublicKey(), observe(peerId)]);
  return securityCode(mine, serverKey);
}

/** Verified = the key we use right now is the one that was checked in person. */
export async function isVerified(peerId: string): Promise<boolean> {
  const k = (await load())[peerId];
  return !!k && !!k.verifiedKey && k.verifiedKey === k.key;
}

/** Marks the peer's *current* key as verified (fetched fresh, so a swapped key is caught). */
export async function markVerified(peerId: string): Promise<void> {
  // The code was compared for the key the server offers now: that key becomes trusted.
  const { serverKey } = await observe(peerId);
  const known = await load();
  known[peerId] = { ...known[peerId], key: serverKey, verifiedKey: serverKey, pendingKey: undefined, changedAt: undefined };
  await save();
}

export async function unmarkVerified(peerId: string): Promise<void> {
  const known = await load();
  if (known[peerId]) {
    delete known[peerId].verifiedKey;
    await save();
  }
}

const QR_PREFIX = 'mayfly-verify:1:';

/** Content of the QR code for a chat: the pair's security code (identical on both phones). */
export function verifyQrPayload(code: string): string {
  return QR_PREFIX + code.replace(/\s/g, '');
}

/** Result of scanning the friend's QR code. */
export function checkScannedPayload(scanned: string, code: string): 'match' | 'mismatch' | 'invalid' {
  if (!scanned.startsWith(QR_PREFIX)) return 'invalid';
  return scanned === verifyQrPayload(code) ? 'match' : 'mismatch';
}

// ---- Adding friends by QR code -------------------------------------------------------

const FRIEND_PREFIX = 'mayfly-friend:1:';
const SCANNED_KEY = 'mayfly_scanned_friend_keys_v1';

function toB64Url(b64: string) { return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function fromB64Url(s: string) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return b + '='.repeat((4 - (b.length % 4)) % 4);
}

/** QR content for "add me": username + own public key (so the scan also verifies). */
export async function friendQrPayload(username: string): Promise<string> {
  return FRIEND_PREFIX + username + ':' + toB64Url(await getOwnPublicKey());
}

export function parseFriendQr(data: string): { username: string; key: string } | null {
  if (!data.startsWith(FRIEND_PREFIX)) return null;
  const rest = data.slice(FRIEND_PREFIX.length);
  const i = rest.lastIndexOf(':');
  if (i <= 0) return null;
  const username = rest.slice(0, i);
  const key = fromB64Url(rest.slice(i + 1));
  if (!/^[A-Za-z0-9_]{3,50}$/.test(username)) return null;
  try {
    if (decodeBase64(key).length !== 32) return null;
  } catch {
    return null;
  }
  return { username, key };
}

async function loadScanned(): Promise<Record<string, string>> {
  try { return (await getSecureJson<Record<string, string>>(SCANNED_KEY)) ?? {}; } catch { return {}; }
}

/** Remembers a key scanned in person; applied as soon as we learn that user's id. */
export async function rememberScannedFriendKey(username: string, key: string) {
  const m = await loadScanned();
  m[username.toLowerCase()] = key;
  await setSecureJson(SCANNED_KEY, m);
}

/**
 * If the peer's key was scanned in person: a match marks it verified, a mismatch is
 * flagged like a key change (someone in between, or the friend reinstalled).
 */
async function applyScannedKey(peerId: string, serverKey: string, known: Record<string, Known>) {
  // by username (the scanned code carries the username; nicknames are local)
  const name = username(peerId);
  if (!name) return;
  const m = await loadScanned();
  const scanned = m[name.toLowerCase()];
  if (!scanned) return;
  const now = new Date().toISOString();
  if (scanned === serverKey) {
    known[peerId] = { firstSeen: known[peerId]?.firstSeen ?? now, key: serverKey, verifiedKey: serverKey };
  } else {
    // Scanned in person beats the server: trust the scanned key, hold the server's back.
    known[peerId] = { firstSeen: known[peerId]?.firstSeen ?? now, key: scanned, verifiedKey: scanned, pendingKey: serverKey, changedAt: now };
  }
  delete m[name.toLowerCase()];
  await setSecureJson(SCANNED_KEY, m);
  await save();
}
