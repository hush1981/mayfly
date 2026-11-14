/**
 * Full-screen call: ringing (in / out), connecting, running. Video calls show the friend
 * full screen and me small (mirrored). No screenshots while a call is open.
 */
import React, { useEffect, useState } from 'react';
import { BackHandler, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import * as ScreenCapture from 'expo-screen-capture';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RootStackParamList } from '../types';
import {
  answer, callDuration, decline, deviceLocked, flipCamera, hangUp, toggleCamera, toggleMute, toggleSpeaker, useCall,
} from '../calls/manager';
import { getAvatarUrl } from '../api/users';
import { useAuth } from '../store/AuthProvider';
import { Avatar, Icon, IconName } from '../ui/kit';
import { getGroupAvatarUrl } from '../api/groups';
import { showAlert } from '../ui/dialog';
import { colors, typescale } from '../theme';
import { t } from '../i18n';

type Props = NativeStackScreenProps<RootStackParamList, 'Call'>;

function RoundBtn({ icon, onPress, active, danger, label, big }: {
  icon: IconName; onPress: () => void; active?: boolean; danger?: boolean; label: string; big?: boolean;
}) {
  return (
    <View style={styles.btnWrap}>
      <TouchableOpacity
        onPress={onPress}
        style={[styles.btn, big && styles.btnBig, active && styles.btnActive, danger && styles.btnDanger]}
        activeOpacity={0.8}
        accessibilityLabel={label}
      >
        <Icon name={icon} size={big ? 32 : 26} color={active ? '#000' : '#fff'} />
      </TouchableOpacity>
      <Text style={styles.btnLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

export default function CallScreen({ navigation }: Props) {
  const c = useCall();
  const insets = useSafeAreaInsets();
  const { state } = useAuth();
  const [, tick] = useState(0);

  useEffect(() => {
    ScreenCapture.preventScreenCaptureAsync('call').catch(() => {});
    return () => { ScreenCapture.allowScreenCaptureAsync('call').catch(() => {}); };
  }, []);

  useEffect(() => {
    if (c.phase !== 'connected') return;
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [c.phase]);

  useEffect(() => {
    if (c.phase === 'idle') {
      if (navigation.canGoBack()) navigation.goBack(); else navigation.navigate('Home');
    }
  }, [c.phase, navigation]);

  // On a locked phone (call answered from the lock screen) "back" must not lead into the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      deviceLocked().then((locked) => {
        if (!locked && navigation.isFocused()) {
          if (navigation.canGoBack()) navigation.goBack(); else navigation.navigate('Home');
        }
      });
      return true;
    });
    return () => sub.remove();
  }, [navigation]);

  const status =
    c.phase === 'outgoing' ? t('Ringing…')
    : c.phase === 'incoming' ? (c.video ? t('Incoming video call') : t('Incoming call'))
    : c.phase === 'connecting' ? t('Connecting…')
    : c.phase === 'connected' ? callDuration()
    : c.phase === 'ended' ? (c.endReason === 'decline' ? t('Declined') : c.endReason === 'busy' ? t('Busy') : c.endReason === 'failed' ? t('Connection failed') : t('Call ended'))
    : '';

  const isGroup = !!c.group;
  const showRemoteVideo = !isGroup && c.video && c.phase === 'connected' && !!c.remoteUrl;
  const showGrid = isGroup && c.phase !== 'incoming' && c.peers.length > 0;
  const title = isGroup ? c.groupName ?? '' : c.peerName ?? '';
  const groupStatus = isGroup && c.phase === 'incoming'
    ? t('{name} is calling', { name: c.peerName ?? '?' })
    : isGroup && c.phase === 'outgoing' ? t('Ringing everyone…')
    : isGroup && c.phase === 'connecting' && c.peers.length === 0 ? t('Waiting for others…')
    : status;

  async function accept(video?: boolean) {
    try {
      await answer(video);
    } catch (e: any) {
      showAlert(t('Call failed'), e?.message ?? String(e));
    }
  }

  return (
    <View style={styles.container}>
      {/* (audio plays without a view; the remote video only when there is one) */}
      {showRemoteVideo ? (
        <RTCView streamURL={c.remoteUrl!} style={StyleSheet.absoluteFill} objectFit="cover" zOrder={0} />
      ) : null}

      {showGrid && (
        <View style={[styles.grid, { paddingTop: insets.top + 56, paddingBottom: insets.bottom + 200 }]}>
          {c.peers.map((p) => (
            <View key={p.id} style={[styles.tile, c.peers.length === 1 && styles.tileFull, c.peers.length > 4 && styles.tileSmall]}>
              {c.video && p.url ? (
                <RTCView streamURL={p.url} style={StyleSheet.absoluteFill} objectFit="cover" zOrder={0} />
              ) : (
                <Avatar uri={getAvatarUrl(p.id)} token={state.token ?? ''} name={p.name} size={64} />
              )}
              <View style={styles.tileName}>
                <Text style={styles.tileNameText} numberOfLines={1}>{p.name}{p.connected ? '' : ` · ${t('connecting…')}`}</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {showGrid && (
        <View style={[styles.topInfo, { top: insets.top + 12 }]}>
          <Text style={styles.nameSmall} numberOfLines={1}>{title}</Text>
          <Text style={styles.statusSmall}>{groupStatus} · {c.peers.length + 1}</Text>
        </View>
      )}

      {!showRemoteVideo && !showGrid && (
        <View style={styles.center}>
          {isGroup && c.group ? (
            <Avatar uri={getGroupAvatarUrl(c.group)} token={state.token ?? ''} name={title} size={112} icon="account-group" />
          ) : c.peerId ? <Avatar uri={getAvatarUrl(c.peerId)} token={state.token ?? ''} name={c.peerName ?? '?'} size={112} /> : null}
          <Text style={styles.name} numberOfLines={1}>{title}</Text>
          <Text style={styles.status}>{isGroup ? groupStatus : status}</Text>
          <View style={styles.e2e}>
            <Icon name="lock" size={12} color="rgba(255,255,255,0.7)" />
            <Text style={styles.e2eText}>{t('End-to-end encrypted')}</Text>
          </View>
        </View>
      )}

      {showRemoteVideo && (
        <View style={[styles.topInfo, { top: insets.top + 12 }]}>
          <Text style={styles.nameSmall}>{c.peerName}</Text>
          <Text style={styles.statusSmall}>{status}</Text>
        </View>
      )}

      {c.video && c.localUrl && !c.camOff && c.phase !== 'ended' ? (
        <View style={[styles.self, { top: insets.top + 12 }]}>
          <RTCView streamURL={c.localUrl} style={StyleSheet.absoluteFill} objectFit="cover" mirror={c.front} zOrder={1} />
        </View>
      ) : null}

      <View style={[styles.controls, { paddingBottom: insets.bottom + 28 }]}>
        {c.phase === 'incoming' ? (
          <View style={styles.row}>
            <RoundBtn icon="phone-hangup" danger big label={t('Decline')} onPress={decline} />
            {c.video && <RoundBtn icon="phone" label={t('Audio only')} onPress={() => accept(false)} />}
            <RoundBtn icon={c.video ? 'video' : 'phone'} big active label={isGroup ? t('Join') : t('Answer')} onPress={() => accept()} />
          </View>
        ) : (
          <>
            <View style={styles.row}>
              <RoundBtn icon={c.muted ? 'microphone-off' : 'microphone'} active={c.muted} label={c.muted ? t('Unmute') : t('Mute')} onPress={toggleMute} />
              <RoundBtn icon={c.speaker ? 'volume-high' : 'volume-medium'} active={c.speaker} label={t('Speaker')} onPress={toggleSpeaker} />
              {c.video && <RoundBtn icon={c.camOff ? 'video-off' : 'video'} active={c.camOff} label={t('Camera')} onPress={toggleCamera} />}
              {c.video && <RoundBtn icon="camera-flip-outline" label={t('Flip')} onPress={flipCamera} />}
            </View>
            <View style={styles.row}>
              <RoundBtn icon="phone-hangup" danger big label={t('End call')} onPress={hangUp} />
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 24, paddingBottom: 140 },
  name: { ...typescale.headlineSmall, color: '#fff', fontWeight: '700', marginTop: 12 },
  status: { ...typescale.bodyLarge, color: 'rgba(255,255,255,0.8)' },
  e2e: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  e2eText: { ...typescale.labelSmall, color: 'rgba(255,255,255,0.7)' },
  grid: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', flexWrap: 'wrap', alignContent: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 6 },
  tile: {
    width: '48%', aspectRatio: 3 / 4, borderRadius: 14, overflow: 'hidden', backgroundColor: '#1c1c22',
    alignItems: 'center', justifyContent: 'center',
  },
  tileFull: { width: '96%', aspectRatio: 3 / 4 },
  tileSmall: { width: '31%' },
  tileName: { position: 'absolute', left: 6, bottom: 6, right: 6, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  tileNameText: { ...typescale.labelSmall, color: '#fff' },
  topInfo: { position: 'absolute', left: 16, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6 },
  nameSmall: { ...typescale.titleSmall, color: '#fff', fontWeight: '700' },
  statusSmall: { ...typescale.labelSmall, color: 'rgba(255,255,255,0.8)' },
  self: {
    position: 'absolute', right: 12, width: 108, height: 152, borderRadius: 14, overflow: 'hidden',
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.8)', backgroundColor: '#222',
  },
  controls: { position: 'absolute', left: 0, right: 0, bottom: 0, gap: 18 },
  row: { flexDirection: 'row', justifyContent: 'space-evenly', alignItems: 'flex-start' },
  btnWrap: { alignItems: 'center', gap: 6, width: 84 },
  btn: { width: 58, height: 58, borderRadius: 29, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  btnBig: { width: 70, height: 70, borderRadius: 35 },
  btnActive: { backgroundColor: '#fff' },
  btnDanger: { backgroundColor: colors.error },
  btnLabel: { ...typescale.labelSmall, color: 'rgba(255,255,255,0.85)' },
});
