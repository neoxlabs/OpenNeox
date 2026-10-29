/**
 * connector 凭据存储
 *
 *   落在 `~/.neox/plugins/credentials/<plugin>.enc`, 用 localSecretCipher
 *   (AES-256-GCM, key 由 machineId 派生) 加密 —— 与 auth.enc / gateway-key.enc
 *   同一套。这意味着凭据跟设备走, 拷到另一台机器解不开。
 *
 *   谁能读到明文
 *   ------------
 *   只有 executor, 而且只在闸门放行之后的最后一步。插件本身永远拿不到 —— 它
 *   声明的是 (capability, 请求形状), 拿回的是结果。整个市场安全模型建立在
 *   这条上: 否则「装一个插件」等于「交出所有账号」。
 *
 *   所以这里刻意不提供「列出所有明文凭据」这类接口, 也绝不写日志。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import {
  encryptLocalSecret,
  decryptLocalSecret,
} from '@neoxlabs/platform/platform/localSecretCipher.js';

const CREDENTIALS_DIR = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'plugins', 'credentials');

/** 已解密的凭据。executor 是唯一接触它的地方。 */
export type Credential =
  | { kind: 'oauth2'; accessToken: string; refreshToken?: string; expiresAt?: number }
  | { kind: 'token'; token: string }
  | { kind: 'none' };

function credentialFile(pluginName: string): string {
  /* 插件名已被 pluginSecurity 限制为 [a-z][a-z0-9-]*, 不会穿越目录;
   * 仍然过一遍 basename 兜底, 因为这个函数拼的是要写盘的路径。 */
  return path.join(CREDENTIALS_DIR, `${path.basename(pluginName)}.enc`);
}

export async function saveCredential(pluginName: string, credential: Credential): Promise<void> {
  await fs.mkdir(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  const blob = encryptLocalSecret(JSON.stringify(credential));
  await fs.writeFile(credentialFile(pluginName), blob, { mode: 0o600 });
}

export async function loadCredential(pluginName: string): Promise<Credential | null> {
  try {
    const blob = await fs.readFile(credentialFile(pluginName));
    const parsed = JSON.parse(decryptLocalSecret(blob)) as Credential;
    if (!parsed || typeof parsed.kind !== 'string') return null;
    return parsed;
  } catch {
    /* 不存在 / 换过机器解不开 —— 两种都当作「未连接」, 上层会引导重新授权 */
    return null;
  }
}

export async function deleteCredential(pluginName: string): Promise<void> {
  await fs.rm(credentialFile(pluginName), { force: true });
}

export async function hasCredential(pluginName: string): Promise<boolean> {
  return (await loadCredential(pluginName)) !== null;
}

/**
 * 连接变量 (如 Confluence 的 cloudId)。
 *
 *   与凭据分开存: 它们不是秘密, 而且要在设置页显示给用户看/改。放在
 *   registry 的 userConfig 里会跟插件自身配置混在一起, 所以单独一张表。
 */
const CONNECTIONS_FILE = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'plugins', 'connections.json');

type ConnectionsFile = { version: 1; connections: Record<string, Record<string, unknown>> };

async function readConnections(): Promise<ConnectionsFile> {
  try {
    const raw = await fs.readFile(CONNECTIONS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as ConnectionsFile;
    return parsed?.connections ? parsed : { version: 1, connections: {} };
  } catch {
    return { version: 1, connections: {} };
  }
}

export async function getConnection(pluginName: string): Promise<Record<string, unknown>> {
  return (await readConnections()).connections[pluginName] ?? {};
}

export async function setConnection(
  pluginName: string,
  connection: Record<string, unknown>,
): Promise<void> {
  const data = await readConnections();
  data.connections[pluginName] = connection;
  await fs.mkdir(path.dirname(CONNECTIONS_FILE), { recursive: true });
  await fs.writeFile(CONNECTIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

export async function clearConnection(pluginName: string): Promise<void> {
  const data = await readConnections();
  delete data.connections[pluginName];
  await fs.writeFile(CONNECTIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}
