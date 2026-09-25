export type RemoteNetworkMode = 'lan' | 'vps';

export interface RemoteAccessConfig {
  enabled: boolean;
  networkMode: RemoteNetworkMode;
  host: string;
  port: number;
  token?: string;
  allowVoice: boolean;
  autoApprove: boolean;
}

export interface RemoteAccessStatus {
  enabled: boolean;
  running: boolean;
  networkMode: RemoteNetworkMode;
  host: string;
  port: number;
  token?: string;
  clients: number;
  urls: string[];
}

export interface RemoteClientInfo {
  id: string;
  ip: string;
  connectedAt: number;
  lastActivity: number;
  userAgent?: string;
}
