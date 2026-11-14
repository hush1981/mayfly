/**
 * Pulls the server inbox and the encrypted relay queue into the local chat store, and
 * sends chat events (opened / replayed / saved / unsaved / read / reactions / unsend /
 * chat settings), text messages and group chat messages end-to-end encrypted.
 *
 * Every relay payload goes through crypto/channel.ts: the ratchet (forward secrecy) for
 * friends that support it, otherwise the old static-key box. The server only learns
 * "A sent B a small blob", never what happened to which moment.
 *
 * Group chats are pairwise: a message to a group is encrypted separately for every
 * accepted member and carries the group id ("g") inside the ciphertext. Receivers only
 * accept it from accepted members of that group.
 */
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import nacl from 'tweetnacl';
import { getInbox, markViewed, unsendMedia } from '../api/media';
import { QueueFullError, TokenGoneError, sealedRelay, sealedUnsend } from '../api/sealed';
import { checkSealedProof, openSealedSender, sealSender } from '../crypto/sealedSender';
import {
  TOKEN_RE, acceptSealedProof, friendsNeedingToken, isBlockedLocally, markTokenSent, myToken, peerToken, setPeerToken,
} from '../store/deliveryTokens';
import { CallSignalType, handleCallEvent, isCallSignal } from '../calls/signals';
import { mentionedIds } from '../chat/mentions';
import { unsendGroupMedia } from '../api/groups';
import { listFriendRequests } from '../api/friends';
import { ackRelay, fetchRelay, sendRelay } from '../api/relay';
import { KeyChangedError, getPeerKey } from '../crypto/peerKeys';
import { loadPrivateKey } from '../crypto/keys';
import { Binding, bindingErrorText, checkBinding, newBinding } from '../crypto/sealed';
import { openFromPeer, sealFor } from '../crypto/channel';
import { flushSessions, needsHello, sessionHousekeeping } from '../crypto/sessions';
import { getUserId } from '../store/session';
import { getSecureJson, setSecureJson } from '../store/secureJson';
import {
  BIRTHDAY_RE, ChatMoment, ChatTtl, chatTtlMs, isChatTtl, REPLY_KINDS, ReplyRef, birthdaySentTo, birthdayToSend, bumpContact, chatSettings,
  dropFile, firstNotice, flushChatStore, getMoment, groupChatId, groupIdOf, housekeeping, isGroupChat, isSeen, isMoment,
  loadChatStore, markBirthdaySent, markSeen, peerName, setChatSettings, setPeerBirthday, updateMoment, upsertMoment,
} from '../store/chatStore';
import { groupInfo, groupInvites, isChatMember, otherMembers, refreshGroups, sharesGroupChat } from '../store/groupChats';
import { isFriend } from '../store/friendSet';
import { refreshSessionIfDue } from '../api/auth';
import { recordStoryView } from '../store/stories';
import { MediaItem } from '../types';
import { t } from '../i18n';

export type ChatEventType =
  | 'opened' | 'replayed' | 'saved' | 'unsaved' | 'read' | 'react' | 'unsend' | 'settings' | 'profile'
  | 'hello' | 'storyseen' | 'gmedia' | 'edit' | 'dtok' | CallSignalType;

interface ChatEvent {
  v: 1;
  t: ChatEventType | 'text';
  id: string;
  at: string;
  /** Text messages only. */
  b?: string;
  /** Text messages: what it answers. (Not "r": the sender binding uses "r" for the recipient.) */
  rp?: ReplyRef;
  /** 'read': the message ids that were read / listened to. */
  ids?: string[];
  /** 'react': the emoji ('' = reaction removed). */
  e?: string;
  /** 'settings': when unsaved messages disappear in this chat. */
  ttl?: ChatTtl;
  /** 'profile': birthday "MM-DD" the sender chose to share ('' = not shared any more). */
  bd?: string;
  /** Group chat id (group chats only). */
  g?: string;
  /** 'gmedia': key of the group media blob (base64 key ‖ nonce), media type, voice length. */
  k?: string;
  /** 'gmedia': SHA-256 (base64) of the blob, checked before it is opened (2.9+). */
  h?: string;
  mt?: 'image' | 'video' | 'audio';
  ms?: number;
  /** group texts: user ids mentioned with @ */
  mn?: string[];
  /** calls: video?, SDP, why it ended */
  cv?: boolean;
  sdp?: string;
  why?: string;
}

