#!/usr/bin/env node
/**
 * @openneox/cli · prepack hook
 *
 * npm publish 时 npm 会自动在 pack 之前调用 "prepack" script (而不是 "prepublishOnly").
 *
 * 2026-05-28 方案 C 之后 tsup 输出直接落 apps/cli/dist, 且 tsup onSuccess
 * (tsup.config.ts) 已负责: chmod +x / 拷 vendor (Ink fork) / 拷 skills/builtin /
 * 同步 server → ui-electron。所以 prepack 只做一件事: 验证产物齐全, 不再从根 dist/ 拷贝。
 *
 * 期望: 仓库根先跑 `npm run build`(tsup), 产出 apps/cli/dist/cli/main.js + dist/vendor/...
 */
import { existsSync, chmodSync, statSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(__dirname, '..');                // apps/cli/
const cliDist = join(cliRoot, 'dist');

function need(path, hint) {
  if (!existsSync(path)) {
    console.error(`❌ prepack missing: ${path}`);
    console.error(`   ${hint}`);
    process.exit(1);
  }
}

need(join(cliDist, 'cli', 'main.js'), 'Run `npm run build` at repo root first (tsup builds CLI bundle).');
need(join(cliDist, 'server', 'main.js'), 'Run `npm run build` at repo root first (server bundle missing).');
need(join(cliDist, 'vendor'), 'tsup onSuccess 应已拷贝 dist/vendor (Ink fork)。重跑 `npm run build`。');

// bin executable
const mainJs = join(cliDist, 'cli', 'main.js');
chmodSync(mainJs, 0o755);
console.log('✓ chmod +x dist/cli/main.js');

console.log('\n📦 apps/cli/dist/ ready for npm publish');
