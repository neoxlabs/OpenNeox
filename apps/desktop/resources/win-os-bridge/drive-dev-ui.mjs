import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const APP = process.env.DEV_APP || 'electron';
const text = process.argv.slice(2).join(' ');

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
const call = (req, t = 20000) => new Promise((res) => {
  const id = ++seq;
  const timer = setTimeout(() => { waiters.delete(id); res({ ok: false, code: 'timeout', op: req.op }); }, t);
  waiters.set(id, (m) => { clearTimeout(timer); res(m); });
  bridge.stdin.write(JSON.stringify({ id, ...req }) + '\n');
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const launch = await call({ op: 'launch', app: APP });
console.log('launch →', JSON.stringify(launch).slice(0, 200));
await sleep(600);

/* 点一下输入框 (底边中部), 再打字 —— 不点也行, 但点了更稳 (光标一定在 composer 里) */
const click = await call({ op: 'click_at', app: APP, dx: 0.5, dy: 0.94 });
console.log('click composer →', JSON.stringify(click).slice(0, 160));
await sleep(400);

if (text) {
  const t = await call({ op: 'type', app: APP, text });
  console.log('type →', JSON.stringify(t).slice(0, 200));
  await sleep(500);
  const k = await call({ op: 'key', app: APP, key: 'return' });
  console.log('enter →', JSON.stringify(k).slice(0, 160));
}

await call({ op: 'quit' });
await sleep(150);
process.exit(0);
