import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.dirname(new URL(import.meta.url).pathname);
export const WORK = process.env.CB_WORK || '/private/tmp/cb-work';
const TEMPLATE_CECE = path.join(ROOT, 'templates', 'cece');
const CECE_NODE_MODULES = path.join(process.env.HOME, 'AI', 'cece', 'node_modules');

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 180000 });
const tryRun = (cmd, cwd) => { try { return { ok: true, out: sh(cmd, cwd) }; } catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }; } };

function cloneCece(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  sh(`git clone -q "${TEMPLATE_CECE}" "${dir}"`);
  fs.symlinkSync(CECE_NODE_MODULES, path.join(dir, 'node_modules'));
  sh('git config user.email dev@cece.local && git config user.name cece-dev', dir);
}
function patch(dir, file, from, to) {
  const f = path.join(dir, file);
  const src = fs.readFileSync(f, 'utf8');
  if (!src.includes(from)) throw new Error(`patch miss: ${file}: ${from.slice(0, 60)}`);
  fs.writeFileSync(f, src.replace(from, to));
}
const commit = (dir, msg) => sh(`git add -A && git commit -q -m ${JSON.stringify(msg)}`, dir);
const cecePass = (dir) => tryRun('npm test', dir).ok;
/* node_modules 是软链进来的 (不在模板 .gitignore 里), 不算 agent 的改动 */
const changed = (dir) => sh('git status --porcelain', dir).split('\n').filter(Boolean).map((l) => l.slice(3)).filter((f) => f !== 'node_modules');

/**
 * 在工作目录里跑一段 CommonJS 验证脚本 (用 agent 改过的代码)。脚本最后 console.log 一行 JSON。
 * 公共前缀: 临时库 + 起服务 (端口 0) + 带 cookie 的 fetch + 登录。
 */
const HTTP_PRELUDE = `
const path = require('path'); const os = require('os');
process.env.CECE_DB_PATH = path.join(os.tmpdir(), 'bench-' + process.pid + '-' + Date.now() + '.db');
const { initDatabase, getDatabase, closeDatabase } = require('./config/database');
initDatabase();
const db = getDatabase();
const bcrypt = require('bcryptjs');
function mkUser(name) { return db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)').run(name, name + '@t.local', bcrypt.hashSync('password-123', 4)).lastInsertRowid; }
function mkPet(uid, name) { return db.prepare('INSERT INTO pets (user_id, name, species) VALUES (?, ?, ?)').run(uid, name, '狗').lastInsertRowid; }
function localDay(offset) { const d = new Date(); d.setDate(d.getDate() + offset); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
async function withServer(fn) {
  const { createApp, loadConfig } = require('./app');
  const app = createApp({ config: loadConfig({ NODE_ENV: 'test', PORT: '0' }) });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  try { return await fn(base); } finally { server.close(); }
}
function client(base) {
  let jar = {};
  const cookie = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  const req = async (p, opt = {}) => {
    const r = await fetch(base + p, { ...opt, redirect: 'manual', headers: { ...(opt.headers || {}), cookie: cookie() } });
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) { const kv = c.split(';')[0]; const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return r;
  };
  const csrfOf = (html) => { const m = html.match(/name="_csrf"[^>]*value="([^"]+)"/) || html.match(/value="([^"]+)"[^>]*name="_csrf"/) || html.match(/csrf-token"\\s+content="([^"]+)"/); return m ? m[1] : ''; };
  const login = async (u) => {
    const html = await (await req('/auth/login')).text();
    const body = new URLSearchParams({ username: u, password: 'password-123', _csrf: csrfOf(html) });
    const r = await req('/auth/login', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    return r.status;
  };
  return { req, login };
}
`;
function runVerifyScript(dir, body) {
  const f = path.join(dir, '.bench-verify.cjs');
  fs.writeFileSync(f, HTTP_PRELUDE + `\n(async () => {\n${body}\n})().then((r) => { console.log('__RESULT__' + JSON.stringify(r)); try { closeDatabase(); } catch {} process.exit(0); }).catch((e) => { console.log('__RESULT__' + JSON.stringify({ crash: String(e && e.stack || e).slice(0, 600) })); process.exit(0); });\n`);
  const r = spawnSync('node', [f], { cwd: dir, encoding: 'utf8', timeout: 120000 });
  fs.rmSync(f, { force: true });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  return line ? JSON.parse(line.slice('__RESULT__'.length)) : { crash: (r.stderr || r.stdout || '').slice(0, 600) };
}