export const REACTIONS = ['❤️', '😂', '😮', '😢', '👍', '👎'];

export const MAX_TEXT_LEN = 1000;

/** Own text messages can be edited this long after sending. */
export const EDIT_WINDOW_MS = 15 * 60_000;

export function canEdit(s: ChatMoment): boolean {
  return s.dir === 'out' && s.kind === 'text' && !s.unsent && s.status !== 'pending'
    && Date.now() - new Date(s.createdAt).getTime() < EDIT_WINDOW_MS;
}

/** Changes the text of an own message (for everyone in the chat). */
export async function editText(s: ChatMoment, body: string) {
  const text = body.trim().slice(0, MAX_TEXT_LEN);
  if (!text || !canEdit(s) || text === s.text) return;
  updateMoment(s.id, s.peerId, { text, edited: true });
  await sendChatEvent(s.peerId, 'edit', s.id, { b: text });
}

const OUTBOX_KEY = 'mayfly_relay_outbox_v1';

/** Events that wake the recipient's phone; receipts etc. arrive with the next sync. */
const WAKES = new Set(['text', 'gmedia', 'call', 'gcall']);

/** Wire-level delivery to one person. */
async function deliver(peerId: string, ev: ChatEvent, opts: { hello?: boolean } = {}): Promise<void> {
  const myId = await getUserId();
  if (!myId) throw new Error('not logged in');
  // Authenticated: bound to sender/recipient/time/id (and, with the ratchet, forward secret).
  const peerKey = await getPeerKey(peerId);
  const sealed = await sealFor(peerId, { ...ev, ...newBinding(myId, peerId) }, { hello: opts.hello, peerKey });
  const notify = WAKES.has(ev.t);
  // Sealed sender: with the friend's delivery token the server does not learn that it is from me.
  const tok = await peerToken(peerId);
  if (tok) {
    const outer = sealSender(peerKey, { v: 1, f: myId, n: sealed.fs ? undefined : sealed.nonce }, sealed.bytes, await loadPrivateKey());
    try {
      await sealedRelay(tok, encodeBase64(outer), notify);
      return;
    } catch (e) {
      if (e instanceof TokenGoneError) {
        await setPeerToken(peerId, null); // they changed it: normal delivery, the new one will come
      } else if (!(e instanceof QueueFullError)) {
        throw e;
      }
      // QueueFullError: the shared sealed queue of this friend is full (somebody may be
      // flooding it) — this message goes the logged-in way, the token stays.
    }
  }
  await sendRelay(peerId, sealed.eph, sealed.nonce, encodeBase64(sealed.bytes), notify);
}

/** Low-level send of one event to one person (used by calls). Not queued. */
export async function deliverNow(peerId: string, ev: Omit<ChatEvent, 'v' | 'at'> & { at?: string }) {
  await deliver(peerId, { v: 1, at: new Date().toISOString(), ...ev } as ChatEvent);
}

/**
 * Sealed sender: friends that do not have my current delivery token get it (end-to-end
 * encrypted). Registers the token with the server first.
 */
export async function syncDeliveryTokens(friendIds: string[]) {
  let tok: string;
  try { tok = await myToken(); } catch { return; } // server without sealed sender (old version)
  for (const id of await friendsNeedingToken(friendIds)) {
    try {
      const key = await getPeerKey(id); // (the key the token is encrypted to)
      await deliver(id, { v: 1, t: 'dtok', id: newId(), at: new Date().toISOString(), k: tok });
      await markTokenSent(id, tok, key);
    } catch (_) {}
  }
}

interface Pending { peerId: string; ev: ChatEvent }

