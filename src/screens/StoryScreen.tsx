/**
 * Watching stories: a friend's (with reply → it shows up in the chat with them) or my own
 * (who watched, delete). No screenshots while open. Decrypted media only lives in memory or
 * as a temp file in the cache that is deleted when the story changes or the screen closes.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, Image, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, Animated, Easing,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as ScreenCapture from 'expo-screen-capture';
import { encodeBase64 } from 'tweetnacl-util';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RootStackParamList } from '../types';
import {
  FriendStory, OwnStory, markStoryWatched, openStory, ownStories, removeOwnStory, storiesOf, useStoriesVersion,
} from '../store/stories';
import { peerName } from '../store/chatStore';
import { MAX_TEXT_LEN, sendStorySeen, sendText } from '../sync/sync';
import { LinkChip, ShownMedia, MomentMedia } from '../ui/MomentMedia';
import { Icon, IconButton, timeAgo } from '../ui/kit';
import { ask, showAlert, showSheet } from '../ui/dialog';
import { colors, shape, typescale } from '../theme';
import { t } from '../i18n';

type Props = NativeStackScreenProps<RootStackParamList, 'Story'>;

interface Shown extends ShownMedia {
  caption: string;
  dur: number;
  link?: string;
}

export default function StoryScreen({ route, navigation }: Props) {
  const { ownerId } = route.params;
  const own = ownerId === 'me';
  const insets = useSafeAreaInsets();
  useStoriesVersion();
  const [items] = useState<(FriendStory | OwnStory)[]>(() => (own ? ownStories() : storiesOf(ownerId)));
  const [index, setIndex] = useState(() => {
    if (own) return 0;
    const i = (items as FriendStory[]).findIndex((s) => !s.seen);
    return i < 0 ? 0 : i;
  });
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState('');
  const [reply, setReply] = useState('');
  const [typing, setTyping] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const tempRef = useRef<string[]>([]);
  const dropTemp = () => {
    for (const f of tempRef.current) FileSystem.deleteAsync(f, { idempotent: true }).catch(() => {});
    tempRef.current = [];
  };
  const name = own ? t('My story') : peerName(ownerId) ?? (items[0] as FriendStory | undefined)?.ownerName ?? '';
  const current = items[index];

  useEffect(() => {
    ScreenCapture.preventScreenCaptureAsync('story').catch(() => {});
    return () => {
      ScreenCapture.allowScreenCaptureAsync('story').catch(() => {});
      dropTemp();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const close = useCallback(() => navigation.goBack(), [navigation]);
  const next = useCallback(() => {
    progress.stopAnimation();
    if (index + 1 < items.length) setIndex(index + 1); else close();
  }, [index, items.length, close, progress]);
  const prev = useCallback(() => {
    progress.stopAnimation();
    if (index > 0) setIndex(index - 1);
  }, [index, progress]);

  // Load the current story.
  useEffect(() => {
    if (!current) { close(); return; }
    let cancelled = false;
    setShown(null);
    setError('');
    progress.setValue(0);
    (async () => {
      try {
        const info = await openStory(current.id);
        if (cancelled) return;
        const s: Shown = {
          caption: info.caption, dur: info.dur, aspect: info.aspect, link: info.link,
          filter: current.mt === 'video' ? info.filter : undefined, speed: info.speed, muted: info.muted,
        };
        if (info.overlay) s.overlay = `data:image/png;base64,${encodeBase64(info.overlay)}`;
        if (current.mt === 'image') {
          s.image = `data:image/jpeg;base64,${encodeBase64(info.media)}`;
        } else {
          dropTemp();
          const path = `${FileSystem.cacheDirectory}view_story_${current.id}.mp4`;
          await FileSystem.writeAsStringAsync(path, encodeBase64(info.media), { encoding: FileSystem.EncodingType.Base64 });
          tempRef.current.push(path);
          s.video = path;
          if (info.dual) {
            const p2 = `${FileSystem.cacheDirectory}view_story_${current.id}_2.mp4`;
            await FileSystem.writeAsStringAsync(p2, encodeBase64(info.dual.inset), { encoding: FileSystem.EncodingType.Base64 });
            tempRef.current.push(p2);
            s.inset = p2;
            s.dual = { rect: info.dual.rect, main: info.dual.main, layout: info.dual.layout };
          }
        }
        setShown(s);
        if (!own && markStoryWatched(current.id)) sendStorySeen(ownerId, current.id);
      } catch (e: any) {
        if (!cancelled) setError(t(e?.message ?? String(e)));
      }
    })();
    return () => { cancelled = true; };
  }, [current, own, ownerId, close, progress]);

  // Photos advance by themselves (view time chosen by the owner; 0 = until tapped).
  useEffect(() => {
    if (!shown?.image || typing || shown.dur <= 0) return;
    Animated.timing(progress, { toValue: 1, duration: shown.dur * 1000, easing: Easing.linear, useNativeDriver: false })
      .start(({ finished }) => { if (finished) next(); });
    return () => progress.stopAnimation();
  }, [shown, typing, next, progress]);

  async function sendReply() {
    const body = reply.trim();
    if (!body || !current) return;
    setReply('');
    setTyping(false);
    await sendText(ownerId, name, body, { id: current.id, q: t('Story'), k: 'story' });
    showAlert(t('Sent'), t('Your reply is in your chat with {name}.', { name }), undefined, { icon: 'check' });
  }

  function viewers() {
    const s = current as OwnStory;
    const list = Object.entries(s.viewers ?? {}).sort((a, b) => b[1].localeCompare(a[1]));
    showSheet({
      title: t('Seen by {n} of {total}', { n: list.length, total: s.audience }),
      message: list.length === 0 ? t('Nobody has watched it yet.') : undefined,
      actions: list.map(([id, at]) => ({ label: `${peerName(id) ?? '?'} · ${timeAgo(at)}`, icon: 'eye-outline' as const, onPress: () => {} })),
    });
  }

  async function remove() {
    const ok = await ask({ title: t('Delete this story?'), message: t('It is removed from the server right away.'), confirm: t('Delete'), destructive: true });
    if (!ok || !current) return;
    try {
      await removeOwnStory(current.id);
      close();
    } catch (e: any) {
      showAlert(t('Error'), e.message);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {shown?.image ? (
        <Image source={{ uri: shown.image }} style={styles.media} resizeMode="contain" />
      ) : shown?.video ? (
        <MomentMedia m={shown} loop={false} paused={typing} onProgress={(f) => progress.setValue(f)} onEnd={next} />
      ) : error ? (
        <View style={styles.center}>
          <Icon name="alert-circle-outline" size={36} color={colors.error} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : (
        <ActivityIndicator color="#fff" size="large" />
      )}

      {/* tap zones: left = back, right = next */}
      <View style={StyleSheet.absoluteFill} pointerEvents={typing ? 'none' : 'box-none'}>
        <View style={styles.tapRow}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={prev} />
          <TouchableOpacity style={{ flex: 2 }} activeOpacity={1} onPress={next} />
        </View>
      </View>

      <View style={[styles.top, { paddingTop: insets.top + 6 }]} pointerEvents="box-none">
        <View style={styles.bars}>
          {items.map((it, i) => (
            <View key={it.id} style={styles.bar}>
              {i < index ? <View style={[styles.barFill, { width: '100%' }]} />
                : i === index ? <Animated.View style={[styles.barFill, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]} />
                : null}
            </View>
          ))}
        </View>
        <View style={styles.headRow}>
          <View style={styles.chip}>
            <Text style={styles.chipName}>{name}</Text>
            {current ? <Text style={styles.chipMeta}> · {timeAgo(current.createdAt)}</Text> : null}
          </View>
          <View style={{ flex: 1 }} />
          <IconButton name="close" color="#fff" style={styles.round} onPress={close} accessibilityLabel={t('Close')} />
        </View>
      </View>

      {shown?.caption ? (
        <View style={styles.captionBar} pointerEvents="none">
          <View style={styles.captionPill}><Text style={styles.captionText}>{shown.caption}</Text></View>
        </View>
      ) : null}

      <View style={[styles.bottom, { paddingBottom: insets.bottom + 10 }]}>
        {own ? (
          <View style={styles.ownRow}>
            <TouchableOpacity style={styles.ownBtn} onPress={viewers} activeOpacity={0.8}>
              <Icon name="eye-outline" size={18} color="#fff" />
              <Text style={styles.ownText}>
                {current ? t('{n} of {total}', { n: Object.keys((current as OwnStory).viewers ?? {}).length, total: (current as OwnStory).audience }) : ''}
              </Text>
            </TouchableOpacity>
            <View style={{ flex: 1 }} />
            <IconButton name="delete-outline" color="#fff" style={styles.round} onPress={remove} accessibilityLabel={t('Delete this story?')} />
          </View>
        ) : (
          <View style={styles.replyRow}>
            <TouchableOpacity
              style={styles.cameraBtn}
              onPress={() => current && navigation.replace('Camera', { peerId: ownerId, peerName: name, replyTo: { id: current.id, q: t('Story'), k: 'story' } })}
              accessibilityLabel={t('Reply with a moment')}
            >
              <Icon name="camera" size={20} color="#000" />
            </TouchableOpacity>
            <TextInput
              style={styles.input}
              value={reply}
              onChangeText={setReply}
              onFocus={() => { setTyping(true); progress.stopAnimation(); }}
              onBlur={() => setTyping(false)}
              placeholder={t('Reply to {name}…', { name })}
              placeholderTextColor="rgba(255,255,255,0.6)"
              maxLength={MAX_TEXT_LEN}
              returnKeyType="send"
              onSubmitEditing={sendReply}
            />
            {reply.trim() ? (
              <TouchableOpacity style={styles.sendBtn} onPress={sendReply} accessibilityLabel={t('Send')}>
                <Icon name="send" size={18} color="#fff" />
              </TouchableOpacity>
            ) : null}
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
  media: { width: '100%', height: '100%' },
  center: { alignItems: 'center', gap: 10, padding: 24 },
  errorText: { ...typescale.bodyMedium, color: '#fff', textAlign: 'center' },
  tapRow: { flex: 1, flexDirection: 'row', marginTop: 90, marginBottom: 90 },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 8 },
  bars: { flexDirection: 'row', gap: 3, marginBottom: 8 },
  bar: { flex: 1, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)', overflow: 'hidden' },
  barFill: { height: 3, backgroundColor: '#fff' },
  headRow: { flexDirection: 'row', alignItems: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: shape.full, paddingVertical: 6, paddingHorizontal: 12 },
  chipName: { ...typescale.labelLarge, color: '#fff' },
  chipMeta: { ...typescale.labelMedium, color: 'rgba(255,255,255,0.75)' },
  round: { backgroundColor: 'rgba(0,0,0,0.6)' },
  captionBar: { position: 'absolute', left: 16, right: 16, bottom: 110, alignItems: 'center' },
  captionPill: { backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: shape.medium, paddingVertical: 8, paddingHorizontal: 14 },
  captionText: { ...typescale.bodyLarge, color: '#fff', textAlign: 'center' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 10 },
  replyRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cameraBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  input: {
    flex: 1, height: 44, borderRadius: 22, paddingHorizontal: 16, color: '#fff',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)', backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.kindText, alignItems: 'center', justifyContent: 'center' },
  ownRow: { flexDirection: 'row', alignItems: 'center' },
  ownBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: shape.full, paddingHorizontal: 14, height: 40 },
  ownText: { ...typescale.labelLarge, color: '#fff' },
});
