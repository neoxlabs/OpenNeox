#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIRS = [
  'apps/desktop/src/ui/electron',
  'packages/core/src/server',
  'packages/core/src/runtime',
];

const asar = process.argv[2];
if (!asar || !fs.existsSync(asar)) {
  console.error('用法: node scripts/check-dynamic-exports.mjs <app.asar>');
  process.exit(2);
}

/* ── 1. 源码侧: 收集 (模块, 用到的成员) ── */
const pairs = new Map();
/* 太容易跟局部变量撞名的命名空间绑定 —— 见下面 scan() 里的说明 */
const AMBIGUOUS_BINDINGS = new Set(['m', 'e', 'x', 's', 'r', 'p', 't', 'a', 'b', 'c', 'i', 'k', 'v', 'o', 'f', 'g', 'n', 'd', 'u', 'w', 'mod', 'lib', 'ns']);
const ambiguous = [];
/* 短名绑定的取用点搜索窗口 (字符数) —— 一个函数体的量级 */
const NEAR_WINDOW = 800;

function scan(file) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /(?:const|let|var)\s+(\{[^}]+\}|[A-Za-z_$][\w$]*)\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const [, binding, mod] = m;
    if (!(mod.startsWith('.') || mod.startsWith('@neoxlabs/'))) continue;
    if (binding.startsWith('{')) {
      for (const raw of binding.slice(1, -1).split(',')) {
        const name = raw.split(':')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) pairs.set(`${mod}|${name}`, { file, mod, member: name });
      }
    } else {
      const near = AMBIGUOUS_BINDINGS.has(binding);
      if (near) ambiguous.push({ file, mod, binding });
      /* 短名: 只看 import 之后一小段 (同一个函数体的量级)。牺牲一点覆盖换零误报 ——
       * 误报的代价是发版链在出完包之后才红, 比漏掉一个远处的取用点贵得多。 */
      const hay = near ? src.slice(m.index, m.index + NEAR_WINDOW) : src;
      const use = new RegExp(`\\b${binding}\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)`, 'g');
      let u;
      while ((u = use.exec(hay))) pairs.set(`${mod}|${u[1]}`, { file, mod, member: u[1] });
    }
  }
}

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/node_modules|__tests__|dist/.test(e.name)) continue;
      walk(p);
    } else if (/\.tsx?$/.test(e.name)) scan(p);
  }
}

for (const d of SRC_DIRS) {
  const abs = path.join(ROOT, d);
  if (fs.existsSync(abs)) walk(abs);
}

if (ambiguous.length) {
  console.log(`[dyn-exports] ${ambiguous.length} 处短名绑定 (m / mod / ...) 只在 import 后 ${NEAR_WINDOW} 字内取用点 —— 全文扫会误报`);
}

/* ── 2. 产物侧: 核对导出绑定 ── */
/* 直接按模式做字节搜索, 不在内存里拼接整份字符串 (asar 几百 MB, 提取会 OOM) */
const buf = fs.readFileSync(asar);
const has = (pat) => buf.includes(Buffer.from(pat, 'utf8'));
const members = [...pairs.values()];
const missing = [];
let bound = 0;

for (const p of members) {
  const hasBinding = has(`'${p.member}':()=>`)
    || has(`"${p.member}":()=>`)
    || has(`${p.member}:()=>`);
  if (hasBinding) { bound++; continue; }
  /* 没绑定也没调用 = 整条路径被 tree-shake, 不算塌陷 */
  const called = has(`['${p.member}']`) || has(`.${p.member}(`);
  if (called) missing.push(p);
}

console.log(`[dyn-exports] 动态 import 自有成员 ${members.length} 个, 导出绑定完好 ${bound} 个`);

if (missing.length) {
  console.error(`\n❌ [dyn-exports] ${missing.length} 个成员在产物里只有调用点、没有导出绑定 —— 运行时会是 "is not a function":\n`);
  for (const p of missing) {
    console.error(`   ${p.member}  ←  ${p.mod}`);
    console.error(`     调用方: ${path.relative(ROOT, p.file)}`);
  }
  console.error('\n  查 bundle 配置: 该模块是否被 tsup/esbuild 正确打进产物、导出是否被摇掉。');
  process.exit(1);
}
console.log('[dyn-exports] ✅ 无塌陷');
