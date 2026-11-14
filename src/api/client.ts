import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from '../config';
import { getToken, reportSessionExpired } from '../store/session';

const SERVER_URL_KEY = 'mayfly_server_url';

let currentServerUrl = API_BASE_URL;

export function getServerUrl(): string {
  return currentServerUrl;
}

export async function initServerUrl(): Promise<void> {
  const stored = await AsyncStorage.getItem(SERVER_URL_KEY);
  if (stored?.trim()) {
    currentServerUrl = stored.trim();
    apiClient.defaults.baseURL = currentServerUrl;
  }
}

/**
 * Only https servers are accepted. Plain http is allowed solely for local development
 * hosts (emulator loopback), which the network security config also restricts.
 */
export function validateServerUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  const m = /^(https?):\/\/([^/:?#@]+)(:\d+)?$/i.exec(trimmed);
  if (!m) return 'Enter a server address like https://example.org';
  const [, scheme, host] = m;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '10.0.2.2';
  if (scheme.toLowerCase() !== 'https' && !local) return 'The server must use https://';
  return null;
}

export async function saveServerUrl(url: string): Promise<void> {
  const err = validateServerUrl(url);
  if (err) throw new Error(err);
  const trimmed = url.trim().replace(/\/+$/, '');
  currentServerUrl = trimmed || API_BASE_URL;
  apiClient.defaults.baseURL = currentServerUrl;
  if (trimmed) {
    await AsyncStorage.setItem(SERVER_URL_KEY, trimmed);
  } else {
    await AsyncStorage.removeItem(SERVER_URL_KEY);
  }
}

export async function getStoredServerUrl(): Promise<string> {
  const stored = await AsyncStorage.getItem(SERVER_URL_KEY);
  return stored?.trim() ?? '';
}

export const apiClient = axios.create({
  baseURL: currentServerUrl,
  timeout: 30000,
});

apiClient.interceptors.request.use(async (config) => {
  const token = await getToken();
  if (token && !config.headers.Authorization) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/** 401 answers that mean "this session is over" (not "wrong password"). */
const SESSION_GONE = new Set(['missing token', 'invalid token', 'session expired, please log in again']);

/** True for a 401 of the server's session check (code "auth"; older servers: by message). */
export function isSessionGone(status: number | undefined, data: any): boolean {
  if (status !== 401) return false;
  return data?.code === 'auth' || (typeof data?.message === 'string' && SESSION_GONE.has(data.message));
}

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const data = error.response?.data;
    const sent = error.config?.headers?.Authorization;
    if (typeof sent === 'string' && sent.startsWith('Bearer ') && isSessionGone(error.response?.status, data)) {
      reportSessionExpired(sent.slice(7)).catch(() => {});
    }
    const message =
      (typeof data?.message === 'string' && data.message) ||
      (typeof data === 'string' && data) ||
      (typeof error.message === 'string' && error.message) ||
      'Request failed';
    // Keep status, machine-readable code (e.g. "quota") and the response for callers.
    const err = new Error(message) as Error & { status?: number; code?: string; response?: unknown };
    err.status = error.response?.status;
    if (typeof data?.code === 'string') err.code = data.code;
    err.response = error.response;
    return Promise.reject(err);
  },
);
