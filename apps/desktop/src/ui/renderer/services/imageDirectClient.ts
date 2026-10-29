/**
 * imageDirectClient — renderer 侧图片模式直连封装.
 *
 * composer "创建图片" chip 激活时 (以及图片 surface), 用户敲的 prompt 走这里,
 * 完全绕开 LLM chat completions, 直接调 window.neox.imageDirectGenerate.
 *
 * 相比 agent 通道 (generate_image tool via LLM):
 *   · 无 LLM 延迟 (500ms-2s 的首 token 时间)
 *   · 每次纯粹算图片成本, 不占 chat tokens 配额
 *   · 无对话上下文, 每次独立请求
 *   · 用户不用等 assistant 组织文字回复
 */

export interface DirectGenerateOptions {
  prompt: string;
  model?: string;       // 默认 'gpt-image-1'
  n?: number;           // 默认 1, 最大 10
  size?: string;        // 默认 '1024x1024'
  quality?: string;     // 默认 'high'
  background?: 'auto' | 'opaque' | 'transparent';
  outputCompression?: number;   // 0-100
  providerOptions?: Record<string, unknown>;
  /** 出图档位 —— 普通(第三方) / 高级(全参数聚合商) */
  tier?: 'standard' | 'advanced';
  /** 用户在模型选择器里点中的 provider id —— 订阅 vs BYOK 由用户的选择决定, 不由我们猜 */
  providerId?: string;
  optimizePrompt?: boolean;
  /** 图生图/改图参考图 — dataURL 或公网 URL, 单张或多张. 走 input_references. */
  image?: string | string[];
}

export interface DirectGenerateResult {
  ok: boolean;
  paths: string[];
  fileUrls: string[];
  count: number;
  mode?: 'neoxcloud' | 'byok' | string;
  providerLabel?: string;
  /** 档位选路的结果 —— 前台据此显"普通/高级"而不是供应商名 (供应商绝不外露) */
  tier?: 'standard' | 'advanced';
  model?: string;
  size?: string;
  latencyMs?: number;
  createdAt?: number;
  revisedPrompt?: string;
  error?: string;
  /** 是否真流式 (OpenRouter). false = 降级非流式. */
  streamed?: boolean;
  /** 断连兜底: 只落了部分图. */
  partial?: boolean;
}

/** 流式出图回调 — partial 渐进预览帧 / image 某张成图. */
export interface DirectStreamCallbacks {
  onPartial?: (dataUrl: string, partialIndex?: number) => void;
  onImage?: (dataUrl: string, imageIndex?: number) => void;
}

export interface DirectEditOptions {
  prompt: string;
  /** 源图: 绝对本地路径 · data URL · 公网 URL. */
  source: string;
  mask?: string;
  model?: string;
  n?: number;
  size?: string;
  /** 额外参考图 (dataURL/URL/绝对路径), 如模特换装的服装图. 跟 source 一起进 input_references. */
  references?: string[];
}

/** 直连出图. IPC 未挂 (电脑上没跑 desktop main) 时返 error, 不抛异常. */
export async function directGenerateImage(opts: DirectGenerateOptions): Promise<DirectGenerateResult> {
  const api = (window as any).neox;
  if (!api?.imageDirectGenerate) {
    return { ok: false, paths: [], fileUrls: [], count: 0, error: 'desktop IPC 未就绪 (imageDirectGenerate 缺失)' };
  }
  const result = await api.imageDirectGenerate(opts);
  return {
    ok: result?.ok === true,
    paths: result?.paths ?? [],
    fileUrls: result?.fileUrls ?? [],
    count: result?.count ?? 0,
    mode: result?.mode,
    providerLabel: result?.providerLabel,
    tier: (result as { tier?: 'standard' | 'advanced' } | undefined)?.tier,
    model: result?.model,
    size: result?.size,
    latencyMs: result?.latencyMs,
    createdAt: result?.createdAt,
    revisedPrompt: result?.revisedPrompt,
    error: result?.error,
  };
}

/** 流式直连出图. 边生成边回调 partial 预览帧; IPC 未挂或不支持流式则自动降级到 directGenerateImage.
 *  返回值多带 streamId (供取消). */
