/**
 * Forward secrecy: a Double Ratchet (Signal's design) per pair of users, built only on
 * tweetnacl primitives (X25519, SHA-512 → HMAC/HKDF, XSalsa20-Poly1305). Pure functions,
 * no React Native imports, so jest can test them directly.
 *
 * Session start ("X3DH-lite"): the initiator A picks a fresh base key EK and derives
 *   SK = HKDF(DH(IK_A, IK_B) ‖ DH(EK, IK_B))
 * from both identity keys (the keys users verify with the security code / QR). B's identity
 * key serves as B's first ratchet key. Only someone holding IK_A or IK_B can build SK, so
 * the server can neither read nor forge session messages.
 *
 * Every message gets its own key (symmetric chain), and every change of direction mixes in
 * a fresh DH (DH ratchet). Used keys are deleted at once — a key stolen later cannot
 * decrypt earlier ciphertexts the server may have kept. The app only sends real content in
 * a session after the peer answered in it (handshake "hello"), so even the first content
 * messages depend on a fresh key of the peer and not only on the long-term identity keys.
 *
 * Wire format (binary):
 *   "MFR1" | flags(1: bit0 = carries EK) | sid(16) | [EK(32)] | DH(32) | PN(u32) | N(u32) | secretbox
 * The secretbox key and nonce come from the message key; the plaintext starts with a 32-byte
 * hash of the associated data (magic, both identity keys, header), which binds the header.
 */
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';

export const MAGIC = [0x4d, 0x46, 0x52, 0x31]; // "MFR1"
/** How many message keys one message may skip ahead in a chain. */
export const MAX_SKIP = 1000;
/** Skipped (not yet received) message keys kept per session at most. */
export const MAX_STORED_SKIPPED = 2000;
/** Skipped keys older than this are deleted (server copies are gone after 24 h). */
export const SKIPPED_TTL_MS = 72 * 3600 * 1000;

const enc = (s: string) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0)));
const INFO_RK = enc('Mayfly ratchet root');
const INFO_SK = enc('Mayfly session start');
const INFO_MK = enc('Mayfly message key');
const INFO_SID = enc('Mayfly session id');

export interface KeyPairB64 { pub: string; sec: string }

export interface Session {
  /** session id (hex), derived from the initiator's base key */
  sid: string;
  rk: string;
  dhs: KeyPairB64;
  dhr: string | null;
  cks: string | null;
  ckr: string | null;
  ns: number;
  nr: number;
  pn: number;
  /** "<dh b64>:<n>" → message key + time stored */
  skipped: Record<string, { mk: string; at: number }>;
  initiator: boolean;
  /** Initiator: base key sent along until the peer answered. */
  ek?: string;
  /** A message from the peer was decrypted in this session. */
  confirmed: boolean;
  /** We sent at least one message in this session. */
  sentAny: boolean;
  created: number;
  usedAt: number;
}

export interface Header {
  sid: Uint8Array;
  ek?: Uint8Array;
  dh: Uint8Array;
  pn: number;
  n: number;
}

export class RatchetError extends Error {
  constructor(public code: 'format' | 'no-session' | 'decrypt' | 'too-many-skipped' | 'bad-key') {
    super('ratchet: ' + code);
  }
}

// ---- primitives ------------------------------------------------------------------------

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
  const B = 128;
  const k = key.length > B ? nacl.hash(key) : key;
  const kp = new Uint8Array(B);
  kp.set(k);
  const ipad = new Uint8Array(B);
  const opad = new Uint8Array(B);
  for (let i = 0; i < B; i++) { ipad[i] = kp[i] ^ 0x36; opad[i] = kp[i] ^ 0x5c; }
  return nacl.hash(concat(opad, nacl.hash(concat(ipad, data))));
}

export function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Uint8Array {
  const prk = hmacSha512(salt.length ? salt : new Uint8Array(64), ikm);
  const out = new Uint8Array(len);
  let prev: Uint8Array = new Uint8Array(0);
  let o = 0;
  for (let i = 1; o < len; i++) {
    prev = hmacSha512(prk, concat(prev, info, Uint8Array.of(i)));
    out.set(prev.subarray(0, Math.min(prev.length, len - o)), o);
    o += prev.length;
  }
  return out;
}

/** X25519; refuses low-order points (all-zero shared secret). */
export function dh(secret: Uint8Array, pub: Uint8Array): Uint8Array {
  if (pub.length !== 32) throw new RatchetError('bad-key');
  const out = nacl.scalarMult(secret, pub);
  if (out.every((b) => b === 0)) throw new RatchetError('bad-key');
  return out;
}

function kdfRk(rk: Uint8Array, dhOut: Uint8Array): [Uint8Array, Uint8Array] {
  const o = hkdf(rk, dhOut, INFO_RK, 64);
  return [o.slice(0, 32), o.slice(32, 64)];
}

