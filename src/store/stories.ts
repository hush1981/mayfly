/**
 * Stories: one encrypted blob per story for 24 hours, readable only by the friends the
 * owner picked. The blob key goes to each of them in an end-to-end encrypted envelope
 * (ratchet when possible). The server stores the blob and the envelopes but never the key.
 *
 * Viewers open an envelope once and keep the key locally (encrypted at rest) until the
 * story expires; ratchet message keys are single-use, so the envelope cannot be opened twice.
 * Watching tells the owner end-to-end encrypted ("storyseen"); the server only sees a
 * small relay message.
 */
import { useSyncExternalStore } from 'react';
import * as FileSystem from 'expo-file-system';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { deleteStory, downloadStory, listStories, postStory as apiPostStory } from '../api/stories';
import { decryptBlob, encryptBlob, openFromPeer, sealEnvelope } from '../crypto/channel';
import { unwrapMedia, wrapMedia } from '../crypto/encryption';
import { KeyChangedError, getPeerKey } from '../crypto/peerKeys';
import { Binding, checkBinding, newBinding } from '../crypto/sealed';
import { flushSessions } from '../crypto/sessions';
import { getSecureJson, setSecureJson } from './secureJson';
import { isSeen, markSeen, rememberPeerNames } from './chatStore';
import { readMomentPayload } from '../send/payload';
import { PayloadDraft, buildPayload, deletePlainOriginals } from '../send/build';
import { blobHash, blobMatches } from '../media/tools';

const KEY = 'mayfly_stories_v1';

export interface FriendStory {
  id: string;
  owner: string;
  ownerName: string;
  mt: 'image' | 'video';
  createdAt: string;
  expiresAt: string;
  key: string;
  /** SHA-256 of the blob from the owner's envelope (2.9+), checked on every open. */
  h?: string;
  seen?: boolean;
}

export interface OwnStory {
  id: string;
  mt: 'image' | 'video';
  createdAt: string;
  expiresAt: string;
  key: string;
  audience: number;
  /** viewer id → when they watched */
  viewers: Record<string, string>;
}

interface Persisted { friends: Record<string, FriendStory>; mine: Record<string, OwnStory> }

let data: Persisted = { friends: {}, mine: {} };
let loaded = false;
let version = 0;
const listeners = new Set<() => void>();

async function load() {
  if (loaded) return;
  try {
    const p = await getSecureJson<Persisted>(KEY);
    if (p?.friends && p.mine) data = p;
  } catch (_) {}
  loaded = true;
}

function changed() {
  version++;
  listeners.forEach((l) => l());
}

async function save() {
  await setSecureJson(KEY, data);
  changed();
}

export function useStoriesVersion(): number {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => version);
}

function alive(expiresAt: string) {
  return new Date(expiresAt).getTime() > Date.now();
}

interface Envelope extends Partial<Binding> { t?: string; k?: string; h?: string; mt?: string }

let refreshing: Promise<void> | null = null;

