/**
 * 桌面端跑分器 —— 驱动正在运行的 Neox dev 实例 (CDP 41777), 一次一个任务, 串行。
 *
 *   每一轮: 重建工作目录 → 切工作区 → 新会话 → 选模型 (写进会话) → 本会话审批=dangerous
 *          → 发 prompt → 等真正结束 (停止按钮消失且持续 8s) → 拿回答 → verify → 存原始事件
 *
 *   原始事件 (action log) 每轮单独存 results/events/<runId>.jsonl, 指标由 analyze.mjs 从原始数据算,
 *   换口径不用重跑。
 *
 *   用法: node desktop-run.mjs [--tasks a,b] [--models id1,id2] [--reps N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
/* --suite v2 → tasks-v2.mjs (聪明/方便那一套); 默认 tasks.mjs */
const SUITE = await import(argOf('--suite', '') === 'v2' ? './tasks-v2.mjs' : './tasks.mjs');
const { TASKS, ROOT } = SUITE;
/* v2 的工作目录在跑分仓库外 (见 tasks-v2.mjs WORK 注释: agent 翻上级目录读到了判分脚本) */
const WORK = SUITE.WORK || path.join(ROOT, 'work');

const { chromium } = createRequire('/Users/exampleuser/AI/OpenNeox/packages/core/package.json')('playwright-core');
const ONLY = argOf('--tasks', '') ? argOf('--tasks').split(',') : null;
const MODELS = argOf('--models', 'opencode-zen:deepseek-flash,opencode-zen:mimo-v2.5').split(',');
const REPS = Number(argOf('--reps', '1'));
const TIMEOUT_MS = Number(argOf('--timeout', String(8 * 60 * 1000)));
/* 批次标签: A/B 两批必须分开统计 (analyze.mjs --label) */
const LABEL = argOf('--label', 'unlabeled');
const RESTORE_WS = '/Users/exampleuser/AI/MK/neox-bench';
const RESTORE_SESSION = 'session-1789111819654-cb78e0a3fc409';

