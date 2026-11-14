/**
 * Who may see my stories: all friends (also ones added later) or only the picked ones.
 * The choice stays on this phone and is used for every new story.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList, User } from '../types';
import { listFriends } from '../api/friends';
import { getAvatarUrl } from '../api/users';
import { useAuth } from '../store/AuthProvider';
import { loadChatStore, peerName, setStoryAudience, storyAudience } from '../store/chatStore';
import { colors, typescale } from '../theme';
import { Avatar, Icon } from '../ui/kit';
import { showAlert } from '../ui/dialog';
import { t } from '../i18n';

type Props = NativeStackScreenProps<RootStackParamList, 'StoryAudience'>;

export default function StoryAudienceScreen({ navigation }: Props) {
  const { state } = useAuth();
  const [friends, setFriends] = useState<User[] | null>(null);
  const [mode, setMode] = useState<'all' | 'custom'>('all');
  const [ids, setIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadChatStore().then(() => {
      const a = storyAudience();
      setMode(a.mode);
      setIds(new Set(a.ids));
    });
    listFriends().then(setFriends).catch((e) => { setFriends([]); showAlert(t('Error'), e.message); });
  }, []);

  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity
          onPress={() => { setStoryAudience({ mode, ids: [...ids] }); navigation.goBack(); }}
          style={styles.saveBtn}
        >
          <Text style={styles.saveText}>{t('Done')}</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, mode, ids]);

  const sorted = useMemo(() => [...(friends ?? [])].sort((a, b) => (peerName(a.id) ?? a.username).localeCompare(peerName(b.id) ?? b.username)), [friends]);

  if (!friends) return <View style={styles.center}><ActivityIndicator color={colors.primaryText} /></View>;

  function toggle(id: string) {
    setMode('custom');
    setIds((prev) => {
      const next = new Set(mode === 'all' ? friends!.map((f) => f.id) : prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const checked = (id: string) => mode === 'all' || ids.has(id);

  return (
    <View style={styles.container}>
      <Text style={styles.intro}>
        {t('Your story is visible for 24 hours. Only the friends picked here can see it — the server stores a key for each of them and nobody else.')}
      </Text>
      <TouchableOpacity style={styles.row} onPress={() => { setMode(mode === 'all' ? 'custom' : 'all'); if (mode === 'all') setIds(new Set(friends.map((f) => f.id))); }} activeOpacity={0.6}>
        <View style={styles.allIcon}><Icon name="account-multiple" size={20} color={colors.onPrimary} /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{t('All friends')}</Text>
          <Text style={styles.sub}>{t('Also friends you add later')}</Text>
        </View>
        <Icon name={mode === 'all' ? 'toggle-switch' : 'toggle-switch-off-outline'} size={36} color={mode === 'all' ? colors.primaryText : colors.outline} />
      </TouchableOpacity>
      <FlatList
        data={sorted}
        keyExtractor={(f) => f.id}
        ListHeaderComponent={<Text style={styles.section}>{mode === 'all' ? t('Friends') : t('{n} of {total} friends', { n: ids.size, total: friends.length })}</Text>}
        renderItem={({ item }) => {
          const name = peerName(item.id) ?? item.username;
          return (
            <TouchableOpacity style={styles.row} onPress={() => toggle(item.id)} activeOpacity={0.6}>
              <Avatar uri={getAvatarUrl(item.id)} token={state.token ?? undefined} name={name} size={36} />
              <Text style={[styles.name, { flex: 1 }]} numberOfLines={1}>{name}</Text>
              <Icon name={checked(item.id) ? 'check-circle' : 'circle-outline'} size={22} color={checked(item.id) ? colors.primaryText : colors.outline} />
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' },
  intro: { ...typescale.bodySmall, color: colors.onSurfaceVariant, padding: 16, paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
  allIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  name: { ...typescale.bodyLarge, color: colors.onSurface },
  sub: { ...typescale.bodySmall, color: colors.onSurfaceVariant },
  section: { ...typescale.labelMedium, color: colors.onSurfaceVariant, textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 },
  saveBtn: { paddingHorizontal: 12, paddingVertical: 6 },
  saveText: { ...typescale.labelLarge, color: colors.primaryText },
});
