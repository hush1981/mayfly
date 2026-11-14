/**
 * Local chat history. Lives only on this device (AsyncStorage + app-private files);
 * the server never sees it.
 *
 * A moment entry exists once per (moment, peer). Incoming moments use the server media id,
 * outgoing ones the media id returned by /media/send — both sides share the same id,
 * which is how receipts (opened / replayed / saved) are matched.
 *
 * Local copies (`file`) are always ciphertext: incoming = the blob as downloaded
 * (encrypted to our key), outgoing = a copy we encrypt to our own key on send.
 * They exist for the one allowed replay, for moments saved in the chat (shown inline,
 * no view limit) and for voice messages while they are in the chat.
 *
 * Per-chat settings (delete time, mute, nickname) and the contact counter behind the
 * best-friends list also live only here.
 */
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSecureJson, setSecureJson } from './secureJson';
import * as FileSystem from 'expo-file-system';

const DAY = 24 * 60 * 60 * 1000;

export type MomentStatus = 'pending' | 'opened' | 'replayed' | 'expired';

export type ChatKind = 'moment' | 'text' | 'voice' | 'system';

/** What a message answers: id + short quote + kind of the original. */
export interface ReplyRef {
  id: string;
  q: string;
  k: 'moment' | 'text' | 'voice' | 'story';
}

export { REPLY_KINDS } from '../send/payload';

/** Group chats live in the chat store under the id "g:<group id>". */
export function groupChatId(groupId: string): string {
  return 'g:' + groupId;
}
export function isGroupChat(chatId: string): boolean {
  return chatId.startsWith('g:');
}
export function groupIdOf(chatId: string): string {
  return chatId.slice(2);
}

export interface ChatMoment {
  /** 'moment' (photo/video), 'text', 'voice' or 'system' (local note). Missing = moment. */
  kind?: ChatKind;
  /** Text messages and system notes: the text (plain, only on this device). */
  text?: string;
  /** Incoming texts/voice: when it was read / listened to. */
  readAt?: string;
  /** Outgoing texts/voice: when the peer read / listened to it. */
  peerReadAt?: string;
  /** Answer to another message or moment. */
  replyTo?: ReplyRef;
  myReaction?: string;
  peerReaction?: string;
  /** The sender took it back. */
  unsent?: boolean;
  /** Own moments sent with sealed sender: secret that lets me unsend it while unopened. */
  ut?: string;
  /** Group texts: I was @mentioned (notified even in a muted group). */
  mentionsMe?: boolean;
  /** Text messages: the author changed the text after sending. */
  edited?: boolean;
  /** Moments: view time in seconds set by the sender (0 = until closed). */
  dur?: number;
  /** Voice messages: length in ms. */
  voiceMs?: number;
  /** Outgoing moments: the sender used its one extra view of a saved moment. */
  viewedAgain?: boolean;
  id: string;
  peerId: string;
  peerName: string;
  dir: 'in' | 'out';
  mediaType: 'image' | 'video' | 'audio';
  groupName?: string;
  createdAt: string;
  status: MomentStatus;
  openedAt?: string;
  replayedAt?: string;
  saved: boolean;
  /** Local ciphertext copy (absent = cannot be shown again). */
  file?: string;
  eph?: string;
  nonce?: string;
  /** Local copy in the new format: secretbox key + nonce (base64) of `file` (2.6+). */
  mk?: string;
  /** Incoming group media: SHA-256 of the blob from the sender's announcement (2.9+). */
  bh?: string;
  /** Group chats: author of an incoming entry. */
  from?: string;
  /** Group chats, own moments / messages: who opened / replayed (user id → time). */
  openedBy?: Record<string, string>;
  /** Group chats: reactions per member (user id → emoji); own reaction stays in myReaction. */
  reactions?: Record<string, string>;
  /** Colour filter of a video (applied while playing; photos are baked). */
  filter?: string;
}

/** When unsaved messages disappear: 24 / 12 / 6 h after sending, or after viewing (1:1 only). */
export type ChatTtl = 'day' | '12h' | '6h' | 'viewed';

export const CHAT_TTLS: ChatTtl[] = ['viewed', '6h', '12h', 'day'];

