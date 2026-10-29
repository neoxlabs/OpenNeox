/**
 * sttStreamManager — 主进程侧的流式语音识别 (STT) WS 代理。
 *
 * 两条流式路径 (按 config.stt.provider 分流):
 *   official: 渲染端(mic 16k PCM) ──IPC──> 主进程 ──WS(Bearer nxk)──> 网关 /n1/asr/stream ──> 火山
 *   xfyun:    渲染端 ──IPC──> 主进程 ──WS(hmac-sha256 签名)──> 讯飞 IAT wss://iat-api.xfyun.cn/v2/iat
 *             (BYOK 真流式逐字, 免登录, 国内直连; dwa=wpgs 动态修正, sn/pgs/rg 组装全文)
 *
 * 为什么走主进程而不是渲染端直连:浏览器 WebSocket API 不能设自定义请求头/需要签名密钥,
 * 主进程用 Node `ws` 可以带头, 且密钥不出主进程。
 *
 * IPC:
 *   stt:stream-start (model) -> { ok, streamId?, error? }   主进程开 WS
 *   stt:stream-audio (streamId, Uint8Array)  fire-and-forget 推 PCM (16k mono 16bit LE)
 *   stt:stream-stop  (streamId) -> { ok }
 *   主→渲染 事件 'stt:stream-event' { streamId, type:'open'|'transcript'|'final'|'error'|'close', text?, isFinal?, message? }
 */

/* 走桥的 ipcMain 替身; 类型是纯类型导入, 编译后完全擦除, 不把 electron 拉进运行时。 */
import { ipcMain } from '../ipc/ipcMainBridged.js';
import type { WebContents } from 'electron';
import { WebSocket } from 'ws';
import { createHmac, randomUUID } from 'node:crypto';
import { loadConfig, type STTConfig, type STTProfile } from '@neoxlabs/platform/utils/config.js';
import { unwrapApiKey } from '@neoxlabs/platform/utils/apiKeyCrypto.js';
import { getGatewayKey } from '../ipc/gatewayKeyHandlers.js';
import { getGatewayWsBase } from './neoxRoutingService.js';
import { effectiveAsrId, transcribeLocal, isPlatformSupported } from './localVoiceService.js';

interface ActiveStream {
  push: (chunk: ArrayBuffer | Uint8Array) => void;
  stop: () => void;
  close: () => void;
}

const streams = new Map<string, ActiveStream>();
let streamSeq = 0;

function send(wc: WebContents, payload: Record<string, unknown>): void {
  if (!wc.isDestroyed()) {
    try { wc.send('stt:stream-event', payload); } catch { /* window closing */ }
  }
}

/* ==================== 讯飞 IAT (BYOK 真流式) ==================== */

const XFYUN_HOST = 'iat-api.xfyun.cn';
const XFYUN_PATH = '/v2/iat';

export function buildXfyunUrl(apiKey: string, apiSecret: string): string {
  const date = new Date().toUTCString();
  const origin = `host: ${XFYUN_HOST}\ndate: ${date}\nGET ${XFYUN_PATH} HTTP/1.1`;
  const signature = createHmac('sha256', apiSecret).update(origin).digest('base64');
  const authOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authOrigin).toString('base64');
  return `wss://${XFYUN_HOST}${XFYUN_PATH}?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${XFYUN_HOST}`;
}

interface XfyunCreds { appId: string; apiKey: string; apiSecret: string }

export function getXfyunCreds(): XfyunCreds | null {
  const stt = loadConfig().stt;
  if (stt?.provider !== 'xfyun') return null;
  const appId = (stt.appId || '').trim();
  /* apiKey/apiSecret 盘上是 enc:v1 密文 — 解出真值签名; 旧明文配置 unwrap 原样透传 */
  const apiKey = unwrapApiKey(stt.apiKey).trim();
  const apiSecret = unwrapApiKey(stt.apiSecret).trim();
  return appId && apiKey && apiSecret ? { appId, apiKey, apiSecret } : null;
}

/** 讯飞 wpgs 动态修正结果组装器: sn 槽位 + pgs='rpl' 时按 rg 范围替换 */
function createXfyunAssembler() {
  const segs = new Map<number, string>();
  return {
    ingest(result: { sn?: number; pgs?: string; rg?: [number, number]; ws?: Array<{ cw?: Array<{ w?: string }> }> }): string {
      const text = (result.ws || []).map(w => w.cw?.[0]?.w || '').join('');
      if (result.pgs === 'rpl' && Array.isArray(result.rg)) {
        for (let i = result.rg[0]; i <= result.rg[1]; i++) segs.delete(i);
      }
      if (typeof result.sn === 'number') segs.set(result.sn, text);
      return [...segs.keys()].sort((a, b) => a - b).map(k => segs.get(k)).join('');
    },
  };
}

