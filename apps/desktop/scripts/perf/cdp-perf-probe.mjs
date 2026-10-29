#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg.startsWith('--')) {
    const key = arg.slice(2);
    const next = process.argv[i + 1];
    if (next && !next.startsWith('--')) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, 'true');
    }
  }
}

const port = Number(args.get('port') ?? 42481);
const urlMatch = String(args.get('url') ?? '127.0.0.1:5180');
const durationMs = Number(args.get('duration') ?? 5000);
const mode = String(args.get('mode') ?? 'observe'); // observe | resize | scroll
const outDir = resolve(String(args.get('out') ?? 'tmp/perf'));
mkdirSync(outDir, { recursive: true });

const fetchJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
};

const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
const target = targets.find((t) => t.type === 'page' && t.url.includes(urlMatch) && !t.url.startsWith('devtools://') && !t.url.includes('/pet.html'));
if (!target) {
  console.error(`[cdp-perf-probe] No page target matching ${urlMatch} on port ${port}`);
  console.error(JSON.stringify(targets.map((t) => ({ type: t.type, title: t.title, url: t.url })), null, 2));
  process.exit(2);
}

let seq = 0;
const pending = new Map();
const events = [];
const ws = new WebSocket(target.webSocketDebuggerUrl);
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject, method });
  ws.send(JSON.stringify({ id, method, params }));
});

const waitOpen = () => new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

const unpackRemote = (value) => {
  if (!value) return undefined;
  if ('value' in value) return value.value;
  if (value.unserializableValue) return value.unserializableValue;
  if (value.description) return value.description;
  return value;
};

ws.addEventListener('message', (message) => {
  const data = JSON.parse(message.data.toString());
  if (data.id) {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.error) p.reject(new Error(`${p.method}: ${data.error.message}`));
    else p.resolve(data.result);
    return;
  }
  if (data.method === 'Runtime.consoleAPICalled') {
    const text = data.params.args.map(unpackRemote).map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
    const item = { kind: 'console', type: data.params.type, ts: Date.now(), text, raw: data.params.args.map(unpackRemote) };
    events.push(item);
    if (text.includes('[ShellPerf]') || text.includes('[Violation]') || text.includes('TimelineJank')) {
      console.log(text);
    }
  } else if (data.method === 'Log.entryAdded') {
    const item = { kind: 'log', ts: Date.now(), entry: data.params.entry };
    events.push(item);
    const text = data.params.entry?.text ?? '';
    if (text.includes('[ShellPerf]') || text.includes('[Violation]') || text.includes('TimelineJank')) console.log(text);
  } else if (data.method === 'Inspector.targetCrashed') {
    events.push({ kind: 'crash', ts: Date.now(), params: data.params });
  }
});

await waitOpen();
await send('Runtime.enable');
await send('Log.enable').catch(() => {});
await send('Performance.enable').catch(() => {});

const evaluate = async (expression, opts = {}) => {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
    ...opts,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
  return result.result?.value;
};

await evaluate(`(() => {
  if (!window.__neoxShellPerfEnable) return { ok:false, reason:'shellPerf helper missing' };
  window.__neoxShellPerfEnable();
  return window.__neoxPerfSnapshot ? window.__neoxPerfSnapshot({ probe:'cdp-before' }) : { ok:true };
})()`);

const snapshotBefore = await evaluate(`(() => ({
  title: document.title,
  href: location.href,
  shellMode: document.querySelector('.neox-shell')?.getAttribute('data-mode'),
  timelineRoots: document.querySelectorAll('.agent-timeline').length,
  timelineFeeds: document.querySelectorAll('.atl-feed').length,
  rows: document.querySelectorAll('.atl-row-clamp').length,
  virtualRows: document.querySelectorAll('.atl-feed .atl-row-clamp[data-timeline-row-index]').length,
  feed: (() => { const el = document.querySelector('.atl-feed'); return el ? { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } : null })(),
  viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio }
}))()`);
console.log('[cdp-perf-probe] target', { title: target.title, url: target.url, mode, durationMs });
console.log('[cdp-perf-probe] before', snapshotBefore);

await evaluate(`window.__neoxPerfStart && window.__neoxPerfStart(${JSON.stringify(`cdp-${mode}`)}, ${JSON.stringify({ source: 'cdp-perf-probe', durationMs })})`);

if (mode === 'scroll') {
  await evaluate(`(async () => {
    const el = document.querySelector('.atl-feed');
    if (!el) return { ok:false, reason:'no .atl-feed' };
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    const start = performance.now();
    const duration = ${durationMs};
    return await new Promise((resolve) => {
      const tick = () => {
        const p = Math.min(1, (performance.now() - start) / duration);
        el.scrollTop = max * (0.5 - Math.cos(p * Math.PI * 2) / 2);
        if (p < 1) requestAnimationFrame(tick);
        else resolve({ ok:true, scrollTop: el.scrollTop, max });
      };
      requestAnimationFrame(tick);
    });
  })()`, { timeout: durationMs + 3000 });
} else if (mode === 'resize') {
  // Browser window resize: use Browser domain when available. Fallback to viewport-ish visual viewport churn via body var.
  try {
    const win = await send('Browser.getWindowForTarget', { targetId: target.id });
    const { windowId, bounds } = win;
    const baseW = bounds.width || 1280;
    const baseH = bounds.height || 800;
    const steps = Math.max(20, Math.round(durationMs / 80));
    for (let i = 0; i < steps; i += 1) {
      const p = i / Math.max(1, steps - 1);
      const w = Math.round(baseW - 180 + Math.sin(p * Math.PI * 4) * 160);
      const h = Math.round(baseH - 90 + Math.cos(p * Math.PI * 3) * 70);
      await send('Browser.setWindowBounds', { windowId, bounds: { width: Math.max(900, w), height: Math.max(640, h) } });
      await new Promise((r) => setTimeout(r, Math.max(16, Math.round(durationMs / steps))));
    }
    await send('Browser.setWindowBounds', { windowId, bounds: { width: baseW, height: baseH } });
  } catch (e) {
    console.warn('[cdp-perf-probe] Browser resize unavailable, fallback observe:', e.message);
    await new Promise((r) => setTimeout(r, durationMs));
  }
} else {
  await new Promise((r) => setTimeout(r, durationMs));
}

await evaluate(`window.__neoxPerfStop && window.__neoxPerfStop(${JSON.stringify(`cdp-${mode}-done`)}, ${JSON.stringify({ source: 'cdp-perf-probe' })})`);
const snapshotAfter = await evaluate(`window.__neoxPerfSnapshot ? window.__neoxPerfSnapshot({ probe:'cdp-after' }) : null`);
const perfMetrics = await send('Performance.getMetrics').catch(() => null);

await new Promise((r) => setTimeout(r, 500));
const summaries = events.filter((e) => {
  const text = e.text || e.entry?.text || '';
  return text.includes('fps-summary') || text.includes('long-task') || text.includes('react-profiler') || text.includes('raf-gap');
});
const artifact = {
  createdAt: new Date().toISOString(),
  port,
  target: { id: target.id, title: target.title, url: target.url },
  mode,
  durationMs,
  snapshotBefore,
  snapshotAfter,
  perfMetrics,
  summaries,
  events,
};
const file = resolve(outDir, `cdp-perf-${mode}-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(artifact, null, 2));
console.log('[cdp-perf-probe] wrote', file);
ws.close();
