import { apiClient } from './client';
import { User, FriendRequest } from '../types';
import { lastContactAt, loadChatStore } from '../store/chatStore';
import { rememberFriends } from '../store/friendSet';

export async function sendFriendRequest(username: string): Promise<'pending' | 'accepted'> {
  const res = await apiClient.post('/friends/request', { username });
  return res.data?.status === 'accepted' ? 'accepted' : 'pending';
}

export async function listFriendRequests(): Promise<FriendRequest[]> {
  const res = await apiClient.get('/friends/requests');
  return res.data;
}

export async function acceptFriendRequest(friendshipId: string): Promise<void> {
  await apiClient.post(`/friends/accept/${friendshipId}`);
}

/**
 * Friends, most recent contact first (then by name). The order is built on this device from
 * the local contact counter: the server does not know who you talk to and when.
 */
export async function listFriends(): Promise<User[]> {
  const [res] = await Promise.all([apiClient.get('/friends'), loadChatStore()]);
  rememberFriends(res.data as User[]);
  return sortByLastContact(res.data as User[], lastContactAt);
}

export function sortByLastContact<T extends { id: string; username: string }>(
  friends: T[], lastAt: (id: string) => number,
): T[] {
  return [...friends].sort((a, b) =>
    lastAt(b.id) - lastAt(a.id) || (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));
}

/** Ends a friendship, or declines / withdraws a friend request (by the other user's id). */
export async function removeFriend(userId: string): Promise<void> {
  await apiClient.delete(`/friends/${userId}`);
}