function startXfyunStream(creds: XfyunCreds, wc: WebContents): { ok: boolean; streamId?: string; error?: string } {
  const streamId = `stt-xf-${Date.now()}-${++streamSeq}`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(buildXfyunUrl(creds.apiKey, creds.apiSecret));
  } catch (e: any) {
    return { ok: false, error: e?.message || '讯飞 WS 连接失败' };
  }

  let sentFirst = false;
  let opened = false;
  const pending: Array<ArrayBuffer | Uint8Array> = [];  /* WS 握手期到达的音频不丢 */
  const assembler = createXfyunAssembler();

  const sendFrame = (chunk: ArrayBuffer | Uint8Array | null, status: 0 | 1 | 2) => {
    const frame: Record<string, unknown> = {
      data: {
        status,
        format: 'audio/L16;rate=16000',
        encoding: 'raw',
        audio: chunk ? Buffer.from(chunk as ArrayBuffer).toString('base64') : '',
      },
    };
    if (!sentFirst) {
      frame.common = { app_id: creds.appId };
      /* vad_eos 拉满 10s — 收口时机由客户端 VAD (700ms) 决定, 不让服务端抢跑 */
      frame.business = { language: 'zh_cn', domain: 'iat', accent: 'mandarin', vad_eos: 10000, dwa: 'wpgs', ptt: 1 };
      sentFirst = true;
    }
    try { ws.send(JSON.stringify(frame)); } catch { /* dropped */ }
  };

  ws.on('open', () => {
    opened = true;
    send(wc, { streamId, type: 'open' });
    for (const c of pending.splice(0)) sendFrame(c, sentFirst ? 1 : 0);
  });
  ws.on('message', (data: Buffer | string) => {
    try {
      const msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf-8'));
      if (msg.code !== 0) {
        send(wc, { streamId, type: 'error', message: `讯飞识别错误 ${msg.code}: ${msg.message || ''}` });
        return;
      }
      const d = msg.data;
      if (d?.result) {
        const full = assembler.ingest(d.result);
        if (d.status === 2) {
          send(wc, { streamId, type: 'final', text: full, isFinal: true });
          try { ws.close(); } catch { /* noop */ }
        } else if (full) {
          send(wc, { streamId, type: 'transcript', text: full });
        }
      } else if (d?.status === 2) {
        send(wc, { streamId, type: 'final', text: '', isFinal: true });
        try { ws.close(); } catch { /* noop */ }
      }
    } catch { /* 非 JSON 忽略 */ }
  });
  ws.on('error', (err: Error) => send(wc, { streamId, type: 'error', message: err.message }));
  ws.on('close', () => {
    send(wc, { streamId, type: 'close' });
    streams.delete(streamId);
  });

  streams.set(streamId, {
    push: (chunk) => {
      if (!opened) { pending.push(chunk); return; }
      if (ws.readyState === WebSocket.OPEN) sendFrame(chunk, sentFirst ? 1 : 0);
    },
    stop: () => {
      if (ws.readyState === WebSocket.OPEN) sendFrame(null, 2);
      /* 讯飞在 status=2 后回 final 并由我们 close; 兜底定时关 */
      setTimeout(() => { try { ws.close(); } catch { /* noop */ } }, 4000);
    },
    close: () => { try { ws.close(); } catch { /* noop */ } },
  });
  return { ok: true, streamId };
}

/** 讯飞整段转写 (composer 输入框麦克风按钮复用同一凭证):
 *  开一条 IAT 流, 按 ~10x 实时速率灌完整段 PCM, 等 final。 */
export function xfyunTranscribeOnce(pcm: Buffer, creds: XfyunCreds): Promise<string> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(buildXfyunUrl(creds.apiKey, creds.apiSecret));
    } catch (e: any) { reject(new Error(e?.message || '讯飞 WS 连接失败')); return; }
    const assembler = createXfyunAssembler();
    let full = '';
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* noop */ }
      if (err) reject(err); else resolve(full);
    };
    const timer = setTimeout(() => settle(new Error('讯飞识别超时')), 30_000);
    ws.on('open', () => {
      let off = 0;
      let first = true;
      const FRAME = 12800; /* 400ms 音频/帧, 40ms 一发 ≈ 10x 实时 */
      const pump = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) { clearInterval(pump); return; }
        const slice = pcm.subarray(off, off + FRAME);
        off += FRAME;
        const done = off >= pcm.length;
        const frame: Record<string, unknown> = {
          data: { status: done ? 2 : (first ? 0 : 1), format: 'audio/L16;rate=16000', encoding: 'raw', audio: slice.toString('base64') },
        };
        if (first) {
          frame.common = { app_id: creds.appId };
          frame.business = { language: 'zh_cn', domain: 'iat', accent: 'mandarin', vad_eos: 10000, dwa: 'wpgs', ptt: 1 };
          first = false;
        }
        try { ws.send(JSON.stringify(frame)); } catch { /* noop */ }
        if (done) clearInterval(pump);
      }, 40);
    });
    ws.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf-8'));
        if (msg.code !== 0) { clearTimeout(timer); settle(new Error(`讯飞识别错误 ${msg.code}: ${msg.message || ''}`)); return; }
        if (msg.data?.result) full = assembler.ingest(msg.data.result);
        if (msg.data?.status === 2) { clearTimeout(timer); settle(); }
      } catch { /* noop */ }
    });
    ws.on('error', (err: Error) => { clearTimeout(timer); settle(err); });
    ws.on('close', () => { clearTimeout(timer); settle(); });
  });
}

/* ==================== 官方网关流式 ==================== */

