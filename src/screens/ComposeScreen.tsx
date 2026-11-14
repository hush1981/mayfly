/**
 * Editing a moment before sending: drawing, emoji stickers, text in three styles and the
 * view time for photos. Photos are flattened into one image before sending; for videos
 * the drawing layer is sent as a transparent PNG next to the video (inside the same
 * encrypted payload) and drawn over it by the viewer.
 */
import React, { useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Image, StyleSheet, PanResponder, Modal, ScrollView,
  ActivityIndicator, LayoutChangeEvent, GestureResponderEvent,
} from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import Svg, { Path } from 'react-native-svg';
import { captureRef } from 'react-native-view-shot';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DraftParams, RootStackParamList } from '../types';
import { colors, shape, typescale } from '../theme';
import { Icon, IconName } from '../ui/kit';
import { showSendError } from '../chat/actions';
import { deleteIfCached } from '../media/local';
import { useAuth } from '../store/AuthProvider';
import { sendDraftToChat } from '../send/sendMoment';
import { FILTERS, bakePhoto, filtersAvailable } from '../filters/filters';
import { FilterView } from '../ui/FilterView';
import { promptText, showAlert } from '../ui/dialog';
import { canSaveToGallery, saveToGallery, stripAudio } from '../media/tools';
import { normalizeLink } from '../send/payload';
import { t } from '../i18n';

type Props = NativeStackScreenProps<RootStackParamList, 'Compose'>;

const PEN_COLORS = ['#FFFFFF', '#000000', '#FFD60A', '#FF3B30', '#FF9500', '#34C759', '#4DA3FF', '#B98CFF', '#FF2D92'];
const EMOJIS = [
  '😂', '🥹', '😍', '🥰', '😎', '🤩', '😜', '🤪', '😇', '🙃', '😴', '🤯', '😱', '🥳', '😤', '😭',
  '❤️', '💛', '💜', '💙', '💚', '🧡', '🖤', '💯', '✨', '⭐', '🌈', '☀️', '🌙', '⚡', '❄️', '🎉',
  '👍', '👎', '👏', '🙌', '🤝', '✌️', '🤞', '👀', '💪', '🙏', '👋', '🫶', '🐶', '🐱', '🦄', '🍕',
  '🍔', '🍟', '🍦', '🍩', '☕', '🍺', '🎂', '🎁', '⚽', '🎮', '🎧', '📸', '🚗', '✈️', '🏖️', '🏠',
];
const DURATIONS = [5, 10, 60, 0]; // seconds, 0 = until closed
const SPEEDS = [1, 2, 0.5];

/** Where a dual camera clip sits: [l, t, w, h] fractions → absolute style. */
export function rectStyle(r: number[], w: number, h: number) {
  return { position: 'absolute' as const, left: r[0] * w, top: r[1] * h, width: r[2] * w, height: r[3] * h };
}

type TextStyleName = 'bar' | 'big' | 'box';

interface Stroke { d: string; color: string }
interface Item {
  id: number;
  kind: 'emoji' | 'text';
  x: number; // center, px within canvas
  y: number;
  text: string;
  size: number;
  style?: TextStyleName;
  color?: string;
}

/** Renders a text sticker in one of the three styles. */
function TextSticker({ item, width }: { item: Item; width: number }) {
  const color = item.color ?? '#FFFFFF';
  if (item.style === 'bar') {
    return (
      <View style={[styles.barText, { width }]}>
        <Text style={[styles.barTextInner, { color }]}>{item.text}</Text>
      </View>
    );
  }
  if (item.style === 'box') {
    const dark = color === '#FFFFFF' || color === '#FFD60A' || color === '#34C759';
    return (
      <View style={[styles.boxText, { backgroundColor: color, maxWidth: width - 32 }]}>
        <Text style={[styles.boxTextInner, { color: dark ? '#000' : '#fff' }]}>{item.text}</Text>
      </View>
    );
  }
  return <Text style={[styles.bigText, { color, maxWidth: width - 32 }]}>{item.text}</Text>;
}

