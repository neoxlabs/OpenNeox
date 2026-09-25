/**
 * 基准靶站 —— 一个受控的小后台系统。
 *
 * ─── 为什么要自己写一个, 不拿真站点测 ──────────────────────────────────────
 * 真站点每天都在变, 而且网络抖动会盖过我们想量的东西 (工具层是毫秒级的)。
 * 更要紧的是**验证**: 真站点上没法查"这条数据到底改没改", 只能看 agent 自己说
 * "我改好了" —— 那正是假绿。这里所有状态都在内存里, 跑分器可以直接查。
 *
 * ─── 为什么长这样 ──────────────────────────────────────────────────────────
 * 刻意放进了 agent 最容易翻车的几件事, 每一件都对应一类真实网站:
 *   · 登录后才有数据            —— 状态依赖, 一步错后面全错
 *   · 列表异步渲染 (200ms)      —— 点完立刻读会读到旧的
 *   · 搜索/筛选是前端做的       —— 不刷新页面, URL 不变
 *   · 分页                      —— 目标可能不在第一页
 *   · 表单有校验 + 二次确认     —— 少一步就没提交上
 *   · 删除有确认弹窗            —— 误点代价高
 *   · 一个"看起来能点其实禁用"  —— 专治"点了报成功"
 *
 * 无依赖, `node app/server.mjs` 就跑。端口默认 8910。
 */
import http from 'node:http';

const PORT = Number(process.env.PORT || 8910);

/* ─── 状态 (跑分器直接查这里, 不看 agent 怎么说) ─────────────────────────── */
const seed = () => ({
  users: { admin: 'neox2026' },
  session: null,
  tickets: Array.from({ length: 23 }, (_, i) => ({
    id: i + 1,
    title: [
      '登录页在 Safari 上白屏', '导出 CSV 缺最后一行', '搜索框中文输入丢字',
      '移动端底栏遮挡内容', '订单金额四舍五入错误', '头像上传超时',
      '通知重复推送两次', '筛选条件刷新后丢失',
    ][i % 8] + ` #${i + 1}`,
    priority: ['low', 'normal', 'high', 'urgent'][i % 4],
    status: i % 5 === 0 ? 'closed' : 'open',
    assignee: ['', '张三', '李四', '王五'][i % 4],
    locked: i === 6,          /* 6 号锁着 —— 按钮在, 但点了不生效 */
  })),
  audit: [],                  /* 每一次真正的状态变更 —— 验证的唯一依据 */
});
let db = seed();

const log = (action, detail) => db.audit.push({ at: Date.now(), action, ...detail });

/* ─── 页面 ────────────────────────────────────────────────────────────────── */
const shell = (body, extra = '') => `<!doctype html><html lang="zh"><meta charset="utf-8">
<title>Bench 工单台</title>
<style>
 body{font:14px/1.6 -apple-system,"PingFang SC",sans-serif;margin:0;background:#f6f7f8;color:#1a1f23}
 header{background:#fff;border-bottom:1px solid #e3e7ea;padding:12px 20px;display:flex;gap:16px;align-items:center}
 main{padding:20px;max-width:920px}
 input,select,button{font:inherit;padding:6px 10px;border:1px solid #ccd3d8;border-radius:5px;background:#fff}
 button{cursor:pointer}
 button.primary{background:#0e7c86;color:#fff;border-color:#0e7c86}
 button:disabled{opacity:.45;cursor:not-allowed}
 table{border-collapse:collapse;width:100%;background:#fff;margin-top:12px}
 th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #eef1f3}
 th{font-size:12px;color:#6b7a80;text-transform:uppercase;letter-spacing:.05em}
 .pill{font-size:12px;padding:1px 8px;border-radius:10px;border:1px solid currentColor}
 .open{color:#2f7d4f}.closed{color:#6b7a80}.urgent{color:#b03a2e}.high{color:#9a6a0c}
 #toast{position:fixed;right:16px;bottom:16px;background:#1a1f23;color:#fff;padding:9px 14px;border-radius:6px;display:none}
 dialog{border:1px solid #ccd3d8;border-radius:8px;padding:18px;min-width:280px}
 .muted{color:#6b7a80}
</style>${body}${extra}`;

