import { apiClient, getServerUrl } from './client';
import { Group, GroupMember } from '../types';

export async function createGroup(name: string, kind: 'list' | 'chat' = 'list'): Promise<Group> {
  const res = await apiClient.post('/groups', { name, kind });
  return res.data;
}

export async function deleteGroup(groupId: string): Promise<void> {
  await apiClient.delete(`/groups/${groupId}`);
}

export async function renameGroup(groupId: string, name: string): Promise<void> {
  await apiClient.put(`/groups/${groupId}`, { name });
}

/** Accepts an invitation to a group chat. */
export async function joinGroup(groupId: string): Promise<void> {
  await apiClient.post(`/groups/${groupId}/join`);
}

/** Uploads one encrypted blob for all other members of a group chat. */
export async function sendGroupMedia(groupId: string, mediaType: 'image' | 'video' | 'audio', fileUri: string): Promise<string> {
  const formData = new FormData();
  formData.append('media_type', mediaType);
  formData.append('encrypted_file', { uri: fileUri, name: 'media', type: 'application/octet-stream' } as unknown as Blob);
  const res = await apiClient.post(`/groups/${groupId}/media`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
  return res.data.media_id as string;
}

export async function downloadGroupMedia(mediaId: string): Promise<Uint8Array> {
  const res = await apiClient.get(`/group-media/${mediaId}`, { responseType: 'arraybuffer' });
  return new Uint8Array(res.data as ArrayBuffer);
}

export async function markGroupMediaViewed(mediaId: string): Promise<void> {
  await apiClient.post(`/group-media/${mediaId}/viewed`);
}

export async function unsendGroupMedia(mediaId: string): Promise<void> {
  await apiClient.delete(`/group-media/${mediaId}`);
}

export async function listGroups(): Promise<Group[]> {
  const res = await apiClient.get('/groups');
  return res.data;
}

export async function listGroupMembers(groupId: string): Promise<GroupMember[]> {
  const res = await apiClient.get(`/groups/${groupId}/members`);
  return res.data;
}

export async function addGroupMember(groupId: string, userId: string): Promise<void> {
  await apiClient.post(`/groups/${groupId}/members`, { user_id: userId });
}

export async function removeGroupMember(groupId: string, userId: string): Promise<void> {
  await apiClient.delete(`/groups/${groupId}/members/${userId}`);
}

export async function uploadGroupAvatar(groupId: string, imageUri: string): Promise<void> {
  const formData = new FormData();
  formData.append('avatar', {
    uri: imageUri,
    name: 'avatar.jpg',
    type: 'image/jpeg',
  } as unknown as Blob);
  await apiClient.post(`/groups/${groupId}/avatar`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
}

export function getGroupAvatarUrl(groupId: string): string {
  return `${getServerUrl()}/groups/${groupId}/avatar`;
}
