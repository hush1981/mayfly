/**
 * Sealed-sender requests. They deliberately use their OWN http client without the login
 * token: the server must not be able to tell who sent them (it still sees the IP address,
 * like any server — see the README).
 */
import axios from 'axios';
import { apiClient, getServerUrl } from './client';

/** The recipient changed its delivery token (or never had this one): use a normal delivery. */
export class TokenGoneError extends Error {}

/** The recipient's shared sealed-sender queue is full: deliver this one with the login. */
export class QueueFullError extends Error {}

const anon = axios.create({ timeout: 60000 });

function rethrow(e: any): never {
  if (e?.response?.status === 404 && e.response.data?.code === 'token') throw new TokenGoneError('delivery token unknown');
  if (e?.response?.status === 429 && e.response.data?.code === 'queue') throw new QueueFullError('sealed queue full');
  const data = e?.response?.data;
  const err = new Error((typeof data?.message === 'string' && data.message) || e?.message || 'Request failed') as Error & { response?: unknown };
  err.response = e?.response;
  throw err;
}

export async function registerDeliveryToken(tokenHashB64: string): Promise<void> {
  await apiClient.put('/users/me/delivery-token', { token_hash: tokenHashB64 });
}

export async function sealedRelay(token: string, payloadB64: string, notify: boolean): Promise<void> {
  try {
    await anon.post(`${getServerUrl()}/sealed/relay`, { payload: payloadB64, notify }, {
      headers: { 'X-Delivery-Token': token },
    });
  } catch (e) {
    rethrow(e);
  }
}

export async function sealedMedia(p: {
  token: string; mediaType: string; sealedHeaderB64: string; unsendHashB64: string; encryptedFileUri: string;
}): Promise<string> {
  const form = new FormData();
  form.append('media_type', p.mediaType);
  form.append('sealed_header', p.sealedHeaderB64);
  form.append('unsend_hash', p.unsendHashB64);
  form.append('encrypted_file', { uri: p.encryptedFileUri, name: 'media', type: 'application/octet-stream' } as unknown as Blob);
  try {
    const res = await anon.post(`${getServerUrl()}/sealed/media`, form, {
      headers: { 'Content-Type': 'multipart/form-data', 'X-Delivery-Token': p.token },
      timeout: 5 * 60_000,
    });
    return res.data.media_id as string;
  } catch (e) {
    rethrow(e);
  }
}

export async function sealedUnsend(mediaId: string, unsendToken: string): Promise<void> {
  try {
    await anon.delete(`${getServerUrl()}/sealed/media/${mediaId}`, { headers: { 'X-Unsend-Token': unsendToken } });
  } catch (e) {
    rethrow(e);
  }
}
