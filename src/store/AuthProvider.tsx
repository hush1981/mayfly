import React, { createContext, useContext, useEffect, useReducer } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { initServerUrl } from '../api/client';
import { registerBackgroundFetch } from '../notifications/backgroundTask';
import { clearChatStore } from './chatStore';
import { forgetStoreKey } from './secureJson';
import { clearToken, getToken, onSessionExpired, setToken } from './session';
import { forgetKnownKeys } from '../crypto/peerKeys';
import { forgetAllSessions } from '../crypto/sessions';
import { clearTokens } from './deliveryTokens';
import { forgetStories } from './stories';
import { forgetGroups } from './groupChats';
import { forgetFriends } from './friendSet';
import { disablePush, startPushBridge } from '../push/unifiedPush';

const USER_ID_KEY = 'mayfly_user_id';
const USERNAME_KEY = 'mayfly_username';

interface AuthState {
  token: string | null;
  userId: string | null;
  username: string | null;
  isLoading: boolean;
}

type AuthAction =
  | { type: 'HYDRATE'; token: string | null; userId: string | null; username: string | null }
  | { type: 'LOGIN'; token: string; userId: string; username: string }
  | { type: 'EXPIRED' }
  | { type: 'LOGOUT' };

function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'HYDRATE':
      return { ...state, token: action.token, userId: action.userId, username: action.username, isLoading: false };
    case 'LOGIN':
      return { ...state, token: action.token, userId: action.userId, username: action.username };
    case 'EXPIRED':
      // the server ended the session: back to the login screen, the account's data stays
      return { ...state, token: null };
    case 'LOGOUT':
      return { ...state, token: null, userId: null, username: null };
    default:
      return state;
  }
}

interface AuthContextValue {
  state: AuthState;
  login: (token: string, userId: string, username: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(authReducer, {
    token: null,
    userId: null,
    username: null,
    isLoading: true,
  });

  useEffect(() => {
    (async () => {
      await initServerUrl();
      const [token, userId, username] = await Promise.all([
        getToken(),
        AsyncStorage.getItem(USER_ID_KEY),
        AsyncStorage.getItem(USERNAME_KEY),
      ]);
      dispatch({ type: 'HYDRATE', token, userId, username });
      if (token) startPushBridge();
    })();
  }, []);

  // The server no longer accepts the session (expired, or the password was changed on
  // another device): show the login screen. Nothing on the phone is deleted.
  useEffect(() => onSessionExpired(() => dispatch({ type: 'EXPIRED' })), []);

  async function login(token: string, userId: string, username: string) {
    // Another account than the one whose chats are on this phone: those go first.
    const previous = await AsyncStorage.getItem(USER_ID_KEY);
    if (previous && previous !== userId) await wipeLocalData();
    await Promise.all([
      setToken(token),
      AsyncStorage.setItem(USER_ID_KEY, userId),
      AsyncStorage.setItem(USERNAME_KEY, username),
    ]);
    dispatch({ type: 'LOGIN', token, userId, username });
    startPushBridge();
    registerBackgroundFetch().catch(() => {});
  }

  /** Everything this account left on the phone (chats, trusted keys, sessions, tokens). */
  async function wipeLocalData() {
    await Promise.all([
      clearToken(),
      AsyncStorage.removeItem(USER_ID_KEY),
      AsyncStorage.removeItem(USERNAME_KEY),
      AsyncStorage.removeItem('mayfly_relay_outbox_v1'),
      clearChatStore(),
      forgetKnownKeys(),
      forgetAllSessions(),
      forgetStories(),
      clearTokens(),
    ]);
    forgetGroups();
    forgetFriends();
    // last: anything still encrypted with the at-rest key becomes unreadable
    await forgetStoreKey();
  }

  async function logout() {
    // Stop pushes for this account before the session token is gone.
    await disablePush().catch(() => {});
    await wipeLocalData();
    dispatch({ type: 'LOGOUT' });
  }

  return (
    <AuthContext.Provider value={{ state, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
