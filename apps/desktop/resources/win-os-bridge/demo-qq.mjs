import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(homedir(), '.neox', 'run', 'shots');
const APP = process.env.DEMO_APP || 'qq';

const bridge = spawn(join(DIR, 'neox-os-bridge.exe'), [], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const waiters = new Map();
bridge.stdout.setEncoding('utf8');
bridge.stdout.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.event) { console.log(`   [事件] ${m.action} ${m.label ?? ''} @${m.x ?? '-'},${m.y ?? '-'}`); continue; }
    const w = waiters.get(m.id);
    if (w) { waiters.delete(m.id); w(m); }
  }
});
let seq = 0;
const call = (req, t = 25000) => new Promise((res) => {
  const id = ++seq;
  const timer = setTimeout(() => { waiters.delete(id); res({ ok: false, code: 'timeout' }); }, t);
  waiters.set(id, (m) => { clearTimeout(timer); res(m); });
  bridge.stdin.write(JSON.stringify({ id, ...req }) + '\n');
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snap(tag = 'now') {
  const path = join(SHOTS, `qq-${tag}.jpg`);
  const d = await call({ op: 'dump', app: APP, budget: 800 });
  const s = await call({ op: 'screenshot', app: APP, path });
  console.log(`dump: ok=${d.ok} 元素=${d.elements?.length ?? '-'} axBlind=${d.axBlind} 重探=${d.accessibilityRetry} 换树=${d.rawViewFallback}`);
  console.log(`截图: ok=${s.ok} ${s.width}x${s.height} → ${path}`);
  return { d, s };
}

const [cmd, ...args] = process.argv.slice(2);
await sleep(300);

switch (cmd) {
  case 'snap': {
    const { d } = await snap(args[0] || 'snap');
    if (d.ok && d.elements?.length) {
      console.log('编号表:');
      for (const e of d.elements) {
        console.log(`   ${String(e.id).padStart(3)}. [${e.role}] ${(e.label || e.roleDesc || '(无标签)').slice(0, 40)}${e.actionable ? ' ←可点' : ''}${e.value ? ` value=${String(e.value).slice(0, 20)}` : ''}`);
      }
    }
    break;
  }
  case 'click': {
    const dx = Number(args[0]); const dy = Number(args[1]);
    const r = await call({ op: 'click_at', app: APP, dx, dy });
    console.log(`click_at(${dx}, ${dy}) →`, JSON.stringify(r));
    await sleep(400);
    await snap(args[2] || 'after-click');
    break;
  }
  case 'type': {
    const r = await call({ op: 'type', app: APP, text: args.join(' ') });
    console.log('type →', JSON.stringify(r));
    break;
  }
  case 'key': {
    const r = await call({ op: 'key', app: APP, key: args[0] });
    console.log('key →', JSON.stringify(r));
    break;
  }
  case 'shot': {
    const path = join(SHOTS, `qq-${args[0] || 'shot'}.jpg`);
    const s = await call({ op: 'screenshot', app: APP, path });
    console.log(`截图 → ${path} (${s.width}x${s.height})`);
    break;
  }
  default:
    console.log('用法: snap | click <dx> <dy> | type <文本> | key <键> | shot <名字>');
}

await call({ op: 'quit' });
await sleep(150);
process.exit(0);
