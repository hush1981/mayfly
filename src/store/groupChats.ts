/**
 * Local view of the groups (group chats and broadcast lists) from the server.
 *
 * The server decides who is in a group, so every change of a group chat's members or name
 * is shown as a line in the chat ("X joined", "Y left") — a member the server sneaks in
 * cannot stay unnoticed. Messages are only accepted from, and sent to, accepted members.
 */
import { listGroupMembers, listGroups } from '../api/groups';
import { Group } from '../types';
import { getSecureJson, setSecureJson } from './secureJson';
import { getUserId } from './session';
import { groupChatId, rememberPeerNames, upsertMoment } from './chatStore';
import { t } from '../i18n';

const KEY = 'mayfly_groups_v1';
const STALE_MS = 60_000;

export interface Member { id: string; username: string; status: 'member' | 'invited' }

export interface GroupInfo {
  id: string;
  name: string;
  ownerId: string;
  kind: 'list' | 'chat';
  myStatus: 'member' | 'invited';
  invitedBy?: string;
  members: Member[];
  fetchedAt: number;
}

let groups: Record<string, GroupInfo> = {};
let loaded = false;
let refreshing: Promise<GroupInfo[]> | null = null;
let lastRefresh = 0;
const listeners = new Set<() => void>();

async function load() {
  if (loaded) return;
  try { groups = (await getSecureJson<Record<string, GroupInfo>>(KEY)) ?? {}; } catch { groups = {}; }
  loaded = true;
}

function save() {
  setSecureJson(KEY, groups).catch(() => {});
  listeners.forEach((l) => l());
}

export function onGroupsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function systemLine(groupId: string, text: string) {
  const id = 'sys-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  upsertMoment({
    kind: 'system', id, peerId: groupChatId(groupId), peerName: '', dir: 'in', mediaType: 'image',
    createdAt: new Date().toISOString(), status: 'opened', saved: false, text,
  });
}

function kindOf(g: Group): 'list' | 'chat' {
  return g.kind === 'chat' ? 'chat' : 'list';
}

/** Fetches groups (and members of group chats). Notes membership and name changes in the chats. */
export function refreshGroups(force = false): Promise<GroupInfo[]> {
  if (!force && Date.now() - lastRefresh < STALE_MS && loaded) return Promise.resolve(Object.values(groups));
  if (!refreshing) {
    refreshing = (async () => {
      await load();
      const me = await getUserId();
      const list = await listGroups();
      const next: Record<string, GroupInfo> = {};
      for (const g of list) {
        const prev = groups[g.id];
        const info: GroupInfo = {
          id: g.id, name: g.name, ownerId: g.owner_id, kind: kindOf(g),
          myStatus: g.my_status === 'invited' ? 'invited' : 'member', invitedBy: g.invited_by,
          members: prev?.members ?? [], fetchedAt: prev?.fetchedAt ?? 0,
        };
        if (info.kind === 'chat') {
          try {
            const ms = await listGroupMembers(g.id);
            info.members = ms.map((m) => ({ id: m.user_id, username: m.username, status: m.status === 'invited' ? 'invited' : 'member' }));
            info.fetchedAt = Date.now();
            rememberPeerNames(ms.map((m) => ({ id: m.user_id, username: m.username })));
          } catch (_) {}
          if (prev && prev.myStatus === 'member' && info.myStatus === 'member') noteChanges(prev, info, me);
          else if (prev?.myStatus === 'invited' && info.myStatus === 'member') systemLine(g.id, t('You joined {group}', { group: info.name }));
        }
        next[g.id] = info;
      }
      for (const [id, prev] of Object.entries(groups)) {
        if (!next[id] && prev.kind === 'chat' && prev.myStatus === 'member') {
          systemLine(id, t('You are no longer in this group'));
        }
      }
      groups = next;
      lastRefresh = Date.now();
      save();
      return Object.values(groups);
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

function noteChanges(prev: GroupInfo, next: GroupInfo, me: string | null) {
  if (prev.name !== next.name) systemLine(next.id, t('The group is now called “{name}”', { name: next.name }));
  const was = new Map(prev.members.map((m) => [m.id, m]));
  const now = new Map(next.members.map((m) => [m.id, m]));
  for (const m of next.members) {
    if (m.id === me) continue;
    const p = was.get(m.id);
    if (m.status === 'member' && p?.status !== 'member') systemLine(next.id, t('{name} joined the group', { name: m.username }));
    else if (m.status === 'invited' && !p) systemLine(next.id, t('{name} was invited', { name: m.username }));
  }
  for (const m of prev.members) {
    if (m.id === me || now.has(m.id)) continue;
    systemLine(next.id, m.status === 'member'
      ? t('{name} left the group', { name: m.username })
      : t('{name} declined the invitation', { name: m.username }));
  }
}

export async function loadGroups(): Promise<GroupInfo[]> {
  await load();
  return Object.values(groups);
}

export function groupInfo(groupId: string): GroupInfo | undefined {
  return groups[groupId];
}

export function groupChats(): GroupInfo[] {
  return Object.values(groups).filter((g) => g.kind === 'chat' && g.myStatus === 'member');
}

export function groupInvites(): GroupInfo[] {
  return Object.values(groups).filter((g) => g.kind === 'chat' && g.myStatus === 'invited');
}

/** Accepted members of a group chat (without me). */
export function otherMembers(groupId: string, me: string): Member[] {
  return (groups[groupId]?.members ?? []).filter((m) => m.status === 'member' && m.id !== me);
}

/**
 * Is `userId` an accepted member of the group chat? Refreshes once if unknown (someone who
 * just joined), so a message from a new member is not dropped.
 */
export async function isChatMember(groupId: string, userId: string): Promise<boolean> {
  await load();
  const check = () => {
    const g = groups[groupId];
    return !!g && g.kind === 'chat' && g.myStatus === 'member' && g.members.some((m) => m.id === userId && m.status === 'member');
  };
  if (check()) return true;
  if (Date.now() - lastRefresh > 10_000) {
    try { await refreshGroups(true); } catch (_) {}
  }
  return check();
}

/** Does `userId` sit in one of my group chats (both of us accepted)? Local data only. */
export async function sharesGroupChat(userId: string): Promise<boolean> {
  await load();
  return Object.values(groups).some((g) => g.kind === 'chat' && g.myStatus === 'member'
    && g.members.some((m) => m.id === userId && m.status === 'member'));
}

export function forgetGroups() {
  groups = {};
  loaded = true;
  lastRefresh = 0;
  setSecureJson(KEY, {}).catch(() => {});
}
