/**
 * TTS Service - 语音合成服务（流式版）
 *
 * 架构：
 * - TTSService：统一入口
 * - EdgeTTSProvider：Edge TTS 流式合成
 *
 * 流程：
 * 文本 → Edge TTS synthesizeStream → 逐 chunk 回调 → SSE 推送
 */

import { EdgeTTS } from '@andresaya/edge-tts';
import { createHash } from 'node:crypto';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { loadAutoHmacSigner } from '@neoxlabs/kernel/models/openai.js';
import { unwrapApiKey } from '@neoxlabs/platform/utils/apiKeyCrypto.js';
import type { TTSConfig } from '@neoxlabs/platform/utils/config.js';

// ============================================================================
// Types
// ============================================================================

export interface TTSResult {
  audio: string;
  format: string;
  voiceSummary: string;
  durationMs?: number;
}

export interface TTSProviderOptions {
  voice?: string;
  speed?: number;
  format?: string;
}

/** 流式 chunk 回调 */
export type TTSChunkCallback = (chunk: Buffer, index: number) => void;

/** TTS Provider 接口 */
export interface TTSProvider {
  readonly id: string;
  init(): Promise<void>;
  synthesize(text: string, options?: TTSProviderOptions): Promise<{ audio: Buffer; format: string; durationMs?: number }>;
  synthesizeStream(text: string, onChunk: TTSChunkCallback, options?: TTSProviderOptions): Promise<{ format: string; totalChunks: number }>;
  getVoices(): Promise<Array<{ id: string; name: string; locale: string; gender: string }>>;
  destroy(): void;
}

// ============================================================================
// Edge TTS Provider
// ============================================================================

export class EdgeTTSProvider implements TTSProvider {
  readonly id = 'edge';
  private tts: EdgeTTS;

  constructor() {
    this.tts = new EdgeTTS();
  }

  async init(): Promise<void> {}

  async synthesize(text: string, options?: TTSProviderOptions): Promise<{ audio: Buffer; format: string; durationMs?: number }> {
    const voice = options?.voice || 'zh-CN-XiaoxiaoNeural';
    const rate = options?.speed ? `${Math.round((options.speed - 1) * 100)}%` : '+0%';
    const format = options?.format || 'mp3';
    const outputFormat = format === 'opus'
      ? 'webm-24khz-16bit-mono-opus'
      : 'audio-24khz-48kbitrate-mono-mp3';

    await this.tts.synthesize(text, voice, { rate, outputFormat });
    const buffer = this.tts.toBuffer();
    const info = this.tts.getAudioInfo();

    return {
      audio: buffer,
      format,
      durationMs: Math.round(info.estimatedDuration * 1000),
    };
  }

  async synthesizeStream(
    text: string,
    onChunk: TTSChunkCallback,
    options?: TTSProviderOptions,
  ): Promise<{ format: string; totalChunks: number }> {
    const voice = options?.voice || 'zh-CN-XiaoxiaoNeural';
    const format = options?.format || 'mp3';
    let chunkIndex = 0;

    try {
      for await (const chunk of this.tts.synthesizeStream(text, voice)) {
        if (chunk && chunk.length > 0) {
          onChunk(Buffer.from(chunk), chunkIndex);
          chunkIndex++;
        }
      }
    } catch (err: any) {
      // edge-tts WebSocket 可能在连接未就绪时抛异常，不应崩溃进程
      cliLogger.warn('TTS', `Edge TTS stream error (${chunkIndex} chunks sent): ${err.message}`);
    }

    return { format, totalChunks: chunkIndex };
  }

  async getVoices(): Promise<Array<{ id: string; name: string; locale: string; gender: string }>> {
    const voices = await this.tts.getVoicesByLanguage('zh-CN');
    return voices.map(v => ({
      id: v.ShortName,
      name: v.LocalName || v.FriendlyName,
      locale: v.Locale,
      gender: v.Gender,
    }));
  }

  destroy(): void {}
}

// ============================================================================
// OpenAI 兼容 TTS Provider —— BYOK: 任何 /v1/audio/speech 端点
//   (硅基流动 CosyVoice2 / OpenAI tts-1 / Groq PlayAI / Fish 兼容层)
// ============================================================================

