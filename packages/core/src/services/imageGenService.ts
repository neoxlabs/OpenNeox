/**
 * Image Generation Service — 图像生成 (文生图 · 图生图 · 编辑).
 *
 * 架构 (对齐 ttsService 的双路径心智):
 *   - NeoxCloudImageProvider : 走 NeoxCloud 网关 /n1/images/generations + /n1/images/edits,
 *     HMAC 签名同 chat 路径, 网关按张扣费 (走 image_credits).
 *   - BYOKImageProvider      : 用户自带 API key, 直接打上游 (OpenAI / OpenRouter / Doubao ...),
 *     Neox 不扣积分, 只在 UI 上显示 "BYOK 模式" 徽章.
 *   - ImageGenService        : 统一入口, 通过 resolver 决定走哪条.
 *
 * 两条通道说明 (对齐产品设计):
 *   agent 调用   : 通过 generate_image / edit_image tool, 走 ImageGenService,
 *                  返回图片 URL / dataURL / 本地路径, 供 timeline 图片卡渲染.
 *   直连图片模式 : renderer 通过 IPC 直调 ImageGenService.generate, 不走 LLM,
 *                  用户输入 = prompt (可选一层轻量 optimizer 预处理).
 */

import { createHash } from 'node:crypto';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { loadAutoHmacSigner } from '@neoxlabs/kernel/models/openai.js';
import type { ProviderConfigEntry } from '@neoxlabs/kernel/types/configTypes.js';
import { candidatesForTier, tierOfProvider, type ImageTier } from './imageTierRouting.js';

/** 普通档全灭时抛这个 —— 上层据此显示"服务忙", 不外露任何渠道名。 */
export const IMAGE_TIER_BUSY = 'IMAGE_TIER_BUSY';
import {
  hasCapability,
  providerDeclaresModel,
  resolveProviderForModality,
  resolveCapability,
  resolveChannel,
} from '@neoxlabs/kernel/models/providerCapabilities.js';

// ============================================================================
// Types
// ============================================================================

export type ImageQuality = 'standard' | 'hd' | 'low' | 'medium' | 'high';
export type ImageSize =
  | '256x256' | '512x512' | '1024x1024' | '1024x1536' | '1536x1024'
  | '1792x1024' | '1024x1792' | 'auto';
export type ImageResponseFormat = 'url' | 'b64_json';

export interface ImageGenerationRequest {
  tier?: 'standard' | 'advanced';
  providerId?: string;
  /** 网关侧 model id (e.g. 'gpt-image-1', 'grok-image', 'doubao-seedream-4'). */
  model: string;
  /** 主提示词. 图片模式建议先跑一遍 optimizer 转英文结构化. */
  prompt: string;
  /** 张数. 默认 1. gpt-image-1 支持 1-10, grok 通常 1. */
  n?: number;
  /** 目标尺寸. auto = 让上游选择. */
  size?: ImageSize;
  /** 质量档 (影响成本). standard = 便宜, hd = 高细节. */
  quality?: ImageQuality;
  /** 返回格式. url 便于展示但会过期, b64_json 便于持久化. */
  responseFormat?: ImageResponseFormat;
  /** 风格提示 (dall-e-3 legacy field, gpt-image-1 忽略). */
  style?: string;
  /** 参考图 (图生图 / 编辑). data URL 或 URL, 单张字符串或数组. */
  image?: string | string[];
  /** 编辑蒙版 (仅 edit 路径, dataURL/URL, PNG alpha=编辑区域). */
  mask?: string;
  /** 背景 (gpt-image 系): 'auto' | 'opaque' | 'transparent'. */
  background?: 'auto' | 'opaque' | 'transparent';
  /** 输出压缩 0-100 (gpt-image / OpenRouter, 越低体积越小). */
  outputCompression?: number;
  /** 输入保真度 (gpt-image edit): 'high' 让模型更努力保留原图特征, 尤其人脸/背景, 减少"整张重画"漂移.
   *  官方文档确认: high input fidelity 对编辑保留人脸/风格显著更好. edit 类必开. */
  inputFidelity?: 'high' | 'low';
  /** provider 特定透传参数 (OpenRouter provider.options / 上游私有键). 原样并入 payload. */
  providerOptions?: Record<string, unknown>;
  /** 用户 id (billing 归属, 网关会自己从 API key 反查, 通常留空). */
  user?: string;
}

export interface ImageItem {
  url?: string;
  b64Json?: string;
  revisedPrompt?: string;
}

