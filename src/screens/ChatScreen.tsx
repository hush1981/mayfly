import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, TextInput, KeyboardAvoidingView, Platform, Image, Linking,
  ActivityIndicator, useWindowDimensions,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ScreenCapture from 'expo-screen-capture';
import { RootStackParamList } from '../types';
import { colors, shape, typescale } from '../theme';
import {
  ChatMoment, ReplyRef, cake, chatTtlMs, canReplay, canViewSaved, chatSettings, dropFile, groupIdOf, isGroupChat, isMoment,
  isText, peerName as storedPeerName, purgeViewed, setOpenChat, momentsForPeer, updateMoment, useChatStoreVersion,
} from '../store/chatStore';
import {
  MAX_TEXT_LEN, REACTIONS, authorName, canEdit, editText, markRead, quoteOf, react, sendChatEvent, sendText, syncNow, unsend,
} from '../sync/sync';
import { groupInfo, onGroupsChanged } from '../store/groupChats';
import { Icon, IconButton, momentState, membersText } from '../ui/kit';
import { ask, showAlert, showSheet, SheetAction } from '../ui/dialog';
import { isVerified, keyChangedAt } from '../crypto/peerKeys';
import { POLLING_INTERVAL_MS } from '../config';
import { openChatMenu, openGroupChatMenu, resolveKeyChange, showSendError, ttlLabel } from '../chat/actions';
import { useAuth } from '../store/AuthProvider';
import { sendDraftToChat } from '../send/sendMoment';
import {
  MAX_VOICE_MS, VoiceError, forgetImage, playVoice, savedImageUri, startVoiceRecording, stopVoice, stopVoiceRecording,
} from '../media/local';
import { t } from '../i18n';
import { joinGroupCall, startCall, useOngoingGroupCall } from '../calls/manager';
import { completeMention, splitMentions, typingMention } from '../chat/mentions';

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

function clock(iso: string): string {
  const d = new Date(iso);
  const sameDay = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? hm : `${d.toLocaleDateString([], { day: '2-digit', month: '2-digit' })} ${hm}`;
}

function hoursLeft(s: ChatMoment): number {
  return Math.max(0, Math.ceil((new Date(s.createdAt).getTime() + chatTtlMs(s.peerId) - Date.now()) / 3600000));
}

