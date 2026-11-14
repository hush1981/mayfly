/**
 * Voice and video calls over WebRTC: 1:1 and group calls (mesh, up to 8 people).
 *
 * Media goes peer-to-peer, encrypted with DTLS-SRTP. Offers / answers (which carry the DTLS
 * fingerprints) travel end-to-end encrypted through the relay (sealed sender where possible),
 * so the server can neither read nor swap them — it cannot sit in the middle. By default calls
 * only use the server's TURN relay ("hide my IP"), so nobody learns my IP address; the relay
 * itself only sees encrypted packets.
 *
 * No trickle ICE: an SDP is sent once, after candidate gathering (relay candidates come within a
 * second), so a connection needs just two messages.
 *
 * 1:1 protocol: call (offer) → callans (answer) | callend.
 * Group protocol (events carry the group id "g", pairwise to every accepted member):
 *   gcall  — someone starts a call (rings everybody; no SDP)
 *   gjoin  — I joined (to all members, so everyone knows who is in the call)
 *   ghere  — "I am in the call" (to one joiner)
 *   goffer / gans — SDP between two participants; for every pair the one with the smaller
 *                   user id makes the offer, so two peers never offer to each other
 *   gleave — I left (to all members); when nobody is left the call is over
 */
import { AppState, NativeEventEmitter, NativeModules } from 'react-native';
import {
  MediaStream, RTCPeerConnection, RTCSessionDescription, mediaDevices,
} from 'react-native-webrtc';
import { useSyncExternalStore } from 'react';
import { getIceConfig } from '../api/calls';
import { waitForRelay } from '../api/relay';
import { navRef } from '../navigation/ref';
import {
  callsHideIp, groupChatId, groupIdOf, isGroupChat, isMuted, loadChatStore, peerName,
} from '../store/chatStore';
import { groupInfo, otherMembers } from '../store/groupChats';
import { getUserId } from '../store/session';
import { deliverNow, newId, sendChatEvent, syncNow, systemLine } from '../sync/sync';
import { CallSignal, setCallHandler } from './signals';
import { t } from '../i18n';

const Native = NativeModules.MfCall as
  | {
      startRinging(): void; stopRinging(): void;
      showIncoming(id: string, title: string, text: string, answer: string, decline: string): void;
      cancelIncoming(): void;
      startCall(title: string, video: boolean, speaker: boolean): void;
      setSpeaker(on: boolean, video: boolean): void;
      endCall(): void;
      takeLaunchAction(): Promise<{ action: string; callId: string } | null>;
      relock?(): void;
      isDeviceLocked?(): Promise<boolean>;
    }
  | undefined;

/**
 * Only the call screen may be visible on a locked phone (an incoming call shows over the
 * lock screen). Called whenever another screen comes up: the app goes back behind the lock.
 */
export function relockUnlessOnCall(routeName: string | undefined) {
  if (routeName !== 'Call') Native?.relock?.();
}

/** True while the phone is locked (then the call screen must not be left). */
export async function deviceLocked(): Promise<boolean> {
  try { return !!(await Native?.isDeviceLocked?.()); } catch { return false; }
}

const RING_MS = 45_000;
/** Offers / invitations older than this (server time) are not rung any more. */
const OFFER_MAX_AGE_MS = 40_000;
/** Group signals older than this are stale (e.g. retried from an outbox). gleave always counts. */
const GROUP_SIGNAL_MAX_AGE_MS = 120_000;
/** Mesh: every participant connects to every other one. */
export const MAX_GROUP_CALL = 8;

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'connected' | 'ended';

export interface CallPeer {
  id: string;
  name: string;
  url?: string;
  connected: boolean;
}

export interface CallState {
  phase: CallPhase;
  id?: string;
  /** 1:1: the friend; group call: who rang me (incoming) */
  peerId?: string;
  peerName?: string;
  /** group calls: the group id */
  group?: string;
  groupName?: string;
  /** group calls: the other participants I am connected (or connecting) to */
  peers: CallPeer[];
  video: boolean;
  dir?: 'in' | 'out';
  connectedAt?: number;
  muted: boolean;
  speaker: boolean;
  camOff: boolean;
  front: boolean;
  localUrl?: string;
  remoteUrl?: string;
  endReason?: string;
}

