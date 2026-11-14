/**
 * Shows a decrypted moment / story: photo, or video (with filter, speed, mute, the second
 * camera of a dual video and the drawing layer). Used by the moment viewer and stories.
 */
import React from 'react';
import { Image, Linking, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { ResizeMode, Video } from 'expo-av';
import { FilterView } from './FilterView';
import { Icon } from './kit';
import { ask } from './dialog';
import { shape, typescale } from '../theme';
import { t } from '../i18n';

export interface ShownMedia {
  image?: string;
  video?: string;
  /** file uri of the second camera clip (dual video) */
  inset?: string;
  dual?: { rect: number[]; main: number[]; layout: 'pip' | 'split' };
  overlay?: string;
  aspect?: number;
  filter?: string;
  speed?: number;
  muted?: boolean;
}

function rectStyle(r: number[], w: number, h: number) {
  return { position: 'absolute' as const, left: r[0] * w, top: r[1] * h, width: r[2] * w, height: r[3] * h };
}

export function MomentMedia({ m, loop, onEnd, paused, onProgress }: {
  m: ShownMedia; loop: boolean; onEnd?: () => void; paused?: boolean; onProgress?: (fraction: number) => void;
}) {
  const win = useWindowDimensions();
  if (m.image) return <Image source={{ uri: m.image }} style={styles.media} resizeMode="contain" />;
  if (!m.video) return null;
  // Drawing layer / dual layout: keep the sender's canvas shape so everything lines up.
  let frame = { width: win.width, height: win.height };
  if ((m.overlay || m.dual) && m.aspect) {
    frame = win.width / win.height > m.aspect
      ? { width: win.height * m.aspect, height: win.height }
      : { width: win.width, height: win.width / m.aspect };
  }
  const speed = m.speed ?? 1;
  return (
    <FilterView filter={m.filter} style={frame}>
      <Video
        source={{ uri: m.video }}
        style={m.dual ? rectStyle(m.dual.main, frame.width, frame.height) : StyleSheet.absoluteFill}
        resizeMode={m.overlay || m.dual ? ResizeMode.COVER : ResizeMode.CONTAIN}
        shouldPlay={!paused}
        isLooping={loop}
        isMuted={!!m.muted}
        rate={speed}
        shouldCorrectPitch
        onPlaybackStatusUpdate={(st) => {
          if (!st.isLoaded) return;
          if (onProgress && st.durationMillis) onProgress(st.positionMillis / st.durationMillis);
          if (st.didJustFinish && !loop) onEnd?.();
        }}
      />
      {m.dual && m.inset ? (
        <View style={[rectStyle(m.dual.rect, frame.width, frame.height), m.dual.layout === 'pip' && styles.inset]}>
          <Video source={{ uri: m.inset }} style={StyleSheet.absoluteFill} resizeMode={ResizeMode.COVER} shouldPlay={!paused} isLooping={loop} isMuted rate={speed} />
        </View>
      ) : null}
      {m.overlay ? <Image source={{ uri: m.overlay }} style={StyleSheet.absoluteFill} resizeMode="stretch" /> : null}
    </FilterView>
  );
}

/** Opens a link from a moment only after showing the full address. */
export async function openMomentLink(url: string) {
  const ok = await ask({
    title: t('Open link?'),
    message: t('{url}\n\nThe website learns your IP address. Only open links you trust.', { url }),
    confirm: t('Open'),
  });
  if (ok) Linking.openURL(url).catch(() => {});
}

export function LinkChip({ url, onBeforeOpen }: { url: string; onBeforeOpen?: () => void }) {
  let host = url;
  try { host = url.replace(/^https:\/\//i, '').split(/[/?#]/)[0]; } catch (_) {}
  return (
    <TouchableOpacity
      style={styles.link}
      onPress={() => { onBeforeOpen?.(); openMomentLink(url); }}
      activeOpacity={0.8}
      accessibilityLabel={t('Open link')}
    >
      <Icon name="link-variant" size={16} color="#000" />
      <Text style={styles.linkText} numberOfLines={1}>{host}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  media: { width: '100%', height: '100%' },
  inset: { borderRadius: 14, overflow: 'hidden', borderWidth: 2, borderColor: '#fff' },
  link: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center', maxWidth: '80%',
    backgroundColor: '#fff', borderRadius: shape.full, paddingHorizontal: 14, height: 36,
  },
  linkText: { ...typescale.labelLarge, color: '#000', flexShrink: 1 },
});