export async function gatewayTranscribeOnce(pcm: Buffer, model = 'fun-asr-realtime'): Promise<string> {
  const key = await getGatewayKey();
  if (!key?.secret) throw new Error('语音识别需要登录 NeoxCloud 订阅');
  const url = `${getGatewayWsBase()}/asr/stream?model=${encodeURIComponent(model)}`;
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key.secret}` } });
    } catch (e: any) { reject(new Error(e?.message || 'WS 连接失败')); return; }
    let full = '';
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* noop */ }
      if (err) reject(err); else resolve(full);
    };
    const timer = setTimeout(() => settle(new Error('语音识别超时')), 30_000);
    ws.on('open', () => {
      /* 3200 字节 = 100ms 音频; 一口气灌完, 网关按收到的顺序转给上游 */
      for (let off = 0; off < pcm.length; off += 3200) {
        try { ws.send(pcm.subarray(off, off + 3200)); } catch { /* noop */ }
      }
      try { ws.send(JSON.stringify({ type: 'stop' })); } catch { /* noop */ }
    });
    ws.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf-8'));
        if (msg?.type === 'error') { settle(new Error(String(msg.message || '语音识别出错'))); return; }
        if (typeof msg?.text === 'string') full = msg.text.trim();
        if (msg?.isFinal || msg?.type === 'final') settle();
      } catch { /* 非 JSON 忽略 */ }
    });
    ws.on('error', (err: Error) => settle(err));
    ws.on('close', () => settle());
  });
}

async function startGatewayStream(model: string, wc: WebContents): Promise<{ ok: boolean; streamId?: string; error?: string }> {
  const key = await getGatewayKey();
  if (!key?.secret) {
    return { ok: false, error: '语音识别需要登录 NeoxCloud 订阅' };
  }
  const base = getGatewayWsBase();
  const url = `${base}/asr/stream?model=${encodeURIComponent(model || 'fun-asr-realtime')}`;
  const streamId = `stt-${Date.now()}-${++streamSeq}`;

  let ws: WebSocket;
  try {
    ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key.secret}` } });
  } catch (e: any) {
    return { ok: false, error: e?.message || 'WS 连接失败' };
  }

  const pending: Buffer[] = [];
  let stopRequested = false;
  ws.on('open', () => {
    send(wc, { streamId, type: 'open' });
    for (const c of pending.splice(0)) {
      try { ws.send(c); } catch { /* dropped */ }
    }
    if (stopRequested) {
      try { ws.send(JSON.stringify({ type: 'stop' })); } catch { /* noop */ }
      setTimeout(() => { try { ws.close(); } catch { /* noop */ } }, 4000);
    }
  });
  ws.on('message', (data: Buffer | string) => {
    // 网关回吐 JSON 文本帧 { type:'transcript'|'final'|'error', text, isFinal }
    try {
      const msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf-8'));
      /* 网关收尾是 {type:'transcript', isFinal:true}; 其它几家都发 'final', 输入框 / 语音命令 (「发送吧」) 只认 'final' */
      if (msg?.type === 'transcript' && msg.isFinal) msg.type = 'final';
      send(wc, { streamId, ...msg });
    } catch { /* 非 JSON 忽略 */ }
  });
  ws.on('error', (err: Error) => send(wc, { streamId, type: 'error', message: err.message }));
  ws.on('close', () => {
    send(wc, { streamId, type: 'close' });
    streams.delete(streamId);
  });

  streams.set(streamId, {
    push: (chunk) => {
      const buf = Buffer.from(chunk as ArrayBuffer);
      if (ws.readyState === WebSocket.CONNECTING) { pending.push(buf); return; }
      if (ws.readyState !== WebSocket.OPEN) return;
      try { ws.send(buf); } catch { /* dropped */ }
    },
    stop: () => {
      /* 还没连上就说完了: 等连上把攒的送完再 stop (open 里处理) */
      if (ws.readyState === WebSocket.CONNECTING) { stopRequested = true; return; }
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
      } catch { /* noop */ }
      setTimeout(() => { try { ws.close(); } catch { /* noop */ } }, 4000);
    },
    close: () => { try { ws.close(); } catch { /* noop */ } },
  });
  return { ok: true, streamId };
}


interface DashscopeProfile { apiKey: string; model?: string; language?: string; apiHost?: string; connMode?: 'ws' | 'http' }

/** 百炼 HTTP 整段识别 (qwen3-asr-flash / sensevoice / paraformer-v2 等不支持 WS 的模型走这条).
 * 端点: POST https://<host>/compatible-mode/v1/audio/transcriptions (OpenAI 兼容)
 * 或   POST https://<host>/api/v1/services/audio/asr/transcription (DashScope 原生)
 * 累 PCM → 组 WAV → multipart POST → 回文本. */
function startDashscopeHttpAccum(profile: DashscopeProfile, wc: WebContents): { ok: boolean; streamId?: string; error?: string } {
  if (!profile.apiKey) return { ok: false, error: '百炼 API Key 缺失' };
  const streamId = `stt-ds-http-${Date.now()}-${++streamSeq}`;
  const host = (profile.apiHost || 'dashscope.aliyuncs.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const url = `https://${host}/compatible-mode/v1/audio/transcriptions`;
  const chunks: Int16Array[] = [];
  let stopped = false;
  send(wc, { streamId, type: 'open' });

  const finalize = async () => {
    if (stopped) return;
    stopped = true;
    try {
      let total = 0;
      for (const c of chunks) total += c.length;
      if (total < 800) {
        send(wc, { streamId, type: 'final', text: '', isFinal: true });
        send(wc, { streamId, type: 'close' });
        streams.delete(streamId);
        return;
      }
      const merged = new Int16Array(total);
      let off = 0;
      for (const c of chunks) { merged.set(c, off); off += c.length; }
      const wav = encodePcmToWav(merged, 16000);
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
      form.append('model', profile.model || 'qwen3-asr-flash');
      if (profile.language) form.append('language', profile.language);
      const isPrivate = /\.maas\.aliyuncs\.com$/.test(host);
      const workspaceId = isPrivate ? host.split('.')[0] : '';
      const headers: Record<string, string> = { Authorization: `Bearer ${profile.apiKey}` };
      if (workspaceId) headers['X-DashScope-WorkSpace'] = workspaceId;
      const resp = await fetch(url, { method: 'POST', headers, body: form as any });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`${resp.status} ${errText.slice(0, 300)} · ${url}`);
      }
      const json = (await resp.json().catch(() => ({}))) as { text?: string };
      send(wc, { streamId, type: 'final', text: (json.text || '').trim(), isFinal: true });
    } catch (e: any) {
      send(wc, { streamId, type: 'error', message: e?.message || '百炼 HTTP 识别失败' });
    } finally {
      send(wc, { streamId, type: 'close' });
      streams.delete(streamId);
    }
  };

  streams.set(streamId, {
    push: (chunk) => {
      if (stopped) return;
      const ab = chunk instanceof Uint8Array ? chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) : chunk as ArrayBuffer;
      chunks.push(new Int16Array(ab));
    },
    stop: () => { void finalize(); },
    close: () => { stopped = true; streams.delete(streamId); },
  });
  return { ok: true, streamId };
}


