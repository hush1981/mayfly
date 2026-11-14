/**
 * Sealed sender envelope (pure functions, no React Native imports — jest loads it).
 *
 * The server must not learn who sends to whom. The sender therefore delivers with the
 * recipient's delivery token instead of its own login, and puts its user id INSIDE an outer
 * box that only the recipient can open:
 *
 *   "MFS1" | ephemeral public key (32) | nonce (24) | nacl.box(header ‖ inner, eph → recipient identity key)
 *   header = u16 length | JSON {v:1, f: sender id, n?: inner nonce (base64), m?: media fields}
 *
 * `inner` is the normal message (ratchet message or the old static box), which proves the
 * sender once it is opened with the key (or ratchet session) we trust for that id.
 *
 * Since 2.9.1 the header also carries `p`, a proof that the sender holds the identity key of
 * "f": HMAC over (ephemeral key, recipient key, f, n) with a key derived from the static
 * DH between the sender's and the recipient's identity keys. Only the real sender (or the
 * recipient) can compute it. It matters where the inner part is empty or opened later —
 * sealed moments: without it, anybody holding my delivery token could make "moment from
 * <another friend>" entries appear (they failed on open, but the entry and the notification
 * named the wrong person). Envelopes from senders before 2.9.1 have no `p`; once a friend
 * sent one with `p`, a missing one from them is refused (see store/deliveryTokens.ts).
 * The ephemeral key is single-use, so the outer box links nothing across messages.
 */
import nacl from 'tweetnacl';
import { decodeBase64, decodeUTF8, encodeBase64, encodeUTF8 } from 'tweetnacl-util';
import { hkdf, hmacSha512 } from './ratchet';

const MAGIC = [0x4d, 0x46, 0x53, 0x31]; // "MFS1"

export interface SealedHeader {
  v: 1;
  /** sender user id */
  f: string;
  /** relay: nonce of an old-format inner box */
  n?: string;
  /** media: extra fields the recipient needs before downloading */
  m?: Record<string, unknown>;
  /** 2.9.1+: proof that the sender holds the identity key of `f` (base64, 32 bytes) */
  p?: string;
}

const enc = (str: string) => decodeUTF8(str);
const PROOF_INFO = enc('Mayfly sealed sender proof');

/** The proof for one envelope (static DH between sender and recipient identity keys). */
function proofFor(shared: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array, f: string, n: string | undefined): string {
  const key = hkdf(new Uint8Array(32), shared, PROOF_INFO, 32);
  const fb = enc(f);
  const nb = enc(n ?? '');
  const msg = new Uint8Array(32 + 32 + 2 + fb.length + nb.length);
  msg.set(ephPub, 0);
  msg.set(recipientPub, 32);
  msg[64] = fb.length;
  msg[65] = nb.length;
  msg.set(fb, 66);
  msg.set(nb, 66 + fb.length);
  return encodeBase64(hmacSha512(key, msg).subarray(0, 32));
}