export interface ImageGenerationResult {
  created: number;
  data: ImageItem[];
  /** 客户端可见的 model id (网关映射后; BYOK 时是上游 raw model). */
  model: string;
  /** 计费信息 (只 NeoxCloud 走 credits). */
  usage?: {
    imagesGenerated: number;
    creditsSpent?: number;
    provider?: string;
    latencyMs?: number;
    /** 上游实际成本 (USD, OpenRouter streaming completed 事件带). */
    costUsd?: number;
  };
}

/* ── 流式出图 (OpenRouter /images stream:true) ── */
export interface ImageStreamEvent {
  /** partial = 渐进预览帧; completed = 某张成图; done = 全部结束. */
  type: 'partial' | 'completed' | 'done';
  /** 该帧/图的 base64 (不含 data: 前缀). */
  b64Json?: string;
  /** partial 帧序号 (同一张图会递增, 越大越清晰). */
  partialIndex?: number;
  /** 第几张图 (n>1). */
  imageIndex?: number;
  /** MIME, 如 image/png. */
  mediaType?: string;
  /** completed 事件带的成本/用量. */
  usage?: { costUsd?: number; totalTokens?: number };
}
export type ImageStreamHandler = (ev: ImageStreamEvent) => void;

// ============================================================================
// Provider Interface
// ============================================================================

export interface ImageProvider {
  readonly id: string;
  generate(req: ImageGenerationRequest): Promise<ImageGenerationResult>;
  /**
   * edit 路径 — 图生图 / inpaint. 部分 provider 可能不支持, 抛错即可.
   * gpt-image-1 通过 POST /v1/images/edits 支持 image+mask.
   */
  edit(req: ImageGenerationRequest): Promise<ImageGenerationResult>;
  /**
   * 流式出图 (可选) — 边生成边推 partial 预览帧. 只有支持的 provider (OpenRouter) 实现;
   * 不实现时 ImageGenService 自动降级到 generate() 并合成一个 completed 事件.
   */
  generateStream?(req: ImageGenerationRequest, onEvent: ImageStreamHandler, signal?: AbortSignal): Promise<ImageGenerationResult>;
}

// ============================================================================
// NeoxCloud Provider
// ============================================================================

export interface NeoxCloudImageOptions {
  /** 网关 base URL (以 /n1 结尾, 同 chat 路径). */
  baseUrl: string;
  /** 网关 apiKey (nxk / JWT). */
  apiKey: string;
}

/**
 * 走 NeoxCloud 网关 → 上游 provider (OpenAI / OpenRouter / Doubao ...).
 * HMAC 签名同 chat / tts, 网关按张扣 image_credits.
 */
export class NeoxCloudImageProvider implements ImageProvider {
  readonly id = 'neoxcloud';
  private baseUrl: string;
  private apiKey: string;

  constructor(opts: NeoxCloudImageOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
  }

  async generate(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    return this.callEndpoint('/images/generations', req);
  }

  async edit(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (!req.image) {
      throw new Error('edit_image: image field required (data URL or public URL)');
    }
    return this.callEndpoint('/images/edits', req);
  }

  private async callEndpoint(subPath: string, req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const url = `${this.baseUrl}${subPath}`;
    const payload: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
    };
    if (req.n && req.n > 0) payload.n = req.n;
    if (req.size) payload.size = req.size;
    if (req.quality) payload.quality = req.quality;
    if (req.responseFormat) payload.response_format = req.responseFormat;
    if (req.style) payload.style = req.style;
    if (req.image) payload.image = req.image;
    if (req.mask) payload.mask = req.mask;
    if (req.user) payload.user = req.user;
    /* 档位 —— 订阅侧唯一能表达"要便宜的还是要全参数的"的方式。
     * BYOK 侧我们看得见每个 provider 的 baseUrl, 自己就能分档 (imageTierRouting);
     * 走网关时看不见背后是哪条路由, 不发这个字段的话用户点"普通"照样可能被轮到贵的那条。
     * 网关只拿它选路, 不转发给上游。 */
    if (req.tier) payload.tier = req.tier;
    /* 下面这几个原来漏了 —— 于是"背景/压缩/透传参数"在**订阅路径上整个失效**,
     * 而 BYOK 路径 (buildPayload) 一直是转发的。同一个参数面板, 两条路径两种行为。 */
    if (req.background) payload.background = req.background;
    if (typeof req.outputCompression === 'number') payload.output_compression = req.outputCompression;
    if (req.providerOptions) {
      for (const [k, v] of Object.entries(req.providerOptions)) {
        if (!(k in payload)) payload[k] = v;
      }
    }

    const bodyStr = JSON.stringify(payload);
    const sigPath = new URL(url).pathname; // /n1/images/generations