export class OpenAICompatTTSProvider implements TTSProvider {
  readonly id = 'openai-compat';
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(opts: { baseUrl: string; apiKey: string; model: string }) {
    /* URL 归一化 — 跟 BYOK STT 同规矩: 裸域名补 /v1, 已含完整路径原样 */
    const base = opts.baseUrl.trim().replace(/\/+$/, '');
    this.baseUrl = /\/audio\/speech$/.test(base)
      ? base
      : /\/v\d+$/.test(base)
        ? `${base}/audio/speech`
        : `${base}/v1/audio/speech`;
    this.apiKey = opts.apiKey;
    this.model = opts.model;
  }

  async init(): Promise<void> {
    /* TLS 预热: 首句合成前把 DNS+握手 (~200-300ms) 提前付掉 — undici 连接池
     * keep-alive, 预热的连接直接被首个真请求复用。失败无所谓, 真请求自己会连。 */
    try {
      const origin = new URL(this.baseUrl).origin;
      void fetch(origin, { method: 'HEAD', signal: AbortSignal.timeout(3000) }).catch(() => { /* noop */ });
    } catch { /* baseUrl 不合法 — 真请求时报错更清楚 */ }
  }

  /** 发起 /audio/speech 请求 — synthesize 与 synthesizeStream 共用 (响应消费方式不同) */
  private async request(text: string, options?: TTSProviderOptions): Promise<{ resp: Response; format: string }> {
    const format = options?.format || 'mp3';
    const resp = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        /* voice 缺省交给服务端默认 — 硅基流动格式是 "模型名:音色名" */
        ...(options?.voice ? { voice: options.voice } : {}),
        response_format: format,
        speed: options?.speed ?? 1.0,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`BYOK TTS failed: ${resp.status} ${detail.slice(0, 200)}`);
    }
    return { resp, format };
  }

  async synthesize(text: string, options?: TTSProviderOptions): Promise<{ audio: Buffer; format: string; durationMs?: number }> {
    const { resp, format } = await this.request(text, options);
    const audio = Buffer.from(await resp.arrayBuffer());
    const durationMs = Math.round((text.length / 4) * 1000); /* 粗估, 仅 UI hint */
    return { audio, format, durationMs };
  }

  async synthesizeStream(
    text: string,
    onChunk: TTSChunkCallback,
    options?: TTSProviderOptions,
  ): Promise<{ format: string; totalChunks: number }> {
    const { resp, format } = await this.request(text, options);
    if (!resp.body) {
      const audio = Buffer.from(await resp.arrayBuffer());
      onChunk(audio, 0);
      return { format, totalChunks: 1 };
    }
    const reader = resp.body.getReader();
    const MIN_EMIT = 8 * 1024;
    let chunkIndex = 0;
    let acc: Buffer[] = [];
    let accLen = 0;
    const flush = () => {
      if (accLen === 0) return;
      onChunk(Buffer.concat(acc, accLen), chunkIndex);
      chunkIndex++;
      acc = [];
      accLen = 0;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        acc.push(Buffer.from(value));
        accLen += value.byteLength;
        if (accLen >= MIN_EMIT) flush();
      }
    }
    flush();
    return { format, totalChunks: chunkIndex };
  }

  async getVoices(): Promise<Array<{ id: string; name: string; locale: string; gender: string }>> {
    return []; /* OpenAI 兼容端点无统一 voice 列表协议 — 音色手填 config.tts.voice */
  }

  destroy(): void {}
}

// ============================================================================
// NeoxCloud TTS Provider —— 走 NeoxCloud 网关 /n1/audio/speech (火山豆包等上游)
// ============================================================================

export interface NeoxCloudTTSOptions {
  /** 网关 base URL, 订阅用户即 routing.json 的 gatewayBase (以 /n1 结尾). */
  baseUrl: string;
  /** 网关鉴权 key (nxk / JWT), 同 chat 路径. */
  apiKey: string;
  /** 网关里配置的 TTS 渠道 modelId, 如 'doubao-tts'. */
  model: string;
}

/**
 * NeoxCloud 云端 TTS —— 复用 chat 路径同一套网关 + HMAC 签名机制。
 *
 * 请求形态与 OpenAI /audio/speech 兼容 (网关 handleAudioSpeech 接收):
 *   POST {baseUrl}/audio/speech
 *   Header: Authorization: Bearer {nxk}  +  X-Sig-* (HMAC, native signer)
 *   Body:   { model, input, voice, response_format, speed }
 *   Resp:   原始音频字节 (Content-Type 由上游决定)
 *
 * 上游是火山豆包还是 MiniMax 由网关 channel 的 api_protocol 决定, 客户端无感。
 * 云端一次性返整段音频 (非流式), 故 synthesizeStream 退化为单 chunk。
 */
