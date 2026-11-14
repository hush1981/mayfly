import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView, Modal, BackHandler, NativeModules, Linking } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '../store/AuthProvider';
import { RootStackParamList } from '../types';
import { uploadAvatar, getAvatarUrl, rotatePublicKey, deleteAccount, changePassword } from '../api/users';
import {
  Distributor, PushStatus, disablePush, enablePush, getDistributors, getPushStatus, onPushEvent, pushAvailable,
  syncEndpointToServer,
} from '../push/unifiedPush';
import { generateKeyPair, storePrivateKey, deletePrivateKey } from '../crypto/keys';
import { ThemeName, colors, saveThemeName, shape, themeName, typescale } from '../theme';
import { listBlocked, unblockUser } from '../api/blocks';
import { unblockLocally } from '../store/deliveryTokens';
import { ServerLimits, getServerLimits } from '../api/limits';
import { User } from '../types';
import { Avatar, Button, Field, Icon, SectionLabel, IconName } from '../ui/kit';
import { ServerSetting } from './LoginScreen';
import { ask, promptText, showAlert } from '../ui/dialog';
import { Switch } from 'react-native';
import { listFriends } from '../api/friends';
import {
  callsHideIp, loadChatStore, myBirthday, setCallsHideIp, setMyBirthday, useChatStoreVersion,
} from '../store/chatStore';
import { syncBirthday } from '../sync/sync';
import { checkForUpdate, installed, openUpdate } from '../update/updateCheck';
import { LangSetting, langSetting, saveLangSetting, t } from '../i18n';

type Props = NativeStackScreenProps<RootStackParamList, 'Profile'>;

/** Small modal asking for the password before a sensitive account action. */
function PasswordModal({
  visible, title, body, confirmLabel, danger, onCancel, onConfirm,
}: {
  visible: boolean; title: string; body: string; confirmLabel: string; danger?: boolean;
  onCancel: () => void; onConfirm: (password: string) => Promise<void>;
}) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!visible) setPw(''); }, [visible]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalBg}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>{title}</Text>
          <Text style={styles.modalBody}>{body}</Text>
          <Field label={t('Password')} value={pw} onChangeText={setPw} secureTextEntry autoFocus />
          <View style={styles.modalRow}>
            <Button label={t('Cancel')} kind="tonal" onPress={onCancel} style={{ flex: 1 }} />
            <Button
              label={confirmLabel}
              kind={danger ? 'danger' : 'primary'}
              loading={busy}
              disabled={!pw}
              style={{ flex: 1 }}
              onPress={async () => {
                setBusy(true);
                try { await onConfirm(pw); } finally { setBusy(false); }
              }}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** Push via UnifiedPush: pick a distributor (e.g. ntfy); Mayfly shows its own notifications. */