export const TASKS = [
  {
    id: 'v2-streak', kind: 'debug',
    prompt: '用户反馈：她这周每天都给猫喂饭（都是在 App 里按实际日期补录的），但「三天打鱼」连续记录徽章一直不解锁；另一个只遛狗的用户就正常。帮我查清楚原因并修好，补一个回归测试。',
    setup(dir) {
      cloneCece(dir);
      patch(dir, 'models/Achievement.js', 'UNION SELECT feed_date as d FROM feedings', 'UNION SELECT created_at as d FROM feedings');
      commit(dir, 'perf(achievement): streak 查询统一走带索引的时间列');
    },
    async verify(dir) {
      const r = runVerifyScript(dir, `
        const Feeding = require('./models/Feeding'); const Walk = require('./models/Walk'); const Achievement = require('./models/Achievement');
        const u = mkUser('feeder'); const p = mkPet(u, 'Mimi');
        for (const off of [0, -1, -2]) Feeding.create({ pet_id: p, user_id: u, feed_date: localDay(off), feed_time: '08:00' });
        Achievement.checkAndUnlock(u, p);
        const feedStreak = !!db.prepare("SELECT 1 FROM achievements WHERE user_id=? AND pet_id=? AND badge_key='streak_3'").get(u, p);
        const u2 = mkUser('walker'); const p2 = mkPet(u2, 'Bobo');
        for (const off of [0, -1, -2]) Walk.create({ pet_id: p2, user_id: u2, walk_date: localDay(off) });
        Achievement.checkAndUnlock(u2, p2);
        const walkStreak = !!db.prepare("SELECT 1 FROM achievements WHERE user_id=? AND pet_id=? AND badge_key='streak_3'").get(u2, p2);
        /* 断档不能被误算成连续 */
        const u3 = mkUser('gap'); const p3 = mkPet(u3, 'Gap');
        for (const off of [0, -1, -3]) Feeding.create({ pet_id: p3, user_id: u3, feed_date: localDay(off), feed_time: '08:00' });
        Achievement.checkAndUnlock(u3, p3);
        const gapNoBadge = !db.prepare("SELECT 1 FROM achievements WHERE user_id=? AND pet_id=? AND badge_key='streak_3'").get(u3, p3);
        return { feedStreak, walkStreak, gapNoBadge };
      `);
      const tests = cecePass(dir);
      const addedTest = changed(dir).some((f) => /^test\//.test(f));
      const ok = r.feedStreak && r.walkStreak && r.gapNoBadge && tests;
      return { ok, why: ok ? (addedTest ? null : '修好了但没补回归测试') : JSON.stringify({ ...r, tests }), extra: { addedTest } };
    },
  },

  /* ── 多文件功能: 路由 + 视图 + 权限 + 编码 + 测试, 用真实 HTTP 验收 ── */
  {
    id: 'v2-export', kind: 'feature',
    prompt: '给遛狗记录加「导出 CSV」：遛狗列表页加一个导出按钮；GET /walks/export.csv 导出当前用户能看到的全部遛狗记录（不分页），支持跟列表页一样的筛选参数 pet_id、date_from、date_to、search。列：日期、宠物、时长(分钟)、距离(km)、心情。要保证用 Excel 直接打开中文不乱码。加上测试。',
    setup(dir) { cloneCece(dir); },
    async verify(dir) {
      const r = runVerifyScript(dir, `
        const Walk = require('./models/Walk'); const PetShare = require('./models/PetShare');
        const a = mkUser('alice'); const b = mkUser('bobby'); const c = mkUser('carol');
        const pa = mkPet(a, 'A狗'); const pb = mkPet(b, 'B狗'); const pc = mkPet(c, 'C狗');
        for (let i = 1; i <= 25; i++) Walk.create({ pet_id: pa, user_id: a, walk_date: '2026-08-' + String(i).padStart(2, '0'), duration_minutes: 30, distance_km: 1.5, mood: '开心' });
        /* 200 条 7 月的记录: 列表查询 Walk.findByUser 带 LIMIT 200, 直接拿来导出会**静默丢数据**。
         * 2026-09-11 实拍: Neox 那版就踩了 (竞品三家都绕开了), 而第一版验收只造 28 条, 够不着上限 ——
         * 验收自己漏了这个坑。日期放在 date_from 筛选之外, 不影响下面的筛选断言。 */
        for (let i = 0; i < 200; i++) Walk.create({ pet_id: pa, user_id: a, walk_date: '2026-07-' + String((i % 28) + 1).padStart(2, '0'), duration_minutes: 10, distance_km: 0.5, mood: '一般' });
        for (let i = 1; i <= 3; i++) Walk.create({ pet_id: pb, user_id: b, walk_date: '2026-07-0' + i, duration_minutes: 20, distance_km: 1 });
        for (let i = 1; i <= 4; i++) Walk.create({ pet_id: pc, user_id: c, walk_date: '2026-08-1' + i, duration_minutes: 10, distance_km: 0.5 });
        PetShare.create({ pet_id: pb, owner_id: b, shared_with_id: a, permission: 'view' });
        return await withServer(async (base) => {
          const cl = client(base); const loginStatus = await cl.login('alice');
          const get = async (q) => { const res = await cl.req('/walks/export.csv' + q); const buf = Buffer.from(await res.arrayBuffer()); const text = buf.toString('utf8'); return { status: res.status, type: res.headers.get('content-type') || '', bom: buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, lines: text.replace(/^\\uFEFF/, '').trim().split(/\\r?\\n/), text }; };
          const all = await get('');
          const byPet = await get('?pet_id=' + pa);
          const byDate = await get('?date_from=2026-08-20');
          const list = await (await cl.req('/walks')).text();
          return { loginStatus, status: all.status, type: all.type, bom: all.bom, header: all.lines[0], rowsAll: all.lines.length - 1, leaksC: all.text.includes('C狗'), rowsPet: byPet.lines.length - 1, rowsDate: byDate.lines.length - 1, listLinks: list.includes('export.csv') };
        });
      `);
      const tests = cecePass(dir);
      const addedTest = changed(dir).some((f) => /^test\//.test(f));
      const ok = r.status === 200 && /csv/.test(r.type) && r.rowsAll === 228 && !r.leaksC && r.rowsPet === 225 && r.rowsDate === 6 && r.bom && r.listLinks && tests && addedTest;
      return { ok, why: ok ? null : JSON.stringify({ ...r, tests, addedTest }).slice(0, 400) };
    },
  },

  /* ── 读懂代码 + 安全: 埋两个越权, 要求只写报告不改代码 ── */
  {
    id: 'v2-security', kind: 'review',
    prompt: '家庭共享功能要上线了。请审查权限模型：被共享的人（view / edit / admin 三种权限）实际能做哪些操作，有没有越权漏洞。结论写到 SECURITY_REVIEW.md，每条写清楚：位置、复现步骤、影响、修复建议。先不要改代码。',
    setup(dir) {
      cloneCece(dir);
      patch(dir, 'models/PetShare.js', "'UPDATE pet_shares SET status = ? WHERE id = ? AND owner_id = ?'\n    ).run('revoked', id, userId);", "'UPDATE pet_shares SET status = ? WHERE id = ?'\n    ).run('revoked', id);");
      patch(dir, 'routes/walks.js', "router.post('/:id/delete', requireRecordPetAccess(Walk, 'findById', 'edit')", "router.post('/:id/delete', requireRecordPetAccess(Walk, 'findById', 'view')");
      commit(dir, 'refactor: 共享相关查询收敛');
    },
    async verify(dir) {
      const f = path.join(dir, 'SECURITY_REVIEW.md');
      if (!fs.existsSync(f)) return { ok: false, why: '没有 SECURITY_REVIEW.md' };
      const md = fs.readFileSync(f, 'utf8');
      const ARTIFACT = /^(public\/uploads\/|database\/|logs?\/|\.neox\/|.*\.(db|db-wal|db-shm|log)$)/;
      const dirty = changed(dir).filter((x) => x !== 'SECURITY_REVIEW.md');
      const leftovers = dirty.filter((x) => ARTIFACT.test(x));
      const codeTouched = dirty.filter((x) => !ARTIFACT.test(x));
      /* 两个埋点各自按段落找: 同一段里要同时出现位置和性质 */
      const paras = md.split(/\n(?=#{1,4} |\d+[.、]|- \*\*|\*\*)/);
      const hitRevoke = paras.some((p) => /revoke|撤销|撤回/i.test(p) && /(PetShare|pet_shares|family|owner_id|任何|他人|别人)/i.test(p));
      const hitWalkDelete = paras.some((p) => /walk|遛狗/i.test(p) && /delete|删除/i.test(p) && /view|只读|查看/i.test(p));
      const ok = hitRevoke && hitWalkDelete && codeTouched.length === 0;
      return { ok, why: ok ? null : JSON.stringify({ hitRevoke, hitWalkDelete, codeTouched }), extra: { chars: md.length, leftovers } };
    },
  },

  /* ── 联网调研: 事实要新 (版本号), 要出处; 版本号用 npm registry 实时对账 ── */
  {
    id: 'v2-research', kind: 'research',
    prompt: '我们在考虑把测试从 node:test 迁到 Vitest，先帮我调研：1) Vitest 当前最新稳定版的大版本号和发布时间；2) 它对我们这种 CommonJS（require）项目的支持情况；3) better-sqlite3 这种原生模块在 Vitest 多线程/多进程下的已知坑。每条都给出处链接，写到 research.md，不超过 500 字，最后给出迁不迁的建议。',
    setup(dir) { cloneCece(dir); },
    async verify(dir) {
      const f = path.join(dir, 'research.md');
      if (!fs.existsSync(f)) return { ok: false, why: '没有 research.md' };
      const md = fs.readFileSync(f, 'utf8');
      const links = [...new Set(md.match(/https?:\/\/[^\s)>\]]+/g) || [])];
      const latest = tryRun('npm view vitest version', dir).out.trim();
      const major = latest.split('.')[0];
      /* 先去掉 markdown 强调/代码符号 —— `Vitest **5**` 第一版被判成没提版本 (假阴性) */
      const plain = md.replace(/[*_`]/g, '');
      const saysMajor = major && (new RegExp(`(v|Vitest\\s*|版本\\s*|版\\s*[:：]?\\s*)${major}(\\.|\\b)`, 'i').test(plain) || plain.includes(`vitest@${latest}`));
      const han = (md.match(/[\u4e00-\u9fff]/g) || []).length;
      const ok = links.length >= 3 && !!saysMajor && han <= 800;
      return { ok, why: ok ? null : JSON.stringify({ links: links.length, latest, saysMajor, han }), extra: { links, latest } };
    },
  },

  /* ── 模糊需求: 没有唯一答案; 自动只判 "没弄坏", 好不好由人评 ── */
  {
    id: 'v2-vague-ui', kind: 'vague',
    prompt: '宠物详情页信息太多太乱了，看着头疼，帮我整理一下。',
    setup(dir) { cloneCece(dir); },
    async verify(dir, answer = '') {
      const touched = changed(dir);
      /* 没动文件但给了具体方案并反问 = "先澄清" —— 真实使用里是合理打法, 单轮测试里没人回答它。
       * 不算失败也不算完成, 单独一类, 由人工评分跟"直接改好"并列比较。 */
      if (touched.length === 0 && (/\[ASKED_USER\]/.test(answer)
        || (/[?？]/.test(answer) && /(A\)|B\)|方案|确认|要不要|哪种|选)/.test(answer)))) {
        return { ok: false, why: '先澄清 (给了方案并反问, 没动代码)', extra: { clarify: true } };
      }
      const r = runVerifyScript(dir, `
        const Walk = require('./models/Walk');
        const u = mkUser('owner1'); const p = mkPet(u, '豆豆');
        Walk.create({ pet_id: p, user_id: u, walk_date: localDay(0), duration_minutes: 30 });
        return await withServer(async (base) => {
          const cl = client(base); await cl.login('owner1');
          const res = await cl.req('/pets/' + p); const html = await res.text();
          return { status: res.status, hasName: html.includes('豆豆'), hasBadges: /徽章|成就/.test(html), len: html.length };
        });
      `);
      const tests = cecePass(dir);
      const ok = touched.some((x) => /views\/|public\/|css/.test(x)) && r.status === 200 && r.hasName && r.hasBadges && tests;
      return { ok, why: ok ? null : JSON.stringify({ ...r, tests, touched }).slice(0, 300), extra: { touched } };
    },
  },

  /* ── 出错恢复: 启动链上两个串联错误, 修掉一个才看得见下一个; 修法要对 (改对列名, 不许删索引) ── */
  {
    id: 'v2-startup', kind: 'recovery',
    prompt: 'npm start 起不来了，报错看不太懂。帮我修好，确认服务能正常启动、首页能打开。',
    setup(dir) {
      cloneCece(dir);
      sh('git mv routes/breed.js routes/breeds.js', dir);
      commit(dir, 'refactor: 路由文件统一复数命名');
      patch(dir, 'config/database.js', 'CREATE TABLE IF NOT EXISTS feedings (', 'CREATE INDEX IF NOT EXISTS idx_walks_pet_date ON walks(pet_id, walk_dat);\n\n    CREATE TABLE IF NOT EXISTS feedings (');
      commit(dir, 'perf(db): 遛狗列表加复合索引');
    },
    async verify(dir) {
      const r = runVerifyScript(dir, `
        const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_walks_pet_date'").get();
        return await withServer(async (base) => {
          const h = await fetch(base + '/healthz'); const home = await fetch(base + '/', { redirect: 'manual' }); const breed = await fetch(base + '/breed', { redirect: 'manual' });
          return { health: h.status, home: home.status, breed: breed.status, idx: idx ? idx.sql : null };
        });
      `);
      const tests = cecePass(dir);
      const depsUntouched = !changed(dir).includes('package.json');
      const ok = r.health === 200 && [200, 302].includes(r.home) && [200, 302].includes(r.breed) && /walk_date/.test(r.idx || '') && tests && depsUntouched;
      return { ok, why: ok ? null : JSON.stringify({ ...r, tests, depsUntouched }).slice(0, 400) };
    },
  },
];

/* node tasks-v2.mjs --selfcheck: 未动手时每题都必须判失败 (否则验收是假的) */
if (process.argv.includes('--selfcheck')) {
  for (const t of TASKS) {
    const dir = path.join(WORK, `selfcheck-${t.id}`);
    t.setup(dir);
    const v = await t.verify(dir, '');
    console.log(`${v.ok ? '✗ 假阳性!' : '✓ 未动手判失败'} ${t.id.padEnd(14)} ${v.why || ''}`.slice(0, 260));
  }
}
