import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { register, login } from '../api/auth';
import { generateAndStoreKeyPair } from '../crypto/keys';
import { useAuth } from '../store/AuthProvider';
import { colors, shape, typescale } from '../theme';
import { Icon } from '../ui/kit';
import { showAlert } from '../ui/dialog';
import { t } from '../i18n';

type Props = NativeStackScreenProps<RootStackParamList, 'Register'>;

export default function RegisterScreen({ navigation }: Props) {
  const { login: storeLogin } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [invite, setInvite] = useState('');
  const [loading, setLoading] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);

  async function handleRegister() {
    if (!username.trim() || !password || !confirm) return;
    if (password !== confirm) {
      showAlert(t('Passwords do not match'));
      return;
    }
    if (password.length < 8) {
      showAlert(t('Password must be at least 8 characters'));
      return;
    }

    setLoading(true);
    try {
      const publicKey = await generateAndStoreKeyPair();
      await register(username.trim(), password, publicKey, invite.trim() || undefined);
      const res = await login(username.trim(), password);
      await storeLogin(res.token, res.user_id, res.username);
    } catch (e: any) {
      showAlert(t('Registration failed'), e.message);
    } finally {
      setLoading(false);
    }
  }

  const field = (
    key: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
    opts?: { secure?: boolean },
  ) => (
    <View style={[styles.fieldWrap, focusedField === key && styles.fieldFocused]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.fieldInput}
        value={value}
        onChangeText={onChange}
        onFocus={() => setFocusedField(key)}
        onBlur={() => setFocusedField(null)}
        secureTextEntry={opts?.secure}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={colors.onSurfaceVariant}
      />
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.noticeCard}>
          <Icon name="shield-lock-outline" size={20} color={colors.onTertiaryContainer} />
          <Text style={styles.noticeText}>
            {t('Your encryption key is created on this device and never leaves it. No email or phone number is needed. If you reinstall the app, unopened moments cannot be recovered.')}
          </Text>
        </View>

        <View style={styles.fields}>
          {field('user', t('Username'), username, setUsername)}
          {field('pass', t('Password (min 8 characters)'), password, setPassword, { secure: true })}
          {field('conf', t('Confirm password'), confirm, setConfirm, { secure: true })}
          {field('inv', t('Invite code (only if your server needs one)'), invite, setInvite)}
        </View>

        <TouchableOpacity
          style={[styles.btn, loading && styles.btnDisabled]}
          onPress={handleRegister}
          disabled={loading}
          activeOpacity={0.85}
        >
          <Text style={styles.btnText}>{loading ? t('Creating account…') : t('Create account')}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.tonalBtn}
          onPress={() => navigation.goBack()}
          activeOpacity={0.85}
        >
          <Text style={styles.tonalBtnText}>{t('Already have an account')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1, justifyContent: 'center',
    paddingHorizontal: 20, paddingVertical: 24,
  },
  title: {
    ...typescale.headlineLarge,
    color: colors.onBackground,
    marginBottom: 24,
  },
  noticeCard: {
    backgroundColor: colors.tertiaryContainer,
    borderRadius: shape.medium,
    padding: 12, flexDirection: 'row',
    alignItems: 'flex-start', gap: 10,
    marginBottom: 16,
  },
  noticeIcon: { fontSize: 20, lineHeight: 22 },
  noticeText: {
    ...typescale.bodyMedium,
    color: colors.onTertiaryContainer,
    flex: 1, lineHeight: 20,
  },
  fields: { gap: 10, marginBottom: 16 },
  fieldWrap: {
    backgroundColor: colors.surfaceContainer,
    borderRadius: shape.medium,
    paddingHorizontal: 14, paddingTop: 7, paddingBottom: 6,
    borderWidth: 1, borderColor: colors.outlineVariant,
  },
  fieldFocused: {
    borderColor: colors.primary,
    backgroundColor: colors.surfaceContainerHigh,
  },
  fieldLabel: {
    ...typescale.labelMedium,
    color: colors.onSurfaceVariant,
    marginBottom: 2,
  },
  fieldInput: {
    ...typescale.bodyLarge,
    color: colors.onSurface,
    padding: 0,
  },
  btn: {
    backgroundColor: colors.primary,
    borderRadius: shape.medium,
    paddingVertical: 13, alignItems: 'center',
    marginBottom: 12,
  },
  btnDisabled: { opacity: 0.4 },
  btnText: {
    ...typescale.labelLarge,
    color: colors.onPrimary,
    fontSize: 15,
  },
  tonalBtn: {
    backgroundColor: colors.surfaceContainerHigh,
    borderRadius: shape.medium,
    paddingVertical: 13, alignItems: 'center',
  },
  tonalBtnText: {
    ...typescale.labelLarge,
    color: colors.onSurface,
    fontSize: 15,
  },
});
