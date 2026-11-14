import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';

// Magic byte that marks a payload with an embedded caption header.
// JPEG starts 0xFF 0xD8, MP4 starts 0x00 — neither conflicts with 0x01.
const HEADER_MAGIC = 0x01;

/** Prepends a caption header to media bytes before encryption. */
export function wrapWithCaption(mediaBytes: Uint8Array, caption: string): Uint8Array {
  if (!caption) return mediaBytes;
  const headerBytes = decodeUTF8(JSON.stringify({ c: caption }));
  const len = headerBytes.length;
  const buf = new Uint8Array(1 + 4 + len + mediaBytes.length);
  buf[0] = HEADER_MAGIC;
  buf[1] = (len >>> 24) & 0xff;
  buf[2] = (len >>> 16) & 0xff;
  buf[3] = (len >>> 8) & 0xff;
  buf[4] = len & 0xff;
  buf.set(headerBytes, 5);
  buf.set(mediaBytes, 5 + len);
  return buf;
}

/** Prepends a JSON header (caption + sender binding) to media bytes before encryption. */
export function wrapMedia(mediaBytes: Uint8Array, header: Record<string, unknown>): Uint8Array {
  const headerBytes = decodeUTF8(JSON.stringify(header));
  const len = headerBytes.length;
  const buf = new Uint8Array(1 + 4 + len + mediaBytes.length);
  buf[0] = HEADER_MAGIC;
  buf[1] = (len >>> 24) & 0xff;
  buf[2] = (len >>> 16) & 0xff;
  buf[3] = (len >>> 8) & 0xff;
  buf[4] = len & 0xff;
  buf.set(headerBytes, 5);
  buf.set(mediaBytes, 5 + len);
  return buf;
}

/** Splits header and media. header = null for payloads without a header. */
export function unwrapMedia(bytes: Uint8Array): { header: Record<string, any> | null; mediaBytes: Uint8Array } {
  if (bytes.length < 5 || bytes[0] !== HEADER_MAGIC) return { header: null, mediaBytes: bytes };
  const len = (bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4];
  if (len <= 0 || 5 + len > bytes.length) return { header: null, mediaBytes: bytes };
  try {
    return { header: JSON.parse(encodeUTF8(bytes.subarray(5, 5 + len))), mediaBytes: bytes.subarray(5 + len) };
  } catch {
    return { header: null, mediaBytes: bytes };
  }
}

/** Strips caption header from decrypted bytes. Safe to call on legacy payloads. */
export function unwrapCaption(bytes: Uint8Array): { caption: string; mediaBytes: Uint8Array } {
  if (bytes.length < 5 || bytes[0] !== HEADER_MAGIC) {
    return { caption: '', mediaBytes: bytes };
  }
  const len = (bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4];
  if (len <= 0 || 5 + len > bytes.length) {
    return { caption: '', mediaBytes: bytes };
  }
  try {
    const header = JSON.parse(encodeUTF8(bytes.subarray(5, 5 + len)));
    return { caption: header.c || '', mediaBytes: bytes.subarray(5 + len) };
  } catch {
    return { caption: '', mediaBytes: bytes };
  }
}

export interface EncryptedPackage {
  ephemeralPublicKey: string; // base64, 32 bytes
  nonce: string;              // base64, 24 bytes
  ciphertext: Uint8Array;
}

/**
 * Encrypts media bytes for a recipient using their X25519 public key.
 * Uses nacl.box (X25519 ECDH + XSalsa20-Poly1305).
 * A fresh ephemeral keypair is generated per message for forward secrecy.
 */
export function encryptMedia(
  mediaBytes: Uint8Array,
  recipientPublicKeyB64: string,
): EncryptedPackage {
  const recipientPublicKey = decodeBase64(recipientPublicKeyB64);
  const ephemeralKeyPair = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength); // 24 bytes

  const ciphertext = nacl.box(
    mediaBytes,
    nonce,
    recipientPublicKey,
    ephemeralKeyPair.secretKey,
  );

  return {
    ephemeralPublicKey: encodeBase64(ephemeralKeyPair.publicKey),
    nonce: encodeBase64(nonce),
    ciphertext,
  };
}

/**
 * Decrypts media bytes using own private key and the sender's ephemeral public key.
 * Throws if the ciphertext is invalid or has been tampered with.
 */
export function decryptMedia(
  ciphertext: Uint8Array,
  nonceB64: string,
  ephemeralPublicKeyB64: string,
  ownPrivateKey: Uint8Array,
): Uint8Array {
  const nonce = decodeBase64(nonceB64);
  const ephemeralPublicKey = decodeBase64(ephemeralPublicKeyB64);

  const decrypted = nacl.box.open(
    ciphertext,
    nonce,
    ephemeralPublicKey,
    ownPrivateKey,
  );

  // nacl.box.open returns null on authentication failure — this IS the auth check
  if (!decrypted) {
    throw new Error('Decryption failed: message is invalid or has been tampered with');
  }
  return decrypted;
}
