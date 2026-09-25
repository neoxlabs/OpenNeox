/**
 * 团队工具按需加载的冒烟: 用团队工作台的原样指令开团, 看 team_run 能否点名解锁、
 * 后续 team_* 是否带着 schema 正常调用 (没有 "not available" / 参数错)。
 *   用法: node team-smoke.mjs [--model id]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TASKS, ROOT } from './tasks.mjs';

const { chromium } = createRequire('/Users/exampleuser/AI/OpenNeox/packages/core/package.json')('playwright-core');
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const MODEL = argOf('--model', 'opencode-zen:deepseek-flash');
const RESTORE_WS = '/Users/exampleuser/AI/MK/neox-bench';
const RESTORE_SESSION = 'session-1789111819654-cb78e0a3fc409';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const goal = '给宠物系统加「成就分享」: 后端生成分享卡片接口、前端分享页、配套测试';
const prompt = `${goal}\n\n<neox-directive>先调 team_run({ goal }) 进入团队规划态: 递归拆需求树 → 定编制 → 每人领取, 三步走完停下来把方案讲给用户, 等他拍板再调 team_execute({confirm:true}) 开工。规划过程留在这个会话里, 别派子 agent。</neox-directive>`;

const app = await chromium.connectOverCDP('http://127.0.0.1:41777');
let page; for (const c of app.contexts()) for (const p of c.pages()) if (p.url().includes(':5180')) page = p;
const ORIG_MODEL = await page.evaluate(() => window.__neoxTestSelectedModel?.());
const dir = path.join(ROOT, 'work', 'team-smoke');
try {
  TASKS.find((t) => t.id === 'cece-feature').setup(dir);
  await page.evaluate((p) => window.neox.setWorkspace(p), dir); await sleep(1500);
  await page.getByText('New chat', { exact: true }).first().click(); await sleep(1500);
  await page.evaluate((m) => window.__neoxTestPickModel?.(m), MODEL);
  await page.fill('.atl-composer textarea', prompt);
  const t0 = Date.now();
  await page.keyboard.press('Enter');
  let sid = null;
  for (let i = 0; i < 40 && !sid; i++) { await sleep(200); sid = await page.evaluate(() => window.__neoxTestActiveSession?.()); }
  await page.evaluate(({ id, m }) => window.neox.setApprovalMode(id, 'dangerous', m, { acknowledgeNoApproval: true, acknowledgeHighRiskExecution: true }), { id: sid, m: MODEL }).catch(() => {});
  let seen = false; let quiet = 0;
  while (Date.now() - t0 < 6 * 60 * 1000) {
    const busy = await page.evaluate(() => !!document.querySelector('.atl-composer__stop'));
    if (busy) { seen = true; quiet = 0; } else if (seen) { quiet ||= Date.now(); if (Date.now() - quiet > 8000) break; }
    await sleep(1000);
  }
  if (await page.evaluate(() => !!document.querySelector('.atl-composer__stop'))) await page.click('.atl-composer__stop').catch(() => {});
  /* 事件: 找这个工作区的 action log */
  const wsRoot = path.join(process.env.HOME, '.neox', 'workspaces');
  const evDir = fs.readdirSync(wsRoot).filter((d) => d.startsWith('team-smoke-')).map((d) => path.join(wsRoot, d, 'events'))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const ev = [];
  for (const f of fs.readdirSync(evDir)) for (const l of fs.readFileSync(path.join(evDir, f), 'utf8').split('\n')) {
    if (!l.trim()) continue; const e = JSON.parse(l); if (e.ts >= t0 - 1000 && (!e.sessionId || e.sessionId === sid)) ev.push(e);
  }
  const args = new Map();
  for (const e of ev.sort((a, b) => a.ts - b.ts)) {
    if (e.type === 'tool_call_start') args.set(e.data.toolId, e.data.argsPreview);
    if (e.type === 'tool_call_end') console.log(`${e.data.success === false ? '✗' : '✓'} ${e.data.name.padEnd(20)} ${(args.get(e.data.toolId) || '').slice(0, 90)} => ${String(e.data.outputPreview || '').replace(/\n/g, ' ').slice(0, 140)}`);
  }
  console.log(`sid ${sid} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
} finally {
  await page.evaluate((p) => window.neox.setWorkspace(p), RESTORE_WS).catch(() => {}); await sleep(1200);
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent('neox:select-session', { detail: { sessionId: id } })), RESTORE_SESSION).catch(() => {});
  await sleep(800);
  if (ORIG_MODEL) await page.evaluate((m) => window.__neoxTestPickModel?.(m), ORIG_MODEL).catch(() => {});
  await app.close().catch(() => {});
}