/** Loads the story list, opens new envelopes once, forgets expired stories. */
export function refreshStories(myId: string): Promise<void> {
  if (!refreshing) {
    refreshing = (async () => {
      await load();
      const { friends, mine } = await listStories();
      const next: Record<string, FriendStory> = {};
      const keys = new Map<string, string | null>();
      rememberPeerNames(friends.map((s) => ({ id: s.owner_id, username: s.owner_username })));
      for (const s of friends) {
        const known = data.friends[s.id];
        if (known) { next[s.id] = known; continue; }
        if (!keys.has(s.owner_id)) {
          try { keys.set(s.owner_id, await getPeerKey(s.owner_id)); } catch (e) {
            keys.set(s.owner_id, null); // key change pending: wait until it is resolved
            if (!(e instanceof KeyChangedError)) throw e;
          }
        }
        const peerKey = keys.get(s.owner_id);
        if (!peerKey) continue;
        try {
          const opened = await openFromPeer<Envelope>(s.owner_id, myId, decodeBase64(s.envelope), { peerKey });
          const env = opened?.obj;
          if (!env || env.t !== 'story' || typeof env.k !== 'string') continue;
          if (env.h !== undefined && (typeof env.h !== 'string' || env.h.length > 64)) continue;
          if (checkBinding(env, s.owner_id, myId, isSeen)) continue;
          markSeen(env.x!);
          next[s.id] = {
            id: s.id, owner: s.owner_id, ownerName: s.owner_username, mt: s.media_type,
            createdAt: s.created_at, expiresAt: s.expires_at, key: env.k, h: env.h,
          };
        } catch (_) {}
      }
      const mineNext: Record<string, OwnStory> = {};
      for (const m of mine) {
        const known = data.mine[m.id];
        if (known) mineNext[m.id] = { ...known, audience: m.audience, expiresAt: m.expires_at };
      }
      data = { friends: next, mine: mineNext };
      // The keys must be on disk before the ratchet forgets the message keys they came with.
      await save();
      await flushSessions();
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

export async function loadStories(): Promise<void> {
  await load();
  changed();
}

/** Friends' active stories grouped by owner (oldest first), owners with unseen ones first. */
export function storiesByOwner(): { owner: string; name: string; items: FriendStory[]; unseen: boolean; latest: string }[] {
  const m = new Map<string, FriendStory[]>();
  for (const s of Object.values(data.friends)) {
    if (!alive(s.expiresAt)) continue;
    const l = m.get(s.owner) ?? [];
    l.push(s);
    m.set(s.owner, l);
  }
  return Array.from(m.entries()).map(([owner, items]) => {
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { owner, name: items[0].ownerName, items, unseen: items.some((i) => !i.seen), latest: items[items.length - 1].createdAt };
  }).sort((a, b) => (a.unseen !== b.unseen ? (a.unseen ? -1 : 1) : b.latest.localeCompare(a.latest)));
}

export function storiesOf(owner: string): FriendStory[] {
  return Object.values(data.friends).filter((s) => s.owner === owner && alive(s.expiresAt))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function ownStories(): OwnStory[] {
  return Object.values(data.mine).filter((s) => alive(s.expiresAt)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Marks a friend's story as watched locally. Returns true the first time. */
export function markStoryWatched(id: string): boolean {
  const s = data.friends[id];
  if (!s || s.seen) return false;
  data.friends[id] = { ...s, seen: true };
  save().catch(() => {});
  return true;
}

/** "storyseen" from a viewer (only counted for my own, still known stories). */
export function recordStoryView(storyId: string, viewer: string, at: string) {
  const s = data.mine[storyId];
  if (!s || s.viewers[viewer]) return;
  data.mine[storyId] = { ...s, viewers: { ...s.viewers, [viewer]: at } };
  save().catch(() => {});
}

export interface StoryDraft extends PayloadDraft {
  type: 'image' | 'video';
}

/**
 * Posts a story for the given friends. Friends with a pending key change are left out
 * (returned in `skipped`).
 */
export async function postStory(
  draft: StoryDraft, viewers: { id: string; username: string }[], myId: string, keepOriginals = false,
): Promise<{ skipped: string[] }> {
  await load();
  const { body, header } = await buildPayload({ ...draft, replyTo: undefined }, 5);
  const { blob, key } = encryptBlob(wrapMedia(body, { ...header, f: myId, st: 1 }));

  const tmp = `${FileSystem.cacheDirectory}moment_story_${Date.now()}.enc`;
  await FileSystem.writeAsStringAsync(tmp, encodeBase64(blob), { encoding: FileSystem.EncodingType.Base64 });
  // every viewer gets the hash of the one shared blob in their own envelope
  const h = await blobHash(blob, tmp).catch((e) => {
    FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
    throw e;
  });

  const keys: { viewer_id: string; envelope: string }[] = [];
  const skipped: string[] = [];
  for (const v of viewers) {
    try {
      const env = await sealEnvelope(v.id, { t: 'story', k: key, h, mt: draft.type, ...newBinding(myId, v.id) }, undefined, true);
      keys.push({ viewer_id: v.id, envelope: encodeBase64(env) });
    } catch (e) {
      skipped.push(v.username);
    }
  }
  try {
    if (keys.length === 0) throw new Error('No friend can receive this story right now.');
    await flushSessions(); // before the envelopes leave the device
    const res = await apiPostStory(tmp, draft.type, keys);
    data.mine[res.id] = {
      id: res.id, mt: draft.type, createdAt: new Date().toISOString(), expiresAt: res.expires_at,
      key, audience: keys.length, viewers: {},
    };
    await save();
  } finally {
    FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
  }
  if (!keepOriginals) deletePlainOriginals(draft);
  return { skipped };
}

/** Downloads and decrypts a story (friend's or own). */
export async function openStory(id: string): Promise<ReturnType<typeof readMomentPayload> & { filter?: string }> {
  await load();
  const key = data.friends[id]?.key ?? data.mine[id]?.key;
  if (!key) throw new Error('unknown story');
  const blob = await downloadStory(id);
  // (a friend's story: the blob is shared by all viewers — it must match the owner's hash)
  const fh = data.friends[id]?.h;
  if (data.friends[id] && fh !== undefined) {
    // hashed natively from a temp copy of the ciphertext (much faster than in JS)
    const tmp = `${FileSystem.cacheDirectory}story_chk_${Date.now()}.enc`;
    let ok = false;
    try {
      await FileSystem.writeAsStringAsync(tmp, encodeBase64(blob), { encoding: FileSystem.EncodingType.Base64 });
      ok = await blobMatches(fh, blob, tmp);
    } finally {
      FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
    }
    if (!ok) throw new Error('This story could not be decrypted.');
  }
  const plain = decryptBlob(blob, key);
  if (!plain) throw new Error('This story could not be decrypted.');
  const { header, mediaBytes } = unwrapMedia(plain);
  const info = readMomentPayload(header, mediaBytes);
  const fl = typeof header?.fl === 'string' ? header.fl : undefined;
  return { ...info, filter: fl };
}

export async function removeOwnStory(id: string) {
  await deleteStory(id);
  delete data.mine[id];
  await save();
}

export async function forgetStories() {
  data = { friends: {}, mine: {} };
  loaded = true;
  await setSecureJson(KEY, data).catch(() => {});
  changed();
}
