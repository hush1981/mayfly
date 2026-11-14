import nacl from 'tweetnacl';
import { decodeUTF8, encodeBase64, encodeUTF8 } from 'tweetnacl-util';
import {
  Binding, MAX_AGE_MS, checkBinding, newBinding, openFrom, seal,
} from '../crypto/sealed';
import { unwrapMedia, wrapMedia } from '../crypto/encryption';

const alice = nacl.box.keyPair();
const bob = nacl.box.keyPair();
const mallory = nacl.box.keyPair();
const pub = (k: nacl.BoxKeyPair) => encodeBase64(k.publicKey);
const never = () => false;

function sealJson(obj: object, to: nacl.BoxKeyPair, from: nacl.BoxKeyPair) {
  return seal(decodeUTF8(JSON.stringify(obj)), pub(to), from.secretKey);
}

describe('authenticated envelopes', () => {
  test('recipient opens a message from the expected sender', () => {
    const msg = { v: 1, t: 'text', b: 'hi', ...newBinding('alice', 'bob') };
    const box = sealJson(msg, bob, alice);
    const plain = openFrom(box.ciphertext, box.nonce, pub(alice), bob.secretKey);
    expect(plain).not.toBeNull();
    const parsed = JSON.parse(encodeUTF8(plain!));
    expect(checkBinding(parsed, 'alice', 'bob', never)).toBeNull();
  });

  test('wire field carries the sender static key (old clients can still decrypt)', () => {
    const box = sealJson({ a: 1 }, bob, alice);
    expect(box.senderPublicKey).toBe(pub(alice));
  });

  test('a third party (e.g. the server) cannot forge a message "from alice"', () => {
    const forged = sealJson({ v: 1, t: 'text', b: 'fake', ...newBinding('alice', 'bob') }, bob, mallory);
    expect(openFrom(forged.ciphertext, forged.nonce, pub(alice), bob.secretKey)).toBeNull();
  });

  test('a reflected message (alice→bob sent back to alice as "from bob") is rejected', () => {
    const box = sealJson({ v: 1, t: 'text', b: 'to bob', ...newBinding('alice', 'bob') }, bob, alice);
    // box key is symmetric, so alice CAN open it with bob's public key …
    const plain = openFrom(box.ciphertext, box.nonce, pub(bob), alice.secretKey);
    expect(plain).not.toBeNull();
    // … but the binding says it was from alice to bob
    expect(checkBinding(JSON.parse(encodeUTF8(plain!)), 'bob', 'alice', never)).toBe('wrong-sender');
  });

  test('a message re-addressed to someone else fails the recipient check', () => {
    const b: Binding = newBinding('alice', 'carol');
    expect(checkBinding(b, 'alice', 'bob', never)).toBe('wrong-recipient');
  });

  test('replays are detected by id', () => {
    const b = newBinding('alice', 'bob');
    const seen = new Set<string>();
    expect(checkBinding(b, 'alice', 'bob', (x) => seen.has(x))).toBeNull();
    seen.add(b.x);
    expect(checkBinding(b, 'alice', 'bob', (x) => seen.has(x))).toBe('replay');
  });

  test('too old or future-dated messages are rejected', () => {
    const now = Date.now();
    const old = { ...newBinding('alice', 'bob'), ts: new Date(now - MAX_AGE_MS - 1000).toISOString() };
    const future = { ...newBinding('alice', 'bob'), ts: new Date(now + 2 * 3600 * 1000).toISOString() };
    expect(checkBinding(old, 'alice', 'bob', never, now)).toBe('too-old');
    expect(checkBinding(future, 'alice', 'bob', never, now)).toBe('from-future');
  });

  test('messages without binding (clients ≤ 2.2) are reported as missing', () => {
    expect(checkBinding({ } as any, 'alice', 'bob', never)).toBe('missing');
  });

  test('binding does not clobber the relay event type field "t"', () => {
    const ev = { v: 1, t: 'text', id: 'abc', at: new Date().toISOString(), b: 'hi' };
    const body = { ...ev, ...newBinding('alice', 'bob') };
    expect(body.t).toBe('text');
  });

  test('a reply reference in a text event survives the binding (field "rp", not "r")', () => {
    const ev = { v: 1, t: 'text', id: 'abc', b: 'hi', rp: { id: 'q1', q: 'quoted', k: 'text' } };
    const body = { ...ev, ...newBinding('alice', 'bob') };
    expect(body.rp).toEqual({ id: 'q1', q: 'quoted', k: 'text' });
    expect(checkBinding(body, 'alice', 'bob', never)).toBeNull();
  });

  test('media header round-trips caption and binding', () => {
    const media = new Uint8Array([0xff, 0xd8, 1, 2, 3]);
    const header = { c: 'hello', ...newBinding('alice', 'bob') };
    const { header: h, mediaBytes } = unwrapMedia(wrapMedia(media, header));
    expect(h).toEqual(header);
    expect(Array.from(mediaBytes)).toEqual(Array.from(media));
  });
});