const IDLE: CallState = { phase: 'idle', video: false, muted: false, speaker: false, camOff: false, front: true, peers: [] };
let state: CallState = IDLE;
let version = 0;
const listeners = new Set<() => void>();

interface Link { pc: RTCPeerConnection; url?: string; connected: boolean; everConnected: boolean }
/** One peer connection per other participant (1:1: exactly one). */
const links = new Map<string, Link>();
let local: MediaStream | null = null;
let pendingOffer: { sdp: string; at: number } | null = null;
let ringTimer: ReturnType<typeof setTimeout> | null = null;
let aloneTimer: ReturnType<typeof setTimeout> | null = null;
let polling = false;
let ice: { iceServers: any[] } | null = null;
let myId: string | null = null;

/** Group calls I know of (also ones I am not in): group id → call id, who is in it. */
interface KnownGroupCall { id: string; cv: boolean; members: Set<string>; at: number }
const groupCalls = new Map<string, KnownGroupCall>();

function emit() {
  version++;
  listeners.forEach((l) => l());
}

function set(patch: Partial<CallState>) {
  state = { ...state, ...patch };
  emit();
}

function syncPeers() {
  if (!state.group) return;
  const peers: CallPeer[] = Array.from(links.entries()).map(([id, l]) => ({ id, name: name(id), url: l.url, connected: l.connected }));
  const connected = peers.some((p) => p.connected);
  set({
    peers,
    phase: state.phase === 'outgoing' && !connected ? 'outgoing' : connected ? 'connected' : state.phase === 'outgoing' ? 'outgoing' : 'connecting',
    connectedAt: state.connectedAt ?? (connected ? Date.now() : undefined),
  });
}

export function getCall(): CallState {
  return state;
}

export function useCall(): CallState {
  useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => version);
  return state;
}

/** An ongoing group call in this group that I am not part of (to show "Join"). */
export function useOngoingGroupCall(groupId: string): { id: string; count: number; video: boolean } | null {
  useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => version);
  const g = groupCalls.get(groupId);
  if (!g || g.members.size === 0 || (state.group === groupId && busy())) return null;
  return { id: g.id, count: g.members.size, video: g.cv };
}

function busy(): boolean {
  return state.phase !== 'idle' && state.phase !== 'ended';
}

function name(peerId: string): string {
  return peerName(peerId) ?? '?';
}

