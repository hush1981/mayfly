/**
 * Delivery tokens for sealed sender (see crypto/sealedSender.ts, server handlers/sealed.go).
 *
 * - My token: 32 random bytes; the server only knows its SHA-256. Friends get the token
 *   end-to-end encrypted (relay event "dtok") and use it instead of their login to deliver
 *   to me — so the server cannot see who sends to whom.
 * - Friends' tokens: kept here (encrypted at rest) and used for everything sent to them.
 * - Blocking someone changes my token and gives the new one only to the remaining friends;
 *   messages that still arrive from a blocked person are dropped by the app.
 */
import { getSecureJson, setSecureJson } from './secureJson';
import { registerDeliveryToken } from '../api/sealed';
import { newSecret, sha256b64 } from '../crypto/sealedSender';
import { trustedKeyLocal } from '../crypto/peerKeys';

const KEY = 'mayfly_sealed_v1';

interface State {
  mine?: { tok: string; hash: string; registered: boolean };
  /** friend id → their delivery token */
  peers: Record<string, string>;
  /** friend id → "hash of my token | their key" I last gave it to (a new key of theirs = send again) */
  sent: Record<string, string>;
  /** people I blocked (their sealed messages are dropped) */
  blocked: Record<string, number>;
  /** friends that sent a sealed envelope with sender proof (2.9.1+): never accept one without */
  proof?: Record<string, number>;
}

let state: State = { peers: {}, sent: {}, blocked: {} };
let loaded: Promise<void> | null = null;

function load(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      try {
        const s = await getSecureJson<State>(KEY);
        if (s) state = { peers: s.peers ?? {}, sent: s.sent ?? {}, blocked: s.blocked ?? {}, proof: s.proof ?? {}, mine: s.mine };
      } catch (_) {}
    })();
  }
  return loaded;
}

async function save() {
  await setSecureJson(KEY, state).catch(() => {});
}

export const TOKEN_RE = /^[A-Za-z0-9+/]{43}=$/;

/** My current token, registered with the server (creates one the first time). */
export async function myToken(): Promise<string> {
  await load();
  if (!state.mine) {
    const tok = newSecret();
    state.mine = { tok, hash: sha256b64(tok), registered: false };
    await save();
  }
  if (!state.mine.registered) {
    await registerDeliveryToken(state.mine.hash);
    state.mine.registered = true;
    await save();
  }
  return state.mine.tok;
}

/** New token: the old one stops working at once; friends get the new one with the next sync. */
export async function rotateMyToken(): Promise<void> {
  await load();
  const tok = newSecret();
  state.mine = { tok, hash: sha256b64(tok), registered: false };
  state.sent = {};
  await save();
  await myToken().catch(() => {});
}

export async function peerToken(peerId: string): Promise<string | undefined> {
  await load();
  return state.peers[peerId];
}

export async function setPeerToken(peerId: string, tok: string | null) {
  await load();
  if (tok && TOKEN_RE.test(tok)) state.peers[peerId] = tok;
  else delete state.peers[peerId];
  await save();
}

/** Friends that do not have my current token yet (or got it for an old key of theirs). */
export async function friendsNeedingToken(friendIds: string[]): Promise<string[]> {
  await load();
  const h = state.mine?.hash;
  const out: string[] = [];
  for (const id of friendIds) {
    if (state.blocked[id]) continue;
    if (!h || state.sent[id] !== `${h}|${(await trustedKeyLocal(id)) ?? ''}`) out.push(id);
  }
  return out;
}

export async function markTokenSent(peerId: string, tok: string, peerKey: string) {
  await load();
  state.sent[peerId] = `${sha256b64(tok)}|${peerKey}`;
  await save();
}

export async function isBlockedLocally(peerId: string): Promise<boolean> {
  await load();
  return !!state.blocked[peerId];
}

/** After blocking / removing a friend: forget their token, drop their messages, new own token. */
export async function cutOff(peerId: string, block: boolean) {
  await load();
  delete state.peers[peerId];
  delete state.sent[peerId];
  if (block) state.blocked[peerId] = Date.now();
  await save();
  await rotateMyToken();
}

export async function unblockLocally(peerId: string) {
  await load();
  delete state.blocked[peerId];
  await save();
}

/**
 * Sender proof of a sealed envelope (crypto/sealedSender.ts checkSealedProof): accepted?
 * 'ok' marks the friend as proof-capable; 'missing' is accepted only from friends that never
 * sent a proof (older app versions), so nobody can strip it to impersonate an updated friend.
 */
export async function acceptSealedProof(peerId: string, result: 'ok' | 'missing' | 'bad'): Promise<boolean> {
  if (result === 'bad') return false;
  await load();
  const proof = state.proof ?? (state.proof = {});
  if (result === 'missing') return !proof[peerId];
  if (!proof[peerId]) {
    proof[peerId] = Date.now();
    await save();
  }
  return true;
}

export async function clearTokens() {
  state = { peers: {}, sent: {}, blocked: {} };
  loaded = Promise.resolve();
  await setSecureJson(KEY, state).catch(() => {});
}
