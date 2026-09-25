
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';
import { getOsBridge } from './osBridgeClient.js';

/** value 为 null = 问过了, 拿不到。别再问第二次。 */
const cache = new Map<string, string | null>();

export function iconsDir(): string {
  return neoxHome('run', 'icons');
}

/** App 名 → 文件名。只留字母数字, 其余压成 `_` —— 中文名的 App (微信/钉钉) 也要有个稳定文件名。 */
function iconFileName(app: string): string {
  const safe = app.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'app';
  /* 中文名压完可能只剩下划线, 再拼一个长度做区分, 够用且稳定 */
  return `${safe}-${app.length}.png`;
}

/** 返回图标的**本地文件路径**; 拿不到返回 undefined。 */
export async function appIconPath(app?: string): Promise<string | undefined> {
  const key = (app ?? '').trim();
  if (!key) return undefined;
  const hit = cache.get(key);
  if (hit !== undefined) return hit ?? undefined;

  const path = join(iconsDir(), iconFileName(key));
  if (existsSync(path)) { cache.set(key, path); return path; }

  try {
    const r = await getOsBridge().request({ op: 'icon', app: key, path }) as
      { ok?: boolean; path?: string };
    const got = r?.ok && typeof r.path === 'string' ? r.path : null;
    cache.set(key, got);
    return got ?? undefined;
  } catch {
    /* 桥没起来 / 没装插件 —— 图标是锦上添花, 绝不能因此让工具调用失败 */
    cache.set(key, null);
    return undefined;
  }
}

/** 测试用 —— 生产路径不该清缓存 */
export function __resetAppIconCache(): void {
  cache.clear();
}