function Draggable({
  item, width, onMove, onTap, onRemove, disabled,
}: {
  item: Item; width: number; disabled: boolean;
  onMove: (id: number, x: number, y: number) => void; onTap: (id: number) => void; onRemove: (id: number) => void;
}) {
  const start = useRef({ x: 0, y: 0 });
  const moved = useRef(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const latest = useRef(item);
  latest.current = item;
  const pr = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      start.current = { x: latest.current.x, y: latest.current.y };
      moved.current = false;
      pressTimer.current = setTimeout(() => { if (!moved.current) onRemove(latest.current.id); }, 650);
    },
    onPanResponderMove: (_e, g) => {
      if (Math.abs(g.dx) + Math.abs(g.dy) > 6) {
        moved.current = true;
        if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
      }
      onMove(latest.current.id, start.current.x + g.dx, start.current.y + g.dy);
    },
    onPanResponderRelease: () => {
      if (pressTimer.current) {
        clearTimeout(pressTimer.current);
        pressTimer.current = null;
        if (!moved.current) onTap(latest.current.id);
      }
    },
    onPanResponderTerminate: () => {
      if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  const bar = item.kind === 'text' && item.style === 'bar';
  return (
    <View
      {...(disabled ? {} : pr.panHandlers)}
      pointerEvents={disabled ? 'none' : 'auto'}
      onLayout={(e: LayoutChangeEvent) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      style={{ position: 'absolute', left: bar ? 0 : item.x - size.w / 2, top: item.y - size.h / 2, opacity: size.w ? 1 : 0 }}
    >
      {item.kind === 'emoji'
        ? <Text style={{ fontSize: item.size }}>{item.text}</Text>
        : <TextSticker item={item} width={width} />}
    </View>
  );
}

export default function ComposeScreen({ route, navigation }: Props) {
  const { uri, type, peerId, peerName, replyTo, dual } = route.params;
  const { state } = useAuth();
  const insets = useSafeAreaInsets();
  const canvasRef = useRef<View>(null);
  const overlayRef = useRef<View>(null);
  const [canvas, setCanvas] = useState({ w: 0, h: 0 });

  const [mode, setMode] = useState<'none' | 'draw'>('none');
  const [penColor, setPenColor] = useState(PEN_COLORS[3]);
  const penColorRef = useRef(penColor);
  penColorRef.current = penColor;
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const current = useRef<string>('');
  const [, force] = useState(0);
  const [items, setItems] = useState<Item[]>([]);
  const nextId = useRef(1);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [dur, setDur] = useState(10);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [filter, setFilter] = useState('none');
  const [filterToast, setFilterToast] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [link, setLink] = useState<string | undefined>();
  const [canSave, setCanSave] = useState(false);
  const [saving, setSaving] = useState(false);
  React.useEffect(() => { canSaveToGallery().then(setCanSave); }, []);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function pickFilter(id: string) {
    setFilter(id);
    const f = FILTERS.find((x) => x.id === id);
    setFilterToast(f ? t(f.name) : null);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setFilterToast(null), 900);
  }
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const canvasRefSize = useRef(canvas);
  canvasRefSize.current = canvas;

  // Empty space: tap = add text, swipe left / right = next / previous filter.
  const tapResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderRelease: (e: GestureResponderEvent, g) => {
      if (Math.abs(g.dx) > 50 && Math.abs(g.dx) > Math.abs(g.dy) && filtersAvailable) {
        const i = FILTERS.findIndex((f) => f.id === filterRef.current);
        const next = (i + (g.dx < 0 ? 1 : -1) + FILTERS.length) % FILTERS.length;
        pickFilter(FILTERS[next].id);
      } else if (Math.abs(g.dx) + Math.abs(g.dy) < 10) {
        startText({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY });
      }
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  function addTimeStamp() {
    const now = new Date();
    const text = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setMode('none');
    setItems((list) => [...list, {
      id: nextId.current++, kind: 'text', text, x: canvas.w / 2, y: canvas.h * 0.3, size: 0, style: 'big', color: '#FFFFFF',
    }]);
  }

  const drawResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e: GestureResponderEvent) => {
      const { locationX: x, locationY: y } = e.nativeEvent;
      current.current = `M${x.toFixed(1)} ${y.toFixed(1)}`;
      force((n) => n + 1);
    },
    onPanResponderMove: (e: GestureResponderEvent) => {
      const { locationX: x, locationY: y } = e.nativeEvent;
      current.current += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
      force((n) => n + 1);
    },
    onPanResponderRelease: () => {
      const d = current.current;
      current.current = '';
      if (d.includes('L')) setStrokes((s) => [...s, { d, color: penColorRef.current }]);
      else force((n) => n + 1);
    },
  }), []);

  const hasOverlay = strokes.length > 0 || items.length > 0;

  function addEmoji(e: string) {
    setEmojiOpen(false);
    setItems((list) => [...list, { id: nextId.current++, kind: 'emoji', text: e, x: canvas.w / 2, y: canvas.h / 2.4, size: 72 }]);
  }

  function startText(at?: { x: number; y: number }) {
    setMode('none');
    const c = canvasRefSize.current; // (also called from the gesture handler, which keeps its first closure)
    setEditing({
      id: nextId.current++, kind: 'text', text: '', x: c.w / 2, y: at?.y ?? c.h * 0.4, size: 0,
      style: 'bar', color: '#FFFFFF',
    });
  }

  function commitText() {
    const e = editing;
    setEditing(null);
    if (!e) return;
    const text = e.text.trim();
    setItems((list) => {
      const rest = list.filter((i) => i.id !== e.id);
      return text ? [...rest, { ...e, text }] : rest;
    });
  }

  function onItemTap(id: number) {
    setItems((list) => {
      const it = list.find((i) => i.id === id);
      if (it?.kind === 'text') {
        setEditing(it);
        return list;
      }
      return list.map((i) => (i.id === id ? { ...i, size: i.size >= 140 ? 48 : Math.round(i.size * 1.45) } : i));
    });
  }

  async function produceDraft(): Promise<DraftParams> {
    const filtered = filter !== 'none';
    if (type === 'image') {
      if (filtersAvailable) {
        // Filter on the photo, drawing / stickers on top, cropped as seen on screen. Always
        // re-encoded: the new JPEG carries no EXIF data (camera, time, GPS of gallery photos).
        const layer = hasOverlay ? await captureRef(overlayRef, { format: 'png', quality: 1, result: 'tmpfile' }) : null;
        const out = await bakePhoto(uri, filter, layer, canvas.w / canvas.h);
        if (layer) deleteIfCached(layer);
        return { uri: out, type: 'image', dur, replyTo, link };
      }
      // Flatten photo + drawing into one image, as seen on screen.
      const out = hasOverlay
        ? await captureRef(canvasRef, { format: 'jpg', quality: 0.88, result: 'tmpfile' })
        : uri;
      return { uri: out, type: 'image', dur, replyTo, link };
    }
    let overlayUri: string | undefined;
    if (hasOverlay) overlayUri = await captureRef(overlayRef, { format: 'png', quality: 1, result: 'tmpfile' });
    // Muted: the sound track is removed from the file itself (the flag is a fallback for
    // formats the muxer cannot rewrite).
    let videoUri = uri;
    if (muted) videoUri = await stripAudio(uri).catch(() => uri);
    return {
      uri: videoUri, type: 'video', overlayUri, aspect: canvas.w / canvas.h, replyTo, filter: filtered ? filter : undefined,
      muted: muted || undefined, speed: speed !== 1 ? speed : undefined, link, dual,
    };
  }

  async function addLink() {
    const value = await promptText({
      title: t('Attach a link'),
      message: t('Your friend sees the address and can open it. Only https links.'),
      initial: link ?? '',
      placeholder: 'https://',
      maxLength: 500,
    });
    if (value === null) return;
    if (!value.trim()) { setLink(undefined); return; }
    const n = normalizeLink(value);
    if (!n) { showAlert(t('Not a valid link'), t('Only https links can be attached.')); return; }
    setLink(n);
  }

  async function saveCopy() {
    if (saving) return;
    setSaving(true);
    try {
      const d = await produceDraft();
      await saveToGallery(d.uri, d.type === 'video' ? 'video' : 'image');
      setFilterToast(t('Saved to gallery'));
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setFilterToast(null), 1200);
    } catch (e: any) {
      showAlert(t('Could not save'), e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  async function proceed() {
    if (busy) return;
    setBusy(true);
    try {
      const draft = await produceDraft();
      if (peerId && peerName) {
        // Opened from a chat: goes straight to that friend / group chat.
        setProgress(t('Sending…'));
        await sendDraftToChat(draft, peerId, peerName, state.userId!, setProgress);
        navigation.navigate('Chat', { peerId, peerName });
      } else {
        navigation.navigate('SelectFriend', { draft });
      }
    } catch (e: any) {
      showSendError(e);
    } finally {
      setBusy(false);
      setProgress('');
    }
  }

  const tool = (icon: IconName, onPress: () => void, active = false, label?: string, a11y?: string) => (
    <TouchableOpacity
      style={[styles.tool, active && styles.toolActive]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityLabel={a11y}
    >
      <Icon name={icon} size={label ? 18 : 22} color={active ? '#000' : '#fff'} />
      {label ? <Text style={[styles.toolLabel, active && { color: '#000' }]}>{label}</Text> : null}
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Canvas: media + overlay (captured for sending) */}
      <View
        ref={canvasRef}
        collapsable={false}
        style={StyleSheet.absoluteFill}
        onLayout={(e) => setCanvas({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      >
        <FilterView filter={filter} style={StyleSheet.absoluteFill}>
          {type === 'image' ? (
            <Image source={{ uri }} style={styles.media} resizeMode="cover" />
          ) : (
            <Video
              source={{ uri }}
              style={dual ? rectStyle(dual.main, canvas.w, canvas.h) : styles.media}
              resizeMode={ResizeMode.COVER}
              shouldPlay isLooping isMuted={muted} rate={speed} shouldCorrectPitch
            />
          )}
          {dual && (
            <View style={[rectStyle(dual.rect, canvas.w, canvas.h), dual.layout === 'pip' && styles.dualInset]}>
              <Video source={{ uri: dual.uri }} style={StyleSheet.absoluteFill} resizeMode={ResizeMode.COVER} shouldPlay isLooping isMuted rate={speed} />
            </View>
          )}
        </FilterView>
        {/* Tap on empty space = add text, swipe = filter */}
        {mode !== 'draw' && <View style={StyleSheet.absoluteFill} {...tapResponder.panHandlers} />}
        <View ref={overlayRef} collapsable={false} style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
            {strokes.map((s, i) => (
              <Path key={i} d={s.d} stroke={s.color} strokeWidth={7} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            ))}
            {current.current ? (
              <Path d={current.current} stroke={penColor} strokeWidth={7} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            ) : null}
          </Svg>
          {items.filter((i) => i.id !== editing?.id).map((it) => (
            <Draggable
              key={it.id}
              item={it}
              width={canvas.w}
              disabled={mode === 'draw'}
              onMove={(id, x, y) => setItems((list) => list.map((i) => (i.id === id ? { ...i, x, y } : i)))}
              onTap={onItemTap}
              onRemove={(id) => setItems((list) => list.filter((i) => i.id !== id))}
            />
          ))}
        </View>
      </View>

      {filterToast && (
        <View style={styles.filterToast} pointerEvents="none">
          <Text style={styles.filterToastText}>{filterToast}</Text>
        </View>
      )}

      {/* Drawing input */}
      {mode === 'draw' && <View style={StyleSheet.absoluteFill} {...drawResponder.panHandlers} />}

      {/* Top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <TouchableOpacity style={styles.circleBtn} onPress={() => navigation.goBack()} accessibilityLabel={t('Discard')}>
          <Icon name="close" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }} pointerEvents="none" />
        <View style={styles.tools}>
          {tool('format-text', () => startText(), false, undefined, t('Text'))}
          {tool('draw', () => setMode((m) => (m === 'draw' ? 'none' : 'draw')), mode === 'draw', undefined, t('Draw'))}
          {tool('sticker-emoji', () => { setMode('none'); setEmojiOpen(true); }, false, undefined, t('Sticker'))}
          {tool('clock-outline', addTimeStamp, false, undefined, t('Time'))}
          {type === 'image' && tool(
            'timer-outline',
            () => setDur((d) => DURATIONS[(DURATIONS.indexOf(d) + 1) % DURATIONS.length]),
            false, dur === 0 ? '∞' : `${dur}s`, t('View time'),
          )}
          {type === 'video' && tool(muted ? 'volume-off' : 'volume-high', () => setMuted((m) => !m), muted, undefined, muted ? t('Sound off') : t('Sound on'))}
          {type === 'video' && tool('play-speed', () => setSpeed((x) => SPEEDS[(SPEEDS.indexOf(x) + 1) % SPEEDS.length]), speed !== 1, `${speed}×`, t('Speed'))}
          {tool('link-variant', addLink, !!link, undefined, t('Link'))}
          {canSave && !dual && tool(saving ? 'progress-download' : 'download', saveCopy, false, undefined, t('Save to gallery'))}
          {mode === 'draw' && strokes.length > 0 && tool('undo', () => setStrokes((s) => s.slice(0, -1)), false, undefined, t('Undo'))}
        </View>
      </View>

      {/* Pen colours */}
      {mode === 'draw' && (
        <View style={[styles.palette, { top: insets.top + 64 }]}>
          {PEN_COLORS.map((c) => (
            <TouchableOpacity
              key={c}
              onPress={() => setPenColor(c)}
              style={[styles.swatch, { backgroundColor: c }, penColor === c && styles.swatchActive]}
            />
          ))}
        </View>
      )}

      {/* Bottom: primary action */}
      <View style={[styles.bottomPanel, { paddingBottom: insets.bottom + 12 }]} pointerEvents="box-none">
        {filtersAvailable && mode !== 'draw' && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
            {FILTERS.map((f) => (
              <TouchableOpacity
                key={f.id}
                style={[styles.filterChip, filter === f.id && styles.filterChipActive]}
                onPress={() => pickFilter(f.id)}
                activeOpacity={0.8}
              >
                <Text style={[styles.filterChipText, filter === f.id && { color: '#000' }]}>{t(f.name)}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
        {link ? (
          <TouchableOpacity style={styles.linkChip} onPress={addLink} activeOpacity={0.8}>
            <Icon name="link-variant" size={14} color="#fff" />
            <Text style={styles.linkText} numberOfLines={1}>{link}</Text>
          </TouchableOpacity>
        ) : null}
        <Text style={styles.hint}>
          {mode === 'draw' ? t('Draw with your finger') : t('Tap to add text · swipe for filters · hold to remove')}
        </Text>
        <TouchableOpacity style={[styles.nextBtn, busy && { opacity: 0.7 }]} onPress={proceed} activeOpacity={0.85} disabled={busy}>
          {busy ? <ActivityIndicator color={colors.onPrimary} /> : (
            <>
              {replyTo ? <Icon name="reply" size={18} color={colors.onPrimary} /> : null}
              <Text style={styles.nextBtnText} numberOfLines={1}>{peerName ? t('Send to {name}', { name: peerName }) : t('Next')}</Text>
              <Icon name={peerName ? 'send' : 'chevron-right'} size={20} color={colors.onPrimary} />
            </>
          )}
        </TouchableOpacity>
        {progress ? <Text style={styles.hint}>{progress}</Text> : null}
      </View>

      {/* Text editor */}
      {editing && (
        <View style={styles.editLayer}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={commitText} />
          <View style={[styles.editRow, { top: insets.top + 12 }]}>
            {(['bar', 'big', 'box'] as TextStyleName[]).map((st) => (
              <TouchableOpacity
                key={st}
                style={[styles.styleBtn, editing.style === st && styles.styleBtnActive]}
                onPress={() => setEditing({ ...editing, style: st })}
              >
                <Text style={[styles.styleBtnText, editing.style === st && { color: '#000' }]}>
                  {st === 'bar' ? t('Bar') : st === 'big' ? t('Big') : t('Box')}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={styles.doneBtn} onPress={commitText}>
              <Text style={styles.doneText}>{t('Done')}</Text>
            </TouchableOpacity>
          </View>
          <View style={[styles.editColors, { top: insets.top + 64 }]}>
            {PEN_COLORS.map((c) => (
              <TouchableOpacity
                key={c}
                onPress={() => setEditing({ ...editing, color: c })}
                style={[styles.swatchSmall, { backgroundColor: c }, editing.color === c && styles.swatchActive]}
              />
            ))}
          </View>
          <View style={[styles.editInputWrap, { top: Math.max(insets.top + 110, canvas.h * 0.25) }]}>
            <TextInput
              autoFocus
              value={editing.text}
              onChangeText={(t) => setEditing({ ...editing, text: t })}
              multiline
              maxLength={160}
              selectionColor={colors.primary}
              style={[
                styles.editInput,
                editing.style === 'big' && styles.bigText,
                editing.style === 'box' && { backgroundColor: editing.color, borderRadius: 10 },
                { color: editing.style === 'box' ? (['#FFFFFF', '#FFD60A', '#34C759'].includes(editing.color ?? '') ? '#000' : '#fff') : editing.color },
              ]}
              placeholder={t('Type something')}
              placeholderTextColor="rgba(255,255,255,0.5)"
            />
          </View>
        </View>
      )}

      {/* Emoji picker */}
      <Modal visible={emojiOpen} transparent animationType="slide" onRequestClose={() => setEmojiOpen(false)} statusBarTranslucent>
        <TouchableOpacity style={styles.sheetScrim} activeOpacity={1} onPress={() => setEmojiOpen(false)} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
          <View style={styles.handle} />
          <ScrollView contentContainerStyle={styles.emojiGrid}>
            {EMOJIS.map((e) => (
              <TouchableOpacity key={e} style={styles.emojiCell} onPress={() => addEmoji(e)}>
                <Text style={styles.emoji}>{e}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  media: { width: '100%', height: '100%' },
  dualInset: { borderRadius: 14, overflow: 'hidden', borderWidth: 2, borderColor: '#fff' },
  linkChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center', maxWidth: '90%',
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: shape.full, paddingHorizontal: 12, height: 30,
  },
  linkText: { ...typescale.labelMedium, color: '#fff', flexShrink: 1 },

  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    paddingHorizontal: 12, zIndex: 10,
  },
  circleBtn: {
    width: 44, height: 44, borderRadius: shape.full,
    backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center',
  },
  tools: { gap: 10, alignItems: 'center' },
  tool: {
    width: 44, height: 44, borderRadius: shape.full,
    backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center',
  },
  toolActive: { backgroundColor: '#fff' },
  toolLabel: { color: '#fff', fontSize: 10, fontWeight: '700', marginTop: -1 },

  palette: { position: 'absolute', left: 12, zIndex: 11, gap: 10 },
  swatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: 'rgba(255,255,255,0.6)' },
  swatchSmall: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: 'rgba(255,255,255,0.6)' },
  swatchActive: { borderColor: '#fff', borderWidth: 3, transform: [{ scale: 1.15 }] },

  filterRow: { gap: 6, paddingHorizontal: 2 },
  filterChip: {
    height: 30, paddingHorizontal: 12, borderRadius: shape.full, justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)',
  },
  filterChipActive: { backgroundColor: '#fff', borderColor: '#fff' },
  filterChipText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  filterToast: {
    position: 'absolute', alignSelf: 'center', top: '40%', zIndex: 15,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: shape.full, paddingHorizontal: 18, paddingVertical: 8,
  },
  filterToastText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  bottomPanel: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12, gap: 8, zIndex: 10 },
  hint: { color: 'rgba(255,255,255,0.85)', ...typescale.labelSmall, textAlign: 'center', textShadowColor: '#000', textShadowRadius: 4 },
  nextBtn: {
    backgroundColor: colors.primary, borderRadius: shape.large, height: 50,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  nextBtnText: { ...typescale.labelLarge, color: colors.onPrimary, fontSize: 16 },

  barText: { backgroundColor: 'rgba(0,0,0,0.6)', paddingVertical: 8, paddingHorizontal: 16 },
  barTextInner: { fontSize: 18, textAlign: 'center', fontWeight: '500' },
  bigText: {
    fontSize: 36, fontWeight: '900', textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.7)', textShadowRadius: 6, textShadowOffset: { width: 0, height: 1 },
  },
  boxText: { borderRadius: 10, paddingVertical: 6, paddingHorizontal: 12 },
  boxTextInner: { fontSize: 22, fontWeight: '700', textAlign: 'center' },

  editLayer: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)', zIndex: 20 },
  editRow: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', gap: 8, alignItems: 'center' },
  styleBtn: {
    height: 36, paddingHorizontal: 14, borderRadius: shape.full, justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)',
  },
  styleBtnActive: { backgroundColor: '#fff', borderColor: '#fff' },
  styleBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  doneBtn: { marginLeft: 'auto', height: 36, paddingHorizontal: 16, borderRadius: shape.full, backgroundColor: colors.primary, justifyContent: 'center' },
  doneText: { color: colors.onPrimary, fontWeight: '700', fontSize: 14 },
  editColors: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', gap: 10, justifyContent: 'center' },
  editInputWrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  editInput: { fontSize: 22, fontWeight: '600', textAlign: 'center', minWidth: 120, maxWidth: '100%', padding: 8 },

  sheetScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: colors.surfaceContainer, borderTopLeftRadius: shape.extraLarge, borderTopRightRadius: shape.extraLarge,
    paddingTop: 10, maxHeight: '55%',
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.outline, opacity: 0.5, marginBottom: 8 },
  emojiGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 8 },
  emojiCell: { width: '12.5%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center' },
  emoji: { fontSize: 32 },
});
