import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { encryptMedia, decryptMedia } from '../crypto/encryption';

describe('encryption round-trip', () => {
  it('encrypts and decrypts correctly', () => {
    const bobKeyPair = nacl.box.keyPair();
    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    const encrypted = encryptMedia(plaintext, encodeBase64(bobKeyPair.publicKey));
    const decrypted = decryptMedia(
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.ephemeralPublicKey,
      bobKeyPair.secretKey,
    );

    expect(decrypted).toEqual(plaintext);
  });

  it('produces different ciphertext for the same plaintext (ephemeral nonce)', () => {
    const bobKeyPair = nacl.box.keyPair();
    const plaintext = new Uint8Array([1, 2, 3]);

    const enc1 = encryptMedia(plaintext, encodeBase64(bobKeyPair.publicKey));
    const enc2 = encryptMedia(plaintext, encodeBase64(bobKeyPair.publicKey));

    // Different ephemeral keys → different ciphertext
    expect(enc1.ephemeralPublicKey).not.toBe(enc2.ephemeralPublicKey);
  });

  it('throws when decrypting with wrong private key', () => {
    const bobKeyPair = nacl.box.keyPair();
    const eveKeyPair = nacl.box.keyPair();
    const plaintext = new Uint8Array([1, 2, 3]);

    const encrypted = encryptMedia(plaintext, encodeBase64(bobKeyPair.publicKey));

    expect(() =>
      decryptMedia(
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.ephemeralPublicKey,
        eveKeyPair.secretKey, // wrong key
      ),
    ).toThrow('Decryption failed');
  });

  it('throws when ciphertext is tampered', () => {
    const bobKeyPair = nacl.box.keyPair();
    const plaintext = new Uint8Array([1, 2, 3, 4, 5]);

    const encrypted = encryptMedia(plaintext, encodeBase64(bobKeyPair.publicKey));
    const tampered = new Uint8Array(encrypted.ciphertext);
    tampered[0] ^= 0xff; // flip bits in first byte

    expect(() =>
      decryptMedia(tampered, encrypted.nonce, encrypted.ephemeralPublicKey, bobKeyPair.secretKey),
    ).toThrow('Decryption failed');
  });
});
