/**
 * Encrypts and sends a moment or voice message to one or more friends (or a group).
 * Used by the Send To screen and directly from a chat (camera / voice button).
 *
 * Everything that describes the moment travels inside the encrypted payload header:
 * caption (c), view time in seconds (d, 0 = until closed), what it answers (rp),
 * an optional overlay layer for videos (ol = byte length of a PNG appended after the
 * media, a = aspect ratio of the canvas it was drawn on), voice length (ms), plus the
 * sender binding (f/r→rcpt/ts/x — see crypto/sealed.ts).
 */
import * as FileSystem from 'expo-file-system';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { sendMedia } from '../api/media';
import { sendGroupMedia } from '../api/groups';
import { wrapMedia } from '../crypto/encryption';
import { loadPrivateKey } from '../crypto/keys';
import { getPeerKey } from '../crypto/peerKeys';
import { newBinding, seal } from '../crypto/sealed';
import { encryptBlob, packMedia, sealEnvelope } from '../crypto/channel';
import { flushSessions, isFsPeer } from '../crypto/sessions';
import {
  ReplyRef, MOMENT_DIR, bumpContact, groupChatId, loadChatStore, upsertMoment,
} from '../store/chatStore';
import { announceGroupMedia } from '../sync/sync';
import { t } from '../i18n';
import { TokenGoneError, sealedMedia } from '../api/sealed';
import { newSecret, sealSender, sha256b64 } from '../crypto/sealedSender';
import { peerToken, setPeerToken } from '../store/deliveryTokens';
import { PayloadDraft, buildPayload, deletePlainOriginals, writeBytes } from './build';
import { blobHash } from '../media/tools';

export { deletePlainOriginals };

export interface MomentDraft extends PayloadDraft {
  uri: string;
  type: 'image' | 'video' | 'audio';
  caption?: string;
  /** View time in seconds for photos (0 = until closed). */
  dur?: number;
  /** PNG drawn over a video (photos are flattened before sending). */
  overlayUri?: string;
  /** width / height of the canvas the overlay was drawn on. */
  aspect?: number;
  replyTo?: ReplyRef;
  voiceMs?: number;
  /** Colour filter id of a video (photos are filtered before sending). */
  filter?: string;
  /** Videos: playback speed (0.5 / 2). */
  speed?: number;
  /** Videos: no sound (the track is removed; the flag makes old copies play muted too). */
  muted?: boolean;
  /** Link attached to the moment. */
  link?: string;
  /** Dual camera video: second clip + layout. */
  dual?: { uri: string; rect: number[]; main: number[]; layout: 'pip' | 'split' };
}

export interface Recipient { id: string; username: string }

/** The server refused the upload because of its limits (or a full disk). */
export class QuotaError extends Error {
  constructor(public code: 'quota' | 'server_full', message: string) {
    super(message);
  }
}

function quotaFrom(e: any): QuotaError | null {
  const code = e?.response?.data?.code;
  return code === 'quota' || code === 'server_full' ? new QuotaError(code, e.response.data.message) : null;
}

/**
 * Sends to friends one by one (each gets an own server copy that is deleted once opened).
 *
 * Friends with forward secrecy get "MFM1" | envelope | blob: the payload is encrypted once
 * with a random key, the envelope (ratchet) carries that key and the sender binding. Older
 * friends get the payload sealed with the static keys, as before.
 */