export class NeoxCloudTTSProvider implements TTSProvider {
  readonly id = 'neoxcloud';
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(opts: NeoxCloudTTSOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model || 'doubao-tts';
  }

  async init(): Promise<void> {}

  async synthesize(text: string, options?: TTSProviderOptions): Promise<{ audio: Buffer; format: string; durationMs?: number }> {
    const format = options?.format || 'mp3';
    const payload = {
      model: this.model,
      input: text,
      voice: options?.voice || 'longxiaochun_v2',
      response_format: format,
      speed: options?.speed ?? 1.0,
    };
    const bodyStr = JSON.stringify(payload);

    const url = `${this.baseUrl}/audio/speech`;
    const sigPath = new URL(url).pathname; // e.g. /n1/audio/speech

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
    const signer = loadAutoHmacSigner();
    if (signer) {
      const { getNeoxDeviceFp } = await import('@neoxlabs/kernel/models/openai.js');
      const bodyHexHash = createHash('sha256').update(bodyStr).digest('hex');
      const nxkId = createHash('sha256').update(this.apiKey).digest('hex').slice(0, 16);
      const deviceFp = getNeoxDeviceFp();
      const sig = await signer(sigPath, bodyHexHash, { nxkId, deviceFp });
      headers['X-Sig-Ts'] = sig.ts;
      headers['X-Sig-Nonce'] = sig.nonce;
      headers['X-Sig'] = sig.sig;
      headers['X-Sig-Proto'] = '2';
      headers['X-Device-FP'] = deviceFp;
      headers['X-Client-Version'] = sig.version;
    }

    const resp = await fetch(url, { method: 'POST', headers, body: bodyStr });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`NeoxCloud TTS failed: ${resp.status} ${errText.slice(0, 300)}`);
    }
    const arrayBuf = await resp.arrayBuffer();
    const audio = Buffer.from(arrayBuf);
    // 粗估时长: 中文约 4 字/秒朗读, 仅用于 UI hint, 不精确。
    const durationMs = Math.round((text.length / 4) * 1000);
    return { audio, format, durationMs };
  }

  async synthesizeStream(
    text: string,
    onChunk: TTSChunkCallback,
    options?: TTSProviderOptions,
  ): Promise<{ format: string; totalChunks: number }> {
    const result = await this.synthesize(text, options);
    onChunk(result.audio, 0);
    return { format: result.format, totalChunks: 1 };
  }

  async getVoices(): Promise<Array<{ id: string; name: string; locale: string; gender: string }>> {
    // 阿里 CosyVoice v2 常用音色 (静态表; 网关未提供 voice 列表端点)。
    return [
      { id: 'longxiaochun_v2', name: '龙小淳(女)', locale: 'zh-CN', gender: 'Female' },
      { id: 'longxiaoxia_v2', name: '龙小夏(女)', locale: 'zh-CN', gender: 'Female' },
      { id: 'longwan_v2', name: '龙婉(女)', locale: 'zh-CN', gender: 'Female' },
      { id: 'longcheng_v2', name: '龙橙(男)', locale: 'zh-CN', gender: 'Male' },
      { id: 'longhua_v2', name: '龙华(男)', locale: 'zh-CN', gender: 'Male' },
    ];
  }

  destroy(): void {}
}

// ============================================================================
// TTS Service（统一入口）
// ============================================================================
// ============================================================================

/**
 * DashscopeTtsProvider — 百炼实时 TTS (CosyVoice-v3-plus / v3-flash / v2)
 *
 * 协议: wss://<host>/api-ws/v1/inference
 * 会话: run-task → task-started → continue-task (文本) → finish-task → task-finished
 * 音频: 二进制通道 (JSON 帧首字节 = 0x7b '{', 其他都是音频)
 * 私有部署需 X-DashScope-WorkSpace 头 (workspaceId = apiHost 首段)
 *
 * 一次 synthesize() 内部完整收满音频再返 Buffer, 复用现有 chatEventPublisher 句级流水线.
 */
