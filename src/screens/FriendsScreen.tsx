import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput, StyleSheet, SectionList, ActivityIndicator, Image, Modal,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList, User, FriendRequest } from '../types';
import { listFriends, listFriendRequests, acceptFriendRequest, removeFriend, sendFriendRequest } from '../api/friends';
import { getAvatarUrl } from '../api/users';
import { useAuth } from '../store/AuthProvider';
import { colors, shape, typescale } from '../theme';
import { Button, Icon, IconButton } from '../ui/kit';
import QrCode from '../ui/QrCode';
import { chooseAndScanQr } from '../qr/scan';
import { friendQrPayload, getPeerKey, parseFriendQr, rememberScannedFriendKey } from '../crypto/peerKeys';
import { bestFriends, cake, loadChatStore, peerName, rememberPeerNames, useChatStoreVersion } from '../store/chatStore';
import { openChatMenu } from '../chat/actions';
import { showAlert } from '../ui/dialog';
import { t } from '../i18n';

type Props = NativeStackScreenProps<RootStackParamList, 'Friends'>;

export default function FriendsScreen({ navigation }: Props) {
  const { state } = useAuth();
  useChatStoreVersion();
  useEffect(() => { loadChatStore(); }, []);
  const [friends, setFriends] = useState<User[]>([]);
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [addUsername, setAddUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);
  const [fullscreenUserId, setFullscreenUserId] = useState<string | null>(null);
  const [fullscreenInitial, setFullscreenInitial] = useState('');
  const [avatarFailed, setAvatarFailed] = useState<Record<string, boolean>>({});
  const [qrMode, setQrMode] = useState<'mine' | null>(null);
  const [myQr, setMyQr] = useState<string | null>(null);

  async function showMyCode() {
    try {
      setMyQr(await friendQrPayload(state.username ?? ''));
      setQrMode('mine');
    } catch (e: any) {
      showAlert(t('Not available'), e.message);
    }
  }

  async function startScan() {
    try {
      const data = await chooseAndScanQr();
      if (data) await onScanned(data);
    } catch (e: any) {
      showAlert(t('Scanner'), e.message);
    }
  }

  async function onScanned(data: string) {
    const parsed = parseFriendQr(data);
    if (!parsed) {
      showAlert(t('Unknown code'), t('That is not an Mayfly friend code.'));
      return;
    }
    if (parsed.username.toLowerCase() === (state.username ?? '').toLowerCase()) {
      showAlert(t('That is you'), t("Scan your friend's code, not your own."));
      return;
    }
    // Scanned in person: remember the key, it verifies the friend once we see them.
    await rememberScannedFriendKey(parsed.username, parsed.key);
    try {
      const status = await sendFriendRequest(parsed.username);
      showAlert(
        status === 'accepted' ? t('Friends') : t('Request sent'),
        status === 'accepted'
          ? t('You and {name} are now friends (verified by QR).', { name: parsed.username })
          : t('{name} gets your request. Once accepted, the chat is verified automatically.', { name: parsed.username }),
      );
    } catch (e: any) {
      if (/already friends/i.test(e.message)) {
        showAlert(t('Already friends'), t('The QR code verified {name}.', { name: parsed.username }));
      } else {
        showAlert(t('Error'), e.message);
        return;
      }
    }
    await load();
  }

  const token = state.token ?? '';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [f, r] = await Promise.all([listFriends(), listFriendRequests()]);
      rememberPeerNames(f);
      // Fetching keys applies any key scanned by QR (verifies, or flags a mismatch).
      f.forEach((u) => { getPeerKey(u.id).catch(() => {}); });
      setFriends(f);
      setRequests(r);
    } catch (e: any) {
      showAlert(t('Error'), e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleAccept(req: FriendRequest) {
    try {
      await acceptFriendRequest(req.id);
      await load();
    } catch (e: any) {
      showAlert(t('Error'), e.message);
    }
  }

  async function handleDecline(req: FriendRequest) {
    try {
      await removeFriend(req.requester.id);
      await load();
    } catch (e: any) {
      showAlert(t('Error'), e.message);
    }
  }

  async function handleAdd() {
    if (!addUsername.trim()) return;
    setSending(true);
    try {
      const status = await sendFriendRequest(addUsername.trim());
      setAddUsername('');
      if (status === 'accepted') {
        showAlert(t('Friends'), t('You and {name} are now friends.', { name: addUsername.trim() }));
        await load();
      } else {
        showAlert(t('Request sent'), t('Friend request sent to {name}', { name: addUsername.trim() }));
      }
    } catch (e: any) {
      showAlert(t('Error'), e.message);
    } finally {
      setSending(false);
    }
  }

  function openFullscreen(user: User) {
    setFullscreenUserId(user.id);
    setFullscreenInitial(user.username[0].toUpperCase());
  }

  const best = bestFriends(friends.map((f) => f.id));
  const byId = new Map(friends.map((f) => [f.id, f]));
  const sorted = [...friends].sort((a, b) => (peerName(a.id) ?? a.username).localeCompare(peerName(b.id) ?? b.username));
  const sections = [
    ...(requests.length > 0 ? [{
      title: t('Requests ({n})', { n: requests.length }),
      data: requests as any[],
      isRequests: true,
      key: 'requests',
    }] : []),
    ...(best.length > 0 ? [{
      title: t('Best friends'),
      data: best.map((id) => byId.get(id)!) as any[],
      isRequests: false,
      key: 'best',
    }] : []),
    {
      title: t('Friends · {n}', { n: friends.length }),
      data: sorted as any[],
      isRequests: false,
      key: 'friends',
    },
  ];

  const fullscreenUri = fullscreenUserId ? getAvatarUrl(fullscreenUserId) : null;

  return (
    <View style={styles.container}>
      {/* Fullscreen avatar modal */}
      <Modal
        visible={fullscreenUserId !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setFullscreenUserId(null)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setFullscreenUserId(null)}
        >
          {fullscreenUri ? (
            <Image
              source={{ uri: fullscreenUri, headers: { Authorization: `Bearer ${token}` } }}
              style={styles.modalAvatar}
              onError={() => setFullscreenUserId(null)}
            />
          ) : (
            <View style={styles.modalAvatarFallback}>
              <Text style={styles.modalAvatarInitial}>{fullscreenInitial}</Text>
            </View>
          )}
        </TouchableOpacity>
      </Modal>

      {/* QR: show own code / scan a friend's code */}
      <Modal visible={qrMode !== null} transparent animationType="fade" onRequestClose={() => setQrMode(null)}>
        <View style={styles.qrModalBg}>
          <View style={styles.qrCard}>
            {qrMode === 'mine' && myQr ? (
              <>
                <Text style={styles.qrTitle}>{t('Your friend code')}</Text>
                <View style={{ alignItems: 'center' }}><QrCode value={myQr} size={240} /></View>
                <Text style={styles.qrHint}>
                  {t('Let your friend scan this in Mayfly (Friends → Scan). It adds you and verifies your key in one go.')}
                </Text>
              </>
            ) : null}
            <Button label={t('Close')} kind="tonal" onPress={() => setQrMode(null)} />
          </View>
        </View>
      </Modal>

      <View style={styles.qrRow}>
        <Button label={t('My code')} kind="tonal" icon="qrcode" onPress={showMyCode} style={{ flex: 1 }} />
        <Button label={t('Scan')} kind="tonal" icon="qrcode-scan" onPress={startScan} style={{ flex: 1 }} />
      </View>

      {/* Search / add bar */}
      <View style={styles.addSection}>
        <View style={[styles.fieldWrap, focused && styles.fieldFocused]}>
          <Text style={styles.fieldLabel}>{t('Add by username')}</Text>
          <TextInput
            style={styles.fieldInput}
            value={addUsername}
            onChangeText={setAddUsername}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            autoCapitalize="none"
            autoCorrect={false}
            placeholderTextColor={colors.onSurfaceVariant}
            onSubmitEditing={handleAdd}
            returnKeyType="send"
          />
        </View>
        <TouchableOpacity
          style={[styles.sendBtn, sending && styles.sendBtnDisabled]}
          onPress={handleAdd}
          disabled={sending}
          activeOpacity={0.85}
        >
          <Text style={styles.sendBtnText}>{sending ? '…' : t('Add')}</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.primaryText} size="large" />
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item, i) => `${item.id}-${i}`}
          contentContainerStyle={styles.listContent}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }: any) => (
            <View style={[styles.sectionHeaderWrap, { flexDirection: 'row', alignItems: 'center', gap: 6 }]}>
              {section.key === 'best' && <Icon name="star" size={14} color={colors.primaryText} />}
              <Text style={styles.sectionHeader}>{section.title}</Text>
            </View>
          )}
          renderItem={({ item, section }: any) =>
            section.isRequests ? (
              <View style={styles.card}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{item.requester.username[0].toUpperCase()}</Text>
                </View>
                <Text style={styles.cardName}>{item.requester.username}</Text>
                <IconButton name="close" size={20} onPress={() => handleDecline(item)} accessibilityLabel={t('Decline')} />
                <TouchableOpacity
                  style={styles.acceptBtn}
                  onPress={() => handleAccept(item)}
                  activeOpacity={0.85}
                >
                  <Text style={styles.acceptBtnText}>{t('Accept')}</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.card}>
                <TouchableOpacity
                  style={styles.avatarWrap}
                  onPress={() => openFullscreen(item)}
                  activeOpacity={0.8}
                >
                  {!avatarFailed[item.id] ? (
                    <Image
                      source={{
                        uri: getAvatarUrl(item.id),
                        headers: { Authorization: `Bearer ${token}` },
                      }}
                      style={styles.avatarImg}
                      onError={() => setAvatarFailed((p) => ({ ...p, [item.id]: true }))}
                    />
                  ) : (
                    <View style={styles.avatar}>
                      <Text style={styles.avatarText}>{item.username[0].toUpperCase()}</Text>
                    </View>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={{ flex: 1 }}
                  onPress={() => navigation.navigate('Chat', { peerId: item.id, peerName: peerName(item.id) ?? item.username })}
                  activeOpacity={0.7}
                >
                  <Text style={styles.cardName} numberOfLines={1}>{peerName(item.id) ?? item.username}{cake(item.id)}</Text>
                  {peerName(item.id) && peerName(item.id) !== item.username ? (
                    <Text style={styles.cardSub} numberOfLines={1}>@{item.username}</Text>
                  ) : null}
                </TouchableOpacity>
                <IconButton
                  name="dots-vertical"
                  color={colors.onSurfaceVariant}
                  onPress={() => openChatMenu(item.id, peerName(item.id) ?? item.username, {
                    onOpenCamera: () => navigation.navigate('Camera', { peerId: item.id, peerName: peerName(item.id) ?? item.username }),
                    onBlocked: () => load(),
                  })}
                  accessibilityLabel={t('Options for {name}', { name: item.username })}
                />
              </View>
            )
          }
          ListEmptyComponent={
            <Text style={styles.emptyText}>{t('No friends yet — add someone above')}</Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center', alignItems: 'center',
  },
  modalAvatar: { width: 280, height: 280, borderRadius: shape.large },
  modalAvatarFallback: {
    width: 280, height: 280, borderRadius: shape.large,
    backgroundColor: colors.primaryContainer,
    justifyContent: 'center', alignItems: 'center',
  },
  modalAvatarInitial: { fontSize: 120, color: colors.onPrimaryContainer },

  qrRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  qrModalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', padding: 20 },
  qrCard: { backgroundColor: colors.surfaceContainerHigh, borderRadius: shape.large, padding: 16, gap: 12 },
  qrTitle: { ...typescale.titleMedium, fontWeight: '600', color: colors.onSurface },
  qrHint: { ...typescale.bodySmall, color: colors.onSurfaceVariant, textAlign: 'center' },
  addSection: {
    flexDirection: 'row', gap: 12,
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8,
    alignItems: 'flex-end',
  },
  fieldWrap: {
    flex: 1,
    backgroundColor: colors.surfaceContainer,
    borderRadius: shape.medium,
    paddingHorizontal: 14, paddingTop: 7, paddingBottom: 6,
    borderWidth: 1, borderColor: colors.outline,
  },
  fieldFocused: {
    borderColor: colors.primary,
    backgroundColor: colors.surfaceContainerHigh,
  },
  fieldLabel: {
    ...typescale.labelMedium,
    color: colors.onSurfaceVariant, marginBottom: 2,
  },
  fieldInput: {
    ...typescale.bodyLarge,
    color: colors.onSurface, padding: 0,
  },
  sendBtn: {
    backgroundColor: colors.primary,
    borderRadius: shape.medium,
    paddingVertical: 12, paddingHorizontal: 18,
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: {
    ...typescale.labelLarge,
    color: colors.onPrimary,
  },

  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  listContent: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32, gap: 6 },

  sectionHeaderWrap: { paddingTop: 12, paddingBottom: 4 },
  sectionHeader: {
    ...typescale.labelMedium,
    color: colors.onSurfaceVariant,
    textTransform: 'uppercase', letterSpacing: 1,
  },

  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surfaceContainer,
    borderRadius: shape.medium,
    paddingVertical: 8, paddingHorizontal: 12, gap: 12,
  },
  avatarWrap: { width: 38, height: 38, borderRadius: shape.full, overflow: 'hidden' },
  avatarImg: { width: 38, height: 38, borderRadius: shape.full },
  avatar: {
    width: 38, height: 38, borderRadius: shape.full,
    backgroundColor: colors.primaryContainer,
    justifyContent: 'center', alignItems: 'center',
  },
  avatarText: {
    ...typescale.titleMedium,
    color: colors.onPrimaryContainer,
  },
  cardSub: { ...typescale.bodySmall, color: colors.onSurfaceVariant },
  cardName: {
    ...typescale.bodyLarge,
    color: colors.onSurface, flex: 1,
  },
  acceptBtn: {
    backgroundColor: colors.primary,
    borderRadius: shape.full,
    paddingHorizontal: 16, paddingVertical: 8,
  },
  acceptBtnText: {
    ...typescale.labelLarge,
    color: colors.onPrimary,
  },
  emptyText: {
    ...typescale.bodyMedium,
    color: colors.onSurfaceVariant,
    textAlign: 'center', marginTop: 40,
  },
});