function startDashscopeStream(profile: DashscopeProfile, wc: WebContents): { ok: boolean; streamId?: string; error?: string } {
  if (!profile.apiKey) return { ok: false, error: '百炼 API Key 缺失 (设置 → 语音 → 添加百炼)' };
  const streamId = `stt-ds-${Date.now()}-${++streamSeq}`;
  const host = (profile.apiHost || 'dashscope.aliyuncs.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const url = `wss://${host}/api-ws/v1/inference`;
  const isPrivate = /\.maas\.aliyuncs\.com$/.test(host);
  const workspaceId = isPrivate ? host.split('.')[0] : '';
  const headers: Record<string, string> = {
    Authorization: `bearer ${profile.apiKey}`,
    'X-DashScope-DataInspection': 'enable',
  };
  if (workspaceId) headers['X-DashScope-WorkSpace'] = workspaceId;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url, { headers });
  } catch (e: any) {
    return { ok: false, error: `${e?.message || '百炼 WS 连接失败'} · ${url}` };
  }

  const taskId = randomUUID().replace(/-/g, '');
  let started = false;
  let stopped = false;
  const pending: Array<ArrayBuffer | Uint8Array> = [];
  let committed = '';   /* 已定稿的完整句拼接 */
  let partial = '';     /* 当前 sentence 的最新 partial */

  ws.on('open', () => {
    /* run-task 首帧 (JSON) — 声明这是双向流的语音识别任务 */
    const runTask = {
      header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
      payload: {
        task_group: 'audio',
        task: 'asr',
        function: 'recognition',
        model: profile.model || 'paraformer-realtime-v2',
        parameters: {
          sample_rate: 16000,
          format: 'pcm',
          ...(profile.language ? { language_hints: [profile.language] } : {}),
        },
        input: {},
      },
    };
    try { ws.send(JSON.stringify(runTask)); } catch { /* noop */ }
  });

  ws.on('message', (data: Buffer | string) => {
    /* 二进制帧不该出现 (服务端只回 JSON); 全部按 JSON 处理 */
    let msg: any;
    try { msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf-8')); } catch { return; }
    const event = msg?.header?.event;
    if (event === 'task-started') {
      started = true;
      send(wc, { streamId, type: 'open' });
      /* 冲刷握手期到达的音频帧 */
      for (const c of pending.splice(0)) {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(Buffer.from(c as ArrayBuffer)); } catch { /* noop */ }
        }
      }
      return;
    }
    if (event === 'result-generated') {
      const sentence = msg?.payload?.output?.sentence;
      const text = (sentence?.text ?? '').trim();
      const isFinal = sentence?.end_time != null && sentence?.begin_time != null && sentence?.sentence_end === true;
      /* DashScope 每 sentence 会流式回多次 partial (text 增长), 完成时 sentence_end=true */
      if (isFinal) {
        committed = committed ? `${committed}${text}` : text;
        partial = '';
        send(wc, { streamId, type: 'transcript', text: committed });
      } else if (text) {
        partial = text;
        send(wc, { streamId, type: 'transcript', text: `${committed}${partial}` });
      }
      return;
    }
    if (event === 'task-finished') {
      const finalText = `${committed}${partial}`.trim();
      send(wc, { streamId, type: 'final', text: finalText, isFinal: true });
      try { ws.close(); } catch { /* noop */ }
      return;
    }
    if (event === 'task-failed') {
      const msgTxt = msg?.header?.error_message || msg?.header?.error_code || '百炼识别失败';
      send(wc, { streamId, type: 'error', message: `${msgTxt}` });
      try { ws.close(); } catch { /* noop */ }
      return;
    }
  });
  ws.on('error', (err: Error) => send(wc, { streamId, type: 'error', message: `${err.message} · ${url}${workspaceId ? ` (workspace: ${workspaceId})` : ''}` }));
  ws.on('close', () => {
    send(wc, { streamId, type: 'close' });
    streams.delete(streamId);
  });

  streams.set(streamId, {
    push: (chunk) => {
      if (stopped) return;
      if (!started) { pending.push(chunk); return; }
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(Buffer.from(chunk as ArrayBuffer)); } catch { /* noop */ }
      }
    },
    stop: () => {
      stopped = true;
      if (ws.readyState === WebSocket.OPEN) {
        const finish = {
          header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
          payload: { input: {} },
        };
        try { ws.send(JSON.stringify(finish)); } catch { /* noop */ }
      }
      /* 兜底 5s 强关 */
      setTimeout(() => { try { ws.close(); } catch { /* noop */ } }, 5000);
    },
    close: () => { try { ws.close(); } catch { /* noop */ } },
  });
  return { ok: true, streamId };
}


export interface DashscopeTtsProfile {
  apiKey: string;
  model?: string;      /* cosyvoice-v3-plus / cosyvoice-v3-flash / cosyvoice-v2, 默认 v3-plus */
  voice?: string;      /* longanyang / longxiaochun_v2 等 */
  format?: 'pcm' | 'mp3';
  apiHost?: string;
}

export interface DashscopeTtsSession {
  /** 追加要合成的一段文本 (可多次调, 服务端流式返回) */
  sendText: (text: string) => void;
  /** 结束会话, 等 task-finished 后 promise resolve */
  finish: () => void;
  /** 立即中断 (WS close), 不等剩余音频 */
  cancel: () => void;
}

export interface DashscopeTtsEvents {
  onOpen?: () => void;
  onAudio: (chunk: Buffer) => void;   /* 二进制音频帧 */
  onFinal?: () => void;
  onError?: (msg: string) => void;
}

