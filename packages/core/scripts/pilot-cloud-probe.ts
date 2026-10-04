/**
 * 扮手机跟住在云端的 Pilot 说几句, 量每句从发出到第一个字 / 说完的时间。
 *
 *   NEOX_JWT=<用户 access token> npx tsx packages/core/scripts/pilot-cloud-probe.ts <pilot_id> "第一句" "第二句" ...
 *
 * 走的就是手机那条路: POST /api/v1/pilot/pilots/:id/wake → 中继 (设备类型 mobile) → session.input。
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { decryptAesGcm, encryptAesGcm, makeEnvelope, parseEnvelope, randomNonce } from '../src/relay-transport/index.js';

const BASE = process.env.NEOX_API_BASE || 'https://neox-dev.com';
const jwt = process.env.NEOX_JWT || '';
const [pilotId, ...lines] = process.argv.slice(2);
if (!jwt || !pilotId || lines.length === 0) {
  console.error('用法: NEOX_JWT=... npx tsx packages/core/scripts/pilot-cloud-probe.ts <pilot_id> "一句话" ...');
  process.exit(1);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/v1/pilot/pilots/${encodeURIComponent(pilotId)}/wake`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timezone: 'Asia/Shanghai' }),
  });
  const w = await r.json() as any;
  if (!r.ok) throw new Error(`wake: HTTP ${r.status} ${JSON.stringify(w)}`);
  console.log(`[wake] ${Date.now() - t0}ms state=${w.state} session=${w.session_id}`);
  const key = Buffer.from(w.relay_session_key_b64, 'base64');
  /* 中继只认账号下登记过的设备 (device_presence); 测试用一个专门登记的, 别顶掉真手机 */
  const me = process.env.NEOX_PROBE_DEVICE || 'probe-mobile-pilot';

  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/relay/api/v1/relay`, {
    headers: { Authorization: `Bearer ${jwt}`, 'X-Neox-Device-Id': me, 'X-Neox-Device-Type': 'mobile' },
  });
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  console.log(`[relay] connected ${Date.now() - t0}ms`);

  const send = (msg: object) => {
    const nonce = randomNonce();
    const ct = encryptAesGcm(key, nonce, Buffer.from(JSON.stringify(msg)));
    ws.send(JSON.stringify(makeEnvelope({ toDeviceId: w.agent_device_id, fromDeviceId: me, nonce, ciphertext: ct })));
  };
  let onEvent: ((m: any) => void) | null = null;
  ws.on('message', (data) => {
    const env = parseEnvelope(data as any) as any;
    if (!env?.ciphertext) return;
    try {
      const m = JSON.parse(decryptAesGcm(key, Buffer.from(env.nonce, 'base64'), Buffer.from(env.ciphertext, 'base64')).toString());
      onEvent?.(m);
    } catch { /* 不是给我的 */ }
  });

  /* 容器刚醒要几秒: 先打招呼, 等它回 */
  for (let i = 0; i < 30; i++) {
    const ok = await new Promise<boolean>((res) => {
      const id = randomUUID();
      const timer = setTimeout(() => res(false), 2000);
      onEvent = (m) => { if (m.id === id) { clearTimeout(timer); res(true); } };
      send({ jsonrpc: '2.0', id, method: 'pilot.hello', params: { device_kind: 'mobile' } });
    });
    if (ok) break;
  }
  console.log(`[hello] ${Date.now() - t0}ms`);

  for (const line of lines) {
    const s = Date.now();
    let first = 0;
    let text = '';
    const tools: string[] = [];
    await new Promise<void>((res) => {
      const timer = setTimeout(() => { console.log('  (60s 没说完)'); res(); }, 60_000);
      onEvent = (m) => {
        if (m.error) { console.log('  error', m.error); clearTimeout(timer); res(); return; }
        const ev = m.params?.event ?? m.params;
        const kind = ev?.kind ?? ev?.type ?? m.method;
        const p = ev?.payload ?? ev;
        if (kind === 'agent_text_delta' && p?.content) { if (!first) first = Date.now() - s; text += p.content; }
        if (kind === 'tool_call' && p?.tool_name) tools.push(p.tool_name);
        if (kind === 'agent_turn_done') { clearTimeout(timer); res(); }
      };
      send({ jsonrpc: '2.0', id: randomUUID(), method: 'session.input', params: { session_id: w.session_id, kind: 'user_message', payload: { text: line, device: 'phone', client_id: randomUUID() } } });
    });
    console.log(`> ${line}\n  首字 ${first}ms  说完 ${Date.now() - s}ms${tools.length ? `  工具 ${tools.join(',')}` : ''}\n  ${text.trim().slice(0, 200)}`);
  }
  ws.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
