import { apiClient } from './client';

export interface IceConfig {
  ice_servers: { urls: string[]; username?: string; credential?: string }[];
  /** the server has a TURN relay (calls work behind NAT, IP addresses can stay hidden) */
  relay: boolean;
}

export async function getIceConfig(): Promise<IceConfig> {
  const res = await apiClient.get('/calls/ice');
  return res.data;
}
