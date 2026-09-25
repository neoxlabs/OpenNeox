#!/usr/bin/env node
/**
 * examples 编译体检 —— 防止 API 改了示例烂掉。
 *
 * v1 验收标准里写着 "7 个 examples 在干净环境可跑通", 但没有任何自动检查 ——
 * 于是示例只会在用户手里报错。这个脚本用 tsc 把 examples/ 全部类型检查一遍
 * (不执行、不触网、不花钱), 编译不过即失败。
 *
 *   node scripts/check-examples.mjs
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const examples = readdirSync(join(pkgRoot, 'examples'))
  .filter((f) => f.endsWith('.ts'))
  .sort();

if (examples.length === 0) {
  console.error('[sdk] examples/ 下没有 .ts 文件');
  process.exit(1);
}

try {
  execFileSync(
    'npx',
    [
      'tsc',
      '--noEmit',
      '--skipLibCheck',
      '--module', 'nodenext',
      '--moduleResolution', 'nodenext',
      '--target', 'es2022',
      '--strict',
      ...examples.map((f) => join(pkgRoot, 'examples', f)),
    ],
    { cwd: pkgRoot, stdio: 'inherit' },
  );
} catch {
  console.error(`\n[sdk] examples 类型检查失败 —— 示例跟 API 脱节了, 先修示例再发版。`);
  process.exit(1);
}

console.log(`[sdk] examples ✓ — ${examples.length} 个示例类型检查通过`);