export function newId(): string {
  const b = nacl.randomBytes(16);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function readOutbox(): Promise<Pending[]> {
  try {
    return (await getSecureJson<Pending[]>(OUTBOX_KEY)) ?? [];
  } catch {
    return [];
  }
}

async function writeOutbox(box: Pending[]): Promise<void> {
  await setSecureJson(OUTBOX_KEY, box);
}

async function enqueue(items: Pending[]) {
  if (items.length === 0) return;
  const box = await readOutbox();
  box.push(...items);
  await writeOutbox(box.slice(-400));
}

/**
 * Sends one event to the people of a chat: the friend, or every accepted member of a group
 * chat (`only` limits it, e.g. receipts go to the author only). Failures are queued.
 * Returns how many deliveries succeeded right away.
 */
async function sendToChat(chatId: string, ev: ChatEvent, only?: string[]): Promise<number> {
  let targets: string[];
  if (isGroupChat(chatId)) {
    const me = await getUserId();
    const gid = groupIdOf(chatId);
    ev = { ...ev, g: gid };
    targets = otherMembers(gid, me ?? '').map((m) => m.id);
    if (only) targets = targets.filter((id) => only.includes(id));
  } else {
    targets = [chatId];
  }
  let ok = 0;
  const failed: Pending[] = [];
  for (const peerId of targets) {
    try {
      await deliver(peerId, ev);
      ok++;
    } catch {
      failed.push({ peerId, ev });
    }
  }
  await enqueue(failed);
  return ok;
}

/**
 * Sends a text message (to a friend or a group chat). It is stored locally right away
 * (status 'pending' until the server accepted it) and retried from the outbox if the
 * network is down.
 */
export async function sendText(chatId: string, chatName: string, body: string, replyTo?: ReplyRef): Promise<void> {
  const text = body.trim().slice(0, MAX_TEXT_LEN);
  if (!text) return;
  await loadChatStore();
  const ev: ChatEvent = { v: 1, t: 'text', id: newId(), at: new Date().toISOString(), b: text, rp: replyTo };
  if (isGroupChat(chatId)) {
    const gi = groupInfo(groupIdOf(chatId));
    const mn = gi ? mentionedIds(text, gi.members.filter((m) => m.status === 'member')) : [];
    if (mn.length) ev.mn = mn;
  }
  upsertMoment({
    kind: 'text', id: ev.id, peerId: chatId, peerName: chatName, dir: 'out', mediaType: 'image',
    createdAt: ev.at, status: 'pending', saved: false, text, replyTo,
  });
  bumpContact(chatId);
  const ok = await sendToChat(chatId, ev);
  if (ok > 0 || isGroupChat(chatId)) updateMoment(ev.id, chatId, { status: 'opened' }); // 'opened' = handed to the server
}

/** Sends a chat event to a friend or a group chat; queues it for retry if the server is unreachable. */
export async function sendChatEvent(chatId: string, type: ChatEventType, momentId: string, extra?: Partial<ChatEvent>, only?: string[]) {
  const ev: ChatEvent = { v: 1, t: type, id: momentId, at: new Date().toISOString(), ...extra };
  await sendToChat(chatId, ev, only);
}

/** Receipt about something in a chat: in a group chat only its author needs to know. */
export function sendReceipt(s: ChatMoment, type: 'opened' | 'replayed') {
  if (isGroupChat(s.peerId)) {
    if (s.from) sendChatEvent(s.peerId, type, s.id, undefined, [s.from]);
  } else {
    sendChatEvent(s.peerId, type, s.id);
  }
}

/** Tells the members of a group chat about a new group media blob (key inside, end-to-end). */
export async function announceGroupMedia(
  groupId: string, mediaId: string, key: string, h: string, mt: 'image' | 'video' | 'audio', ms?: number, rp?: ReplyRef,
) {
  await sendChatEvent(groupChatId(groupId), 'gmedia', mediaId, { k: key, h, mt, ms, rp });
}

/** Story viewers tell the owner that they watched (shown in "My story"). */
export function sendStorySeen(ownerId: string, storyId: string) {
  sendChatEvent(ownerId, 'storyseen', storyId).catch(() => {});
}

/** Short preview of a message for reply quotes. */
export function quoteOf(s: ChatMoment): ReplyRef {
  const k = s.kind === 'text' ? 'text' : s.kind === 'voice' ? 'voice' : 'moment';
  const q = k === 'text' ? (s.text ?? '').replace(/\s+/g, ' ').slice(0, 80)
    : k === 'voice' ? t('Voice message')
    : s.mediaType === 'video' ? t('Video') : t('Photo');
  return { id: s.id, q, k };
}

/** Marks incoming texts / voice messages as read and tells the sender (not in group chats). */
export function markRead(chatId: string, items: ChatMoment[]) {
  const now = new Date().toISOString();
  const ids: string[] = [];
  for (const s of items) {
    if (s.dir !== 'in' || s.readAt || s.unsent) continue;
    if (s.kind === 'text' || (s.kind === 'voice' && s.status !== 'pending')) {
      updateMoment(s.id, s.peerId, { readAt: now });
      if (!s.id.startsWith('legacy-')) ids.push(s.id);
    }
  }
  if (ids.length > 0 && !isGroupChat(chatId)) sendChatEvent(chatId, 'read', newId(), { ids: ids.slice(0, 100) });
}

/** Sets (or clears, with the same emoji again) my reaction to a message or moment. */
export function react(s: ChatMoment, emoji: string) {
  const e = s.myReaction === emoji ? '' : emoji;
  updateMoment(s.id, s.peerId, { myReaction: e || undefined });
  sendChatEvent(s.peerId, 'react', s.id, { e });
}

/**
 * Takes back something I sent. Moments / voice messages that were not opened yet are also
 * deleted from the server; the peer's app removes its copy. It may already have been seen.
 */
export async function unsend(s: ChatMoment) {
  if (s.dir !== 'out') return;
  if (s.kind !== 'text') {
    if (isGroupChat(s.peerId)) await unsendGroupMedia(s.id).catch(() => {});
    else if (s.status === 'pending' && s.ut) await sealedUnsend(s.id, s.ut).catch(() => {});
    else if (s.status === 'pending') await unsendMedia(s.id).catch(() => {});
  }
  updateMoment(s.id, s.peerId, { unsent: true, text: undefined, replyTo: undefined, saved: false });
  await dropFile(s.id, s.peerId);
  await sendChatEvent(s.peerId, 'unsend', s.id);
}

function ttlNote(who: string, ttl: ChatTtl): string {
  switch (ttl) {
    case 'viewed': return t('{name} set messages to disappear after viewing', { name: who });
    case '6h': return t('{name} set messages to disappear 6 hours after sending', { name: who });
    case '12h': return t('{name} set messages to disappear 12 hours after sending', { name: who });
    default: return t('{name} set messages to disappear 24 hours after sending', { name: who });
  }
}

export function systemLine(chatId: string, text: string, at: string) {
  const id = 'sys-' + newId();
  upsertMoment({
    kind: 'system', id, peerId: chatId, peerName: peerName(chatId) ?? '', dir: 'in', mediaType: 'image',
    createdAt: at, status: 'opened', saved: false, text,
  });
}

/** Changes when unsaved messages disappear in a chat — for both sides (group chats: for everyone). */
export async function setChatTtl(peerId: string, ttl: ChatTtl) {
  if ((chatSettings(peerId).ttl ?? 'day') === ttl) return;
  if (ttl === 'viewed' && isGroupChat(peerId)) return; // needs read receipts, which groups don't use
  setChatSettings(peerId, { ttl });
  systemLine(peerId, ttlNote(t('You'), ttl), new Date().toISOString());
  await sendChatEvent(peerId, 'settings', newId(), { ttl });
}

/**
 * Opt-in birthday: tells each friend the current value (or that it is no longer shared)
 * once, end-to-end encrypted. Also catches up friends added later.
 */
export async function syncBirthday(friendIds: string[]) {
  await loadChatStore();
  const want = birthdayToSend();
  for (const id of friendIds) {
    if (birthdaySentTo(id) === want) continue;
    try {
      await deliver(id, { v: 1, t: 'profile', id: newId(), at: new Date().toISOString(), bd: want });
      markBirthdaySent(id, want);
    } catch (_) {
      // try again with the next sync
    }
  }
}

/**
 * Forward-secrecy handshake: friends (and group co-members) we have no ratchet message from
 * yet get a content-free "hello" in a new session, at most every 12 hours. Friends on old
 * versions simply drop it; newer ones answer, and from then on everything is forward secret.
 */
export async function sendHellos(peerIds: string[]) {
  for (const id of peerIds) {
    try {
      if (!(await needsHello(id))) continue;
      await deliver(id, { v: 1, t: 'hello', id: newId(), at: new Date().toISOString() }, { hello: true });
    } catch (_) {}
  }
}

function validReply(r: unknown): ReplyRef | undefined {
  const x = r as ReplyRef | undefined;
  if (!x || typeof x.id !== 'string' || x.id.length > 64 || typeof x.q !== 'string') return undefined;
  if (!REPLY_KINDS.includes(x.k)) return undefined;
  return { id: x.id, q: x.q.slice(0, 120), k: x.k };
}

async function flushOutbox() {
  const box = await readOutbox();
  if (box.length === 0) return;
  const failed: Pending[] = [];
  for (const p of box) {
    // Unsent texts older than their lifetime are dropped instead of delivered late.
    const chat = p.ev.g ? groupChatId(p.ev.g) : p.peerId;
    if (p.ev.t === 'text' && Date.now() - new Date(p.ev.at).getTime() > chatTtlMs(chat)) continue;
    try {
      await deliver(p.peerId, p.ev);
      if (p.ev.t === 'text' && !p.ev.g) updateMoment(p.ev.id, p.peerId, { status: 'opened' });
    } catch {
      failed.push(p);
    }
  }
  await writeOutbox(failed);
}

function validMediaType(x: unknown): x is 'image' | 'video' | 'audio' {
  return x === 'image' || x === 'video' || x === 'audio';
}

/**
 * Applies one event. `chatId` = the friend (1:1) or "g:<group>" (group chat); `from` = the
 * user who sent it (already checked to be the friend / an accepted member).
 */
async function applyEvent(chatId: string, from: string, ev: ChatEvent, serverTime: string, fresh: ChatMoment[]) {
  const group = isGroupChat(chatId);
  if (ev.t === 'hello') return; // the ratchet already did its work
  if (ev.t === 'text') {
    if (typeof ev.b !== 'string' || getMoment(ev.id, chatId)) return;
    // Server time, not the sender's clock, decides when the 24 h start.
    const msg: ChatMoment = {
      kind: 'text', id: ev.id, peerId: chatId, peerName: peerName(chatId) ?? 'Someone',
      dir: 'in', mediaType: 'image', createdAt: serverTime, status: 'opened', saved: false,
      text: ev.b.slice(0, MAX_TEXT_LEN), replyTo: validReply(ev.rp), from: group ? from : undefined,
      mentionsMe: group && Array.isArray(ev.mn) && !!myIdCache && ev.mn.includes(myIdCache) ? true : undefined,
    };
    upsertMoment(msg);
    bumpContact(chatId);
    fresh.push(msg);
    return;
  }
  if (ev.t === 'gmedia') {
    if (!group || typeof ev.k !== 'string' || !validMediaType(ev.mt) || getMoment(ev.id, chatId)) return;
    if (ev.h !== undefined && (typeof ev.h !== 'string' || ev.h.length > 64)) return;
    if (!/^[0-9a-f-]{36}$/.test(ev.id)) return;
    const s: ChatMoment = {
      kind: ev.mt === 'audio' ? 'voice' : 'moment', id: ev.id, peerId: chatId, peerName: peerName(chatId) ?? '',
      dir: 'in', mediaType: ev.mt, createdAt: serverTime, status: 'pending', saved: false, mk: ev.k, bh: ev.h, from,
      voiceMs: typeof ev.ms === 'number' && ev.ms > 0 ? Math.min(ev.ms, 10 * 60_000) : undefined,
      replyTo: validReply(ev.rp),
    };
    upsertMoment(s);
    bumpContact(chatId);
    fresh.push(s);
    return;
  }
  if (ev.t === 'dtok') {
    if (!group && typeof ev.k === 'string' && TOKEN_RE.test(ev.k)) await setPeerToken(from, ev.k);
    return;
  }
  if (isCallSignal(ev.t)) {
    handleCallEvent(chatId, from, ev as any, serverTime);
    return;
  }
  if (ev.t === 'storyseen') {
    if (!group) recordStoryView(ev.id, from, ev.at);
    return;
  }
  if (ev.t === 'read') {
    if (group) return;
    for (const id of Array.isArray(ev.ids) ? ev.ids.slice(0, 100) : []) {
      const s = typeof id === 'string' ? getMoment(id, chatId) : undefined;
      if (s && s.dir === 'out' && !s.peerReadAt) updateMoment(s.id, s.peerId, { peerReadAt: ev.at });
    }
    return;
  }
  if (ev.t === 'profile') {
    if (!group && typeof ev.bd === 'string' && (ev.bd === '' || BIRTHDAY_RE.test(ev.bd))) setPeerBirthday(from, ev.bd);
    return;
  }
  if (ev.t === 'settings') {
    if (!isChatTtl(ev.ttl) || (group && ev.ttl === 'viewed')) return;
    if ((chatSettings(chatId).ttl ?? 'day') !== ev.ttl) {
      setChatSettings(chatId, { ttl: ev.ttl });
      systemLine(chatId, ttlNote(peerName(from) ?? t('Your friend'), ev.ttl), serverTime);
    }
    return;
  }
  const s = getMoment(ev.id, chatId);
  if (!s) return; // unknown moment, or event from someone who wasn't its peer
  // Who wrote it: me ('out'), or the friend / the group member in `from`.
  const author = s.dir === 'out' ? 'me' : group ? s.from : chatId;
  switch (ev.t) {
    case 'edit': {
      // Only the author, only texts, only shortly after sending (some slack for clocks / delivery).
      const late = Date.parse(ev.at) - new Date(s.createdAt).getTime() > EDIT_WINDOW_MS + 10 * 60_000;
      if (s.dir === 'in' && s.kind === 'text' && !s.unsent && author === from && typeof ev.b === 'string' && ev.b.trim() && !late) {
        updateMoment(s.id, s.peerId, { text: ev.b.slice(0, MAX_TEXT_LEN), edited: true });
      }
      break;
    }
    case 'react':
      if (typeof ev.e !== 'string' || ev.e.length > 16) break;
      if (group) {
        const r = { ...(s.reactions ?? {}) };
        if (ev.e) r[from] = ev.e; else delete r[from];
        updateMoment(s.id, s.peerId, { reactions: r });
      } else {
        updateMoment(s.id, s.peerId, { peerReaction: ev.e || undefined });
      }
      break;
    case 'unsend':
      if (s.dir === 'in' && author === from) {
        updateMoment(s.id, s.peerId, { unsent: true, text: undefined, replyTo: undefined, saved: false });
        await dropFile(s.id, s.peerId);
      }
      break;
    case 'opened':
      if (s.dir !== 'out') break;
      if (group) {
        updateMoment(s.id, s.peerId, {
          openedBy: { ...(s.openedBy ?? {}), [from]: ev.at }, status: 'opened', openedAt: s.openedAt ?? ev.at,
        });
      } else if (s.status === 'pending') {
        updateMoment(s.id, s.peerId, { status: 'opened', openedAt: ev.at });
      }
      break;
    case 'replayed':
      if (s.dir === 'out' && isMoment(s) && !group) {
        updateMoment(s.id, s.peerId, { status: 'replayed', replayedAt: ev.at, openedAt: s.openedAt ?? ev.at });
        if (!s.saved) await dropFile(s.id, s.peerId);
      }
      break;
    case 'saved':
      // In group chats one member saving keeps it for everybody.
      if (!s.saved) {
        updateMoment(s.id, s.peerId, { saved: true });
        if (group) systemLine(chatId, t('{name} saved a message for everyone', { name: peerName(from) ?? '?' }), serverTime);
      }
      break;
    case 'unsaved':
      updateMoment(s.id, s.peerId, { saved: false });
      break;
  }
}

/** Shows a visible note instead of silently dropping a message from an outdated client. */
function rejectedLegacy(peerId: string, relayId: string, at: string, fresh: ChatMoment[]) {
  if (getMoment('legacy-' + relayId, peerId)) return;
  const note: ChatMoment = {
    kind: 'text', id: 'legacy-' + relayId, peerId, peerName: peerName(peerId) ?? 'Someone', dir: 'in',
    mediaType: 'image', createdAt: at, status: 'opened', saved: false,
    text: '⚠ ' + t(bindingErrorText('missing')),
  };
  upsertMoment(note);
  fresh.push(note);
}

function inboxToMoment(item: MediaItem): ChatMoment {
  return {
    kind: item.media_type === 'audio' ? 'voice' : 'moment',
    id: item.id,
    peerId: item.sender_id,
    peerName: item.sender_username,
    dir: 'in',
    mediaType: item.media_type,
    groupName: item.group_name ?? undefined,
    createdAt: item.created_at,
    status: 'pending',
    saved: false,
  };
}

let running: Promise<SyncResult> | null = null;

export interface SyncResult {
  newIncoming: ChatMoment[];
  /** Ready-made notification texts (friend requests, group invitations). */
  notices: string[];
}

/** One sync round. Concurrent callers share the same run. */
export function syncNow(): Promise<SyncResult> {
  if (!running) {
    running = doSync().finally(() => { running = null; });
  }
  return running;
}

let myIdCache: string | null = null;

async function doSync(): Promise<SyncResult> {
  await loadChatStore();
  const newIncoming: ChatMoment[] = [];
  const notices: string[] = [];
  const myId = await getUserId();
  myIdCache = myId;

  await refreshSessionIfDue().catch(() => {});
  try { await refreshGroups(); } catch (_) {}

  let inboxIds: Set<string> | null = null;
  try {
    const inbox = await getInbox();
    inboxIds = new Set(inbox.map((i) => i.id));
    let secret: Uint8Array | null = null;
    for (const item of inbox) {
      let sender = item.sender_id;
      if (!sender) {
        // sealed sender: who sent it is in the encrypted header
        secret = secret ?? await loadPrivateKey();
        const env = item.sealed_header ? decodeBase64(item.sealed_header) : null;
        const o = env ? openSealedSender(env, secret) : null;
        if (!o || o.header.f === myId || (await isBlockedLocally(o.header.f))) {
          markViewed(item.id).catch(() => {}); // unreadable or from someone blocked: delete it
          continue;
        }
        // Moments only come from friends (the server checks that for logged-in senders; with a
        // delivery token the app has to).
        const friend = await isFriend(o.header.f);
        if (friend === null) continue; // cannot tell right now: look again with the next sync
        if (!friend) {
          markViewed(item.id).catch(() => {});
          continue;
        }
        // The moment itself is checked when it is opened, but the entry and the notification
        // already name the sender: it must be proven now (anybody holding my delivery token
        // could otherwise claim to be another friend).
        let senderKey: string;
        try {
          senderKey = await getPeerKey(o.header.f);
        } catch (_) {
          continue; // key change pending or offline: decide with a later sync (24 h on the server)
        }
        if (!(await acceptSealedProof(o.header.f, checkSealedProof(env!, o.header, secret, senderKey)))) {
          markViewed(item.id).catch(() => {}); // forged sender: delete it
          continue;
        }
        sender = o.header.f;
      }
      const existing = getMoment(item.id, sender);
      if (!existing) {
        const s = inboxToMoment({ ...item, sender_id: sender, sender_username: item.sender_username || (peerName(sender) ?? '?') });
        upsertMoment(s);
        bumpContact(sender);
        newIncoming.push(s);
      }
    }
  } catch (_) {}

  const answer = new Set<string>(); // friends that started a session: answer with a hello
  try {
    const msgs = await fetchRelay();
    if (msgs.length > 0 && myId) {
      const secret = await loadPrivateKey();
      const keys = new Map<string, string>();
      const held = new Set<string>(); // senders whose messages stay on the server for now
      const contacts = new Map<string, boolean>(); // sender → true: friend, false: group member only
      const done: string[] = [];
      for (const m of msgs) {
        // Sealed sender: the server does not know who it is from — the outer box says it,
        // the inner message (opened with that friend's key / session) proves it.
        let sender = m.sender_id;
        let bytes = decodeBase64(m.payload);
        let nonce = m.nonce;
        if (!sender) {
          const o = openSealedSender(bytes, secret);
          if (!o || o.header.f === myId || (await isBlockedLocally(o.header.f))) { done.push(m.id); continue; }
          // (the inner message proves the sender anyway; a wrong proof is dropped early, a
          // correct one marks the friend so a stripped proof is refused from now on)
          if (!held.has(o.header.f)) {
            let k: string | null = null;
            try { k = await getPeerKey(o.header.f); } catch (_) {} // (key change: handled below)
            if (k && !(await acceptSealedProof(o.header.f, checkSealedProof(bytes, o.header, secret, k)))) {
              done.push(m.id);
              continue;
            }
          }
          sender = o.header.f;
          bytes = o.inner;
          nonce = o.header.n ?? '';
        }
        if (held.has(sender)) continue;
        // Who may write to me: friends (anything), and members of a group chat we share
        // (only inside that group, plus the key handshake). Decided before decrypting — a
        // ratchet message can be opened only once, so "decide later" is not possible.
        let direct = contacts.get(sender);
        if (direct === undefined) {
          const friend = await isFriend(sender);
          if (friend) direct = true;
          else if (await sharesGroupChat(sender)) direct = false;
          else if (friend === null) { held.add(sender); continue; } // offline: decide next time
          else { done.push(m.id); continue; } // neither friend nor group member: dropped
          contacts.set(sender, direct);
        }
        try {
          let peerKey = keys.get(sender);
          if (!peerKey) {
            try {
              peerKey = await getPeerKey(sender);
            } catch (e: any) {
              // Leave the messages on the server (24 h): until the new key is accepted, or
              // because the key could not be fetched right now (network, rate limit).
              // Only a clear "not your contact (any more)" from the server drops them.
              if (e instanceof KeyChangedError || (e?.status !== 403 && e?.status !== 404)) {
                held.add(sender);
                continue;
              }
              throw e;
            }
            keys.set(sender, peerKey);
          }
          const opened = await openFromPeer<ChatEvent & Partial<Binding>>(sender, myId, bytes, {
            nonce: nonce || undefined, promote: true, peerKey,
          });
          if (opened) {
            if (opened.answer) answer.add(sender);
            const ev = opened.obj;
            const err = checkBinding(ev, sender, myId, isSeen);
            if (!err && ev?.v === 1 && typeof ev.id === 'string' && ev.id.length <= 64) {
              markSeen(ev.x!);
              if (typeof ev.g === 'string') {
                if (await isChatMember(ev.g, sender)) {
                  await applyEvent(groupChatId(ev.g), sender, ev, m.created_at, newIncoming);
                }
              } else if (direct) {
                await applyEvent(sender, sender, ev, m.created_at, newIncoming);
              }
              // (a group member who is not a friend: nothing outside the group is accepted)
            }
          } else if (direct && m.sender_id && nonce && m.ephemeral_public_key
            && nacl.box.open(bytes, decodeBase64(nonce), decodeBase64(m.ephemeral_public_key), secret)) {
            // Old client (≤ 2.2): readable but the sender is not proven — reject, but say so.
            rejectedLegacy(sender, m.id, m.created_at, newIncoming);
          }
        } catch (_) {}
        done.push(m.id); // undecryptable / rejected messages are dropped as well
      }
      // Nothing is acknowledged before the chat and the ratchet state are on disk.
      await flushChatStore();
      await flushSessions();
      await ackRelay(done);
    }
  } catch (_) {}

  for (const id of answer) {
    deliver(id, { v: 1, t: 'hello', id: newId(), at: new Date().toISOString() }).catch(() => {});
  }

  await flushOutbox().catch(() => {});
  await housekeeping(inboxIds);
  await sessionHousekeeping().catch(() => {});

  // Friend requests and group invitations: notify once each.
  try {
    for (const r of await listFriendRequests()) {
      if (firstNotice('fr:' + r.id)) notices.push(t('{name} wants to be your friend', { name: r.requester.username }));
    }
  } catch (_) {}
  for (const g of groupInvites()) {
    if (firstNotice('gi:' + g.id)) {
      const by = g.invitedBy ? peerName(g.invitedBy) : undefined;
      notices.push(by ? t('{name} invited you to the group “{group}”', { name: by, group: g.name })
        : t('You were invited to the group “{group}”', { group: g.name }));
    }
  }
  return { newIncoming, notices };
}

export function displayName(s: ChatMoment): string {
  if (isGroupChat(s.peerId)) return groupInfo(groupIdOf(s.peerId))?.name ?? s.peerName;
  return peerName(s.peerId) ?? s.peerName;
}

/** Name of the author of an entry (group chats: the member who wrote it). */
export function authorName(s: ChatMoment): string {
  if (s.dir === 'out') return t('You');
  if (isGroupChat(s.peerId)) return (s.from && peerName(s.from)) || '?';
  return peerName(s.peerId) ?? s.peerName;
}
