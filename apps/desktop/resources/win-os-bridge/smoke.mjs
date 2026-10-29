/**
 * neox-os-bridge (Windows) 冒烟测试 —— 走完整 JSON-lines 协议做一件真事。
 *
 *   对应 mac 的 os-bridge/smoke.mjs: 那边在 TextEdit 里打字读回, 这边在**记事本**里
 *   做同一件事。区别只在目标应用 —— 协议、编号体系、动作语义全一样。
 *
 *   为什么要有它: 单元测试测不出 UIA / SendInput 这一层。这里每一步都是真窗口真事件,
 *   失败了就是真的坏了。
 *
 * 用法:
 *   node apps/desktop/resources/win-os-bridge/smoke.mjs            全部
 *   node apps/desktop/resources/win-os-bridge/smoke.mjs probe      只跑协议层
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const BIN = join(DIR, 'neox-os-bridge.exe');
const ONLY = process.argv[2] || '';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v) => (typeof v === 'string' ? v.slice(0, 120) : JSON.stringify(v).slice(0, 160));

const bridge = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const waiters = new Map();
let handshake = null;
/* 事件行 (没有 id) —— 叠加层靠它画虚拟光标, 这里专门收一份来断言 */
const pointerEvents = [];
bridge.stdout.setEncoding('utf8');
bridge.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.log(`  ! 解不开这行: ${short(line)}`); continue; }
    /* id=0 是启动握手行 —— 没有等它的人 */
    if (msg.id === 0) { handshake = msg; continue; }
    if (msg.event === 'pointer') { pointerEvents.push(msg); continue; }
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  }
});
bridge.on('exit', (code) => { console.log(`  · 桥退出 code=${code}`); });

let seq = 0;
const call = (req, timeoutMs = 15000) =>
  new Promise((res) => {
    const id = ++seq;
    const timer = setTimeout(() => { waiters.delete(id); res({ id, ok: false, code: 'smoke_timeout', error: `${req.op} 超时` }); }, timeoutMs);
    waiters.set(id, (m) => { clearTimeout(timer); res(m); });
    bridge.stdin.write(JSON.stringify({ id, ...req }) + '\n');
  });

await sleep(300);

console.log('\n── 协议层 ──');
check('启动握手 (id=0) 收到', !!handshake, handshake ? `trusted=${handshake.trusted}` : '没收到');
const pr = await call({ op: 'probe' });
check('probe 回执合法', pr.ok === true && pr.trusted === true, short(pr));
const apps = await call({ op: 'apps' });
check('apps 能列出在跑的应用', apps.ok === true && Array.isArray(apps.apps) && apps.apps.length > 0,
  apps.ok ? `${apps.apps.length} 个: ${apps.apps.slice(0, 6).map((a) => a.name).join(', ')}` : short(apps));
const badOp = await call({ op: 'no_such_op' });
check('不认识的 op → unknown_op (不是挂掉)', badOp.ok === false && badOp.code === 'unknown_op', short(badOp));
bridge.stdin.write('{ this is not json }\n');
await sleep(150);
check('坏 JSON 之后桥还活着 (probe 仍答)', (await call({ op: 'probe' })).ok === true);