/** 起一个 CosyVoice 实时 TTS 会话 (对内 API, 供 ttsBridgeHandlers 用) */
export function startDashscopeTts(profile: DashscopeTtsProfile, events: DashscopeTtsEvents): DashscopeTtsSession {
  const host = (profile.apiHost || 'dashscope.aliyuncs.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const url = `wss://${host}/api-ws/v1/inference`;
  const isPrivate = /\.maas\.aliyuncs\.com$/.test(host);
  const workspaceId = isPrivate ? host.split('.')[0] : '';
  const headers: Record<string, string> = {
    Authorization: `bearer ${profile.apiKey}`,
  };
  if (workspaceId) headers['X-DashScope-WorkSpace'] = workspaceId;
  const ws = new WebSocket(url, { headers });
  const taskId = randomUUID().replace(/-/g, '');
  let started = false;
  const pendingText: string[] = [];

  const sendContinue = (text: string) => {
    const frame = {
      header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
      payload: { input: { text } },
    };
    try { ws.send(JSON.stringify(frame)); } catch { /* noop */ }
  };

  ws.on('open', () => {
    const run = {
      header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
      payload: {
        task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer',
        model: profile.model || 'cosyvoice-v3-plus',
        parameters: {
          text_type: 'PlainText',
          voice: profile.voice || 'longanyang',
          format: profile.format || 'pcm',
          sample_rate: 16000,
          volume: 50, rate: 1, pitch: 1,
        },
        input: {},
      },
    };
    try { ws.send(JSON.stringify(run)); } catch { /* noop */ }
  });
  ws.on('message', (data: Buffer | string) => {
    /* 二进制帧 = 音频, JSON 帧 = 控制事件 */
    if (typeof data !== 'string' && Buffer.isBuffer(data)) {
      /* 简易判 JSON: 首字节 '{' = JSON, 否则二进制 */
      if (data.length > 0 && data[0] === 0x7b) {
        try {
          const msg = JSON.parse(data.toString('utf-8'));
          const ev = msg?.header?.event;
          if (ev === 'task-started') {
            started = true;
            events.onOpen?.();
            for (const t of pendingText.splice(0)) sendContinue(t);
          } else if (ev === 'task-finished') {
            events.onFinal?.();
            try { ws.close(); } catch { /* noop */ }
          } else if (ev === 'task-failed') {
            events.onError?.(msg?.header?.error_message || 'CosyVoice 失败');
            try { ws.close(); } catch { /* noop */ }
          }
        } catch {
          /* 不是 JSON, 当二进制音频处理 */
          events.onAudio(data);
        }
      } else {
        events.onAudio(data);
      }
    }
  });
  ws.on('error', (err: Error) => events.onError?.(`${err.message} · ${url}`));
  ws.on('close', () => { /* onFinal already called from task-finished, close is idempotent */ });

  return {
    sendText: (text) => {
      if (!started) { pendingText.push(text); return; }
      if (ws.readyState === WebSocket.OPEN) sendContinue(text);
    },
    finish: () => {
      if (ws.readyState === WebSocket.OPEN) {
        const frame = {
          header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
          payload: { input: {} },
        };
        try { ws.send(JSON.stringify(frame)); } catch { /* noop */ }
      }
    },
    cancel: () => { try { ws.close(); } catch { /* noop */ } },
  };
}

/* ==================== 火山引擎实时大模型 ASR (bigmodel v3 sauc) ==================== *
 * 协议: WSS wss://openspeech.bytedance.com/api/v3/sauc/bigmodel
 * 头部: X-Api-App-Key + X-Api-Access-Key + X-Api-Resource-Id + X-Api-Request-Id
 * 帧格式: 火山定义的二进制包 (4B header + 4B序列号 + 4B payload size + payload).
 *   header byte0: (0001<<4) | ((flags<<0)&0x0f)  — flags=0 数据帧, flags=2 last frame
 *   header byte1: (msgType<<4) | (msgFlags)
 *   header byte2: (serial<<4) | 0
 *   header byte3: 0
 * 简化: 我们用 JSON message (msgType=1 client full-request 首帧 config; msgType=2 client audio;
 *       服务端 msgType=9 server full-response result / 15 error). 参考火山官方 sauc 示例. */

interface VolcProfile { appId: string; accessToken: string; resourceId?: string }

function buildVolcHeader(msgType: number, flags: number): Buffer {
  /* 火山二进制帧头 (4 bytes):
   * [0]: version(0001) | header_size(0001) = 0x11
   * [1]: message_type(<<4) | message_type_flags
   * [2]: serialization(0001=JSON) << 4 | compression(0000=no)
   * [3]: reserved(0x00) */
  const b = Buffer.alloc(4);
  b[0] = 0x11;
  b[1] = ((msgType & 0x0f) << 4) | (flags & 0x0f);
  b[2] = 0x10;   /* JSON, no compression */
  b[3] = 0x00;
  return b;
}

function encodeVolcFrame(msgType: number, flags: number, payload: Buffer): Buffer {
  const header = buildVolcHeader(msgType, flags);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, size, payload]);
}

function decodeVolcFrame(buf: Buffer): { msgType: number; flags: number; serialization: number; payload: Buffer } | null {
  if (buf.length < 4) return null;
  const msgType = (buf[1] >> 4) & 0x0f;
  const flags = buf[1] & 0x0f;
  const serialization = (buf[2] >> 4) & 0x0f;
  const size = buf.readUInt32BE(4);
  const payload = buf.subarray(8, 8 + size);
  return { msgType, flags, serialization, payload };
}

