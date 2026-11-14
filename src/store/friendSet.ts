/**
 * Who my friends are, as a local set — to decide whose direct messages are accepted.
 *
 * The server only delivers messages from friends and from members of a shared group chat.
 * Group members who are not friends must stay in the group, though: without this check a
 * stranger from a group could open a 1:1 chat with me or make my phone ring.
 *
 * The set is refreshed with every friend list the app fetches, and once more (at most every
 * 10 s) when somebody unknown writes — a friend who accepted a moment ago must not be dropped.
 */
import { apiClient } from '../api/client';
import { getSecureJson, setSecureJson } from './secureJson';

const KEY = 'mayfly_friend_ids_v1';
const RECHECK_MS = 10_000;

let ids: Set<string> | null = null;
let loaded = false;
let lastFetch = 0;
let fetching: Promise<boolean> | null = null;

async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const stored = await getSecureJson<string[]>(KEY);
    if (Array.isArray(stored) && !ids) ids = new Set(stored);
  } catch (_) {}
}

/** Remembers a freshly fetched friend list. */
export function rememberFriends(list: { id: string }[]) {
  ids = new Set(list.map((f) => f.id));
  loaded = true;
  lastFetch = Date.now();
  setSecureJson(KEY, Array.from(ids)).catch(() => {});
}

function refresh(): Promise<boolean> {
  if (!fetching) {
    fetching = (async () => {
      try {
        const res = await apiClient.get('/friends');
        if (!Array.isArray(res.data)) return false;
        rememberFriends(res.data as { id: string }[]);
        return true;
      } catch {
        return false;
      }
    })().finally(() => { fetching = null; });
  }
  return fetching;
}

/**
 * true / false, or null when it cannot be decided right now (not in the known list and the
 * server could not be asked) — the caller then leaves the message where it is.
 */
export async function isFriend(userId: string): Promise<boolean | null> {
  await load();
  if (ids?.has(userId)) return true;
  if (ids && Date.now() - lastFetch < RECHECK_MS) return false;
  if (!(await refresh())) return null;
  return !!ids?.has(userId);
}

/** Logout: forget the list. */
export function forgetFriends() {
  ids = null;
  loaded = true;
  lastFetch = 0;
  setSecureJson(KEY, []).catch(() => {});
}

/** Tests only. */
export function _setFriendsForTest(list: string[] | null, fetchedAt = Date.now()) {
  ids = list ? new Set(list) : null;
  loaded = true;
  lastFetch = fetchedAt;
}
