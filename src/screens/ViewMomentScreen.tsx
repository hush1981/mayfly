import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, Animated, Easing,
} from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as ScreenCapture from 'expo-screen-capture';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { encodeBase64 } from 'tweetnacl-util';
import { RootStackParamList } from '../types';
import { unwrapMedia } from '../crypto/encryption';
import { decryptLocal, fetchIncoming } from '../media/local';
import { LinkChip, ShownMedia, MomentMedia } from '../ui/MomentMedia';
import { colors, shape, typescale } from '../theme';
import {
  dropFile, getMoment, isGroupChat, loadChatStore, updateMoment, useChatStoreVersion,
} from '../store/chatStore';
import { authorName, displayName, quoteOf, sendReceipt } from '../sync/sync';
import { readMomentPayload } from '../send/payload';
import { toggleSaved } from './ChatScreen';
import { Icon, IconButton } from '../ui/kit';
import { t } from '../i18n';

type Props = NativeStackScreenProps<RootStackParamList, 'ViewMoment'>;
type Phase = 'loading' | 'viewing' | 'error';

/** Photos carry their filter baked in; videos are filtered while playing. */
function type0(mediaType: 'image' | 'video', filter?: string) {
  return mediaType === 'video' ? filter : undefined;
}

export default function ViewMomentScreen({ route, navigation }: Props) {
  const { momentId, peerId, mode } = route.params;
  const insets = useSafeAreaInsets();
  useChatStoreVersion();
  const moment = getMoment(momentId, peerId);

  const [phase, setPhase] = useState<Phase>('loading');
  const [shown, setShown] = useState<ShownMedia>({});
  const [link, setLink] = useState<string | undefined>();
  const [mediaType, setMediaType] = useState<'image' | 'video'>(moment?.mediaType === 'video' ? 'video' : 'image');
  const [caption, setCaption] = useState('');
  const [dur, setDur] = useState(10);
  const [reply, setReply] = useState<string | undefined>();
  const [errorMsg, setErrorMsg] = useState('');
  const tempUriRef = useRef<string[]>([]);
  const closedRef = useRef(false);
  const progress = useRef(new Animated.Value(0)).current;

  const close = useCallback(async () => {
    if (closedRef.current) return;
    closedRef.current = true;
    progress.stopAnimation();
    for (const f of tempUriRef.current) FileSystem.deleteAsync(f, { idempotent: true }).catch(() => {});
    // ONE extra view in total: after the replay the copy is gone (unless it was saved
    // meanwhile — saved moments stay visible in the chat).
    if (mode === 'replay' && !getMoment(momentId, peerId)?.saved) await dropFile(momentId, peerId);
    navigation.goBack();
  }, [mode, navigation, peerId, progress, momentId]);

  useEffect(() => {
    ScreenCapture.preventScreenCaptureAsync();
    return () => { ScreenCapture.allowScreenCaptureAsync(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadChatStore();
      const s = getMoment(momentId, peerId);
      try {
        if (!s) throw new Error(t('This moment is no longer available.'));
        if (s.unsent) throw new Error(t('This moment was unsent.'));
        let plain: Uint8Array;
        let type: 'image' | 'video' = s.mediaType === 'video' ? 'video' : 'image';

        if (mode === 'first') {
          if (s.dir !== 'in' || s.status !== 'pending') throw new Error(t('This moment was already opened.'));
          // checks the key first (a pending key change burns nothing), then downloads,
          // verifies the sender, keeps the local copy and deletes the server copy
          const r = await fetchIncoming(s);
          plain = r.plain;
          if (r.type === 'video' || r.type === 'image') type = r.type;
          const info = readMomentPayload(unwrapMedia(plain).header, unwrapMedia(plain).mediaBytes);
          updateMoment(momentId, peerId, {
            mediaType: type, dur: type === 'image' ? info.dur : undefined, replyTo: info.replyTo, filter: info.filter,
          });
        } else {
          if (!s.file) throw new Error(t('This moment is no longer stored on this device.'));
          if (mode === 'replay' && (s.dir !== 'in' || s.status !== 'opened')) {
            throw new Error(t('This moment was already replayed.'));
          }
          plain = await decryptLocal(s);
          if (mode === 'replay') {
            updateMoment(momentId, peerId, { status: 'replayed', replayedAt: new Date().toISOString() });
            sendReceipt(s, 'replayed');
          } else if (mode === 'saved' && !s.saved) {
            throw new Error(t('This moment is not saved any more.'));
          }
        }
        if (cancelled) return;

        const { header, mediaBytes } = unwrapMedia(plain);
        const info = readMomentPayload(header, mediaBytes);
        setCaption(info.caption);
        setMediaType(type);
        setDur(mode === 'saved' ? 0 : info.dur);
        setReply(info.replyTo?.q);
        setLink(info.link);
        const m: ShownMedia = { aspect: info.aspect, filter: type0(type, info.filter), speed: info.speed, muted: info.muted };
        if (info.overlay) m.overlay = `data:image/png;base64,${encodeBase64(info.overlay)}`;
        if (type === 'image') {
          m.image = `data:image/jpeg;base64,${encodeBase64(info.media)}`;
        } else {
          const tempPath = `${FileSystem.cacheDirectory}view_${momentId}.mp4`;
          tempUriRef.current.push(tempPath);
          await FileSystem.writeAsStringAsync(tempPath, encodeBase64(info.media), {
            encoding: FileSystem.EncodingType.Base64,
          });
          m.video = tempPath;
          if (info.dual) {
            const insetPath = `${FileSystem.cacheDirectory}view_${momentId}_2.mp4`;
            tempUriRef.current.push(insetPath);
            await FileSystem.writeAsStringAsync(insetPath, encodeBase64(info.dual.inset), {
              encoding: FileSystem.EncodingType.Base64,
            });
            m.inset = insetPath;
            m.dual = { rect: info.dual.rect, main: info.dual.main, layout: info.dual.layout };
          }
        }
        setShown(m);
        setPhase('viewing');
      } catch (e: any) {
        if (cancelled) return;
        setErrorMsg(e?.message || t('Could not decrypt moment'));
        setPhase('error');
      }
    })();
    return () => { cancelled = true; };
  }, [mode, peerId, momentId]);

  // Photos close by themselves after the view time the sender chose (0 = until closed).
  useEffect(() => {
    if (phase !== 'viewing' || mediaType !== 'image' || dur <= 0) return;
    Animated.timing(progress, {
      toValue: 1, duration: dur * 1000, easing: Easing.linear, useNativeDriver: false,
    }).start(({ finished }) => { if (finished) close(); });
  }, [phase, mediaType, dur, progress, close]);

  const name = moment ? displayName(moment) : '';

  if (phase === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={styles.loadingText}>{t('Decrypting…')}</Text>
      </View>
    );
  }

  if (phase === 'error') {
    return (
      <View style={[styles.center, { padding: 24 }]}>
        <Icon name="alert-circle-outline" size={40} color={colors.error} />
        <Text style={styles.errorTitle}>{t('Could not open moment')}</Text>
        <Text style={styles.errorDetail}>{errorMsg}</Text>
        <TouchableOpacity style={styles.errorBtn} onPress={() => navigation.goBack()} activeOpacity={0.85}>
          <Text style={styles.errorBtnText}>{t('Close')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const saved = !!moment?.saved;
  const label = mode === 'replay' ? t('Last view') : mode === 'saved' ? t('Saved') : null;

  return (
    <TouchableOpacity style={styles.container} activeOpacity={1} onPress={close}>
      <MomentMedia m={shown} loop={mode === 'saved'} onEnd={() => { if (mode !== 'saved') close(); }} />

      <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
        {mediaType === 'image' && dur > 0 && (
          <View style={styles.track}>
            <Animated.View
              style={[styles.trackFill, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['100%', '0%'] }) }]}
            />
          </View>
        )}
        <View style={styles.topRow}>
          <View style={styles.senderChip}>
            <Text style={styles.senderName}>{moment ? authorName(moment) : name}</Text>
            {moment?.groupName ? <Text style={styles.senderMeta}> · {moment.groupName}</Text> : null}
            {moment && isGroupChat(moment.peerId) ? <Text style={styles.senderMeta}> · {name}</Text> : null}
            {label ? <Text style={styles.senderMeta}> · {label}</Text> : null}
            {reply ? (
              <Text style={styles.senderMeta} numberOfLines={1} accessibilityLabel={t('Reply to: {text}', { text: reply })}>
                {'  '}<Icon name="reply" size={13} color="rgba(255,255,255,0.75)" /> {reply}
              </Text>
            ) : null}
          </View>
          <View style={{ flex: 1 }} />
          {moment && (
            <IconButton
              name={saved ? 'bookmark' : 'bookmark-outline'}
              color={saved ? colors.primary : '#fff'}
              style={styles.saveBtn}
              onPress={() => { const cur = getMoment(momentId, peerId); if (cur) toggleSaved(cur); }}
              accessibilityLabel={saved ? t('Unsave') : t('Save in chat')}
            />
          )}
          <IconButton name="close" color="#fff" style={styles.saveBtn} onPress={close} accessibilityLabel={t('Close')} />
        </View>
      </View>

      {caption !== '' && (
        <View style={styles.captionBar} pointerEvents="none">
          <View style={styles.captionPill}>
            <Text style={styles.captionText}>{caption}</Text>
          </View>
        </View>
      )}

      {link ? (
        <View style={[styles.linkRow, { bottom: insets.bottom + (moment?.dir === 'in' ? 80 : 24) }]}>
          <LinkChip url={link} onBeforeOpen={() => progress.stopAnimation()} />
        </View>
      ) : null}

      {moment?.dir === 'in' && (
        <TouchableOpacity
          style={[styles.replyBtn, { bottom: insets.bottom + 24 }]}
          onPress={() => {
            const cur = getMoment(momentId, peerId);
            closedRef.current = true;
            progress.stopAnimation();
            navigation.replace('Camera', { peerId, peerName: name, replyTo: cur ? quoteOf(cur) : undefined });
          }}
          activeOpacity={0.85}
          accessibilityLabel={t('Reply with a moment')}
        >
          <Icon name="camera" size={20} color="#000" />
          <Text style={styles.replyBtnText}>{t('Reply')}</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
  center: { flex: 1, backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center', gap: 12 },
  loadingText: { ...typescale.bodyMedium, color: colors.onSurfaceVariant },
  errorTitle: { ...typescale.titleMedium, color: colors.onSurface, textAlign: 'center' },
  errorDetail: { ...typescale.bodyMedium, color: colors.onSurfaceVariant, textAlign: 'center' },
  errorBtn: {
    backgroundColor: colors.surfaceContainerHigh, borderRadius: shape.medium,
    paddingVertical: 12, paddingHorizontal: 28, marginTop: 8,
  },
  errorBtnText: { ...typescale.labelLarge, color: colors.onSurface },

  media: { width: '100%', height: '100%' },

  topBar: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 10, zIndex: 10 },
  track: { height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)', overflow: 'hidden', marginBottom: 8 },
  trackFill: { height: 3, backgroundColor: '#fff' },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  senderChip: {
    flexDirection: 'row', alignItems: 'center', flexShrink: 1,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: shape.full,
    paddingVertical: 6, paddingHorizontal: 12,
  },
  senderName: { ...typescale.labelLarge, color: '#fff' },
  senderMeta: { ...typescale.labelMedium, color: 'rgba(255,255,255,0.75)' },
  saveBtn: { backgroundColor: 'rgba(0,0,0,0.6)' },

  captionBar: { position: 'absolute', left: 16, right: 16, bottom: 100, alignItems: 'center' },
  captionPill: {
    backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: shape.medium,
    paddingVertical: 8, paddingHorizontal: 14, maxWidth: '100%',
  },
  captionText: { ...typescale.bodyLarge, color: '#fff', textAlign: 'center' },

  linkRow: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  replyBtn: {
    position: 'absolute', alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#fff', borderRadius: shape.full, paddingHorizontal: 18, height: 44,
  },
  replyBtnText: { ...typescale.labelLarge, color: '#000', fontSize: 15 },
});