function mmss(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Accent colour of a message kind: texts blue, photos yellow, videos purple. */
export function kindColor(s: ChatMoment): string {
  if (s.kind === 'text' || s.kind === 'voice') return colors.kindText;
  return s.mediaType === 'video' ? colors.kindVideo : colors.kindPhoto;
}

/** Toggles "saved in chat" on a moment or message and tells the peer. */
export async function toggleSaved(s: ChatMoment) {
  const saved = !s.saved;
  updateMoment(s.id, s.peerId, { saved });
  sendChatEvent(s.peerId, saved ? 'saved' : 'unsaved', s.id);
  if (!saved && isMoment(s)) {
    forgetImage(s);
    // Copy is only still needed for the one extra view (receiver) or a pending moment (sender).
    const keep = canReplay({ ...s, saved: false }) || (s.dir === 'out' && s.status === 'pending');
    if (!keep) await dropFile(s.id, s.peerId);
  }
}

function SavedImage({ s, onPress, onLongPress }: { s: ChatMoment; onPress: () => void; onLongPress: () => void }) {
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    savedImageUri(s).then((u) => { if (alive) setUri(u); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [s]);
  return (
    <TouchableOpacity onPress={onPress} onLongPress={onLongPress} activeOpacity={0.85} style={styles.savedMedia}>
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        : failed ? <Icon name="image-broken-variant" size={28} color={colors.outline} />
        : <ActivityIndicator color={colors.kindPhoto} />}
      <View style={styles.savedBadge}><Icon name="bookmark" size={12} color="#000" /></View>
    </TouchableOpacity>
  );
}

/** Back button + left inset (72) and the four header buttons (4 × 40 + margin). */
const HEADER_RIGHT_SPACE = 244;

export default function ChatScreen({ route, navigation }: Props) {
  const { peerId } = route.params;
  const { width: winWidth } = useWindowDimensions();
  const { state } = useAuth();
  const insets = useSafeAreaInsets();
  const version = useChatStoreVersion();
  const isGroup = isGroupChat(peerId);
  const [, setGroupTick] = useState(0);
  useEffect(() => onGroupsChanged(() => setGroupTick((n) => n + 1)), []);
  const group = isGroup ? groupInfo(groupIdOf(peerId)) : undefined;
  const memberCount = group ? group.members.filter((m) => m.status === 'member').length : 0;
  const peerName = (isGroup ? group?.name : storedPeerName(peerId)) ?? route.params.peerName;
  const [keyChanged, setKeyChanged] = useState<string | undefined>();
  const [verified, setVerified] = useState(false);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null);
  const [editing, setEditing] = useState<ChatMoment | null>(null);
  // startedAt 0 = microphone still starting
  const [rec, setRec] = useState<{ startedAt: number } | null>(null);
  const [recMs, setRecMs] = useState(0);
  const [voiceState, setVoiceState] = useState<{ id: string; playing: boolean; pos: number } | null>(null);
  const [voiceBusy, setVoiceBusy] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);
  const settings = chatSettings(peerId);
  const ongoing = useOngoingGroupCall(isGroup ? groupIdOf(peerId) : '');
  const mentionable = useMemo(
    () => (group ? group.members.filter((m) => m.status === 'member').map((m) => ({ id: m.id, username: m.username })) : []),
    [group],
  );
  const mentionPrefix = isGroup ? typingMention(draft) : null;
  const suggestions = mentionPrefix === null ? [] : mentionable
    .filter((m) => m.id !== state.userId && m.username.toLowerCase().startsWith(mentionPrefix.toLowerCase()))
    .slice(0, 6);
  const ttl = settings.ttl ?? 'day';

  const openVerify = useCallback(() => navigation.navigate('Verify', { peerId, peerName }), [navigation, peerId, peerName]);
  const refreshKeyState = useCallback(() => {
    keyChangedAt(peerId).then(setKeyChanged);
    isVerified(peerId).then(setVerified);
  }, [peerId]);
  /** True when sending is allowed; otherwise asks about the pending key change. */
  const keyOk = useCallback(async () => isGroup || resolveKeyChange(peerId, peerName, {
    onVerify: openVerify,
    onAccepted: () => { refreshKeyState(); syncNow().catch(() => {}); },
  }), [isGroup, peerId, peerName, openVerify, refreshKeyState]);
  const openCamera = useCallback(async (reply?: ReplyRef) => {
    if (!(await keyOk())) return;
    navigation.navigate('Camera', { peerId, peerName, replyTo: reply });
  }, [navigation, peerId, peerName, keyOk]);
  const call = useCallback(async (video: boolean) => {
    if (!(await keyOk())) return;
    startCall(peerId, video).catch((e) => showAlert(t('Call failed'), e?.message ?? String(e), undefined, { icon: 'phone-off' }));
  }, [keyOk, peerId]);
  const openInfo = useCallback(() => navigation.navigate('GroupInfo', { groupId: groupIdOf(peerId) }), [navigation, peerId]);
  const menu = useCallback(() => (isGroup
    ? openGroupChatMenu(groupIdOf(peerId), peerName, state.userId ?? '', group?.ownerId, { onInfo: openInfo, onLeft: () => navigation.navigate('Home') })
    : openChatMenu(peerId, peerName, { onBlocked: () => navigation.navigate('Home') })),
  [isGroup, navigation, peerId, peerName, state.userId, group?.ownerId, openInfo]);

  useEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <TouchableOpacity onPress={menu} activeOpacity={0.7} style={[styles.headerTitle, { maxWidth: Math.max(120, winWidth - HEADER_RIGHT_SPACE) }]}>
          <Text style={styles.headerName} numberOfLines={1}>{peerName}{cake(peerId)}</Text>
          <View style={styles.headerSub}>
            {settings.muted && <Icon name="bell-off-outline" size={12} color={colors.onSurfaceVariant} />}
            <Text style={styles.headerSubText} numberOfLines={1}>
              {isGroup ? `${membersText(memberCount)} · ` : ''}
              {t('Messages disappear {when}', { when: ttlLabel(ttl) })}
            </Text>
          </View>
        </TouchableOpacity>
      ),
      headerRight: () => (
        <View style={{ flexDirection: 'row' }}>
          <IconButton name="phone-outline" onPress={() => call(false)} accessibilityLabel={isGroup ? t('Group call') : t('Voice call')} />
          <IconButton name="video-outline" onPress={() => call(true)} accessibilityLabel={isGroup ? t('Group video call') : t('Video call')} />
          {isGroup ? (
            <IconButton name="account-group-outline" onPress={openInfo} accessibilityLabel={t('Group info')} />
          ) : (
            <IconButton
              name={keyChanged ? 'shield-alert-outline' : verified ? 'shield-check' : 'shield-key-outline'}
              color={keyChanged ? colors.error : verified ? colors.tertiary : colors.onSurface}
              onPress={openVerify}
              accessibilityLabel={verified ? t('Verified — security code') : t('Verify security code')}
            />
          )}
          <IconButton name="dots-vertical" onPress={menu} accessibilityLabel={t('Chat settings')} />
        </View>
      ),
    });
  }, [navigation, peerName, openVerify, verified, keyChanged, menu, ttl, settings.muted, isGroup, memberCount, openInfo, call, winWidth]);

  useFocusEffect(useCallback(() => {
    setOpenChat(peerId);
    // No screenshots or screen recording while a chat is open.
    ScreenCapture.preventScreenCaptureAsync('chat').catch(() => {});
    if (!isGroup) refreshKeyState();
    syncNow().catch(() => {});
    const t = setInterval(() => { syncNow().catch(() => {}); }, POLLING_INTERVAL_MS);
    return () => {
      clearInterval(t);
      setOpenChat(null);
      stopVoice();
      ScreenCapture.allowScreenCaptureAsync('chat').catch(() => {});
      purgeViewed(peerId);
    };
  }, [peerId]));

  // Newest at the bottom (inverted list)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => momentsForPeer(peerId).reverse(), [peerId, version]);

  // Incoming messages count as read while the chat is open.
  useEffect(() => { markRead(peerId, items); }, [items, peerId]);

  // Recording timer + hard limit.
  useEffect(() => {
    if (!rec || !rec.startedAt) return;
    const t = setInterval(() => {
      const ms = Date.now() - rec.startedAt;
      setRecMs(ms);
      if (ms >= MAX_VOICE_MS) finishVoice(false);
    }, 200);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec]);

  async function send() {
    const body = draft.trim();
    if (!body) return;
    if (editing) {
      const e = editing;
      setEditing(null);
      setDraft('');
      await editText(e, body);
      return;
    }
    if (!(await keyOk())) return;
    setDraft('');
    const r = replyTo ?? undefined;
    setReplyTo(null);
    await sendText(peerId, peerName, body, r);
  }

  async function startVoice() {
    if (rec) return;
    if (!(await keyOk())) return;
    setRecMs(0);
    setRec({ startedAt: 0 }); // immediate feedback: "Starting microphone…"
    try {
      await stopVoice();
      await startVoiceRecording();
      setRec({ startedAt: Date.now() });
    } catch (e: any) {
      setRec(null);
      const denied = e instanceof VoiceError && e.step === 'denied';
      showAlert(
        t('Microphone not available'),
        e?.message ?? String(e),
        denied
          ? [{ text: t('Cancel'), style: 'cancel' }, { text: t('Open settings'), onPress: () => Linking.openSettings().catch(() => {}) }]
          : undefined,
        { icon: 'microphone-off' },
      );
    }
  }

  async function finishVoice(cancel: boolean) {
    if (rec && !rec.startedAt) return; // still starting
    setRec(null);
    const res = await stopVoiceRecording(cancel);
    if (!res) return;
    const r = replyTo ?? undefined;
    setReplyTo(null);
    try {
      await sendDraftToChat({ uri: res.uri, type: 'audio', voiceMs: res.ms, replyTo: r }, peerId, peerName, state.userId!);
    } catch (e: any) {
      if (e?.code) showSendError(e);
      else showAlert(t('Voice message not sent'), e.message);
    }
  }

  async function toggleVoice(s: ChatMoment) {
    if (voiceState?.id === s.id && voiceState.playing) {
      await stopVoice();
      setVoiceState(null);
      return;
    }
    setVoiceBusy(s.id);
    try {
      // (read receipt: the chat marks it read as soon as it is downloaded)
      await playVoice(s, (playing, pos) => setVoiceState(playing ? { id: s.id, playing, pos } : (cur) => (cur?.id === s.id ? null : cur)));
    } catch (e: any) {
      showAlert(t('Could not play'), e.message);
    } finally {
      setVoiceBusy(null);
    }
  }

  function open(s: ChatMoment) {
    if (!isMoment(s) || s.unsent) return;
    if (s.dir === 'in' && s.status === 'pending') {
      navigation.navigate('ViewMoment', { momentId: s.id, peerId, mode: 'first' });
    } else if (canViewSaved(s)) {
      navigation.navigate('ViewMoment', { momentId: s.id, peerId, mode: 'saved' });
    } else if (canReplay(s)) {
      showAlert(
        t('View again?'),
        t('Each moment can be viewed one more time — then it is gone. {name} will see that you did.', { name: authorName(s) }),
        [
          { text: t('Cancel'), style: 'cancel' },
          { text: t('View again'), onPress: () => navigation.navigate('ViewMoment', { momentId: s.id, peerId, mode: 'replay' }) },
        ],
        { icon: 'replay' },
      );
    }
  }

  function longPress(s: ChatMoment) {
    if (s.kind === 'system' || s.unsent) return;
    const actions: SheetAction[] = [
      { label: t('Reply'), icon: 'reply', onPress: () => { setReplyTo(quoteOf(s)); inputRef.current?.focus(); } },
      { label: t('Reply with a moment'), icon: 'camera-outline', onPress: () => openCamera(quoteOf(s)) },
    ];
    const canSave = !isMoment(s) || !!s.file || s.saved;
    if (canSave) {
      actions.push({
        label: s.saved ? t('Unsave') : t('Save in chat'),
        icon: s.saved ? 'bookmark-remove-outline' : 'bookmark-outline',
        onPress: () => toggleSaved(s),
      });
    }
    if (canEdit(s)) {
      actions.push({
        label: t('Edit'), icon: 'pencil-outline',
        onPress: () => { setReplyTo(null); setEditing(s); setDraft(s.text ?? ''); inputRef.current?.focus(); },
      });
    }
    if (s.dir === 'out') {
      actions.push({
        label: t('Unsend'), icon: 'undo-variant', destructive: true,
        onPress: async () => {
          const ok = await ask({
            title: t('Unsend?'),
            message: isGroup
              ? t('It is removed for everyone in the group. Some may already have seen it.')
              : t('It is removed for you and {name}. {name} may already have seen it.', { name: peerName }),
            confirm: t('Unsend'),
            destructive: true,
          });
          if (ok) unsend(s).catch((e) => showAlert(t('Could not unsend'), e.message));
        },
      });
    }
    showSheet({
      actions,
      header: (close) => (
        <View style={styles.reactRow}>
          {REACTIONS.map((e) => (
            <TouchableOpacity
              key={e}
              style={[styles.reactBtn, s.myReaction === e && styles.reactBtnActive]}
              onPress={() => { react(s, e); close(); }}
            >
              <Text style={styles.reactEmoji}>{e}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ),
    });
  }

  /** Extra space below a message that carries reaction badges. */
  const others = (s: ChatMoment) => [s.peerReaction, ...Object.values(s.reactions ?? {})].filter(Boolean) as string[];
  const reacted = (s: ChatMoment) => (s.myReaction || others(s).length ? { marginBottom: 12 } : null);

  function Reactions({ s, mine }: { s: ChatMoment; mine: boolean }) {
    const list = others(s);
    if (!s.myReaction && list.length === 0) return null;
    return (
      <View style={[styles.reactions, mine ? { right: 8 } : { left: 8 }]}>
        {list.slice(0, 6).map((e, i) => <Text key={i} style={styles.reactionText}>{e}</Text>)}
        {s.myReaction ? <Text style={styles.reactionText}>{s.myReaction}</Text> : null}
      </View>
    );
  }

  /** In group chats: who wrote an incoming entry. */
  function Author({ s }: { s: ChatMoment }) {
    if (!isGroup || s.dir === 'out') return null;
    return <Text style={styles.author} numberOfLines={1}>{authorName(s)}</Text>;
  }

  function Quote({ r, mine }: { r: ReplyRef; mine: boolean }) {
    return (
      <View style={[styles.quote, mine && styles.quoteOnColor]}>
        <Icon name={r.k === 'text' ? 'reply' : r.k === 'voice' ? 'microphone' : r.k === 'story' ? 'circle-slice-8' : 'camera'} size={12} color={mine ? '#fff' : colors.onSurfaceVariant} />
        <Text style={[styles.quoteText, mine && { color: 'rgba(255,255,255,0.85)' }]} numberOfLines={2}>{r.q}</Text>
      </View>
    );
  }

  function renderSystem(s: ChatMoment) {
    return <Text style={styles.systemLine}>{s.text}</Text>;
  }

  function renderUnsent(s: ChatMoment) {
    return (
      <View style={[styles.line, s.dir === 'out' ? styles.lineOut : styles.lineIn]}>
        <View style={styles.unsentBubble}>
          <Icon name="undo-variant" size={14} color={colors.outline} />
          <Text style={styles.unsentText}>{s.dir === 'out' ? t('You unsent this') : t('{name} unsent this', { name: authorName(s) })}</Text>
        </View>
      </View>
    );
  }

  function metaLine(s: ChatMoment, onColor: boolean) {
    const mine = s.dir === 'out';
    const parts = [clock(s.createdAt)];
    if (s.edited) parts.push(t('edited'));
    if (mine && s.status === 'pending' && s.kind === 'text') parts.push(t('sending…'));
    else if (mine && (s.kind === 'text' || s.kind === 'voice')) parts.push(s.peerReadAt ? (s.kind === 'voice' ? t('listened') : t('read')) : t('sent'));
    if (mine && isGroup && s.kind === 'voice' && s.openedBy) parts.push(t('Opened by {n}', { n: Object.keys(s.openedBy).length }));
    if (!s.saved && (s.kind === 'text' || s.kind === 'voice')) parts.push(ttl === 'viewed' ? t('after viewing') : `${hoursLeft(s)}h`);
    return (
      <View style={styles.textMetaRow}>
        {s.saved && <Icon name="bookmark" size={12} color={onColor ? '#fff' : colors.kindText} />}
        <Text style={[styles.meta, onColor && styles.metaOnColor]}>{parts.join('  ·  ')}</Text>
      </View>
    );
  }

  function renderText(s: ChatMoment) {
    const mine = s.dir === 'out';
    return (
      <View style={[styles.line, mine ? styles.lineOut : styles.lineIn, reacted(s)]}>
        <TouchableOpacity
          style={[styles.textBubble, mine ? styles.textOut : styles.textIn, s.saved && !mine && styles.bubbleSavedIn, s.mentionsMe && !mine && styles.bubbleMentioned]}
          onLongPress={() => longPress(s)}
          delayLongPress={300}
          activeOpacity={0.8}
        >
          {s.replyTo && <Quote r={s.replyTo} mine={mine} />}
          <Text style={[styles.textBody, mine && { color: '#fff' }]} selectable={false}>
            {isGroup && s.text && s.text.includes('@')
              ? splitMentions(s.text, mentionable).map((p, i) => (p.mention
                ? <Text key={i} style={[styles.mention, p.mention === state.userId && styles.mentionMe, mine && { color: '#fff' }]}>{p.text}</Text>
                : <Text key={i}>{p.text}</Text>))
              : s.text}
          </Text>
          {metaLine(s, mine)}
        </TouchableOpacity>
        <Reactions s={s} mine={mine} />
      </View>
    );
  }

  function renderVoice(s: ChatMoment) {
    const mine = s.dir === 'out';
    const active = voiceState?.id === s.id && voiceState.playing;
    const total = s.voiceMs ?? 0;
    const pos = active ? voiceState!.pos : 0;
    const pendingIn = !mine && s.status === 'pending';
    const gone = !s.file && !pendingIn;
    return (
      <View style={[styles.line, mine ? styles.lineOut : styles.lineIn, reacted(s)]}>
        <TouchableOpacity
          style={[styles.voiceBubble, mine ? styles.textOut : styles.textIn, pendingIn && styles.voiceNew]}
          onPress={() => !gone && toggleVoice(s)}
          onLongPress={() => longPress(s)}
          delayLongPress={300}
          activeOpacity={0.8}
        >
          {s.replyTo && <Quote r={s.replyTo} mine={mine} />}
          <View style={styles.voiceRow}>
            {voiceBusy === s.id ? (
              <ActivityIndicator color={mine ? '#fff' : colors.kindText} size="small" />
            ) : (
              <Icon name={gone ? 'microphone-off' : active ? 'pause-circle' : 'play-circle'} size={30} color={mine ? '#fff' : colors.kindText} />
            )}
            <View style={styles.voiceTrack}>
              <View style={[styles.voiceFill, { width: `${total ? Math.min(100, (pos / total) * 100) : 0}%`, backgroundColor: mine ? '#fff' : colors.kindText }]} />
            </View>
            <Text style={[styles.voiceTime, mine && { color: '#fff' }]}>
              {active ? mmss(pos) : pendingIn ? t('New') : gone ? t('Gone') : total ? mmss(total) : ''}
            </Text>
          </View>
          {metaLine(s, mine)}
        </TouchableOpacity>
        <Reactions s={s} mine={mine} />
      </View>
    );
  }

  function renderMoment(s: ChatMoment) {
    const mine = s.dir === 'out';
    if (canViewSaved(s) && s.mediaType === 'image') {
      return (
        <View style={[styles.line, mine ? styles.lineOut : styles.lineIn, reacted(s)]}>
          <View>
            {s.replyTo && <Quote r={s.replyTo} mine={false} />}
            <SavedImage s={s} onPress={() => open(s)} onLongPress={() => longPress(s)} />
            <Text style={[styles.meta, { alignSelf: mine ? 'flex-end' : 'flex-start', marginTop: 3 }]}>
              {authorName(s)} · {clock(s.createdAt)}
            </Text>
          </View>
          <Reactions s={s} mine={mine} />
        </View>
      );
    }
    const st = momentState(s);
    const accent = kindColor(s);
    const isNew = s.dir === 'in' && s.status === 'pending';
    const tappable = isNew || canViewSaved(s) || canReplay(s);
    const savedVideo = canViewSaved(s) && s.mediaType === 'video';
    return (
      <View style={[styles.line, mine ? styles.lineOut : styles.lineIn, reacted(s)]}>
        <TouchableOpacity
          style={[
            styles.bubble,
            { borderColor: accent },
            isNew && { backgroundColor: accent },
            savedVideo && styles.savedVideo,
          ]}
          onPress={() => open(s)}
          onLongPress={() => longPress(s)}
          delayLongPress={300}
          activeOpacity={tappable ? 0.6 : 1}
        >
          <Icon name={savedVideo ? 'play-circle' : st.icon} size={savedVideo ? 30 : 18} color={isNew ? '#000' : accent} />
          <View style={{ flexShrink: 1 }}>
            {s.replyTo && <Quote r={s.replyTo} mine={false} />}
            <Text style={[styles.bubbleText, isNew && { color: '#000', fontWeight: '700' }]}>
              {savedVideo ? t('Saved video') : st.label}
              {s.groupName ? ` · ${s.groupName}` : ''}
            </Text>
            <Text style={[styles.meta, isNew && { color: 'rgba(0,0,0,0.7)' }]}>
              {clock(s.createdAt)}
              {isNew ? `  ·  ${t('tap to view')}` : ''}
              {canReplay(s) ? `  ·  ${t('tap to view again')}` : ''}
              {savedVideo ? `  ·  ${t('tap to play')}` : ''}
            </Text>
          </View>
          {s.saved && !savedVideo && <Icon name="bookmark" size={16} color={accent} />}
        </TouchableOpacity>
        <Reactions s={s} mine={mine} />
      </View>
    );
  }

  function renderEntry(s: ChatMoment) {
    if (s.kind === 'system') return renderSystem(s);
    if (s.unsent) return renderUnsent(s);
    if (isText(s)) return renderText(s);
    if (s.kind === 'voice') return renderVoice(s);
    return renderMoment(s);
  }

  function renderItem(s: ChatMoment) {
    if (!isGroup || s.dir === 'out' || s.kind === 'system') return renderEntry(s);
    return <View><Author s={s} />{renderEntry(s)}</View>;
  }

  const hint = t('Messages disappear {when} · long-press for more', { when: ttlLabel(ttl) });

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 0}
    >
      {keyChanged && (
        <TouchableOpacity style={styles.keyBanner} onPress={() => { keyOk(); }} activeOpacity={0.7}>
          <Icon name="shield-alert-outline" size={18} color={colors.onErrorContainer} />
          <Text style={styles.keyBannerText}>
            {t("{name}'s security key changed. Nothing is sent or accepted until you check it — tap here.", { name: peerName })}
          </Text>
        </TouchableOpacity>
      )}
      {ongoing && (
        <TouchableOpacity
          style={styles.callBanner}
          onPress={() => joinGroupCall(groupIdOf(peerId)).catch((e) => showAlert(t('Call failed'), e?.message ?? String(e)))}
          activeOpacity={0.8}
        >
          <Icon name={ongoing.video ? 'video' : 'phone'} size={18} color={colors.onTertiaryContainer} />
          <Text style={styles.callBannerText}>{t('Group call running · {n} in it', { n: ongoing.count })}</Text>
          <Text style={styles.callBannerJoin}>{t('Join')}</Text>
        </TouchableOpacity>
      )}
      {items.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            {isGroup ? t('No moments or messages in {name} yet.', { name: peerName }) : t('No moments or messages with {name} yet.', { name: peerName })}
          </Text>
          <Text style={styles.hint}>{hint}</Text>
        </View>
      ) : (
        <FlatList
          inverted
          data={items}
          keyExtractor={(s) => s.id}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item: s }) => renderItem(s)}
          ListHeaderComponent={<Text style={styles.hint}>{hint}</Text>}
        />
      )}

      {editing && (
        <View style={styles.replyBar}>
          <Icon name="pencil-outline" size={16} color={colors.kindText} />
          <Text style={styles.replyBarText} numberOfLines={1}>{t('Edit message')}</Text>
          <IconButton name="close" size={18} onPress={() => { setEditing(null); setDraft(''); }} accessibilityLabel={t('Cancel')} />
        </View>
      )}

      {replyTo && (
        <View style={styles.replyBar}>
          <Icon name="reply" size={16} color={colors.kindText} />
          <Text style={styles.replyBarText} numberOfLines={1}>{replyTo.q}</Text>
          <IconButton name="close" size={18} onPress={() => setReplyTo(null)} accessibilityLabel={t('Cancel reply')} />
        </View>
      )}

      {suggestions.length > 0 && (
        <View style={styles.mentionBar}>
          {suggestions.map((m) => (
            <TouchableOpacity key={m.id} style={styles.mentionChip} onPress={() => setDraft((d) => completeMention(d, m.username))} activeOpacity={0.7}>
              <Text style={styles.mentionChipText}>@{m.username}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={[styles.bottomBar, { paddingBottom: 8 + insets.bottom }]}>
        {rec ? (
          <>
            <IconButton name="delete-outline" color={colors.error} onPress={() => finishVoice(true)} accessibilityLabel={t('Discard recording')} />
            <View style={styles.recBar}>
              <View style={styles.recDot} />
              <Text style={styles.recText}>
                {rec.startedAt ? `${t('Recording')}  ${mmss(recMs)} / ${mmss(MAX_VOICE_MS)}` : t('Starting microphone…')}
              </Text>
            </View>
            <TouchableOpacity style={styles.sendVoiceBtn} onPress={() => finishVoice(false)} accessibilityLabel={t('Send voice message')}>
              <Icon name="send" size={20} color="#fff" />
            </TouchableOpacity>
          </>
        ) : (
          <>
            <TouchableOpacity
              style={styles.cameraBtn}
              onPress={() => openCamera(replyTo ?? undefined)}
              activeOpacity={0.85}
              accessibilityLabel={t('Moment to {name}', { name: peerName })}
            >
              <Icon name="camera" size={22} color={colors.onPrimary} />
            </TouchableOpacity>
            <TextInput
              ref={inputRef}
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder={t('Message')}
              placeholderTextColor={colors.outline}
              selectionColor={colors.kindText}
              multiline
              maxLength={MAX_TEXT_LEN}
            />
            {draft.trim() ? (
              <IconButton name={editing ? 'check' : 'send'} onPress={send} color={colors.kindText} accessibilityLabel={editing ? t('Save') : t('Send message')} />
            ) : (
              <IconButton name="microphone" onPress={startVoice} color={colors.onSurface} accessibilityLabel={t('Record voice message')} />
            )}
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  headerTitle: { flexShrink: 1 },
  headerName: { ...typescale.titleMedium, color: colors.onSurface, fontWeight: '700', fontSize: 17 },
  headerSub: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerSubText: { ...typescale.labelSmall, color: colors.onSurfaceVariant, flexShrink: 1 },

  list: { paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
  emptyText: { ...typescale.bodyMedium, color: colors.onSurfaceVariant },
  hint: { ...typescale.labelSmall, color: colors.outline, textAlign: 'center', paddingVertical: 6 },
  systemLine: { ...typescale.labelSmall, color: colors.outline, textAlign: 'center', paddingVertical: 4, fontStyle: 'italic' },

  line: { flexDirection: 'row' },
  lineIn: { justifyContent: 'flex-start' },
  lineOut: { justifyContent: 'flex-end' },
  bubble: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: shape.large, maxWidth: '82%',
    borderWidth: 1.5, backgroundColor: colors.surfaceContainer,
  },
  savedVideo: { paddingVertical: 14 },
  bubbleText: { ...typescale.bodyMedium, color: colors.onSurface, fontWeight: '500' },
  meta: { ...typescale.labelSmall, color: colors.onSurfaceVariant, marginTop: 1 },
  metaOnColor: { color: 'rgba(255,255,255,0.8)' },

  textBubble: { paddingHorizontal: 12, paddingTop: 7, paddingBottom: 5, borderRadius: shape.large, maxWidth: '82%' },
  textIn: { backgroundColor: colors.surfaceContainerHigh, borderBottomLeftRadius: shape.extraSmall, borderLeftWidth: 3, borderLeftColor: colors.kindText },
  textOut: { backgroundColor: colors.kindText, borderBottomRightRadius: shape.extraSmall },
  bubbleSavedIn: { borderWidth: 1, borderColor: colors.kindText },
  textBody: { ...typescale.bodyLarge, color: colors.onSurface, lineHeight: 21 },
  textMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-end', marginTop: 2 },

  quote: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4,
    borderLeftWidth: 2, borderLeftColor: colors.outline, paddingLeft: 6, paddingVertical: 2,
  },
  quoteOnColor: { borderLeftColor: 'rgba(255,255,255,0.7)' },
  quoteText: { ...typescale.bodySmall, color: colors.onSurfaceVariant, flexShrink: 1 },

  reactions: {
    position: 'absolute', bottom: -10, flexDirection: 'row', gap: 2,
    backgroundColor: colors.surfaceContainerHighest, borderRadius: shape.full, paddingHorizontal: 5, paddingVertical: 1,
    borderWidth: 1, borderColor: colors.background,
  },
  reactionText: { fontSize: 13 },
  author: { ...typescale.labelSmall, color: colors.onSurfaceVariant, marginLeft: 12, marginBottom: 2, marginTop: 4 },
  reactRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4, marginBottom: 6 },
  reactBtn: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceContainerHigh },
  reactBtnActive: { backgroundColor: colors.primaryContainer, borderWidth: 1, borderColor: colors.primary },
  reactEmoji: { fontSize: 24 },

  unsentBubble: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderRadius: shape.large, paddingHorizontal: 12, paddingVertical: 7,
    borderWidth: 1, borderStyle: 'dashed', borderColor: colors.outlineVariant,
  },
  unsentText: { ...typescale.bodySmall, color: colors.outline, fontStyle: 'italic' },

  savedMedia: {
    width: 200, height: 280, borderRadius: shape.large, overflow: 'hidden',
    backgroundColor: colors.surfaceContainerHigh, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: colors.kindPhoto,
  },
  savedBadge: {
    position: 'absolute', top: 8, right: 8, width: 22, height: 22, borderRadius: 11,
    backgroundColor: colors.kindPhoto, alignItems: 'center', justifyContent: 'center',
  },

  voiceBubble: { paddingHorizontal: 10, paddingTop: 8, paddingBottom: 5, borderRadius: shape.large, width: 240, maxWidth: '82%' },
  voiceNew: { borderWidth: 2, borderColor: colors.kindText },
  voiceRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  voiceTrack: { flex: 1, height: 4, borderRadius: 2, backgroundColor: 'rgba(127,127,127,0.35)', overflow: 'hidden' },
  voiceFill: { height: 4 },
  voiceTime: { ...typescale.labelMedium, color: colors.onSurface, minWidth: 34, textAlign: 'right' },

  mention: { fontWeight: '700', color: colors.kindText },
  mentionMe: { backgroundColor: colors.tertiaryContainer, color: colors.onTertiaryContainer },
  bubbleMentioned: { borderWidth: 1.5, borderColor: colors.tertiary },
  mentionBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 10, paddingTop: 6 },
  mentionChip: { backgroundColor: colors.surfaceContainerHigh, borderRadius: shape.full, paddingHorizontal: 12, height: 32, justifyContent: 'center' },
  mentionChipText: { ...typescale.labelLarge, color: colors.onSurface },
  callBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 10, marginTop: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: shape.large, backgroundColor: colors.tertiaryContainer,
  },
  callBannerText: { ...typescale.bodyMedium, color: colors.onTertiaryContainer, flex: 1 },
  callBannerJoin: { ...typescale.labelLarge, color: colors.onTertiaryContainer, fontWeight: '700' },
  keyBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.errorContainer, paddingHorizontal: 14, paddingVertical: 10,
  },
  keyBannerText: { ...typescale.bodySmall, color: colors.onErrorContainer, flex: 1 },

  replyBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 4,
    backgroundColor: colors.surfaceContainer, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.outlineVariant,
  },
  replyBarText: { ...typescale.bodyMedium, color: colors.onSurfaceVariant, flex: 1 },

  bottomBar: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 6,
    paddingHorizontal: 8, paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.outlineVariant,
    backgroundColor: colors.surfaceContainerLow,
  },
  cameraBtn: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  input: {
    flex: 1, minHeight: 42, maxHeight: 120,
    backgroundColor: colors.surfaceContainerHigh, borderRadius: 21,
    paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10,
    ...typescale.bodyLarge, color: colors.onSurface,
  },
  recBar: {
    flex: 1, height: 42, borderRadius: 21, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14,
    backgroundColor: colors.surfaceContainerHigh,
  },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.error },
  recText: { ...typescale.labelLarge, color: colors.onSurface },
  sendVoiceBtn: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: colors.kindText,
    alignItems: 'center', justifyContent: 'center',
  },
});
