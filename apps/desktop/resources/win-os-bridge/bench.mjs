import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, '..', '..', '..', '..');
const OCR_PS1 = join(ROOT, 'scripts', 'win-ocr.ps1');
const SHOTS = join(homedir(), '.neox', 'run', 'shots');
mkdirSync(SHOTS, { recursive: true });

/* ── 桥客户端 ────────────────────────────────────────────────────────────── */
const bridge = spawn(join(DIR, 'neox-os-bridge.exe'), [], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const waiters = new Map();
bridge.stdout.setEncoding('utf8');
bridge.stdout.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line); const w = waiters.get(m.id);
    if (w) { waiters.delete(m.id); w(m); }
  }
});
let seq = 0;
const call = (req, t = 20000) => new Promise((res) => {
  const id = ++seq;
  const timer = setTimeout(() => { waiters.delete(id); res({ ok: false, code: 'timeout' }); }, t);
  waiters.set(id, (m) => { clearTimeout(timer); res(m); });
  bridge.stdin.write(JSON.stringify({ id, ...req }) + '\n');
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const p50 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : -1; };

/* ── Windows OCR (像素层) ────────────────────────────────────────────────── */
function ocr(imagePath) {
  const t0 = Date.now();
  let out = '';
  try {
    out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OCR_PS1],
      { env: { ...process.env, OCR_IMG: imagePath }, encoding: 'utf8', timeout: 60000 });
  } catch (e) {
    return { ocrMs: -1, wallMs: Date.now() - t0, lines: [], error: String(e.message).slice(0, 80) };
  }
  const lines = [];
  let ocrMs = -1;
  for (const row of out.split(/\r?\n/)) {
    const m = /^(\d+)\t(\d+)\t(.+)$/.exec(row);
    if (m) lines.push({ x: Number(m[1]), y: Number(m[2]), text: m[3] });
    const t = /^TOTAL\t(\d+)\t(\d+)$/.exec(row);
    if (t) ocrMs = Number(t[2]);
  }
  return { ocrMs, wallMs: Date.now() - t0, lines };
}

/* ── 窗口几何: 取矩形 / 移动 / 缩放 ──────────────────────────────────────── */
const PS_HELPER = `
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
'@
$p = Get-Process ${'$'}PROC -ErrorAction SilentlyContinue | Where-Object { ${'$'}_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not ${'$'}p) { Write-Output "NO_WINDOW"; exit 0 }
$r = [W.U+RECT]::new()
[void][W.U]::GetWindowRect(${'$'}p.MainWindowHandle, [ref]$r)
`;
function geom(procName, op) {
  const ps = PS_HELPER.replaceAll('$PROC', procName) + op + '\nWrite-Output ("$($r.L),$($r.T),$($r.R),$($r.B)")';
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 30000 }).trim();
    if (out === 'NO_WINDOW') return null;
    const m = /(-?\d+),(-?\d+),(-?\d+),(-?\d+)\s*$/.exec(out);
    if (!m) return null;
    const [l, t, r, b] = [m[1], m[2], m[3], m[4]].map(Number);
    return { l, t, r, b, w: r - l, h: b - t };
  } catch (e) { return null; }
}
const rect = (p) => geom(p, '');
const moveTo = (p, x, y) => geom(p, `[void][W.U]::SetWindowPos($p.MainWindowHandle,[IntPtr]::Zero,${x},${y},0,0,0x0001 -bor 0x0004)`);
const resizeTo = (p, w, h) => geom(p, `[void][W.U]::SetWindowPos($p.MainWindowHandle,[IntPtr]::Zero,0,0,${w},${h},0x0002 -bor 0x0004)`);

const results = { perceive: [], act: [], stability: [] };
await sleep(400);

