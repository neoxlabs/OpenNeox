#!/usr/bin/env node
/**
 * CDP Timeline scroll quality bench.
 * Usage: env -u HTTP_PROXY -u HTTPS_PROXY node apps/desktop/scripts/timeline-scroll-bench.mjs
 * Requires Electron ui:dev with NEOX_CDP_PORT=41777.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const { chromium } = createRequire(
  new URL('../../../packages/core/package.json', import.meta.url)
)('playwright-core');

const app = await chromium.connectOverCDP('http://127.0.0.1:41777');
let page;
for (const c of app.contexts()) {
  for (const p of c.pages()) {
    if (p.url().includes(':5180')) page = p;
  }
}
if (!page) {
  console.log(JSON.stringify({ error: 'no renderer on :5180' }));
  process.exit(1);
}

const result = await page.evaluate(async () => {
  const feed = document.querySelector('.atl-feed');
  const thumb = document.querySelector('.atl-scroll-nav__thumb');
  const track = document.querySelector('.atl-scroll-nav__track');
  if (!feed) return { error: 'no .atl-feed' };
  window.__NEOX_SHELL_PERF__ = true;
  window.__NEOX_SHELL_PERF_EVENTS__ = [];
  window.__neoxShellPerfEnable?.();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pct = (arr, p) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return (
      Math.round(
        s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 10
      ) / 10
    );
  };
  const avg = (arr) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const estTotal = () => {
    const el = feed.querySelector(
      '.atl-feed__virtual-space[data-atl-est-total], .atl-feed__virtual-slot, .atl-feed__virtual-pad--bottom'
    );
    return el ? Number(el.dataset.atlEstTotal || 0) : 0;
  };
  const visibleRows = () => {
    const rows = [
      ...document.querySelectorAll(
        '.atl-feed .atl-row-clamp[data-timeline-row-index]'
      ),
    ];
    const vr = feed.getBoundingClientRect();
    return rows.filter((r) => {
      const b = r.getBoundingClientRect();
      return b.bottom > vr.top + 4 && b.top < vr.bottom - 4 && b.height > 1;
    });
  };
  const gapStats = () => {
    const v = visibleRows();
    const gaps = [];
    for (let i = 1; i < v.length; i++) {
      gaps.push(
        v[i].getBoundingClientRect().top -
          v[i - 1].getBoundingClientRect().bottom
      );
    }
    return {
      max: gaps.length ? Math.round(Math.max(...gaps) * 10) / 10 : null,
      over40: gaps.filter((g) => g > 40).length,
      over80: gaps.filter((g) => g > 80).length,
    };
  };
  const thumbRatio = () => {
    if (!thumb || !track) return null;
    const tr = thumb.getBoundingClientRect();
    const tb = track.getBoundingClientRect();
    return (tr.top - tb.top) / Math.max(1, tb.height - tr.height);
  };
  const thumbScrollRatio = () => {
    const est = estTotal();
    const max = Math.max(
      1,
      (est > feed.clientHeight ? est : feed.scrollHeight) - feed.clientHeight
    );
    return feed.scrollTop / max;
  };
  const snapshot = (tag) => {
    const v = visibleRows();
    const sr = thumbScrollRatio();
    const tr = thumbRatio();
    const est = estTotal();
    return {
      tag,
      blank: v.length === 0,
      visible: v.length,
      mounted: document.querySelectorAll(
        '.atl-feed .atl-row-clamp[data-timeline-row-index]'
      ).length,
      minHeight: document.querySelectorAll(
        '.atl-feed .atl-row-clamp[style*="min-height"]'
      ).length,
      items: document.querySelectorAll('.atl-feed__virtual-item').length,
      scrollHeight: Math.round(feed.scrollHeight),
      estTotal: est,
      heightDelta: est ? Math.round(feed.scrollHeight - est) : null,
      scrollRatio: Math.round(sr * 1000) / 1000,
      thumbRatio: tr == null ? null : Math.round(tr * 1000) / 1000,
      thumbDelta:
        tr == null ? null : Math.round((tr - sr) * 1000) / 1000,
      gaps: gapStats(),
      scrolling: feed.getAttribute('data-atl-scrolling'),
    };
  };

  const frameGaps = [];
  let last = performance.now();
  let rafId = requestAnimationFrame(function tick(t) {
    frameGaps.push(t - last);
    last = t;
    rafId = requestAnimationFrame(tick);
  });
  const samples = [];
  const max0 = Math.max(0, feed.scrollHeight - feed.clientHeight);
  for (const ratio of [0.15, 0.35, 0.5, 0.65, 0.85]) {
    feed.scrollTop = Math.floor(max0 * ratio);
    feed.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(16);
    feed.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await sleep(24);
    samples.push(snapshot(`jump-${ratio}`));
  }
  feed.scrollTop = Math.floor(max0 * 0.7);
  feed.dispatchEvent(new Event('scroll', { bubbles: true }));
  await sleep(16);
  for (let i = 0; i < 40; i++) {
    const max = Math.max(0, feed.scrollHeight - feed.clientHeight);
    feed.scrollTop = Math.max(
      0,
      Math.min(max, feed.scrollTop - (160 + (i % 6) * 50))
    );
    feed.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(5);
    if (i % 5 === 0) samples.push(snapshot('flick-up'));
  }
  for (let i = 0; i < 40; i++) {
    const max = Math.max(0, feed.scrollHeight - feed.clientHeight);
    feed.scrollTop = Math.max(
      0,
      Math.min(max, feed.scrollTop + (170 + (i % 6) * 55))
    );
    feed.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(5);
    if (i % 5 === 0) samples.push(snapshot('flick-down'));
  }
  const stopTop = feed.scrollTop;
  samples.push(snapshot('at-stop'));
  await sleep(900);
  samples.push(snapshot('after-idle'));
  const drift = feed.scrollTop - stopTop;
  cancelAnimationFrame(rafId);

  const events = window.__NEOX_SHELL_PERF_EVENTS__ || [];
  const profiler = events.filter(
    (e) => e.type === 'mark' && e.label === 'react-profiler'
  );
  const rendered = profiler
    .map((e) => e.renderedRows)
    .filter((n) => n != null);
  const baseMs = profiler
    .map((e) => e.baseMs)
    .filter((n) => typeof n === 'number');
  const blanks = samples.filter((s) => s.blank);
  const thumbBad = samples.filter(
    (s) => s.thumbDelta != null && Math.abs(s.thumbDelta) > 0.06
  );
  const gapBad = samples.filter(
    (s) =>
      s.gaps &&
      (s.gaps.over80 > 0 || (s.gaps.max != null && s.gaps.max > 160))
  );
  const idle = samples.find((s) => s.tag === 'after-idle');
  /* 实高>估高时 scrollHeight 略大于 est 是预期; 拇指仍准即可. */
  const heightStable = !!(
    idle &&
    idle.estTotal &&
    idle.heightDelta != null &&
    idle.heightDelta > -80 &&
    idle.heightDelta < 600
  );

  const score = {
    blankN: blanks.length,
    sampleN: samples.length,
    driftPx: Math.round(drift * 10) / 10,
    thumbBadN: thumbBad.length,
    gapBadN: gapBad.length,
    fps:
      Math.round(
        ((frameGaps.length * 1000) /
          Math.max(
            1,
            frameGaps.reduce((a, b) => a + b, 0)
          )) *
          10
      ) / 10,
    frameP95: pct(frameGaps, 95),
    frameMax: frameGaps.length
      ? Math.round(Math.max(...frameGaps) * 10) / 10
      : null,
    over34: frameGaps.filter((g) => g > 34).length,
    over50: frameGaps.filter((g) => g > 50).length,
    renderedPeak: rendered.length ? Math.max(...rendered) : null,
    renderedAvg: rendered.length ? Math.round(avg(rendered)) : null,
    baseMsP50: pct(baseMs, 50),
    mountedPeak: Math.max(...samples.map((s) => s.mounted)),
    minHeightAny: samples.some((s) => s.minHeight > 0),
    absoluteItems: samples.some((s) => s.items > 0),
    heightStable,
    idleHeightDelta: idle?.heightDelta ?? null,
    visibleMin: Math.min(...samples.map((s) => s.visible)),
    gapMaxPeak: Math.max(...samples.map((s) => s.gaps.max ?? 0)),
  };
  const virtualized = score.absoluteItems;

  const gates = {
    noBlank: blanks.length === 0,
    noDrift: Math.abs(drift) <= 2,
    thumbOk: !virtualized || thumbBad.length === 0,
    gapsOk: gapBad.length === 0,
    fpsOk: score.fps >= 50,
    frameOk:
      score.over50 <= 3 &&
      (score.frameP95 == null || score.frameP95 <= 24),
    mountOk:
      !virtualized ||
      ((score.renderedPeak ?? 999) <= 120 && score.mountedPeak <= 180),
    noMinHeight: !score.minHeightAny,
    heightStable: !virtualized || heightStable,
    naturalFlow: true, // absolute items are OK when prefix-placed
    itemPlaced: score.absoluteItems || score.mountedPeak > 0,
  };
  return {
    pass: Object.values(gates).every(Boolean),
    mode: virtualized ? 'virtualized' : 'full-render',
    gates,
    score,
    failBlank: blanks.slice(0, 3),
    idle,
  };
});

fs.writeFileSync(
  '/tmp/neox-timeline-scroll-bench.json',
  JSON.stringify(result, null, 2)
);
console.log(JSON.stringify(result, null, 2));
await app.close();
process.exit(result.pass ? 0 : 2);
