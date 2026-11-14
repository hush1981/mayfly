import { apiClient } from './client';
import { AuthResponse } from '../types';
import { getToken, setToken, tokenIssuedAt } from '../store/session';

export async function register(
  username: string,
  password: string,
  publicKey: string,
  invite?: string,
): Promise<{ id: string; username: string }> {
  const res = await apiClient.post('/auth/register', {
    username, password, public_key: publicKey, ...(invite ? { invite } : {}),
  });
  return res.data;
}

export async function login(username: string, password: string): Promise<AuthResponse> {
  const res = await apiClient.post('/auth/login', { username, password });
  return res.data;
}

/** Renew the session token about once a day (the server keeps a session alive for 30 days). */
const REFRESH_AFTER_MS = 24 * 3600 * 1000;
const RETRY_AFTER_MS = 6 * 3600 * 1000;
let refreshing: Promise<void> | null = null;
let triedAt = 0;

/**
 * Asks the server for a fresh token when the current one is older than a day. Cheap to call
 * often (every sync does). Servers without this route (older self-hosted ones) are asked
 * again only after a few hours.
 */
export function refreshSessionIfDue(now = Date.now()): Promise<void> {
  if (!refreshing) {
    refreshing = (async () => {
      const token = await getToken();
      if (!token) return;
      if (now - (await tokenIssuedAt()) < REFRESH_AFTER_MS || now - triedAt < RETRY_AFTER_MS) return;
      triedAt = now;
      try {
        const res = await apiClient.post('/auth/refresh');
        // (the session may have ended or changed while the request was on its way)
        if (typeof res.data?.token === 'string' && (await getToken()) === token) {
          await setToken(res.data.token);
          triedAt = 0;
        }
      } catch (_) {
        // offline, or a server without /auth/refresh: try again later
      }
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}
