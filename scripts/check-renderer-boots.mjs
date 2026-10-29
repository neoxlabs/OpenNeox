#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DIST = path.join(REPO, 'apps/cli/dist/ui/renderer');
const PORT = 5197;
/* 模块求值 + React 首次挂载。挂载本身还要等 startup gate (无 preload 时立即过),
 * 10s 足够, 且这道闸在发版链里只跑一次。 */
const WAIT_MS = 10_000;

const require = createRequire(path.join(REPO, 'packages/core/package.json'));

const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.html': 'text/html', '.json': 'application/json', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.gif': 'image/gif',
};

function fail(msg, extra) {
  console.error(`\n❌ [renderer-boots] ${msg}`);
  if (extra) console.error(extra);
  console.error(
    '\n  这意味着**打包版一打开就是一张不动的启动画面** (用户侧: logo + 三点, 无报错无出路)。\n'
    + '  模块求值期的异常最常见的两个来源:\n'
    + '    · TDZ —— 模块顶层调用的函数里用到了声明在它**后面**的 const/let;\n'
    + '    · 循环 import —— A 求值时 B 还没初始化完。\n'
    + '  注意 dev 正常、tsc 绿、单测绿都不能作为反证 (原因见本文件头部)。\n',
  );
  process.exit(1);
}

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  fail(`找不到渲染端产物: ${DIST}/index.html — 先跑 npm run ui:build`);
}

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch (e) {
  fail(`playwright-core 不可用, 无法验证渲染端能否启动: ${e?.message ?? e}`);
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: neox-asset: https:",
  "connect-src 'self'",
].join('; ');

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(DIST, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'Content-Security-Policy': CSP,
  });
  fs.createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();

  /* 模块求值期抛的异常 —— 这就是要抓的东西 */
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(`${e.message}\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}`));
  /* CSP 违规只以 console 消息的形式出现, 不抛异常 —— 所以必须单独收 */
  const cspViolations = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy/.test(t)) cspViolations.push(t);
  });

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });

  /* React 挂上就算过, 不等满 WAIT_MS */
  const mounted = await page
    .waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0, null, { timeout: WAIT_MS })
    .then(() => true)
    .catch(() => false);

  /* 先看模块求值异常 —— 它是因, 挂不上只是果, 报因才有用 */
  const fatal = pageErrors.filter((m) =>
    /before initialization|is not defined|Cannot access|is not a function|Cannot read properties of undefined/.test(m));
  if (fatal.length > 0) {
    fail('渲染端 bundle 在模块求值阶段抛异常', fatal.map((m) => '  ' + m.replace(/\n/g, '\n  ')).join('\n\n'));
  }
  if (!mounted) {
    fail(
      `React 在 ${WAIT_MS}ms 内没有挂载 (#root 一个子节点都没有)`,
      pageErrors.length > 0 ? pageErrors.map((m) => '  ' + m).join('\n') : '  (页面没有抛任何异常 —— 查挂载闸门是不是没放行)',
    );
  }

  if (cspViolations.length > 0) {
    fail(
      `打包版 CSP 挡掉了 ${cspViolations.length} 处东西`,
      cspViolations.slice(0, 6).map((m) => '  ' + m.slice(0, 220)).join('\n')
      + '\n\n  这类问题只在打包版发生 (dev 不挂 CSP), 且**不报错、只是悄悄不生效**。\n'
      + '  常见三种: 内联 <script> / 内联事件处理器 (onload=…) / data: 资源。\n'
      + '  内联脚本要挪成外部文件 (assets/ 下, publicDir 会原样拷过去)。',
    );
  }

  console.log(`✅ [renderer-boots] 打包版渲染端能起来 (干净 profile + 真 CSP, React 已挂载${pageErrors.length ? `; ${pageErrors.length} 条非致命页面异常` : ''})`);
} finally {
  await browser?.close();
  server.close();
}
