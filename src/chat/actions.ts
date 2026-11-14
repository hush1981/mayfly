/** Chat-level actions shared by the chat screen and the chat list (long-press). */
import { Linking } from 'react-native';
import { blockUser } from '../api/blocks';
import { removeFriend } from '../api/friends';
import { QuotaError } from '../send/sendMoment';
import { acceptNewKey, pendingKeyChange } from '../crypto/peerKeys';
import {
  ChatTtl, chatSettings, forgetPeer, groupChatId, isPinned, setChatSettings, setPinned, username,
} from '../store/chatStore';
import { forgetSessions } from '../crypto/sessions';
import { cutOff } from '../store/deliveryTokens';
import { removeGroupMember, deleteGroup } from '../api/groups';
import { refreshGroups } from '../store/groupChats';
import { setChatTtl } from '../sync/sync';
import { ask, promptText, showAlert, showSheet } from '../ui/dialog';
import { t } from '../i18n';

export function openChatMenu(peerId: string, name: string, after?: { onBlocked?: () => void; onOpenCamera?: () => void }) {
  const st = chatSettings(peerId);
  const ttl = st.ttl ?? 'day';
  showSheet({
    title: name,
    message: username(peerId) && username(peerId) !== name ? `@${username(peerId)}` : undefined,
    actions: [
      ...(after?.onOpenCamera ? [{ label: t('Send a moment'), icon: 'camera-outline' as const, onPress: after.onOpenCamera }] : []),
      { label: st.nickname ? t('Change nickname') : t('Set nickname'), icon: 'rename-box', onPress: () => editNickname(peerId, name) },
      {
        label: t('Messages disappear: {when}', { when: ttlLabel(ttl) }),
        icon: 'timer-sand',
        onPress: () => chooseTtl(peerId, name),
      },
      pinAction(peerId),
      st.muted
        ? { label: t('Unmute notifications'), icon: 'bell-outline', onPress: () => setChatSettings(peerId, { muted: false }) }
        : { label: t('Mute notifications'), icon: 'bell-off-outline', onPress: () => setChatSettings(peerId, { muted: true }) },
      { label: t('Remove friend'), icon: 'account-remove-outline', destructive: true, onPress: () => confirmRemove(peerId, name, after?.onBlocked) },
      { label: t('Block'), icon: 'block-helper', destructive: true, onPress: () => confirmBlock(peerId, name, after?.onBlocked) },
    ],
  });
}

async function confirmRemove(peerId: string, name: string, onDone?: () => void) {
  const ok = await ask({
    title: t('Remove {name}?', { name }),
    message: t('You will no longer be friends and this chat is deleted from your phone. {name} is not told, but can add you again.', { name }),
    confirm: t('Remove'),
    destructive: true,
  });
  if (!ok) return;
  try {
    await removeFriend(peerId);
    await forgetPeer(peerId);
    await forgetSessions(peerId);
    await cutOff(peerId, false);
    onDone?.();
  } catch (e: any) {
    showAlert(t('Error'), e?.message ?? String(e));
  }
}

async function editNickname(peerId: string, name: string) {
  const value = await promptText({
    title: t('Nickname'),
    message: `${t('Only you see this name.')} ${username(peerId) ? t('Username: {name}', { name: username(peerId)! }) : ''}`.trim(),
    initial: chatSettings(peerId).nickname ?? '',
    placeholder: username(peerId) ?? name,
    maxLength: 30,
  });
  if (value === null) return;
  setChatSettings(peerId, { nickname: value.trim() });
}

/** "after viewing" / "6 hours after sending" … */
export function ttlLabel(ttl: ChatTtl): string {
  switch (ttl) {
    case 'viewed': return t('after viewing');
    case '6h': return t('after 6 hours');
    case '12h': return t('after 12 hours');
    default: return t('after 24 hours');
  }
}

function pinAction(chatId: string) {
  return isPinned(chatId)
    ? { label: t('Unpin chat'), icon: 'pin-off-outline' as const, onPress: () => setPinned(chatId, false) }
    : { label: t('Pin chat'), icon: 'pin-outline' as const, onPress: () => setPinned(chatId, true) };
}

function chooseTtl(chatId: string, name: string, group = false) {
  const ttl = chatSettings(chatId).ttl ?? 'day';
  const mark = (x: ChatTtl) => (ttl === x ? '  ✓' : '');
  showSheet({
    title: t('When should messages disappear?'),
    message: group
      ? t('Applies to everyone in {name}. Saved messages always stay.', { name })
      : t('Applies to you and {name}. Saved messages always stay.', { name }),
    actions: [
      ...(group ? [] : [{ label: `${t('After viewing')}${mark('viewed')}`, icon: 'eye-off-outline' as const, onPress: () => { setChatTtl(chatId, 'viewed'); } }]),
      { label: `${t('6 hours after sending')}${mark('6h')}`, icon: 'clock-time-six-outline', onPress: () => { setChatTtl(chatId, '6h'); } },
      { label: `${t('12 hours after sending')}${mark('12h')}`, icon: 'clock-time-twelve-outline', onPress: () => { setChatTtl(chatId, '12h'); } },
      { label: `${t('24 hours after sending')}${mark('day')}`, icon: 'clock-outline', onPress: () => { setChatTtl(chatId, 'day'); } },
    ],
  });
}