export interface DashscopeTtsProviderConfig {
  apiKey: string;
  apiHost?: string;     /* 缺省 dashscope.aliyuncs.com; 私有部署填 llm-xxx.cn-beijing.maas.aliyuncs.com */
  model?: string;       /* cosyvoice-v3-plus / v3-flash / v2, 缺省 v3-plus */
  voice?: string;       /* longanyang / longxiaochun_v2 等, 缺省 longanyang */
  format?: 'pcm' | 'mp3';
  sampleRate?: number;
}

/** CosyVoice pcm 缺省采样率 — 流式播放端 (ttsPlayer) 需要这个数, 走 tts_audio_chunk 事件透传 */
export const DASHSCOPE_PCM_SAMPLE_RATE = 22050;

export const COSYVOICE_V3_VOICES = [
  'longanyang',
  'longxiaochun_v3',
  'longxiaoxia_v3',
  'longwan_v3',
  'longcheng_v3',
  'longhua_v3',
  'longshu_v3',
] as const;

function normalizeCosyVoice(voice: string, model: string): string {
  const isV3 = !/v2/.test(model);
  if (!isV3) return voice;
  if ((COSYVOICE_V3_VOICES as readonly string[]).includes(voice)) return voice;
  /* 龙小白没有 v3 版本 —— 同为女声的龙小淳最接近, 换人总好过一声不出 */
  if (voice === 'longxiaobai' || voice === 'longxiaobai_v3') return 'longxiaochun_v3';
  const bare = voice.replace(/_v[23]$/, '');
  const v3 = `${bare}_v3`;
  if ((COSYVOICE_V3_VOICES as readonly string[]).includes(v3)) return v3;
  return 'longanyang';
}

export class DashscopeTtsProvider implements TTSProvider {
  readonly id = 'dashscope';
  private cfg: DashscopeTtsProviderConfig;
  constructor(cfg: DashscopeTtsProviderConfig) { this.cfg = cfg; }

  async init(): Promise<void> {
    if (!this.cfg.apiKey) throw new Error('DashscopeTtsProvider: apiKey 缺失');
  }

  /** WSS 会话骨架 — synthesize (收满) 与 synthesizeStream (逐帧) 共用,
   * 协议细节 (私有部署 workspace 头 / 首字节判帧 / 超时) 只维护一份。 */
  private async runWssSession(
    text: string,
    onAudio: (chunk: Buffer) => void,
    options?: TTSProviderOptions,
  ): Promise<{ format: string }> {
    /* 动态导入 ws — 保持 core 顶部 import 干净, 且 ws 是 optional (browser 环境不需要) */
    const { WebSocket } = await import('ws');
    const { randomUUID } = await import('node:crypto');

    const host = (this.cfg.apiHost || 'dashscope.aliyuncs.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const url = `wss://${host}/api-ws/v1/inference`;
    const isPrivate = /\.maas\.aliyuncs\.com$/.test(host);
    const workspaceId = isPrivate ? host.split('.')[0] : '';
    const headers: Record<string, string> = { Authorization: `bearer ${this.cfg.apiKey}` };
    if (workspaceId) headers['X-DashScope-WorkSpace'] = workspaceId;

    const format = (options?.format as 'pcm' | 'mp3' | undefined) || this.cfg.format || 'mp3';
    const model = this.cfg.model || 'cosyvoice-v3-plus';
    const voice = normalizeCosyVoice(options?.voice || this.cfg.voice || 'longanyang', model);
    const sampleRate = this.cfg.sampleRate || (format === 'mp3' ? 24000 : DASHSCOPE_PCM_SAMPLE_RATE);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const taskId = randomUUID().replace(/-/g, '');
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* noop */ }
        if (err) reject(err);
        else resolve();
      };
      /* 保守 30s 超时 (CosyVoice 单句合成通常 <5s, 30s 已很保险) */
      const timer = setTimeout(() => settle(new Error(`CosyVoice 超时 30s · ${url}`)), 30_000);

