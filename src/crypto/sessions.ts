/**
 * Ratchet sessions per friend (see crypto/ratchet.ts), stored encrypted at rest.
 *
 * Policy:
 * - A friend counts as "forward-secrecy capable" (fs) once one of their ratchet messages
 *   decrypted. Before that, content goes the old way (static keys) so 2.5 friends can still
 *   read it; the app only sends a content-free "hello" in a new session to find out.
 * - Once fs, everything to that friend goes through the ratchet — never back (a server
 *   cannot downgrade us by withholding messages).
 * - Sessions are bound to the friend's trusted identity key; if that key changes (accepted or
 *   verified again), all sessions with the friend are dropped and a new handshake starts.
 * - When both sides start a session at once, the one started by the smaller user id wins.
 *
 * - Session ids that were dropped (housekeeping, blocking) are remembered (bounded), so a
 *   server replaying an old session-opening message cannot bring a dead session back and
 *   make it the one we write in.
 *
 * All operations run one after another (a small lock), and the state is saved before a
 * ciphertext leaves the device, so a message key is never used twice.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { decodeBase64 } from 'tweetnacl-util';
import nacl from 'tweetnacl';
import { getSecureJson, setSecureJson } from '../store/secureJson';
import { loadPrivateKey } from './keys';
import { getPeerKey } from './peerKeys';
import { RatchetError, Session, decrypt, encrypt, initiate, pruneSkipped, sessionIdOf } from './ratchet';

const KEY = 'mayfly_ratchet_v1';
const HELLO_EVERY_MS = 12 * 3600 * 1000;
const OLD_SESSION_MS = 3 * 24 * 3600 * 1000;
/** Dropped session ids remembered per friend (oldest forgotten first). */
export const MAX_DROPPED = 64;

interface PeerRecord {
  /** identity key the sessions belong to */
  ik?: string;
  active?: string;
  sessions: Record<string, Session>;
  fs?: boolean;
  helloAt?: number;
  /** dropped session id → when; such a session is never started again */
  dropped?: Record<string, number>;
}

function tombstone(rec: PeerRecord, sid: string, at: number) {
  const d = rec.dropped ?? (rec.dropped = {});
  d[sid] = at;
  const ids = Object.keys(d);
  if (ids.length > MAX_DROPPED) {
    ids.sort((a, b) => d[a] - d[b]);
    for (const old of ids.slice(0, ids.length - MAX_DROPPED)) delete d[old];
  }
}

let cache: Record<string, PeerRecord> | null = null;
let dirty = false;
let chain: Promise<unknown> = Promise.resolve();

function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function load(): Promise<Record<string, PeerRecord>> {
  if (cache) return cache;
  try {
    cache = (await getSecureJson<Record<string, PeerRecord>>(KEY)) ?? {};
  } catch {
    cache = {};
  }
  return cache!;
}

async function save() {
  if (!cache) return;
  await setSecureJson(KEY, cache);
  dirty = false;
}

/** Writes pending changes (after a batch of decryptions, before acknowledging them). */
export function flushSessions(): Promise<void> {
  return locked(async () => { if (dirty) await save(); });
}

/** `known` = the friend's trusted key if the caller just got it from getPeerKey (saves a request). */
async function recordFor(peerId: string, known?: string): Promise<{ rec: PeerRecord; peerIk: Uint8Array }> {
  const peerKey = known ?? await getPeerKey(peerId); // throws KeyChangedError while a change is pending
  const all = await load();
  let rec = all[peerId];
  if (!rec || rec.ik !== peerKey) {
    // new friend, or their key changed: start over (old sessions belong to the old key)
    rec = { ik: peerKey, sessions: {} };
    all[peerId] = rec;
    dirty = true;
  }
  return { rec, peerIk: decodeBase64(peerKey) };
}

export async function isFsPeer(peerId: string): Promise<boolean> {
  const rec = (await load())[peerId];
  return !!rec?.fs;
}

/**
 * Encrypts for a friend. Returns null if the friend has not shown forward-secrecy support
 * yet (the caller then uses the old format), unless `hello` forces a session message.
 */
