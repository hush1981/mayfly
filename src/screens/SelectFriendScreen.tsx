import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, SectionList, TouchableOpacity, StyleSheet, ActivityIndicator,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RootStackParamList, User } from '../types';
import { listFriends } from '../api/friends';
import { listGroupMembers, getGroupAvatarUrl } from '../api/groups';
import { getAvatarUrl } from '../api/users';
import { useAuth } from '../store/AuthProvider';
import {
  bestFriends, cake, loadChatStore, peerName, rememberPeerNames, storyAudience, useChatStoreVersion,
} from '../store/chatStore';
import { GroupInfo, loadGroups, refreshGroups } from '../store/groupChats';
import { postStory } from '../store/stories';
import { QuotaError, deletePlainOriginals, sendMomentTo, sendToGroupChat } from '../send/sendMoment';
import { colors, shape, typescale } from '../theme';
import { Avatar, Icon } from '../ui/kit';
import { showAlert } from '../ui/dialog';
import { showSendError } from '../chat/actions';
import { t } from '../i18n';

type Props = NativeStackScreenProps<RootStackParamList, 'SelectFriend'>;

interface Row { id: string; name: string; kind: 'friend' | 'list' | 'chat' | 'story' }

export default function SelectFriendScreen({ route, navigation }: Props) {
  const { draft, peerId: presetPeerId } = route.params;
  const { state } = useAuth();
  const insets = useSafeAreaInsets();
  const [friends, setFriends] = useState<User[]>([]);
  const [lists, setLists] = useState<GroupInfo[]>([]);
  const [chats, setChats] = useState<GroupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState('');
  useChatStoreVersion(); // story audience label

  // Friends and group chats: multi-select. A broadcast list replaces the friend selection.
  // "My story" can be combined with everything.
  const [selectedFriendIds, setSelectedFriendIds] = useState<Set<string>>(
    new Set(presetPeerId && !presetPeerId.startsWith('g:') ? [presetPeerId] : []),
  );
  const [selectedChats, setSelectedChats] = useState<Set<string>>(
    new Set(presetPeerId?.startsWith('g:') ? [presetPeerId.slice(2)] : []),
  );
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [story, setStory] = useState(false);
  const canStory = draft.type === 'image' || draft.type === 'video';

  useEffect(() => {
    Promise.all([listFriends(), refreshGroups(true).catch(() => loadGroups()), loadChatStore()])
      .then(([f, g]) => {
        setFriends(f);
        rememberPeerNames(f);
        setLists(g.filter((x) => x.kind === 'list'));
        setChats(g.filter((x) => x.kind === 'chat' && x.myStatus === 'member'));
      })
      .catch((e) => showAlert(t('Error'), e.message))
      .finally(() => setLoading(false));
  }, []);

  function toggleFriend(id: string) {
    setSelectedListId(null);
    setSelectedFriendIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleList(id: string) {
    setSelectedFriendIds(new Set());
    setSelectedListId((prev) => (prev === id ? null : id));
  }

  function toggleChat(id: string) {
    setSelectedChats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const audience = storyAudience();
  const audienceIds = useMemo(() => (audience.mode === 'all'
    ? friends.map((f) => f.id)
    : audience.ids.filter((id) => friends.some((f) => f.id === id))),
  [audience.mode, audience.ids, friends]);
  const audienceLabel = audience.mode === 'all'
    ? t('All friends')
    : audienceIds.length === 1 ? t('1 friend') : t('{n} friends', { n: audienceIds.length });

  const hasSelection = selectedFriendIds.size > 0 || selectedListId !== null || selectedChats.size > 0 || story;
  const nameOf = useCallback((u: User) => peerName(u.id) ?? u.username, []);

  const sendLabel = () => {
    const parts: string[] = [];
    if (story) parts.push(t('My story'));
    if (selectedListId) parts.push(lists.find((x) => x.id === selectedListId)?.name ?? t('list'));
    for (const id of selectedChats) parts.push(chats.find((c) => c.id === id)?.name ?? '?');
    const n = selectedFriendIds.size;
    if (n === 1) {
      const f = friends.find((x) => selectedFriendIds.has(x.id));
      parts.push(f ? nameOf(f) : t('1 friend'));
    } else if (n > 1) {
      parts.push(t('{n} friends', { n }));
    }
    return t('Send to {name}', { name: parts.join(', ') });
  };

  const handleSend = useCallback(async () => {
    if (!hasSelection || sending) return;
    if (story && audienceIds.length === 0) {
      showAlert(t('Nobody can see this story'), t('Pick at least one friend who may see your story.'));
      return;
    }
    setSending(true);
    setProgress(t('Encrypting…'));
    const errors: string[] = [];
    let anyOk = false;
    try {
      const me = state.userId!;
      if (story && (draft.type === 'image' || draft.type === 'video')) {
        setProgress(t('Posting story…'));
        try {
          const viewers = friends.filter((f) => audienceIds.includes(f.id)).map((f) => ({ id: f.id, username: f.username }));
          const { skipped } = await postStory({ ...draft, type: draft.type }, viewers, me, true);
          anyOk = true;
          if (skipped.length) errors.push(t('Story not shared with {names} (security key changed)', { names: skipped.join(', ') }));
        } catch (e: any) {
          if (e?.code === 'quota' || e?.code === 'server_full') throw new QuotaError(e.code, e.message);
          errors.push(`${t('My story')}: ${t(e?.message ?? String(e))}`);
        }
      }
      for (const gid of selectedChats) {
        const g = chats.find((c) => c.id === gid);
        setProgress(t('Sending to {name}…', { name: g?.name ?? '' }));
        try {
          await sendToGroupChat(draft, gid, g?.name ?? '', me, true);
          anyOk = true;
        } catch (e: any) {
          if (e instanceof QuotaError) throw e;
          errors.push(`${g?.name ?? '?'}: ${e?.message ?? e}`);
        }
      }
      let recipients: { id: string; username: string }[] = [];
      let groupId: string | undefined;
      let groupName: string | undefined;
      if (selectedListId) {
        const members = await listGroupMembers(selectedListId);
        recipients = members
          .filter((m) => m.user_id !== me && m.status !== 'invited')
          .map((m) => ({ id: m.user_id, username: m.username }));
        groupId = selectedListId;
        groupName = lists.find((g) => g.id === selectedListId)?.name;
        if (recipients.length === 0) errors.push(t('This list has nobody else on it yet.'));
      } else {
        recipients = friends
          .filter((f) => selectedFriendIds.has(f.id))
          .map((f) => ({ id: f.id, username: f.username }));
      }
      if (recipients.length > 0) {
        const res = await sendMomentTo(draft, recipients, me, { groupId, groupName, onProgress: setProgress, keepOriginals: true });
        errors.push(...res.errors);
        anyOk = true;
      }
      deletePlainOriginals(draft);
      if (errors.length > 0) showAlert(anyOk ? t('Some sends failed') : t('Send failed'), errors.join('\n'));
      if (anyOk) navigation.navigate('Home');
    } catch (e: any) {
      showSendError(e);
    } finally {
      setSending(false);
      setProgress('');
    }
  }, [hasSelection, sending, story, audienceIds, selectedChats, chats, selectedListId, lists, selectedFriendIds, friends, draft, navigation, state.userId]);

  const sections = useMemo(() => {
    const best = bestFriends(friends.map((f) => f.id));
    const byId = new Map(friends.map((f) => [f.id, f]));
    const toRow = (f: User): Row => ({ id: f.id, name: nameOf(f) + cake(f.id), kind: 'friend' });
    const all = [...friends].sort((a, b) => nameOf(a).localeCompare(nameOf(b))).map(toRow);
    return [
      ...(canStory ? [{ title: t('Story'), key: 'story', data: [{ id: 'story', name: t('My story'), kind: 'story' as const }] }] : []),
      ...(chats.length > 0 ? [{ title: t('Group chats'), key: 'chats', data: chats.map((g): Row => ({ id: g.id, name: g.name, kind: 'chat' })) }] : []),
      ...(best.length > 0 ? [{ title: t('Best friends'), key: 'best', data: best.map((id) => toRow(byId.get(id)!)) }] : []),
      ...(lists.length > 0 ? [{ title: t('Broadcast lists'), key: 'lists', data: lists.map((g): Row => ({ id: g.id, name: g.name, kind: 'list' })) }] : []),
      { title: t('Friends'), key: 'friends', data: all },
    ];
  }, [friends, lists, chats, nameOf, canStory]);

  const isSelected = (r: Row) => (r.kind === 'story' ? story
    : r.kind === 'chat' ? selectedChats.has(r.id)
    : r.kind === 'list' ? selectedListId === r.id
    : selectedFriendIds.has(r.id));
  const toggle = (r: Row) => (r.kind === 'story' ? setStory((x) => !x)
    : r.kind === 'chat' ? toggleChat(r.id)
    : r.kind === 'list' ? toggleList(r.id)
    : toggleFriend(r.id));

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primaryText} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {sending && (
        <View style={styles.overlay}>
          <View style={styles.overlayCard}>
            <ActivityIndicator color={colors.primaryText} />
            <Text style={styles.overlayText}>{progress}</Text>
          </View>
        </View>
      )}

      <SectionList
        sections={sections}
        keyExtractor={(item, i) => `${item.id}-${i}`}
        contentContainerStyle={styles.listContent}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeaderRow}>
            {section.key === 'best' && <Icon name="star" size={14} color={colors.primaryText} />}
            {section.key === 'lists' && <Text style={styles.sectionHint}>{t('· one by one to each member')}</Text>}
            <Text style={styles.sectionHeader}>{section.title}</Text>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.emptyText}>{t('No friends yet — add some first')}</Text>}
        renderItem={({ item }) => {
          const selected = isSelected(item);
          if (item.kind === 'story') {
            return (
              <View style={[styles.row, selected && styles.rowSelected]}>
                <TouchableOpacity style={styles.storyMain} onPress={() => toggle(item)} activeOpacity={0.6}>
                  <View style={styles.storyIcon}><Icon name="circle-slice-8" size={22} color={colors.onPrimary} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.rowName, selected && styles.rowNameSelected]}>{item.name}</Text>
                    <Text style={styles.rowSub}>{t('24 hours · {who}', { who: audienceLabel })}</Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity style={styles.audienceBtn} onPress={() => navigation.navigate('StoryAudience')} accessibilityLabel={t('Who can see my story')}>
                  <Icon name="account-multiple-check-outline" size={20} color={colors.onSurfaceVariant} />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => toggle(item)}>
                  <Icon name={selected ? 'check-circle' : 'circle-outline'} size={22} color={selected ? colors.primaryText : colors.outline} />
                </TouchableOpacity>
              </View>
            );
          }
          const isGroup = item.kind !== 'friend';
          return (
            <TouchableOpacity
              style={[styles.row, selected && styles.rowSelected]}
              onPress={() => toggle(item)}
              activeOpacity={0.6}
            >
              <Avatar
                uri={isGroup ? getGroupAvatarUrl(item.id) : getAvatarUrl(item.id)}
                token={state.token ?? undefined}
                name={item.name}
                size={36}
                icon={item.kind === 'list' ? 'account-multiple-outline' : item.kind === 'chat' ? 'account-group' : undefined}
                tint={isGroup ? colors.tertiaryContainer : colors.surfaceContainerHighest}
                textColor={isGroup ? colors.onTertiaryContainer : colors.onSurface}
              />
              <Text style={[styles.rowName, selected && styles.rowNameSelected]} numberOfLines={1}>{item.name}</Text>
              <Icon
                name={selected ? 'check-circle' : 'circle-outline'}
                size={22}
                color={selected ? colors.primaryText : colors.outline}
              />
            </TouchableOpacity>
          );
        }}
      />

      {hasSelection && (
        <View style={[styles.sendBar, { paddingBottom: 10 + insets.bottom }]}>
          <TouchableOpacity
            style={[styles.sendBtn, sending && { opacity: 0.5 }]}
            onPress={handleSend}
            disabled={sending}
            activeOpacity={0.85}
          >
            <Text style={styles.sendText} numberOfLines={1}>{sendLabel()}</Text>
            <Icon name="send" size={18} color={colors.onPrimary} />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' },
  overlay: {
    ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center', alignItems: 'center', zIndex: 10,
  },
  overlayCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.surfaceContainerHigh, borderRadius: shape.medium,
    paddingVertical: 16, paddingHorizontal: 20,
  },
  overlayText: { ...typescale.bodyLarge, color: colors.onSurface },
  listContent: { paddingBottom: 100 },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 },
  sectionHeader: {
    ...typescale.labelMedium, color: colors.onSurfaceVariant,
    textTransform: 'uppercase', letterSpacing: 0.8,
  },
  emptyText: { ...typescale.bodyMedium, color: colors.onSurfaceVariant, textAlign: 'center', marginTop: 60 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
  rowSelected: { backgroundColor: colors.surfaceContainer },
  rowName: { ...typescale.bodyLarge, color: colors.onSurface, flex: 1 },
  rowNameSelected: { fontWeight: '600' },
  rowSub: { ...typescale.bodySmall, color: colors.onSurfaceVariant },
  storyMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  storyIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  audienceBtn: { padding: 6, marginRight: 4 },
  sectionHint: { ...typescale.labelSmall, color: colors.outline },
  sendBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: 12, paddingTop: 10,
    backgroundColor: colors.surfaceContainerLow,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.outlineVariant,
  },
  sendBtn: {
    height: 48, borderRadius: shape.medium, backgroundColor: colors.primary,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 16,
  },
  sendText: { ...typescale.labelLarge, color: colors.onPrimary, fontSize: 15, flexShrink: 1 },
});