function duration(): string {
  if (!state.connectedAt) return '';
  const s = Math.round((Date.now() - state.connectedAt) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** While a call is being set up (or people may still join) the relay is long-polled. */
async function pollSignals() {
  if (polling) return;
  polling = true;
  try {
    while (busy()) {
      const fast = state.phase !== 'connected' || !!state.group;
      try {
        if (fast) await waitForRelay(10);
        else await new Promise((r) => setTimeout(r, 4000));
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (!busy()) break;
      await syncNow().catch(() => {});
    }
  } finally {
    polling = false;
  }
}

async function iceConfig() {
  if (ice) return ice;
  const cfg = await getIceConfig();
  if (!cfg.relay || cfg.ice_servers.length === 0) {
    throw new Error(t('This Mayfly server has no call relay (TURN), so calls are not available.'));
  }
  ice = { iceServers: cfg.ice_servers.map((s) => ({ urls: s.urls, username: s.username, credential: s.credential })) };
  return ice;
}

async function openMedia(video: boolean) {
  local = await mediaDevices.getUserMedia({
    audio: true,
    video: video ? { facingMode: 'user', frameRate: 24, width: 640, height: 480 } : false,
  }) as MediaStream;
  set({ localUrl: video ? local.toURL() : undefined });
}

/** Creates the peer connection to one participant (replacing an old one). */
async function connect(peerId: string): Promise<RTCPeerConnection> {
  const cfg = await iceConfig();
  const old = links.get(peerId);
  if (old) { try { old.pc.close(); } catch (_) {} }
  const conn = new RTCPeerConnection({
    iceServers: cfg.iceServers,
    iceTransportPolicy: callsHideIp() ? 'relay' : 'all',
    bundlePolicy: 'max-bundle',
  });
  const link: Link = { pc: conn, connected: false, everConnected: false };
  links.set(peerId, link);
  (conn as any).addEventListener('track', (e: any) => {
    const s = e.streams?.[0];
    if (!s || links.get(peerId) !== link) return;
    link.url = s.toURL();
    if (state.group) syncPeers(); else set({ remoteUrl: link.url });
  });
  (conn as any).addEventListener('connectionstatechange', () => {
    if (links.get(peerId) !== link) return;
    const cs = conn.connectionState;
    if (cs === 'connected') {
      link.connected = true;
      link.everConnected = true;
      if (aloneTimer) { clearTimeout(aloneTimer); aloneTimer = null; }
      if (state.group) syncPeers();
      else if (state.phase !== 'connected') set({ phase: 'connected', connectedAt: Date.now() });
    } else if (cs === 'failed' || cs === 'closed') {
      if (state.group) dropPeer(peerId);
      else if (cs === 'failed') finish('failed', true);
    } else if (cs === 'disconnected') {
      link.connected = false;
      if (state.group) syncPeers();
    }
  });
  local?.getTracks().forEach((tr) => conn.addTrack(tr, local!));
  return conn;
}

/** Waits until ICE gathering is complete (max 4 s) and returns the full local SDP. */
function gathered(conn: RTCPeerConnection): Promise<string> {
  return new Promise((resolve) => {
    const done = () => resolve(conn.localDescription?.sdp ?? '');
    if (conn.iceGatheringState === 'complete') { done(); return; }
    const timer = setTimeout(done, 4000);
    (conn as any).addEventListener('icegatheringstatechange', () => {
      if (conn.iceGatheringState === 'complete') { clearTimeout(timer); done(); }
    });
  });
}

function closeLinks() {
  for (const l of links.values()) { try { l.pc.close(); } catch (_) {} }
  links.clear();
}

function cleanup() {
  if (ringTimer) { clearTimeout(ringTimer); ringTimer = null; }
  if (aloneTimer) { clearTimeout(aloneTimer); aloneTimer = null; }
  Native?.stopRinging();
  Native?.cancelIncoming();
  Native?.endCall();
  try { local?.getTracks().forEach((tr) => tr.stop()); } catch (_) {}
  try { (local as any)?.release?.(); } catch (_) {}
  closeLinks();
  local = null;
  pendingOffer = null;
  ice = null;
}

function toIdle() {
  setTimeout(() => {
    if (state.phase === 'ended') {
      state = { ...IDLE };
      emit();
    }
  }, 1800);
}

/** Ends a 1:1 call; `tell` = let the friend know. Leaves a line in the chat. */
function finish(why: string, tell: boolean) {
  if (state.phase === 'idle' || state.phase === 'ended') return;
  if (state.group) { leaveGroupCall(why); return; }
  const { id, peerId, dir, video, connectedAt } = state;
  const was = state.phase;
  const dur = duration();
  cleanup();
  if (tell && id && peerId) deliverNow(peerId, { t: 'callend', id, why } as any).catch(() => {});
  if (peerId) {
    const kind = video ? t('Video call') : t('Voice call');
    let line: string;
    if (connectedAt) line = `📞 ${kind} · ${dur}`;
    else if (dir === 'in' && was === 'incoming') line = why === 'decline' ? `📞 ${t('Declined call')}` : `📞 ${t('Missed call')}`;
    else if (why === 'decline') line = `📞 ${t('{name} declined the call', { name: name(peerId) })}`;
    else if (why === 'busy') line = `📞 ${t('{name} is in another call', { name: name(peerId) })}`;
    else line = `📞 ${t('Call not answered')}`;
    loadChatStore().then(() => systemLine(peerId, line, new Date().toISOString())).catch(() => {});
  }
  set({ phase: 'ended', endReason: why, remoteUrl: undefined, localUrl: undefined, peers: [] });
  toIdle();
}

// ---- 1:1 outgoing ----------------------------------------------------------------------------

export async function startCall(peerId: string, video: boolean) {
  if (isGroupChat(peerId)) return startGroupCall(groupIdOf(peerId), video);
  if (busy()) throw new Error(t('You are already in a call.'));
  const id = newId();
  state = { ...IDLE, phase: 'outgoing', id, peerId, peerName: name(peerId), video, dir: 'out', speaker: video };
  emit();
  navRef.isReady() && navRef.navigate('Call');
  try {
    await openMedia(video);
    const conn = await connect(peerId);
    const offer = await conn.createOffer({});
    await conn.setLocalDescription(offer);
    const sdp = await gathered(conn);
    if (state.id !== id) return; // hung up meanwhile
    Native?.startCall(t('Call with {name}', { name: name(peerId) }), video, video);
    await deliverNow(peerId, { t: 'call', id, cv: video, sdp } as any);
    pollSignals();
    ringTimer = setTimeout(() => { if (state.id === id && state.phase === 'outgoing') finish('timeout', true); }, RING_MS);
  } catch (e: any) {
    if (state.id === id) finish('failed', false);
    throw e;
  }
}

// ---- group calls -------------------------------------------------------------------------------

function sendGroup(groupId: string, type: string, callId: string, extra?: Record<string, unknown>, only?: string[]) {
  return sendChatEvent(groupChatId(groupId), type as any, callId, extra as any, only).catch(() => {});
}

function groupName(groupId: string): string {
  return groupInfo(groupId)?.name ?? t('Group');
}

function knownCall(groupId: string, id: string, cv: boolean, at: number): KnownGroupCall {
  let g = groupCalls.get(groupId);
  if (!g || g.id !== id) {
    g = { id, cv, members: new Set(), at };
    groupCalls.set(groupId, g);
  }
  return g;
}

/** Starts a group call: everybody in the group chat is rung. */
export async function startGroupCall(groupId: string, video: boolean) {
  if (busy()) throw new Error(t('You are already in a call.'));
  myId = myId ?? await getUserId();
  const members = otherMembers(groupId, myId ?? '');
  if (members.length === 0) throw new Error(t('Nobody else is in this group yet.'));
  const id = newId();
  state = {
    ...IDLE, phase: 'outgoing', id, group: groupId, groupName: groupName(groupId), video, dir: 'out', speaker: true,
  };
  emit();
  navRef.isReady() && navRef.navigate('Call');
  try {
    await openMedia(video);
    await iceConfig();
    const g = knownCall(groupId, id, video, Date.now());
    if (myId) g.members.add(myId);
    Native?.startCall(t('Group call · {group}', { group: groupName(groupId) }), video, true);
    await sendGroup(groupId, 'gcall', id, { cv: video });
    systemLine(groupChatId(groupId), `📞 ${t('You started a group call')}`, new Date().toISOString());
    pollSignals();
    armAloneTimer(id);
  } catch (e) {
    if (state.id === id) leaveGroupCall('failed');
    throw e;
  }
}

/** Nobody (left) in the call for 45 s → hang up. */
function armAloneTimer(id: string) {
  if (aloneTimer) clearTimeout(aloneTimer);
  aloneTimer = setTimeout(() => {
    if (state.id === id && state.group && !Array.from(links.values()).some((l) => l.connected)) leaveGroupCall('timeout');
  }, RING_MS);
}

/** Joins a group call I was rung for (or an ongoing one shown in the chat). */
export async function joinGroupCall(groupId: string, withVideo?: boolean) {
  const g = groupCalls.get(groupId);
  if (!g) throw new Error(t('This call has ended.'));
  if (state.phase === 'incoming' && state.id === g.id) {
    if (ringTimer) { clearTimeout(ringTimer); ringTimer = null; }
    Native?.stopRinging();
    Native?.cancelIncoming();
  } else if (busy()) {
    throw new Error(t('You are already in a call.'));
  }
  if (g.members.size >= MAX_GROUP_CALL) throw new Error(t('This call is full ({n} people).', { n: MAX_GROUP_CALL }));
  myId = myId ?? await getUserId();
  const video = withVideo ?? g.cv;
  state = {
    ...state, phase: 'connecting', id: g.id, group: groupId, groupName: groupName(groupId), video, dir: state.dir ?? 'in',
    speaker: true, muted: false, camOff: false, front: true, peers: [], connectedAt: undefined, endReason: undefined,
  };
  emit();
  navRef.isReady() && navRef.navigate('Call');
  try {
    await openMedia(video);
    await iceConfig();
    if (myId) g.members.add(myId);
    Native?.startCall(t('Group call · {group}', { group: groupName(groupId) }), video, true);
    await sendGroup(groupId, 'gjoin', g.id);
    pollSignals();
    armAloneTimer(g.id);
  } catch (e) {
    leaveGroupCall('failed');
    throw e;
  }
}

function leaveGroupCall(why: string) {
  const { id, group, connectedAt, video, dir, phase } = state;
  if (!group || !id) return;
  const dur = duration();
  cleanup();
  if (phase !== 'incoming') {
    sendGroup(group, 'gleave', id);
    const g = groupCalls.get(group);
    if (g && myId) g.members.delete(myId);
    if (g && g.members.size === 0) groupCalls.delete(group);
  }
  const chat = groupChatId(group);
  const kind = video ? t('Group video call') : t('Group call');
  if (connectedAt) systemLine(chat, `📞 ${kind} · ${dur}`, new Date().toISOString());
  else if (dir === 'in' && phase === 'incoming') systemLine(chat, `📞 ${why === 'decline' ? t('Declined call') : t('Missed group call')}`, new Date().toISOString());
  else if (why === 'timeout') systemLine(chat, `📞 ${t('Nobody joined the call')}`, new Date().toISOString());
  set({ phase: 'ended', endReason: why, localUrl: undefined, remoteUrl: undefined, peers: [] });
  toIdle();
}

function dropPeer(peerId: string) {
  const l = links.get(peerId);
  if (!l) return;
  try { l.pc.close(); } catch (_) {}
  links.delete(peerId);
  syncPeers();
  // everybody else left: end after a short wait (someone may still join)
  if (links.size === 0 && state.group && state.id) armAloneTimer(state.id);
}

async function offerTo(peerId: string) {
  const { id, group } = state;
  if (!id || !group) return;
  const conn = await connect(peerId);
  syncPeers();
  const offer = await conn.createOffer({});
  await conn.setLocalDescription(offer);
  const sdp = await gathered(conn);
  if (state.id !== id || links.get(peerId)?.pc !== conn) return;
  await sendGroup(group, 'goffer', id, { sdp }, [peerId]);
}

function inThisGroupCall(groupId: string, id: string) {
  return state.group === groupId && state.id === id && (state.phase === 'connecting' || state.phase === 'connected' || state.phase === 'outgoing');
}

function onGroupSignal(groupId: string, from: string, ev: CallSignal, serverTime: string) {
  const at = Date.parse(serverTime);
  const age = Date.now() - at;
  if (ev.t !== 'gleave' && age > GROUP_SIGNAL_MAX_AGE_MS) return;
  const chat = groupChatId(groupId);
  const me = myId ?? '';
  switch (ev.t) {
    case 'gcall': {
      const g = knownCall(groupId, ev.id, !!ev.cv, at);
      g.members.add(from);
      emit();
      if (state.id === ev.id) return;
      systemLine(chat, `📞 ${t('{name} started a group call', { name: name(from) })}`, serverTime);
      if (busy() || age > OFFER_MAX_AGE_MS) return;
      state = {
        ...IDLE, phase: 'incoming', id: ev.id, peerId: from, peerName: name(from), group: groupId, groupName: groupName(groupId),
        video: !!ev.cv, dir: 'in', speaker: true,
      };
      emit();
      ringTimer = setTimeout(() => { if (state.id === ev.id && state.phase === 'incoming') leaveGroupCall('timeout'); }, RING_MS - Math.max(0, age));
      if (AppState.currentState === 'active') {
        if (!isMuted(chat)) Native?.startRinging();
        navRef.isReady() && navRef.navigate('Call');
      } else if (!isMuted(chat)) {
        Native?.showIncoming(
          ev.id,
          t('Group call · {group}', { group: groupName(groupId) }),
          t('{name} is calling · end-to-end encrypted', { name: name(from) }),
          t('Join'), t('Decline'),
        );
      }
      pollSignals();
      return;
    }
    case 'gjoin': {
      const g = knownCall(groupId, ev.id, groupCalls.get(groupId)?.cv ?? false, at);
      g.members.add(from);
      emit();
      if (!inThisGroupCall(groupId, ev.id) || links.has(from)) return;
      if (me < from) offerTo(from).catch(() => dropPeer(from));
      else sendGroup(groupId, 'ghere', ev.id, undefined, [from]);
      return;
    }
    case 'ghere': {
      groupCalls.get(groupId)?.members.add(from);
      if (!inThisGroupCall(groupId, ev.id) || links.has(from)) return;
      if (me < from) offerTo(from).catch(() => dropPeer(from));
      return;
    }
    case 'goffer': {
      if (!inThisGroupCall(groupId, ev.id) || typeof ev.sdp !== 'string' || ev.sdp.length > 20000) return;
      if (me < from) return; // I am the offerer for this pair
      (async () => {
        const conn = await connect(from);
        syncPeers();
        await conn.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: ev.sdp! }));
        const ans = await conn.createAnswer();
        await conn.setLocalDescription(ans);
        const sdp = await gathered(conn);
        if (!inThisGroupCall(groupId, ev.id) || links.get(from)?.pc !== conn) return;
        await sendGroup(groupId, 'gans', ev.id, { sdp }, [from]);
      })().catch(() => dropPeer(from));
      return;
    }
    case 'gans': {
      const l = links.get(from);
      if (!inThisGroupCall(groupId, ev.id) || !l || typeof ev.sdp !== 'string') return;
      l.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: ev.sdp })).catch(() => dropPeer(from));
      return;
    }
    case 'gleave': {
      const g = groupCalls.get(groupId);
      if (g && g.id === ev.id) {
        g.members.delete(from);
        if (g.members.size === 0 || (g.members.size === 1 && me && g.members.has(me) && !inThisGroupCall(groupId, ev.id))) {
          groupCalls.delete(groupId);
        }
      }
      emit();
      if (state.id === ev.id && state.phase === 'incoming' && (!g || g.members.size === 0)) {
        leaveGroupCall('timeout'); // the caller gave up
        return;
      }
      if (inThisGroupCall(groupId, ev.id)) dropPeer(from);
      return;
    }
  }
}

