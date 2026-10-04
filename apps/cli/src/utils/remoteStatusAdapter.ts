import * as os from 'os';
import type { RemoteAccessConfig } from '@neoxlabs/platform/utils/config.js';

function getLanUrls(port: number): string[] {
  const urls: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const key of Object.keys(interfaces)) {
    const entries = interfaces[key] || [];
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal) {
        urls.push(`http://${entry.address}:${port}`);
      }
    }
  }
  return urls;
}

export function buildRemoteStatusFromMain(params: {
  config: Required<RemoteAccessConfig>;
  remoteEnabled: boolean;
  serverPort: number;
}) {
  return {
    enabled: params.config.enabled,
    running: params.remoteEnabled,
    networkMode: params.config.networkMode,
    host: params.config.host,
    port: params.serverPort,
    token: params.config.token,
    clients: 0,
    urls: getLanUrls(params.serverPort),
  };
}
