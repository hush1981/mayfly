/**
 * On-device media helpers (android/.../media/MediaToolsModule + DualCameraActivity).
 * Nothing here talks to a server.
 */
import { NativeModules } from 'react-native';
import { encodeBase64 } from 'tweetnacl-util';
import { sha256 } from '../crypto/sealedSender';
import { t } from '../i18n';

export interface DualResult {
  type: 'image' | 'video';
  /** photo (composed) or the main video (with sound) */
  uri: string;
  /** videos: the small / second camera (no sound) */
  inset?: string;
  layout?: 'pip' | 'split';
  /** where the main / inset video sits on the screen: [left, top, width, height] as fractions */
  mainRect?: number[];
  insetRect?: number[];
  /** screen width / height */
  aspect?: number;
}

const Native = NativeModules.MfMediaTools as
  | {
      stripAudio(uri: string): Promise<string>;
      canSaveToGallery(): Promise<boolean>;
      saveToGallery(uri: string, type: string): Promise<boolean>;
      dualCamera(labels: Record<string, string>): Promise<DualResult | null>;
      sha256File?(uri: string): Promise<string>;
    }
  | undefined;

/** A copy of the video without any sound track (no re-encoding). */
export async function stripAudio(uri: string): Promise<string> {
  if (!Native) throw new Error('not available');
  return Native.stripAudio(uri);
}

export async function canSaveToGallery(): Promise<boolean> {
  try { return !!Native && (await Native.canSaveToGallery()); } catch { return false; }
}

/** Saves an own photo / video into the phone's gallery (Pictures / Movies → Mayfly). */
export async function saveToGallery(uri: string, type: 'image' | 'video'): Promise<void> {
  if (!Native) throw new Error('not available');
  await Native.saveToGallery(uri, type);
}

/** Opens the dual camera (back + front at once). null = cancelled. */
export async function openDualCamera(): Promise<DualResult | null> {
  if (!Native) throw new Error(t('Dual camera is not available on this phone.'));
  return Native.dualCamera({
    hint: t('Tap · photo  ·  Hold · video  ·  Tap the small picture to swap'),
    sequential: t("This phone can't use both cameras at once: tap takes a photo with each camera, one after the other."),
    second: t('Now the other camera…'),
    noVideo: t('Dual video needs a phone that can use both cameras at once.'),
    failed: t('Dual camera is not available on this phone.'),
    split: t('Split'),
    pip: t('Picture in picture'),
    close: t('Close'),
    shutter: t('Shutter'),
  });
}

/**
 * SHA-256 (base64) of an encrypted media blob. One blob (moment to several friends, group
 * media, story) is shared by everybody who got its key, so the key alone does not prove who
 * made the blob: a recipient working with the server could swap it. The sender therefore
 * puts this hash into each recipient's own end-to-end envelope (`h`). With `fileUri` (the
 * same bytes on disk) the hash is computed natively, which is much faster.
 */
export async function blobHash(blob: Uint8Array, fileUri?: string): Promise<string> {
  if (fileUri && Native?.sha256File) {
    try { return await Native.sha256File(fileUri); } catch (_) {}
  }
  return encodeBase64(sha256(blob));
}

/** True if the blob matches the hash from its envelope (no hash = sender before 2.9). */
export async function blobMatches(h: unknown, blob: Uint8Array, fileUri?: string): Promise<boolean> {
  if (h === undefined || h === null) return true;
  if (typeof h !== 'string') return false;
  return (await blobHash(blob, fileUri)) === h;
}
