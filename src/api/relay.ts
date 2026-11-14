import { apiClient } from './client';

/** Encrypted client-to-client message as stored by the server (opaque to it). */
export interface RelayEnvelope {
  id: string;
  sender_id: string;
  ephemeral_public_key: string;
  nonce: string;
  payload: string;
  created_at: string;
}

export async function sendRelay(
  recipientId: string, ephemeralPublicKey: string, nonce: string, payload: string, notify = false,
): Promise<void> {
  await apiClient.post('/relay', {
    recipient_id: recipientId,
    ephemeral_public_key: ephemeralPublicKey,
    nonce,
    payload,
    notify,
  });
}

export async function fetchRelay(): Promise<RelayEnvelope[]> {
  const res = await apiClient.get('/relay');
  return res.data;
}

export async function ackRelay(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await apiClient.post('/relay/ack', { ids });
}

/**
 * Long poll: resolves once something is waiting in the relay queue (or after `seconds`).
 * Does not take anything out of the queue — the normal sync does that.
 */
export async function waitForRelay(seconds: number): Promise<boolean> {
  const res = await apiClient.get('/relay', { params: { wait: seconds }, timeout: (seconds + 15) * 1000 });
  return Array.isArray(res.data) && res.data.length > 0;
}