const RES = path.join(ROOT, 'results');
fs.mkdirSync(path.join(RES, 'events'), { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await chromium.connectOverCDP('http://127.0.0.1:41777');
let page; for (const c of app.contexts()) for (const p of c.pages()) if (p.url().includes(':5180')) page = p;
const busy = () => page.evaluate(() => !!document.querySelector('.atl-composer__stop'));
const ORIG_MODEL = await page.evaluate(() => window.__neoxTestSelectedModel?.());

/** 这个工作目录对应的 action log 目录: ~/.neox/workspaces/<basename>-<hash>, 取最新的 */
function eventsDirFor(dir) {
  const root = path.join(process.env.HOME, '.neox', 'workspaces');
  const base = path.basename(dir);
  const cands = fs.readdirSync(root).filter((d) => d.startsWith(base + '-'))
    .map((d) => ({ d, m: fs.statSync(path.join(root, d)).mtimeMs })).sort((a, b) => b.m - a.m);
  return cands.length ? path.join(root, cands[0].d, 'events') : null;
}
function collectEvents(dir, sid, from, to) {
  const ev = eventsDirFor(dir); if (!ev || !fs.existsSync(ev)) return [];
  const out = [];
  for (const f of fs.readdirSync(ev).filter((x) => /^events-.*\.jsonl$/.test(x))) {
    for (const line of fs.readFileSync(path.join(ev, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.ts < from || e.ts > to) continue;
      if (sid && e.sessionId && e.sessionId !== sid) continue;
      out.push(e);
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

async function runOnce(task, model, rep) {
  const dir = path.join(WORK, `${task.id}__r${rep}_${Date.now()}`);
  task.setup(dir);
  await page.evaluate((p) => window.neox.setWorkspace(p), dir);
  await sleep(1500);
  await page.getByText('New chat', { exact: true }).first().click();
  await sleep(1500);
  /* 新会话是懒创建的: 发第一条消息才落库, 所以模型在发送前选 (新会话继承当前选择),
   * 会话 id / 审批 / 工作区核对都放到发送之后。 */
  const picked = await page.evaluate((m) => window.__neoxTestPickModel?.(m), model);
  if (!picked?.id || picked.id !== model) return { error: `选模型失败 ${JSON.stringify(picked)}` };
  await page.fill('.atl-composer textarea', task.prompt);
  const t0 = Date.now();
  await page.keyboard.press('Enter');
  let sid = null;
  for (let i = 0; i < 40 && !sid; i++) { await sleep(200); sid = await page.evaluate(() => window.__neoxTestActiveSession?.()); }
  if (!sid) return { error: '发送后 8s 内没有出现会话' };
  await page.evaluate(({ id, m }) => window.neox.setApprovalMode(id, 'dangerous', m, { acknowledgeNoApproval: true, acknowledgeHighRiskExecution: true }), { id: sid, m: model }).catch(() => {});
  let seen = false; let quietSince = 0; let timedOut = false; let autoApproved = 0;
  for (;;) {
    /* 万一仍弹出审批 (设审批前模型已经发出了第一个工具调用), 点允许 —— 基准不考审批 */
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('[class*="approv"] button, [class*="dangerous"] button, [class*="permission"] button')]
        .find((b) => /^(允许|批准|同意|运行|Allow|Approve|Run)/.test((b.textContent || '').trim()) && b.offsetParent);
      if (btn) { btn.click(); return true; }
      return false;
    }).catch(() => false);
    if (clicked) autoApproved++;
    const b = await busy();
    if (b) { seen = true; quietSince = 0; }
    else if (seen) { quietSince ||= Date.now(); if (Date.now() - quietSince > 8000) break; }
    else if (Date.now() - t0 > 20000) break;   /* 20s 都没开始跑 = 没发出去 */
    if (Date.now() - t0 > TIMEOUT_MS) { timedOut = true; await page.click('.atl-composer__stop').catch(() => {}); await sleep(3000); break; }
    await sleep(500);
  }
  const t1 = Date.now();
  await page.evaluate(() => { document.querySelector('.atl-composer__stop')?.click(); }).catch(() => {});
  for (let i = 0; i < 12 && await busy(); i++) await sleep(500);
  await sleep(1500);
  /* sessionUsage 才是这一轮的真实账 (请求数 / 输入 / 缓存命中 / 输出 / 按来源拆分)。
   * run_result.totalTokens 只是**最后一次请求**的用量 —— 第一版拿它当整轮 token, 低估 7 倍。 */
  const sess = await page.evaluate(async (id) => { const x = await window.neox.getSession(id); const s = x?.session ?? x; return { tl: s?.timeline ?? [], ws: s?.workspacePath, model: s?.modelId, usage: s?.sessionUsage ?? null }; }, sid);
  const answers = sess.tl.filter((e) => e.type === 'assistant_message').map((e) => String(e.detail || ''));
  const answer = answers.join('\n');
  const events = collectEvents(dir, sid, t0 - 1000, t1 + 1500);
  const foreign = collectEvents(dir, null, t0 - 1000, t1 + 1500)
    .filter((e) => e.type === 'tool_call_start' && e.sessionId && e.sessionId !== sid);
  const foreignWrites = foreign.filter((e) => /write_file|edit|delete_file|rename_file/.test(e.data?.name || '')).length;
  const askedUser = events.some((e) => e.type === 'tool_call_start' && e.data?.name === 'ask_user');
  const v = await task.verify(dir, answer + (askedUser ? '\n[ASKED_USER]' : ''));
  const runId = `${task.id}__${model.replace(/[^a-z0-9.-]/gi, '_')}__r${rep}__${t0}`;
  fs.writeFileSync(path.join(RES, 'events', runId + '.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
  const rr = events.filter((e) => e.type === 'run_result');
  const rec = {
    runId, label: LABEL, task: task.id, kind: task.kind, model, rep, sid, ok: v.ok, why: v.why || null, timedOut, started: seen,
    /* 核对这一轮真的跑在该跑的地方: 工作区 / 模型 (上一版就栽过"以为选了 A 其实跑的 B") */
    wsOk: sess.ws === dir, modelOk: sess.model === model, sessionModel: sess.model, autoApproved,
    foreignActions: foreign.length, foreignWrites,
    usage: sess.usage,
    wallMs: t1 - t0, iterations: rr.reduce((n, e) => n + Number(e.data?.iterations ?? 0), 0),
    tokens: rr.reduce((n, e) => n + Number(e.data?.totalTokens ?? 0), 0),
    toolCalls: events.filter((e) => e.type === 'tool_call_end').length, events: events.length,
    answerTail: answer.replace(/\s+/g, ' ').slice(-200),
  };
  fs.appendFileSync(path.join(RES, 'desktop-runs.jsonl'), JSON.stringify(rec) + '\n');
  return rec;
}

const tasks = ONLY ? TASKS.filter((t) => ONLY.includes(t.id)) : TASKS;
try {
  for (let rep = 1; rep <= REPS; rep++) {
    for (const model of MODELS) {
      for (const task of tasks) {
        const r = await runOnce(task, model, rep).catch((e) => ({ error: e.message.split('\n')[0] }));
        if (r.error) log(`✗ ${task.id} ${model} r${rep} 跑分器错误: ${r.error}`);
        else log(`${r.ok ? '✓' : '✗'} ${task.id.padEnd(14)} ${model.padEnd(28)} r${rep} ${(r.wallMs / 1000).toFixed(1)}s 往返${r.iterations} 工具${r.toolCalls} ${r.tokens}tok ${r.why || ''}${r.timedOut ? ' [超时]' : ''}`);
      }
    }
  }
} finally {
  /* 把用户的工作区和会话还回去 */
  await page.evaluate((p) => window.neox.setWorkspace(p), RESTORE_WS).catch(() => {});
  await sleep(1200);
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent('neox:select-session', { detail: { sessionId: id } })), RESTORE_SESSION).catch(() => {});
  await sleep(800);
  if (ORIG_MODEL) await page.evaluate((m) => window.__neoxTestPickModel?.(m), ORIG_MODEL).catch(() => {});
  log('restored', await page.evaluate(() => window.__neoxTestActiveSession?.()).catch(() => '?'));
  await app.close().catch(() => {});
}
