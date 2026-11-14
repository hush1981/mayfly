/** Pure helpers for moment payloads (no React Native imports, used by jest too). */
import type { ReplyRef } from '../store/chatStore';

/** Kinds a reply quote can point to. */
export const REPLY_KINDS = ['moment', 'text', 'voice', 'story'];

/** Links on moments: https only, no credentials, at most 500 characters. Returns null if not acceptable. */
export function normalizeLink(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let v = input.trim();
  if (!v || v.length > 500 || /\s/.test(v)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v;
  const m = /^https:\/\/([^/?#]+)([/?#].*)?$/i.exec(v);
  if (!m) return null;
  const host = m[1];
  if (host.includes('@') || !/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) || !host.includes('.')) return null;
  return v;
}

function rect(x: unknown): number[] | undefined {
  if (!Array.isArray(x) || x.length !== 4) return undefined;
  if (!x.every((n) => typeof n === 'number' && n >= -0.01 && n <= 1.01)) return undefined;
  return x as number[];
}

/** Splits a decrypted payload into header fields, media, optional second camera clip and overlay. */
export function readMomentPayload(header: Record<string, any> | null, bytes: Uint8Array) {
  const h = header ?? {};
  let media = bytes;
  let overlay: Uint8Array | null = null;
  const ol = typeof h.ol === 'number' ? h.ol : 0;
  if (ol > 0 && ol < media.length) {
    overlay = media.subarray(media.length - ol);
    media = media.subarray(0, media.length - ol);
  }
  // dual camera video: [main][inset][overlay]
  let inset: Uint8Array | null = null;
  const iv = typeof h.iv === 'number' ? h.iv : 0;
  const ir = rect(h.ir);
  const mr = rect(h.mr);
  if (iv > 0 && iv < media.length && ir && mr) {
    inset = media.subarray(media.length - iv);
    media = media.subarray(0, media.length - iv);
  }
  const dual = inset && ir && mr ? { inset, rect: ir, main: mr, layout: h.il === 'split' ? 'split' as const : 'pip' as const } : undefined;
  const speed = h.sp === 0.5 || h.sp === 2 ? h.sp as number : 1;
  const muted = h.mu === 1 || h.mu === true;
  const link = normalizeLink(h.u) ?? undefined;
  const dur = typeof h.d === 'number' && h.d >= 0 && h.d <= 60 ? h.d : 10;
  const aspect = typeof h.a === 'number' && h.a > 0.2 && h.a < 5 ? h.a : undefined;
  const ms = typeof h.ms === 'number' && h.ms > 0 ? Math.min(h.ms, 10 * 60_000) : undefined;
  const rp = h.rp;
  const replyTo: ReplyRef | undefined =
    rp && typeof rp.id === 'string' && rp.id.length <= 64 && typeof rp.q === 'string' && REPLY_KINDS.includes(rp.k)
      ? { id: rp.id, q: rp.q.slice(0, 120), k: rp.k }
      : undefined;
  const filter = typeof h.fl === 'string' && h.fl.length <= 24 ? h.fl : undefined;
  return { caption: typeof h.c === 'string' ? h.c : '', media, overlay, dur, aspect, ms, replyTo, filter, dual, speed, muted, link };
}
