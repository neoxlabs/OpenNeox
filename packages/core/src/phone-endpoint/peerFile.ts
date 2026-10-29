import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';

export const PEER_FILE_NAME = 'cli-phone-peers.json';
export const PEER_FILE_VERSION = 1;

export interface CliPhonePeer {
  /** 手机的 device_id (envelope 的 to_device_id) */
  device_id: string;
  /** 手机属于哪个账号 —— CLI 只用跟自己登录账号一致的 (null = 老配对没记账号, 照用) */
  owner_user_id: string | null;
  name?: string;
  /** base64(deriveCliEndpointKey(relay_session_key)) */
  key_b64: string;
}

export interface CliPhonePeerFile {
  version: number;
  /** 这台电脑的 device_id (跟客户端连中转用的同一个) */
  device_id: string;
  device_name: string;
  peers: CliPhonePeer[];
  updated_at: number;
}

/** 跟客户端 localSecretCipher.neoxDataDir() 同一个目录 —— 两边必须一致 */
export function neoxIdentityDir(): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', DISTRIBUTION.appName);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), DISTRIBUTION.appName);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), DISTRIBUTION.appName.toLowerCase());
}

export function peerFilePath(): string {
  return path.join(neoxIdentityDir(), PEER_FILE_NAME);
}

/** 客户端调: 原子写 (先写临时文件再改名), 0600 */
export function writePeerFile(data: Omit<CliPhonePeerFile, 'version' | 'updated_at'>): void {
  const fp = peerFilePath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const body: CliPhonePeerFile = { version: PEER_FILE_VERSION, ...data, updated_at: Date.now() };
  const tmp = `${fp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  fs.renameSync(tmp, fp);
}

/** CLI 调: 没有 / 坏了都返 null (调用方据此告诉用户「先在客户端里配对手机」) */
export function readPeerFile(): CliPhonePeerFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(peerFilePath(), 'utf8'));
    if (raw?.version !== PEER_FILE_VERSION || typeof raw.device_id !== 'string' || !Array.isArray(raw.peers)) return null;
    const peers = raw.peers.filter((p: any) => typeof p?.device_id === 'string' && typeof p?.key_b64 === 'string');
    return { ...raw, peers };
  } catch {
    return null;
  }
}
