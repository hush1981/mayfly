import { apiClient } from './client';

/** What the connected server allows (GET /limits; older servers don't have it). */
export interface ServerLimits {
  pending_moments_per_sender: number;
  pending_moments_per_recipient: number;
  pending_moments_per_group: number;
  pending_messages_per_user: number;
  /** 2.9+: messages one sender may have waiting (beyond that, its own oldest drop) */
  pending_messages_per_sender?: number;
  story_mb: number;
  group_members: number;
  keep_hours: number;
  call_mbit: number;
  min_free_mb: number;
  video_seconds: number;
}

export async function getServerLimits(): Promise<ServerLimits> {
  const res = await apiClient.get('/limits');
  return res.data;
}
