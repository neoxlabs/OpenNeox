import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.dirname(new URL(import.meta.url).pathname);
const TEMPLATE_CECE = path.join(ROOT, 'templates', 'cece');
const CECE_NODE_MODULES = path.join(process.env.HOME, 'AI', 'cece', 'node_modules');

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120000 });
const tryRun = (cmd, cwd) => { try { return { ok: true, out: sh(cmd, cwd) }; } catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }; } };
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');

function fresh(dir) { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); }
function cloneCece(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  sh(`git clone -q "${TEMPLATE_CECE}" "${dir}"`);
  fs.symlinkSync(CECE_NODE_MODULES, path.join(dir, 'node_modules'));
  sh('git config user.email bench@local && git config user.name bench', dir);
}
const cecePass = (dir) => tryRun('npm test', dir).ok;
const untouched = (dir, glob) => sh(`git status --porcelain -- ${glob}`, dir).trim() === '';

/* ── 合成靶子 ─────────────────────────────────────────────────────────── */
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

function genLog(dir) {
  const r = rng(42); const lines = [];
  const eps = ['/api/pets', '/api/feedings', '/api/walks', '/api/report', '/api/export', '/api/health'];
  let t = Date.UTC(2026, 8, 11, 1, 0, 0);
  const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 23);
  for (let i = 0; i < 6000; i++) {
    t += Math.floor(r() * 900);
    const id = 'req-' + Math.floor(r() * 0xfffff).toString(16).padStart(5, '0');
    const ep = eps[Math.floor(r() * eps.length)];
    if (i === 4480) {
      lines.push(`${fmt(t)} INFO  [http] ${'req-7f3a9'} GET /api/export?format=csv&limit=250000 user=u_1832 start`);
      for (let k = 0; k < 6; k++) { t += 700; lines.push(`${fmt(t)} WARN  [gc] heap used ${(1.2 + k * 0.14).toFixed(2)}GB / 2.0GB, rss climbing (req-7f3a9 still streaming rows)`); }
      t += 400; lines.push(`${fmt(t)} ERROR [runtime] FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`);
      t += 50; lines.push(`${fmt(t)} ERROR [supervisor] worker 3 exited with code 134, restarting`);
      t += 2200; lines.push(`${fmt(t)} INFO  [supervisor] worker 3 ready`);
      continue;
    }
    if (i === 1200) { lines.push(`${fmt(t)} INFO  [http] req-7f3a8 GET /api/export?format=csv&limit=250 user=u_0021 200 in 88ms`); continue; }
    const roll = r();
    if (roll < 0.04) lines.push(`${fmt(t)} WARN  [db] slow query ${Math.floor(300 + r() * 900)}ms on ${ep} (${id})`);
    else if (roll < 0.06) lines.push(`${fmt(t)} WARN  [http] ${id} ${ep} 429 rate limited`);
    else if (roll < 0.07) lines.push(`${fmt(t)} ERROR [http] ${id} ${ep} 502 upstream timeout (retried ok)`);
    else lines.push(`${fmt(t)} INFO  [http] ${id} GET ${ep}?page=${Math.floor(r() * 20)} 200 in ${Math.floor(5 + r() * 120)}ms`);
  }
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'logs', 'app.log'), lines.join('\n') + '\n');
}

const REGIONS = ['华东', '华南', '华北', '西南', '东北'];
function genCsv(dir) {
  const r = rng(7); const rows = ['date,region,product,qty,unit_price'];
  const products = ['猫粮', '狗粮', '猫砂', '牵引绳', '玩具球', '驱虫药'];
  for (let i = 0; i < 400; i++) {
    const d = `2026-08-${String(1 + Math.floor(r() * 31)).padStart(2, '0')}`;
    rows.push(`${d},${REGIONS[Math.floor(r() * 5)]},${products[Math.floor(r() * 6)]},${1 + Math.floor(r() * 20)},${(9.9 + Math.floor(r() * 3000) / 10).toFixed(2)}`);
  }
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'sales.csv'), rows.join('\n') + '\n');
}
function csvTotals(dir) {
  const lines = fs.readFileSync(path.join(dir, 'data', 'sales.csv'), 'utf8').trim().split('\n').slice(1);
  const tot = Object.fromEntries(REGIONS.map((x) => [x, 0]));
  for (const l of lines) { const [, reg, , q, p] = l.split(','); tot[reg] += Number(q) * Number(p); }
  return tot;
}

