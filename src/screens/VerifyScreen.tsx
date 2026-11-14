import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { colors, shape, typescale } from '../theme';
import { Button, Icon } from '../ui/kit';
import QrCode from '../ui/QrCode';
import { chooseAndScanQr } from '../qr/scan';
import {
  checkScannedPayload, isVerified, markVerified, securityCodeWith, unmarkVerified, verifyQrPayload,
} from '../crypto/peerKeys';
import { showAlert } from '../ui/dialog';
import { t } from '../i18n';

type Props = NativeStackScreenProps<RootStackParamList, 'Verify'>;

/**
 * Verify a chat: both phones show the same security code (derived from both public keys).
 * Scanning the friend's QR code compares it automatically; a match marks the friend's
 * current key as verified. If the key ever changes, the mark is gone.
 */
export default function VerifyScreen({ route, navigation }: Props) {
  const { peerId, peerName } = route.params;
  const [code, setCode] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [result, setResult] = useState<'match' | 'mismatch' | 'invalid' | null>(null);

  const load = useCallback(async () => {
    try {
      setCode(await securityCodeWith(peerId));
      setVerified(await isVerified(peerId));
    } catch (e: any) {
      showAlert(t('Not available'), e.message);
      navigation.goBack();
    }
  }, [peerId, navigation]);

  useEffect(() => { navigation.setOptions({ title: t('Verify {name}', { name: peerName }) }); load(); }, [load, navigation, peerName]);

  async function startScan() {
    setResult(null);
    try {
      const data = await chooseAndScanQr();
      if (data) await onScanned(data);
    } catch (e: any) {
      showAlert(t('Scanner'), e.message);
    }
  }

  async function onScanned(data: string) {
    if (!code) return;
    // Re-derive the code right now, so a key that changed meanwhile cannot slip through.
    const fresh = await securityCodeWith(peerId);
    const r = checkScannedPayload(data, fresh);
    setResult(r);
    if (r === 'match') {
      await markVerified(peerId);
      setVerified(true);
    }
  }

  function manualVerify() {
    showAlert(
      t('Mark as verified?'),
      t('Only do this if you compared all 30 digits with {name} in person or over a channel you trust.', { name: peerName }),
      [
        { text: t('Cancel'), style: 'cancel' },
        { text: t('They match'), onPress: async () => { await markVerified(peerId); setVerified(true); } },
      ],
    );
  }

  if (!code) {
    return <View style={styles.center}><ActivityIndicator color={colors.primaryText} /></View>;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={[styles.status, verified ? styles.statusOk : styles.statusOpen]}>
        <Icon
          name={verified ? 'shield-check' : 'shield-outline'}
          size={20}
          color={verified ? colors.onTertiaryContainer : colors.onSurfaceVariant}
        />
        <Text style={[styles.statusText, verified && { color: colors.onTertiaryContainer }]}>
          {verified ? t('{name} is verified', { name: peerName }) : t('{name} is not verified yet', { name: peerName })}
        </Text>
      </View>

      <View style={styles.qrWrap}>
        <QrCode value={verifyQrPayload(code)} size={220} />
      </View>

      {result === 'match' && (
        <Text style={[styles.result, { color: colors.tertiary }]}>{t('Codes match — verified.')}</Text>
      )}
      {result === 'mismatch' && (
        <Text style={[styles.result, { color: colors.error }]}>
          {t("Codes do NOT match. Someone may be in between, or one of you has a new key. Don't send anything sensitive.")}
        </Text>
      )}
      {result === 'invalid' && (
        <Text style={[styles.result, { color: colors.error }]}>{t('That is not an Mayfly verification code.')}</Text>
      )}

      <Text style={styles.code}>{code}</Text>
      <Text style={styles.hint}>
        {t("Scan {name}'s code (their phone: chat with you → shield). Both phones show the same code; if it matches, nobody — not even the server — can read your moments and messages.", { name: peerName })}
      </Text>

      <Button label={t("Scan {name}'s code", { name: peerName })} icon="qrcode-scan" onPress={startScan} />
      {!verified ? (
        <Button label={t('Compared the digits — mark verified')} kind="text" onPress={manualVerify} />
      ) : (
        <Button
          label={t('Remove verification')}
          kind="text"
          onPress={async () => { await unmarkVerified(peerId); setVerified(false); setResult(null); }}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 12, alignItems: 'stretch' },
  center: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  status: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: shape.medium, paddingHorizontal: 12, paddingVertical: 10,
  },
  statusOk: { backgroundColor: colors.tertiaryContainer },
  statusOpen: { backgroundColor: colors.surfaceContainer },
  statusText: { ...typescale.bodyMedium, color: colors.onSurface, flex: 1 },
  qrWrap: { alignItems: 'center', paddingVertical: 4 },
  result: { ...typescale.bodyMedium, textAlign: 'center' },
  code: {
    ...typescale.titleMedium, color: colors.onSurface, textAlign: 'center',
    fontVariant: ['tabular-nums'], letterSpacing: 1.5, lineHeight: 26,
  },
  hint: { ...typescale.bodySmall, color: colors.onSurfaceVariant, textAlign: 'center' },
});