    const { getNeoxUserAgent } = await import('@neoxlabs/kernel/models/openai.js');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'User-Agent': getNeoxUserAgent(),
    };

    // HMAC 签名 — v2, 绑 Bearer 指纹 + device fp.
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

    const startedAt = Date.now();
    const resp = await fetch(url, { method: 'POST', headers, body: bodyStr });
    const latencyMs = Date.now() - startedAt;
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`NeoxCloud image ${subPath} failed: ${resp.status} ${errText.slice(0, 500)}`);
    }
    const json = await resp.json() as any;
    const data: ImageItem[] = Array.isArray(json?.data)
      ? json.data.map((d: any) => ({
          url: typeof d?.url === 'string' ? d.url : undefined,
          b64Json: typeof d?.b64_json === 'string' ? d.b64_json : undefined,
          revisedPrompt: typeof d?.revised_prompt === 'string' ? d.revised_prompt : undefined,
        }))
      : [];
    return {
      created: typeof json?.created === 'number' ? json.created : Math.floor(Date.now() / 1000),
      data,
      model: typeof json?.model === 'string' ? json.model : req.model,
      usage: {
        imagesGenerated: data.length,
        creditsSpent: typeof json?.credits_spent === 'number' ? json.credits_spent : undefined,
        provider: 'neoxcloud',
        latencyMs,
      },
    };
  }
}

// ============================================================================
// BYOK Provider — 用户自带 key, 直连上游.
// ============================================================================

/** 图生图 (edit) 上游载荷格式 —— 不同上游/代理不一样, 属于协议层, 按 provider 确定, **绝不运行时试错**.
 *   · 'images-array' : { images: [{ image_url: { url } }] }  (现代 gpt-image 代理, 如 relay-b — 默认)
 *   · 'image-field'  : { image: <dataURL/URL>, mask? }       (经典 OpenAI 兼容)
 *  (OpenRouter 走独立的 /images + input_references, 由 baseUrl 判定, 不在此列.) */
export type ImageEditFormat = 'images-array' | 'image-field';

export interface BYOKImageOptions {
  /** 上游 API base URL, 如 'https://openrouter.ai/api/v1' or 'https://api.openai.com/v1'. */
  baseUrl: string;
  /** 上游 API key. */
  apiKey: string;
  /** 可选 extra headers (OpenRouter 需要 HTTP-Referer / X-Title). */
  extraHeaders?: Record<string, string>;
  /** 图生图编辑载荷格式 (非 OpenRouter). 缺省 'images-array' (现代代理默认). 用户可在设置里显式指定. */
  imageEditFormat?: ImageEditFormat;
}

export class BYOKImageProvider implements ImageProvider {
  readonly id = 'byok';
  private baseUrl: string;
  private apiKey: string;
  private extraHeaders: Record<string, string>;
  private imageEditFormat: ImageEditFormat;

  constructor(opts: BYOKImageOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.imageEditFormat = opts.imageEditFormat ?? 'images-array';
  }

  /** OpenRouter 走统一 /images 端点 (2026 版). 其它 provider 仍走 OpenAI 老 /images/generations. */
  private isOpenRouter(): boolean {
    return this.baseUrl.includes('openrouter.ai');
  }

  async generate(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const subPath = this.isOpenRouter() ? '/images' : '/images/generations';
    return this.callEndpoint(subPath, req);
  }

  async edit(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (!req.image) {
      throw new Error('edit_image (BYOK): image field required');
    }
    /* OpenRouter 编辑走同一 /images 端点 (input_references 就是编辑). */
    if (this.isOpenRouter()) return this.callEndpoint('/images', req);

    const payload = this.buildPayload('/images/edits', req);   // 含通用字段 + 老式 image/mask
    if (this.imageEditFormat === 'images-array') {
      const refs = Array.isArray(req.image) ? req.image : [req.image];
      delete payload.image; delete payload.mask;
      payload.images = refs.map((url) => ({ image_url: { url } }));
    }
    /* 'image-field' → 保留 buildPayload 里的 image/mask 原样. */
    return this.postPayload('/images/edits', payload, req);
  }

