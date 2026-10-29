#!/usr/bin/env node
/**
 * 滚动掉帧归因 A/B — 同一段滚动，逐个关掉可疑项，看帧率怎么变。
 * 只注入临时 <style>，跑完全部移除，不改任何源码。
 *
 * env -u HTTP_PROXY -u HTTPS_PROXY node apps/desktop/scripts/timeline-scroll-ab.mjs
 */
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../../../packages/core/package.json', import.meta.url))('playwright-core');

const app = await chromium.connectOverCDP('http://127.0.0.1:41777');
let page;
for (const c of app.contexts()) for (const p of c.pages()) if (p.url().includes(':5180')) page = p;
if (!page) { console.log('no renderer'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONDITIONS = [
  { id: 'baseline', css: '' },
  { id: 'contain:layout-style', css: `.atl-feed__virtual-item { contain: layout style !important; }` },
  { id: 'contain:paint-only', css: `.atl-feed__virtual-item { contain: paint !important; }` },
  { id: 'contain:layout-only', css: `.atl-feed__virtual-item { contain: layout !important; }` },
  { id: 'contain:style-only', css: `.atl-feed__virtual-item { contain: style !important; }` },
  { id: 'no-animation-only', css: `.atl-feed * { animation: none !important; }` },
  { id: 'no-transition-only', css: `.atl-feed * { transition: none !important; }` },
  { id: 'no-fresh-anim', css: `.atl-feed .atl-row-clamp--fresh { animation: none !important; transition: none !important; }` },
  { id: 'BEST: layout-style+notrans', css: `.atl-feed__virtual-item { contain: layout style !important; } .atl-feed[data-atl-scrolling="1"] * { transition: none !important; animation: none !important; }` },
];

async function measure() {
  const box = await page.evaluate(() => {
    const f = document.querySelector('.atl-feed');
    const r = f.getBoundingClientRect();
    f.scrollTop = Math.floor((f.scrollHeight - f.clientHeight) * 0.7);
    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
  });
  await page.mouse.move(box.cx, box.cy);
  await sleep(350);
  await page.evaluate(() => {
    const w = window;
    w.__ab = { gaps: [], last: performance.now(), t0: performance.now(), long: [] };
    const tick = (t) => { w.__ab.gaps.push(t - w.__ab.last); w.__ab.last = t; w.__ab.raf = requestAnimationFrame(tick); };
    w.__ab.raf = requestAnimationFrame(tick);
    w.__ab.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__ab.long.push(Math.round(e.duration)); });
    w.__ab.po.observe({ type: 'longtask' });
  });
  /* 统一滚动模式: 上滑 50 次 ×160px, 下滑 50 次 ×160px */
  for (let i = 0; i < 50; i++) { await page.mouse.wheel(0, -160); await sleep(8); }
  for (let i = 0; i < 50; i++) { await page.mouse.wheel(0, 160); await sleep(8); }
  return page.evaluate(() => {
    const w = window;
    cancelAnimationFrame(w.__ab.raf); w.__ab.po.disconnect();
    const gaps = w.__ab.gaps.slice(1);
    const dur = performance.now() - w.__ab.t0;
    const s = [...gaps].sort((a, b) => a - b);
    const pct = (p) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 10) / 10 : null);
    return {
      fps: Math.round((gaps.length / (dur / 1000)) * 10) / 10,
      p95: pct(95), p99: pct(99),
      max: gaps.length ? Math.round(Math.max(...gaps) * 10) / 10 : null,
      droppedPct: gaps.length ? Math.round((gaps.filter((g) => g > 25).length / gaps.length) * 1000) / 10 : null,
      longMs: w.__ab.long.reduce((a, b) => a + b, 0),
    };
  });
}

const results = [];
for (const cond of CONDITIONS) {
  await page.evaluate((c) => {
    document.getElementById('__ab_style')?.remove();
    if (c.css) {
      const el = document.createElement('style');
      el.id = '__ab_style'; el.textContent = c.css;
      document.head.appendChild(el);
    }
  }, cond);
  await sleep(500);
  const r = await measure();
  results.push({ id: cond.id, ...r });
  console.log(`${cond.id.padEnd(20)} fps=${String(r.fps).padStart(5)}  p95=${String(r.p95).padStart(5)}ms  p99=${String(r.p99).padStart(5)}ms  max=${String(r.max).padStart(5)}ms  掉帧=${r.droppedPct}%`);
}
await page.evaluate(() => document.getElementById('__ab_style')?.remove());
console.log('\n临时样式已移除');
await app.close();