function equalB64(a: string, b: string): boolean {
  const x = decodeBase64(a);
  const y = decodeBase64(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export function isSealedEnvelope(b: Uint8Array): boolean {
  return b.length > 4 + 32 + 24 + 16 && MAGIC.every((x, i) => b[i] === x);
}

/**
 * Seals `inner` for the recipient. `senderSecretKey` (our identity secret) adds the proof
 * `p` for header.f — always pass it (without it the recipient cannot tell a forged "f").
 */
export function sealSender(
  recipientPublicKeyB64: string, header: SealedHeader, inner: Uint8Array, senderSecretKey?: Uint8Array,
): Uint8Array {
  const recipientPub = decodeBase64(recipientPublicKeyB64);
  const eph = nacl.box.keyPair();
  const hdr: SealedHeader = { ...header };
  delete hdr.p;
  if (senderSecretKey) {
    const shared = nacl.scalarMult(senderSecretKey, recipientPub);
    hdr.p = proofFor(shared, eph.publicKey, recipientPub, hdr.f, hdr.n);
    shared.fill(0);
  }
  const h = decodeUTF8(JSON.stringify(hdr));
  if (h.length > 0xffff) throw new Error('header too large');
  const plain = new Uint8Array(2 + h.length + inner.length);
  plain[0] = h.length >> 8;
  plain[1] = h.length & 0xff;
  plain.set(h, 2);
  plain.set(inner, 2 + h.length);
  const nonce = nacl.randomBytes(24);
  const box = nacl.box(plain, nonce, recipientPub, eph.secretKey);
  eph.secretKey.fill(0);
  const out = new Uint8Array(4 + 32 + 24 + box.length);
  out.set(MAGIC, 0);
  out.set(eph.publicKey, 4);
  out.set(nonce, 36);
  out.set(box, 60);
  return out;
}

/** Opens a sealed envelope with our identity secret key. null = not for us / damaged. */
export function openSealedSender(bytes: Uint8Array, mySecretKey: Uint8Array): { header: SealedHeader; inner: Uint8Array } | null {
  if (!isSealedEnvelope(bytes)) return null;
  const plain = nacl.box.open(bytes.subarray(60), bytes.subarray(36, 60), bytes.subarray(4, 36), mySecretKey);
  if (!plain || plain.length < 2) return null;
  const len = (plain[0] << 8) | plain[1];
  if (2 + len > plain.length) return null;
  let header: SealedHeader;
  try {
    header = JSON.parse(encodeUTF8(plain.subarray(2, 2 + len)));
  } catch {
    return null;
  }
  if (!header || header.v !== 1 || typeof header.f !== 'string' || !/^[0-9a-f-]{36}$/.test(header.f)) return null;
  if (header.n !== undefined && typeof header.n !== 'string') return null;
  if (header.p !== undefined && (typeof header.p !== 'string' || header.p.length > 64)) return null;
  return { header, inner: plain.subarray(2 + len) };
}

/**
 * Checks the proof of an opened envelope against the identity key we trust for header.f.
 * 'ok' = really from f; 'missing' = no proof (sender before 2.9.1); 'bad' = forged.
 */
export function checkSealedProof(
  bytes: Uint8Array, header: SealedHeader, mySecretKey: Uint8Array, senderPublicKeyB64: string,
): 'ok' | 'missing' | 'bad' {
  if (header.p === undefined) return 'missing';
  if (!isSealedEnvelope(bytes)) return 'bad';
  const ephPub = bytes.subarray(4, 36);
  const myPub = nacl.box.keyPair.fromSecretKey(mySecretKey).publicKey;
  const shared = nacl.scalarMult(mySecretKey, decodeBase64(senderPublicKeyB64));
  let expected: string;
  try {
    expected = proofFor(shared, ephPub, myPub, header.f, header.n);
  } finally {
    shared.fill(0);
  }
  try {
    return equalB64(expected, header.p) ? 'ok' : 'bad';
  } catch {
    return 'bad';
  }
}

/** Random 32-byte secrets (delivery token, unsend token) and their SHA-256 (server side value). */
export function newSecret(): string {
  return encodeBase64(nacl.randomBytes(32));
}

export function sha256b64(secretB64: string): string {
  // nacl.hash is SHA-512; the server stores SHA-256, so use a tiny SHA-256 here.
  return encodeBase64(sha256(decodeBase64(secretB64)));
}

// ---- SHA-256 (FIPS 180-4), small and dependency free ----------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, bitLen >>> 0);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [A, B, C, D, E, F, G, H] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7));
      const ch = (E & F) ^ (~E & G);
      const t1 = (H + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10));
      const maj = (A & B) ^ (A & C) ^ (B & C);
      const t2 = (S0 + maj) >>> 0;
      H = G; G = F; F = E; E = (D + t1) >>> 0; D = C; C = B; B = A; A = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + A) >>> 0; h[1] = (h[1] + B) >>> 0; h[2] = (h[2] + C) >>> 0; h[3] = (h[3] + D) >>> 0;
    h[4] = (h[4] + E) >>> 0; h[5] = (h[5] + F) >>> 0; h[6] = (h[6] + G) >>> 0; h[7] = (h[7] + H) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}