function startVolcStream(profile: VolcProfile, wc: WebContents): { ok: boolean; streamId?: string; error?: string } {
  if (!profile.appId || !profile.accessToken) return { ok: false, error: '火山 STT: appId 或 accessToken 缺失' };
  const streamId = `stt-volc-${Date.now()}-${++streamSeq}`;
  const url = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';
  const requestId = randomUUID();
  let ws: WebSocket;
  try {
    ws = new WebSocket(url, {
      headers: {
        'X-Api-App-Key': profile.appId,
        'X-Api-Access-Key': profile.accessToken,
        'X-Api-Resource-Id': profile.resourceId || 'volc.bigasr.sauc.duration',
        'X-Api-Request-Id': requestId,
      },
    });
  } catch (e: any) {
    return { ok: false, error: e?.message || '火山 WS 连接失败' };
  }

  let opened = false;
  let stopped = false;
  const pending: Array<ArrayBuffer | Uint8Array> = [];
  let latestPartial = '';

  ws.on('open', () => {
    /* 首帧 (msgType=1 full-client-request, flags=0): 会话配置 */
    const config = {
      user: { uid: requestId },
      audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
      request: {
        model_name: 'bigmodel',
        enable_punc: true,
        enable_itn: true,
        show_utterances: true,
        result_type: 'single',   /* single=每次全量 */
      },
    };
    const payload = Buffer.from(JSON.stringify(config), 'utf-8');
    try { ws.send(encodeVolcFrame(1, 0, payload)); } catch { /* noop */ }
    opened = true;
    send(wc, { streamId, type: 'open' });
    /* 冲刷握手期到达的音频 */
    for (const c of pending.splice(0)) {
      if (ws.readyState === WebSocket.OPEN) {
        const pcm = Buffer.from(c as ArrayBuffer);
        try { ws.send(encodeVolcFrame(2, 0, pcm)); } catch { /* noop */ }
      }
    }
  });

  ws.on('message', (data: Buffer | string) => {
    if (typeof data === 'string') return;
    const decoded = decodeVolcFrame(data);
    if (!decoded) return;
    if (decoded.msgType === 9) {
      /* full-server-response: JSON payload */
      try {
        const json = JSON.parse(decoded.payload.toString('utf-8'));
        const result = json?.result;
        if (result?.text != null) {
          latestPartial = String(result.text);
          const isLast = decoded.flags === 2 || json?.result?.utterances?.some((u: any) => u.definite);
          if (isLast) {
            send(wc, { streamId, type: 'final', text: latestPartial, isFinal: true });
            try { ws.close(); } catch { /* noop */ }
          } else {
            send(wc, { streamId, type: 'transcript', text: latestPartial });
          }
        }
      } catch { /* noop */ }
      return;
    }
    if (decoded.msgType === 15) {
      /* error */
      try {
        const err = JSON.parse(decoded.payload.toString('utf-8'));
        send(wc, { streamId, type: 'error', message: err?.error || err?.message || '火山识别失败' });
      } catch {
        send(wc, { streamId, type: 'error', message: '火山识别失败' });
      }
      try { ws.close(); } catch { /* noop */ }
    }
  });
  ws.on('error', (err: Error) => send(wc, { streamId, type: 'error', message: err.message }));
  ws.on('close', () => {
    send(wc, { streamId, type: 'close' });
    streams.delete(streamId);
  });

  streams.set(streamId, {
    push: (chunk) => {
      if (stopped) return;
      if (!opened) { pending.push(chunk); return; }
      if (ws.readyState === WebSocket.OPEN) {
        const pcm = Buffer.from(chunk as ArrayBuffer);
        try { ws.send(encodeVolcFrame(2, 0, pcm)); } catch { /* noop */ }
      }
    },
    stop: () => {
      stopped = true;
      /* last audio frame with flags=2 空 payload — 告知服务端结束 */
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(encodeVolcFrame(2, 2, Buffer.alloc(0))); } catch { /* noop */ }
      }
      setTimeout(() => { try { ws.close(); } catch { /* noop */ } }, 5000);
    },
    close: () => { try { ws.close(); } catch { /* noop */ } },
  });
  return { ok: true, streamId };
}

/* ==================== 累积式假流式 (local / custom) ==================== *
 * local 和 custom 都是"整段识别"引擎, 没有真流式接口. 为对齐 IPC 协议 (前端不用分支),
 * 主进程累 PCM buffer, stop 时组 WAV → 一次识别 → 回 final. UX 上 micState 会经过
 * 'recording' → 'transcribing' → idle 三态 (整段识别 200ms~2s, 用户可接受). */

function encodePcmToWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);         // PCM
  buf.writeUInt16LE(1, 22);         // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);         // block align
  buf.writeUInt16LE(16, 34);        // bits/sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

/** 本地识别: 主引擎是流式 (Zipformer / 导入的 transducer) → 边说边出字, 停下时定稿; 整段模型 → 累积后整段识别 */
async function startLocalStream(wc: WebContents): Promise<{ ok: boolean; streamId?: string; error?: string }> {
  if (!isPlatformSupported()) return { ok: false, error: '本地语音识别当前仅支持 macOS Apple Silicon' };
  if (!effectiveAsrId()) return { ok: false, error: '本地识别模型还没下载 (设置 → 语音 → 语音输入 → 本地)' };
  const streamId = `stt-local-${Date.now()}-${++streamSeq}`;
  let session: import('./localAsr.js').LocalAsrSession | null;
  try {
    const { openStreamingSession } = await import('./localAsr.js');
    session = await openStreamingSession((full) => send(wc, { streamId, type: 'transcript', text: full }));
  } catch (e: any) {
    return { ok: false, error: e?.message || '本地识别引擎启动失败' };
  }
  if (!session) return startLocalAccumStream(wc);
  const live = session;
  let stopped = false;
  send(wc, { streamId, type: 'open' });
  streams.set(streamId, {
    push: (chunk) => {
      if (stopped) return;
      const ab = chunk instanceof Uint8Array ? chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) : chunk as ArrayBuffer;
      try { live.push(new Int16Array(ab)); } catch (e: any) { send(wc, { streamId, type: 'error', message: e?.message || '本地识别失败' }); }
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      void live.finish()
        .then((text) => send(wc, { streamId, type: 'final', text, isFinal: true }))
        .catch((e: any) => send(wc, { streamId, type: 'error', message: e?.message || '本地识别失败' }))
        .finally(() => { send(wc, { streamId, type: 'close' }); streams.delete(streamId); });
    },
    close: () => { stopped = true; streams.delete(streamId); },
  });
  return { ok: true, streamId };
}

