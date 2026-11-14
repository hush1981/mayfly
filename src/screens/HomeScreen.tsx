import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, AppState, RefreshControl, ScrollView,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RootStackParamList, User } from '../types';
import { listFriends } from '../api/friends';
import { getAvatarUrl } from '../api/users';
import { getGroupAvatarUrl, joinGroup, removeGroupMember } from '../api/groups';
import { useAuth } from '../store/AuthProvider';
import { POLLING_INTERVAL_MS } from '../config';
import { colors, shape, typescale } from '../theme';
import {
  ChatMoment, allMoments, cake, chatSettings, groupChatId, groupIdOf, isGroupChat, isMuted, isPinned, isMoment, loadChatStore,
  peerName, rememberPeerNames, setChatSettings, useChatStoreVersion,
} from '../store/chatStore';
import { openChatMenu, openGroupChatMenu } from '../chat/actions';
import { sendHellos, syncBirthday, syncDeliveryTokens, syncNow } from '../sync/sync';
import { groupChats, groupInfo, groupInvites, onGroupsChanged, refreshGroups } from '../store/groupChats';
import { loadStories, ownStories, refreshStories, storiesByOwner, useStoriesVersion } from '../store/stories';
import { showAlert, showSheet } from '../ui/dialog';
import { clearPushNotifications, onPushEvent } from '../push/unifiedPush';
import { Avatar, Icon, IconButton, momentState, timeAgo, membersText } from '../ui/kit';
import { cleanupTempMedia } from '../media/local';
import { openUpdate, useUpdateNotice } from '../update/updateCheck';
import { t } from '../i18n';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

interface ChatRow {
  peerId: string;
  name: string;
  latest?: ChatMoment;
  pending: ChatMoment[];
  unreadTexts: number;
  lastAt: string;
}

function activityAt(s: ChatMoment): string {
  return [s.createdAt, s.openedAt, s.replayedAt].filter(Boolean).sort().pop()!;
}

