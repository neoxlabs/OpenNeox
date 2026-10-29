import { app } from 'electron';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cached: string | null = null;

export function getAppVersion(): string {
  if (cached) return cached;

  /* 打包版: asar 根 package.json 就是发版真相 */
  if (app.isPackaged) {
    const v = app.getVersion();
    if (v) { cached = v; return cached; }
  }

  /* dev: 按 name 显式认, 别按路径猜 —— 按路径猜正是当年撞上 neox-cli 的原因 */
  const candidates = [
    join(__dirname, '..', '..', '..', '..', 'desktop', 'package.json'),
    join(__dirname, '..', '..', '..', '..', '..', 'package.json'),
    join(__dirname, '..', '..', '..', 'package.json'),
  ];
  let desktopPkgVersion: string | null = null;
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf-8')) as { name?: string; version?: string };
      if (!pkg.version) continue;
      /* monorepo 根 = desktop.sh 写入的那份, 优先级最高 */
      if (pkg.name === 'neox-monorepo') { cached = pkg.version; return cached; }
      /* neox-desktop 子包只当次选 —— desktop.sh 不写它, 可能是陈的 */
      if (pkg.name === 'neox-desktop' && !desktopPkgVersion) desktopPkgVersion = pkg.version;
    } catch { /* 尝试下一个 */ }
  }
  if (desktopPkgVersion) { cached = desktopPkgVersion; return cached; }

  cached = app.getVersion();
  return cached;
}