function startLocalAccumStream(wc: WebContents): { ok: boolean; streamId?: string; error?: string } {
  if (!isPlatformSupported()) return { ok: false, error: '本地语音识别当前仅支持 macOS Apple Silicon' };
  const asrId = effectiveAsrId();
  if (!asrId) return { ok: false, error: '本地识别模型未下载 (设置 → 语音 → 本地语音模型)' };

  const streamId = `stt-local-${Date.now()}-${++streamSeq}`;
  const chunks: Int16Array[] = [];
  let stopped = false;
  send(wc, { streamId, type: 'open' });

  const finalize = async () => {
    if (stopped) return;
    stopped = true;
    try {
      let total = 0;
      for (const c of chunks) total += c.length;
      if (total < 800) {   // <50ms @16k → 太短忽略
        send(wc, { streamId, type: 'final', text: '', isFinal: true });
        send(wc, { streamId, type: 'close' });
        streams.delete(streamId);
        return;
      }
      const merged = new Int16Array(total);
      let off = 0;
      for (const c of chunks) { merged.set(c, off); off += c.length; }
      const text = await transcribeLocal(merged);
      send(wc, { streamId, type: 'final', text, isFinal: true });
    } catch (e: any) {
      send(wc, { streamId, type: 'error', message: e?.message || '本地识别失败' });
    } finally {
      send(wc, { streamId, type: 'close' });
      streams.delete(streamId);
    }
  };

  streams.set(streamId, {
    push: (chunk) => {
      if (stopped) return;
      /* 渲染端推的是 16k mono 16-bit LE PCM ArrayBuffer, 直接视为 Int16Array */
      const ab = chunk instanceof Uint8Array ? chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) : chunk as ArrayBuffer;
      chunks.push(new Int16Array(ab));
    },
    stop: () => { void finalize(); },
    close: () => { stopped = true; streams.delete(streamId); },
  });
  return { ok: true, streamId };
}

