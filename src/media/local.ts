/**
 * Decrypting local copies (saved moments shown in the chat, voice messages) and voice
 * recording / playback. Decrypted data only lives in memory or as a temp file in the
 * cache directory that is deleted after use.
 */
import * as FileSystem from 'expo-file-system';
import { Audio } from 'expo-av';
import { PermissionsAndroid, Platform } from 'react-native';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { downloadMedia, markViewed } from '../api/media';
import { downloadGroupMedia, markGroupMediaViewed } from '../api/groups';
import { decryptMedia, unwrapMedia } from '../crypto/encryption';
import { loadPrivateKey } from '../crypto/keys';
import { getPeerKey } from '../crypto/peerKeys';
import { Binding, bindingErrorText, checkBinding, openFrom } from '../crypto/sealed';
import { decryptBlob, openFromPeer, unpackMedia } from '../crypto/channel';
import { readMomentPayload } from '../send/payload';
import {
  ChatMoment, MOMENT_DIR, getMoment, groupIdOf, isGroupChat, isSeen, markSeen, updateMoment,
} from '../store/chatStore';
import { getUserId } from '../store/session';
import { sendReceipt } from '../sync/sync';
import { t } from '../i18n';
import { blobMatches } from './tools';

async function readCipher(path: string): Promise<Uint8Array> {
  return decodeBase64(await FileSystem.readAsStringAsync(path, { encoding: FileSystem.EncodingType.Base64 }));
}

async function writeCipher(path: string, bytes: Uint8Array) {
  await FileSystem.writeAsStringAsync(path, encodeBase64(bytes), { encoding: FileSystem.EncodingType.Base64 });
}

/** Decrypts the local copy of a moment / voice message (new format with `mk`, or the old box). */
export async function decryptLocal(s: ChatMoment): Promise<Uint8Array> {
  if (!s.file) throw new Error(t('Not stored on this device any more.'));
  const bytes = await readCipher(s.file);
  if (s.mk) {
    const plain = decryptBlob(bytes, s.mk);
    if (!plain) throw new Error(t('Could not decrypt moment'));
    return plain;
  }
  if (!s.eph || !s.nonce) throw new Error(t('Not stored on this device any more.'));
  return decryptMedia(bytes, s.nonce, s.eph, await loadPrivateKey());
}

async function openLocal(s: ChatMoment) {
  const { header, mediaBytes } = unwrapMedia(await decryptLocal(s));
  return readMomentPayload(header, mediaBytes);
}

/** Thrown after the download when the content can never be opened (it is burned then). */
export class UnreadableError extends Error {}

/**
 * First open of an incoming moment / voice message: downloads it, checks who sent it, keeps
 * the ciphertext locally (for the one replay / saving) and deletes the server copy.
 * The friend's key is checked BEFORE the download, so a pending key change burns nothing.
 * Returns the decrypted payload (header + media).
 */