export default function HomeScreen({ navigation }: Props) {
  const { state } = useAuth();
  const insets = useSafeAreaInsets();
  const version = useChatStoreVersion();
  const storiesVersion = useStoriesVersion();
  const [groupTick, setGroupTick] = useState(0);
  useEffect(() => onGroupsChanged(() => setGroupTick((n) => n + 1)), []);
  const [update, dismissUpdate] = useUpdateNotice();
  const [friends, setFriends] = useState<User[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [ready, setReady] = useState(false);
  const token = state.token ?? '';

  const refresh = useCallback(async () => {
    await loadChatStore();
    loadStories().catch(() => {});
    setReady(true);
    try {
      const f = await listFriends();
      setFriends(f);
      rememberPeerNames(f);
      syncBirthday(f.map((x) => x.id)).catch(() => {});
      syncDeliveryTokens(f.map((x) => x.id)).catch(() => {});
      // forward-secrecy handshake with friends and group co-members (only where still needed)
      const groups = await refreshGroups(true).catch(() => []);
      const co = groups.filter((g) => g.kind === 'chat' && g.myStatus === 'member')
        .flatMap((g) => g.members.filter((m) => m.status === 'member').map((m) => m.id));
      const ids = Array.from(new Set([...f.map((x) => x.id), ...co])).filter((id) => id !== state.userId);
      sendHellos(ids).catch(() => {});
    } catch (_) {}
    await syncNow().catch(() => {});
    if (state.userId) refreshStories(state.userId).catch(() => {});
  }, [state.userId]);

  useEffect(() => onPushEvent((t) => { if (t === 'message') refresh(); }), [refresh]);

  useFocusEffect(
    useCallback(() => {
      clearPushNotifications();
      cleanupTempMedia();
      refresh();
      const interval = setInterval(() => { syncNow().catch(() => {}); }, POLLING_INTERVAL_MS);
      return () => clearInterval(interval);
    }, [refresh]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') { clearPushNotifications(); refresh(); }
    });
    return () => sub.remove();
  }, [refresh]);

  const rows = useMemo<ChatRow[]>(() => {
    const map = new Map<string, ChatRow>();
    for (const f of friends) {
      map.set(f.id, { peerId: f.id, name: peerName(f.id) ?? f.username, pending: [], unreadTexts: 0, lastAt: '' });
    }
    for (const g of groupChats()) {
      map.set(groupChatId(g.id), { peerId: groupChatId(g.id), name: g.name, pending: [], unreadTexts: 0, lastAt: '' });
    }
    for (const s of allMoments()) {
      let row = map.get(s.peerId);
      if (!row) {
        // group chats I left are not shown any more
        if (isGroupChat(s.peerId)) continue;
        row = { peerId: s.peerId, name: peerName(s.peerId) ?? s.peerName, pending: [], unreadTexts: 0, lastAt: '' };
        map.set(s.peerId, row);
      }
      const at = activityAt(s);
      if (at > row.lastAt) {
        row.lastAt = at;
        row.latest = s;
      }
      if (s.dir === 'in' && s.status === 'pending' && isMoment(s) && !s.unsent) row.pending.push(s);
      if ((s.kind === 'text' || s.kind === 'voice') && s.dir === 'in' && !s.readAt && !s.unsent) row.unreadTexts++;
    }
    for (const r of map.values()) r.pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return Array.from(map.values()).sort((a, b) => {
      // pinned chats first (in the order they were pinned)
      const pa = chatSettings(a.peerId).pinned ?? 0;
      const pb = chatSettings(b.peerId).pinned ?? 0;
      if ((pa > 0) !== (pb > 0)) return pb > 0 ? 1 : -1;
      if (pa > 0 && pb > 0 && pa !== pb) return pa - pb;
      const ap = a.pending.length + a.unreadTexts > 0 ? 1 : 0;
      const bp = b.pending.length + b.unreadTexts > 0 ? 1 : 0;
      if (ap !== bp) return bp - ap;
      if (a.lastAt !== b.lastAt) return b.lastAt.localeCompare(a.lastAt);
      return a.name.localeCompare(b.name);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friends, version, groupTick]);

  // Muted stories go to the end (dimmed); long-press a story to (un)mute it.
  const storyOwners = useMemo(() => {
    const list = storiesByOwner();
    return [...list.filter((o) => !chatSettings(o.owner).storyMuted), ...list.filter((o) => chatSettings(o.owner).storyMuted)];
  }, [storiesVersion, version]); // eslint-disable-line react-hooks/exhaustive-deps

  function storyMenu(owner: string, name: string) {
    const muted = !!chatSettings(owner).storyMuted;
    showSheet({
      title: name,
      actions: [
        muted
          ? { label: t('Unmute story'), icon: 'eye-outline', onPress: () => setChatSettings(owner, { storyMuted: false }) }
          : { label: t('Mute story'), icon: 'eye-off-outline', onPress: () => setChatSettings(owner, { storyMuted: true }) },
      ],
    });
  }
  const mine = useMemo(() => ownStories(), [storiesVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const invites = useMemo(() => groupInvites(), [groupTick]); // eslint-disable-line react-hooks/exhaustive-deps

  function groupMenu() {
    showSheet({
      actions: [
        { label: t('New group chat'), icon: 'account-multiple-plus-outline', onPress: () => navigation.navigate('NewGroupChat') },
        { label: t('Broadcast lists'), icon: 'account-multiple-outline', onPress: () => navigation.navigate('Groups') },
      ],
    });
  }

  async function answerInvite(groupId: string, accept: boolean) {
    try {
      if (accept) await joinGroup(groupId);
      else await removeGroupMember(groupId, state.userId!);
      await refreshGroups(true);
      if (accept) {
        const g = groupInfo(groupId);
        navigation.navigate('Chat', { peerId: groupChatId(groupId), peerName: g?.name ?? '' });
      }
    } catch (e: any) {
      showAlert(t('Error'), e.message);
    }
  }

  // Single tap opens the moment / chat, double tap opens the camera for this friend.
  const lastTap = useRef<{ id: string; at: number; timer?: ReturnType<typeof setTimeout> } | null>(null);
  function tapRow(r: ChatRow) {
    const prev = lastTap.current;
    if (prev && prev.id === r.peerId && Date.now() - prev.at < 280) {
      if (prev.timer) clearTimeout(prev.timer);
      lastTap.current = null;
      navigation.navigate('Camera', { peerId: r.peerId, peerName: r.name });
      return;
    }
    if (prev?.timer) clearTimeout(prev.timer);
    lastTap.current = { id: r.peerId, at: Date.now(), timer: setTimeout(() => { lastTap.current = null; openRow(r); }, 280) };
  }

  function openRow(r: ChatRow) {
    if (r.pending.length > 0) {
      const s = r.pending[0];
      navigation.navigate('ViewMoment', { momentId: s.id, peerId: s.peerId, mode: 'first' });
    } else {
      navigation.navigate('Chat', { peerId: r.peerId, peerName: r.name });
    }
  }

  const unread = rows.reduce((n, r) => n + r.pending.length + r.unreadTexts, 0);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => navigation.navigate('Profile')} activeOpacity={0.7} accessibilityLabel={t('Profile')}>
          <Avatar
            uri={state.userId ? getAvatarUrl(state.userId) : null}
            token={token}
            name={state.username ?? '?'}
            size={34}
          />
        </TouchableOpacity>
        <Text style={styles.title}>{t('Chats')}{unread > 0 ? ` · ${t('{n} new', { n: unread })}` : ''}</Text>
        <IconButton name="account-group-outline" onPress={groupMenu} accessibilityLabel={t('Groups')} />
        <IconButton name="account-plus-outline" onPress={() => navigation.navigate('Friends')} accessibilityLabel={t('Friends')} />
      </View>

      {update && (
        <View style={styles.updateBar}>
          <Icon name="arrow-up-circle" size={22} color={colors.onPrimaryContainer} />
          <View style={{ flex: 1 }}>
            <Text style={styles.updateTitle}>{t('Mayfly {version} is available', { version: update })}</Text>
            <Text style={styles.updateText}>{t('Update in F-Droid to get the newest features and fixes.')}</Text>
          </View>
          <TouchableOpacity style={styles.updateBtn} onPress={openUpdate} activeOpacity={0.85}>
            <Text style={styles.updateBtnText}>{t('Update')}</Text>
          </TouchableOpacity>
          <IconButton name="close" size={18} color={colors.onPrimaryContainer} onPress={dismissUpdate} accessibilityLabel={t('Dismiss update notice')} />
        </View>
      )}

      <FlatList
        data={rows}
        keyExtractor={(r) => r.peerId}
        ListHeaderComponent={
          <View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stories}>
              <TouchableOpacity
                style={styles.story}
                onPress={() => (mine.length > 0 ? navigation.navigate('Story', { ownerId: 'me' }) : navigation.navigate('Camera', {}))}
                onLongPress={() => navigation.navigate('Camera', {})}
                activeOpacity={0.7}
                accessibilityLabel={t('My story')}
              >
                <View style={[styles.ring, mine.length > 0 ? styles.ringOwn : styles.ringNone]}>
                  <Avatar uri={state.userId ? getAvatarUrl(state.userId) : null} token={token} name={state.username ?? '?'} size={50} />
                  {mine.length === 0 && <View style={styles.plus}><Icon name="plus" size={14} color={colors.onPrimary} /></View>}
                </View>
                <Text style={styles.storyName} numberOfLines={1}>{t('My story')}</Text>
              </TouchableOpacity>
              {storyOwners.map((o) => {
                const n = peerName(o.owner) ?? o.name;
                const muted = !!chatSettings(o.owner).storyMuted;
                return (
                  <TouchableOpacity
                    key={o.owner}
                    style={[styles.story, muted && { opacity: 0.45 }]}
                    onPress={() => navigation.navigate('Story', { ownerId: o.owner })}
                    onLongPress={() => storyMenu(o.owner, n)}
                    activeOpacity={0.7}
                  >
                    <View style={[styles.ring, o.unseen && !muted ? styles.ringNew : styles.ringSeen]}>
                      <Avatar uri={getAvatarUrl(o.owner)} token={token} name={n} size={50} />
                    </View>
                    <Text style={[styles.storyName, o.unseen && { fontWeight: '700', color: colors.onSurface }]} numberOfLines={1}>{n}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            {invites.map((g) => (
              <View key={g.id} style={styles.invite}>
                <Icon name="account-group" size={22} color={colors.onTertiaryContainer} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.inviteTitle} numberOfLines={1}>{g.name}</Text>
                  <Text style={styles.inviteText} numberOfLines={2}>
                    {g.invitedBy && peerName(g.invitedBy)
                      ? `${t('{name} invited you', { name: peerName(g.invitedBy)! })} · ${membersText(g.members.filter((m) => m.status === 'member').length)}`
                      : `${t('Invitation')} · ${membersText(g.members.filter((m) => m.status === 'member').length)}`}
                  </Text>
                </View>
                <TouchableOpacity style={styles.inviteNo} onPress={() => answerInvite(g.id, false)} accessibilityLabel={t('Decline')}>
                  <Icon name="close" size={18} color={colors.onSurface} />
                </TouchableOpacity>
                <TouchableOpacity style={styles.inviteYes} onPress={() => answerInvite(g.id, true)}>
                  <Text style={styles.inviteYesText}>{t('Join')}</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        }
        contentContainerStyle={rows.length === 0 ? styles.emptyContainer : styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => { setRefreshing(true); await refresh(); setRefreshing(false); }}
            tintColor={colors.primaryText}
            colors={[colors.onPrimary]}
            progressBackgroundColor={colors.primary}
          />
        }
        ListEmptyComponent={ready ? (
          <View style={styles.empty}>
            <Icon name="message-outline" size={40} color={colors.outline} />
            <Text style={styles.emptyTitle}>{t('No chats yet')}</Text>
            <Text style={styles.emptyHint}>{t('Add a friend, then send your first moment.')}</Text>
            <TouchableOpacity style={styles.emptyBtn} onPress={() => navigation.navigate('Friends')}>
              <Icon name="account-plus-outline" size={18} color={colors.onPrimary} />
              <Text style={styles.emptyBtnText}>{t('Add friends')}</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        renderItem={({ item: r }) => {
          const st = r.latest ? momentState(r.latest) : null;
          const extra = r.pending.length > 1 ? ` (${r.pending.length})` : '';
          return (
            <TouchableOpacity
              style={styles.row}
              onPress={() => tapRow(r)}
              onLongPress={() => (isGroupChat(r.peerId)
                ? openGroupChatMenu(groupIdOf(r.peerId), r.name, state.userId ?? '', groupInfo(groupIdOf(r.peerId))?.ownerId, {
                  onInfo: () => navigation.navigate('GroupInfo', { groupId: groupIdOf(r.peerId) }),
                  onOpenCamera: () => navigation.navigate('Camera', { peerId: r.peerId, peerName: r.name }),
                  onLeft: () => refresh(),
                })
                : openChatMenu(r.peerId, r.name, {
                  onOpenCamera: () => navigation.navigate('Camera', { peerId: r.peerId, peerName: r.name }),
                  onBlocked: () => refresh(),
                }))}
              delayLongPress={350}
              activeOpacity={0.6}
            >
              {isGroupChat(r.peerId) ? (
                <Avatar
                  uri={getGroupAvatarUrl(groupIdOf(r.peerId))} token={token} name={r.name} size={44} icon="account-group"
                  tint={colors.tertiaryContainer} textColor={colors.onTertiaryContainer}
                />
              ) : (
                <Avatar uri={getAvatarUrl(r.peerId)} token={token} name={r.name} size={44} />
              )}
              <View style={styles.rowBody}>
                <View style={styles.nameLine}>
                  <Text style={[styles.rowName, (r.pending.length > 0 || r.unreadTexts > 0) && styles.rowNameStrong]} numberOfLines={1}>
                    {r.name}{cake(r.peerId)}
                  </Text>
                  {isMuted(r.peerId) && <Icon name="bell-off-outline" size={14} color={colors.outline} />}
                  {isPinned(r.peerId) && <Icon name="pin" size={14} color={colors.outline} />}
                </View>
                {st ? (
                  <View style={styles.statusLine}>
                    <Icon name={st.icon} size={14} color={st.color} />
                    <Text style={[styles.status, { color: st.color }, st.strong && styles.statusStrong]} numberOfLines={1}>
                      {st.label}{extra}
                      {r.latest?.saved && !isMoment(r.latest) ? `  ·  ${t('saved')}` : ''}
                      {'  ·  '}{timeAgo(r.lastAt)}
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.statusIdle}>{t('Double-tap to send a moment')}</Text>
                )}
              </View>
              <IconButton
                name="chat-outline"
                size={20}
                color={colors.onSurfaceVariant}
                onPress={() => navigation.navigate('Chat', { peerId: r.peerId, peerName: r.name })}
                accessibilityLabel={t('Chat with {name}', { name: r.name })}
              />
            </TouchableOpacity>
          );
        }}
      />

      <TouchableOpacity
        style={[styles.fab, { bottom: 20 + insets.bottom }]}
        onPress={() => navigation.navigate('Camera', {})}
        activeOpacity={0.85}
        accessibilityLabel={t('New moment')}
      >
        <Icon name="camera" size={28} color={colors.onPrimary} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  topBar: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 12, height: 56,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.outlineVariant,
  },
  title: { ...typescale.titleLarge, fontWeight: '600', color: colors.onSurface, flex: 1, marginLeft: 10, fontSize: 20 },

  listContent: { paddingBottom: 110 },
  stories: { paddingHorizontal: 10, paddingVertical: 8, gap: 12 },
  story: { width: 72, alignItems: 'center', gap: 3 },
  ring: { width: 58, height: 58, borderRadius: 29, borderWidth: 2.5, alignItems: 'center', justifyContent: 'center' },
  ringNew: { borderColor: colors.primary },
  ringSeen: { borderColor: colors.outlineVariant },
  ringOwn: { borderColor: colors.tertiary },
  ringNone: { borderColor: 'transparent' },
  plus: {
    position: 'absolute', right: -1, bottom: -1, width: 20, height: 20, borderRadius: 10,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.background,
  },
  storyName: { ...typescale.labelSmall, color: colors.onSurfaceVariant, maxWidth: 72, textAlign: 'center' },
  invite: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 10, marginBottom: 6,
    paddingLeft: 12, paddingRight: 6, paddingVertical: 8, borderRadius: shape.large, backgroundColor: colors.tertiaryContainer,
  },
  inviteTitle: { ...typescale.titleSmall, color: colors.onTertiaryContainer, fontWeight: '700' },
  inviteText: { ...typescale.bodySmall, color: colors.onTertiaryContainer, opacity: 0.85 },
  inviteNo: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceContainerHigh },
  inviteYes: { backgroundColor: colors.primary, borderRadius: shape.full, paddingHorizontal: 14, height: 34, justifyContent: 'center' },
  inviteYesText: { ...typescale.labelLarge, color: colors.onPrimary },
  updateBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    margin: 10, marginBottom: 2, paddingLeft: 14, paddingVertical: 8, paddingRight: 2,
    borderRadius: shape.large, backgroundColor: colors.primaryContainer,
  },
  updateTitle: { ...typescale.titleSmall, color: colors.onPrimaryContainer, fontWeight: '700' },
  updateText: { ...typescale.bodySmall, color: colors.onPrimaryContainer, opacity: 0.85 },
  updateBtn: { backgroundColor: colors.primary, borderRadius: shape.full, paddingHorizontal: 14, height: 34, justifyContent: 'center' },
  updateBtnText: { ...typescale.labelLarge, color: colors.onPrimary },
  emptyContainer: { flex: 1 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.outlineVariant, marginLeft: 72 },

  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 6, paddingVertical: 9, gap: 12 },
  rowBody: { flex: 1, minWidth: 0 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowName: { ...typescale.titleMedium, color: colors.onSurface, flexShrink: 1 },
  rowNameStrong: { fontWeight: '700' },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  status: { ...typescale.bodySmall, flexShrink: 1 },
  statusStrong: { fontWeight: '700' },
  statusIdle: { ...typescale.bodySmall, color: colors.outline, marginTop: 2 },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 32 },
  emptyTitle: { ...typescale.titleMedium, color: colors.onSurface, marginTop: 4 },
  emptyHint: { ...typescale.bodyMedium, color: colors.onSurfaceVariant, textAlign: 'center' },
  emptyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12,
    backgroundColor: colors.primary, borderRadius: shape.medium, paddingHorizontal: 16, height: 42,
  },
  emptyBtnText: { ...typescale.labelLarge, color: colors.onPrimary },

  fab: {
    position: 'absolute', alignSelf: 'center',
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
    elevation: 6,
  },
});