/* ══ 感知: UIA 元素树 对照 截图+OCR ══════════════════════════════════════ */
console.log('\n════ 感知 (同一个应用, 两种读法) ════');
console.log('应用        UIA元素 可交互 dump_ms axBlind 重探 换树 | OCR行数 OCR纯算 OCR含启动  读到的内容样例');
for (const app of ['notepad', 'explorer', 'chrome', 'qq', 'taskmgr']) {
  const dumps = [];
  let d = null;
  for (let i = 0; i < 3; i++) { d = await call({ op: 'dump', app, budget: 1200 }); if (d.ok) dumps.push(d.ms); await sleep(120); }
  if (!d || !d.ok) { console.log(`${app.padEnd(11)} — 不在跑 / dump 失败 (${d?.code ?? '?'})`); continue; }

  const shot = join(SHOTS, `bench-${app}.jpg`);
  const s = await call({ op: 'screenshot', app, path: shot });
  const o = s.ok ? ocr(shot) : { ocrMs: -1, wallMs: -1, lines: [], error: s.code };
  const actionable = d.elements.filter((e) => e.actionable).length;
  const sample = o.lines.slice(0, 2).map((l) => l.text.slice(0, 20)).join(' | ');

  console.log(
    `${app.padEnd(11)} ${String(d.elements.length).padStart(6)} ${String(actionable).padStart(6)} `
    + `${String(p50(dumps)).padStart(7)} ${String(d.axBlind).padStart(7)} ${String(!!d.accessibilityRetry).padStart(5)} ${String(!!d.rawViewFallback).padStart(4)} | `
    + `${String(o.lines.length).padStart(7)} ${String(o.ocrMs).padStart(7)} ${String(o.wallMs).padStart(8)}  ${sample || o.error || ''}`,
  );
  results.perceive.push({
    app, uia: d.elements.length, actionable, dumpMs: p50(dumps), axBlind: !!d.axBlind,
    retry: !!d.accessibilityRetry, rawFallback: !!d.rawViewFallback,
    ocrLines: o.lines.length, ocrMs: o.ocrMs, ocrWallMs: o.wallMs,
  });
}

/* ══ 操作: 记事本, 判定看界面真的变了没有 ═══════════════════════════════ */
console.log('\n════ 操作 (记事本, 判定落在可观测的界面变化上) ════');
await call({ op: 'launch', app: 'notepad' });
await sleep(700);
let dnp = await call({ op: 'dump', app: 'notepad' });
let editId = dnp.elements.find((e) => e.role === 'Edit')?.id;
const readVal = async () => (await call({ op: 'read', target: editId, app: 'notepad' })).value ?? '';

/* ③ setValue —— 写进去再读回来, 值相等才算成功 */
{
  const ms = []; let ok = 0;
  for (let i = 0; i < 8; i++) {
    const mark = `SET${i}${Date.now() % 10000}`;
    const r = await call({ op: 'act', target: editId, action: 'setValue', text: mark, app: 'notepad' });
    if (r.ms) ms.push(r.ms);
    if ((await readVal()) === mark) ok++;
    await sleep(60);
  }
  console.log(`  set_value           成功 ${ok}/8  p50 ${p50(ms)}ms  ← 判定: 读回值相等 (ValuePattern, 不抢焦点)`);
  results.act.push({ name: 'set_value', ok, n: 8, ms: p50(ms) });
}

/* ④ type (SendInput 真键入) —— 先清空, 键入后再读回, 含标记才算成功 */
{
  const ms = []; let ok = 0;
  for (let i = 0; i < 8; i++) {
    const mark = `T${i}`;
    await call({ op: 'act', target: editId, action: 'setValue', text: '', app: 'notepad' });
    await sleep(80);
    const before = await readVal();
    const r = await call({ op: 'type', target: editId, text: mark, app: 'notepad' });
    if (r.ms) ms.push(r.ms);
    const after = await readVal();
    if (String(after).includes(mark) && before !== after) ok++;
    await sleep(60);
  }
  console.log(`  type (SendInput)    成功 ${ok}/8  p50 ${p50(ms)}ms  ← 判定: 清空后键入的内容出现在值里`);
  results.act.push({ name: 'type', ok, n: 8, ms: p50(ms) });
}

