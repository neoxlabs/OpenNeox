/**
 * 窗口截图落在哪。
 *
 * 桥默认写系统临时目录, 但**渲染层读不到那儿**: neox-asset:// 协议只放行 workspace 各根
 * 和 Neox 自己的 artifacts 目录, /var/folders/... 一律 403 —— 结果就是卡片上一个破图。
 * 所以统一落在 `~/.neox/run/shots/`, 主进程把这条路径加进放行清单。
 *
 * 顺手做保留上限: 截图只在 AX 读不到元素时才取, 但那类 App (微信/飞书) 一用起来就是
 * 一串, 不封顶会一直堆在用户磁盘上。每次写之前把超出 KEEP 的旧图删掉。
 */

import { join } from 'node:path';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';

const KEEP = 40;

export function shotsDir(): string {
  return neoxHome('run', 'shots');
}

/** 下一张截图的绝对路径 (顺手清理旧图)。 */
export function nextShotPath(): string {
  const dir = shotsDir();
  try { mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
  pruneShots(dir);
  return join(dir, `shot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`);
}

function pruneShots(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jpg'))
      .map((f) => {
        const p = join(dir, f);
        return { p, t: statSync(p).mtimeMs };
      })
      .sort((a, b) => b.t - a.t);
    for (const f of files.slice(KEEP)) {
      try { unlinkSync(f.p); } catch { /* 别人正在读 / 已经没了 */ }
    }
  } catch { /* 目录读不了就不清, 清理失败绝不该影响截图本身 */ }
}
