#!/usr/bin/env node
/**
 * neox-native 构建包装 —— 在调 napi 之前把源码路径重映射掉。
 *
 * 【为什么需要】
 *   Rust 的 panic 消息里带 `file!()` 展开的**绝对路径**, 它在编译期就烧进 .rodata,
 *   `strip = "symbols"` 砍的是符号表, 管不到这些字符串。结果发布出去的二进制里能直接
 *   `strings` 出构建机的用户名和目录结构:
 *
 *       /Users/<用户名>/.cargo/registry/src/.../aes-0.8.4/src/soft/fixslice.rs
 *       /Users/<用户名>/<仓库目录>/packages/native/target/release/...
 *
 *   2026-07-28 扫 npm 平台子包时实测 32 处命中, 其中 27 处来自这里。泄漏的是开发者身份
 *   和项目内部结构 —— 用户明确要求消掉。
 *
 * 【怎么做】
 *   --remap-path-prefix 是 rustc 的标准能力 (专为可复现构建设计), 把前缀换成占位符,
 *   不影响任何运行时行为, panic 依然能给出相对文件名和行号, 只是不再带出机器路径。
 *
 *   这里不把用户名写死在配置里 —— 那样换台机器就失效, 而且配置本身又成了一处泄漏。
 *   改成运行时读 $HOME / CARGO_HOME / 仓库根, 现算现替换, 谁的机器都干净。
 */

const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const nativeDir = path.resolve(__dirname, '..');
const home = os.homedir();
const cargoHome = process.env.CARGO_HOME || path.join(home, '.cargo');

/* 顺序有意义: 越长越具体的前缀必须排在前面, 否则会被短前缀先吃掉。
 * 例: $HOME/.cargo 必须先于 $HOME 匹配。 */
const remaps = [
  [cargoHome, '/cargo'],
  [nativeDir, '/neox-native'],
  [repoRoot, '/build'],
  [home, '/home'],
];

const flags = remaps
  .filter(([from]) => from && from !== '/' && from !== '.')
  .map(([from, to]) => `--remap-path-prefix=${from}=${to}`);

const existing = process.env.RUSTFLAGS ? process.env.RUSTFLAGS.split(/\s+/).filter(Boolean) : [];
const rustflags = [...existing, ...flags].join(' ');

const args = process.argv.slice(2);
if (args.length === 0) args.push('build', '--platform', '--release', '--strip');

console.log('[native] remap-path-prefix:');
for (const [from, to] of remaps) console.log(`  ${from} → ${to}`);

const r = spawnSync('npx', ['napi', ...args], {
  cwd: nativeDir,
  stdio: 'inherit',
  env: { ...process.env, RUSTFLAGS: rustflags },
  shell: process.platform === 'win32',
});
if (r.status !== 0) process.exit(r.status ?? 1);

/* macOS: LC_ID_DYLIB 里还烧着一条绝对路径 —— 它在 Mach-O 的 load command 里, 既不受
 * --remap-path-prefix 影响, strings 也扫不到 (要 otool -D 才看得见), 但 `strings` 对整个
 * 最终二进制扫时会命中, 一样把构建机路径带出去:
 *     /Users/<用户名>/<仓库目录>/packages/native/target/release/deps/libneox_native.dylib
 * .node 是被 dlopen 的, 这个 id 对加载没有实际作用, 改成 @rpath 形式最干净。 */
if (process.platform === 'darwin') {
  const fs = require('node:fs');
  for (const f of fs.readdirSync(nativeDir)) {
    if (!f.startsWith('neox-native.') || !f.endsWith('.node')) continue;
    const target = path.join(nativeDir, f);
    const res = spawnSync('install_name_tool', ['-id', `@rpath/${f}`, target], { stdio: 'pipe' });
    if (res.status === 0) console.log(`[native] install_name → @rpath/${f}`);
    else console.warn(`[native] ⚠ install_name_tool 失败 (${f}), LC_ID_DYLIB 仍含构建机路径`);
  }
}
