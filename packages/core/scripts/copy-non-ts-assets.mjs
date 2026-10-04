#!/usr/bin/env node
/**
 * copy-non-ts-assets — tsc 只处理 .ts 文件, 其它资源 (SKILL.md, references/*.md,
 * scripts/*.mjs) 得手动复制到 dist/. build 后执行.
 *
 * 复制清单:
 *   1) src/tools/pptx/scripts/**\/ *.mjs → dist/... (agent 运行的 inspect / render 脚本)
 *   2) src/skills/builtin/**\/ *.md, *.txt, *.json → dist/... (SKILL.md + references/)
 */
import { readdir, mkdir, copyFile, stat, rm } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/* fileURLToPath 而不是 .pathname: Windows 上 pathname 是 `/E:/...`, join 之后
 * 是 `\E:\...` (当前盘根下的怪路径), existsSync/readdir 全 false —— 资源一个都拷不过去,
 * 而且不报错 (清单为空就是"正常完成")。 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

const KEEP_EXTS = new Set(['.mjs', '.cjs', '.md', '.txt', '.json', '.yaml', '.yml', '.sh', '.py']);

async function walk(dir, results = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return results; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__' || e.name.startsWith('.')) continue;
      await walk(full, results);
    } else if (e.isFile()) {
      const dotIdx = e.name.lastIndexOf('.');
      const ext = dotIdx >= 0 ? e.name.slice(dotIdx).toLowerCase() : '';
      if (KEEP_EXTS.has(ext)) results.push(full);
    }
  }
  return results;
}

async function main() {
  /* dist/skills/builtin 整个是本脚本的产物 (tsc 不往里写) —— 先清空再拷, 保证跟源目录一致。
   * 2026-09-17: 删掉 builtin/commit 后重新 build, dist 里的旧 commit/SKILL.md 还在, 而 registry
   * 优先读磁盘 builtin 目录 —— 删掉的技能照样出现在技能列表里。只增不删的拷贝就是这个坑。 */
  await rm(join(DIST, 'skills', 'builtin'), { recursive: true, force: true });
  const files = await walk(SRC);
  let copied = 0;
  for (const src of files) {
    const rel = relative(SRC, src);
    const dst = join(DIST, rel);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    copied++;
  }
  console.log(`copied ${copied} non-ts asset(s) to dist/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