function kdfCk(ck: Uint8Array): [Uint8Array, Uint8Array] {
  return [hmacSha512(ck, Uint8Array.of(2)).slice(0, 32), hmacSha512(ck, Uint8Array.of(1)).slice(0, 32)];
}

function messageCipher(mk: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
  const o = hkdf(new Uint8Array(0), mk, INFO_MK, 56);
  return { key: o.slice(0, 32), nonce: o.slice(32, 56) };
}

const b64 = encodeBase64;
const unb64 = decodeBase64;

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function sessionIdFor(ek: Uint8Array): Uint8Array {
  return nacl.hash(concat(INFO_SID, ek)).slice(0, 16);
}

function u32(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function readU32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

export function encodeHeader(h: Header): Uint8Array {
  return concat(Uint8Array.from(MAGIC), Uint8Array.of(h.ek ? 1 : 0), h.sid, h.ek ?? new Uint8Array(0), h.dh, u32(h.pn), u32(h.n));
}

/** True if the bytes look like a ratchet message (magic). */
export function isRatchetMessage(b: Uint8Array): boolean {
  return b.length > 4 && MAGIC.every((m, i) => b[i] === m);
}

export function parseMessage(b: Uint8Array): { header: Header; headerBytes: Uint8Array; body: Uint8Array } {
  if (!isRatchetMessage(b) || b.length < 4 + 1 + 16 + 32 + 8 + nacl.secretbox.overheadLength) {
    throw new RatchetError('format');
  }
  const flags = b[4];
  if (flags & ~1) throw new RatchetError('format');
  let o = 5;
  const sid = b.slice(o, o + 16); o += 16;
  let ek: Uint8Array | undefined;
  if (flags & 1) {
    if (b.length < o + 32 + 32 + 8 + nacl.secretbox.overheadLength) throw new RatchetError('format');
    ek = b.slice(o, o + 32); o += 32;
  }
  const dhPub = b.slice(o, o + 32); o += 32;
  const pn = readU32(b, o); o += 4;
  const n = readU32(b, o); o += 4;
  return { header: { sid, ek, dh: dhPub, pn, n }, headerBytes: b.slice(0, o), body: b.slice(o) };
}

function adHash(myIk: Uint8Array, peerIk: Uint8Array, senderIsMe: boolean, headerBytes: Uint8Array): Uint8Array {
  const [s, r] = senderIsMe ? [myIk, peerIk] : [peerIk, myIk];
  return nacl.hash(concat(Uint8Array.from(MAGIC), s, r, headerBytes)).slice(0, 32);
}

function clone(s: Session): Session {
  return JSON.parse(JSON.stringify(s));
}

function keyPair(): KeyPairB64 {
  const kp = nacl.box.keyPair();
  return { pub: b64(kp.publicKey), sec: b64(kp.secretKey) };
}

// ---- session start ---------------------------------------------------------------------

/** A starts a session with B (B's identity public key `peerIk`). */
export function initiate(myIkSecret: Uint8Array, peerIk: Uint8Array, now = Date.now()): Session {
  const ek = nacl.box.keyPair();
  const sk = hkdf(new Uint8Array(0), concat(dh(myIkSecret, peerIk), dh(ek.secretKey, peerIk)), INFO_SK, 32);
  const dhs = keyPair();
  const [rk, cks] = kdfRk(sk, dh(unb64(dhs.sec), peerIk));
  return {
    sid: hex(sessionIdFor(ek.publicKey)), rk: b64(rk), dhs, dhr: b64(peerIk), cks: b64(cks), ckr: null,
    ns: 0, nr: 0, pn: 0, skipped: {}, initiator: true, ek: b64(ek.publicKey),
    confirmed: false, sentAny: false, created: now, usedAt: now,
  };
}

/**
 * B's side of a session A started. The identity secret is only used for the first DH
 * ratchet step inside `decrypt`; it is replaced by a fresh key before the state is kept.
 */
function respond(myIkSecret: Uint8Array, peerIk: Uint8Array, ek: Uint8Array, now: number): Session {
  const sk = hkdf(new Uint8Array(0), concat(dh(myIkSecret, peerIk), dh(myIkSecret, ek)), INFO_SK, 32);
  const myIkPub = nacl.box.keyPair.fromSecretKey(myIkSecret).publicKey;
  return {
    sid: hex(sessionIdFor(ek)), rk: b64(sk), dhs: { pub: b64(myIkPub), sec: b64(myIkSecret) }, dhr: null,
    cks: null, ckr: null, ns: 0, nr: 0, pn: 0, skipped: {}, initiator: false,
    confirmed: false, sentAny: false, created: now, usedAt: now,
  };
}

// ---- messages --------------------------------------------------------------------------

export function encrypt(
  state: Session, myIk: Uint8Array, peerIk: Uint8Array, plaintext: Uint8Array, now = Date.now(),
): { state: Session; message: Uint8Array } {
  const s = clone(state);
  if (!s.cks) throw new RatchetError('no-session');
  const [ck, mk] = kdfCk(unb64(s.cks));
  s.cks = b64(ck);
  const header: Header = {
    sid: hexToBytes(s.sid),
    ek: s.initiator && !s.confirmed && s.ek ? unb64(s.ek) : undefined,
    dh: unb64(s.dhs.pub), pn: s.pn, n: s.ns,
  };
  s.ns += 1;
  s.sentAny = true;
  s.usedAt = now;
  const headerBytes = encodeHeader(header);
  const { key, nonce } = messageCipher(mk);
  const body = nacl.secretbox(concat(adHash(myIk, peerIk, true, headerBytes), plaintext), nonce, key);
  return { state: s, message: concat(headerBytes, body) };
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export function sessionIdOf(message: Uint8Array): { sid: string; hasEk: boolean } {
  const { header } = parseMessage(message);
  return { sid: hex(header.sid), hasEk: !!header.ek };
}

function skip(s: Session, until: number, now: number) {
  if (!s.ckr || !s.dhr) return;
  if (until - s.nr > MAX_SKIP) throw new RatchetError('too-many-skipped');
  let ck = unb64(s.ckr);
  while (s.nr < until) {
    const [next, mk] = kdfCk(ck);
    s.skipped[`${s.dhr}:${s.nr}`] = { mk: b64(mk), at: now };
    ck = next;
    s.nr += 1;
  }
  s.ckr = b64(ck);
  pruneSkipped(s, now);
}

export function pruneSkipped(s: Session, now = Date.now()) {
  const entries = Object.entries(s.skipped);
  for (const [k, v] of entries) if (now - v.at > SKIPPED_TTL_MS) delete s.skipped[k];
  const left = Object.entries(s.skipped);
  if (left.length > MAX_STORED_SKIPPED) {
    left.sort((a, b) => a[1].at - b[1].at);
    for (const [k] of left.slice(0, left.length - MAX_STORED_SKIPPED)) delete s.skipped[k];
  }
}

function openBody(mk: Uint8Array, body: Uint8Array, ad: Uint8Array): Uint8Array {
  const { key, nonce } = messageCipher(mk);
  const plain = nacl.secretbox.open(body, nonce, key);
  if (!plain || plain.length < 32) throw new RatchetError('decrypt');
  for (let i = 0; i < 32; i++) if (plain[i] !== ad[i]) throw new RatchetError('decrypt');
  return plain.slice(32);
}

/**
 * Decrypts a message from the peer. `state` = the session named by the message (null if we
 * do not know it — then the message must start a session). Never changes the given state;
 * the caller keeps the returned one only if decryption worked.
 */
export function decrypt(
  state: Session | null, myIkSecret: Uint8Array, peerIk: Uint8Array, message: Uint8Array, now = Date.now(),
): { state: Session; plaintext: Uint8Array; created: boolean; fromSkipped: boolean } {
  const { header, headerBytes, body } = parseMessage(message);
  const myIk = nacl.box.keyPair.fromSecretKey(myIkSecret).publicKey;
  const ad = adHash(myIk, peerIk, false, headerBytes);
  let s: Session;
  let created = false;
  if (state) {
    s = clone(state);
    if (s.sid !== hex(header.sid)) throw new RatchetError('no-session');
  } else {
    if (!header.ek || hex(sessionIdFor(header.ek)) !== hex(header.sid)) throw new RatchetError('no-session');
    s = respond(myIkSecret, peerIk, header.ek, now);
    created = true;
  }

  const dhB64 = b64(header.dh);
  const sk = s.skipped[`${dhB64}:${header.n}`];
  if (sk) {
    const plaintext = openBody(unb64(sk.mk), body, ad);
    delete s.skipped[`${dhB64}:${header.n}`];
    s.confirmed = true;
    s.usedAt = now;
    delete s.ek;
    return { state: s, plaintext, created, fromSkipped: true };
  }

  if (dhB64 !== s.dhr) {
    // the peer turned the DH ratchet: finish the old receiving chain, then step forward
    if (s.ckr) skip(s, header.pn, now);
    s.pn = s.ns;
    s.ns = 0;
    s.nr = 0;
    s.dhr = dhB64;
    const [rk1, ckr] = kdfRk(unb64(s.rk), dh(unb64(s.dhs.sec), header.dh));
    s.dhs = keyPair(); // (replaces the identity key B started with)
    const [rk2, cks] = kdfRk(rk1, dh(unb64(s.dhs.sec), header.dh));
    s.rk = b64(rk2);
    s.ckr = b64(ckr);
    s.cks = b64(cks);
  }
  if (header.n < s.nr) throw new RatchetError('decrypt'); // already used (replay)
  skip(s, header.n, now);
  const [ck, mk] = kdfCk(unb64(s.ckr!));
  const plaintext = openBody(mk, body, ad);
  s.ckr = b64(ck);
  s.nr = header.n + 1;
  s.confirmed = true;
  s.usedAt = now;
  delete s.ek;
  return { state: s, plaintext, created, fromSkipped: false };
}
