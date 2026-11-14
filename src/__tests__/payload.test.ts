import { newBinding, checkBinding } from '../crypto/sealed';
import { unwrapMedia, wrapMedia } from '../crypto/encryption';
import { readMomentPayload } from '../send/payload';

jest.mock('expo-file-system', () => ({}));
jest.mock('../api/media', () => ({}));
jest.mock('../crypto/keys', () => ({}));
jest.mock('../crypto/peerKeys', () => ({}));
jest.mock('../store/chatStore', () => ({}));

describe('moment payload header', () => {
  const media = new Uint8Array([0xff, 0xd8, 1, 2, 3, 4]);
  const overlay = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9]);

  test('overlay, view time, aspect and reply survive the round trip', () => {
    const body = new Uint8Array([...media, ...overlay]);
    const header = {
      c: '', d: 3, ol: overlay.length, a: 0.5, rp: { id: 'abc', q: 'Photo', k: 'moment' }, ...newBinding('alice', 'bob'),
    };
    const { header: h, mediaBytes } = unwrapMedia(wrapMedia(body, header));
    const p = readMomentPayload(h, mediaBytes);
    expect(Array.from(p.media)).toEqual(Array.from(media));
    expect(Array.from(p.overlay!)).toEqual(Array.from(overlay));
    expect(p.dur).toBe(3);
    expect(p.aspect).toBe(0.5);
    expect(p.replyTo).toEqual({ id: 'abc', q: 'Photo', k: 'moment' });
    // the reply must not clobber the binding's recipient field
    expect(checkBinding(h as any, 'alice', 'bob', () => false)).toBeNull();
  });

  test('defaults and validation', () => {
    const p = readMomentPayload({ d: 999, a: 99, rp: { id: 'x', q: 1, k: 'evil' } }, media);
    expect(p.dur).toBe(10);
    expect(p.aspect).toBeUndefined();
    expect(p.replyTo).toBeUndefined();
    expect(p.overlay).toBeNull();
    expect(readMomentPayload(null, media).dur).toBe(10);
    expect(readMomentPayload({ d: 0 }, media).dur).toBe(0);
  });
});

describe('2.7 payload fields', () => {
  const { readMomentPayload: read, normalizeLink } = require('../send/payload');
  it('splits main video, second camera clip and drawing layer', () => {
    const main = new Uint8Array([1, 1, 1, 1]);
    const inset = new Uint8Array([2, 2]);
    const layer = new Uint8Array([3]);
    const all = new Uint8Array([...main, ...inset, ...layer]);
    const r = read({ ol: 1, iv: 2, ir: [0.03, 0.05, 0.32, 0.25], mr: [0, 0, 1, 1], il: 'pip', sp: 2, mu: 1 }, all);
    expect(Array.from(r.media)).toEqual([1, 1, 1, 1]);
    expect(Array.from(r.dual.inset)).toEqual([2, 2]);
    expect(Array.from(r.overlay)).toEqual([3]);
    expect(r.speed).toBe(2);
    expect(r.muted).toBe(true);
  });
  it('ignores bad dual rects and speeds', () => {
    const r = read({ iv: 2, ir: [0, 0, 9, 1], mr: [0, 0, 1, 1], sp: 7 }, new Uint8Array([1, 2, 3]));
    expect(r.dual).toBeUndefined();
    expect(r.media.length).toBe(3);
    expect(r.speed).toBe(1);
  });
  it('accepts only https links', () => {
    expect(normalizeLink('example.org/x')).toBe('https://example.org/x');
    expect(normalizeLink('https://a.example/path?q=1')).toBe('https://a.example/path?q=1');
    expect(normalizeLink('http://example.org')).toBeNull();
    expect(normalizeLink('javascript:alert(1)')).toBeNull();
    expect(normalizeLink('https://user@evil.example')).toBeNull();
    expect(normalizeLink('https://localhost')).toBeNull();
    expect(normalizeLink('https://exa mple.org')).toBeNull();
    expect(read({ u: 'intent://x' }, new Uint8Array([1])).link).toBeUndefined();
  });
});
