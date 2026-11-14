export interface User {
  id: string;
  username: string;
}

export interface AuthResponse {
  token: string;
  user_id: string;
  username: string;
  /** The account's public key on the server (base64); missing on servers before 2.9. */
  public_key?: string;
}

export interface FriendRequest {
  id: string;
  requester: User;
  created_at: string;
}

export interface MediaItem {
  id: string;
  sender_id: string;
  sender_username: string;
  /** sealed sender: sender_id / sender_username are empty, the sender is in here (encrypted) */
  sealed_header?: string;
  group_id?: string;
  group_name?: string;
  media_type: 'image' | 'video' | 'audio';
  file_size: number;
  created_at: string;
}

export interface Group {
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
  /** 'list' = broadcast list ("Rundliste"), 'chat' = group chat. Missing on old servers = list. */
  kind?: 'list' | 'chat';
  /** own membership: 'member' or 'invited' (group chats) */
  my_status?: 'member' | 'invited';
  invited_by?: string;
}

export interface GroupMember {
  user_id: string;
  username: string;
  status?: 'member' | 'invited';
  joined_at: string;
}

/** Optional pre-selected recipient when a moment is started from a chat. */
export interface PresetPeer {
  peerId?: string;
  peerName?: string;
}

export type ViewMode = 'first' | 'replay' | 'saved';

/** A finished moment waiting for its recipients (see send/sendMoment.ts). */
export interface DraftParams {
  uri: string;
  type: 'image' | 'video' | 'audio';
  caption?: string;
  dur?: number;
  overlayUri?: string;
  aspect?: number;
  replyTo?: { id: string; q: string; k: 'moment' | 'text' | 'voice' | 'story' };
  /** Colour filter id (videos: applied while playing). */
  filter?: string;
  /** Videos: playback speed (0.5 / 2; 1 = normal). */
  speed?: number;
  /** Videos: sent without sound. */
  muted?: boolean;
  /** Link attached to the moment (https only). */
  link?: string;
  /** Dual camera video: the second camera's clip and where both sit on the canvas. */
  dual?: DualVideo;
}

/** Second camera of a dual camera video. Rects are [left, top, width, height] fractions. */
export interface DualVideo {
  uri: string;
  rect: number[];
  main: number[];
  layout: 'pip' | 'split';
}

export type RootStackParamList = {
  Login: undefined;
  Register: undefined;
  Home: undefined;
  Camera: PresetPeer & { replyTo?: DraftParams['replyTo'] };
  Compose: { uri: string; type: 'image' | 'video'; dual?: DualVideo } & PresetPeer & { replyTo?: DraftParams['replyTo'] };
  SelectFriend: { draft: DraftParams } & PresetPeer;
  ViewMoment: { momentId: string; peerId: string; mode: ViewMode };
  Chat: { peerId: string; peerName: string };
  Verify: { peerId: string; peerName: string };
  Friends: undefined;
  Groups: undefined;
  Profile: undefined;
  Story: { ownerId: string };
  StoryAudience: undefined;
  GroupInfo: { groupId: string };
  NewGroupChat: undefined;
  Call: undefined;
};