export async function sendMomentTo(
  draft: MomentDraft,
  recipients: Recipient[],
  myId: string,
  opts: { groupId?: string; groupName?: string; onProgress?: (text: string) => void; keepOriginals?: boolean } = {},
): Promise<{ sent: number; errors: string[] }> {
  if (recipients.length === 0) throw new Error('No recipients');
  await loadChatStore();
  const { body, header } = await buildPayload(draft);

  const secret = await loadPrivateKey();
  const publicKeys = await Promise.all(recipients.map((r) => getPeerKey(r.id)));

  // One blob for the own copy and every forward-secret recipient; its key stays in the chat
  // store (encrypted at rest) and is deleted together with the copy.
  const { blob, key } = encryptBlob(wrapMedia(body, { ...header, f: myId }));
  const selfPath = `${MOMENT_DIR}out_${Date.now()}.enc`;
  await writeBytes(selfPath, blob);
  const h = await blobHash(blob, selfPath); // the shared blob is checked against it

  let sent = 0;
  const errors: string[] = [];
  let quota: QuotaError | null = null;
  for (let i = 0; i < recipients.length; i++) {
    opts.onProgress?.(recipients.length > 1 ? t('Sending {i}/{n}…', { i: i + 1, n: recipients.length }) : t('Sending…'));
    const r = recipients[i];
    const tempUri = `${FileSystem.cacheDirectory}moment_${Date.now()}_${i}.enc`;
    try {
      let upload: Uint8Array;
      let nonce: string;
      const fs = await isFsPeer(r.id);
      if (fs) {
        const env = await sealEnvelope(r.id, { t: 'media', k: key, h, ...newBinding(myId, r.id) }, publicKeys[i]);
        upload = packMedia(env, blob);
        nonce = encodeBase64(nacl.randomBytes(24));
      } else {
        const box = seal(wrapMedia(body, { ...header, ...newBinding(myId, r.id) }), publicKeys[i], secret);
        upload = box.ciphertext;
        nonce = box.nonce;
      }
      await writeBytes(tempUri, upload);
      let mediaId: string | null = null;
      let ut: string | undefined;
      // Sealed sender (forward-secret friends that gave me their delivery token): the server
      // does not learn that the moment is from me; the encrypted header tells the friend.
      const tok = fs && !opts.groupId ? await peerToken(r.id) : undefined;
      if (tok) {
        ut = newSecret();
        try {
          mediaId = await sealedMedia({
            token: tok,
            mediaType: draft.type,
            sealedHeaderB64: encodeBase64(sealSender(publicKeys[i], { v: 1, f: myId }, new Uint8Array(0), secret)),
            unsendHashB64: sha256b64(ut),
            encryptedFileUri: tempUri,
          });
        } catch (e) {
          if (!(e instanceof TokenGoneError)) throw e;
          await setPeerToken(r.id, null);
          ut = undefined;
        }
      }
      if (!mediaId) {
        mediaId = await sendMedia({
          recipientId: r.id,
          ephemeralPublicKey: encodeBase64(nacl.box.keyPair.fromSecretKey(secret).publicKey),
          nonce,
          mediaType: draft.type,
          encryptedFileUri: tempUri,
          groupId: opts.groupId,
        });
      }
      upsertMoment({
        kind: draft.type === 'audio' ? 'voice' : 'moment',
        id: mediaId,
        peerId: r.id,
        peerName: r.username,
        dir: 'out',
        mediaType: draft.type,
        groupName: opts.groupName,
        createdAt: new Date().toISOString(),
        status: 'pending',
        saved: false,
        file: selfPath,
        mk: key,
        ut,
        dur: draft.type === 'image' ? draft.dur ?? 10 : undefined,
        replyTo: draft.replyTo,
        voiceMs: draft.voiceMs,
        filter: draft.filter,
      });
      bumpContact(r.id);
      sent++;
    } catch (e: any) {
      quota = quotaFrom(e) ?? quota;
      errors.push(`${r.username}: ${e?.response?.data?.message ?? e.message}`);
    } finally {
      FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
    }
  }
  if (sent === 0) {
    FileSystem.deleteAsync(selfPath, { idempotent: true }).catch(() => {});
    throw quota ?? new Error(errors.join('\n'));
  }
  if (!opts.keepOriginals) deletePlainOriginals(draft);
  return { sent, errors };
}

/** Sends a finished draft into a chat: a friend, or a group chat ("g:<id>"). */
export async function sendDraftToChat(draft: MomentDraft, chatId: string, chatName: string, myId: string, onProgress?: (s: string) => void) {
  if (chatId.startsWith('g:')) {
    onProgress?.(t('Sending…'));
    await sendToGroupChat(draft, chatId.slice(2), chatName, myId);
  } else {
    await sendMomentTo(draft, [{ id: chatId, username: chatName }], myId, { onProgress });
  }
}

/**
 * Sends into a group chat: ONE encrypted blob for everybody on the server, the key goes to
 * each member end-to-end encrypted through the relay (with the sender binding).
 */
export async function sendToGroupChat(
  draft: MomentDraft, groupId: string, groupName: string, myId: string, keepOriginals = false,
): Promise<void> {
  await loadChatStore();
  const { body, header } = await buildPayload(draft);
  const { blob, key } = encryptBlob(wrapMedia(body, { ...header, f: myId, g: groupId }));
  const selfPath = `${MOMENT_DIR}out_${Date.now()}.enc`;
  await writeBytes(selfPath, blob);
  const h = await blobHash(blob, selfPath);
  let mediaId: string;
  try {
    mediaId = await sendGroupMedia(groupId, draft.type, selfPath);
  } catch (e: any) {
    FileSystem.deleteAsync(selfPath, { idempotent: true }).catch(() => {});
    throw quotaFrom(e) ?? e;
  }
  const chatId = groupChatId(groupId);
  upsertMoment({
    kind: draft.type === 'audio' ? 'voice' : 'moment', id: mediaId, peerId: chatId, peerName: groupName, dir: 'out',
    mediaType: draft.type, createdAt: new Date().toISOString(), status: 'pending', saved: false,
    file: selfPath, mk: key, dur: draft.type === 'image' ? draft.dur ?? 10 : undefined,
    replyTo: draft.replyTo, voiceMs: draft.voiceMs, filter: draft.filter,
  });
  bumpContact(chatId);
  await announceGroupMedia(groupId, mediaId, key, h, draft.type, draft.voiceMs, draft.replyTo);
  if (!keepOriginals) deletePlainOriginals(draft);
}


export { readMomentPayload } from './payload';
