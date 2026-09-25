#!/usr/bin/env tsx
/**
 * minify-desktop-bundle — 桌面端打包前把 dist/ui-electron 下的 JS 用 terser 压缩一遍 (2026-09-17)。
 *
 *   取代原 Fortress 管线 (compile-bytecode --bytecode / polymorphic / integrity manifest):
 *     · 不再 javascript-obfuscator 强混淆主进程 —— 实测主进程 bundle 4.4MB → 9.7MB,
 *       热点代码 (SSE 解析) 慢 2.7~3.6 倍, 且出过崩溃; 源码保护在 AI 时代基本无效。
 *     · 不再 polymorphic 注入死代码 / 字符串 XOR —— v2.5.0 崩溃来源。
 *     · 不再 drop_console —— 打包版排障要靠日志。
 *   只保留普通压缩: 体积小、解析快, 行为不变。
 *
 * Usage: npx tsx scripts/minify-desktop-bundle.ts [--dry-run]
 * Run AFTER ui:build and BEFORE electron-builder.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';

const DIST_DIR = join(process.cwd(), 'apps', 'cli', 'dist', 'ui-electron');
/* preload 必须保持原样 CJS (contextBridge) */
const SKIP_FILES = new Set(['electron/preload.cjs']);

function findJsFiles(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...findJsFiles(full, base));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(relative(base, full));
    }
  }
  return out;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  if (!existsSync(DIST_DIR)) {
    console.error(`[minify] dist not found: ${DIST_DIR}`);
    process.exit(1);
  }
  const terser = createRequire(import.meta.url)('terser');

  let before = 0;
  let after = 0;
  const errors: string[] = [];
  const files = findJsFiles(DIST_DIR).filter((f) => !SKIP_FILES.has(f.replace(/\\/g, '/')));
  for (const rel of files) {
    const abs = join(DIST_DIR, rel);
    try {
      const source = readFileSync(abs, 'utf8');
      const result = await terser.minify(source, {
        module: true,
        ecma: 2022,
        compress: { passes: 2, drop_debugger: true, toplevel: true },
        /* 不混淆属性名: React 的 __html / _owner 等内部属性会被改坏 (React #61 白屏) */
        mangle: { toplevel: true, properties: false },
        output: { comments: false },
      });
      const code = result.code ?? source;
      before += Buffer.byteLength(source);
      after += Buffer.byteLength(code);
      if (!dryRun) writeFileSync(abs, code, 'utf8');
    } catch (err) {
      errors.push(`${rel}: ${(err as Error).message.slice(0, 120)}`);
    }
  }

  console.log(`[minify] ${files.length} files  ${(before / 1e6).toFixed(1)}MB → ${(after / 1e6).toFixed(1)}MB${dryRun ? ' (dry-run)' : ''}`);
  if (errors.length) {
    for (const e of errors) console.error(`[minify] ✗ ${e}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[minify] fatal:', err);
  process.exit(1);
});
