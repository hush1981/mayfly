import React, { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { login } from '../api/auth';
import { getServerUrl, getStoredServerUrl, saveServerUrl } from '../api/client';
import { generateKeyPair, getOwnPublicKey, hasPrivateKey, storePrivateKey } from '../crypto/keys';
import { rotatePublicKey } from '../api/users';
import { useAuth } from '../store/AuthProvider';
import { colors, shape, typescale } from '../theme';
import { Button, Field, Icon } from '../ui/kit';
import { API_BASE_URL } from '../config';
import { showAlert } from '../ui/dialog';
import { t } from '../i18n';

type Props = NativeStackScreenProps<RootStackParamList, 'Login'>;

export function ServerSetting() {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [current, setCurrent] = useState(getServerUrl());

  useEffect(() => { getStoredServerUrl().then(setUrl); }, []);

  async function save() {
    try {
      await saveServerUrl(url.trim());
      setCurrent(getServerUrl());
      setEditing(false);
    } catch (e: any) {
      showAlert(t('Invalid server'), e.message);
    }
  }

  if (!editing) {
    return (
      <TouchableOpacity style={styles.serverRow} onPress={() => setEditing(true)} activeOpacity={0.6}>
        <Icon name="server-network" size={16} color={colors.onSurfaceVariant} />
        <Text style={styles.serverText} numberOfLines={1}>{current.replace(/^https?:\/\//, '')}</Text>
        <Text style={styles.serverChange}>{t('Change')}</Text>
      </TouchableOpacity>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      <Field
        label={t('Server URL (empty = default)')}
        value={url}
        onChangeText={setUrl}
        placeholder={API_BASE_URL}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label={t('Cancel')} kind="tonal" onPress={() => setEditing(false)} style={{ flex: 1 }} />
        <Button label={t('Use server')} onPress={save} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

export default function LoginScreen({ navigation }: Props) {
  const { login: storeLogin, state } = useAuth();
  // Session ended by the server: the account (and its chats) are still on this phone.
  const expired = !!state.userId && !!state.username;
  const [username, setUsername] = useState(state.username ?? '');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    if (!username.trim() || !password) return;
    setLoading(true);
    try {
      const res = await login(username.trim(), password);
      // The key on this phone must be the one the server has for this account. It is not
      // after a reinstall, on a new phone, or when another account used this phone before.
      const mine = (await hasPrivateKey()) ? await getOwnPublicKey().catch(() => null) : null;
      if (!mine || (res.public_key && res.public_key !== mine)) {
        // The private key never leaves the device it was created on. On a new device
        // (or after a reinstall) a fresh key is created and registered with the password.
        const ok = await new Promise<boolean>((resolve) => showAlert(
          t('New device'),
          t('This device has no key for your account yet. A new key will be created; moments that were sent to your old key cannot be opened any more, and your friends will see that your security code changed.'),
          [
            { text: t('Cancel'), style: 'cancel', onPress: () => resolve(false) },
            { text: t('Create key'), onPress: () => resolve(true) },
          ],
          { icon: 'key-plus' },
        ));
        if (!ok) return;
        const kp = generateKeyPair();
        await rotatePublicKey(kp.publicKey, password, res.token);
        await storePrivateKey(kp.secretKey);
      }
      await storeLogin(res.token, res.user_id, res.username);
    } catch (e: any) {
      showAlert(t('Login failed'), e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.brand}>
          <View style={styles.brandMark}>
            <Icon name="camera-iris" size={30} color={colors.onPrimary} />
          </View>
          <View>
            <Text style={styles.title}>Mayfly</Text>
            <Text style={styles.subtitle}>{t('Private. Ephemeral. Yours.')}</Text>
          </View>
        </View>

        {expired && (
          <View style={styles.notice}>
            <Icon name="clock-alert-outline" size={18} color={colors.onSurfaceVariant} />
            <Text style={styles.noticeText}>
              {t('Your session has ended. Log in again — your chats are still on this phone.')}
            </Text>
          </View>
        )}

        <View style={styles.fields}>
          <Field label={t('Username')} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} />
          <Field
            label={t('Password')} value={password} onChangeText={setPassword} secureTextEntry
            onSubmitEditing={handleLogin} returnKeyType="go"
          />
        </View>

        <Button label={t('Log in')} onPress={handleLogin} loading={loading} />
        <Button label={t('Create account')} kind="tonal" onPress={() => navigation.navigate('Register')} style={{ marginTop: 8 }} />

        <View style={styles.serverWrap}>
          <ServerSetting />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  container: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 32 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 28 },
  brandMark: {
    width: 56, height: 56, borderRadius: shape.large,
    backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center',
  },
  title: { ...typescale.headlineSmall, fontWeight: '700', color: colors.onBackground },
  subtitle: { ...typescale.bodyMedium, color: colors.onSurfaceVariant },
  fields: { gap: 10, marginBottom: 16 },
  notice: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14,
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: shape.medium, backgroundColor: colors.surfaceVariant,
  },
  noticeText: { ...typescale.bodySmall, color: colors.onSurfaceVariant, flex: 1 },
  serverWrap: { marginTop: 24 },
  serverRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 10, paddingHorizontal: 4,
  },
  serverText: { ...typescale.bodySmall, color: colors.onSurfaceVariant, flex: 1 },
  serverChange: { ...typescale.labelMedium, color: colors.primaryText },
});
