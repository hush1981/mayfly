/**
 * Builds the plaintext payload of a moment or story: media bytes (+ second camera clip of a
 * dual video, + drawing layer) and the header that describes it. Everything here ends up
 * inside the end-to-end encrypted blob.
 *
 * Header fields: c caption, d view time (photos), rp reply, ol/a overlay length + canvas
 * aspect, ms voice length, fl filter, sp speed, mu muted, u link, iv/ir/mr/il dual video
 * (inset length, inset + main rect, layout).
 */
import * as FileSystem from 'expo-file-system';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import type { ReplyRef } from '../store/chatStore';

export interface PayloadDraft {
  uri: string;
  type: 'image' | 'video' | 'audio';
  caption?: string;
  dur?: number;
  overlayUri?: string;
  aspect?: number;
  replyTo?: ReplyRef;
  voiceMs?: number;
  filter?: string;
  speed?: number;
  muted?: boolean;
  link?: string;
  dual?: { uri: string; rect: number[]; main: number[]; layout: 'pip' | 'split' };
}

export async function readBytes(uri: string): Promise<Uint8Array> {
  return decodeBase64(await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }));
}

export async function writeBytes(path: string, bytes: Uint8Array) {
  await FileSystem.writeAsStringAsync(path, encodeBase64(bytes), { encoding: FileSystem.EncodingType.Base64 });
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Media + header shared by every copy (`defaultDur` = view time when none was chosen). */
export async function buildPayload(draft: PayloadDraft, defaultDur = 10) {
  const media = await readBytes(draft.uri);
  const inset = draft.type === 'video' && draft.dual ? await readBytes(draft.dual.uri) : null;
  const overlay = draft.overlayUri ? await readBytes(draft.overlayUri) : null;
  let body = inset ? concat(media, inset) : media;
  if (overlay) body = concat(body, overlay);
  const header: Record<string, unknown> = { c: draft.caption ?? '' };
  if (draft.type === 'image') header.d = draft.dur ?? defaultDur;
  // (not "r": the sender binding uses "r" for the recipient)
  if (draft.replyTo) header.rp = draft.replyTo;
  if (overlay) header.ol = overlay.length;
  if (inset && draft.dual) {
    header.iv = inset.length;
    header.ir = draft.dual.rect.map(round3);
    header.mr = draft.dual.main.map(round3);
    header.il = draft.dual.layout;
  }
  if ((overlay || inset) && draft.aspect) header.a = draft.aspect;
  if (draft.voiceMs) header.ms = draft.voiceMs;
  if (draft.filter) header.fl = draft.filter;
  if (draft.type === 'video' && (draft.speed === 0.5 || draft.speed === 2)) header.sp = draft.speed;
  if (draft.type === 'video' && draft.muted) header.mu = 1;
  if (draft.link) header.u = draft.link;
  return { body, header };
}

export function deletePlainOriginals(draft: PayloadDraft) {
  // The plaintext originals are not needed any more (the own copy is encrypted).
  for (const u of [draft.uri, draft.overlayUri, draft.dual?.uri]) {
    const dir = FileSystem.cacheDirectory;
    if (u && dir && u.startsWith(dir)) FileSystem.deleteAsync(u, { idempotent: true }).catch(() => {});
  }
}
