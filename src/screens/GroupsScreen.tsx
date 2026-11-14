import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput, StyleSheet, ActivityIndicator, Image,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '../store/AuthProvider';
import { RootStackParamList, Group, GroupMember, User } from '../types';
import {
  createGroup, listGroups, listGroupMembers, addGroupMember, removeGroupMember,
  uploadGroupAvatar, getGroupAvatarUrl, deleteGroup,
} from '../api/groups';
import { listFriends } from '../api/friends';
import { Icon, membersText } from '../ui/kit';
import { colors, shape, typescale } from '../theme';
import { ask, showAlert } from '../ui/dialog';
import { t } from '../i18n';

type Props = NativeStackScreenProps<RootStackParamList, 'Groups'>;

function GroupAvatar({ groupId, ts }: { groupId: string; ts?: number }) {
  const [failed, setFailed] = useState(false);
  React.useEffect(() => { setFailed(false); }, [groupId, ts]);
  return failed ? (
    <Icon name="account-group" size={20} color={colors.onTertiaryContainer} />
  ) : (
    <Image
      source={{ uri: `${getGroupAvatarUrl(groupId)}?t=${ts ?? 0}` }}
      style={styles.groupAvatarImg}
      onError={() => setFailed(true)}
    />
  );
}

export default function GroupsScreen(_: Props) {
  const { state } = useAuth();
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [members, setMembers] = useState<Record<string, GroupMember[]>>({});
  const [friends, setFriends] = useState<User[]>([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [creating, setCreating] = useState(false);
  const [focused, setFocused] = useState(false);
  // Which group's "add member" picker is open
  const [addPickerGroupId, setAddPickerGroupId] = useState<string | null>(null);
  // Tracks avatar cache-busters per group to force re-fetch after upload
  const [avatarTs, setAvatarTs] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [g, f] = await Promise.all([listGroups(), listFriends()]);
      // Group chats have their own screen; this one manages broadcast lists ("Rundlisten").
      setGroups(g.filter((x) => x.kind !== 'chat'));
      setFriends(f);
    } catch (e: any) {
      showAlert(t('Error'), e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleCreate() {
    if (!newGroupName.trim()) return;
    setCreating(true);
    try {
      const g = await createGroup(newGroupName.trim(), 'list');
      setNewGroupName('');
      setGroups((prev) => [g, ...prev]);
    } catch (e: any) {
      showAlert(t('Error'), e.message);
    } finally {
      setCreating(false);
    }
  }

  async function toggleExpand(groupId: string) {
    if (expandedGroupId === groupId) {
      setExpandedGroupId(null);
      setAddPickerGroupId(null);
      return;
    }
    setExpandedGroupId(groupId);
    setAddPickerGroupId(null);
    if (!members[groupId]) {
      try {
        const m = await listGroupMembers(groupId);
        setMembers((prev) => ({ ...prev, [groupId]: m }));
      } catch (e: any) {
        showAlert(t('Error'), e.message);
      }
    }
  }

  async function doAddMember(groupId: string, friend: User) {
    try {
      await addGroupMember(groupId, friend.id);
      const m = await listGroupMembers(groupId);
      setMembers((prev) => ({ ...prev, [groupId]: m }));
      setAddPickerGroupId(null);
    } catch (e: any) {
      showAlert(t('Error'), e.message);
    }
  }

  async function handlePickAvatar(group: Group) {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      showAlert(t('Permission needed'), t('Gallery access is required.'));
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (result.canceled || !result.assets[0]) return;
    try {
      await uploadGroupAvatar(group.id, result.assets[0].uri);
      setAvatarTs((prev) => ({ ...prev, [group.id]: Date.now() }));
    } catch (e: any) {
      showAlert(t('Upload failed'), e.message);
    }
  }

  async function handleRemoveMember(groupId: string, userId: string, username: string) {
    showAlert(t('Remove member'), t('Remove {name}?', { name: username }), [
      { text: t('Cancel'), style: 'cancel' },
      {
        text: t('Remove'), style: 'destructive',
        onPress: async () => {
          try {
            await removeGroupMember(groupId, userId);
            setMembers((prev) => ({
              ...prev,
              [groupId]: (prev[groupId] ?? []).filter((m) => m.user_id !== userId),
            }));
          } catch (e: any) {
            showAlert(t('Error'), e.message);
          }
        },
      },
    ]);
  }

  async function handleDelete(group: Group) {
    const isOwner = group.owner_id === state.userId;
    const ok = await ask({
      title: isOwner ? t('Delete {group}?', { group: group.name }) : t('Leave {group}?', { group: group.name }),
      message: isOwner ? t('The list is deleted for everyone on it. Moments already sent stay.') : t('You will not get moments through this list any more.'),
      confirm: isOwner ? t('Delete') : t('Leave'),
      destructive: true,
    });
    if (!ok) return;
    try {
      if (isOwner) await deleteGroup(group.id);
      else await removeGroupMember(group.id, state.userId!);
      setGroups((prev) => prev.filter((x) => x.id !== group.id));
    } catch (e: any) {
      showAlert(t('Error'), e.message);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primaryText} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Create group field */}
      <View style={styles.createSection}>
        <View style={[styles.fieldWrap, focused && styles.fieldFocused]}>
          <Text style={styles.fieldLabel}>{t('Name of the new list')}</Text>
          <TextInput
            style={styles.fieldInput}
            value={newGroupName}
            onChangeText={setNewGroupName}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            autoCapitalize="none"
            autoCorrect={false}
            placeholderTextColor={colors.onSurfaceVariant}
            onSubmitEditing={handleCreate}
            returnKeyType="done"
          />
        </View>
        <TouchableOpacity
          style={[styles.createBtn, creating && styles.createBtnDisabled]}
          onPress={handleCreate}
          disabled={creating}
          activeOpacity={0.85}
        >
          <Text style={styles.createBtnText}>{creating ? '…' : t('Create')}</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={groups}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <View style={styles.emptyIcon}>
              <Icon name="account-group-outline" size={36} color={colors.outline} />
            </View>
            <Text style={styles.emptyTitle}>{t('No broadcast lists yet')}</Text>
            <Text style={styles.emptyHint}>{t('Create one above to send moments to multiple friends at once')}</Text>
          </View>
        }
        renderItem={({ item: group }) => {
          const isExpanded = expandedGroupId === group.id;
          const isOwner = group.owner_id === state.userId;
          const groupMembers = members[group.id] ?? [];
          const showAddPicker = addPickerGroupId === group.id;
          const nonMembers = friends.filter(
            (f) => !groupMembers.some((m) => m.user_id === f.id),
          );

          return (
            <View style={styles.groupCard}>
              <TouchableOpacity
                style={styles.groupRow}
                onPress={() => toggleExpand(group.id)}
                activeOpacity={0.8}
              >
                <TouchableOpacity
                  style={styles.groupAvatar}
                  onPress={isOwner ? () => handlePickAvatar(group) : undefined}
                  activeOpacity={isOwner ? 0.75 : 1}
                >
                  <GroupAvatar groupId={group.id} ts={avatarTs[group.id]} />
                  {isOwner && <View style={styles.groupAvatarEditDot} />}
                </TouchableOpacity>
                <View style={styles.groupInfo}>
                  <Text style={styles.groupName}>{group.name}</Text>
                  {isExpanded && groupMembers.length > 0 && (
                    <Text style={styles.groupMeta}>{membersText(groupMembers.length)}</Text>
                  )}
                </View>
                <Text style={styles.chevron}>{isExpanded ? '▲' : '▼'}</Text>
              </TouchableOpacity>

              {isExpanded && (
                <View style={styles.memberSection}>
                  {groupMembers.map((m) => (
                    <View key={m.user_id} style={styles.memberRow}>
                      <View style={styles.memberAvatar}>
                        <Text style={styles.memberAvatarText}>{m.username[0].toUpperCase()}</Text>
                      </View>
                      <Text style={styles.memberName}>{m.username}</Text>
                      {isOwner && m.user_id !== state.userId && (
                        <TouchableOpacity
                          style={styles.removeBtn}
                          onPress={() => handleRemoveMember(group.id, m.user_id, m.username)}
                          activeOpacity={0.8}
                        >
                          <Text style={styles.removeBtnText}>{t('Remove')}</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  ))}

                  {isOwner && (
                    <>
                      <TouchableOpacity
                        style={[styles.addMemberBtn, showAddPicker && styles.addMemberBtnActive]}
                        onPress={() => setAddPickerGroupId(showAddPicker ? null : group.id)}
                        activeOpacity={0.85}
                      >
                        <Text style={[styles.addMemberText, showAddPicker && styles.addMemberTextActive]}>
                          {showAddPicker ? t('Cancel') : t('Add member')}
                        </Text>
                      </TouchableOpacity>

                      {/* Inline friend picker — replaces Alert.prompt (iOS-only) */}
                      {showAddPicker && (
                        <View style={styles.friendPicker}>
                          {nonMembers.length === 0 ? (
                            <Text style={styles.friendPickerEmpty}>{t('All friends are already on this list')}</Text>
                          ) : (
                            nonMembers.map((f) => (
                              <TouchableOpacity
                                key={f.id}
                                style={styles.friendPickerItem}
                                onPress={() => doAddMember(group.id, f)}
                                activeOpacity={0.8}
                              >
                                <View style={styles.friendPickerAvatar}>
                                  <Text style={styles.friendPickerAvatarText}>
                                    {f.username[0].toUpperCase()}
                                  </Text>
                                </View>
                                <Text style={styles.friendPickerName}>{f.username}</Text>
                                <Text style={styles.friendPickerAdd}>{t('Add')}</Text>
                              </TouchableOpacity>
                            ))
                          )}
                        </View>
                      )}
                    </>
                  )}
                  <TouchableOpacity style={styles.deleteBtn} onPress={() => handleDelete(group)} activeOpacity={0.8}>
                    <Icon name={isOwner ? 'delete-outline' : 'exit-run'} size={18} color={colors.error} />
                    <Text style={styles.deleteText}>{isOwner ? t('Delete list') : t('Leave list')}</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  deleteBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 4, marginTop: 4 },
  deleteText: { ...typescale.labelLarge, color: colors.error },
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background },

  createSection: {
    flexDirection: 'row', gap: 12,
    paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8,
    alignItems: 'flex-end',
  },
  fieldWrap: {
    flex: 1,
    backgroundColor: colors.surfaceContainer,
    borderRadius: shape.medium,
    paddingHorizontal: 14, paddingTop: 7, paddingBottom: 6,
    borderWidth: 1, borderColor: colors.outline,
  },
  fieldFocused: { borderColor: colors.primary, backgroundColor: colors.surfaceContainerHigh },
  fieldLabel: { ...typescale.labelMedium, color: colors.onSurfaceVariant, marginBottom: 2 },
  fieldInput: { ...typescale.bodyLarge, color: colors.onSurface, padding: 0 },
  createBtn: {
    backgroundColor: colors.tertiaryContainer,
    borderRadius: shape.medium,
    paddingVertical: 12, paddingHorizontal: 18,
  },
  createBtnDisabled: { opacity: 0.4 },
  createBtnText: { ...typescale.labelLarge, color: colors.onTertiaryContainer },

  listContent: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32, gap: 6 },

  emptyWrap: { alignItems: 'center', paddingTop: 60 },
  emptyIcon: {
    width: 80, height: 80, borderRadius: shape.medium,
    backgroundColor: colors.tertiaryContainer,
    justifyContent: 'center', alignItems: 'center', marginBottom: 20,
  },
  emptyIconText: { fontSize: 36 },
  emptyTitle: { ...typescale.titleLarge, color: colors.onSurface, marginBottom: 8 },
  emptyHint: {
    ...typescale.bodyMedium, color: colors.onSurfaceVariant,
    textAlign: 'center', paddingHorizontal: 32, lineHeight: 20,
  },

  groupCard: {
    backgroundColor: colors.surfaceContainer,
    borderRadius: shape.medium,
    overflow: 'hidden',
  },
  groupRow: { flexDirection: 'row', alignItems: 'center', padding: 16, gap: 14 },
  groupAvatar: {
    width: 38, height: 38, borderRadius: shape.large,
    backgroundColor: colors.tertiaryContainer,
    justifyContent: 'center', alignItems: 'center',
    overflow: 'hidden',
  },
  groupAvatarImg: { width: 38, height: 38, borderRadius: shape.large },
  groupAvatarFallback: { fontSize: 22 },
  groupAvatarEditDot: {
    position: 'absolute', bottom: 0, right: 0,
    width: 14, height: 14, borderRadius: shape.full,
    backgroundColor: colors.primary,
    borderWidth: 1.5, borderColor: colors.surfaceContainerHigh,
  },
  groupInfo: { flex: 1 },
  groupName: { ...typescale.titleMedium, color: colors.onSurface },
  groupMeta: { ...typescale.bodySmall, color: colors.onSurfaceVariant, marginTop: 2 },
  chevron: { ...typescale.labelMedium, color: colors.onSurfaceVariant },

  memberSection: { backgroundColor: colors.surfaceContainerHigh, paddingHorizontal: 16, paddingBottom: 12 },
  memberRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, gap: 12,
    borderTopWidth: 1, borderTopColor: colors.outlineVariant,
  },
  memberAvatar: {
    width: 36, height: 36, borderRadius: shape.full,
    backgroundColor: colors.surfaceContainerHighest,
    justifyContent: 'center', alignItems: 'center',
  },
  memberAvatarText: { ...typescale.labelLarge, color: colors.onSurface },
  memberName: { ...typescale.bodyMedium, color: colors.onSurface, flex: 1 },
  removeBtn: {
    borderRadius: shape.small,
    paddingHorizontal: 10, paddingVertical: 5,
    borderWidth: 1, borderColor: colors.error,
  },
  removeBtnText: { ...typescale.labelSmall, color: colors.error },

  addMemberBtn: {
    marginTop: 10,
    borderRadius: shape.medium,
    borderWidth: 1, borderColor: colors.outlineVariant,
    paddingVertical: 12, alignItems: 'center',
  },
  addMemberBtnActive: { borderColor: colors.outline, backgroundColor: colors.surfaceContainer },
  addMemberText: { ...typescale.labelLarge, color: colors.tertiary },
  addMemberTextActive: { color: colors.onSurfaceVariant },

  friendPicker: {
    marginTop: 8,
    borderRadius: shape.large,
    backgroundColor: colors.surfaceContainer,
    overflow: 'hidden',
  },
  friendPickerEmpty: {
    ...typescale.bodySmall,
    color: colors.onSurfaceVariant,
    textAlign: 'center',
    padding: 16,
  },
  friendPickerItem: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 10, gap: 12,
    borderBottomWidth: 1, borderBottomColor: colors.outlineVariant,
  },
  friendPickerAvatar: {
    width: 34, height: 34, borderRadius: shape.full,
    backgroundColor: colors.primaryContainer,
    justifyContent: 'center', alignItems: 'center',
  },
  friendPickerAvatarText: { ...typescale.labelMedium, color: colors.onPrimaryContainer },
  friendPickerName: { ...typescale.bodyMedium, color: colors.onSurface, flex: 1 },
  friendPickerAdd: {
    ...typescale.labelMedium,
    color: colors.primaryText,
    paddingHorizontal: 4,
  },
});