if (ONLY === 'probe') {
  await call({ op: 'quit' });
  await sleep(300);
  console.log(failures === 0 ? '\n✓ 协议层通过\n' : `\n✗ ${failures} 项失败\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/* ── 感知 / 动作层 (b2/b3 落地后逐步补) ───────────────────────────────────── */
console.log('\n── 感知 ──');
/* 跟 mac 的 smoke 一样自带准备步: 那边打开 TextEdit 新文档, 这边打开记事本,
 * 让脚本在任何一台干净的机器上都能跑 (不用人手先开个应用)。 */
const launched = await call({ op: 'launch', app: 'notepad' });
check('launch 记事本', launched.ok === true, short(launched));
await sleep(500);

const dump = await call({ op: 'dump', app: 'notepad' });
check('dump 记事本', dump.ok === true && Array.isArray(dump.elements) && dump.elements.length > 0,
  dump.ok ? `${dump.elements.length} 个元素 / ${dump.ms}ms / visited=${dump.visited} / axBlind=${dump.axBlind}` : short(dump));
if (dump.ok) {
  console.log('  编号表 (前 14 个):');
  for (const e of dump.elements.slice(0, 14)) {
    console.log(`    ${String(e.id).padStart(3)}. [${e.role}] ${e.label || e.roleDesc || '(无标签)'}`
      + `${e.actionable ? ' ' + JSON.stringify(e.actions) : ''}`);
  }
}

const sig = await call({ op: 'signature', app: 'notepad' });
check('signature 记事本', sig.ok === true && Array.isArray(sig.texts),
  sig.ok ? `${sig.ms}ms / texts=${JSON.stringify(sig.texts).slice(0, 100)} / counts=${JSON.stringify(sig.counts)}` : short(sig));

/* ── 动作层 ────────────────────────────────────────────────────────────────
 * 这是整套东西真正要证明的事: 能对着**编号**动手, 而不是靠猜坐标。
 * 跑完记事本里会留着测试文本 —— 那正是"真的发生了"的证据。 */
console.log('\n── 动作 ──');
const before = await call({ op: 'dump', app: 'notepad' });
const edit = before.ok ? before.elements.find((e) => e.role === 'Edit') : null;
check('编号表里有输入框 (Edit)', !!edit, edit ? `编号 ${edit.id} / actions=${JSON.stringify(edit.actions)}` : '没找到');

const TEXT = 'neox win smoke ✓ 你好';
const sv = await call({ op: 'act', target: edit?.id, action: 'setValue', text: TEXT });
check('setValue 写值 (ValuePattern, 不抢焦点)', sv.ok === true, short(sv));

const rd = await call({ op: 'read', target: edit?.id });
check('read 读回一致', rd.ok === true && String(rd.value).includes('neox win smoke'),
  rd.ok ? `「${String(rd.value).slice(0, 40)}」` : short(rd));

const fo = await call({ op: 'act', target: edit?.id, action: 'focus' });
check('focus 元素', fo.ok === true, short(fo));

const ty = await call({ op: 'type', target: edit?.id, text: ' typed-ok' });
check('type 真键入 (SendInput)', ty.ok === true, short(ty));
const rd2 = await call({ op: 'read', target: edit?.id });
check('type 之后 read 里含 typed-ok', rd2.ok === true && String(rd2.value).includes('typed-ok'),
  rd2.ok ? `「${String(rd2.value).slice(0, 60)}」` : short(rd2));

const cl = await call({ op: 'click', target: edit?.id });
check('click 元素中心 (坐标点击兜底)', cl.ok === true, short(cl));

const k = await call({ op: 'key', key: 'end' });
check('key end (前台按键)', k.ok === true, short(k));

/* 指针事件: 叠加层(虚拟光标)全靠它 —— 没有 id 的事件行, 老宿主会自然忽略 */
{
  const withCoords = pointerEvents.filter((e) => typeof e.x === 'number' && typeof e.y === 'number');
  const kinds = [...new Set(pointerEvents.map((e) => e.action))];
  check(
    '动作会发指针事件 (带坐标, 供叠加层画光标)',
    pointerEvents.length >= 3 && withCoords.length >= 2 && kinds.includes('click') && kinds.includes('type'),
    `${pointerEvents.length} 条 / 动作=[${kinds.join(',')}] / 带坐标 ${withCoords.length} 条 / 样例=${short(withCoords[withCoords.length - 1] ?? {})}`,
  );
}

const stale = await call({ op: 'act', target: 9999, action: 'press' });
check('越界编号 → stale_handle', stale.ok === false && stale.code === 'stale_handle', short(stale));

/* ── 守卫: 硬边界 ──────────────────────────────────────────────────────────
 * 这三条是**绝不能通过**的。过了就意味着"绕过所有审批执行任意命令"。 */
console.log('\n── 守卫 (这三条必须被拒) ──');
for (const [app, want, why] of [
  ['cmd', 'app_forbidden_terminal', '终端'],
  ['powershell', 'app_forbidden_terminal', 'PowerShell'],
  ['neox', 'app_forbidden_self', 'Neox 自己'],
]) {
  const r = await call({ op: 'dump', app });
  check(`${app} (${why}) → ${want}`, r.ok === false && r.code === want, short(r));
}
const guardAct = await call({ op: 'act', app: 'cmd', target: 0, action: 'press' });
check('对 cmd 的 act 也被拒', guardAct.ok === false && guardAct.code === 'app_forbidden_terminal', short(guardAct));

/* ── 兜底与降级 ────────────────────────────────────────────────────────────
 * 自绘界面 (读不到元素) 就靠这两条: 截图给眼睛 + 比例点击。 */
console.log('\n── 兜底与降级 ──');
const shotsDir = join(homedir(), '.neox', 'run', 'shots');
await mkdir(shotsDir, { recursive: true }).catch(() => {});
const shotPath = join(shotsDir, `smoke-${Date.now()}.jpg`);
const shot = await call({ op: 'screenshot', app: 'notepad', path: shotPath });
check(
  'screenshot 落盘 (含缩放)',
  shot.ok === true && existsSync(shotPath),
  shot.ok ? `${shot.width}x${shot.height} · ${Math.round(shot.bytes / 1024)}KB → ${shotPath}` : short(shot),
);
const watch = await call({ op: 'watch', app: 'notepad', budget: 300 });
check('watch 等满 300ms 正常返回', watch.ok === true && Array.isArray(watch.fired), short(watch));
const ra = await call({ op: 'request_access' });
check(
  'request_access 带回 privilege (真权限状态)',
  ra.ok === true && ra.privilege && typeof ra.privilege.integrity === 'string' && typeof ra.privilege.canDriveElevated === 'boolean',
  short(ra),
);
const st = await call({ op: 'select_text', target: 0 });
check('select_text → unsupported_op (人话, 不是崩)', st.ok === false && st.code === 'unsupported_op', short(st));
const ic = await call({ op: 'icon', app: 'notepad' });
check('icon → unsupported_op', ic.ok === false && ic.code === 'unsupported_op', short(ic));

console.log(failures === 0 ? '\n✓ 全部通过\n' : `\n✗ ${failures} 项失败\n`);
await call({ op: 'quit' });
await sleep(300);
process.exit(failures === 0 ? 0 : 1);
