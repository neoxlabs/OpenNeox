#!/usr/bin/env node

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const label = (args.find((a) => a.startsWith('--label=')) || '--label=dist').slice('--label='.length);
const allowTs = args.includes('--allow-ts');

if (!dir) {
  console.error('用法: node scripts/check-source-leak.mjs <dir> [--label=name] [--allow-ts]');
  process.exit(2);
}
if (!existsSync(dir)) {
  console.error(`[leak-guard] 目录不存在: ${dir}`);
  process.exit(2);
}

/* 扫描内容时只读文本型文件, 且只读头部 —— 分发目录里有几十 MB 的 native/.node/字体,
 * 全量读会把构建拖慢好几分钟。内联 map 一定在文件【尾部】, 所以尾部单独取一段。 */
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css']);
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;

const findings = [];
const warnings = [];
let scanned = 0;

/* vendored 第三方源码树 —— 以 TS 源形态被 import 是设计使然 (见文件头 3. 的例外说明).
 * 判据放在这里, 别散到调用方去。 */
const isVendored = (rel) => /(^|[\\/])vendor[\\/]/.test(rel);

const isThirdParty = (rel) => /(^|[\\/])node_modules[\\/]/.test(rel) || isVendored(rel);
const PROMPT_ASSET_EXT = new Set(['.md', '.txt']);
function isPromptAsset(rel, name) {
  if (isThirdParty(rel)) return false;
  if (name === 'SKILL.md') return true;
  if (!PROMPT_ASSET_EXT.has(extname(name))) return false;
  return /(^|[\\/])(skills|prompts)[\\/]/.test(rel);
}

function readEdges(file, size) {
  const fd = readFileSync(file);
  if (size <= HEAD_BYTES + TAIL_BYTES) return fd.toString('latin1');
  return (
    fd.subarray(0, HEAD_BYTES).toString('latin1') + '\n' + fd.subarray(size - TAIL_BYTES).toString('latin1')
  );
}

function walk(cur) {
  let entries;
  try {
    entries = readdirSync(cur, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(cur, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      walk(p);
      continue;
    }
    if (!e.isFile()) continue;
    const rel = relative(dir, p);

    /* 1 + 3: 按文件名判 */
    if (e.name.endsWith('.map')) {
      findings.push({ kind: 'sourcemap-file', rel });
      continue;
    }
    if (!allowTs && !e.name.endsWith('.d.ts')) {
      const ext = extname(e.name);
      if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') {
        if (isVendored(rel)) warnings.push(rel);
        else findings.push({ kind: 'typescript-source', rel });
        continue;
      }
    }

    /* 5: prompt 资产明文 (见文件头 5. 的范围说明) */
    if (isPromptAsset(rel, e.name)) {
      findings.push({ kind: 'prompt-asset-plaintext', rel });
      continue;
    }

    /* 2 + 4: 按内容判 (只看文本型) */
    if (!TEXT_EXT.has(extname(e.name))) continue;
    let size;
    try {
      size = statSync(p).size;
    } catch {
      continue;
    }
    if (size === 0) continue;
    let txt;
    try {
      txt = readEdges(p, size);
    } catch {
      continue;
    }
    scanned++;
    if (txt.includes('sourceMappingURL=data:')) {
      findings.push({ kind: 'inline-sourcemap', rel });
      continue;
    }
    if (txt.includes('sourcesContent')) {
      /* 纯 indexOf, 不用正则 —— 跟 build-cli-binaries.ts 的护栏同款判据:
       * 真 map 的 sources/sourcesContent 才会出现 packages/<pkg>/src/ 或 apps/cli/src/ 路径。 */
      for (const n of ['packages/core', 'apps/cli', 'packages/kernel', 'packages/sdk']) {
        if (txt.indexOf(n + '/src/') >= 0) {
          findings.push({ kind: 'embedded-map-content', rel });
          break;
        }
      }
    }
  }
}

walk(dir);

if (findings.length > 0) {
  console.error(`\n[leak-guard] 🔴 ${label}: 源码泄漏 ${findings.length} 处 — 拒绝发布\n`);
  const byKind = new Map();
  for (const f of findings) {
    if (!byKind.has(f.kind)) byKind.set(f.kind, []);
    byKind.get(f.kind).push(f.rel);
  }
  for (const [kind, files] of byKind) {
    console.error(`  ${kind} (${files.length}):`);
    for (const f of files.slice(0, 20)) console.error(`    · ${f}`);
    if (files.length > 20) console.error(`    · … 还有 ${files.length - 20} 个`);
  }
  console.error(
    '\n  修 · sourcemap 类: 分发前从产物里剔除 (别去关 tsup 的 sourcemap —— 它对本地调试有用,' +
      '\n      正确做法是 map 留在构建机器上, 不进分发目录)。' +
      '\n  修 · prompt-asset 类: 别把 skills/ prompts/ 的明文拷进分发目录 —— 运行时走烘焙快照' +
      '\n      (bake-skills.mjs / bake-prompts.mjs)。删完记得跑 check-resource-integrity.mjs' +
      '\n      复核技能仍能加载, 两个闸都绿才算修好。\n',
  );
  process.exit(1);
}

if (warnings.length > 0) {
  console.log(
    `[leak-guard] ℹ ${label}: ${warnings.length} 个 vendored 第三方 TS 源随包发 ` +
      `(如 vendor/ink —— 运行时以源形态被 import, 不是我们的源码, 放行)`,
  );
}
console.log(`[leak-guard] ✓ ${label}: 干净 (扫了 ${scanned} 个文本文件, 无 .map / 无内联 map / 无自有 TS 源)`);