function genBigfile(dir) {
  fs.mkdirSync(path.join(dir, 'src'));
  const fns = [];
  const names = ['tax', 'shipping', 'handling', 'insurance', 'coupon', 'loyalty', 'bundle', 'refund', 'fee', 'rounding'];
  for (let i = 0; i < 58; i++) {
    const n = `${names[i % names.length]}Rule${i}`;
    fns.push(`/**\n * ${n}: 第 ${i} 条计价规则 (历史遗留, 保持原样)\n * 输入金额 (元), 返回调整后的金额\n */\nexport function ${n}(amount) {\n  if (typeof amount !== 'number' || Number.isNaN(amount)) throw new TypeError('amount must be a number');\n  const base = Math.max(0, amount);\n  const rate = ${(0.01 * ((i % 7) + 1)).toFixed(2)};\n  const cap = ${100 + i * 5};\n  let adj = base * rate;\n  if (adj > cap) adj = cap;\n  // rule ${i}: ${['四舍五入到分', '向下取整到分', '不处理'][i % 3]}\n  const out = base + adj;\n  return Math.round(out * 100) / 100;\n}\n`);
    if (i === 31) fns.push(`/**\n * 阶梯折扣: 满 1000 打 85 折, 满 500 打 9 折, 满 200 打 95 折, 其余不打折\n */\nexport function applyTieredDiscount(amount) {\n  if (typeof amount !== 'number' || Number.isNaN(amount)) throw new TypeError('amount must be a number');\n  let rate = 1;\n  if (amount >= 200) rate = 0.95;\n  else if (amount >= 500) rate = 0.9;\n  else if (amount >= 1000) rate = 0.85;\n  return Math.round(amount * rate * 100) / 100;\n}\n`);
  }
  fs.writeFileSync(path.join(dir, 'src', 'pricing.js'), `// 计价规则集合 —— 自动生成, 共 ${fns.length} 个函数\n\n${fns.join('\n')}`);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(dir, 'check.mjs'), `import * as p from './src/pricing.js';\nconst cases = [\n  [p.applyTieredDiscount(100), 100],\n  [p.applyTieredDiscount(300), 285],\n  [p.applyTieredDiscount(600), 540],\n  [p.applyTieredDiscount(1200), 1020],\n  [p.taxRule0(100), 101],\n  [p.shippingRule1(200), 204],\n];\nlet bad = 0;\ncases.forEach(([got, want], i) => { if (got !== want) { bad++; console.error('case ' + i + ': got ' + got + ', want ' + want); } });\nif (bad) { console.error(bad + ' failing'); process.exit(1); }\nconsole.log('all ' + cases.length + ' ok');\n`);
}

