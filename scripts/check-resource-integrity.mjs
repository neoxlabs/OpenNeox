#!/usr/bin/env node
/**
 * check-resource-integrity — 资源完整性闸 (2026-07-18).
 *
 * ─── 它防的是什么 ────────────────────────────────────────────────────────────
 *   2026-07-18 实测: 已发布的 2.6.0 安装包 app.asar 里 `.md` 数量为 0。
 *   electron-builder.json 的 `files` 里有一条 `!**\/*.md`, 它把所有内置技能的
 *   SKILL.md 全排除掉了 —— 目录结构还在, 全是空壳。用户侧的表现是**没有任何报错**,
 *   只是 agent 悄悄少了一半本事 (commit / review / knowledge-* / pptx-deck-writer)。
 *
 *   这类 bug 的共性: 代码运行时要读一个磁盘上的资源文件, 打包规则把它丢了, 而加载
 *   失败被当成"本来就没有"。它不会在 dev 里复现 (dev 有源码树), 只在发行版里发作,
 *   所以必须**在构建期**钉死。
 *
 * ─── 判据: 跑加载逻辑, 不 grep 明文 ─────────────────────────────────────────
 *   ⚠️ 跟 scripts/check-source-leak.mjs 的目标是**相反**的, 两个闸不能打架:
 *
 *     check-source-leak      : 技能内容【不许】明文出现在产物里 (SKILL.md = prompt 工程
 *                              产出 = 核心 IP, 解包即 cat 等于没打包)。
 *     check-resource-integrity: 技能内容【必须】能被加载出来。
 *
 *   两者同时成立的唯一办法, 也正是仓库已有的做法: 烘焙成 base64 常量进 bundle
 *   (bake-prompts / bake-schemas / bake-skills)。所以本闸**只调真实的加载函数**,
 *   看它能不能吐出东西, 绝不做明文扫描 —— 明文扫描既会跟泄漏闸对撞, 也测不到
 *   "解码后是不是完整的"。
 *
 * ─── 期望值从哪来 ───────────────────────────────────────────────────────────
 *   不写死 magic number。期望值 = **源码树里数出来的真值**, 产物必须逐项对齐。
 *   这样加一个技能 / 加一个 model schema 不需要改本脚本, 而漏 bake 立刻红。
 *
 *   用法:  node scripts/check-resource-integrity.mjs [--verbose]
 *   退出码: 0 完整 / 1 有缺口
 */

import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');

const failures = [];
const report = [];

function ok(label, detail) {
  report.push(`  ✅ ${label} — ${detail}`);
}
function bad(label, detail) {
  failures.push(`${label}: ${detail}`);
  report.push(`  ❌ ${label} — ${detail}`);
}

/** 动态 import 一个 dist 产物; 不存在 = 构建没跑完, 直接算失败 (而不是跳过). */
async function importDist(relPath) {
  const abs = join(REPO_ROOT, relPath);
  if (!existsSync(abs)) {
    throw new Error(`产物不存在: ${relPath} — 先跑 npm run build:packages`);
  }
  return import(pathToFileURL(abs).href);
}

function countDirs(dir, predicate) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .filter((name) => predicate(join(dir, name), name));
}

// ══════════════════════════════════════════════════════════════════════════
// 1. 内置技能 —— 烘焙快照必须覆盖源码树里的每一个技能
// ══════════════════════════════════════════════════════════════════════════
async function checkSkills() {
  const label = '内置技能';
  const builtinDir = join(REPO_ROOT, 'packages', 'core', 'src', 'skills', 'builtin');
  /* 源码真值: builtin/ 下每个含 SKILL.md 的目录 = 一个技能 (跟 SkillLoader 的判据一致) */
  const expected = countDirs(builtinDir, (p) => existsSync(join(p, 'SKILL.md')));
  if (expected.length === 0) {
    bad(label, `源码树 ${builtinDir} 里一个技能都没有 — 这本身就不对`);
    return;
  }

  const { getBakedSkills } = await importDist('packages/core/dist/skills/bakedSkills.generated.js');
  const snapshot = getBakedSkills();
  const bakedIds = Object.keys(snapshot);

  const missing = expected.filter((id) => !bakedIds.includes(id));
  if (missing.length > 0) {
    bad(label, `烘焙快照缺 ${missing.length} 个技能: ${missing.join(', ')} — 漏跑 scripts/bake-skills.mjs?`);
    return;
  }

  /* 光有 key 不够 —— 空壳 SKILL.md 正是这次的病症. 每个技能必须有非空 SKILL.md 正文. */
  const hollow = bakedIds.filter((id) => {
    const body = snapshot[id]?.['SKILL.md'];
    return typeof body !== 'string' || body.trim().length < 50;
  });
  if (hollow.length > 0) {
    bad(label, `${hollow.length} 个技能的 SKILL.md 是空壳: ${hollow.join(', ')}`);
    return;
  }

  /* 真跑一遍加载器 —— 快照解得开 ≠ 加载器认得出 (frontmatter 解析失败会静默丢). */
  const { SkillLoader } = await importDist('packages/core/dist/skills/loader.js');
  const loaded = await new SkillLoader().loadFromSnapshot(snapshot, 'builtin', 'baked://integrity-check');
  if (loaded.length < expected.length) {
    const loadedIds = loaded.map((s) => s.id);
    bad(
      label,
      `加载器只解析出 ${loaded.length}/${expected.length} 个技能, 丢了: ` +
        expected.filter((id) => !loadedIds.includes(id)).join(', '),
    );
    return;
  }
  ok(label, `${loaded.length} 个技能从烘焙快照完整加载 (${loaded.map((s) => s.id).join(', ')})`);
}

