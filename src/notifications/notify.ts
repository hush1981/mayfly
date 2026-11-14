/**
 * Decides about notifications for newly arrived moments / messages: muted chats are left
 * out, names are the local nicknames. Shown by Mayfly itself (never by the distributor).
 */
import { NativeModules } from 'react-native';
import { ChatMoment, isGroupChat, isMuted, peerName } from '../store/chatStore';
import { displayName } from '../sync/sync';
import { t } from '../i18n';

const Native = NativeModules.MayflyUnifiedPush as
  | { showNotification(title: string, text: string): Promise<boolean> }
  | undefined;

function what(s: ChatMoment): string {
  if (s.kind === 'text') return 'message';
  if (s.kind === 'voice') return 'voice';
  return s.mediaType === 'video' ? 'video' : 'moment';
}

export function notificationText(items: ChatMoment[]): string | null {
  // @mentions get through even in a muted group
  const fresh = items.filter((s) => s.kind !== 'system' && !s.id.startsWith('legacy-') && (!isMuted(s.peerId) || s.mentionsMe));
  if (fresh.length === 0) return null;
  if (fresh.length === 1 && fresh[0].mentionsMe && fresh[0].from) {
    return t('{name} mentioned you in {group}', { name: peerName(fresh[0].from) ?? '?', group: displayName(fresh[0]) });
  }
  const names = Array.from(new Set(fresh.map((s) => (isGroupChat(s.peerId) ? displayName(s) : peerName(s.peerId) ?? s.peerName))));
  if (fresh.length === 1) {
    const w = what(fresh[0]);
    const key = w === 'message' ? 'New message from {name}' : w === 'voice' ? 'New voice message from {name}' : w === 'video' ? 'New video moment from {name}' : 'New moment from {name}';
    return t(key, { name: names[0] });
  }
  if (names.length === 1) return t('{n} new moments and messages from {name}', { n: fresh.length, name: names[0] });
  const list = names.slice(0, 3).join(', ') + (names.length > 3 ? t(' and others') : '');
  return t('{n} new moments and messages from {name}', { n: fresh.length, name: list });
}

export async function notifyNew(items: ChatMoment[], notices: string[] = []): Promise<boolean> {
  const parts = [notificationText(items), ...notices].filter(Boolean) as string[];
  if (parts.length === 0) return false;
  const text = parts.join('\n');
  // Posted by Mayfly's own native code (channel "moments"); no Google / Firebase libraries.
  if (Native?.showNotification) await Native.showNotification('Mayfly', text).catch(() => {});
  return true;
}
