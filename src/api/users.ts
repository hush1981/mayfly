import { apiClient, getServerUrl } from './client';
import { User } from '../types';

export async function getUserPublicKey(userId: string): Promise<string> {
  const res = await apiClient.get(`/users/${userId}/public-key`);
  return res.data.public_key as string;
}

export async function uploadAvatar(imageUri: string): Promise<void> {
  const formData = new FormData();
  formData.append('avatar', {
    uri: imageUri,
    name: 'avatar.jpg',
    type: 'image/jpeg',
  } as unknown as Blob);
  await apiClient.post('/users/me/avatar', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
}

export function getAvatarUrl(userId: string): string {
  return `${getServerUrl()}/users/${userId}/avatar`;
}

/** Replaces the account's public key (new device / reinstall). Needs the password. */
export async function rotatePublicKey(publicKey: string, password: string, token?: string): Promise<void> {
  await apiClient.put('/users/me/public-key', { public_key: publicKey, password },
    token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
}

/** Permanently deletes the account and everything stored for it on the server. */
export async function deleteAccount(password: string): Promise<void> {
  await apiClient.post('/users/me/delete', { password });
}

/** Changes the password; returns a fresh token (all other sessions are logged out). */
export async function changePassword(currentPassword: string, newPassword: string): Promise<string> {
  const res = await apiClient.put('/users/me/password', { current_password: currentPassword, new_password: newPassword });
  return res.data.token as string;
}
