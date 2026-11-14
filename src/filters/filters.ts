/**
 * Colour filters for moments and stories. Everything is computed on the device (Android
 * ColorMatrix) — no face tracking, no downloads, no third-party services.
 * Photos are filtered before sending; videos carry the filter id and are filtered while
 * playing (the receiver applies the same matrix).
 */
import { NativeModules } from 'react-native';

export interface Filter { id: string; name: string; matrix: number[] | null }

const I = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];

function saturation(s: number): number[] {
  const r = 0.2126 * (1 - s), g = 0.7152 * (1 - s), b = 0.0722 * (1 - s);
  return [r + s, g, b, 0, 0, r, g + s, b, 0, 0, r, g, b + s, 0, 0, 0, 0, 0, 1, 0];
}

/** a · b (4×5 colour matrices, applied right to left: first b, then a). */
function mul(a: number[], b: number[]): number[] {
  const out = new Array(20).fill(0);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += a[row * 5 + k] * b[k * 5 + col];
      if (col === 4) v += a[row * 5 + 4];
      out[row * 5 + col] = v;
    }
  }
  return out;
}

function contrast(c: number): number[] {
  const t = 128 * (1 - c);
  return [c, 0, 0, 0, t, 0, c, 0, 0, t, 0, 0, c, 0, t, 0, 0, 0, 1, 0];
}

function tint(r: number, g: number, b: number, off = [0, 0, 0]): number[] {
  return [r, 0, 0, 0, off[0], 0, g, 0, 0, off[1], 0, 0, b, 0, off[2], 0, 0, 0, 1, 0];
}

/** share `w` of a, rest of b */
function blend(a: number[], b: number[], w: number): number[] {
  return a.map((v, i) => v * w + b[i] * (1 - w));
}

const SEPIA = [0.393, 0.769, 0.189, 0, 0, 0.349, 0.686, 0.168, 0, 0, 0.272, 0.534, 0.131, 0, 0, 0, 0, 0, 1, 0];

export const FILTERS: Filter[] = [
  { id: 'none', name: 'Original', matrix: null },
  { id: 'vivid', name: 'Vivid', matrix: mul(contrast(1.1), saturation(1.45)) },
  { id: 'warm', name: 'Warm', matrix: mul(tint(1.08, 1.0, 0.86, [8, 4, 0]), saturation(1.1)) },
  { id: 'cool', name: 'Cool', matrix: mul(tint(0.9, 1.0, 1.1, [0, 4, 12]), saturation(0.95)) },
  { id: 'fade', name: 'Fade', matrix: mul(tint(0.85, 0.85, 0.85, [30, 30, 34]), saturation(0.75)) },
  { id: 'vintage', name: 'Vintage', matrix: mul(tint(1, 1, 1, [12, 6, 0]), mul(contrast(0.92), blend(SEPIA, I, 0.7))) },
  { id: 'mono', name: 'B&W', matrix: saturation(0) },
  { id: 'noir', name: 'Noir', matrix: mul(contrast(1.45), saturation(0)) },
];

export function filterById(id?: string): Filter | undefined {
  return FILTERS.find((f) => f.id === id);
}

/** Matrix for an id (null for none / unknown). */
export function matrixOf(id?: string): number[] | null {
  return filterById(id)?.matrix ?? null;
}

const Native = NativeModules.MfImageFilter as
  | { bake(uri: string, matrix: number[] | null, overlay: string | null, aspect: number): Promise<string> }
  | undefined;

export const filtersAvailable = !!Native;

/**
 * Photo for sending: filter applied, drawing layer (PNG of the editor canvas) on top,
 * cropped like the editor shows it. Returns a new temp JPEG without EXIF data.
 */
export async function bakePhoto(uri: string, filterId: string | undefined, overlayUri: string | null, aspect: number): Promise<string> {
  if (!Native) throw new Error('filters not available');
  return Native.bake(uri, matrixOf(filterId), overlayUri, aspect);
}
