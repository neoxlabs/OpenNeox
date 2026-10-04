import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const CLI_OPEN_ENTRY = 'apps/cli/src/main.ts';
export const CLI_COMMERCIAL_ENTRY = 'apps/cli/src/auth/cliEntry.ts';
const COMMERCIAL_DIR = 'apps/cli/src/auth';

/** 返回仓库根相对路径 (posix 分隔符) */
export function resolveCliEntry(repoRoot = REPO_ROOT) {
  if (!existsSync(join(repoRoot, COMMERCIAL_DIR))) return CLI_OPEN_ENTRY;
  if (!existsSync(join(repoRoot, CLI_COMMERCIAL_ENTRY))) {
    throw new Error(
      `[cli-entry] ${COMMERCIAL_DIR}/ 存在但 ${CLI_COMMERCIAL_ENTRY} 不在 —— 商业入口被改名/删了? `
      + '不回落到公开入口 (那会静默打出一个没有账号功能的商业版)。',
    );
  }
  return CLI_COMMERCIAL_ENTRY;
}

/* 直接运行 (tsx scripts/cli-entry.mjs ...) → 加载对应入口; argv 原样留给 CLI 解析。
 * 不用顶层 await: tsup 打包 tsup.config.ts 时会把本文件一起编进 CJS 配置, 顶层 await 过不去。 */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  import(pathToFileURL(join(REPO_ROOT, resolveCliEntry())).href).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