export async function fetchIncoming(s: ChatMoment): Promise<{ plain: Uint8Array; type: 'image' | 'video' | 'audio' }> {
  const myId = await getUserId();
  if (!myId) throw new Error('not logged in');
  const path = `${MOMENT_DIR}in_${s.id}.enc`;
  let type = s.mediaType;
  let plain: Uint8Array;
  if (isGroupChat(s.peerId)) {
    if (!s.mk || !s.from) throw new Error(t('This moment is no longer available.'));
    const blob = await downloadGroupMedia(s.id);
    // written first: the hash of the shared blob is checked natively on the file
    await writeCipher(path, blob);
    const intact = await blobMatches(s.bh, blob, path);
    const opened = intact ? decryptBlob(blob, s.mk) : null;
    const h = opened ? unwrapMedia(opened).header : null;
    if (!opened || !h || h.f !== s.from || h.g !== groupIdOf(s.peerId)) {
      FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
      markGroupMediaViewed(s.id).catch(() => {});
      updateMoment(s.id, s.peerId, { status: 'opened', openedAt: new Date().toISOString(), mk: undefined });
      throw new UnreadableError(t('This moment could not be decrypted.'));
    }
    plain = opened;
    updateMoment(s.id, s.peerId, { status: 'opened', openedAt: new Date().toISOString(), file: path });
    markGroupMediaViewed(s.id).catch(() => {});
  } else {
    const peerKey = await getPeerKey(s.peerId);
    const dl = await downloadMedia(s.id);
    if (dl.mediaType === 'video' || dl.mediaType === 'image' || dl.mediaType === 'audio') type = dl.mediaType;
    const burn = (msg: string) => {
      updateMoment(s.id, s.peerId, { status: 'opened', openedAt: new Date().toISOString() });
      markViewed(s.id).catch(() => {});
      return new UnreadableError(msg);
    };
    const packed = unpackMedia(dl.ciphertext);
    if (packed) {
      // forward secret: the envelope (ratchet) carries the blob key and the sender binding
      const env = await openFromPeer<Partial<Binding> & { t?: string; k?: string; h?: string }>(s.peerId, myId, packed.envelope, { peerKey, persist: true });
      if (!env || env.obj.t !== 'media' || typeof env.obj.k !== 'string') throw burn(t('This moment could not be decrypted.'));
      const err = checkBinding(env.obj, s.peerId, myId, isSeen);
      if (err) throw burn(t(bindingErrorText(err)));
      // The blob may be shared with other recipients (same key): it must be the one the
      // sender hashed into MY envelope.
      await writeCipher(path, packed.blob);
      const intact = await blobMatches(env.obj.h, packed.blob, path);
      const opened = intact ? decryptBlob(packed.blob, env.obj.k) : null;
      if (!opened) {
        FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
        throw burn(t('This moment could not be decrypted.'));
      }
      markSeen(env.obj.x!);
      plain = opened;
      updateMoment(s.id, s.peerId, { status: 'opened', openedAt: new Date().toISOString(), mediaType: type, file: path, mk: env.obj.k });
    } else {
      const secret = await loadPrivateKey();
      // Authenticated open: must be sealed with the key we trust for this friend.
      const opened = openFrom(dl.ciphertext, dl.nonce, peerKey, secret);
      if (!opened) {
        let legacy = false;
        try { decryptMedia(dl.ciphertext, dl.nonce, dl.ephemeralPublicKey, secret); legacy = true; } catch (_) {}
        throw burn(legacy ? t(bindingErrorText('missing')) : t('This moment could not be decrypted (it was sent to an old key of yours).'));
      }
      const header = unwrapMedia(opened).header;
      const bindErr = checkBinding(header ?? undefined, s.peerId, myId, isSeen);
      if (bindErr) throw burn(t(bindingErrorText(bindErr)));
      markSeen(header!.x);
      plain = opened;
      await writeCipher(path, dl.ciphertext);
      updateMoment(s.id, s.peerId, {
        status: 'opened', openedAt: new Date().toISOString(), mediaType: type,
        // the sender's key it was verified with — used for later views
        file: path, eph: peerKey, nonce: dl.nonce,
      });
    }
    // Server copy is deleted right away.
    markViewed(s.id).catch(() => {});
  }
  // The sender learns "opened" end-to-end encrypted.
  if (type !== 'audio') sendReceipt(s, 'opened');
  return { plain, type };
}

// Small in-memory cache for inline images (decrypted data never touches the disk).
const imageCache = new Map<string, string>();

/** data: URI of a saved photo, for showing it inline in the chat. */
export async function savedImageUri(s: ChatMoment): Promise<string> {
  const k = `${s.id}:${s.peerId}`;
  const hit = imageCache.get(k);
  if (hit) return hit;
  const { media } = await openLocal(s);
  const uri = `data:image/jpeg;base64,${encodeBase64(media)}`;
  imageCache.set(k, uri);
  if (imageCache.size > 24) imageCache.delete(imageCache.keys().next().value!);
  return uri;
}

export function forgetImage(s: ChatMoment) {
  imageCache.delete(`${s.id}:${s.peerId}`);
}

// ---- Voice messages ----------------------------------------------------------------

export const MAX_VOICE_MS = 2 * 60 * 1000;

let recording: Audio.Recording | null = null;

/** Error with a step name, so a failing phone tells us where it got stuck. */
export class VoiceError extends Error {
  constructor(message: string, public step: 'permission' | 'denied' | 'start') {
    super(message);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(onTimeout()), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Android's own permission flow (expo-av's request can stay silent on some profiles). */
async function ensureMicPermission(): Promise<void> {
  if (Platform.OS !== 'android') {
    const perm = await Audio.requestPermissionsAsync();
    if (!perm.granted) throw new VoiceError(t('Mayfly needs microphone access for voice messages.'), 'denied');
    return;
  }
  const P = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
  if (await PermissionsAndroid.check(P)) return;
  const res = await withTimeout(
    PermissionsAndroid.request(P),
    30_000,
    () => new VoiceError(t('Android did not answer the microphone permission request.'), 'permission'),
  );
  if (res === PermissionsAndroid.RESULTS.GRANTED) return;
  throw new VoiceError(
    res === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN
      ? t('Microphone access is turned off for Mayfly. Allow it in the app settings (Permissions → Microphone).')
      : t('Mayfly needs microphone access for voice messages.'),
    'denied',
  );
}

export async function startVoiceRecording(): Promise<void> {
  await ensureMicPermission();
  await withTimeout(
    (async () => {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording: r } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      recording = r;
    })(),
    8_000,
    () => new VoiceError(t('The microphone did not start. Is another app using it?'), 'start'),
  ).catch((e) => {
    if (e instanceof VoiceError) throw e;
    throw new VoiceError(t('The microphone did not start: {error}', { error: e?.message ?? String(e) }), 'start');
  });
}