// ---- incoming 1:1 ------------------------------------------------------------------------------

function onSignal(chatId: string, from: string, ev: CallSignal, serverTime: string) {
  if (isGroupChat(chatId)) {
    getUserId().then((id) => { myId = id; onGroupSignal(groupIdOf(chatId), from, ev, serverTime); }).catch(() => {});
    return;
  }
  if (ev.t === 'call') {
    if (typeof ev.sdp !== 'string' || ev.sdp.length > 20000) return;
    const age = Date.now() - Date.parse(serverTime);
    if (state.id === ev.id) return;
    if (busy()) {
      deliverNow(from, { t: 'callend', id: ev.id, why: 'busy' } as any).catch(() => {});
      systemLine(from, `📞 ${t('Missed call')}`, serverTime);
      return;
    }
    if (age > OFFER_MAX_AGE_MS) {
      systemLine(from, `📞 ${t('Missed call')}`, serverTime);
      return;
    }
    pendingOffer = { sdp: ev.sdp, at: Date.parse(serverTime) };
    state = { ...IDLE, phase: 'incoming', id: ev.id, peerId: from, peerName: name(from), video: !!ev.cv, dir: 'in', speaker: !!ev.cv };
    emit();
    ringTimer = setTimeout(() => { if (state.id === ev.id && state.phase === 'incoming') finish('timeout', false); }, RING_MS - Math.max(0, age));
    if (AppState.currentState === 'active') {
      if (!isMuted(from)) Native?.startRinging();
      navRef.isReady() && navRef.navigate('Call');
    } else {
      Native?.showIncoming(
        ev.id,
        ev.cv ? t('Video call from {name}', { name: name(from) }) : t('Call from {name}', { name: name(from) }),
        t('Mayfly call · end-to-end encrypted'),
        t('Answer'), t('Decline'),
      );
    }
    pollSignals();
    return;
  }
  if (ev.id !== state.id || from !== state.peerId || state.group) return;
  const link = links.get(from);
  if (ev.t === 'callans' && state.phase === 'outgoing' && link && typeof ev.sdp === 'string') {
    if (ringTimer) { clearTimeout(ringTimer); ringTimer = null; }
    set({ phase: 'connecting' });
    link.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: ev.sdp })).catch(() => finish('failed', true));
  } else if (ev.t === 'callend') {
    finish(ev.why === 'decline' || ev.why === 'busy' ? ev.why : 'hangup', false);
  }
}