async function confirmBlock(peerId: string, name: string, onBlocked?: () => void) {
  const ok = await ask({
    title: t('Block {name}?', { name }),
    message: t("{name} can't send you moments or messages and can't add you any more. You will no longer be friends, and this chat is deleted from your phone. {name} is not told.", { name }),
    confirm: t('Block'),
    destructive: true,
  });
  if (!ok) return;
  try {
    await blockUser(peerId);
    await forgetPeer(peerId);
    await forgetSessions(peerId);
    // sealed sender: they must not be able to deliver to me with my old token
    await cutOff(peerId, true);
    onBlocked?.();
  } catch (e: any) {
    showAlert(t('Could not block'), e?.response?.data?.message ?? e.message);
  }
}

/**
 * Pending key change: nothing is sent to (or accepted from) the friend until the user
 * verifies the new key or accepts it. Returns true when there is nothing to resolve.
 */
export async function resolveKeyChange(
  peerId: string, name: string, opts: { onVerify: () => void; onAccepted?: () => void },
): Promise<boolean> {
  const p = await pendingKeyChange(peerId);
  if (!p) return true;
  const accept = async () => {
    if (p.wasVerified) {
      const sure = await ask({
        title: t('Accept without verifying?'),
        message: t('{name} was verified. Only accept if you are sure {name} reinstalled the app or has a new phone — otherwise someone may be in between.', { name }),
        confirm: t('Accept anyway'),
        destructive: true,
      });
      if (!sure) return;
    }
    try {
      await acceptNewKey(peerId);
      opts.onAccepted?.();
    } catch (e: any) {
      showAlert(t('Error'), e.message);
    }
  };
  showAlert(
    t('New security key'),
    p.wasVerified
      ? t('{name} was verified, but the server now has a different key for {name}. That happens after a reinstall or a new phone — or it could be an attack. Verify {name} again before you send anything.', { name })
      : t("The server has a new key for {name} (new phone or reinstall?). Until you confirm it, nothing is sent to {name} and {name}'s messages wait on the server.", { name }),
    [
      { text: t('Cancel'), style: 'cancel' },
      { text: t('Verify now'), onPress: opts.onVerify },
      { text: t('Accept new key'), style: p.wasVerified ? 'destructive' : 'default', onPress: () => { accept(); } },
    ],
    { icon: 'shield-alert-outline' },
  );
  return false;
}

/** Error after sending; limits get an explanation and a pointer to self-hosting. */
export function showSendError(e: any) {
  if (e instanceof QuotaError) {
    showAlert(
      e.code === 'server_full' ? t('Server is full') : t('Limit reached'),
      (e.code === 'server_full'
        ? t('This Mayfly server is out of storage right now. Try again later.')
        : t('This shared server limits how many unopened moments can wait at a time (see Profile → Server limits). Wait until your friends opened some moments.'))
        + '\n\n' + t('Mayfly can also run on your own server — no limits but your own.'),
      [
        { text: t('OK'), style: 'cancel' },
        { text: t('Self-hosting'), onPress: () => Linking.openURL('https://mayfly.paul42.de/#selfhosting').catch(() => {}) },
      ],
      { icon: 'server-network' },
    );
    return;
  }
  showAlert(t('Send failed'), e?.message ?? String(e));
}

/** Long-press / header menu of a group chat. */
export function openGroupChatMenu(
  groupId: string, name: string, myId: string, ownerId: string | undefined,
  nav: { onInfo: () => void; onOpenCamera?: () => void; onLeft?: () => void },
) {
  const chatId = groupChatId(groupId);
  const st = chatSettings(chatId);
  showSheet({
    title: name,
    actions: [
      ...(nav.onOpenCamera ? [{ label: t('Send a moment'), icon: 'camera-outline' as const, onPress: nav.onOpenCamera }] : []),
      { label: t('Group info'), icon: 'account-group-outline', onPress: nav.onInfo },
      {
        label: t('Messages disappear: {when}', { when: ttlLabel(st.ttl ?? 'day') }),
        icon: 'timer-sand',
        onPress: () => chooseTtl(chatId, name, true),
      },
      pinAction(chatId),
      st.muted
        ? { label: t('Unmute notifications'), icon: 'bell-outline', onPress: () => setChatSettings(chatId, { muted: false }) }
        : { label: t('Mute notifications'), icon: 'bell-off-outline', onPress: () => setChatSettings(chatId, { muted: true }) },
      { label: t('Leave group'), icon: 'exit-run', destructive: true, onPress: () => confirmLeave(groupId, name, myId, nav.onLeft) },
      ...(ownerId === myId
        ? [{ label: t('Delete group for everyone'), icon: 'delete-outline' as const, destructive: true, onPress: () => confirmDeleteGroup(groupId, name, nav.onLeft) }]
        : []),
    ],
  });
}

export async function confirmLeave(groupId: string, name: string, myId: string, onLeft?: () => void) {
  const ok = await ask({
    title: t('Leave {group}?', { group: name }),
    message: t('You will not get messages from this group any more. Its chat is deleted from your phone.'),
    confirm: t('Leave'),
    destructive: true,
  });
  if (!ok) return;
  try {
    await removeGroupMember(groupId, myId);
    await forgetPeer(groupChatId(groupId));
    await refreshGroups(true).catch(() => {});
    onLeft?.();
  } catch (e: any) {
    showAlert(t('Error'), e?.message ?? String(e));
  }
}

export async function confirmDeleteGroup(groupId: string, name: string, onDone?: () => void) {
  const ok = await ask({
    title: t('Delete {group}?', { group: name }),
    message: t('The group is deleted for all members. Messages already received stay on their phones until they disappear.'),
    confirm: t('Delete'),
    destructive: true,
  });
  if (!ok) return;
  try {
    await deleteGroup(groupId);
    await forgetPeer(groupChatId(groupId));
    await refreshGroups(true).catch(() => {});
    onDone?.();
  } catch (e: any) {
    showAlert(t('Error'), e?.message ?? String(e));
  }
}
