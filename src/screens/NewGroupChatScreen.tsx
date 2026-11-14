/** Creates a group chat and invites the picked friends (they join after accepting). */
import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList, User } from '../types';
import { useAuth } from '../store/AuthProvider';
import { addGroupMember, createGroup } from '../api/groups';
import { listFriends } from '../api/friends';
import { getAvatarUrl } from '../api/users';
import { groupChatId, peerName } from '../store/chatStore';
import { refreshGroups } from '../store/groupChats';
import { Avatar, Icon } from '../ui/kit';
import { showAlert } from '../ui/dialog';
import { colors, shape, typescale } from '../theme';
import { t } from '../i18n';

type Props = NativeStackScreenProps<RootStackParamList, 'NewGroupChat'>;

export default function NewGroupChatScreen({ navigation }: Props) {
  const { state } = useAuth();
  const [name, setName] = useState('');
  const [friends, setFriends] = useState<User[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => { listFriends().then(setFriends).catch(() => setFriends([])); }, []);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const g = await createGroup(name.trim(), 'chat');
      const failed: string[] = [];
      for (const id of picked) {
        try { await addGroupMember(g.id, id); } catch { failed.push(peerName(id) ?? id); }
      }
      await refreshGroups(true).catch(() => {});
      if (failed.length) showAlert(t('Some invitations failed'), failed.join(', '));
      navigation.replace('Chat', { peerId: groupChatId(g.id), peerName: g.name });
    } catch (e: any) {
      showAlert(t('Error'), e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.field}>
        <Text style={styles.label}>{t('Group name')}</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} maxLength={60} autoFocus placeholderTextColor={colors.outline} />
      </View>
      <Text style={styles.section}>{t('Invite friends')}</Text>
      {!friends ? <ActivityIndicator color={colors.primaryText} /> : (
        <FlatList
          data={friends}
          keyExtractor={(f) => f.id}
          contentContainerStyle={{ paddingBottom: 100 }}
          ListEmptyComponent={<Text style={styles.muted}>{t('No friends yet — add some first')}</Text>}
          renderItem={({ item }) => {
            const on = picked.has(item.id);
            const n = peerName(item.id) ?? item.username;
            return (
              <TouchableOpacity
                style={[styles.row, on && { backgroundColor: colors.surfaceContainer }]}
                onPress={() => setPicked((p) => { const x = new Set(p); if (x.has(item.id)) x.delete(item.id); else x.add(item.id); return x; })}
                activeOpacity={0.6}
              >
                <Avatar uri={getAvatarUrl(item.id)} token={state.token ?? undefined} name={n} size={36} />
                <Text style={styles.rowName} numberOfLines={1}>{n}</Text>
                <Icon name={on ? 'check-circle' : 'circle-outline'} size={22} color={on ? colors.primaryText : colors.outline} />
              </TouchableOpacity>
            );
          }}
        />
      )}
      <View style={styles.bar}>
        <TouchableOpacity style={[styles.btn, (!name.trim() || busy) && { opacity: 0.5 }]} onPress={create} disabled={!name.trim() || busy}>
          {busy ? <ActivityIndicator color={colors.onPrimary} /> : (
            <Text style={styles.btnText}>
              {picked.size > 0 ? t('Create and invite {n}', { n: picked.size }) : t('Create group')}
            </Text>
          )}
        </TouchableOpacity>
        <Text style={styles.muted}>{t('Invited friends join once they accept.')}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  field: {
    margin: 12, backgroundColor: colors.surfaceContainer, borderRadius: shape.medium,
    borderWidth: 1, borderColor: colors.outlineVariant, paddingHorizontal: 14, paddingTop: 7, paddingBottom: 4,
  },
  label: { ...typescale.labelSmall, color: colors.onSurfaceVariant },
  input: { ...typescale.bodyLarge, color: colors.onSurface, paddingVertical: 4 },
  section: { ...typescale.labelMedium, color: colors.onSurfaceVariant, textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
  rowName: { ...typescale.bodyLarge, color: colors.onSurface, flex: 1 },
  muted: { ...typescale.bodySmall, color: colors.onSurfaceVariant, textAlign: 'center', marginTop: 6 },
  bar: {
    position: 'absolute', left: 0, right: 0, bottom: 0, padding: 12, paddingBottom: 20,
    backgroundColor: colors.surfaceContainerLow, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.outlineVariant,
  },
  btn: { height: 48, borderRadius: shape.medium, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  btnText: { ...typescale.labelLarge, color: colors.onPrimary, fontSize: 15 },
});