const loginPage = () => shell(`
<main style="max-width:340px;margin:80px auto">
 <h1 style="font-size:20px">Bench 工单台</h1>
 <p class="muted">请先登录。</p>
 <form id="lf">
  <p><input id="u" name="u" placeholder="用户名" autocomplete="off"></p>
  <p><input id="p" name="p" type="password" placeholder="密码" autocomplete="off"></p>
  <p><button class="primary" id="submit" type="submit">登录</button></p>
  <p id="err" style="color:#b03a2e"></p>
 </form>
</main>
<script>
document.getElementById('lf').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/api/login', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ u: u.value, p: p.value }) });
  if (r.ok) location.href = '/tickets';
  else err.textContent = '用户名或密码不对';
});
</script>`);

const ticketsPage = () => shell(`
<header>
 <b>Bench 工单台</b>
 <input id="q" placeholder="搜索标题…" style="width:220px">
 <select id="st"><option value="">全部状态</option><option value="open">未关闭</option><option value="closed">已关闭</option></select>
 <select id="pr"><option value="">全部优先级</option><option value="urgent">紧急</option><option value="high">高</option><option value="normal">普通</option><option value="low">低</option></select>
 <span style="flex:1"></span>
 <span class="muted" id="who"></span>
</header>
<main>
 <div id="list" class="muted">加载中…</div>
 <div id="pager" style="margin-top:14px;display:flex;gap:8px;align-items:center"></div>
</main>
<dialog id="dlg">
 <p id="dlgmsg"></p>
 <div style="display:flex;gap:8px;justify-content:flex-end">
  <button id="no">取消</button><button id="yes" class="primary">确认</button>
 </div>
</dialog>
<div id="toast"></div>
<script>
let page = 1, pending = null;
const PER = 10;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

async function load() {
  /* 刻意异步 + 200ms 延迟: 点完立刻读 DOM 会读到旧内容 —— 真站点普遍如此 */
  const r = await fetch('/api/tickets');
  if (r.status === 401) { location.href = '/'; return; }
  const all = await r.json();
  window.__all = all;
  document.getElementById('who').textContent = '已登录: admin';
  render();
}
function filtered() {
  const q = document.getElementById('q').value.trim().toLowerCase();
  const st = document.getElementById('st').value;
  const pr = document.getElementById('pr').value;
  return (window.__all || []).filter((t) =>
    (!q || t.title.toLowerCase().includes(q)) && (!st || t.status === st) && (!pr || t.priority === pr));
}
function render() {
  const rows = filtered();
  const maxPage = Math.max(1, Math.ceil(rows.length / PER));
  if (page > maxPage) page = maxPage;
  const slice = rows.slice((page - 1) * PER, page * PER);
  document.getElementById('list').innerHTML = slice.length ? \`<table id="tbl"><thead><tr>
    <th>ID</th><th>标题</th><th>优先级</th><th>状态</th><th>负责人</th><th>操作</th></tr></thead><tbody>\`
    + slice.map((t) => \`<tr data-id="\${t.id}">
      <td>\${t.id}</td><td class="title">\${esc(t.title)}</td>
      <td><span class="pill \${t.priority}">\${t.priority}</span></td>
      <td><span class="pill \${t.status}">\${t.status}</span></td>
      <td>\${esc(t.assignee) || '<span class="muted">未分配</span>'}</td>
      <td>
        <button class="assign" data-id="\${t.id}">分配</button>
        <button class="close" data-id="\${t.id}" \${t.status === 'closed' ? 'disabled' : ''}>关闭</button>
      </td></tr>\`).join('') + '</tbody></table>'
    : '<p class="muted" id="empty">没有符合条件的工单</p>';
  document.getElementById('pager').innerHTML =
    \`<button id="prev" \${page <= 1 ? 'disabled' : ''}>上一页</button>
     <span id="pginfo">第 \${page} / \${maxPage} 页 · 共 \${rows.length} 条</span>
     <button id="next" \${page >= maxPage ? 'disabled' : ''}>下一页</button>\`;
}
function toast(m) { const t = document.getElementById('toast'); t.textContent = m; t.style.display='block'; setTimeout(()=>t.style.display='none', 2500); }
function ask(msg, fn) { pending = fn; document.getElementById('dlgmsg').textContent = msg; document.getElementById('dlg').showModal(); }

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'prev') { page--; render(); }
  if (b.id === 'next') { page++; render(); }
  if (b.id === 'no') { document.getElementById('dlg').close(); pending = null; }
  if (b.id === 'yes') { document.getElementById('dlg').close(); const f = pending; pending = null; if (f) await f(); }
  if (b.classList.contains('close')) {
    const id = b.dataset.id;
    ask(\`确认关闭工单 #\${id}?\`, async () => {
      const r = await fetch('/api/tickets/' + id + '/close', { method: 'POST' });
      const j = await r.json();
      toast(j.ok ? \`已关闭 #\${id}\` : ('关闭失败: ' + j.error));
      await load();
    });
  }
  if (b.classList.contains('assign')) {
    const id = b.dataset.id;
    const who = prompt('分配给谁?');
    if (!who) return;
    const r = await fetch('/api/tickets/' + id + '/assign', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ who }) });
    const j = await r.json();
    toast(j.ok ? \`#\${id} 已分配给 \${who}\` : ('分配失败: ' + j.error));
    await load();
  }
});
['q','st','pr'].forEach((id) => document.getElementById(id).addEventListener('input', () => { page = 1; render(); }));
setTimeout(load, 200);
</script>`);