      ws.on('open', () => {
        const run = {
          header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer',
            model,
            parameters: {
              text_type: 'PlainText',
              voice,
              format,
              sample_rate: sampleRate,
              volume: 50,
              rate: options?.speed || 1,
              pitch: 1,
            },
            input: {},
          },
        };
        try { ws.send(JSON.stringify(run)); } catch { /* noop */ }
      });
      ws.on('message', (data: Buffer | string) => {
        if (typeof data === 'string') return;
        if (!Buffer.isBuffer(data)) return;
        /* 首字节 '{' (0x7b) 判 JSON 事件, 否则音频 chunk */
        if (data.length > 0 && data[0] === 0x7b) {
          try {
            const msg = JSON.parse(data.toString('utf-8'));
            const ev = msg?.header?.event;
            if (ev === 'task-started') {
              /* 一次性发文本 + 立刻 finish (音频帧到达即回调, task-finished 收尾) */
              const cont = {
                header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
                payload: { input: { text } },
              };
              const fin = {
                header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
                payload: { input: {} },
              };
              try {
                ws.send(JSON.stringify(cont));
                ws.send(JSON.stringify(fin));
              } catch { /* noop */ }
            } else if (ev === 'task-finished') {
              clearTimeout(timer);
              settle();
            } else if (ev === 'task-failed') {
              clearTimeout(timer);
              settle(new Error(msg?.header?.error_message || 'CosyVoice failed'));
            }
          } catch {
            /* JSON 解析失败 → 保守当作音频 (概率极低) */
            onAudio(data);
          }
        } else {
          onAudio(data);
        }
      });
      ws.on('error', (err: Error) => { clearTimeout(timer); settle(new Error(`${err.message} · ${url}${workspaceId ? ` (workspace: ${workspaceId})` : ''}`)); });
      ws.on('close', () => { clearTimeout(timer); settle(); });
    });
    return { format };
  }

  async synthesize(text: string, options?: TTSProviderOptions): Promise<{ audio: Buffer; format: string; durationMs?: number }> {
    const chunks: Buffer[] = [];
    const { format } = await this.runWssSession(text, (c) => chunks.push(c), options);
    return { audio: Buffer.concat(chunks), format };
  }

  async synthesizeStream(text: string, onChunk: TTSChunkCallback, options?: TTSProviderOptions): Promise<{ format: string; totalChunks: number }> {
    let chunkIndex = 0;
    const { format } = await this.runWssSession(text, (c) => { onChunk(c, chunkIndex); chunkIndex++; }, options);
    return { format, totalChunks: chunkIndex };
  }

  async getVoices(): Promise<Array<{ id: string; name: string; locale: string; gender: string }>> {
    return [
      { id: 'longanyang', name: '龙安杨(男)', locale: 'zh-CN', gender: 'male' },
      { id: 'longxiaochun_v3', name: '龙小淳(女)', locale: 'zh-CN', gender: 'female' },
      { id: 'longxiaoxia_v3', name: '龙小夏(女)', locale: 'zh-CN', gender: 'female' },
      { id: 'longwan_v3', name: '龙婉(女)', locale: 'zh-CN', gender: 'female' },
      { id: 'longcheng_v3', name: '龙橙(男)', locale: 'zh-CN', gender: 'male' },
      { id: 'longhua_v3', name: '龙华(男)', locale: 'zh-CN', gender: 'male' },
      { id: 'longshu_v3', name: '龙书(男)', locale: 'zh-CN', gender: 'male' },
    ];
  }

  destroy(): void { /* WS 每次合成自建自关, 无长连接可清 */ }
}

// ============================================================================

export type SummarizeFn = (text: string, maxChars: number, model?: string) => Promise<string>;

/** 解析网关凭证 —— provider='neoxcloud' 时用. 返回 chat 路径同一份 gateway entry. */
export type CloudGatewayResolver = () => { baseUrl?: string; apiKey?: string } | undefined;

export class TTSService {
  private provider: TTSProvider | null = null;
  private config: TTSConfig;
  private summarizeFn: SummarizeFn | null = null;
  private cloudResolver: CloudGatewayResolver | null = null;

  constructor(config: TTSConfig) {
    this.config = config;
  }

  setSummarizeFn(fn: SummarizeFn): void {
    this.summarizeFn = fn;
  }

  /** 注入网关凭证解析器 (provider='neoxcloud' 时合成走网关). */
  setCloudGatewayResolver(fn: CloudGatewayResolver): void {
    this.cloudResolver = fn;
  }

  updateConfig(config: Partial<TTSConfig>): void {
    this.config = { ...this.config, ...config };
  }

  isEnabled(): boolean {
    return this.config.enabled === true;
  }

