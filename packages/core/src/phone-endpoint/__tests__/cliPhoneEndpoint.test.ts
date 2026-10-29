/**
 * CLI 入口端到端: 本地起一个假中转 (只做 to_device_id / to_endpoint 路由), 假手机用子密钥
 * 加密发 RPC, 断言 CLI 入口的回包、推送、历史都对, 且回包带 from_endpoint。
 */
import { describe, expect, test, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { CliPhoneEndpoint, type CliPhoneEndpointOptions } from '../cliPhoneEndpoint.js';
import { decryptAesGcm, deriveCliEndpointKey, encryptAesGcm, makeEnvelope, randomNonce } from '../../relay-transport/index.js';

let cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });

function fakeRelay(): Promise<{ url: string; headers: Record<string, string>[] }> {
  const conns = new Map<string, WebSocket>();
  const headers: Record<string, string>[] = [];
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws, req) => {
    const dev = String(req.headers['x-neox-device-id']);
    const ep = String(req.headers['x-neox-endpoint'] ?? '');
    headers.push({ dev, ep, type: String(req.headers['x-neox-device-type']) });
    conns.set(ep ? `${dev}#${ep}` : dev, ws);
    ws.on('message', (raw) => {
      const env = JSON.parse(String(raw));
      const key = env.to_endpoint ? `${env.to_device_id}#${env.to_endpoint}` : env.to_device_id;
      conns.get(key)?.send(String(raw));
    });
  });
  cleanup.push(() => wss.close());
  return new Promise((resolve) => wss.on('listening', () => resolve({ url: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`, headers })));
}

describe('CliPhoneEndpoint', () => {
  test('phone lists, sends a message, gets streamed + history events; replies carry from_endpoint', async () => {
    const relay = await fakeRelay();
    const pairingKey = crypto.randomBytes(32);
    const sub = deriveCliEndpointKey(pairingKey);
    const received: string[] = [];
    let ep!: CliPhoneEndpoint;
    ep = new CliPhoneEndpoint({
      apiBaseUrl: relay.url,
      getAccessToken: async () => 'jwt',
      userId: 'u1',
      peers: { version: 1, device_id: 'mac', device_name: 'Mac', updated_at: 0,
        peers: [{ device_id: 'phone', owner_user_id: 'u1', key_b64: sub.toString('base64') },
                { device_id: 'other-account-phone', owner_user_id: 'u2', key_b64: sub.toString('base64') }] },
      getSession: () => ({ id: 's1', title: '修 bug', workspacePath: '/Users/me/proj' }),
      onUserMessage: (text) => {
        received.push(text);
        ep.translator.turnStart('t1', text, 'phone');
        ep.translator.handle({ type: 'text', delta: '好' } as any, 't1');
        ep.translator.handle({ type: 'text', delta: '的' } as any, 't1');
        ep.translator.handle({ type: 'text_complete' } as any, 't1');
        ep.translator.turnEnd('t1');
      },
      onStop: () => {},
    });
    cleanup.push(() => ep.dispose());
    expect(ep.phoneCount()).toBe(1); /* 别的账号配的手机不认 */
    ep.start();

    const phone = new WebSocket(relay.url.replace('http', 'ws'), { headers: { 'x-neox-device-id': 'phone', 'x-neox-endpoint': 'app:cli' } });
    cleanup.push(() => phone.close());
    await new Promise((r) => phone.on('open', r));
    const inbox: any[] = [];
    phone.on('message', (raw) => {
      const env = JSON.parse(String(raw));
      expect(env.from_endpoint).toBe(ep.endpointId);
      inbox.push(JSON.parse(decryptAesGcm(sub, Buffer.from(env.nonce, 'base64'), Buffer.from(env.ciphertext, 'base64')).toString('utf8')));
    });
    const send = (msg: object) => {
      const nonce = randomNonce();
      phone.send(JSON.stringify(makeEnvelope({ toDeviceId: 'mac', toEndpoint: ep.endpointId, fromDeviceId: 'phone', fromEndpoint: 'app:cli', nonce, ciphertext: encryptAesGcm(sub, nonce, Buffer.from(JSON.stringify(msg))) })));
    };
    const until = async (pred: () => boolean) => { const t = Date.now(); while (!pred() && Date.now() - t < 3000) await new Promise((r) => setTimeout(r, 20)); };

    await until(() => relay.headers.some((h) => h.ep === ep.endpointId));
    expect(relay.headers.find((h) => h.ep === ep.endpointId)?.type).toBe('desktop');

    send({ jsonrpc: '2.0', id: 1, method: 'session.list' });
    await until(() => inbox.some((m) => m.id === 1));
    const list = inbox.find((m) => m.id === 1).result.sessions;
    expect(list[0]).toMatchObject({ id: 's1', title: '修 bug', workspace_name: 'proj', source: 'cli', endpoint: ep.endpointId });

    send({ jsonrpc: '2.0', id: 2, method: 'session.input', params: { session_id: 's1', kind: 'user_message', payload: { text: '帮我看下' } } });
    await until(() => inbox.some((m) => m.params?.kind === 'agent_turn_done'));
    expect(received).toEqual(['帮我看下']);
    const kinds = inbox.filter((m) => m.method === 'session.event').map((m) => m.params.kind);
    /* 两个 delta 合并成一条 (60ms 窗口), 再是成型的 agent_text */
    expect(kinds.filter((k) => k === 'agent_text_delta').length).toBe(1);
    expect(inbox.find((m) => m.params?.kind === 'agent_text_delta').params.payload.content).toBe('好的');
    expect(kinds).toContain('agent_text');

    send({ jsonrpc: '2.0', id: 3, method: 'session.history', params: { session_id: 's1' } });
    await until(() => inbox.some((m) => m.id === 3));
    const hist = inbox.find((m) => m.id === 3).result.messages.map((e: any) => e.kind);
    expect(hist).toEqual(['user_message', 'agent_text']);
  });

  test('phone answers ask_user; a late subscribe still gets the pending card (REMOTE-01)', async () => {
    const relay = await fakeRelay();
    const sub = deriveCliEndpointKey(crypto.randomBytes(32));
    const replies: Array<{ id: string; answers: unknown }> = [];
    const ep = new CliPhoneEndpoint({
      apiBaseUrl: relay.url,
      getAccessToken: async () => 'jwt',
      userId: 'u1',
      peers: { version: 1, device_id: 'mac', device_name: 'Mac', updated_at: 0,
        peers: [{ device_id: 'phone', owner_user_id: 'u1', key_b64: sub.toString('base64') }] },
      getSession: () => ({ id: 's1', title: '修 bug', workspacePath: '/Users/me/proj' }),
      onUserMessage: () => {},
      onStop: () => {},
      onAskUserReply: (requestId, answers) => replies.push({ id: requestId, answers }),
    });
    cleanup.push(() => ep.dispose());
    ep.start();

    const phone = new WebSocket(relay.url.replace('http', 'ws'), { headers: { 'x-neox-device-id': 'phone', 'x-neox-endpoint': 'app:cli' } });
    cleanup.push(() => phone.close());
    await new Promise((r) => phone.on('open', r));
    const inbox: any[] = [];
    phone.on('message', (raw) => {
      const env = JSON.parse(String(raw));
      inbox.push(JSON.parse(decryptAesGcm(sub, Buffer.from(env.nonce, 'base64'), Buffer.from(env.ciphertext, 'base64')).toString('utf8')));
    });
    const send = (msg: object) => {
      const nonce = randomNonce();
      phone.send(JSON.stringify(makeEnvelope({ toDeviceId: 'mac', toEndpoint: ep.endpointId, fromDeviceId: 'phone', fromEndpoint: 'app:cli', nonce, ciphertext: encryptAesGcm(sub, nonce, Buffer.from(JSON.stringify(msg))) })));
    };
    const until = async (pred: () => boolean) => { const t = Date.now(); while (!pred() && Date.now() - t < 3000) await new Promise((r) => setTimeout(r, 20)); };
    await until(() => relay.headers.some((h) => h.ep === ep.endpointId));

    send({ jsonrpc: '2.0', id: 1, method: 'session.subscribe', params: { session_id: 's1' } });
    await until(() => inbox.some((m) => m.id === 1));
    expect(inbox.find((m) => m.id === 1).result.pending_actions.ask_user).toEqual([]);

    ep.translator.turnStart('t1', '要不要保留兼容', 'cli');
    ep.translator.handle({
      type: 'ask_user_needed', requestId: 'req-1',
      questions: [{ question: '要不要保留兼容', options: [{ label: '保留' }] }],
    } as any, 't1');
    await until(() => inbox.some((m) => m.params?.kind === 'ask_user_needed'));
    expect(inbox.find((m) => m.params?.kind === 'ask_user_needed').params.payload.request_id).toBe('req-1');

    /* 手机是问完之后才打开会话的: subscribe 必须把这张卡补出来 */
    send({ jsonrpc: '2.0', id: 2, method: 'session.subscribe', params: { session_id: 's1' } });
    await until(() => inbox.some((m) => m.id === 2));
    expect(inbox.find((m) => m.id === 2).result.pending_actions.ask_user.map((a: any) => a.request_id)).toEqual(['req-1']);

    send({
      jsonrpc: '2.0', id: 3, method: 'session.input',
      params: { session_id: 's1', kind: 'control:ask_user_reply', payload: { request_id: 'req-1', answers: { '要不要保留兼容': '保留' } } },
    });
    await until(() => replies.length === 1);
    expect(replies[0]).toEqual({ id: 'req-1', answers: { '要不要保留兼容': '保留' } });

    send({ jsonrpc: '2.0', id: 4, method: 'session.subscribe', params: { session_id: 's1' } });
    await until(() => inbox.some((m) => m.id === 4));
    expect(inbox.find((m) => m.id === 4).result.pending_actions.ask_user).toEqual([]);
  });

  test('terminal answers first: phone gets ask_user_answered with answers, card leaves pending (2026-10-18)', async () => {
    const relay = await fakeRelay();
    const sub = deriveCliEndpointKey(crypto.randomBytes(32));
    const ep = new CliPhoneEndpoint({
      apiBaseUrl: relay.url,
      getAccessToken: async () => 'jwt',
      userId: 'u1',
      peers: { version: 1, device_id: 'mac', device_name: 'Mac', updated_at: 0,
        peers: [{ device_id: 'phone', owner_user_id: 'u1', key_b64: sub.toString('base64') }] },
      getSession: () => ({ id: 's1', title: '修 bug', workspacePath: '/Users/me/proj' }),
      onUserMessage: () => {},
      onStop: () => {},
      onAskUserReply: () => {},
    });
    cleanup.push(() => ep.dispose());
    ep.start();

    const phone = new WebSocket(relay.url.replace('http', 'ws'), { headers: { 'x-neox-device-id': 'phone', 'x-neox-endpoint': 'app:cli' } });
    cleanup.push(() => phone.close());
    await new Promise((r) => phone.on('open', r));
    const inbox: any[] = [];
    phone.on('message', (raw) => {
      const env = JSON.parse(String(raw));
      inbox.push(JSON.parse(decryptAesGcm(sub, Buffer.from(env.nonce, 'base64'), Buffer.from(env.ciphertext, 'base64')).toString('utf8')));
    });
    const send = (msg: object) => {
      const nonce = randomNonce();
      phone.send(JSON.stringify(makeEnvelope({ toDeviceId: 'mac', toEndpoint: ep.endpointId, fromDeviceId: 'phone', fromEndpoint: 'app:cli', nonce, ciphertext: encryptAesGcm(sub, nonce, Buffer.from(JSON.stringify(msg))) })));
    };
    const until = async (pred: () => boolean) => { const t = Date.now(); while (!pred() && Date.now() - t < 3000) await new Promise((r) => setTimeout(r, 20)); };
    await until(() => relay.headers.some((h) => h.ep === ep.endpointId));

    /* 事件只广播给订阅了这个 session 的手机 */
    send({ jsonrpc: '2.0', id: 1, method: 'session.subscribe', params: { session_id: 's1' } });
    await until(() => inbox.some((m) => m.id === 1));

    ep.translator.turnStart('t1', '要不要保留兼容', 'cli');
    ep.translator.handle({
      type: 'ask_user_needed', requestId: 'req-9',
      questions: [{ question: '要不要保留兼容', options: [{ label: '保留' }] }],
    } as any, 't1');
    await until(() => inbox.some((m) => m.params?.kind === 'ask_user_needed'));

    ep.askUserAnswered('req-9', { '要不要保留兼容': '保留' });
    await until(() => inbox.some((m) => m.params?.kind === 'ask_user_answered'));
    const evt = inbox.find((m) => m.params?.kind === 'ask_user_answered');
    expect(evt.params.payload).toEqual({ request_id: 'req-9', answers: { '要不要保留兼容': '保留' } });

    send({ jsonrpc: '2.0', id: 2, method: 'session.subscribe', params: { session_id: 's1' } });
    await until(() => inbox.some((m) => m.id === 2));
    expect(inbox.find((m) => m.id === 2).result.pending_actions.ask_user).toEqual([]);
  });

  test('history is persisted and survives a CLI restart; re-seeding does not duplicate it (REMOTE-02)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-phone-hist-'));
    const historyFile = path.join(dir, 's1.jsonl');
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const make = (extra: Partial<CliPhoneEndpointOptions> = {}) => new CliPhoneEndpoint({
      apiBaseUrl: 'http://127.0.0.1:1',
      getAccessToken: async () => null,
      userId: 'u1',
      peers: { version: 1, device_id: 'mac', device_name: 'Mac', updated_at: 0, peers: [] },
      getSession: () => ({ id: 's1', title: '修 bug', workspacePath: '/tmp/proj' }),
      onUserMessage: () => {},
      onStop: () => {},
      historyFile,
      ...extra,
    });

    const first = make();
    first.translator.seedBatch([{ role: 'user', text: '旧消息', ts: 1 }, { role: 'assistant', text: '旧回复', ts: 2 }]);
    first.translator.turnStart('t1', '新问题', 'cli');
    first.translator.handle({ type: 'tool_call_start', toolId: 'tc1', name: 'read_file', args: {} } as any, 't1');
    first.translator.handle({ type: 'tool_call_end', toolId: 'tc1', name: 'read_file', success: true, output: 'ok' } as any, 't1');
    first.translator.handle({ type: 'text', delta: '做完了' } as any, 't1');
    first.translator.handle({ type: 'text_complete' } as any, 't1');
    first.translator.turnEnd('t1');
    const seqBefore = first.translator.latestSeq();
    first.dispose();

    /* 模拟 CLI 重启: 新进程 / 新 endpoint, 同一个会话 */
    const second = make();
    cleanup.push(() => second.dispose());
    const restored = second.translator.getHistory();
    expect(restored.map((e) => e.kind)).toEqual([
      'user_message', 'agent_text', 'user_message', 'tool_call', 'tool_result', 'agent_text',
    ]);
    expect(second.translator.latestSeq()).toBe(seqBefore);

    /* 重开 /rc 会再灌一遍会话库最近的消息 —— 已有的尾部不能被灌第二遍 */
    second.translator.seedBatch([
      { role: 'user', text: '旧消息' }, { role: 'assistant', text: '旧回复' },
      { role: 'user', text: '新问题' }, { role: 'assistant', text: '做完了' },
      { role: 'user', text: '再来' },
    ]);
    const after = second.translator.getHistory();
    expect(after.filter((e) => e.kind === 'user_message' && e.payload.text === '旧消息')).toHaveLength(1);
    expect(after.at(-1)).toMatchObject({ kind: 'user_message', payload: { text: '再来' } });

    /* 断电写了半行: 坏行丢掉, 前面的照读 */
    fs.appendFileSync(historyFile, '{"seq":999,"kind":\n');
    const third = make();
    cleanup.push(() => third.dispose());
    expect(third.translator.latestSeq()).toBe(second.translator.latestSeq());
    expect(third.translator.getHistory().length).toBe(after.length);
  });
});