export async function directGenerateImageStream(
  opts: DirectGenerateOptions,
  cb?: DirectStreamCallbacks,
): Promise<DirectGenerateResult & { streamId?: string }> {
  const api = (window as any).neox;
  if (!api?.imageDirectGenerateStream) {
    /* 老 preload 没这个能力 → 非流式兜底 (体验退化但不报错). */
    return directGenerateImage(opts);
  }
  const streamId = `imgstream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let unsub: (() => void) | undefined;
  if (api.onImageStreamEvent && cb) {
    unsub = api.onImageStreamEvent((data: any) => {
      if (!data || data.streamId !== streamId) return;
      if (data.kind === 'partial' && data.dataUrl) cb.onPartial?.(data.dataUrl, data.partialIndex);
      else if (data.kind === 'image' && data.dataUrl) cb.onImage?.(data.dataUrl, data.imageIndex);
      /* done/error 由 invoke 的 resolve 处理, 这里不重复 */
    });
  }
  try {
    const result = await api.imageDirectGenerateStream({ ...opts, streamId });
    return {
      ok: result?.ok === true,
      paths: result?.paths ?? [],
      fileUrls: result?.fileUrls ?? [],
      count: result?.count ?? 0,
      mode: result?.mode,
      providerLabel: result?.providerLabel,
    tier: (result as { tier?: 'standard' | 'advanced' } | undefined)?.tier,
      model: result?.model,
      size: result?.size,
      latencyMs: result?.latencyMs,
      createdAt: result?.createdAt,
      revisedPrompt: result?.revisedPrompt,
      error: result?.error,
      streamed: result?.streamed,
      partial: result?.partial,
      streamId,
    };
  } finally {
    unsub?.();
  }
}

/** 取消进行中的流式出图. */
export async function directGenerateAbort(streamId: string): Promise<void> {
  const api = (window as any).neox;
  try { await api?.imageDirectGenerateAbort?.(streamId); } catch { /* noop */ }
}

/** 直连编辑. source 建议传绝对本地路径 (main 会读盘转 dataURL). */
export async function directEditImage(opts: DirectEditOptions): Promise<DirectGenerateResult> {
  const api = (window as any).neox;
  if (!api?.imageDirectEdit) {
    return { ok: false, paths: [], fileUrls: [], count: 0, error: 'desktop IPC 未就绪 (imageDirectEdit 缺失)' };
  }
  const result = await api.imageDirectEdit(opts);
  return {
    ok: result?.ok === true,
    paths: result?.paths ?? [],
    fileUrls: result?.fileUrls ?? [],
    count: result?.count ?? 0,
    mode: result?.mode,
    providerLabel: result?.providerLabel,
    tier: (result as { tier?: 'standard' | 'advanced' } | undefined)?.tier,
    latencyMs: result?.latencyMs,
    error: result?.error,
  };
}

/** 一键抠图/去背景. 透明底优先, 上游不支持时降级白底 (fellBackToWhite=true). */
export async function directCutoutImage(source: string, model?: string): Promise<DirectGenerateResult & { fellBackToWhite?: boolean }> {
  const api = (window as any).neox;
  if (!api?.imageDirectCutout) {
    return { ok: false, paths: [], fileUrls: [], count: 0, error: 'desktop IPC 未就绪 (imageDirectCutout 缺失)' };
  }
  const result = await api.imageDirectCutout({ source, model });
  return {
    ok: result?.ok === true,
    paths: result?.paths ?? [],
    fileUrls: result?.fileUrls ?? [],
    count: result?.count ?? 0,
    mode: result?.mode,
    providerLabel: result?.providerLabel,
    tier: (result as { tier?: 'standard' | 'advanced' } | undefined)?.tier,
    model: result?.model,
    latencyMs: result?.latencyMs,
    createdAt: result?.createdAt,
    error: result?.error,
    fellBackToWhite: result?.fellBackToWhite,
  };
}

/** 图片模式 timeline 事件 (dispatched from composer submit → AgentTimelineView listens).
 *   payload 里 fileUrls 给 <img> 直接用, paths 给"下载"和"再改一下"按钮用.
 *   走 CustomEvent 而非 store — 图片模式产物不进 session store (不占 chat 上下文).
 *   AgentTimelineView 内置一个内存缓冲显示这些 direct-turn, 会话切换/重启就清 (纯 UI 层缓存). */
export interface DirectImageTurnEvent {
  /** 目标图片会话 id — 显式带上, 让全局路由把 turn 落到对的会话槽 (即使那个会话此刻没挂载/用户切走了).
   *  缺省 '__default'. 这是根治"生成中切走 → 完成的图丢失"的关键. */
  sessionId?: string;
  turnId: string;
  prompt: string;
  chipLabel?: string;      // "创建图片"
  createdAt: number;
  status: 'pending' | 'ok' | 'error';
  result?: DirectGenerateResult;
  /** 流式渐进预览: 最新一帧 partial (dataURL). 只在 pending 时用, ok 后被真图替换. */
  partialUrl?: string;
  /** 图生图/改图/换装带上的参考图 (dataURL, 可多张) — 渲染在用户气泡里, 让用户看到"带了哪几张图". */
  refImages?: string[];
}

export const DIRECT_IMAGE_TURN_EVENT = 'neox:direct-image-turn';

export function emitDirectImageTurn(payload: DirectImageTurnEvent): void {
  window.dispatchEvent(new CustomEvent(DIRECT_IMAGE_TURN_EVENT, { detail: payload }));
}