export function isChatTtl(x: unknown): x is ChatTtl {
  return typeof x === 'string' && (CHAT_TTLS as string[]).includes(x);
}

/** Lifetime of unsaved messages for a ttl ('viewed' chats still drop everything after 24 h). */
export function ttlMs(ttl: ChatTtl | undefined): number {
  return ttl === '6h' ? 6 * 3600_000 : ttl === '12h' ? 12 * 3600_000 : DAY;
}

export function chatTtlMs(chatId: string): number {
  return ttlMs(chatSettings(chatId).ttl);
}

export interface ChatSettings {
  /** When unsaved messages disappear (default 24 h after sending). Shared with the peer / the group. */
  ttl?: ChatTtl;
  /** Local only: pinned to the top of the chat list (time pinned, ms). */
  pinned?: number;
  /** Local only: this friend's stories are moved to the end and dimmed. */
  storyMuted?: boolean;
  /** Local only: no notifications from this chat. */
  muted?: boolean;
  /** Local only: own name for this friend. */
  nickname?: string;
}

interface Persisted {
  v: 1;
  chats?: Record<string, ChatSettings>;
  /** Own birthday (opt-in sharing): "MM-DD", share flag, value last sent to each friend. */
  me?: {
    bd?: string; shareBd?: boolean; bdSent?: Record<string, string>; storyAudience?: StoryAudience;
    /** calls: allow direct connections (shows my IP address to the friend); default = via relay */
    callDirect?: boolean;
  };
  /** Friend requests / group invitations already notified about (id → time). */
  notified?: Record<string, number>;
  /** Friends' birthdays they chose to share ("MM-DD"). */
  birthdays?: Record<string, string>;
  /** Contact counter for best friends: decayed score + last update (ms). */
  contacts?: Record<string, { score: number; at: number }>;
  moments: Record<string, ChatMoment>;
  /** Last time the peer list (names) was seen — used for chats without moments. */
  peerNames: Record<string, string>;
  /** Replay protection: message ids ("x") already accepted → time accepted (ms). */
  seen?: Record<string, number>;
}

const KEY = 'mayfly_chat_v1';
/** Unsaved moment entries are kept this long as history lines, without content. */
const HISTORY_MS = 7 * DAY;
/** Unsaved text messages disappear this long after sending. */
export const TEXT_TTL_MS = DAY;
/** How long the one replay stays possible after opening. */
const REPLAY_WINDOW_MS = DAY;

export const MOMENT_DIR = FileSystem.documentDirectory + 'moments/';

let data: Persisted = { v: 1, moments: {}, peerNames: {} };
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
let version = 0;

function key(id: string, peerId: string) {
  return `${id}:${peerId}`;
}

export async function loadChatStore(): Promise<void> {
  if (loaded) return;
  if (!loading) {
    loading = (async () => {
      try {
        const parsed = await getSecureJson<Persisted>(KEY);
        if (parsed?.v === 1) data = parsed;
      } catch (_) {}
      await FileSystem.makeDirectoryAsync(MOMENT_DIR, { intermediates: true }).catch(() => {});
      loaded = true;
    })();
  }
  await loading;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persist() {
  version++;
  listeners.forEach((l) => l());
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    setSecureJson(KEY, data).catch(() => {});
  }, 150);
}