export function ratchetEncrypt(
  peerId: string, plain: Uint8Array, opts: { hello?: boolean; peerKey?: string; defer?: boolean } = {},
): Promise<Uint8Array | null> {
  return locked(async () => {
    const { rec, peerIk } = await recordFor(peerId, opts.peerKey);
    if (!rec.fs && !opts.hello) {
      if (dirty) await save();
      return null;
    }
    const secret = await loadPrivateKey();
    const myIk = nacl.box.keyPair.fromSecretKey(secret).publicKey;
    let s = rec.active ? rec.sessions[rec.active] : undefined;
    if (!s) {
      s = initiate(secret, peerIk);
      rec.sessions[s.sid] = s;
      rec.active = s.sid;
    }
    const r = encrypt(s, myIk, peerIk, plain);
    rec.sessions[s.sid] = r.state;
    if (opts.hello) rec.helloAt = Date.now();
    // Saved before the ciphertext leaves the device (a reused chain key would reuse a key
    // AND nonce). `defer`: the caller encrypts a batch and MUST call flushSessions() before
    // sending any of it.
    if (opts.defer) dirty = true;
    else await save();
    return r.message;
  });
}

export interface RatchetOpened {
  plaintext: Uint8Array;
  /** A new session was started by the peer and we have not written in it: answer with a hello. */
  answer: boolean;
}

/**
 * Decrypts a ratchet message from a friend. `promote` (chat events): the session becomes
 * the one we write in. Changes are kept in memory until flushSessions() unless `persist`.
 */
export function ratchetDecrypt(
  peerId: string, myId: string, message: Uint8Array,
  opts: { promote?: boolean; persist?: boolean; peerKey?: string } = {},
): Promise<RatchetOpened> {
  return locked(async () => {
    const { rec, peerIk } = await recordFor(peerId, opts.peerKey);
    const { sid } = sessionIdOf(message);
    // a replayed opening message of a session we already dropped: refuse, do not re-create
    if (!rec.sessions[sid] && rec.dropped?.[sid]) throw new RatchetError('no-session');
    const secret = await loadPrivateKey();
    const r = decrypt(rec.sessions[sid] ?? null, secret, peerIk, message);
    rec.sessions[sid] = r.state;
    rec.fs = true;
    let answer = false;
    if (r.created) {
      const act = rec.active ? rec.sessions[rec.active] : undefined;
      // both started at once: the session of the smaller user id wins on both phones
      const keepMine = !!act && act.initiator && !act.confirmed && myId < peerId;
      if (!keepMine) {
        rec.active = sid;
        answer = !r.state.sentAny;
      }
    } else if (opts.promote && !r.fromSkipped && rec.active !== sid) {
      rec.active = sid;
    }
    dirty = true;
    if (opts.persist) await save();
    return { plaintext: r.plaintext, answer };
  });
}

/** True if the friend should get a handshake hello (not fs yet, none sent recently). */
export async function needsHello(peerId: string): Promise<boolean> {
  const rec = (await load())[peerId];
  if (rec?.fs) return false;
  return !rec?.helloAt || Date.now() - rec.helloAt > HELLO_EVERY_MS;
}

/** Drops unused old sessions and expired skipped keys. */
export function sessionHousekeeping(): Promise<void> {
  return locked(async () => {
    const all = await load();
    const now = Date.now();
    for (const rec of Object.values(all)) {
      for (const [sid, s] of Object.entries(rec.sessions)) {
        if (sid !== rec.active && now - s.usedAt > OLD_SESSION_MS) {
          delete rec.sessions[sid];
          tombstone(rec, sid, now);
          dirty = true;
          continue;
        }
        const before = Object.keys(s.skipped).length;
        pruneSkipped(s, now);
        if (Object.keys(s.skipped).length !== before) dirty = true;
      }
    }
    if (dirty) await save();
  });
}

/** Forgets the sessions with one friend (blocking); their ids stay refused. */
export function forgetSessions(peerId: string): Promise<void> {
  return locked(async () => {
    const all = await load();
    const rec = all[peerId];
    if (!rec) return;
    const now = Date.now();
    const kept: PeerRecord = { ik: rec.ik, sessions: {}, dropped: rec.dropped };
    for (const sid of Object.keys(rec.sessions)) tombstone(kept, sid, now);
    all[peerId] = kept;
    await save();
  });
}

/** Logout: everything goes. */
export async function forgetAllSessions(): Promise<void> {
  await locked(async () => {
    cache = {};
    dirty = false;
    await AsyncStorage.removeItem(KEY).catch(() => {});
  });
}
