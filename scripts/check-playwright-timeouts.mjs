#!/usr/bin/env node
/**
 * check-playwright-timeouts —— Playwright 的等待型调用必须显式给 timeout (2026-09-09)
 *
 * ─── 为什么上这道闸 ────────────────────────────────────────────────────────────
 *   Playwright 的 locator 方法**默认超时 30 秒**。在 agent 场景里, 一个"读一下 bbox"
 *   的调用有能力卡 30 秒, 而调用方通常连它会等都不知道。
 *
 *   实测代价 (真实站点 trace): `click:20086ms`。查下来是 browser_click 快路径里
 *   第二次 `boundingBox()` 漏了 timeout —— **我为了修慢而写的代码, 自己成了新的慢源**。
 *   同一个文件里另一处 `boundingBox()` 也漏了。
 *
 *   这类洞的共同点: 不报错、测试全绿、只在特定页面上偶发地慢。人 review 抓不住,
 *   所以上闸。
 *
 * 用法: node scripts/check-playwright-timeouts.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIR = new Set(['node_modules', 'dist', 'out', 'build', '.git', 'vendor', '__tests__']);

/** 会等的 locator/page 方法。纯同步的 (count/first/nth) 不在内。 */
const WAITING_METHODS = [
  'click', 'dblclick', 'fill', 'type', 'press', 'hover', 'check', 'uncheck',
  'selectOption', 'setInputFiles', 'boundingBox', 'scrollIntoViewIfNeeded',
  'waitForSelector', 'waitForFunction', 'waitForURL', 'waitForLoadState',
  'innerText', 'textContent', 'inputValue', 'getAttribute', 'screenshot',
];

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p, out); continue; }
    if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/* 只管真正驱动浏览器的那几个目录 —— 全仓扫会有大量同名方法的误报 */
const TARGET_DIRS = [
  'packages/core/src/runtime/browser',
  'packages/test-harness/src/harness',
];

const offenders = [];
for (const rel of TARGET_DIRS) {
  const abs = join(REPO_ROOT, rel);
  try { if (!statSync(abs).isDirectory()) continue; } catch { continue; }
  for (const file of walk(abs)) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (const [i, line] of lines.entries()) {
      if (line.trim().startsWith('*') || line.trim().startsWith('//')) continue;
      for (const m of WAITING_METHODS) {
        /* 匹配 `.method()` —— 空参数 = 用默认 30 秒。
         * 必须带 await: 这些方法全是异步的; 不带 await 的同名调用是别的东西
         * (踩过: `msg.type()` 取 console 消息类型, 被误报成 Playwright 的 type())。 */
        const re = new RegExp(`await\\s[^;]*\\.${m}\\(\\s*\\)`);
        if (re.test(line)) {
          offenders.push({ file: relative(REPO_ROOT, file), line: i + 1, method: m, text: line.trim().slice(0, 110) });
        }
      }
    }
  }
}

if (!offenders.length) {
  console.log('[pw-timeout] ✓ 干净 — 浏览器层没有"用默认 30 秒超时"的等待调用');
  process.exit(0);
}

console.error('\n[pw-timeout] ✗ 这些 Playwright 调用没给 timeout, 会用默认的 **30 秒**:\n');
for (const o of offenders) {
  console.error(`  ${o.file}:${o.line}  .${o.method}()`);
  console.error(`      ${o.text}`);
}
console.error('\n  agent 场景里没有哪个动作值得等 30 秒。显式给一个 (通常 800~5000ms),');
console.error('  等不到就快速失败并把原因回报给模型 —— 那比傻等有用得多。\n');
process.exit(1);