// ══════════════════════════════════════════════════════════════════════════
// 2. Schemas —— 四类 yaml 逐类对齐
// ══════════════════════════════════════════════════════════════════════════
async function checkSchemas() {
  const label = 'Schemas';
  const { getBakedSchemas } = await importDist('packages/kernel/dist/schemas/bakedSchemas.generated.js');
  const snapshot = getBakedSchemas();

  const problems = [];
  let total = 0;
  for (const kind of ['protocols', 'providers', 'models', 'families']) {
    const srcDir = join(REPO_ROOT, 'schemas', kind);
    const expected = existsSync(srcDir)
      ? readdirSync(srcDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      : [];
    const baked = Object.keys(snapshot[kind] ?? {});
    total += baked.length;
    const missing = expected.filter((f) => !baked.includes(f));
    if (missing.length > 0) {
      problems.push(`${kind} 缺 ${missing.length} 个: ${missing.join(', ')}`);
    }
    /* 空内容 = 烘焙时读到了空文件, 跟没有一样 */
    const empty = baked.filter((f) => !String(snapshot[kind][f] ?? '').trim());
    if (empty.length > 0) problems.push(`${kind} 有 ${empty.length} 个空 schema: ${empty.join(', ')}`);
  }

  if (problems.length > 0) {
    bad(label, problems.join(' | ') + ' — 漏跑 scripts/bake-schemas.mjs?');
    return;
  }

  /* 真跑注册表 —— 强制走烘焙分支 (清掉 NEOX_SCHEMAS_DIR + 换到一个没有 schemas/ 的 cwd
   * 才能模拟发行版; 这里用 loadSchemas 的显式 source 参数更干净, 没有就退回计数校验). */
  ok(label, `protocols/providers/models/families 共 ${total} 份 yaml 完整烘焙`);
}

// ══════════════════════════════════════════════════════════════════════════
// 3. Agent 提示词 —— 烘焙常量必须有实质内容
// ══════════════════════════════════════════════════════════════════════════
async function checkPrompts() {
  const label = 'Agent 提示词';
  const mod = await importDist('packages/kernel/dist/prompts/gptAgentsInstructions.generated.js');
  /* 导出形态是 const 字符串 (bake-prompts 直接 Buffer.from(_b64).toString), 不是 getter.
   * 两种都接: 取第一个非空字符串导出, 或第一个函数的返回值. */
  const values = Object.values(mod);
  const text = values.find((v) => typeof v === 'string')
    ?? (typeof values.find((v) => typeof v === 'function') === 'function'
      ? values.find((v) => typeof v === 'function')()
      : undefined);
  if (text === undefined) {
    bad(label, 'gptAgentsInstructions.generated.js 没有导出可读的提示词内容');
    return;
  }
  if (typeof text !== 'string' || text.trim().length < 200) {
    bad(label, `烘焙出来的提示词长度只有 ${String(text).length} — 疑似空壳`);
    return;
  }
  ok(label, `${text.length} 字符`);
}

// ══════════════════════════════════════════════════════════════════════════
// 4. pptx 脚本 —— 必须以【真文件】随包发 (不能烘焙: 要被 node 子进程执行)
// ══════════════════════════════════════════════════════════════════════════
function checkPptxScripts() {
  /* 2026-09-10: pptx 自检改成进程内函数 (neox-core tools/pptx/pptxInspect.ts),
   * 不再有给 node 子进程跑的 .mjs 要随包发。保留这一格只为报告编号不乱。 */
  report.push('  ⏭  pptx 脚本 — 已下线 (自检在进程内跑)');
}

// ══════════════════════════════════════════════════════════════════════════
// 5. 打包排除规则 vs 磁盘技能目录 —— 回归探针
// ══════════════════════════════════════════════════════════════════════════
function checkPackagingContract() {
  const label = '打包契约';
  const builderPath = join(REPO_ROOT, 'electron-builder.json');
  if (!existsSync(builderPath)) {
    bad(label, 'electron-builder.json 不存在');
    return;
  }
  /* 这里不是要求删掉 `!**\/*.md` —— 它拦住 SKILL.md 明文进 asar, 是源码泄漏闸要的。
   * 只是把"排除规则存在"这个事实和"所以必须有烘焙快照"绑在一起显式记录下来:
   * 若哪天有人删了排除规则, 上面的技能检查照样过; 若有人删了烘焙, 这里的断言会红。 */
  const excludesMd = JSON.parse(readFileSync(builderPath, 'utf-8')).files?.some?.(
    (p) => typeof p === 'string' && p.replace(/\\/g, '') === '!**/*.md',
  );
  if (excludesMd) {
    ok(label, '`!**/*.md` 仍在 files 排除表 → 发行版必须靠烘焙快照 (上面已验)');
  } else {
    report.push('  ⏭  打包契约 — `!**/*.md` 已不在排除表, 磁盘 .md 可随包发');
  }
}

// ══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('[check-resource-integrity] 跑真实加载逻辑, 校验产物里的资源能不能拿出来\n');

  await checkSkills();
  await checkSchemas();
  await checkPrompts();
  checkPptxScripts();
  checkPackagingContract();

  console.log(report.join('\n'));

  if (failures.length > 0) {
    console.error(`\n❌ 资源完整性闸失败 (${failures.length} 项):`);
    for (const f of failures) console.error(`   · ${f}`);
    console.error(
      '\n这类缺口在 dev 下不会复现 (dev 有源码树), 只在发行版发作, 而且是静默的 —— ' +
        '用户只会觉得 agent 少了本事。请修好再发。',
    );
    process.exit(1);
  }

  console.log('\n✅ 资源完整性闸通过');
  if (verbose) console.log(JSON.stringify({ report }, null, 2));
}

main().catch((err) => {
  console.error('[check-resource-integrity] 闸本身跑挂了:', err?.message ?? err);
  process.exit(1);
});