  /** 最近一次 speak() 失败的原因 —— 供 bridge 带给调用方, 别让真错烂在进程里 */
  private lastSpeakError: string | null = null;
  getLastSpeakError(): string | null {
    return this.lastSpeakError;
  }

  getConfig(): TTSConfig {
    return this.config;
  }

  getStreamingMeta(): { capable: boolean; format: string; sampleRate?: number } {
    const providerType = this.config.provider || 'edge';
    const format = this.config.format || 'mp3';
    if (!this.provider) return { capable: false, format };
    /* dashscope 协议只吐 pcm/mp3 — 配置成 opus/wav 时流式判不可用, 走整句路 */
    if (providerType === 'dashscope' && this.provider.id === 'dashscope'
        && (format === 'pcm' || format === 'mp3')) {
      return { capable: true, format, sampleRate: format === 'pcm' ? DASHSCOPE_PCM_SAMPLE_RATE : undefined };
    }
    if ((providerType === 'openai' || providerType === 'custom')
        && this.provider.id === 'openai-compat' && format === 'mp3') {
      return { capable: true, format: 'mp3' };
    }
    return { capable: false, format };
  }

  private async prepareText(text: string): Promise<string> {
    text = stripMarkdownForSpeech(text);
    const maxChars = this.config.maxSummaryChars ?? 200;
    if (!this.config.autoSummarize) return text;
    if (text.length <= maxChars) return text;
    if (!this.summarizeFn) return text.substring(0, maxChars);
    try {
      const summary = await this.summarizeFn(text, maxChars, this.config.summaryModel);
      return summary?.trim() || text.substring(0, maxChars);
    } catch (err: any) {
      cliLogger.warn('TTS', `summarize failed, fallback to truncate: ${err.message}`);
      return text.substring(0, maxChars);
    }
  }

  async init(): Promise<void> {
    if (!this.config.enabled) return;
    const providerType = this.config.provider || 'edge';
    const byokApiKey = unwrapApiKey(this.config.apiKey).trim();
    switch (providerType) {
      case 'neoxcloud': {
        const entry = this.cloudResolver?.();
        if (entry?.baseUrl && entry.apiKey) {
          this.provider = new NeoxCloudTTSProvider({
            baseUrl: entry.baseUrl,
            apiKey: entry.apiKey,
            model: this.config.model || 'doubao-tts',
          });
        } else {
          cliLogger.warn('TTS', 'provider=neoxcloud 但网关凭证缺失, 回退 Edge TTS');
          this.provider = new EdgeTTSProvider();
        }
        break;
      }
      case 'dashscope': {
        const apiKey = byokApiKey;
        if (apiKey) {
          this.provider = new DashscopeTtsProvider({
            apiKey,
            apiHost: (this.config as any).dashscopeApiHost || undefined,
            model: this.config.model || 'cosyvoice-v3-plus',
            voice: this.config.voice || 'longanyang',
            format: (this.config.format === 'pcm' || this.config.format === 'mp3') ? this.config.format : 'mp3',
          });
        } else {
          cliLogger.warn('TTS', 'provider=dashscope 但 apiKey 为空, 回退 Edge TTS');
          this.provider = new EdgeTTSProvider();
        }
        break;
      }
      case 'openai':
      case 'custom': {
        const base = (this.config.apiUrl || (providerType === 'openai' ? 'https://api.openai.com/v1' : '')).trim();
        if (base) {
          this.provider = new OpenAICompatTTSProvider({
            baseUrl: base,
            apiKey: byokApiKey,
            model: this.config.model || 'tts-1',
          });
        } else {
          cliLogger.warn('TTS', `provider=${providerType} 但 apiUrl 为空, 回退 Edge TTS`);
          this.provider = new EdgeTTSProvider();
        }
        break;
      }
      case 'local': {
        this.provider = new OpenAICompatTTSProvider({
          baseUrl: 'http://127.0.0.1:43117/v1',
          apiKey: '',
          model: 'melo-zh-en',
        });
        break;
      }
      case 'edge':
        this.provider = new EdgeTTSProvider();
        break;
      default:
        this.provider = new EdgeTTSProvider();
    }
    await this.provider.init();
    cliLogger.info('TTS', `TTS service initialized with provider: ${this.provider.id}`);
  }