  /** 构造上游 payload (generate/edit/stream 共用). */
  private buildPayload(subPath: string, req: ImageGenerationRequest): Record<string, unknown> {
    const openrouter = this.isOpenRouter() && subPath === '/images';
    const payload: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
    };
    if (req.n && req.n > 0) payload.n = req.n;
    if (req.size) payload.size = req.size;
    if (req.quality) payload.quality = req.quality;
    if (req.background) payload.background = req.background;
    if (req.inputFidelity) payload.input_fidelity = req.inputFidelity;
    if (typeof req.outputCompression === 'number') payload.output_compression = req.outputCompression;
    if (openrouter) {
      if (req.image) {
        const refs = Array.isArray(req.image) ? req.image : [req.image];
        payload.input_references = refs.map(url => ({ type: 'image_url', image_url: { url } }));
      }
      /* OpenRouter 无 mask 概念, 编辑区靠 prompt 描述 */
    } else {
      if (req.responseFormat) payload.response_format = req.responseFormat;
      if (req.style) payload.style = req.style;
      if (req.image) payload.image = req.image;
      if (req.mask) payload.mask = req.mask;
    }
    /* provider 特定透传键 (原样并入, 覆盖优先级最低: 不覆盖上面显式设过的). */
    if (req.providerOptions) {
      for (const [k, v] of Object.entries(req.providerOptions)) {
        if (!(k in payload)) payload[k] = v;
      }
    }
    if (req.user) payload.user = req.user;
    return payload;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    };
  }

  private async callEndpoint(subPath: string, req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    return this.postPayload(subPath, this.buildPayload(subPath, req), req);
  }

  /** 发一个已构造好的 payload 到某端点, 解析成 ImageGenerationResult. (供 callEndpoint + 编辑自适应复用) */
  private async postPayload(subPath: string, payload: Record<string, unknown>, req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const url = `${this.baseUrl}${subPath}`;
    const headers = this.headers();
    const startedAt = Date.now();
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const latencyMs = Date.now() - startedAt;
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`BYOK image ${subPath} failed: ${resp.status} ${errText.slice(0, 500)}`);
    }
    const json = await resp.json() as any;
    const data: ImageItem[] = Array.isArray(json?.data)
      ? json.data.map((d: any) => ({
          url: typeof d?.url === 'string' ? d.url : undefined,
          b64Json: typeof d?.b64_json === 'string' ? d.b64_json : undefined,
          revisedPrompt: typeof d?.revised_prompt === 'string' ? d.revised_prompt : undefined,
        }))
      : [];
    return {
      created: typeof json?.created === 'number' ? json.created : Math.floor(Date.now() / 1000),
      data,
      model: typeof json?.model === 'string' ? json.model : req.model,
      usage: {
        imagesGenerated: data.length,
        provider: 'byok',
        latencyMs,
      },
    };
  }

  async generateStream(req: ImageGenerationRequest, onEvent: ImageStreamHandler, signal?: AbortSignal): Promise<ImageGenerationResult> {
    if (!this.isOpenRouter()) {
      throw new Error('generateStream: 仅 OpenRouter 支持流式, 当前 provider 走非流式');
    }
    const url = `${this.baseUrl}/images`;
    const payload = this.buildPayload('/images', req);
    payload.stream = true;
    const bodyStr = JSON.stringify(payload);

    const startedAt = Date.now();
    const resp = await fetch(url, { method: 'POST', headers: this.headers(), body: bodyStr, signal });
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`BYOK image /images (stream) failed: ${resp.status} ${errText.slice(0, 500)}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const images: string[] = [];
    let created: number | undefined;
    let costUsd: number | undefined;

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) return;          // 心跳注释行
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') { onEvent({ type: 'done' }); return; }
      let ev: any;
      try { ev = JSON.parse(data); } catch { return; }
      if (ev?.type === 'image_generation.partial_image') {
        onEvent({ type: 'partial', b64Json: ev.b64_json, partialIndex: ev.partial_image_index, mediaType: ev.media_type });
      } else if (ev?.type === 'image_generation.completed') {
        if (typeof ev.b64_json === 'string') {
          images.push(ev.b64_json);
          const cu = typeof ev?.usage?.cost === 'number' ? ev.usage.cost : undefined;
          onEvent({ type: 'completed', b64Json: ev.b64_json, imageIndex: images.length - 1, mediaType: ev.media_type, usage: { costUsd: cu, totalTokens: ev?.usage?.total_tokens } });
        }
        if (typeof ev?.created === 'number') created = ev.created;
        if (typeof ev?.usage?.cost === 'number') costUsd = (costUsd ?? 0) + ev.usage.cost;
      } else if (ev?.error) {
        throw new Error(`stream error: ${typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error).slice(0, 300)}`);
      }
    };

    /* 韧性: 长连接 (高清出图 200s+) 中途 blip 很常见. 只要已经收到过成图, 断了就用已有的,
     * 绝不因半路错误抛出 —— 否则 service 层会当"流式失败"整张重生成 (慢一倍 + 看着像重复). */
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let done = false;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (readErr) {
        if (images.length > 0) break;   // 已有图 → 用它, 别重生成
        throw readErr;                   // 一张都没有才算真失败 (让上层决定重试)
      }
      if (done) break;
      if (value) buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          handleLine(line);
        } catch (lineErr) {
          if (images.length > 0) { buf = ''; break; }  // 已有图, 忽略后续错误行
          throw lineErr;
        }
      }
    }
    try { if (buf.trim()) handleLine(buf); } catch { /* 已到成图时末行错误无所谓 */ }

    return {
      created: created ?? Math.floor(Date.now() / 1000),
      data: images.map(b => ({ b64Json: b })),
      model: req.model,
      usage: {
        imagesGenerated: images.length,
        provider: 'byok',
        latencyMs: Date.now() - startedAt,
        costUsd,
      },
    };
  }
}

// ============================================================================
// Service Manager
// ============================================================================

/** Resolver 回调 - 返 NeoxCloud 网关 baseUrl + nxk (登录状态). undefined 表示未登录. */
export type CloudImageResolver = () => { baseUrl?: string; apiKey?: string } | undefined;

/** Resolver 回调 - 返 BYOK 图像配置 (用户在设置里填的). undefined 表示未启用 BYOK.
 *  Legacy 单配置模式 (兼容, 早期 UI 只支持一个 BYOK image provider). */
export interface BYOKImageConfig {
  baseUrl: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
  /** 显示给用户的 provider 名 (如 'OpenRouter', 'OpenAI'). */
  providerLabel?: string;
}
export type BYOKImageResolver = () => BYOKImageConfig | undefined;

/** Resolver 回调 - 返完整 provider 列表 (来自 config.providers). 新模型: 挂上后 service 自动走
 *  capability system 挑第一个有 image 能力的 provider, 用户不再需要单独配 "BYOK image" 字段.
 *  存在 providersResolver 时优先级最高 (覆盖 legacy byokResolver). */
export type ProvidersListResolver = () => Iterable<ProviderConfigEntry>;

export class ImageGenService {
  private cloudResolver: CloudImageResolver | null = null;
  private byokResolver: BYOKImageResolver | null = null;
  private providersResolver: ProvidersListResolver | null = null;
  private cloudProvider: NeoxCloudImageProvider | null = null;
  private cloudSig = '';
  private byokProvider: BYOKImageProvider | null = null;
  private byokSig = '';

  setCloudResolver(fn: CloudImageResolver): void {
    this.cloudResolver = fn;
  }

  setBYOKResolver(fn: BYOKImageResolver): void {
    this.byokResolver = fn;
  }

  /** 挂 providers 列表 resolver (新架构). 挂后自动走 capability system, 覆盖 legacy BYOK. */
  setProvidersResolver(fn: ProvidersListResolver): void {
    this.providersResolver = fn;
  }

  private cloudImageModelsResolver: (() => string[]) | null = null;

  /** 挂云端可用出图模型 resolver. 未挂 / 返空 = 当作"云端没有出图能力". */
  setCloudImageModelsResolver(fn: (() => string[]) | null): void {
    this.cloudImageModelsResolver = fn;
  }

  /**
   * 此刻**真的可用**的出图模型。给工具描述用 —— 宁可少列, 绝不瞎列。
   * @returns cloud/byok 两段分开, 调用方决定怎么措辞
   */
  listAvailableImageModels(): { cloud: string[]; byok: string[] } {
    const cloud = (() => {
      try { return this.cloudImageModelsResolver?.() ?? []; } catch { return []; }
    })();
    const byok: string[] = [];
    for (const p of this.listProviders()) {
      if (!hasCapability(p, 'image') && !hasCapability(p, 'image-edit')) continue;
      for (const m of (p.models ?? [])) {
        const id = typeof m === 'string' ? m : (m as { name?: string; id?: string })?.name
          ?? (m as { id?: string })?.id;
        if (id && !byok.includes(id)) byok.push(id);
      }
    }
    return { cloud: [...new Set(cloud)], byok };
  }

  /** 取当前 providers 列表 (解密+实时, 来自 resolver). UI 拉图像模型能力目录时用. 空 = 未挂 resolver. */
  listProviders(): ProviderConfigEntry[] {
    return this.providersResolver ? Array.from(this.providersResolver()) : [];
  }

  /** 强制 BYOK (哪怕云端已登录). 用于 UI 让用户显式切换. */
  private preferByok = false;
  setPreferBYOK(v: boolean): void { this.preferByok = v; }

  /** 尝试从 providers 列表走 capability system 挑一个 image provider. 返 null 表示没配对上. */
  private tryProvidersList(
    modality: 'image' | 'image-edit',
    model?: string,
    opts: { requireDeclared?: boolean } = {},
  ): { provider: BYOKImageProvider; mode: 'byok'; label?: string } | null {
    if (!this.providersResolver) return null;
    const providers = [...this.providersResolver()];
    /* requireDeclared: 只接受**显式声明了这个模型**的 provider, 不要"有 image 能力就凑合".
     * 用在"云端登录时也要先看本地有没有这个模型"那条路上 —— 凑合会把
     * 云端专属模型 (gpt-image-2) 误发给某个只声明了别的模型的第三方。 */
    if (opts.requireDeclared) {
      if (!model) return null;
      const exact = providers.find((p) => hasCapability(p, modality) && providerDeclaresModel(p, model))
        ?? providers.find((p) => hasCapability(p, 'image') && providerDeclaresModel(p, model));
      if (!exact) return null;
      const cap = resolveCapability(exact, modality) ?? resolveCapability(exact, 'image');
      if (!cap) return null;
      const ch = resolveChannel(exact, { modality, model });
      const apiKey = ch.apiKey || exact.apiKey;
      const baseUrl = ch.baseUrl || exact.baseUrl;
      if (!apiKey || !baseUrl) return null;
      return {
        provider: new BYOKImageProvider({
          baseUrl, apiKey,
          extraHeaders: (exact as { extraHeaders?: Record<string, string> }).extraHeaders,
        }),
        mode: 'byok',
        label: exact.name ?? exact.id,
      };
    }
    /* image-edit 用户没配也允许降级到 image (grok 类不支持编辑时至少能出图报错清晰). */
    const chosen = resolveProviderForModality(providers, modality, model)
      ?? resolveProviderForModality(providers, 'image', model);
    if (!chosen) return null;
    const cap = resolveCapability(chosen, modality) ?? resolveCapability(chosen, 'image');
    if (!cap) return null;
    const ch = resolveChannel(chosen, { modality, model });
    const apiKey = ch.apiKey || chosen.apiKey;
    const baseUrl = ch.baseUrl || chosen.baseUrl;
    if (!apiKey || !baseUrl) return null;
    const sig = `${chosen.id}|${baseUrl}|${apiKey.slice(0, 8)}|${cap.protocol}|${(chosen as { imageEditFormat?: string }).imageEditFormat ?? ''}`;
    if (!this.byokProvider || this.byokSig !== sig) {
      this.byokProvider = new BYOKImageProvider({
        baseUrl,
        apiKey,
        extraHeaders: chosen.extraHeaders,
        imageEditFormat: (chosen as { imageEditFormat?: ImageEditFormat }).imageEditFormat,
      });
      this.byokSig = sig;
    }
    return { provider: this.byokProvider, mode: 'byok', label: chosen.name };
  }

  /**
   * 按档位取**有序**的本地渠道候选 (供 failover 逐个试)。
   * 只回本档 —— 跨档回落绝不在这里发生, 见 imageTierRouting 顶部注释。
   */
  private tierCandidates(
    tier: ImageTier,
    modality: 'image' | 'image-edit',
    model?: string,
  ): Array<{ provider: BYOKImageProvider; label: string }> {
    if (!this.providersResolver) return [];
    const out: Array<{ provider: BYOKImageProvider; label: string }> = [];
    for (const c of candidatesForTier(this.providersResolver(), tier, modality, model)) {
      const cap = resolveCapability(c.provider, modality) ?? resolveCapability(c.provider, 'image');
      if (!cap) continue;
      const ch = resolveChannel(c.provider, { modality, model });
      const apiKey = ch.apiKey || c.provider.apiKey;
      const baseUrl = ch.baseUrl || c.provider.baseUrl;
      if (!apiKey || !baseUrl) continue;
      out.push({
        provider: new BYOKImageProvider({
          baseUrl, apiKey,
          extraHeaders: (c.provider as { extraHeaders?: Record<string, string> }).extraHeaders,
        }),
        label: c.provider.name ?? c.provider.id,
      });
    }
    return out;
  }

  /** 按用户点中的 provider 直达。订阅 sentinel → 云端通道; 其余 → 本地那家。 */
  private providerById(
    modality: 'image' | 'image-edit',
    model: string | undefined,
    providerId: string,
  ): { provider: ImageProvider; mode: 'neoxcloud' | 'byok'; label?: string } | null {
    const norm = providerId.replace(/-/g, '').toLowerCase();
    if (norm === 'neoxcloud') {
      const cloud = this.cloudResolver?.();
      if (!cloud?.baseUrl || !cloud.apiKey) return null;
      const sig = `${cloud.baseUrl}|${cloud.apiKey.slice(0, 8)}`;
      if (!this.cloudProvider || this.cloudSig !== sig) {
        this.cloudProvider = new NeoxCloudImageProvider({ baseUrl: cloud.baseUrl, apiKey: cloud.apiKey });
        this.cloudSig = sig;
      }
      return { provider: this.cloudProvider, mode: 'neoxcloud' };
    }
    if (!this.providersResolver) return null;
    const hit = [...this.providersResolver()].find((p) => String(p.id) === providerId);
    if (!hit) return null;
    const ch = resolveChannel(hit, { modality, model });
    const apiKey = ch.apiKey || hit.apiKey;
    const baseUrl = ch.baseUrl || hit.baseUrl;
    if (!apiKey || !baseUrl) return null;
    return {
      provider: new BYOKImageProvider({
        baseUrl, apiKey,
        extraHeaders: (hit as { extraHeaders?: Record<string, string> }).extraHeaders,
      }),
      mode: 'byok',
      label: hit.name ?? hit.id,
    };
  }

  private currentProvider(modality: 'image' | 'image-edit', model?: string, providerId?: string): { provider: ImageProvider; mode: 'neoxcloud' | 'byok'; label?: string } {
    if (providerId) {
      const direct = this.providerById(modality, model, providerId);
      if (direct) return direct;
      /* 指定了但找不到 → 不静默换一家 (那等于无视用户的选择), 让它落到通用路径,
       * 由上层给出可诊断的错误。 */
    }

    // 优先级: preferByok → providersResolver → cloudResolver → legacy byokResolver
    if (this.preferByok) {
      const fromList = this.tryProvidersList(modality, model);
      if (fromList) return fromList;
      // 老 BYOK 兜底
      const byok = this.byokResolver?.();
      if (byok?.baseUrl && byok.apiKey) {
        const sig = `${byok.baseUrl}|${byok.apiKey.slice(0, 8)}`;
        if (!this.byokProvider || this.byokSig !== sig) {
          this.byokProvider = new BYOKImageProvider(byok);
          this.byokSig = sig;
        }
        return { provider: this.byokProvider, mode: 'byok', label: byok.providerLabel };
      }
    }
    const declaredLocally = model ? this.tryProvidersList(modality, model, { requireDeclared: true }) : null;
    if (declaredLocally) return declaredLocally;

    const cloudModels = (() => {
      try { return this.cloudImageModelsResolver?.() ?? []; } catch { return []; }
    })();
    const cloudHasModel = !model || cloudModels.length === 0 || cloudModels.includes(model);

    // 云端登录 → 走 NeoxCloud
    const cloud = this.cloudResolver?.();
    if (!cloudHasModel) {
      /* 云端明确没有这个模型 —— 别把请求送去换一个 404, 直接看本地还有没有能接的 */
      const fromListFirst = this.tryProvidersList(modality, model);
      if (fromListFirst) return fromListFirst;
    }
    if (cloud?.baseUrl && cloud.apiKey) {
      const sig = `${cloud.baseUrl}|${cloud.apiKey.slice(0, 8)}`;
      if (!this.cloudProvider || this.cloudSig !== sig) {
        this.cloudProvider = new NeoxCloudImageProvider({ baseUrl: cloud.baseUrl, apiKey: cloud.apiKey });
        this.cloudSig = sig;
      }
      return { provider: this.cloudProvider, mode: 'neoxcloud' };
    }
    // 云端未登录 → 从 providers 列表挑
    const fromList = this.tryProvidersList(modality, model);
    if (fromList) return fromList;
    // 最兜底: 老 BYOK
    const byok = this.byokResolver?.();
    if (byok?.baseUrl && byok.apiKey) {
      const sig = `${byok.baseUrl}|${byok.apiKey.slice(0, 8)}`;
      if (!this.byokProvider || this.byokSig !== sig) {
        this.byokProvider = new BYOKImageProvider(byok);
        this.byokSig = sig;
      }
      return { provider: this.byokProvider, mode: 'byok', label: byok.providerLabel };
    }
    throw new Error(
      'ImageGenService: 当前没有配置任何图像生成通道 —— 这是配置问题, **换模型名重试无效, 不要重试**。'
      + ' 需要用户去做其中一件: (1) 登录 NeoxCloud; (2) 在设置里启用 BYOK 图像并填 baseUrl + apiKey'
      + ' (注意: 聊天用的 provider 不会自动用于图像, 图像是独立开关);'
      + ' (3) 添加一个具备 image capability 的 provider (OpenAI / OpenRouter / 豆包 / 智谱 / 通义万相 等)。'
      + ' 请直接把这条告诉用户, 让用户去配置。',
    );
  }

  async generate(req: ImageGenerationRequest): Promise<ImageGenerationResult & { mode: string; providerLabel?: string; tier?: ImageTier }> {
    const tier = req.tier;
    if (tier && !req.providerId) {
      const cands = this.tierCandidates(tier, 'image', req.model);
      const errors: string[] = [];
      for (const c of cands) {
        try {
          cliLogger.debug('IMAGEGEN', `generate tier=${tier} label=${c.label} model=${req.model}`);
          const result = await c.provider.generate(req);
          return { ...result, mode: 'byok', tier };
        } catch (err) {
          errors.push(`${c.label}: ${(err as Error)?.message ?? String(err)}`.slice(0, 160));
        }
      }
      if (cands.length > 0) {
        cliLogger.warn('IMAGEGEN', `tier=${tier} 全部渠道失败: ${errors.join(' | ')}`);
        throw new Error(IMAGE_TIER_BUSY);
      }
      /* 本档一个渠道都没配 —— 这不是"忙", 是没配置, 让它落到下面的通用选路去,
       * 由那边给出"没有配置任何图像生成通道"这类可操作的提示。 */
    }

    const { provider, mode, label } = this.currentProvider('image', req.model, req.providerId);
    cliLogger.debug('IMAGEGEN', `generate model=${req.model} mode=${mode} label=${label ?? '-'} size=${req.size ?? 'auto'} n=${req.n ?? 1}`);
    const result = await provider.generate(req);
    return { ...result, mode, providerLabel: label };
  }

  /**
   * 流式出图 — provider 支持就走 SSE 渐进; 不支持 (NeoxCloud / 非 OpenRouter BYOK) 就降级到
   * generate() 并合成 completed 事件, 上层 UI 逻辑不用分叉.
   */
  async generateStream(
    req: ImageGenerationRequest,
    onEvent: ImageStreamHandler,
    signal?: AbortSignal,
  ): Promise<ImageGenerationResult & { mode: string; providerLabel?: string; streamed: boolean }> {
    const { provider, mode, label } = this.currentProvider('image', req.model, req.providerId);
    if (typeof provider.generateStream === 'function') {
      try {
        cliLogger.debug('IMAGEGEN', `generateStream(stream) model=${req.model} mode=${mode} label=${label ?? '-'}`);
        const result = await provider.generateStream(req, onEvent, signal);
        return { ...result, mode, providerLabel: label, streamed: true };
      } catch (err: any) {
        /* 上游不支持流式 (报错) 时降级. AbortError 直接抛 (用户主动取消). */
        if (err?.name === 'AbortError') throw err;
        cliLogger.debug('IMAGEGEN', `stream failed, fallback to generate: ${err?.message || err}`);
      }
    }
    /* 降级非流式: 有参考图 = 图生图, 必须走 edit() (对的 /images/edits + imageEditFormat),
     *   不能走 generate() 把 image 塞进文生图端点 —— 那样上游忽略图 / 返空 = "no images" bug. */
    const isImg2Img = !!req.image && (!Array.isArray(req.image) || req.image.length > 0);
    cliLogger.debug('IMAGEGEN', `generateStream(fallback,${isImg2Img ? 'edit' : 'gen'}) model=${req.model} mode=${mode}`);
    const result = isImg2Img ? await provider.edit(req) : await provider.generate(req);
    for (let i = 0; i < result.data.length; i++) {
      const b = result.data[i]?.b64Json;
      if (b) onEvent({ type: 'completed', b64Json: b, imageIndex: i });
    }
    onEvent({ type: 'done' });
    return { ...result, mode, providerLabel: label, streamed: false };
  }

  async edit(req: ImageGenerationRequest): Promise<ImageGenerationResult & { mode: string; providerLabel?: string }> {
    const { provider, mode, label } = this.currentProvider('image-edit', req.model, req.providerId);
    cliLogger.debug('IMAGEGEN', `edit model=${req.model} mode=${mode} label=${label ?? '-'}`);
    const result = await provider.edit(req);
    return { ...result, mode, providerLabel: label };
  }
}

// ============================================================================
// Singleton 便利实例 — CLI/renderer 挂 resolver 后共用.
// ============================================================================

let sharedInstance: ImageGenService | null = null;

export function getImageGenService(): ImageGenService {
  if (!sharedInstance) sharedInstance = new ImageGenService();
  return sharedInstance;
}