export async function flushChatStore(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await setSecureJson(KEY, data);
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getVersion(): number {
  return version;
}

export function allMoments(): ChatMoment[] {
  return Object.values(data.moments);
}

export function momentsForPeer(peerId: string): ChatMoment[] {
  return allMoments()
    .filter((s) => s.peerId === peerId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getMoment(id: string, peerId: string): ChatMoment | undefined {
  return data.moments[key(id, peerId)];
}

export function rememberPeerNames(peers: { id: string; username: string }[]) {
  let changed = false;
  for (const p of peers) {
    if (data.peerNames[p.id] !== p.username) {
      data.peerNames[p.id] = p.username;
      changed = true;
    }
  }
  if (changed) persist();
}

export function peerName(peerId: string): string | undefined {
  return data.chats?.[peerId]?.nickname || data.peerNames[peerId];
}

/** The account's username (without nickname). */
export function username(peerId: string): string | undefined {
  return data.peerNames[peerId];
}

// ---- Per-chat settings -------------------------------------------------------------

export function chatSettings(peerId: string): ChatSettings {
  return data.chats?.[peerId] ?? {};
}

export function setChatSettings(peerId: string, patch: Partial<ChatSettings>) {
  if (!data.chats) data.chats = {};
  const next = { ...(data.chats[peerId] ?? {}), ...patch };
  if (next.nickname !== undefined && !next.nickname.trim()) delete next.nickname;
  data.chats[peerId] = next;
  persist();
}

export function isMuted(peerId: string): boolean {
  return !!data.chats?.[peerId]?.muted;
}

/** Pinned chats (local only) stay at the top of the list. */
export function isPinned(peerId: string): boolean {
  return !!data.chats?.[peerId]?.pinned;
}

export function setPinned(peerId: string, pinned: boolean) {
  setChatSettings(peerId, { pinned: pinned ? Date.now() : undefined });
}

// ---- Birthdays (opt-in) ----------------------------------------------------------------

export const BIRTHDAY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

export function myBirthday(): { bd?: string; share: boolean } {
  return { bd: data.me?.bd, share: !!data.me?.shareBd };
}

export function setMyBirthday(patch: { bd?: string | null; share?: boolean }) {
  const me = { ...(data.me ?? {}) };
  if (patch.bd !== undefined) me.bd = patch.bd && BIRTHDAY_RE.test(patch.bd) ? patch.bd : undefined;
  if (patch.share !== undefined) me.shareBd = patch.share;
  data.me = me;
  persist();
}

/** What a friend should currently know about my birthday ("" = nothing). */
export function birthdayToSend(): string {
  return data.me?.shareBd && data.me.bd ? data.me.bd : '';
}

export function birthdaySentTo(peerId: string): string {
  return data.me?.bdSent?.[peerId] ?? '';
}

export function markBirthdaySent(peerId: string, value: string) {
  data.me = { ...(data.me ?? {}), bdSent: { ...(data.me?.bdSent ?? {}), [peerId]: value } };
  persist();
}

export function setPeerBirthday(peerId: string, bd: string) {
  if (!data.birthdays) data.birthdays = {};
  if (bd && BIRTHDAY_RE.test(bd)) data.birthdays[peerId] = bd;
  else delete data.birthdays[peerId];
  persist();
}

function todayMMDD(): string {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** " 🎂" on a friend's birthday (if they share it), else "". */
export function cake(peerId: string): string {
  return data.birthdays?.[peerId] === todayMMDD() ? ' 🎂' : '';
}

// ---- Calls ------------------------------------------------------------------------------

/** true = calls only through the server's TURN relay, so the friend never sees my IP address. */
export function callsHideIp(): boolean {
  return !data.me?.callDirect;
}

export function setCallsHideIp(hide: boolean) {
  data.me = { ...(data.me ?? {}), callDirect: !hide };
  persist();
}

// ---- Story audience --------------------------------------------------------------------

/** Who may see my stories: all friends (also ones added later) or only the picked ones. */
export interface StoryAudience { mode: 'all' | 'custom'; ids: string[] }

export function storyAudience(): StoryAudience {
  return data.me?.storyAudience ?? { mode: 'all', ids: [] };
}

export function setStoryAudience(a: StoryAudience) {
  data.me = { ...(data.me ?? {}), storyAudience: { mode: a.mode, ids: [...new Set(a.ids)] } };
  persist();
}

// ---- Notices (friend requests, invitations) -----------------------------------------------

/** True the first time an id is seen (and remembers it for 30 days). */
export function firstNotice(id: string): boolean {
  if (!data.notified) data.notified = {};
  const now = Date.now();
  for (const [k, at] of Object.entries(data.notified)) if (now - at > 30 * DAY) delete data.notified[k];
  if (data.notified[id]) return false;
  data.notified[id] = now;
  persist();
  return true;
}

// ---- Best friends --------------------------------------------------------------------

/** Contact scores halve every two weeks, so best friends follow who you talk to now. */
const HALF_LIFE_MS = 14 * DAY;

function decayed(c: { score: number; at: number }, now: number): number {
  return c.score * Math.pow(0.5, (now - c.at) / HALF_LIFE_MS);
}

/** Counts one exchange (moment, message, voice) with a friend. */
export function bumpContact(peerId: string, weight = 1) {
  if (!data.contacts) data.contacts = {};
  const now = Date.now();
  const c = data.contacts[peerId];
  data.contacts[peerId] = { score: (c ? decayed(c, now) : 0) + weight, at: now };
  persist();
}

/** When this device last exchanged anything with a peer (ms, 0 = never). Never sent anywhere. */
export function lastContactAt(peerId: string): number {
  return data.contacts?.[peerId]?.at ?? 0;
}

/** Up to `n` peers with the most contact recently (only among `candidates`). */
export function bestFriends(candidates: string[], n = 8): string[] {
  const now = Date.now();
  const set = new Set(candidates);
  return Object.entries(data.contacts ?? {})
    .filter(([id]) => set.has(id))
    .map(([id, c]) => [id, decayed(c, now)] as const)
    .filter(([, sc]) => sc >= 0.5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id]) => id);
}

/** Forgets everything about a peer (used when blocking). */
export async function forgetPeer(peerId: string) {
  for (const [k, s] of Object.entries(data.moments)) {
    if (s.peerId !== peerId) continue;
    delete data.moments[k];
    await releaseFile(s.file, k);
  }
  delete data.chats?.[peerId];
  delete data.contacts?.[peerId];
  delete data.birthdays?.[peerId];
  if (data.me?.bdSent) delete data.me.bdSent[peerId];
  persist();
}

/** Removes one entry and its local copy. */
export async function removeMoment(id: string, peerId: string) {
  const k = key(id, peerId);
  const s = data.moments[k];
  if (!s) return;
  delete data.moments[k];
  persist();
  await releaseFile(s.file, k);
}

export function upsertMoment(s: ChatMoment) {
  const k = key(s.id, s.peerId);
  const existing = data.moments[k];
  data.moments[k] = existing ? { ...existing, ...s } : s;
  persist();
}

export function updateMoment(id: string, peerId: string, patch: Partial<ChatMoment>): ChatMoment | undefined {
  const k = key(id, peerId);
  const existing = data.moments[k];
  if (!existing) return undefined;
  const next = { ...existing, ...patch };
  data.moments[k] = next;
  persist();
  return next;
}

/** Deletes a local copy unless another entry (group send) still uses it. */
async function releaseFile(path: string | undefined, exceptKey: string) {
  if (!path) return;
  const stillUsed = Object.entries(data.moments).some(([k, s]) => k !== exceptKey && s.file === path);
  if (!stillUsed) await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
}

export async function dropFile(id: string, peerId: string) {
  const k = key(id, peerId);
  const s = data.moments[k];
  if (!s?.file) return;
  const path = s.file;
  data.moments[k] = { ...s, file: undefined, eph: undefined, nonce: undefined, mk: undefined };
  persist();
  await releaseFile(path, k);
}

export function isSeen(x: string): boolean {
  return !!data.seen?.[x];
}

export function markSeen(x: string) {
  if (!data.seen) data.seen = {};
  data.seen[x] = Date.now();
  persist();
}

export function isText(s: ChatMoment): boolean {
  return s.kind === 'text';
}

/** Photo/video moment (entries from 2.0/2.1 have no kind). */
export function isMoment(s: ChatMoment): boolean {
  return !s.kind || s.kind === 'moment';
}

/** Messages that behave like chat lines: text, voice, system notes. */
export function isChatLine(s: ChatMoment): boolean {
  return s.kind === 'text' || s.kind === 'voice' || s.kind === 'system';
}

/**
 * Receiver: after the first view there is exactly ONE more view in total — the replay.
 * Saved moments are different: they stay visible in the chat (no replay needed).
 */
export function canReplay(s: ChatMoment): boolean {
  return isMoment(s) && !s.unsent && !s.saved && s.dir === 'in' && s.status === 'opened' && !!s.file;
}

/** Saved moments are shown in the chat and can be opened as often as wanted (both sides). */
export function canViewSaved(s: ChatMoment): boolean {
  return isMoment(s) && !s.unsent && s.saved && !!s.file;
}

// ---- "Delete after viewing" chats -----------------------------------------------------

let openChat: string | null = null;

/** The chat currently on screen (its messages are not purged while it is open). */
export function setOpenChat(peerId: string | null) {
  openChat = peerId;
}

function viewedAndDone(s: ChatMoment): boolean {
  if (s.saved) return false;
  if (s.kind === 'text' || s.kind === 'voice') return s.dir === 'in' ? !!s.readAt : !!s.peerReadAt;
  if (s.kind === 'system') return true;
  if (s.unsent) return true;
  // moments: once nothing can be viewed any more
  return s.status === 'replayed' || s.status === 'expired' || (s.status === 'opened' && !s.file);
}

/** In "delete after viewing" chats: removes everything that was seen (call when leaving the chat). */
export async function purgeViewed(peerId: string) {
  if (chatSettings(peerId).ttl !== 'viewed') return;
  let changed = false;
  for (const [k, s] of Object.entries(data.moments)) {
    if (s.peerId !== peerId || !viewedAndDone(s)) continue;
    delete data.moments[k];
    await releaseFile(s.file, k);
    changed = true;
  }
  if (changed) persist();
}

/**
 * Housekeeping: expires, drops replay copies whose window has passed, forgets old
 * unsaved history. `inboxIds` = ids currently pending on the server (null = unknown).
 */
export async function housekeeping(inboxIds: Set<string> | null) {
  const now = Date.now();
  // Replay ids only need to outlive the maximum message age (48 h) — keep 3 days.
  if (data.seen) {
    for (const [x, at] of Object.entries(data.seen)) if (now - at > 3 * DAY) delete data.seen[x];
  }
  for (const [k, s] of Object.entries(data.moments)) {
    const age = now - new Date(s.createdAt).getTime();
    const ttl = chatSettings(s.peerId).ttl;
    const life = ttlMs(ttl);
    if (s.peerId !== openChat && ttl === 'viewed' && viewedAndDone(s)) {
      delete data.moments[k];
      await releaseFile(s.file, k);
      continue;
    }
    // 6 h / 12 h chats: finished moments vanish from the history with the same timer.
    if (life < DAY && isMoment(s) && !s.saved && age > life && viewedAndDone(s)) {
      delete data.moments[k];
      await releaseFile(s.file, k);
      continue;
    }
    if (isChatLine(s) || s.unsent) {
      if (!s.saved && age > life) {
        delete data.moments[k];
        await releaseFile(s.file, k);
      }
      continue;
    }
    let next = s;

    if (s.status === 'pending') {
      if (s.dir === 'in' && inboxIds && !inboxIds.has(s.id) && age > 60_000) {
        next = { ...next, status: 'expired' };
      } else if (age > DAY + 10 * 60_000) {
        next = { ...next, status: 'expired' };
      }
    }

    // Copies not needed any more: not saved, and replay done / window over / expired.
    if (next.file && !next.saved) {
      const openedAge = next.openedAt ? now - new Date(next.openedAt).getTime() : 0;
      const needed =
        (next.status === 'pending' && next.dir === 'out') ||
        (next.status === 'opened' && openedAge < Math.min(REPLAY_WINDOW_MS, life));
      // (saved copies are kept: saved moments stay visible in the chat)
      if (!needed) {
        const path = next.file;
        next = { ...next, file: undefined, eph: undefined, nonce: undefined, mk: undefined };
        data.moments[k] = next;
        await releaseFile(path, k);
      }
    }

    if (!next.saved && age > HISTORY_MS) {
      delete data.moments[k];
      continue;
    }
    if (next !== s) data.moments[k] = next;
  }
  persist();
}

/** Removes everything (used on logout). */
export async function clearChatStore() {
  data = { v: 1, moments: {}, peerNames: {} };
  openChat = null;
  await AsyncStorage.removeItem(KEY).catch(() => {});
  await FileSystem.deleteAsync(MOMENT_DIR, { idempotent: true }).catch(() => {});
  await FileSystem.makeDirectoryAsync(MOMENT_DIR, { intermediates: true }).catch(() => {});
  version++;
  listeners.forEach((l) => l());
}

/** React hook: re-renders whenever the chat store changes. Returns a change counter. */
export function useChatStoreVersion(): number {
  return useSyncExternalStore(subscribe, getVersion);
}