/* ─── 路由 ────────────────────────────────────────────────────────────────── */
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => s += c); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } }); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/' ) return html(res, loginPage());
  if (p === '/tickets') return html(res, ticketsPage());

  if (p === '/api/login' && req.method === 'POST') {
    const { u, p: pw } = await readBody(req);
    if (db.users[u] === pw) { db.session = u; log('login', { u }); return json(res, 200, { ok: true }); }
    return json(res, 401, { ok: false });
  }
  if (p === '/api/tickets') {
    if (!db.session) return json(res, 401, { error: 'not logged in' });
    return json(res, 200, db.tickets);
  }

  const m = /^\/api\/tickets\/(\d+)\/(close|assign)$/.exec(p);
  if (m && req.method === 'POST') {
    if (!db.session) return json(res, 401, { error: 'not logged in' });
    const t = db.tickets.find((x) => x.id === Number(m[1]));
    if (!t) return json(res, 404, { ok: false, error: '没有这个工单' });
    /* 锁着的那条: 按钮点得动、请求也发得出去, 但服务端拒绝 —— 专治"点了就报成功" */
    if (t.locked) return json(res, 409, { ok: false, error: '这条工单已锁定, 不能改' });
    if (m[2] === 'close') {
      if (t.status === 'closed') return json(res, 409, { ok: false, error: '已经是关闭状态' });
      t.status = 'closed'; log('close', { id: t.id });
    } else {
      const { who } = await readBody(req);
      if (!who) return json(res, 400, { ok: false, error: '负责人不能为空' });
      t.assignee = who; log('assign', { id: t.id, who });
    }
    return json(res, 200, { ok: true });
  }

  /* 跑分器专用: 查真实状态 / 重置。agent 不该用这几个 —— 它们不在页面上。 */
  if (p === '/__bench/state') return json(res, 200, { session: db.session, tickets: db.tickets, audit: db.audit });
  if (p === '/__bench/reset') { db = seed(); return json(res, 200, { ok: true }); }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => console.log(`bench app on http://127.0.0.1:${PORT}`));