function PushSection() {
  const [dists, setDists] = useState<Distributor[] | null>(null);
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const [d, st] = await Promise.all([getDistributors(), getPushStatus()]);
    setDists(d);
    setStatus(st);
    if (st?.endpoint) syncEndpointToServer().catch(() => {});
  }, []);

  useEffect(() => {
    reload();
    return onPushEvent(() => { reload(); });
  }, [reload]);

  if (!pushAvailable) return null;
  if (dists === null) return <ActivityIndicator color={colors.primaryText} />;

  const active = status?.endpoint ? dists.find((d) => d.packageName === status.distributor) : undefined;
  const pending = !active && status?.state === 'pending';
  const failed = status?.state?.startsWith('failed') ? status.state.slice(7) : null;

  async function enable(d: Distributor) {
    setBusy(true);
    try { await enablePush(d.packageName); await reload(); } catch (e: any) { showAlert(t('Failed'), e.message); }
    finally { setBusy(false); }
  }
  async function disable() {
    setBusy(true);
    try { await disablePush(); await reload(); } catch (e: any) { showAlert(t('Failed'), e.message); }
    finally { setBusy(false); }
  }

  return (
    <View style={styles.block}>
      <Text style={styles.note}>
        {t('Instant notifications via UnifiedPush. A distributor app such as ntfy only receives an empty wake-up — Mayfly shows the notification itself, so neither ntfy nor its server learns who sent you something. Without it, Mayfly checks every 15 minutes.')}
      </Text>
      {active ? (
        <View style={styles.statusRow}>
          <Icon name="bell-check-outline" size={20} color={colors.primaryText} />
          <Text style={styles.statusText}>{t('Active via {name}', { name: active.label })}</Text>
          <Button label={t('Turn off')} kind="tonal" onPress={disable} loading={busy} style={styles.smallBtn} />
        </View>
      ) : pending ? (
        <View style={styles.statusRow}>
          <ActivityIndicator color={colors.primaryText} size="small" />
          <Text style={styles.statusText}>{t('Waiting for the distributor…')}</Text>
          <Button label={t('Cancel')} kind="tonal" onPress={disable} style={styles.smallBtn} />
        </View>
      ) : dists.length === 0 ? (
        <View style={styles.statusRow}>
          <Icon name="bell-off-outline" size={20} color={colors.onSurfaceVariant} />
          <Text style={styles.statusText}>{t('No distributor installed. Install ntfy (F-Droid) and come back.')}</Text>
        </View>
      ) : (
        dists.map((d) => (
          <Button key={d.packageName} label={t('Use {name}', { name: d.label })} icon="bell-ring-outline" onPress={() => enable(d)} loading={busy} />
        ))
      )}
      {failed && <Text style={[styles.note, { color: colors.error }]}>Registration failed ({failed}).</Text>}
      {status && !status.notificationsEnabled && (
        <Text style={[styles.note, { color: colors.error }]}>{t('Notifications are turned off for Mayfly in Android settings.')}</Text>
      )}
    </View>
  );
}

