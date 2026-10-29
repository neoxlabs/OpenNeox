#!/usr/bin/env node
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(path.join(root, 'packages/core/package.json'))('playwright-core');

let args = process.argv.slice(2);
let port = Number(process.env.APP_UI_PORT || 41799);
if (args[0] === '--port') { port = Number(args[1]); args = args.slice(2); }
if (!args.length) { console.error('用法见文件头注释: node scripts/app-ui.mjs click 设置 :: shot /tmp/a.png'); process.exit(2); }

const steps = [];
let cur = [];
for (const a of args) { if (a === '::') { if (cur.length) steps.push(cur); cur = []; } else cur.push(a); }
if (cur.length) steps.push(cur);

const app = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch((e) => {
  console.error(`连不上 127.0.0.1:${port} —— dev 实例起了吗? (${e.message.split('\n')[0]})`);
  process.exit(1);
});
let page;
for (const c of app.contexts()) for (const p of c.pages()) {
  const u = p.url();
  /* vite 端口不一定是 5180 —— 隔离实例常另起一个 (如 5192), 所以认任意本地端口。 */
  if (/^http:\/\/127\.0\.0\.1:\d+|index\.html/.test(u) && !/overlay|pet|float|call\.html/.test(u)) page = p;
}
if (!page) { console.error('没找到主窗口 renderer 页'); process.exit(1); }

/** 文字优先 (精确、可见), 其次 css */
async function locate(target) {
  const byText = page.getByText(target, { exact: true }).locator('visible=true');
  if (await byText.count()) return byText.first();
  try {
    const byCss = page.locator(target).locator('visible=true');
    if (await byCss.count()) return byCss.first();
  } catch { /* 不是合法 css */ }
  const loose = page.getByText(target).locator('visible=true');
  if (await loose.count()) return loose.first();
  return null;
}

/** 点不动时说清楚是谁挡住了中心点 */
async function whoCovers(loc) {
  return loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const desc = (n) => n ? `${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}${n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).slice(0, 3).join('.') : ''}` : 'null';
    return { center: [Math.round(x), Math.round(y)], hit: desc(hit), self: hit === el || el.contains(hit) };
  });
}

const out = (label, v) => console.log(`[${label}] ${typeof v === 'string' ? v : JSON.stringify(v)}`);

for (const [cmd, ...rest] of steps) {
  const arg = rest.join(' ');
  try {
    switch (cmd) {
      case 'click': {
        const loc = await locate(arg);
        if (!loc) throw new Error(`找不到可见的「${arg}」`);
        try { await loc.click({ timeout: 4000 }); out('click', `ok ${arg}`); }
        catch (e) { throw new Error(`点不动「${arg}」: ${JSON.stringify(await whoCovers(loc))} (${e.message.split('\n')[0]})`); }
        await page.waitForTimeout(400);
        break;
      }
      case 'dom-click': {
        const loc = await locate(arg);
        if (!loc) throw new Error(`找不到可见的「${arg}」`);
        await loc.evaluate((el) => el.click());
        out('dom-click', `ok ${arg} (DOM 点击, 绕过了命中测试)`);
        await page.waitForTimeout(400);
        break;
      }
      case 'type': {
        const [sel, ...words] = rest;
        await page.locator(sel).locator('visible=true').first().fill(words.join(' '));
        out('type', `ok ${sel}`);
        break;
      }
      case 'key': await page.keyboard.press(arg); out('key', arg); await page.waitForTimeout(300); break;
      case 'wait': {
        const ms = Number(rest[rest.length - 1]);
        const target = Number.isFinite(ms) && rest.length > 1 ? rest.slice(0, -1).join(' ') : arg;
        const deadline = Date.now() + (Number.isFinite(ms) && rest.length > 1 ? ms : 8000);
        let found = null;
        while (Date.now() < deadline && !(found = await locate(target))) await page.waitForTimeout(250);
        if (!found) throw new Error(`等不到「${target}」`);
        out('wait', `ok ${target}`);
        break;
      }
      case 'sleep': await page.waitForTimeout(Number(arg) || 500); break;
      case 'text': {
        const t = await page.evaluate((sel) => (sel ? document.querySelector(sel) : document.body)?.innerText ?? '(无此元素)', arg || null);
        out('text', t.replace(/\n{3,}/g, '\n\n').slice(0, 4000));
        break;
      }
      case 'find': {
        const list = await page.evaluate((sel) => [...document.querySelectorAll(sel)].slice(0, 40).map((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return {
            text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 40),
            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
            visible: r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden',
            centerHitsSelf: !!hit && (hit === el || el.contains(hit)),
          };
        }), arg);
        out('find', `${list.length} 个`);
        for (const x of list) console.log('  ', JSON.stringify(x));
        break;
      }
      case 'eval': {
        const v = await page.evaluate(`(async () => (${arg}))()`);
        out('eval', v === undefined ? 'undefined' : v);
        break;
      }
      case 'shot': await page.screenshot({ path: arg }); out('shot', arg); break;
      case 'size': {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
        /* Electron 没有 Browser.setWindowBounds; window.resizeTo 在 Electron 里会改真窗口。 */
        await page.evaluate(([w, h]) => window.resizeTo(w, h), [Number(rest[0]), Number(rest[1])]);
        await page.waitForTimeout(300);
        out('size', `${rest[0]}x${rest[1]} (窗口)`);
        break;
      }
      default: throw new Error(`不认识的步骤「${cmd}」`);
    }
  } catch (e) {
    console.error(`[失败] ${cmd} ${arg}: ${e.message.split('\n')[0]}`);
    process.exit(1);
  }
}
process.exit(0);