function startCustomAccumStream(stt: STTConfig, wc: WebContents): { ok: boolean; streamId?: string; error?: string } {
  const apiUrl = (stt.apiUrl || '').trim();
  /* 盘上 apiKey 是 enc:v1 密文 (profile 明文走 unwrap 透传), 解出真值当 Bearer */
  const apiKey = unwrapApiKey(stt.apiKey).trim();
  if (!apiUrl || !apiKey) return { ok: false, error: 'Custom STT 未配置 (设置 → 语音 → 自定义)' };

  const streamId = `stt-custom-${Date.now()}-${++streamSeq}`;
  const chunks: Int16Array[] = [];
  let stopped = false;
  send(wc, { streamId, type: 'open' });

  const buildUrl = (): string => {
    /* apiUrl 可能是 base (https://api.openai.com/v1) 也可能已带 /audio/transcriptions */
    const u = apiUrl.replace(/\/+$/, '');
    return /\/audio\/transcriptions$/.test(u) ? u : `${u}/audio/transcriptions`;
  };

  const finalize = async () => {
    if (stopped) return;
    stopped = true;
    try {
      let total = 0;
      for (const c of chunks) total += c.length;
      if (total < 800) {
        send(wc, { streamId, type: 'final', text: '', isFinal: true });
        send(wc, { streamId, type: 'close' });
        streams.delete(streamId);
        return;
      }
      const merged = new Int16Array(total);
      let off = 0;
      for (const c of chunks) { merged.set(c, off); off += c.length; }
      const wav = encodePcmToWav(merged, 16000);

      /* OpenAI /v1/audio/transcriptions 要 multipart/form-data:
       *   file (Blob/File), model, language? — 用 Node 原生 FormData + Blob (Node 18+) */
      const model = (stt.customModel || 'whisper-1').trim();
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
      form.append('model', model);
      if (stt.language) form.append('language', stt.language);

      const resp = await fetch(buildUrl(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form as any,
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Custom STT ${resp.status}: ${errText.slice(0, 300)}`);
      }
      const json = (await resp.json().catch(() => ({}))) as { text?: string };
      send(wc, { streamId, type: 'final', text: (json.text || '').trim(), isFinal: true });
    } catch (e: any) {
      send(wc, { streamId, type: 'error', message: e?.message || 'Custom STT 失败' });
    } finally {
      send(wc, { streamId, type: 'close' });
      streams.delete(streamId);
    }
  };

  streams.set(streamId, {
    push: (chunk) => {
      if (stopped) return;
      const ab = chunk instanceof Uint8Array ? chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) : chunk as ArrayBuffer;
      chunks.push(new Int16Array(ab));
    },
    stop: () => { void finalize(); },
    close: () => { stopped = true; streams.delete(streamId); },
  });
  return { ok: true, streamId };
}

/* ==================== provider 分流 & IPC ==================== */

interface ProviderAvailability {
  official: boolean;    /* 已登录订阅 */
  xfyun: boolean;
  dashscope: boolean;
  volc: boolean;
  custom: boolean;
  local: boolean;
}

async function probeProviders(): Promise<ProviderAvailability> {
  const stt = loadConfig().stt || {};
  const key = await getGatewayKey().catch(() => null);
  const anyProfile = (kind: STTProfile['provider']) =>
    (stt.profiles || []).some(p => p.provider === kind);
  return {
    official: !!key?.secret,
    xfyun: getXfyunCreds() !== null || anyProfile('xfyun'),
    dashscope: anyProfile('dashscope') || (stt.provider === 'dashscope' && !!stt.apiKey),
    volc: anyProfile('volc') || (stt.provider === 'volc' && !!stt.appId && !!stt.volcAccessToken),
    custom: !!(stt.apiUrl && stt.apiKey) || anyProfile('custom'),
    local: isPlatformSupported() && effectiveAsrId() !== null,
  };
}

/** 按 profile 分流启动 — profile 是新多档模型的入口, 从 activeProfileId 找 profile 后走
 * (profile 内密钥字段盘上是 enc:v1 密文, 用前 unwrap; 旧明文 profile 透传兼容) */
async function startFromProfile(profile: STTProfile, wc: WebContents, model: string): Promise<{ ok: boolean; streamId?: string; error?: string }> {
  switch (profile.provider) {
    case 'dashscope': {
      const ds = { apiKey: unwrapApiKey(profile.apiKey), model: profile.model, language: profile.language, apiHost: profile.apiHost, connMode: profile.connMode };
      return (profile.connMode === 'http') ? startDashscopeHttpAccum(ds, wc) : startDashscopeStream(ds, wc);
    }
    case 'volc':
      return startVolcStream({ appId: profile.appId, accessToken: unwrapApiKey(profile.accessToken), resourceId: profile.resourceId }, wc);
    case 'xfyun': {
      const creds = { appId: profile.appId, apiKey: unwrapApiKey(profile.apiKey), apiSecret: unwrapApiKey(profile.apiSecret) };
      if (!creds.appId || !creds.apiKey || !creds.apiSecret) return { ok: false, error: '讯飞 profile 字段缺失' };
      return startXfyunStream(creds, wc);
    }
    case 'custom': {
      /* apiKey 不在这层 unwrap — startCustomAccumStream 内部统一 unwrap */
      const merged: STTConfig = { apiUrl: profile.apiUrl, apiKey: profile.apiKey, customModel: profile.model, language: profile.language };
      return startCustomAccumStream(merged, wc);
    }
    case 'local':
      return startLocalStream(wc);
    case 'official':
      return startGatewayStream(model, wc);
    default:
      return { ok: false, error: `未知 provider ${(profile as any).provider}` };
  }
}

async function startStream(model: string, wc: WebContents): Promise<{ ok: boolean; streamId?: string; error?: string }> {
  const stt = loadConfig().stt || {};

  if (stt.activeProfileId && stt.profiles?.length) {
    const active = stt.profiles.find(p => p.id === stt.activeProfileId);
    if (active) return startFromProfile(active, wc, model);
    /* activeProfileId 指向不存在的 profile — 回落到 auto */
  }

  const provider = (stt.provider || '').trim() as STTConfig['provider'] | '';

  /* 兼容旧字段 (未迁 profile 的老用户): 显式 provider */
  if (provider === 'xfyun') {
    const creds = getXfyunCreds();
    if (!creds) return { ok: false, error: '讯飞 STT 未配置 (设置 → 语音 → 讯飞)' };
    return startXfyunStream(creds, wc);
  }
  if (provider === 'dashscope') {
    if (!stt.apiKey) return { ok: false, error: '百炼 API Key 缺失 (设置 → 语音 → 添加百炼)' };
    const connMode = (stt as any).dashscopeConnMode as 'ws' | 'http' | undefined;
    /* enc:v1 密文解出真值 (旧明文透传) */
    const ds = { apiKey: unwrapApiKey(stt.apiKey), model: stt.customModel, language: stt.language, apiHost: stt.dashscopeApiHost, connMode };
    return connMode === 'http' ? startDashscopeHttpAccum(ds, wc) : startDashscopeStream(ds, wc);
  }
  if (provider === 'volc') {
    if (!stt.appId || !stt.volcAccessToken) return { ok: false, error: '火山 STT 未配置 (需 appId + accessToken)' };
    /* enc:v1 密文解出真值 (旧明文透传) */
    return startVolcStream({ appId: stt.appId, accessToken: unwrapApiKey(stt.volcAccessToken), resourceId: stt.volcResourceId }, wc);
  }
  if (provider === 'local') return startLocalStream(wc);
  if (provider === 'custom') return startCustomAccumStream(stt, wc);
  if (provider === 'official') return startGatewayStream(model, wc);

  if (isPlatformSupported() && effectiveAsrId()) return startLocalStream(wc);
  const xf = getXfyunCreds();
  if (xf) return startXfyunStream(xf, wc);
  if (stt.apiUrl && stt.apiKey) return startCustomAccumStream(stt, wc);
  return startGatewayStream(model, wc);
}

export function registerSttStreamIpc(): void {
  ipcMain.handle('stt:stream-start', (event, model: string) => startStream(model, event?.sender));
  ipcMain.on('stt:stream-audio', (_event, streamId: string, chunk: ArrayBuffer | Uint8Array) => {
    streams.get(streamId)?.push(chunk);
  });
  ipcMain.handle('stt:stream-stop', (_event, streamId: string) => {
    const s = streams.get(streamId);
    if (!s) return { ok: false };
    s.stop();
    return { ok: true };
  });
  /* probe: 前端在麦按钮首次可见时探一次, 用于错误引导 "语音输入失败: 未配置任何 STT" */
  ipcMain.handle('stt:probe-providers', async () => {
    const avail = await probeProviders();
    const stt = loadConfig().stt || {};
    return { ok: true, avail, selected: stt.provider || 'auto' };
  });
}
