import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 从当前文件向上找仓库根 (apps/cli/src/main.ts 存在的那一层). */
function findRepoRoot(): string {
  let cur = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(cur, 'apps', 'cli', 'src', 'main.ts'))) return cur;
    const next = dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  throw new Error('CLI e2e: 找不到仓库根 (apps/cli/src/main.ts)');
}

export const REPO_ROOT = findRepoRoot();
export const CLI_ENTRY = join(REPO_ROOT, 'apps', 'cli', 'src', 'main.ts');
export const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

/** 非交互 / PTY 都走 tsx 源码入口 —— 不依赖 dist 是否刚 build 过. */
export const CLI_COMMAND = TSX_BIN;
export const CLI_PREFIX_ARGS = [CLI_ENTRY];
