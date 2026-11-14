/**
 * Audit 2 (2.9.0): ratchet replay guard (dropped sessions stay dead), blob hash check,
 * friend set used to filter direct messages.
 */
import nacl from 'tweetnacl';
import { decodeUTF8, encodeBase64, encodeUTF8 } from 'tweetnacl-util';

const mockA = nacl.box.keyPair();
const mockB = nacl.box.keyPair();
const mockStore: Record<string, unknown> = {};

jest.mock('@react-native-async-storage/async-storage', () => ({ removeItem: async () => {} }));
jest.mock('../store/secureJson', () => ({
  getSecureJson: async (k: string) => (k in mockStore ? JSON.parse(JSON.stringify(mockStore[k])) : null),
  setSecureJson: async (k: string, v: unknown) => { mockStore[k] = JSON.parse(JSON.stringify(v)); },
}));
jest.mock('../crypto/keys', () => ({ loadPrivateKey: async () => mockB.secretKey }));
jest.mock('../crypto/peerKeys', () => ({ getPeerKey: async () => require('tweetnacl-util').encodeBase64(mockA.publicKey) }));
jest.mock('../i18n', () => ({ t: (s: string) => s }));
let mockFriends: { id: string }[] | Error = [];
let mockCalls = 0;
jest.mock('../api/client', () => ({
  apiClient: {
    get: async () => {
      mockCalls++;
      if (mockFriends instanceof Error) throw mockFriends;
      return { data: mockFriends };
    },
  },
}));

import { encrypt, initiate } from '../crypto/ratchet';
import { forgetSessions, ratchetDecrypt, sessionHousekeeping } from '../crypto/sessions';
import { sha256 } from '../crypto/sealedSender';
import { blobHash, blobMatches } from '../media/tools';
import { _setFriendsForTest, isFriend, rememberFriends } from '../store/friendSet';

const ALICE = 'aaaa', BOB = 'bbbb';

function opening(text: string) {
  const s = initiate(mockA.secretKey, mockB.publicKey);
  return encrypt(s, mockA.publicKey, mockB.publicKey, decodeUTF8(text)).message;
}

describe('ratchet replay guard', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a dropped session cannot be started again by replaying its first message', async () => {
    const m1 = opening('one');
    expect(encodeUTF8((await ratchetDecrypt(ALICE, BOB, m1, { persist: true })).plaintext)).toBe('one');
    const m2 = opening('two'); // Alice starts a new session; it becomes the active one
    await ratchetDecrypt(ALICE, BOB, m2, { promote: true, persist: true });
    // four days later the old session is dropped by housekeeping
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 4 * 24 * 3600 * 1000);
    await sessionHousekeeping();
    await expect(ratchetDecrypt(ALICE, BOB, m1, { persist: true })).rejects.toThrow('no-session');
  });

  it('after blocking, the old sessions stay refused', async () => {
    const m = opening('hi');
    await ratchetDecrypt(ALICE, BOB, m, { persist: true });
    await forgetSessions(ALICE);
    await expect(ratchetDecrypt(ALICE, BOB, m, { persist: true })).rejects.toThrow('no-session');
    // a really new session still works
    const fresh = opening('new');
    expect(encodeUTF8((await ratchetDecrypt(ALICE, BOB, fresh, { persist: true })).plaintext)).toBe('new');
  });
});

describe('blob hash', () => {
  it('matches SHA-256 and rejects a swapped blob', async () => {
    const blob = nacl.randomBytes(1000);
    const h = await blobHash(blob);
    expect(h).toBe(encodeBase64(sha256(blob)));
    expect(await blobMatches(h, blob)).toBe(true);
    const other = blob.slice();
    other[10] ^= 1;
    expect(await blobMatches(h, other)).toBe(false);
  });
  it('no hash = old sender (accepted), a wrong type is refused', async () => {
    const blob = nacl.randomBytes(10);
    expect(await blobMatches(undefined, blob)).toBe(true);
    expect(await blobMatches(42, blob)).toBe(false);
  });
});

describe('friend set', () => {
  it('known friends are accepted without asking the server', async () => {
    rememberFriends([{ id: 'f1' }]);
    mockCalls = 0;
    expect(await isFriend('f1')).toBe(true);
    expect(await isFriend('x')).toBe(false); // list is fresh: no new request
    expect(mockCalls).toBe(0);
  });
  it('an unknown sender triggers one re-check when the list is old', async () => {
    _setFriendsForTest(['f1'], 0);
    mockFriends = [{ id: 'f1' }, { id: 'f2' }];
    expect(await isFriend('f2')).toBe(true);
  });
  it('cannot decide while offline → null (message stays on the server)', async () => {
    _setFriendsForTest(['f1'], 0);
    mockFriends = new Error('offline');
    expect(await isFriend('f3')).toBeNull();
    expect(await isFriend('f1')).toBe(true);
  });
});

describe('sealed proof downgrade guard', () => {
  it('after a proof, a missing one from the same friend is refused', async () => {
    const { acceptSealedProof } = require('../store/deliveryTokens');
    expect(await acceptSealedProof('p1', 'missing')).toBe(true); // old app: accepted
    expect(await acceptSealedProof('p1', 'bad')).toBe(false);
    expect(await acceptSealedProof('p1', 'ok')).toBe(true);
    expect(await acceptSealedProof('p1', 'missing')).toBe(false); // stripped: refused
    expect(await acceptSealedProof('p2', 'missing')).toBe(true); // other friends unaffected
  });
});