  /** 一次性合成（保留兼容） */
  async speak(text: string): Promise<TTSResult | null> {
    if (!this.config.enabled || !this.provider) {
      this.lastSpeakError = !this.config.enabled
        ? 'TTS 未启用 (config.tts.enabled=false)'
        : 'TTS provider 未初始化 —— 引擎没起来 (检查引擎/密钥配置, 或重启应用)';
      return null;
    }
    if (!text || text.trim().length === 0) { this.lastSpeakError = '文本为空'; return null; }

    try {
      const voiceText = await this.prepareText(text);
      /* markdown 清洗可能把纯代码块/富卡 JSON 洗成空 — 空文本不合成 (Edge 会报错) */
      if (!voiceText.trim()) { this.lastSpeakError = '清洗后文本为空 (整段是代码/富卡)'; return null; }
      const result = await this.provider.synthesize(voiceText, {
        voice: this.config.voice,
        speed: this.config.speed,
        format: this.config.format || 'mp3',
      });
      return {
        audio: result.audio.toString('base64'),
        format: result.format,
        voiceSummary: voiceText,
        durationMs: result.durationMs,
      };
    } catch (err: any) {
      this.lastSpeakError = err?.message ? String(err.message) : String(err);
      cliLogger.error('TTS', `TTS synthesis failed: ${err.message}`);
      return null;
    }
  }

  async speakStream(
    text: string,
    onChunk: (base64Chunk: string, index: number) => void,
    onStart?: (voiceText: string) => void,
  ): Promise<{ format: string; totalChunks: number; voiceText: string } | null> {
    if (!this.config.enabled || !this.provider) return null;
    if (!text || text.trim().length === 0) return null;

    const voiceText = await this.prepareText(text);
    if (!voiceText.trim()) return null;
    onStart?.(voiceText);
    const result = await this.provider.synthesizeStream(
      voiceText,
      (chunk, index) => {
        onChunk(chunk.toString('base64'), index);
      },
      {
        voice: this.config.voice,
        speed: this.config.speed,
        format: this.config.format || 'mp3',
      },
    );
    return { format: result.format, totalChunks: result.totalChunks, voiceText };
  }

  async getVoices(): Promise<Array<{ id: string; name: string; locale: string; gender: string }>> {
    if (!this.provider) return [];
    return this.provider.getVoices();
  }

  destroy(): void {
    this.provider?.destroy();
    this.provider = null;
  }
}

/** 花括号配平 (字符串感知): 返回与 start 处 '{' 配对的 '}' 下标, 未闭合 -1 */
function matchBraceEnd(s: string, start: number): number {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 裸卡 JSON 岛 ({"...} 平衡块, ≥30 字符) 整块删除; 未闭合的删到结尾 */
export function stripBareJsonIslands(text: string): string {
  if (!text.includes('{"')) return text;
  let out = '';
  let i = 0;
  for (;;) {
    const start = text.indexOf('{"', i);
    if (start === -1) { out += text.slice(i); break; }
    out += text.slice(i, start);
    const end = matchBraceEnd(text, start);
    if (end === -1) break;                       /* 未闭合 — 后面全是 JSON 残段, 不念 */
    if (end - start + 1 >= 30) out += ' ';       /* 整岛删 */
    else out += text.slice(start, end + 1);      /* 太短 — 可能是正文里的花括号, 保留 */
    i = end + 1;
  }
  return out;
}

export function stripMarkdownForSpeech(text: string): string {
  let t = text;
  /* 代码块 / 富卡 JSON (```restaurant {...}``` 等) — 整块不念 */
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = stripBareJsonIslands(t);
  t = t.replace(/`([^`]+)`/g, '$1');
  /* 图片不念, 链接只念文字 */
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  /* 标题 / 粗斜体 / 删除线 */
  t = t.replace(/^#{1,6}\s*/gm, '');
  t = t.replace(/(\*\*|__)([\s\S]*?)\1/g, '$2');
  t = t.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2');
  t = t.replace(/~~([\s\S]*?)~~/g, '$1');
  /* 列表符 / 引用 / 表格行 / 分隔线 */
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\d+[.、)]\s+/gm, '');
  t = t.replace(/^\s*>\s?/gm, '');
  t = t.replace(/^\s*\|.*\|\s*$/gm, ' ');
  t = t.replace(/^\s*[-=_]{3,}\s*$/gm, ' ');
  /* 残余 XML 标签 (life-reminder-fired 等注入物) 不念 */
  t = t.replace(/<[^>\n]{1,60}>/g, ' ');
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}
