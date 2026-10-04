#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

/* 类别 → [正则, 允许的最大字节]。0 = 一个字节都不许有。 */
const RULES = [
  ['Rust 构建中间物 (cargo target/)', /\/target\/(release|debug)\//i, 0],
  ['C/C++ 源码与头文件', /\.(c|cc|cpp|cxx|h|hpp)$/i, 2 * 1024 * 1024],
  ['linux/android 的 prebuilds', /\/prebuilds\/(linux|android)[^/]*\//i, 0],
  ['linux 的 onnxruntime 二进制', /\/onnxruntime-node\/bin\/napi-v6\/linux\//i, 0],
  ['已知的死依赖 react-icons', /\/node_modules\/react-icons\//i, 0],
  ['node-gyp 中间物', /\/build\/(Release|Debug)\/(obj|obj\.target|\.deps)\/|\.(o|a|lib|pdb)$/i, 0],
  ['onnxruntime 重复副本', /\/onnxruntime-node\/bin\/napi-v6\/darwin\/[^/]+\/libonnxruntime\.1\.27\.0\.dylib$|\/sherpa-onnx-darwin-[^/]+\/libonnxruntime\.dylib$/i, 0],
  ['旧版壁纸存档', /\/renderer\/wallpapers-v1-archive-/i, 0],
  ['iconify 图标全集 (构建期依赖)', /\/node_modules\/@iconify-json\//i, 0],
  ['Neox native 源与构建物 (src/lib.rs = HMAC root secret 明文)',
    /\/node_modules\/@neoxlabs\/native\/(src|scripts|tests)\/|\/node_modules\/@neoxlabs\/native\/(Cargo\.(toml|lock)|build\.rs)$/i, 0],
  ['Neox 自有包源码 (pptx 运行时只吃 dist/)',
    /\/node_modules\/@neoxlabs\/pptx-[^/]+\/(src|scripts)\/|\/node_modules\/@neoxlabs\/pptx-[^/]+\/tsconfig[^/]*$/i, 0],
];

const TOTAL_BUDGET = 780 * 1000 * 1000;

function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(12);
    const buf = Buffer.alloc(headerSize);
    fs.readSync(fd, buf, 0, headerSize, 16);
    const text = buf.toString('utf8');
    return JSON.parse(text.slice(0, text.lastIndexOf('}') + 1));
  } finally {
    fs.closeSync(fd);
  }
}

function flatten(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = `${prefix}/${name}`;
    if (entry.files) flatten(entry, p, out);
    else out.set(p, entry.size || 0);
  }
}

function findDefaultAsar() {
  const roots = ['release/mac-arm64', 'release/mac', 'release/win-unpacked'];
  for (const r of roots) {
    for (const c of [
      path.join(r, 'Neox.app/Contents/Resources/app.asar'),
      path.join(r, 'resources/app.asar'),
    ]) {
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

function mb(n) { return (n / 1e6).toFixed(1) + ' MB'; }

function main() {
  const asarPath = process.argv[2] || findDefaultAsar();
  if (!asarPath || !fs.existsSync(asarPath)) {
    /* 没打包产物时不算失败 —— 这个脚本要能挂在 CI 的任意阶段而不添乱 */
    console.log('[bloat] 没找到 app.asar, 跳过 (先打包再跑本检查)');
    return;
  }

  const files = new Map();
  flatten(readAsarHeader(asarPath), '', files);
  const total = [...files.values()].reduce((a, b) => a + b, 0);

  console.log(`[bloat] ${asarPath}`);
  console.log(`[bloat] 载荷 ${mb(total)} / ${files.size} 个文件\n`);

  const failures = [];
  const claimed = new Set();
  for (const [label, re, budget] of RULES) {
    let bytes = 0; let count = 0; const samples = [];
    for (const [p, size] of files) {
      if (claimed.has(p) || !re.test(p)) continue;
      claimed.add(p); bytes += size; count += 1;
      if (samples.length < 3) samples.push(p);
    }
    const ok = bytes <= budget;
    console.log(`  ${ok ? '✓' : '✗'} ${label}: ${mb(bytes)} (${count} 个, 上限 ${mb(budget)})`);
    if (!ok) failures.push({ label, bytes, budget, samples });
  }

  if (total > TOTAL_BUDGET) {
    failures.push({
      label: `载荷总量超预算 (${mb(total)} > ${mb(TOTAL_BUDGET)})`,
      bytes: total, budget: TOTAL_BUDGET, samples: [],
    });
  }

  if (failures.length === 0) {
    console.log('\n[bloat] 通过');
    return;
  }

  console.error('\n[bloat] ✗ 有不该进包的内容:\n');
  for (const f of failures) {
    console.error(`  · ${f.label} — ${mb(f.bytes)} (上限 ${mb(f.budget)})`);
    for (const s of f.samples) console.error(`      ${s}`);
  }
  console.error('\n  修法: 在 electron-builder.json 的**顶层** files 里加对应的 "!" 排除。');
  console.error('  只排除任何代码路径都不会加载的东西 —— 构建中间物 / 源码 / 从不构建的平台');
  console.error('  (linux, android) 的二进制。不确定就先别排。');
  console.error('  ⚠️ 绝对不要写进 mac.files / win.files 平台段: 2026-08-05 实测, 一旦平台段');
  console.error('     出现 files, electron-builder 会把整个仓库打进 asar —— 396112 个文件 /');
  console.error('     5.02GB, 连 gitignore 的本地目录都进去了。要按平台分叉得另想办法。\n');
  process.exit(1);
}

main();
