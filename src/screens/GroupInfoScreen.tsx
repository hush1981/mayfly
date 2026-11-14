/**
 * A group chat: picture and name (every member may change them), members and open
 * invitations, invite friends, leave / delete. Invited friends only join after accepting.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Image } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList, User } from '../types';
import { useAuth } from '../store/AuthProvider';
import { addGroupMember, getGroupAvatarUrl, removeGroupMember, renameGroup, uploadGroupAvatar } from '../api/groups';
import { listFriends } from '../api/friends';
import { getAvatarUrl } from '../api/users';
import { groupInfo, onGroupsChanged, refreshGroups } from '../store/groupChats';
import { peerName } from '../store/chatStore';
import { confirmDeleteGroup, confirmLeave } from '../chat/actions';
import { Avatar, Icon, membersText } from '../ui/kit';
import { ask, promptText, showAlert, showSheet } from '../ui/dialog';
import { colors, shape, typescale } from '../theme';
import { t } from '../i18n';

type Props = NativeStackScreenProps<RootStackParamList, 'GroupInfo'>;

export default function GroupInfoScreen({ route, navigation }: Props) {
  const { groupId } = route.params;
  const { state } = useAuth();
  const me = state.userId ?? '';
  const [, tick] = useState(0);
  const [friends, setFriends] = useState<User[]>([]);
  const [avatarTs, setAvatarTs] = useState(0);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const g = groupInfo(groupId);

  useEffect(() => onGroupsChanged(() => tick((n) => n + 1)), []);
  useEffect(() => {
    refreshGroups(true).catch(() => {});
    listFriends().then(setFriends).catch(() => {});
  }, []);
  useEffect(() => { navigation.setOptions({ title: g?.name ?? t('Group') }); }, [navigation, g?.name]);

  const rename = useCallback(async () => {
    if (!g) return;
    const v = await promptText({ title: t('Group name'), initial: g.name, maxLength: 60 });
    if (v === null || !v.trim() || v.trim() === g.name) return;
    try {
      await renameGroup(groupId, v.trim());
      await refreshGroups(true);
    } catch (e: any) { showAlert(t('Error'), e.message); }
  }, [g, groupId]);

  async function pickPicture() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') { showAlert(t('Permission needed'), t('Gallery access is required.')); return; }
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [1, 1], quality: 0.7,
    });
    if (r.canceled || !r.assets[0]) return;
    try {
      await uploadGroupAvatar(groupId, r.assets[0].uri);
      setAvatarFailed(false);
      setAvatarTs(Date.now());
    } catch (e: any) { showAlert(t('Upload failed'), e.message); }
  }

  function invite() {
    if (!g) return;
    const inGroup = new Set(g.members.map((m) => m.id));
    const candidates = friends.filter((f) => !inGroup.has(f.id));
    if (candidates.length === 0) {
      showAlert(t('Invite friends'), t('All your friends are already in this group or invited.'));
      return;
    }
    showSheet({
      title: t('Invite a friend'),
      message: t('They join once they accept.'),
      actions: candidates.map((f) => ({
        label: peerName(f.id) ?? f.username,
        icon: 'account-plus-outline' as const,
        onPress: async () => {
          try {
            await addGroupMember(groupId, f.id);
            await refreshGroups(true);
          } catch (e: any) { showAlert(t('Error'), e.message); }
        },
      })),
    });
  }

  async function remove(id: string, name: string, invited: boolean) {
    const ok = await ask({
      title: invited ? t('Withdraw invitation?') : t('Remove {name}?', { name }),
      message: invited ? undefined : t('{name} will not get messages from this group any more.', { name }),
      confirm: t('Remove'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await removeGroupMember(groupId, id);
      await refreshGroups(true);
    } catch (e: any) { showAlert(t('Error'), e.message); }
  }

  if (!g) {
    return <View style={styles.center}><Text style={styles.muted}>{t('This group is not available any more.')}</Text></View>;
  }
  const isOwner = g.ownerId === me;
  const members = [...g.members].sort((a, b) => (a.status === b.status ? 0 : a.status === 'member' ? -1 : 1));

  return (
    <View style={styles.container}>
      <FlatList
        data={members}
        keyExtractor={(m) => m.id}
        ListHeaderComponent={
          <View>
            <View style={styles.head}>
              <TouchableOpacity onPress={pickPicture} activeOpacity={0.8} style={styles.bigAvatar} accessibilityLabel={t('Change group picture')}>
                {avatarFailed ? <Icon name="account-group" size={40} color={colors.onTertiaryContainer} /> : (
                  <Image
                    source={{ uri: `${getGroupAvatarUrl(groupId)}?t=${avatarTs}`, headers: state.token ? { Authorization: `Bearer ${state.token}` } : undefined }}
                    style={styles.bigAvatarImg}
                    onError={() => setAvatarFailed(true)}
                  />
                )}
                <View style={styles.editDot}><Icon name="pencil" size={12} color={colors.onPrimary} /></View>
              </TouchableOpacity>
              <TouchableOpacity onPress={rename} activeOpacity={0.7} style={styles.nameRow}>
                <Text style={styles.name}>{g.name}</Text>
                <Icon name="pencil-outline" size={16} color={colors.onSurfaceVariant} />
              </TouchableOpacity>
              <Text style={styles.muted}>{t('Everyone in the group can change its name and picture.')}</Text>
            </View>
            <TouchableOpacity style={styles.action} onPress={invite} activeOpacity={0.7}>
              <Icon name="account-plus-outline" size={22} color={colors.primaryText} />
              <Text style={styles.actionText}>{t('Invite friends')}</Text>
            </TouchableOpacity>
            <Text style={styles.section}>{membersText(g.members.filter((m) => m.status === 'member').length)}</Text>
          </View>
        }
        renderItem={({ item: m }) => {
          const name = m.id === me ? t('You') : peerName(m.id) ?? m.username;
          const invited = m.status === 'invited';
          return (
            <View style={styles.row}>
              <Avatar uri={getAvatarUrl(m.id)} token={state.token ?? undefined} name={m.username} size={36} />
              <View style={{ flex: 1 }}>
                <Text style={styles.memberName} numberOfLines={1}>{name}</Text>
                <Text style={styles.muted}>{invited ? t('Invited') : m.id === g.ownerId ? t('Created the group') : t('Member')}</Text>
              </View>
              {isOwner && m.id !== me && (
                <TouchableOpacity onPress={() => remove(m.id, name, invited)} style={styles.removeBtn}>
                  <Text style={styles.removeText}>{t('Remove')}</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        }}
        ListFooterComponent={
          <View style={{ paddingVertical: 12 }}>
            <TouchableOpacity style={styles.action} onPress={() => confirmLeave(groupId, g.name, me, () => navigation.navigate('Home'))}>
              <Icon name="exit-run" size={22} color={colors.error} />
              <Text style={[styles.actionText, { color: colors.error }]}>{t('Leave group')}</Text>
            </TouchableOpacity>
            {isOwner && (
              <TouchableOpacity style={styles.action} onPress={() => confirmDeleteGroup(groupId, g.name, () => navigation.navigate('Home'))}>
                <Icon name="delete-outline" size={22} color={colors.error} />
                <Text style={[styles.actionText, { color: colors.error }]}>{t('Delete group for everyone')}</Text>
              </TouchableOpacity>
            )}
            <Text style={[styles.muted, { paddingHorizontal: 16, paddingTop: 8 }]}>
              {t('Messages are end-to-end encrypted for every member separately. The server knows who is in the group, but not what is written.')}
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center', padding: 24 },
  head: { alignItems: 'center', paddingTop: 20, paddingBottom: 12, gap: 6, paddingHorizontal: 16 },
  bigAvatar: {
    width: 88, height: 88, borderRadius: 44, backgroundColor: colors.tertiaryContainer,
    alignItems: 'center', justifyContent: 'center',
  },
  bigAvatarImg: { width: 88, height: 88, borderRadius: 44 },
  editDot: {
    position: 'absolute', right: 0, bottom: 0, width: 26, height: 26, borderRadius: 13,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  name: { ...typescale.titleLarge, color: colors.onSurface, fontWeight: '600' },
  muted: { ...typescale.bodySmall, color: colors.onSurfaceVariant, textAlign: 'center' },
  action: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 12 },
  actionText: { ...typescale.bodyLarge, color: colors.primaryText },
  section: {
    ...typescale.labelMedium, color: colors.onSurfaceVariant, textTransform: 'uppercase', letterSpacing: 0.8,
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
  memberName: { ...typescale.bodyLarge, color: colors.onSurface },
  removeBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: shape.full, borderWidth: 1, borderColor: colors.outlineVariant },
  removeText: { ...typescale.labelMedium, color: colors.error },
});
