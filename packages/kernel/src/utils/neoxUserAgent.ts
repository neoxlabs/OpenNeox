
import os from 'os';
import { VERSION } from '../version.js';

function platformLabel(): string {
  switch (process.platform) {
    case 'darwin':  return 'macOS';
    case 'win32':   return 'Windows';
    case 'linux':   return 'Linux';
    case 'android': return 'Android';
    case 'freebsd': return 'FreeBSD';
    case 'openbsd': return 'OpenBSD';
    default:        return process.platform;
  }
}

const PRODUCT_BY_CLIENT: Record<string, string> = {
  desktop: 'Neox-Desktop',
  cli: 'Neox-CLI',
  vscode: 'Neox-VSCode',
  jetbrains: 'Neox-JetBrains',
};

/* UA 里的每一段都来自环境变量, 去掉会破坏格式的字符 (括号 / 分号 / 换行), 并限长 */
function clean(v: string | undefined, max = 48): string {
  return (v ?? '').replace(/[()\r\n;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function runtimeLabel(): string {
  const versions = process.versions as Record<string, string | undefined>;
  if (versions.electron) return `Electron/${versions.electron}`;
  if (versions.bun) return `Bun/${versions.bun}`;
  return `Node/${process.versions.node}`;
}

let cachedUserAgent: string | null = null;

export function getNeoxUserAgent(): string {
  if (cachedUserAgent) return cachedUserAgent;
  const client = clean(process.env.NEOX_CLIENT, 16).toLowerCase();
  const isElectron = !!(process.versions as Record<string, string | undefined>).electron;
  const product = PRODUCT_BY_CLIENT[client]
    ?? (client ? `Neox-${client.replace(/[^a-z0-9-]/g, '')}` : (isElectron ? 'Neox-Desktop' : 'Neox-CLI'));
  const hostVersion = clean(process.env.NEOX_CLIENT_VERSION, 32);
  const version = hostVersion || VERSION;
  const parts = [platformLabel(), os.arch(), clean(process.env.NEOX_HOST) || runtimeLabel()];
  if (version !== VERSION) parts.push(`Engine/${VERSION}`);
  cachedUserAgent = `${product}/${version} (${parts.join('; ')})`;
  return cachedUserAgent;
}

/** 测试用: 改了环境变量后重新生成 */
export function resetNeoxUserAgentForTests(): void {
  cachedUserAgent = null;
}