setCallHandler(onSignal);

export async function answer(withVideo?: boolean) {
  if (state.phase !== 'incoming' || !state.id) return;
  if (state.group) return joinGroupCall(state.group, withVideo);
  if (!pendingOffer || !state.peerId) return;
  const { id, peerId } = state;
  const video = withVideo ?? state.video;
  if (ringTimer) { clearTimeout(ringTimer); ringTimer = null; }
  Native?.stopRinging();
  Native?.cancelIncoming();
  set({ phase: 'connecting', video, speaker: video });
  try {
    await openMedia(video);
    const conn = await connect(peerId);
    await conn.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: pendingOffer.sdp }));
    const ans = await conn.createAnswer();
    await conn.setLocalDescription(ans);
    const sdp = await gathered(conn);
    if (state.id !== id) return;
    Native?.startCall(t('Call with {name}', { name: name(peerId) }), video, video);
    await deliverNow(peerId, { t: 'callans', id, sdp } as any);
    pollSignals();
  } catch (e) {
    finish('failed', true);
    throw e;
  }
}

export function decline() {
  if (state.phase !== 'incoming') return;
  if (state.group) leaveGroupCall('decline');
  else finish('decline', true);
}

export function hangUp() {
  if (!busy()) return;
  if (state.group) leaveGroupCall('hangup');
  else finish('hangup', true);
}

