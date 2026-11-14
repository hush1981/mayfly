import nacl from 'tweetnacl';
import { decodeUTF8, encodeBase64 } from 'tweetnacl-util';
import { createHash } from 'crypto';
import { checkSealedProof, openSealedSender, sealSender, sha256 } from '../crypto/sealedSender';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('sealed sender', () => {
  it('sha256 matches node', () => {
    for (const s of ['', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'q'.repeat(1000)]) {
      const mine = Buffer.from(sha256(decodeUTF8(s))).toString('hex');
      expect(mine).toBe(createHash('sha256').update(s).digest('hex'));
    }
  });

  it('round trip, only the recipient opens it', () => {
    const bob = nacl.box.keyPair();
    const eve = nacl.box.keyPair();
    const inner = nacl.randomBytes(300);
    const env = sealSender(encodeBase64(bob.publicKey), { v: 1, f: A, n: 'nonce' }, inner);
    const opened = openSealedSender(env, bob.secretKey)!;
    expect(opened.header.f).toBe(A);
    expect(opened.header.n).toBe('nonce');
    expect(Buffer.from(opened.inner).equals(Buffer.from(inner))).toBe(true);
    expect(openSealedSender(env, eve.secretKey)).toBeNull();
  });

  it('rejects tampering and bad headers', () => {
    const bob = nacl.box.keyPair();
    const env = sealSender(encodeBase64(bob.publicKey), { v: 1, f: A }, new Uint8Array([1, 2, 3]));
    env[env.length - 1] ^= 1;
    expect(openSealedSender(env, bob.secretKey)).toBeNull();
    const bad = sealSender(encodeBase64(bob.publicKey), { v: 1, f: 'not-a-uuid' } as any, new Uint8Array([1]));
    expect(openSealedSender(bad, bob.secretKey)).toBeNull();
  });

  it('two envelopes of the same sender share nothing', () => {
    const bob = nacl.box.keyPair();
    const a = sealSender(encodeBase64(bob.publicKey), { v: 1, f: A }, new Uint8Array(10));
    const b = sealSender(encodeBase64(bob.publicKey), { v: 1, f: A }, new Uint8Array(10));
    expect(Buffer.from(a.subarray(4, 36)).equals(Buffer.from(b.subarray(4, 36)))).toBe(false);
  });
});

describe('sender proof (2.9.1)', () => {
  const BOB = nacl.box.keyPair(); // recipient
  const ALICE = nacl.box.keyPair(); // sender
  const MALLORY = nacl.box.keyPair(); // another friend who holds my delivery token
  const AID = '11111111-1111-1111-1111-111111111111';
  const pub = (k: nacl.BoxKeyPair) => encodeBase64(k.publicKey);

  it('a genuine envelope proves the sender', () => {
    const env = sealSender(pub(BOB), { v: 1, f: AID }, new Uint8Array(0), ALICE.secretKey);
    const o = openSealedSender(env, BOB.secretKey)!;
    expect(o.header.p).toBeDefined();
    expect(checkSealedProof(env, o.header, BOB.secretKey, pub(ALICE))).toBe('ok');
  });

  it('somebody else claiming to be the sender fails', () => {
    // Mallory writes Alice's id but can only use her own identity key
    const env = sealSender(pub(BOB), { v: 1, f: AID }, new Uint8Array(0), MALLORY.secretKey);
    const o = openSealedSender(env, BOB.secretKey)!;
    expect(checkSealedProof(env, o.header, BOB.secretKey, pub(ALICE))).toBe('bad');
  });

  it('a proof copied into another envelope fails (bound to the ephemeral key)', () => {
    const real = sealSender(pub(BOB), { v: 1, f: AID }, new Uint8Array(0), ALICE.secretKey);
    const p = openSealedSender(real, BOB.secretKey)!.header.p;
    const fake = sealSender(pub(BOB), { v: 1, f: AID, p }, new Uint8Array(0));
    const o = openSealedSender(fake, BOB.secretKey)!;
    expect(o.header.p).toBeUndefined(); // sealSender never passes a caller's p through
    const forged = new Uint8Array(real); // and the real one with another ephemeral key: bad
    forged[10] ^= 1;
    expect(checkSealedProof(forged, { v: 1, f: AID, p }, BOB.secretKey, pub(ALICE))).toBe('bad');
  });

  it('the nonce field is covered too', () => {
    const env = sealSender(pub(BOB), { v: 1, f: AID, n: 'AAAA' }, new Uint8Array(0), ALICE.secretKey);
    const o = openSealedSender(env, BOB.secretKey)!;
    expect(checkSealedProof(env, { ...o.header, n: 'BBBB' }, BOB.secretKey, pub(ALICE))).toBe('bad');
  });

  it('old senders without proof are reported as missing', () => {
    const env = sealSender(pub(BOB), { v: 1, f: AID }, new Uint8Array(0));
    const o = openSealedSender(env, BOB.secretKey)!;
    expect(checkSealedProof(env, o.header, BOB.secretKey, pub(ALICE))).toBe('missing');
  });
});
