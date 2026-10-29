/**
 * CLI 版本号 — 唯一真相是仓库根的 release.json (见 release.json 里的 _readme)。
 *
 * `apps/cli/package.json` 里的 version 只是 npm 包占位 (发版链在构建**之前**才把 release.json
 * 的值写进去), 所以直接读它会得到一个过期的号: 包 3.4.9 / 发布记录 4.0.4, `neox --version`
 * 报的是前者 —— 用户报问题时会把这个号当版本, 跟发布记录对不上。
 *
 * 这里从模块所在目录往上找 release.json, 并要求同层还有 apps/cli/package.json (防止在
 * 全局安装目录里误命中别处的 release.json)。找不到 (bun 编译出的单文件) 再退回 package.json。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '@neoxlabs/kernel/version.js';

function readReleaseCliVersion(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const manifestPath = join(dir, 'release.json');
    if (existsSync(manifestPath) && existsSync(join(dir, 'apps', 'cli', 'package.json'))) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { cli?: unknown };
        if (typeof manifest.cli === 'string' && /^\d+\.\d+\.\d+/.test(manifest.cli)) {
          return manifest.cli;
        }
      } catch {
        /* 坏文件就继续往上找 */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function resolveCliVersion(): string {
  try {
    return readReleaseCliVersion(dirname(fileURLToPath(import.meta.url))) ?? VERSION;
  } catch {
    return VERSION;
  }
}

export const CLI_VERSION = resolveCliVersion();
