import { apiClient } from './client';
import { MediaItem } from '../types';

export async function getInbox(): Promise<MediaItem[]> {
  const res = await apiClient.get('/media/inbox');
  return res.data;
}

export interface DownloadedMedia {
  ciphertext: Uint8Array;
  ephemeralPublicKey: string;
  nonce: string;
  mediaType: string;
}

export async function downloadMedia(mediaId: string): Promise<DownloadedMedia> {
  const res = await apiClient.get(`/media/${mediaId}`, {
    responseType: 'arraybuffer',
  });

  return {
    ciphertext: new Uint8Array(res.data as ArrayBuffer),
    ephemeralPublicKey: res.headers['x-ephemeral-key'] as string,
    nonce: res.headers['x-nonce'] as string,
    mediaType: res.headers['x-media-type'] as string,
  };
}

/** Sender only: deletes a moment / voice message from the server while it is still unopened. */
export async function unsendMedia(mediaId: string): Promise<void> {
  await apiClient.delete(`/media/${mediaId}`);
}

export async function markViewed(mediaId: string): Promise<void> {
  await apiClient.post(`/media/${mediaId}/viewed`);
}

export interface SendMediaParams {
  recipientId: string;
  ephemeralPublicKey: string;
  nonce: string;
  mediaType: 'image' | 'video' | 'audio';
  encryptedFileUri: string;
  groupId?: string;
}

export async function sendMedia(params: SendMediaParams): Promise<string> {
  const formData = new FormData();
  formData.append('recipient_id', params.recipientId);
  formData.append('ephemeral_public_key', params.ephemeralPublicKey);
  formData.append('nonce', params.nonce);
  formData.append('media_type', params.mediaType);
  if (params.groupId) {
    formData.append('group_id', params.groupId);
  }
  formData.append('encrypted_file', {
    uri: params.encryptedFileUri,
    name: 'media',
    type: 'application/octet-stream',
  } as unknown as Blob);

  const res = await apiClient.post('/media/send', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data.media_id as string;
}
