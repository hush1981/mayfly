import { apiClient } from './client';

export interface StoryListItem {
  id: string;
  owner_id: string;
  owner_username: string;
  media_type: 'image' | 'video';
  created_at: string;
  expires_at: string;
  /** base64 — end-to-end encrypted key envelope for me */
  envelope: string;
}

export interface OwnStoryItem {
  id: string;
  media_type: 'image' | 'video';
  created_at: string;
  expires_at: string;
  audience: number;
}

export async function listStories(): Promise<{ friends: StoryListItem[]; mine: OwnStoryItem[] }> {
  const res = await apiClient.get('/stories');
  return { friends: res.data.friends ?? [], mine: res.data.mine ?? [] };
}

export async function postStory(
  fileUri: string, mediaType: 'image' | 'video', keys: { viewer_id: string; envelope: string }[],
): Promise<{ id: string; expires_at: string }> {
  const formData = new FormData();
  formData.append('media_type', mediaType);
  formData.append('keys', JSON.stringify(keys));
  formData.append('encrypted_file', { uri: fileUri, name: 'media', type: 'application/octet-stream' } as unknown as Blob);
  const res = await apiClient.post('/stories', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
  return res.data;
}

export async function downloadStory(id: string): Promise<Uint8Array> {
  const res = await apiClient.get(`/stories/${id}`, { responseType: 'arraybuffer' });
  return new Uint8Array(res.data as ArrayBuffer);
}

export async function deleteStory(id: string): Promise<void> {
  await apiClient.delete(`/stories/${id}`);
}