// ---- controls ----------------------------------------------------------------------------------

export function toggleMute() {
  const muted = !state.muted;
  local?.getAudioTracks().forEach((tr) => { tr.enabled = !muted; });
  set({ muted });
}

export function toggleSpeaker() {
  const speaker = !state.speaker;
  Native?.setSpeaker(speaker, state.video);
  set({ speaker });
}

export function toggleCamera() {
  const camOff = !state.camOff;
  local?.getVideoTracks().forEach((tr) => { tr.enabled = !camOff; });
  set({ camOff });
}

export function flipCamera() {
  local?.getVideoTracks().forEach((tr: any) => tr._switchCamera?.());
  set({ front: !state.front });
}

export function callDuration(): string {
  return duration();
}

// ---- opened from the notification ------------------------------------------------------------

async function launchAction(a: { action: string; callId: string } | null) {
  if (!a || a.callId !== state.id) return;
  if (a.action === 'decline') decline();
  else if (a.action === 'answer') { navRef.isReady() && navRef.navigate('Call'); answer().catch(() => {}); }
  else if (state.phase === 'incoming') { navRef.isReady() && navRef.navigate('Call'); }
}

if (Native) {
  new NativeEventEmitter(NativeModules.MfCall).addListener('MfCallAction', (a) => { launchAction(a); });
  AppState.addEventListener('change', (s) => {
    if (s !== 'active') return;
    Native.takeLaunchAction().then(launchAction).catch(() => {});
    // came back while it rings: ring in the app as well
    if (state.phase === 'incoming') {
      Native.cancelIncoming();
      const chat = state.group ? groupChatId(state.group) : state.peerId;
      if (chat && !isMuted(chat)) Native.startRinging();
      navRef.isReady() && navRef.navigate('Call');
    }
  });
}

/** Called once the navigation is ready (app start from a call notification). */
export function checkLaunchAction() {
  Native?.takeLaunchAction().then(launchAction).catch(() => {});
}
