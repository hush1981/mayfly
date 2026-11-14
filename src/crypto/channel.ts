/**
 * End-to-end channel to one friend on top of the ratchet (crypto/sessions.ts), with the
 * old static-key format (crypto/sealed.ts) as fallback for friends that have not shown
 * forward-secrecy support yet.
 *
 * Formats:
 * - relay events: ratchet message as payload (nonce field random), or the old sealed box.
 * - envelopes stored as one blob (story keys): ratchet message, or "MFL1" | nonce | sealed box.
 * - media (moments, voice, group media): "MFM1" | u32 envelope length | envelope | blob, where
 *   blob = secretbox(payload) with a random key and the envelope carries that key plus the
 *   sender binding. One blob can go to many people; only the envelope is per person.
 */
import nacl from 'tweetnacl';
import { decodeBase64, decodeUTF8, encodeBase64, encodeUTF8 } from 'tweetnacl-util';
import { loadPrivateKey } from './keys';
import { getPeerKey } from './peerKeys';
import { concat, isRatchetMessage } from './ratchet';
import { openFrom, seal } from './sealed';
import { ratchetDecrypt, ratchetEncrypt } from './sessions';

const LEGACY = [0x4d, 0x46, 0x4c, 0x31]; // "MFL1"
const MEDIA = [0x4d, 0x46, 0x4d, 0x31]; // "MFM1"

function startsWith(b: Uint8Array, m: number[]) {
  return b.length > m.length && m.every((x, i) => b[i] === x);
}

export interface Sealed {
  bytes: Uint8Array;
  /** relay fields */
  nonce: string;
  eph: string;
  /** true = ratchet (forward secret) */
  fs: boolean;
}

/** Encrypts a JSON object for a friend. */
export async function sealFor(
  peerId: string, obj: unknown, opts: { hello?: boolean; peerKey?: string; defer?: boolean } = {},
): Promise<Sealed> {
  const plain = decodeUTF8(JSON.stringify(obj));
  const peerKey = opts.peerKey ?? await getPeerKey(peerId);
  const secret = await loadPrivateKey();
  const myPub = encodeBase64(nacl.box.keyPair.fromSecretKey(secret).publicKey);
  const m = await ratchetEncrypt(peerId, plain, { hello: opts.hello, peerKey, defer: opts.defer });
  if (m) return { bytes: m, nonce: encodeBase64(nacl.randomBytes(24)), eph: myPub, fs: true };
  const box = seal(plain, peerKey, secret);
  return { bytes: box.ciphertext, nonce: box.nonce, eph: box.senderPublicKey, fs: false };
}

/**
 * Like sealFor, but self-contained bytes (the legacy nonce is put in front).
 * `defer`: see ratchetEncrypt — call flushSessions() before sending.
 */
export async function sealEnvelope(peerId: string, obj: unknown, peerKey?: string, defer = false): Promise<Uint8Array> {
  const s = await sealFor(peerId, obj, { peerKey, defer });
  return s.fs ? s.bytes : concat(Uint8Array.from(LEGACY), decodeBase64(s.nonce), s.bytes);
}

export interface Opened<T> {
  obj: T;
  /** a new ratchet session was started by the friend — answer with a hello */
  answer: boolean;
  fs: boolean;
}

function parse<T>(plain: Uint8Array | null): T | null {
  if (!plain) return null;
  try { return JSON.parse(encodeUTF8(plain)) as T; } catch { return null; }
}

/**
 * Opens what a friend sent: a ratchet message, a self-contained legacy envelope, or (relay)
 * an old sealed box with its nonce. Returns null if it does not open with the keys we trust.
 */
export async function openFrom_<T>(
  peerId: string, myId: string, bytes: Uint8Array,
  opts: { nonce?: string; promote?: boolean; persist?: boolean; peerKey?: string } = {},
): Promise<Opened<T> | null> {
  const peerKey = opts.peerKey ?? await getPeerKey(peerId);
  if (isRatchetMessage(bytes)) {
    try {
      const r = await ratchetDecrypt(peerId, myId, bytes, { promote: opts.promote, persist: opts.persist, peerKey });
      const obj = parse<T>(r.plaintext);
      return obj ? { obj, answer: r.answer, fs: true } : null;
    } catch {
      // (a legacy box can start with the magic by chance — fall through)
    }
  }
  const secret = await loadPrivateKey();
  if (startsWith(bytes, LEGACY) && bytes.length > 4 + 24) {
    const obj = parse<T>(openFrom(bytes.subarray(28), encodeBase64(bytes.subarray(4, 28)), peerKey, secret));
    if (obj) return { obj, answer: false, fs: false };
  }
  if (opts.nonce) {
    const obj = parse<T>(openFrom(bytes, opts.nonce, peerKey, secret));
    if (obj) return { obj, answer: false, fs: false };
  }
  return null;
}
export { openFrom_ as openFromPeer };

// ---- media blobs -----------------------------------------------------------------------

/** Encrypts a payload with a fresh random key; `key` = base64(key ‖ nonce). */
export function encryptBlob(plain: Uint8Array): { blob: Uint8Array; key: string } {
  const k = nacl.randomBytes(32);
  const n = nacl.randomBytes(24);
  return { blob: nacl.secretbox(plain, n, k), key: encodeBase64(concat(k, n)) };
}

export function decryptBlob(blob: Uint8Array, key: string): Uint8Array | null {
  const kn = decodeBase64(key);
  if (kn.length !== 56) return null;
  return nacl.secretbox.open(blob, kn.subarray(32), kn.subarray(0, 32));
}

export function packMedia(envelope: Uint8Array, blob: Uint8Array): Uint8Array {
  const len = envelope.length;
  return concat(Uint8Array.from(MEDIA), Uint8Array.of((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff), envelope, blob);
}

export function unpackMedia(bytes: Uint8Array): { envelope: Uint8Array; blob: Uint8Array } | null {
  if (!startsWith(bytes, MEDIA) || bytes.length < 8) return null;
  const len = ((bytes[4] << 24) >>> 0) + (bytes[5] << 16) + (bytes[6] << 8) + bytes[7];
  if (len <= 0 || 8 + len > bytes.length) return null;
  return { envelope: bytes.subarray(8, 8 + len), blob: bytes.subarray(8 + len) };
}

export function isPackedMedia(bytes: Uint8Array): boolean {
  return startsWith(bytes, MEDIA);
}