/** Stops; returns the file and its length, or null when cancelled / too short. */
export async function stopVoiceRecording(cancel = false): Promise<{ uri: string; ms: number } | null> {
  const r = recording;
  recording = null;
  if (!r) return null;
  let ms = 0;
  try {
    const st = await r.getStatusAsync();
    ms = st.durationMillis ?? 0;
    await r.stopAndUnloadAsync();
  } catch (_) {}
  await Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(() => {});
  const uri = r.getURI();
  if (cancel || !uri || ms < 600) {
    if (uri) FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    return null;
  }
  return { uri, ms: Math.min(ms, MAX_VOICE_MS) };
}

/**
 * Gets a playable temp file for a voice message. An incoming one is fetched from the
 * server on first play (then deleted there, like an opened moment) and kept encrypted
 * locally while it is in the chat.
 */
export async function voiceFile(s: ChatMoment): Promise<string> {
  let cur = getMoment(s.id, s.peerId) ?? s;
  if (cur.dir === 'in' && cur.status === 'pending') {
    const { plain } = await fetchIncoming(cur);
    const { header, mediaBytes } = unwrapMedia(plain);
    const info = readMomentPayload(header, mediaBytes);
    cur = updateMoment(cur.id, cur.peerId, { voiceMs: info.ms ?? cur.voiceMs }) ?? cur;
  }
  const { media } = await openLocal(cur);
  const tmp = `${FileSystem.cacheDirectory}voice_${cur.id}.m4a`;
  await FileSystem.writeAsStringAsync(tmp, encodeBase64(media), { encoding: FileSystem.EncodingType.Base64 });
  return tmp;
}

let playing: { sound: Audio.Sound; tmp: string; id: string } | null = null;

export async function stopVoice() {
  const p = playing;
  playing = null;
  if (!p) return;
  await p.sound.unloadAsync().catch(() => {});
  FileSystem.deleteAsync(p.tmp, { idempotent: true }).catch(() => {});
}

/** Plays a voice message; `onDone` runs when it ended or was stopped. */
export async function playVoice(s: ChatMoment, onStatus: (playing: boolean, posMs: number) => void): Promise<void> {
  await stopVoice();
  const tmp = await voiceFile(s);
  await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
  const { sound } = await Audio.Sound.createAsync({ uri: tmp }, { shouldPlay: true });
  playing = { sound, tmp, id: s.id };
  sound.setOnPlaybackStatusUpdate((st) => {
    if (!st.isLoaded) return;
    onStatus(st.isPlaying, st.positionMillis);
    if (st.didJustFinish) {
      onStatus(false, 0);
      if (playing?.id === s.id) stopVoice();
    }
  });
}

export function playingId(): string | null {
  return playing?.id ?? null;
}

// ---- Plaintext temp files ----------------------------------------------------------

const TEMP_DIRS = ['Camera', 'ImagePicker', 'Audio'];
const TEMP_PREFIXES = ['ReactNative-', 'view_', 'voice_', 'moment_', 'recording-'];

/**
 * Deletes plaintext media the app left in its cache: camera captures, gallery copies,
 * flattened moments, voice recordings, decrypted temp files. Called when nothing is being
 * composed or viewed (app start, chat list).
 */
export async function cleanupTempMedia(): Promise<void> {
  const dir = FileSystem.cacheDirectory;
  if (!dir) return;
  let names: string[] = [];
  try { names = await FileSystem.readDirectoryAsync(dir); } catch { return; }
  await Promise.all(names
    .filter((n) => TEMP_DIRS.includes(n) || TEMP_PREFIXES.some((p) => n.startsWith(p)))
    .map((n) => FileSystem.deleteAsync(dir + n, { idempotent: true }).catch(() => {})));
}

/** Deletes one plaintext file if it lives in the cache directory. */
export function deleteIfCached(uri?: string) {
  const dir = FileSystem.cacheDirectory;
  if (uri && dir && uri.startsWith(dir)) FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
}
