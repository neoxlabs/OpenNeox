import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const RES = path.join(ROOT, 'results');
const { chromium } = createRequire('/Users/exampleuser/AI/OpenNeox/packages/core/package.json')('playwright-core');
const runs = fs.readFileSync(path.join(RES, 'desktop-runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const have = new Set(fs.existsSync(path.join(RES, 'usage.jsonl'))
  ? fs.readFileSync(path.join(RES, 'usage.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).runId) : []);

const app = await chromium.connectOverCDP('http://127.0.0.1:41777');
let page; for (const c of app.contexts()) for (const p of c.pages()) if (p.url().includes(':5180')) page = p;
let n = 0;
for (const r of runs) {
  if (have.has(r.runId) || r.usage) continue;
  const usage = await page.evaluate(async (id) => { const x = await window.neox.getSession(id); return (x?.session ?? x)?.sessionUsage ?? null; }, r.sid);
  fs.appendFileSync(path.join(RES, 'usage.jsonl'), JSON.stringify({ runId: r.runId, usage }) + '\n');
  n++;
}
console.log(`backfilled ${n}`);
await app.close().catch(() => {});
