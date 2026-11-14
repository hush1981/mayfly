/**
 * Authenticated envelopes between two users (pure functions, no React Native imports).
 *
 * nacl.box with the sender's *static* X25519 key (not a throwaway key): only the sender
 * or the recipient can create a box that opens with (senderPub, recipientSecret), so the
 * server cannot forge messages. Because both sides share the same box key, the plaintext
 * also names sender and recipient ("f"/"r"), which stops the server from reflecting a
 * message back to its author. "ts" (time) and "x" (random id) let receivers reject replays.
 * (Not "t": relay events already use "t" for the event type.)
 *
 * Wire compatibility: the sender's static public key goes into the old
 * "ephemeral_public_key" field, so clients ≤ 2.2 can still decrypt (unauthenticated).
 */
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';

/** Messages older than this (by their own timestamp) are rejected as replays. */
export const MAX_AGE_MS = 48 * 3600 * 1000;
/** Allowed clock skew into the future. */
export const MAX_SKEW_MS = 60 * 60 * 1000;

export interface Binding {
  /** sender user id */
  f: string;
  /** recipient user id */
  r: string;
  /** ISO time of creation */
  ts: string;
  /** random id (hex), for replay detection */
  x: string;
}

export function randomHex(bytes = 16): string {
  return Array.from(nacl.randomBytes(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function newBinding(from: string, to: string): Binding {
  return { f: from, r: to, ts: new Date().toISOString(), x: randomHex() };
}

export interface SealedBox {
  /** base64 — the sender's static public key (wire field "ephemeral_public_key") */
  senderPublicKey: string;
  nonce: string;
  ciphertext: Uint8Array;
}

export function seal(plain: Uint8Array, recipientPublicKeyB64: string, mySecretKey: Uint8Array): SealedBox {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(plain, nonce, decodeBase64(recipientPublicKeyB64), mySecretKey);
  return {
    senderPublicKey: encodeBase64(nacl.box.keyPair.fromSecretKey(mySecretKey).publicKey),
    nonce: encodeBase64(nonce),
    ciphertext,
  };
}

/** Opens a box that must come from `senderPublicKeyB64` (the key we know for that peer). */
export function openFrom(
  ciphertext: Uint8Array, nonceB64: string, senderPublicKeyB64: string, mySecretKey: Uint8Array,
): Uint8Array | null {
  return nacl.box.open(ciphertext, decodeBase64(nonceB64), decodeBase64(senderPublicKeyB64), mySecretKey);
}

export type BindingError = 'missing' | 'wrong-sender' | 'wrong-recipient' | 'too-old' | 'from-future' | 'replay';

/**
 * Checks the binding inside an opened message. `seen` = ids already accepted (replay set).
 * Returns null if fine.
 */
export function checkBinding(
  b: Partial<Binding> | undefined, expectedFrom: string, myId: string, seen: (x: string) => boolean,
  now = Date.now(),
): BindingError | null {
  if (!b || typeof b.f !== 'string' || typeof b.r !== 'string' || typeof b.ts !== 'string' || typeof b.x !== 'string') {
    return 'missing';
  }
  if (b.f !== expectedFrom) return 'wrong-sender';
  if (b.r !== myId) return 'wrong-recipient';
  const t = Date.parse(b.ts);
  if (!Number.isFinite(t) || now - t > MAX_AGE_MS) return 'too-old';
  if (t - now > MAX_SKEW_MS) return 'from-future';
  if (seen(b.x)) return 'replay';
  return null;
}

export function bindingErrorText(e: BindingError): string {
  switch (e) {
    case 'missing':
      return 'The sender uses an outdated Mayfly version that cannot prove who sent this. Ask them to update.';
    case 'wrong-sender':
    case 'wrong-recipient':
      return 'This message was not sent by this friend to you. It was rejected.';
    case 'too-old':
    case 'replay':
      return 'This message was already delivered before or is too old. It was rejected.';
    case 'from-future':
      return 'This message has an invalid timestamp. It was rejected.';
  }
}