/* ── 任务 ─────────────────────────────────────────────────────────────── */
export const TASKS = [
  {
    id: 'cece-bug', kind: 'fix',
    setup(dir) {
      cloneCece(dir);
      const f = path.join(dir, 'models', 'PetStats.js');
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('Math.min(hoursSince * 1.5, 30)', 'Math.min(hoursSince * 1.5, 20)'));
      sh('git commit -qam "wip"', dir);
    },
    prompt: 'npm test 有测试失败了。找到原因并修复业务代码（不要改 test/ 下的测试文件），修完跑 npm test 确认全部通过。',
    verify(dir) {
      if (!untouched(dir, 'test')) return { ok: false, why: '改了测试文件' };
      return cecePass(dir) ? { ok: true } : { ok: false, why: 'npm test 仍失败' };
    },
  },
  {
    id: 'cece-feature', kind: 'feature',
    setup(dir) { cloneCece(dir); },
    prompt: '在 utils/ 下新增 duration.js，导出 formatDuration(minutes)：小于 60 返回「N分钟」，整小时返回「N小时」，其余返回「N小时M分钟」；负数或非数字抛 TypeError。再写 test/duration.test.js 覆盖这些情况，最后跑 npm test 确认全部通过。',
    verify(dir) {
      const f = path.join(dir, 'utils', 'duration.js');
      if (!fs.existsSync(f)) return { ok: false, why: '没有 utils/duration.js' };
      if (!fs.existsSync(path.join(dir, 'test', 'duration.test.js'))) return { ok: false, why: '没有测试文件' };
      const probe = tryRun(`node -e "const m=require('./utils/duration.js');const f=m.formatDuration||m.default||m;const a=require('assert');a.equal(f(45),'45分钟');a.equal(f(120),'2小时');a.equal(f(135),'2小时15分钟');a.throws(()=>f(-1),TypeError);a.throws(()=>f('x'),TypeError);"`, dir);
      if (!probe.ok) return { ok: false, why: '行为不对: ' + probe.out.slice(0, 120) };
      return cecePass(dir) ? { ok: true } : { ok: false, why: 'npm test 失败' };
    },
  },
  {
    id: 'cece-rename', kind: 'refactor',
    setup(dir) { cloneCece(dir); },
    prompt: '把 Achievement 模型里的 checkAndUnlock 方法重命名为 evaluateBadges，所有调用处一起改掉，最后跑 npm test 确认全部通过。',
    verify(dir) {
      const left = tryRun('git grep -n checkAndUnlock -- . ":!node_modules"', dir);
      if (left.ok && left.out.trim()) return { ok: false, why: '还有残留: ' + left.out.split('\n').length + ' 处' };
      if (!/static evaluateBadges\(/.test(fs.readFileSync(path.join(dir, 'models', 'Achievement.js'), 'utf8'))) return { ok: false, why: '没有 evaluateBadges 定义' };
      return cecePass(dir) ? { ok: true } : { ok: false, why: 'npm test 失败' };
    },
  },
  {
    id: 'cece-question', kind: 'question',
    setup(dir) { cloneCece(dir); },
    prompt: 'walk_30 这个徽章要遛狗多少次才能解锁？这个判断写在哪个文件里？只回答次数和文件路径。',
    verify(dir, answer) {
      if (!/\b30\b/.test(answer)) return { ok: false, why: '次数不对' };
      if (!/Achievement\.js/.test(answer)) return { ok: false, why: '文件不对' };
      return { ok: true };
    },
  },
  {
    id: 'log-rca', kind: 'investigate',
    setup(dir) { fresh(dir); genLog(dir); },
    prompt: '服务今天崩溃重启过一次，日志在 logs/app.log。找出是哪个请求导致的崩溃：请求 ID、接口路径、触发它的参数。只回答这三样。',
    verify(dir, answer) {
      const miss = ['req-7f3a9', '/api/export', '250000'].filter((w) => !answer.includes(w));
      return miss.length ? { ok: false, why: '缺: ' + miss.join(' ') } : { ok: true };
    },
  },
  {
    id: 'csv-report', kind: 'office',
    setup(dir) { fresh(dir); genCsv(dir); },
    prompt: '根据 data/sales.csv 生成 report.md：按区域统计总销售额（qty × unit_price），用 Markdown 表格按销售额从高到低列出，金额保留两位小数，最后一行写总计。',
    verify(dir) {
      const f = path.join(dir, 'report.md');
      if (!fs.existsSync(f)) return { ok: false, why: '没有 report.md' };
      const md = fs.readFileSync(f, 'utf8').replace(/,/g, '');
      const tot = csvTotals(dir);
      const order = Object.entries(tot).sort((a, b) => b[1] - a[1]);
      let last = -1;
      for (const [reg, v] of order) {
        const s = v.toFixed(2);
        const at = md.indexOf(s);
        if (at < 0) return { ok: false, why: `${reg} 金额 ${s} 不在报告里` };
        if (at < last) return { ok: false, why: '顺序不是从高到低' };
        last = at;
      }
      const sum = Object.values(tot).reduce((a, b) => a + b, 0).toFixed(2);
      return md.includes(sum) ? { ok: true } : { ok: false, why: `总计 ${sum} 不在报告里` };
    },
  },
  {
    id: 'bigfile-fix', kind: 'fix',
    setup(dir) { fresh(dir); genBigfile(dir); this._checkSha = sha(path.join(dir, 'check.mjs')); },
    prompt: 'node check.mjs 报错了，帮我修好 src/pricing.js（不要改 check.mjs），修完再运行一次确认。',
    verify(dir) {
      if (sha(path.join(dir, 'check.mjs')) !== this._checkSha) return { ok: false, why: '改了 check.mjs' };
      return tryRun('node check.mjs', dir).ok ? { ok: true } : { ok: false, why: 'check 仍失败' };
    },
  },
];

/* 自检: node tasks.mjs --selfcheck —— 每个任务 setup 后, 未动手时 verify 必须是 false (靶子真的是坏的) */
if (process.argv.includes('--selfcheck')) {
  for (const t of TASKS) {
    const dir = path.join(ROOT, 'work', t.id);
    t.setup(dir);
    const v = await t.verify(dir, '');
    console.log(`${t.id.padEnd(14)} setup ok · 未动手时 verify = ${v.ok ? '✗ 竟然通过' : '✓ 失败'} (${v.why || ''})`);
  }
}