/* ⑤ 点"编辑"菜单: 元素定位 vs 比例定位 —— 判定: 菜单项出现 */
async function menuOpened() {
  const d = await call({ op: 'dump', app: 'notepad' });
  const items = d.elements.filter((e) => /撤销|剪切|复制|粘贴|全选/.test(e.label || ''));
  return items.length;
}
let staleRatio = null;
for (const how of ['click(元素)', 'click_at(比例)']) {
  let ok = 0; const ms = []; const vias = new Set();
  for (let i = 0; i < 6; i++) {
    const d = await call({ op: 'dump', app: 'notepad' });
    const item = d.elements.find((e) => e.role === 'MenuItem' && /编辑/.test(e.label || ''));
    const w = await rect('notepad');
    if (!item || !w) { await call({ op: 'key', key: 'esc', app: 'notepad' }); continue; }
    const dx = (item.x + item.w / 2 - w.l) / w.w;
    const dy = (item.y + item.h / 2 - w.t) / w.h;
    if (how.startsWith('click(')) staleRatio = { dx, dy };
    const r = how.startsWith('click(')
      ? await call({ op: 'click', target: item.id, app: 'notepad' })
      : await call({ op: 'click_at', app: 'notepad', dx, dy });
    if (r.ms) ms.push(r.ms);
    if (r.via) vias.add(r.via);
    if ((await menuOpened()) > 0) ok++;
    await call({ op: 'key', key: 'esc', app: 'notepad' });
    await sleep(150);
  }
  console.log(`  ${how.padEnd(18)} 成功 ${ok}/6  p50 ${p50(ms)}ms  via=${[...vias].join(',') || '-'}  ← 判定: 菜单项出现`);
  results.act.push({ name: how, ok, n: 6, ms: p50(ms), vias: [...vias] });
}

/* ══ 稳定性: 位移 vs 缩放 ═══════════════════════════════════════════════ */
async function tryBoth(title, times) {
  const out = [];
  for (const how of ['元素定位', '比例定位(挪动前的比例)']) {
    let ok = 0;
    for (let i = 0; i < times; i++) {
      const d = await call({ op: 'dump', app: 'notepad' });
      const item = d.elements.find((e) => e.role === 'MenuItem' && /编辑/.test(e.label || ''));
      if (!item) break;
      if (how === '元素定位') await call({ op: 'click', target: item.id, app: 'notepad' });
      else await call({ op: 'click_at', app: 'notepad', dx: staleRatio.dx, dy: staleRatio.dy });
      if ((await menuOpened()) > 0) ok++;
      await call({ op: 'key', key: 'esc', app: 'notepad' });
      await sleep(150);
    }
    out.push({ name: `${title}/${how}`, ok, n: times });
    console.log(`  ${how.padEnd(22)} 成功 ${ok}/${times}`);
  }
  results.stability.push(...out);
}
const before = await rect('notepad');
console.log(`\n════ 稳定性 ════\n  起始窗口 (${before.l},${before.t}) ${before.w}x${before.h}; 记下"编辑"菜单比例 dx=${staleRatio.dx.toFixed(3)} dy=${staleRatio.dy.toFixed(3)}`);
console.log('  ① 把窗口平移到 (300,200)');
moveTo('notepad', 300, 200); await sleep(500);
await tryBoth('平移后', 4);
console.log('  ② 把窗口缩放到 1200x760');
resizeTo('notepad', 1200, 760); await sleep(600);
await tryBoth('缩放后', 4);

await call({ op: 'quit' });
await sleep(200);
writeFileSync(join(SHOTS, 'bench-results.json'), JSON.stringify(results, null, 2));
console.log('\n原始数据 → ' + join(SHOTS, 'bench-results.json') + '\n');
process.exit(0);
