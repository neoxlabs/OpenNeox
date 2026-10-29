import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectTsFiles(full, out);
    else if (/\.(ts|tsx|cjs|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

const CHOKIDAR_IMPORT = /(?:from|require\()\s*\(?\s*['"]chokidar['"]/;

describe('桌面端禁止轮询式文件监听', () => {
  it('没有任何源码 import chokidar', () => {
    const offenders = collectTsFiles(SRC_ROOT)
      .filter((f) => CHOKIDAR_IMPORT.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC_ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('watcher 源码里不出现 polling 后端标识', () => {
    const watcherFiles = [
      path.join(SRC_ROOT, 'ui/electron/ipc/workspaceWatcherHandlers.ts'),
      path.join(SRC_ROOT, 'ui/electron/ipc/workspaceWatchOptions.ts'),
    ];
    for (const f of watcherFiles) {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toContain('chokidar-poll');
      expect(src).not.toMatch(/usePolling\s*:\s*true/);
    }
  });
});