/** Current + new password; on success all other sessions are logged out. */
function ChangePasswordModal({ visible, onClose, onChanged }: {
  visible: boolean; onClose: () => void; onChanged: (token: string) => Promise<void>;
}) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!visible) { setCur(''); setNext(''); setConfirm(''); } }, [visible]);
  async function submit() {
    if (next.length < 8) { showAlert(t('Too short'), t('The new password needs at least 8 characters.')); return; }
    if (next !== confirm) { showAlert(t('Mismatch'), t('The new passwords do not match.')); return; }
    setBusy(true);
    try {
      const token = await changePassword(cur, next);
      await onChanged(token);
      onClose();
      showAlert(t('Password changed'), t('All other devices and sessions were logged out.'));
    } catch (e: any) {
      showAlert(t('Failed'), e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBg}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>{t('Change password')}</Text>
          <Field label={t('Current password')} value={cur} onChangeText={setCur} secureTextEntry autoFocus />
          <Field label={t('New password (min 8)')} value={next} onChangeText={setNext} secureTextEntry />
          <Field label={t('Repeat new password')} value={confirm} onChangeText={setConfirm} secureTextEntry />
          <View style={styles.modalRow}>
            <Button label={t('Cancel')} kind="tonal" onPress={onClose} style={{ flex: 1 }} />
            <Button label={t('Change')} onPress={submit} loading={busy} disabled={!cur || !next || !confirm} style={{ flex: 1 }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** Theme choice. Styles are built at startup, so a change needs an app restart. */
function ThemeSection() {
  const [chosen, setChosen] = useState<ThemeName>(themeName);
  async function choose(th: ThemeName) {
    if (th === chosen) return;
    saveThemeName(th);
    setChosen(th);
    const now = await ask({
      title: t('Restart to apply'),
      message: t('The change is used the next time Mayfly starts.'),
      confirm: t('Restart now'),
      cancel: t('Later'),
      icon: 'palette-outline',
    });
    if (now) {
      if (NativeModules.MayflyApp?.restart) NativeModules.MayflyApp.restart();
      else BackHandler.exitApp();
    }
  }
  const opt = (th: ThemeName, label: string, sub: string, swatch: string) => (
    <TouchableOpacity key={th} style={[styles.themeOpt, chosen === th && styles.themeOptActive]} onPress={() => choose(th)} activeOpacity={0.8}>
      <View style={[styles.themeSwatch, { backgroundColor: swatch }]} />
      <View style={{ flex: 1 }}>
        <Text style={styles.themeLabel}>{label}</Text>
        <Text style={styles.note}>{sub}</Text>
      </View>
      <Icon name={chosen === th ? 'radiobox-marked' : 'radiobox-blank'} size={22} color={chosen === th ? colors.primaryText : colors.outline} />
    </TouchableOpacity>
  );
  return (
    <View style={styles.block}>
      {opt('black', t('Black'), t('Pure black — saves battery on OLED screens (default)'), '#000000')}
      {opt('dark', t('Dark'), t('Cool dark grey'), '#0F1413')}
      {opt('light', t('White'), t('Light design for bright surroundings'), '#FFFFFF')}
    </View>
  );
}

/** Opt-in birthday: day + month only, shared end-to-end encrypted with friends. */
function BirthdaySection() {
  useChatStoreVersion();
  useEffect(() => { loadChatStore(); }, []);
  const { bd, share } = myBirthday();
  const shown = bd ? `${bd.slice(3)}.${bd.slice(0, 2)}.` : t('Not set');
  async function push() {
    try {
      const f = await listFriends();
      await syncBirthday(f.map((x) => x.id));
    } catch (_) {
      // sent with the next sync of the chat list
    }
  }
  async function edit() {
    const v = await promptText({
      title: t('Your birthday'),
      message: t('Day and month only, e.g. 14.11. — no year.'),
      initial: bd ? `${bd.slice(3)}.${bd.slice(0, 2)}` : '',
      placeholder: 'DD.MM',
      maxLength: 6,
    });
    if (v === null) return;
    const m = v.trim().match(/^(\d{1,2})\.(\d{1,2})\.?$/);
    if (!v.trim()) {
      setMyBirthday({ bd: null });
    } else if (m) {
      const mmdd = `${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      setMyBirthday({ bd: mmdd });
      if (!myBirthday().bd) { showAlert(t('Invalid date'), t('Please enter day and month, e.g. 14.11.')); return; }
    } else {
      showAlert(t('Invalid date'), t('Please enter day and month, e.g. 14.11.'));
      return;
    }
    push();
  }
  return (
    <View style={styles.block}>
      <TouchableOpacity style={styles.bdRow} onPress={edit} activeOpacity={0.7}>
        <Icon name="cake-variant-outline" size={22} color={colors.onSurfaceVariant} />
        <Text style={[styles.themeLabel, { flex: 1 }]}>{shown}</Text>
        <Text style={styles.bdChange}>{bd ? t('Change') : t('Set')}</Text>
      </TouchableOpacity>
      <View style={styles.bdRow}>
        <Text style={[styles.note, { flex: 1 }]}>
          {t('Show a 🎂 next to my name for my friends on my birthday. Off by default. Only day and month, end-to-end encrypted — the server never sees it.')}
        </Text>
        <Switch
          value={share}
          disabled={!bd}
          onValueChange={(v) => { setMyBirthday({ share: v }); push(); }}
          trackColor={{ true: colors.primary, false: colors.surfaceContainerHighest }}
          thumbColor={share ? colors.onPrimaryContainer : colors.outline}
        />
      </View>
    </View>
  );
}

/** The connected server's limits, as it reports them (self-hosted servers may differ). */
function LimitsSection() {
  const [l, setL] = useState<ServerLimits | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { getServerLimits().then(setL).catch(() => setFailed(true)); }, []);
  const rows: [IconName, string][] = l ? [
    ['send-clock-outline', t('Up to {n} unopened moments per person at a time, {g} in a group chat.', { n: l.pending_moments_per_sender, g: l.pending_moments_per_group })],
    ['inbox-full-outline', l.pending_messages_per_sender
      ? t('Up to {n} unopened moments and {m} messages wait for one person, at most {p} of them from one sender (beyond that, that sender\'s own oldest drop).', { n: l.pending_moments_per_recipient, m: l.pending_messages_per_user, p: l.pending_messages_per_sender })
      : t('Up to {n} unopened moments and {m} messages wait for one person; then the oldest messages drop.', { n: l.pending_moments_per_recipient, m: l.pending_messages_per_user })],
    ['circle-slice-8', t('Active stories of one person: {mb} MB together.', { mb: l.story_mb })],
    ['account-group-outline', t('Groups with up to {n} members (invitations included).', { n: l.group_members })],
    ['timer-sand', t('Moments, stories and messages stay on the server for {h} hours at most.', { h: l.keep_hours })],
    ['phone-outline', t('Calls through the relay: up to {n} Mbit/s per connection.', { n: l.call_mbit })],
    ['harddisk', t('When less than {gb} GB of disk space is free, the server takes no new moments until there is room again.', { gb: Math.round(l.min_free_mb / 102.4) / 10 })],
  ] : [];
  return (
    <View style={styles.block}>
      {failed ? <Text style={styles.note}>{t('This server does not report its limits.')}</Text> : null}
      {!l && !failed ? <ActivityIndicator color={colors.primaryText} /> : null}
      {rows.map(([icon, text]) => (
        <View key={text} style={[styles.bdRow, { alignItems: 'flex-start' }]}>
          <Icon name={icon} size={20} color={colors.onSurfaceVariant} />
          <Text style={[styles.note, { flex: 1 }]}>{text}</Text>
        </View>
      ))}
    </View>
  );
}

function CallsSection() {
  useChatStoreVersion();
  const hide = callsHideIp();
  return (
    <View style={styles.block}>
      <View style={styles.bdRow}>
        <Icon name="phone-lock-outline" size={22} color={colors.onSurfaceVariant} />
        <Text style={[styles.note, { flex: 1 }]}>
          {t('Hide my IP address in calls: calls always go through the server\'s relay, so friends never see your IP address. The relay only forwards encrypted data. Off = direct connections when possible (a little faster).')}
        </Text>
        <Switch
          value={hide}
          onValueChange={(v) => setCallsHideIp(v)}
          trackColor={{ true: colors.primary, false: colors.surfaceContainerHighest }}
          thumbColor={hide ? colors.onPrimaryContainer : colors.outline}
        />
      </View>
    </View>
  );
}

const WEBSITE_URL = 'https://mayfly.paul42.de/';
const SOURCE_URL = 'https://github.com/hush1981/mayfly';

function VersionSection() {
  const [busy, setBusy] = useState(false);
  async function check() {
    setBusy(true);
    const name = await checkForUpdate(true).catch(() => null);
    setBusy(false);
    if (name) {
      showAlert(t('Mayfly {version} is available', { version: name }), t('Update it in F-Droid.'), [
        { text: t('Later'), style: 'cancel' },
        { text: t('Open F-Droid'), onPress: openUpdate },
      ], { icon: 'arrow-up-circle' });
    } else {
      showAlert(t('Up to date'), t('You have the newest version ({version}).', { version: installed.name || '?' }), undefined, { icon: 'check-circle-outline' });
    }
  }
  return (
    <View style={styles.block}>
      <Text style={styles.note}>Mayfly {installed.name || ''}</Text>
      <Button label={t('Check for updates')} kind="tonal" icon="update" loading={busy} onPress={check} />
      <Button label={t('Website')} kind="tonal" icon="web" onPress={() => Linking.openURL(WEBSITE_URL).catch(() => {})} />
      <Button label={t('Source code on GitHub')} kind="tonal" icon="github" onPress={() => Linking.openURL(SOURCE_URL).catch(() => {})} />
    </View>
  );
}

/** App language (System / Deutsch / English); applies after a restart like the theme. */
function LanguageSection() {
  const [chosen, setChosen] = useState<LangSetting>(langSetting);
  async function choose(v: LangSetting) {
    if (v === chosen) return;
    saveLangSetting(v);
    setChosen(v);
    const now = await ask({
      title: t('Restart to apply'),
      message: t('The change is used the next time Mayfly starts.'),
      confirm: t('Restart now'),
      cancel: t('Later'),
      icon: 'translate',
    });
    if (now) {
      if (NativeModules.MayflyApp?.restart) NativeModules.MayflyApp.restart();
      else BackHandler.exitApp();
    }
  }
  const opt = (v: LangSetting, label: string) => (
    <TouchableOpacity key={v} style={[styles.langOpt, chosen === v && styles.themeOptActive]} onPress={() => choose(v)} activeOpacity={0.8}>
      <Text style={[styles.themeLabel, { flex: 1 }]}>{label}</Text>
      <Icon name={chosen === v ? 'radiobox-marked' : 'radiobox-blank'} size={22} color={chosen === v ? colors.primaryText : colors.outline} />
    </TouchableOpacity>
  );
  return (
    <View style={styles.block}>
      {opt('system', t('Phone language'))}
      {opt('de', 'Deutsch')}
      {opt('en', 'English')}
    </View>
  );
}

function BlockedSection() {
  const [list, setList] = useState<User[] | null>(null);
  const load = useCallback(() => { listBlocked().then(setList).catch(() => setList([])); }, []);
  useEffect(() => { load(); }, [load]);
  async function unblock(u: User) {
    const ok = await ask({
      title: t('Unblock {name}?', { name: u.username }),
      message: t('You will not become friends again automatically — add each other again if you want to.'),
      confirm: t('Unblock'),
    });
    if (!ok) return;
    try {
      await unblockUser(u.id);
      await unblockLocally(u.id);
      load();
    } catch (e: any) {
      showAlert(t('Could not unblock'), e.message);
    }
  }
  return (
    <View style={styles.block}>
      {list === null ? <ActivityIndicator color={colors.primaryText} /> : list.length === 0 ? (
        <Text style={styles.note}>{t('Nobody blocked. Block someone from their chat menu (⋮) or the friends list.')}</Text>
      ) : list.map((u) => (
        <View key={u.id} style={styles.blockedRow}>
          <Icon name="block-helper" size={18} color={colors.error} />
          <Text style={[styles.themeLabel, { flex: 1 }]}>{u.username}</Text>
          <Button label={t('Unblock')} kind="tonal" onPress={() => unblock(u)} style={{ height: 36 }} />
        </View>
      ))}
    </View>
  );
}

export default function ProfileScreen(_: Props) {
  const { state, logout, login } = useAuth();
  const token = state.token ?? '';

  const [avatarKey, setAvatarKey] = useState(Date.now());
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<'rotate' | 'delete' | 'password' | null>(null);

  useEffect(() => { setLoading(false); }, []);

  async function pickAvatar() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      showAlert(t('Permission needed'), t('Gallery access is required to set a profile picture.'));
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (result.canceled || !result.assets[0]) return;
    setUploadingAvatar(true);
    try {
      await uploadAvatar(result.assets[0].uri);
      setAvatarKey(Date.now());
    } catch (e: any) {
      showAlert(t('Upload failed'), e.message);
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function doRotate(password: string) {
    try {
      const kp = generateKeyPair();
      await rotatePublicKey(kp.publicKey, password);
      await storePrivateKey(kp.secretKey);
      setModal(null);
      showAlert(t('New key active'), t('Moments that were sent to the old key can no longer be opened.'));
    } catch (e: any) {
      showAlert(t('Failed'), e.message);
    }
  }

  async function doDelete(password: string) {
    try {
      await deleteAccount(password);
      setModal(null);
      await deletePrivateKey();
      await logout();
    } catch (e: any) {
      showAlert(t('Failed'), e.message);
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
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <TouchableOpacity style={styles.header} onPress={pickAvatar} activeOpacity={0.7} disabled={uploadingAvatar}>
        <View>
          <Avatar
            key={avatarKey}
            uri={state.userId ? `${getAvatarUrl(state.userId)}?t=${avatarKey}` : null}
            token={token}
            name={state.username ?? '?'}
            size={64}
          />
          <View style={styles.editBadge}>
            {uploadingAvatar
              ? <ActivityIndicator color={colors.onPrimary} size="small" />
              : <Icon name="pencil" size={14} color={colors.onPrimary} />}
          </View>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.username}>{state.username}</Text>
          <Text style={styles.hint}>{t('Tap to change your picture — only friends and people on shared broadcast lists can see it.')}</Text>
        </View>
      </TouchableOpacity>

      <SectionLabel>{t('Server')}</SectionLabel>
      <View style={styles.block}>
        <ServerSetting />
      </View>

      <SectionLabel>{t('Push notifications')}</SectionLabel>
      <PushSection />

      <SectionLabel>{t('Appearance')}</SectionLabel>
      <ThemeSection />

      <SectionLabel>{t('Language')}</SectionLabel>
      <LanguageSection />

      <SectionLabel>{t('Birthday')}</SectionLabel>
      <BirthdaySection />

      <SectionLabel>{t('Calls')}</SectionLabel>
      <CallsSection />

      <SectionLabel>{t('Server limits')}</SectionLabel>
      <LimitsSection />

      <SectionLabel>{t('Blocked')}</SectionLabel>
      <BlockedSection />

      <SectionLabel>{t('Security')}</SectionLabel>
      <View style={styles.block}>
        <Text style={styles.note}>
          {t('Moments are end-to-end encrypted with a key that never leaves this phone. To check that nobody is in between, open a chat and compare the security code with your friend.')}
        </Text>
        <Button label={t('Create new key')} kind="tonal" icon="key-change" onPress={() => setModal('rotate')} />
      </View>

      <SectionLabel>{t('Version')}</SectionLabel>
      <VersionSection />

      <SectionLabel>{t('Account')}</SectionLabel>
      <View style={styles.block}>
        <Button label={t('Change password')} kind="tonal" icon="form-textbox-password" onPress={() => setModal('password')} />
        <Button label={t('Sign out')} kind="tonal" icon="logout" onPress={logout} />
        <Button label={t('Delete account')} kind="danger" icon="delete-outline" onPress={() => setModal('delete')} />
      </View>

      <ChangePasswordModal
        visible={modal === 'password'}
        onClose={() => setModal(null)}
        onChanged={(token) => login(token, state.userId!, state.username!)}
      />
      <PasswordModal
        visible={modal === 'rotate'}
        title={t('Create new key?')}
        body={t('Your friends will see that your security code changed. Unopened moments sent to the old key are lost.')}
        confirmLabel={t('Create')}
        onCancel={() => setModal(null)}
        onConfirm={doRotate}
      />
      <PasswordModal
        visible={modal === 'delete'}
        title={t('Delete account?')}
        body={t('Your account, friendships, broadcast lists you own and all pending moments are deleted from the server immediately. This cannot be undone.')}
        confirmLabel={t('Delete')}
        danger
        onCancel={() => setModal(null)}
        onConfirm={doDelete}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  themeOpt: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12,
    borderRadius: shape.medium, borderWidth: 1, borderColor: colors.outlineVariant,
  },
  themeOptActive: { borderColor: colors.primary },
  themeSwatch: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, borderColor: colors.outline },
  themeLabel: { ...typescale.bodyLarge, color: colors.onSurface },
  blockedRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bdRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  langOpt: {
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: shape.medium, borderWidth: 1, borderColor: colors.outlineVariant,
  },
  bdChange: { ...typescale.labelLarge, color: colors.primaryText },
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: 40 },
  center: { flex: 1, backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16 },
  editBadge: {
    position: 'absolute', right: -2, bottom: -2, width: 24, height: 24, borderRadius: 12,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: colors.background,
  },
  username: { ...typescale.titleLarge, fontWeight: '600', color: colors.onSurface },
  hint: { ...typescale.bodySmall, color: colors.onSurfaceVariant, marginTop: 2 },
  block: { paddingHorizontal: 16, gap: 8 },
  note: { ...typescale.bodySmall, color: colors.onSurfaceVariant, lineHeight: 17 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 46 },
  statusText: { ...typescale.bodyMedium, color: colors.onSurface, flex: 1 },
  smallBtn: { height: 38, paddingHorizontal: 14 },
  row: { flexDirection: 'row', gap: 8 },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: colors.surfaceContainerHigh, borderRadius: shape.large, padding: 18, gap: 10 },
  modalTitle: { ...typescale.titleMedium, fontWeight: '600', color: colors.onSurface },
  modalBody: { ...typescale.bodyMedium, color: colors.onSurfaceVariant },
  modalRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
});
