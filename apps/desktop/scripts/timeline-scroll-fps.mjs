#!/usr/bin/env node
/**
 * Timeline 滚动帧率指标 — 真实滚轮事件走完整输入管线, 不用 scrollTop 赋值.
 *
 * 用法:
 *   env -u HTTP_PROXY -u HTTPS_PROXY node apps/desktop/scripts/timeline-scroll-fps.mjs
 *   加 --label=before / --label=after 便于对拍
 *
 * 需要 Electron ui:dev 且 NEOX_CDP_PORT=41777.
 *
 * 为什么不用 scrollTop 赋值测帧率:
 *   `feed.scrollTop = x` + dispatchEvent 是同步 JS, 帧率测出来是脚本循环的节奏,
 *   跟用户手指/触控板走的合成器输入管线完全不同. 必须用 Input.dispatchMouseEvent
 *   (Playwright mouse.wheel) 才能测到真实的 scroll 帧.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const label = (process.argv.find((a) => a.startsWith('--label=')) || '--label=run').split('=')[1];
const { chromium } = createRequire(new URL('../../../packages/core/package.json', import.meta.url))('playwright-core');

const app = await chromium.connectOverCDP('http://127.0.0.1:41777');
let page;
for (const c of app.contexts()) for (const p of c.pages()) if (p.url().includes(':5180')) page = p;
if (!page) { console.log(JSON.stringify({ error: 'no renderer on :5180' })); process.exit(1); }

/** 在页面内装采样器 */
async function startSampler() {
  await page.evaluate(() => {
    const w = window;
    w.__fps = { gaps: [], long: [], t0: performance.now(), last: performance.now(), raf: 0 };
    const tick = (t) => { w.__fps.gaps.push(t - w.__fps.last); w.__fps.last = t; w.__fps.raf = requestAnimationFrame(tick); };
    w.__fps.raf = requestAnimationFrame(tick);
    w.__fps.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__fps.long.push(Math.round(e.duration)); });
    w.__fps.po.observe({ type: 'longtask' });
  });
}

async function stopSampler() {
  return page.evaluate(() => {
    const w = window;
    cancelAnimationFrame(w.__fps.raf);
    w.__fps.po.disconnect();
    const gaps = w.__fps.gaps.slice(1);
    const dur = performance.now() - w.__fps.t0;
    const s = [...gaps].sort((a, b) => a - b);
    const pct = (p) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 10) / 10 : null);
    return {
      frames: gaps.length,
      durationMs: Math.round(dur),
      fps: Math.round((gaps.length / (dur / 1000)) * 10) / 10,
      frameP50: pct(50), frameP95: pct(95), frameP99: pct(99),
      frameMax: gaps.length ? Math.round(Math.max(...gaps) * 10) / 10 : null,
      /* 掉帧: 间隔 > 25ms 视为丢了至少一帧 (60Hz 理想 16.7) */
      dropped: gaps.filter((g) => g > 25).length,
      droppedPct: gaps.length ? Math.round((gaps.filter((g) => g > 25).length / gaps.length) * 1000) / 10 : null,
      longTasks: w.__fps.long.length,
      longTaskTotalMs: w.__fps.long.reduce((a, b) => a + b, 0),
      longTaskMaxMs: w.__fps.long.length ? Math.max(...w.__fps.long) : 0,
    };
  });
}

const env = await page.evaluate(() => {
  const feed = document.querySelector('.atl-feed');
  if (!feed) return { error: 'no .atl-feed' };
  const r = feed.getBoundingClientRect();
  let entries = null; try { entries = window.__neoxDump?.().length ?? null; } catch { /* ignore */ }
  return {
    entries,
    mountedRows: document.querySelectorAll('.atl-feed .atl-row-clamp').length,
    engine: feed.querySelector('.atl-feed__virtual-space') ? 'tanstack'
      : feed.querySelector('.atl-feed__virtual-pad') ? 'self-made' : 'full',
    scrollHeight: feed.scrollHeight, clientHeight: feed.clientHeight,
    cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
    overflowAnchor: getComputedStyle(feed).overflowAnchor,
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
  };
});
if (env.error) { console.log(JSON.stringify(env)); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await page.mouse.move(env.cx, env.cy);
/* 先滚到中段, 避免起手就撞边界 */
await page.evaluate(() => { const f = document.querySelector('.atl-feed'); f.scrollTop = Math.floor((f.scrollHeight - f.clientHeight) * 0.65); });
await sleep(500);

const phases = {};

/* ── 阶段1: 慢速阅读滚动 (每帧 ~40px, 触控板典型) ── */
await startSampler();
for (let i = 0; i < 90; i++) { await page.mouse.wheel(0, -40); await sleep(8); }
phases.slowUp = await stopSampler();
await sleep(400);

/* ── 阶段2: 快速翻历史 (每帧 ~200px, 甩动) ── */
await startSampler();
for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, -200); await sleep(8); }
phases.fastUp = await stopSampler();
await sleep(400);

/* ── 阶段3: 快速回落 ── */
await startSampler();
for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, 220); await sleep(8); }
phases.fastDown = await stopSampler();
await sleep(600);

/* ── 阶段4: 停手后静止 (测有没有"滑完还在动") ── */
const beforeIdle = await page.evaluate(() => document.querySelector('.atl-feed').scrollTop);
await startSampler();
await sleep(1500);
phases.idle = await stopSampler();
const afterIdle = await page.evaluate(() => document.querySelector('.atl-feed').scrollTop);

const scrollPhases = ['slowUp', 'fastUp', 'fastDown'];
const worst = (k) => Math.max(...scrollPhases.map((p) => phases[p][k] ?? 0));
const minFps = Math.min(...scrollPhases.map((p) => phases[p].fps));

const gates = {
  /* 业界标准: 滚动期不掉到 55fps 以下 */
  fps55: minFps >= 55,
  /* 掉帧率 < 5% */
  dropped5pct: Math.max(...scrollPhases.map((p) => phases[p].droppedPct ?? 0)) < 5,
  /* p95 帧间隔 <= 20ms (60fps 理想 16.7) */
  frameP95: Math.max(...scrollPhases.map((p) => phases[p].frameP95 ?? 0)) <= 20,
  /* 单帧最长 < 50ms (超过就是肉眼可见的顿) */
  frameMax50: worst('frameMax') < 50,
  /* 滚动期 long task 总时长 < 每阶段 15% */
  longTaskOk: scrollPhases.every((p) => phases[p].longTaskTotalMs < phases[p].durationMs * 0.15),
  /* 停手后不漂 */
  noDrift: Math.abs(afterIdle - beforeIdle) <= 2,
};

const out = {
  label,
  pass: Object.values(gates).every(Boolean),
  env,
  gates,
  summary: {
    minFpsDuringScroll: minFps,
    worstFrameP95: Math.max(...scrollPhases.map((p) => phases[p].frameP95 ?? 0)),
    worstFrameMax: worst('frameMax'),
    worstDroppedPct: Math.max(...scrollPhases.map((p) => phases[p].droppedPct ?? 0)),
    idleDriftPx: afterIdle - beforeIdle,
  },
  phases,
};
fs.writeFileSync(`/tmp/neox-timeline-fps-${label}.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await app.close();
process.exit(out.pass ? 0 : 2);
