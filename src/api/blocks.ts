import { apiClient } from './client';
import { User } from '../types';

/** Blocks a user: ends the friendship and stops everything between the two of you. */
export async function blockUser(userId: string): Promise<void> {
  await apiClient.post('/blocks', { user_id: userId });
}

export async function unblockUser(userId: string): Promise<void> {
  await apiClient.delete(`/blocks/${userId}`);
}

export async function listBlocked(): Promise<User[]> {
  const res = await apiClient.get('/blocks');
  return res.data;
}
