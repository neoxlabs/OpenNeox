/**
 * neox-os-bridge 冒烟测试 —— 走完整 JSON-lines 协议做一件真事。
 *
 * 做的事: 在 TextEdit 里新建文档 → 后台打字 → 读回文本 → 按关闭 → 在"是否存储"
 * 询问上按"不存储" → 确认文档关掉了。全程**目标 App 不在前台**, 用户光标不动。
 *
 * 为什么要有这个: 单元测试测不出 AX/TCC 这一层。这里每一步都是真进程真事件,
 * 失败了就是真的坏了。
 *
 * 用法: node apps/desktop/resources/os-bridge/smoke.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const BIN = join(DIR, 'neox-os-bridge');

const bridge = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const waiters = new Map();
bridge.stdout.setEncoding('utf8');
bridge.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  }
});
let seq = 0;
const call = (req) => new Promise((res) => {
  const id = ++seq; waiters.set(id, res);
  bridge.stdin.write(JSON.stringify({ id, ...req }) + '\n');
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const osa = (s) => { try { execFileSync('osascript', ['-e', s], { stdio: 'pipe', timeout: 5000 }); } catch { /* ignore */ } };

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

await sleep(250);

const probe = await call({ op: 'probe' });
console.log(`授权: 辅助功能=${probe.trusted} 屏幕录制=${probe.screenRecording}`);
if (!probe.trusted) {
  console.error('没有辅助功能授权 —— 系统设置 → 隐私与安全性 → 辅助功能, 勾选跑这个脚本的终端/Neox');
  process.exit(2);
}

console.log('\n准备: 打开 TextEdit 新文档, 然后把前台切走');
/* 起点必须干净: 上一次跑崩留下的文档会被 TextEdit 自动恢复,
 * 于是第 6 步"文档已关闭"永远失败 —— 那是脏起点, 不是回归。 */
osa('tell application "TextEdit" to close every document without saving');
osa('tell application "TextEdit" to activate');
osa('tell application "TextEdit" to make new document');
await sleep(900);
osa('tell application "Finder" to activate');
await sleep(600);

const frontBefore = execFileSync('osascript', ['-e',
  'tell application "System Events" to get name of first process whose frontmost is true'], { encoding: 'utf8' }).trim();
console.log(`前台 App = ${frontBefore} (目标 TextEdit 在后台)\n`);

console.log('1) dump TextEdit');
const d = await call({ op: 'dump', app: 'TextEdit' });
check('dump 成功', d.ok, d.ok ? `${d.ms}ms, ${d.elements.length} 个元素, epoch=${d.epoch}` : `${d.code}: ${d.error}`);
if (!d.ok) process.exit(1);

const area = d.elements.find((e) => e.role === 'AXTextArea');
check('找到文本区域', !!area, area ? `#${area.id}` : '没有 AXTextArea');

console.log('\n2) 后台打字 (目标不在前台)');
const TEXT = 'Neox os-bridge smoke 2026';
const t = await call({ op: 'type', target: area?.id, text: TEXT });
check('type 返回成功', t.ok, `${t.ms}ms`);
await sleep(350);

console.log('\n3) 读回文本验证真的打进去了');
const r = await call({ op: 'read', target: area?.id });
check('文本落在目标 App 里', r.ok && String(r.value || '').includes(TEXT), `读回 "${String(r.value || '').slice(0, 60)}"`);

console.log('\n4) AX 动作: 按窗口关闭按钮');
/* 匹配必须看 label **和** roleDesc: 窗口按钮没有内容标签, 文案只在 AXRoleDescription
 * 里 ("close button")。只看 label 会找不到 —— 这条正是把 roleDesc 从 label 里摘出去
 * (它会污染变化断言) 之后暴露出来的, 两边都得照顾到。 */
const name = (e) => `${e.label} ${e.roleDesc ?? ''}`;
const closeBtn = d.elements.find((e) => e.role === 'AXButton' && /close button/i.test(name(e)));
check('找到关闭按钮', !!closeBtn, closeBtn ? `#${closeBtn.id}` : '没找到');
const c = await call({ op: 'act', target: closeBtn?.id, action: 'press' });
check('AXPress 成功', c.ok, c.ok ? `${c.ms}ms` : `${c.code}: ${c.error}`);
await sleep(700);

console.log('\n5) 重新 dump, 在"是否存储"询问上按「不存储」');
const d2 = await call({ op: 'dump', app: 'TextEdit' });
check('sheet 出现后能重新 dump', d2.ok, d2.ok ? `epoch=${d2.epoch}` : `${d2.code}`);
/* 这三个按钮的 AXTitle 全是空 —— 文案只在 AXDescription 里。
 * 只按 title 找会判成"没找到", 这就是 axLabel 必须取四个来源并集的原因。 */
const dont = d2.elements?.find((e) => e.role === 'AXButton' && /^(Delete|Don't Save|不存储|不儲存)$/i.test(e.label.trim()));
check('找到「不存储」按钮 (标签来自 AXDescription 不是 AXTitle)', !!dont, dont ? `#${dont.id} "${dont.label}"` : `sheet 按钮: ${d2.elements?.filter(e => e.role === 'AXButton').map(e => e.label).join(' / ')}`);
if (dont) {
  const p2 = await call({ op: 'act', target: dont.id, action: 'press' });
  check('AXPress(不存储) 成功', p2.ok, p2.ok ? `${p2.ms}ms` : `${p2.code}`);
}
await sleep(800);

console.log('\n6) 确认收尾');
const d3 = await call({ op: 'dump', app: 'TextEdit' });
check('文档已关闭', !d3.ok && d3.code === 'no_window', d3.ok ? `还剩 ${d3.elements.length} 个元素` : d3.code);

const frontAfter = execFileSync('osascript', ['-e',
  'tell application "System Events" to get name of first process whose frontmost is true'], { encoding: 'utf8' }).trim();
/* 判据只能是"**目标 App** 有没有把焦点抢过去" —— 别的应用 (更新提示、通知) 自己弹到
 * 前台不归我们管, 拿"前台有没有变过"当判据会变成一条随机红。 */
check('目标 App 没有抢走焦点', frontAfter !== 'TextEdit', `${frontBefore} → ${frontAfter}`);

console.log('\n7) 过期编号必须明确报错, 不能静默失败');
const stale = await call({ op: 'act', target: d.elements[0].id, action: 'press' });
/* 注意: 这里不断言一定失败 —— 同一个编号在新 epoch 里可能仍然有效。
   断言的是"如果失败, 原因必须是 stale_handle 且带处置指引"。 */
check('过期编号报 stale_handle 且给指引', stale.ok || (stale.code === 'stale_handle' && !!stale.hint), stale.ok ? '(新表里仍有效)' : stale.code);

await call({ op: 'quit' });
osa('tell application "TextEdit" to quit');
console.log(`\n${failures === 0 ? '✓ 全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
