/**
 * Two app instances (separate module graphs) talk through crypto/channel.ts:
 * old format first, hello handshake, then forward secrecy; simultaneous session starts.
 */
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';

type Channel = typeof import('../crypto/channel');
type Sessions = typeof import('../crypto/sessions');

interface Instance { id: string; ch: Channel; ss: Sessions; kp: nacl.BoxKeyPair }

const keys: Record<string, nacl.BoxKeyPair> = {};

function instance(id: string): Instance {
  const kp = nacl.box.keyPair();
  keys[id] = kp;
  let inst!: Instance;
  jest.isolateModules(() => {
    const store = new Map<string, unknown>();
    jest.doMock('../store/secureJson', () => ({
      getSecureJson: async (k: string) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
      setSecureJson: async (k: string, v: unknown) => { store.set(k, JSON.parse(JSON.stringify(v))); },
    }));
    jest.doMock('@react-native-async-storage/async-storage', () => ({ removeItem: async () => {} }));
    jest.doMock('../crypto/keys', () => ({ loadPrivateKey: async () => kp.secretKey }));
    jest.doMock('../crypto/peerKeys', () => ({ getPeerKey: async (peer: string) => encodeBase64(keys[peer].publicKey) }));
    inst = { id, kp, ch: require('../crypto/channel'), ss: require('../crypto/sessions') };
  });
  return inst;
}

async function send(from: Instance, to: Instance, obj: object, hello = false) {
  const s = await from.ch.sealFor(to.id, obj, { hello });
  return { s, open: () => to.ch.openFromPeer<any>(from.id, to.id, s.bytes, { nonce: s.nonce, promote: true }) };
}

describe('channel', () => {
  it('uses the old format until the friend answered a hello, then the ratchet', async () => {
    const a = instance('a-1'), b = instance('b-2');
    let m = await send(a, b, { t: 'text', b: 'old' });
    expect(m.s.fs).toBe(false);
    expect((await m.open())!.obj.b).toBe('old');

    m = await send(a, b, { t: 'hello' }, true);
    expect(m.s.fs).toBe(true);
    const o = await m.open();
    expect(o!.answer).toBe(true);           // b must answer
    expect(await b.ss.isFsPeer('a-1')).toBe(true);

    const reply = await send(b, a, { t: 'hello' });
    expect(reply.s.fs).toBe(true);          // b now writes forward secret
    expect((await reply.open())!.fs).toBe(true);
    expect(await a.ss.isFsPeer('b-2')).toBe(true);

    m = await send(a, b, { t: 'text', b: 'secret' });
    expect(m.s.fs).toBe(true);
    expect((await m.open())!.obj.b).toBe('secret');
    // replay of the same ratchet message fails
    expect(await m.open()).toBeNull();
  });

  it('a friend on an old version just cannot open a hello (and nothing breaks)', async () => {
    const a = instance('a-3'), old = instance('o-4');
    const m = await send(a, old, { t: 'hello' }, true);
    // an old client would try the static box with the random nonce: fails
    expect(nacl.box.open(m.s.bytes, nacl.randomBytes(24), a.kp.publicKey, old.kp.secretKey)).toBeNull();
    expect(await a.ss.isFsPeer('o-4')).toBe(false);
    const later = await send(a, old, { t: 'text', b: 'still readable' });
    expect(later.s.fs).toBe(false);
  });

  it('both start a session at once: they settle on one and keep talking', async () => {
    const a = instance('a-5'), b = instance('b-6'); // 'a-5' < 'b-6'
    const ha = await send(a, b, { t: 'hello' }, true);
    const hb = await send(b, a, { t: 'hello' }, true);
    const atB = await ha.open();
    const atA = await hb.open();
    expect(atA!.answer).toBe(false); // a (smaller id) keeps its own session
    expect(atB!.answer).toBe(true);  // b switches to a's session and answers
    const ans = await send(b, a, { t: 'hello' });
    expect((await ans.open())!.fs).toBe(true);
    for (let i = 0; i < 3; i++) {
      const x = await send(a, b, { n: i });
      expect((await x.open())!.obj.n).toBe(i);
      const y = await send(b, a, { n: 100 + i });
      expect((await y.open())!.obj.n).toBe(100 + i);
    }
  });

  it('envelopes and media blobs', async () => {
    const a = instance('a-7'), b = instance('b-8');
    const env = await a.ch.sealEnvelope('b-8', { k: 'key' });
    expect((await b.ch.openFromPeer<any>('a-7', 'b-8', env))!.obj.k).toBe('key');
    const { blob, key } = a.ch.encryptBlob(new Uint8Array([1, 2, 3]));
    const packed = a.ch.packMedia(env, blob);
    const un = b.ch.unpackMedia(packed)!;
    expect(Array.from(b.ch.decryptBlob(un.blob, key)!)).toEqual([1, 2, 3]);
    expect(b.ch.decryptBlob(un.blob, a.ch.encryptBlob(new Uint8Array(1)).key)).toBeNull();
  });
});
