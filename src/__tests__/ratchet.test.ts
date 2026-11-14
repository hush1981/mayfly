import nacl from 'tweetnacl';
import { decodeUTF8, encodeUTF8 } from 'tweetnacl-util';
import { Session, decrypt, encrypt, initiate, isRatchetMessage, sessionIdOf, RatchetError, hkdf, hmacSha512 } from '../crypto/ratchet';

const A = nacl.box.keyPair();
const B = nacl.box.keyPair();
const E = nacl.box.keyPair();

function send(s: Session, me: nacl.BoxKeyPair, peer: nacl.BoxKeyPair, text: string) {
  const r = encrypt(s, me.publicKey, peer.publicKey, decodeUTF8(text));
  return { s: r.state, m: r.message };
}

function recv(s: Session | null, me: nacl.BoxKeyPair, peer: nacl.BoxKeyPair, m: Uint8Array) {
  const r = decrypt(s, me.secretKey, peer.publicKey, m);
  return { s: r.state, text: encodeUTF8(r.plaintext), created: r.created };
}

describe('primitives', () => {
  it('HMAC-SHA512 matches RFC 4231 test case 2', () => {
    const mac = hmacSha512(decodeUTF8('Jefe'), decodeUTF8('what do ya want for nothing?'));
    const hex = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737');
  });
  it('HKDF gives the requested length', () => {
    expect(hkdf(new Uint8Array(0), new Uint8Array(32), new Uint8Array(0), 56).length).toBe(56);
  });
});

describe('double ratchet', () => {
  it('starts a session, answers, and keeps going both ways', () => {
    let a = initiate(A.secretKey, B.publicKey);
    let m: Uint8Array;
    ({ s: a, m } = send(a, A, B, 'hello'));
    expect(isRatchetMessage(m)).toBe(true);
    expect(sessionIdOf(m).hasEk).toBe(true);
    let { s: b, text, created } = recv(null, B, A, m);
    expect(created).toBe(true);
    expect(text).toBe('hello');
    // B's state must not contain B's identity secret
    expect(JSON.stringify(b)).not.toContain(Buffer.from(B.secretKey).toString('base64'));

    ({ s: b, m } = send(b, B, A, 'hi back'));
    ({ s: a, text } = recv(a, A, B, m));
    expect(text).toBe('hi back');
    expect(a.confirmed).toBe(true);
    ({ s: a, m } = send(a, A, B, 'after confirm'));
    expect(sessionIdOf(m).hasEk).toBe(false); // base key no longer sent
    ({ s: b, text } = recv(b, B, A, m));
    expect(text).toBe('after confirm');
  });

  it('handles out-of-order and late messages (skipped keys), but only once each', () => {
    let a = initiate(A.secretKey, B.publicKey);
    const msgs: Uint8Array[] = [];
    for (let i = 0; i < 5; i++) { const r = send(a, A, B, 'm' + i); a = r.s; msgs.push(r.m); }
    let b: Session | null = null;
    let t;
    ({ s: b, text: t } = recv(b, B, A, msgs[4]));
    expect(t).toBe('m4');
    ({ s: b, text: t } = recv(b, B, A, msgs[1]));
    expect(t).toBe('m1');
    expect(() => recv(b, B, A, msgs[1])).toThrow(RatchetError); // replay
    expect(() => recv(b, B, A, msgs[4])).toThrow(RatchetError);
    // direction change, then an old one from the first chain still opens
    let m: Uint8Array;
    ({ s: b, m } = send(b!, B, A, 'reply'));
    ({ s: a } = recv(a, A, B, m));
    ({ s: a, m } = send(a, A, B, 'new chain'));
    ({ s: b, text: t } = recv(b, B, A, m));
    expect(t).toBe('new chain');
    ({ s: b, text: t } = recv(b, B, A, msgs[2]));
    expect(t).toBe('m2');
  });

  it('rejects tampering, a wrong sender identity and a third party', () => {
    let a = initiate(A.secretKey, B.publicKey);
    let m: Uint8Array;
    ({ s: a, m } = send(a, A, B, 'secret'));
    const bad = m.slice();
    bad[bad.length - 1] ^= 1;
    expect(() => recv(null, B, A, bad)).toThrow(RatchetError);
    const hdr = m.slice();
    hdr[hdr.length - 50] ^= 1; // inside the body / header area
    expect(() => recv(null, B, A, hdr)).toThrow(RatchetError);
    // B believes the message comes from E: the identity keys do not match
    expect(() => recv(null, B, E, m)).toThrow(RatchetError);
    // E cannot open a message meant for B
    expect(() => recv(null, E, A, m)).toThrow(RatchetError);
    // the server cannot start a session in A's name without A's identity key
    let fake = initiate(E.secretKey, B.publicKey);
    ({ s: fake, m } = send(fake, E, B, 'i am A'));
    expect(() => recv(null, B, A, m)).toThrow(RatchetError);
  });

  it('forward secrecy: the current state cannot open earlier messages', () => {
    let a = initiate(A.secretKey, B.publicKey);
    let m0: Uint8Array;
    ({ s: a, m: m0 } = send(a, A, B, 'old'));
    let { s: b } = recv(null, B, A, m0);
    let m: Uint8Array;
    ({ s: b, m } = send(b, B, A, 'x'));
    ({ s: a } = recv(a, A, B, m));
    ({ s: a, m } = send(a, A, B, 'y'));
    ({ s: b } = recv(b, B, A, m));
    // an attacker who steals B's identity key AND the current session state:
    expect(() => decrypt(b, B.secretKey, A.publicKey, m0)).toThrow(RatchetError);
  });

  it('refuses to skip too far', () => {
    let a = initiate(A.secretKey, B.publicKey);
    let m: Uint8Array = new Uint8Array();
    for (let i = 0; i < 1002; i++) ({ s: a, m } = send(a, A, B, 'x'));
    expect(() => recv(null, B, A, m)).toThrow(RatchetError);
  });
});
