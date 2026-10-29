#!/usr/bin/env node
/**
 * 桌面端场景回归 —— 一条命令跑完一批「用户真实操作路径」。
 *
 *   node scripts/e2e/desktop/run.mjs                  # 全部 (不调模型)
 *   node scripts/e2e/desktop/run.mjs --with-model     # 加上需要真模型回复的场景
 *   node scripts/e2e/desktop/run.mjs --only boot,modes # 按模块过滤
 *   node scripts/e2e/desktop/run.mjs --list           # 只列场景
 *
 * 做法: 起一个隔离的真实实例 (Electron + vite, 固定端口 5191 / 4511 / 41811,
 * NEOX_HOME_DIRNAME=.neox-e2e), 用 CDP 驱动真实点击, 每个场景断言界面 + 必要时断言磁盘。
 * 失败自动截图到 artifacts/, 结束时打一张结果表并写 JSON (artifacts/report-<runId>.json)。
 *
 * 不调模型的场景不需要网络, 可以在每次合并前跑; 调模型的场景 (--with-model) 走订阅,
 * 用一句话任务, 数量控制在 15 个以内。
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_DIRNAME, PORTS, launchInstance } from './lib/instance.mjs';
import { resetToShell, dismissTour, dismissModeNotice, SEL } from './lib/ui.mjs';
import { bodyText } from './lib/ui.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(HERE, 'artifacts');

/* ---------- 参数 ---------- */
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const WITH_MODEL = flag('with-model');
const LIST_ONLY = flag('list');
const KEEP_HOME = flag('keep-home');
const ONLY = (value('only') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const t0 = Date.now();

/* ---------- 场景模块: 按文件名排序, boot 永远第一 ---------- */
async function loadModules() {
  const files = (await readdir(join(HERE, 'scenarios')))
    .filter((f) => f.endsWith('.mjs'))
    .sort();
  const modules = [];
  for (const file of files) {
    const mod = (await import(join(HERE, 'scenarios', file))).default;
    if (!mod?.scenarios?.length) continue;
    if (ONLY.length && !ONLY.includes(mod.id)) continue;
    modules.push({ file, ...mod });
  }
  /* boot 负责把实例从引导页推进主界面, 必须最先跑 */
  modules.sort((a, b) => (a.id === 'boot' ? -1 : b.id === 'boot' ? 1 : 0));
  return modules;
}

const modules = await loadModules();
const all = modules.flatMap((m) =>
  m.scenarios.map((s) => ({ ...s, module: m.id, moduleTitle: m.title })),
);

if (LIST_ONLY) {
  for (const s of all) {
    const tag = s.model ? ' [需要模型]' : '';
    console.log(`${s.module.padEnd(14)} ${s.id.padEnd(34)} ${s.title}${tag}`);
  }
  console.log(`\n共 ${all.length} 个场景 (${all.filter((s) => s.model).length} 个需要模型)`);
  process.exit(0);
}

/* ---------- 套件自检: 不启 Electron, 守住场景表本身的完整性 ---------- */
if (flag('self-check')) {
  const problems = [];
  const ids = new Set();
  for (const s of all) {
    if (!s.id) problems.push(`场景缺 id: ${JSON.stringify(s.title)}`);
    else if (ids.has(s.id)) problems.push(`场景 id 重复: ${s.id}`);
    else ids.add(s.id);
    if (!s.title) problems.push(`场景 ${s.id} 缺 title`);
    if (typeof s.run !== 'function') problems.push(`场景 ${s.id} 没有 run()`);
  }
  const modelCount = all.filter((s) => s.model).length;
  if (all.length < 40) problems.push(`场景总数 ${all.length} < 40`);
  if (modelCount > 15) problems.push(`需要模型的场景 ${modelCount} > 15`);
  if (modules.length < 5) problems.push(`模块数 ${modules.length} 太少 (应至少 5 个模块文件)`);

  console.log(`套件自检: ${modules.length} 个模块 / ${all.length} 个场景 / ${modelCount} 个需要模型`);
  if (problems.length) {
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
  process.exit(0);
}

await mkdir(ARTIFACTS, { recursive: true });

/* ---------- 单个场景 ---------- */
function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${what} 超时 (${Math.round(ms / 1000)}s)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runScenario(app, scenario, index) {
  const started = Date.now();
  const page = app.page;
  const shotPath = join(ARTIFACTS, `${runId}-${String(index + 1).padStart(2, '0')}-${scenario.id}.png`);

  /* 每场景单独收集未捕获异常: 页面崩了 / 组件抛错都算这个场景失败 */
  const pageErrors = [];
  const onPageError = (e) => pageErrors.push(e?.message ? e.message.split('\n')[0] : String(e));
  page.on('pageerror', onPageError);

  const ctx = {
    page,
    app,
    /** 失败现场截图 */
    shot: async (suffix = '') => {
      const p = suffix
        ? join(ARTIFACTS, `${runId}-${String(index + 1).padStart(2, '0')}-${scenario.id}-${suffix}.png`)
        : shotPath;
      await page.screenshot({ path: p }).catch(() => {});
      return p;
    },
    /** 回到干净主界面 (默认每个场景前都调) */
    reset: async () => resetToShell(page),
  };

  try {
    if (scenario.model && !WITH_MODEL) {
      return { ...scenario, status: 'skip', durationMs: 0, error: '' };
    }
    if (scenario.reset !== false) {
      await page.waitForSelector(SEL.shellReady, { timeout: 30_000 }).catch(() => {});
      await resetToShell(page).catch(async () => {
        await dismissTour(page);
        await dismissModeNotice(page);
      });
    }
    const timeout = scenario.timeoutMs ?? (scenario.model ? 240_000 : 60_000);
    await withTimeout(Promise.resolve(scenario.run(ctx)), timeout, scenario.id);
    if (pageErrors.length > 0) {
      throw new Error(`页面抛出未捕获异常: ${pageErrors.slice(0, 3).join(' / ')}`);
    }
    return { ...scenario, status: 'pass', durationMs: Date.now() - started, error: '' };
  } catch (e) {
    const p = await ctx.shot();
    const tail = await bodyText(page)
      .then((t) => t.trim().slice(-600))
      .catch(() => '');
    return {
      ...scenario,
      status: 'fail',
      durationMs: Date.now() - started,
      error: `${e.message.split('\n')[0]}\n    截图: ${p}\n    页面尾部: ${tail.replace(/\n+/g, ' / ')}`,
    };
  } finally {
    page.off('pageerror', onPageError);
  }
}

/* ---------- 跑 ---------- */
console.log(`\n桌面端场景回归 ${runId}`);
console.log(
  `  实例: ${HOME_DIRNAME}  vite ${PORTS.vite} / server ${PORTS.server} / CDP ${PORTS.cdp}` +
    `${WITH_MODEL ? '  (含模型场景)' : ''}`,
);
console.log(`  场景: ${all.length} 个${WITH_MODEL ? '' : ` (跳过 ${all.filter((s) => s.model).length} 个需要模型的)`}\n`);

let app;
let results = [];
let fatal = '';
try {
  app = await launchInstance({ keepHome: KEEP_HOME });
  let i = 0;
  for (const scenario of all) {
    const res = await runScenario(app, scenario, i++);
    results.push(res);
    const mark = res.status === 'pass' ? '✓' : res.status === 'skip' ? '·' : '✗';
    const dur = res.status === 'skip' ? '' : ` ${(res.durationMs / 1000).toFixed(1)}s`;
    console.log(`  ${mark} [${res.module}] ${res.title}${dur}`);
    if (res.status === 'fail') console.log(`      ${res.error}`);
  }
} catch (e) {
  fatal = e.message;
  console.error(`\n实例起不来: ${e.message}\n`);
} finally {
  await app?.stop().catch(() => {});
}

/* ---------- 结果表 ---------- */
const pass = results.filter((r) => r.status === 'pass');
const fail = results.filter((r) => r.status === 'fail');
const skip = results.filter((r) => r.status === 'skip');
const totalMs = Date.now() - t0;

function pad(s, n) {
  const w = [...String(s)].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
}

console.log(`\n${'─'.repeat(78)}`);
console.log(`结果: 通过 ${pass.length} / 失败 ${fail.length} / 跳过 ${skip.length}  (${(totalMs / 1000).toFixed(1)}s)`);
console.log(`${'─'.repeat(78)}`);
console.log(`  ${pad('结果', 6)}${pad('场景', 40)}${pad('耗时', 8)}模块`);
for (const r of results) {
  const mark = r.status === 'pass' ? '通过' : r.status === 'skip' ? '跳过' : '失败';
  console.log(
    `  ${pad(mark, 6)}${pad(r.title, 40)}${pad(r.status === 'skip' ? '-' : `${(r.durationMs / 1000).toFixed(1)}s`, 8)}${r.module}`,
  );
}
if (fatal) console.log(`\n实例级错误: ${fatal}`);

/* ---------- JSON ---------- */
const report = {
  runId,
  startedAt: new Date(t0).toISOString(),
  durationMs: totalMs,
  withModel: WITH_MODEL,
  instance: { home: HOME_DIRNAME, ports: PORTS },
  totals: { total: all.length, pass: pass.length, fail: fail.length, skip: skip.length },
  fatal: fatal || null,
  results: results.map((r) => ({
    module: r.module,
    id: r.id,
    title: r.title,
    status: r.status,
    durationMs: r.durationMs,
    model: !!r.model,
    error: r.error || null,
  })),
};
const reportPath = join(ARTIFACTS, `report-${runId}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(ARTIFACTS, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nJSON: ${reportPath}`);

process.exit(fatal || fail.length > 0 ? 1 : 0);
