
import { useSyncExternalStore } from 'react';

export type ParamValue = string | number | boolean;
export type ImageParamValues = Record<string, ParamValue>;

const STORAGE_KEY = 'neox:image-gen-params-v2';

/* 合理默认 (只在模型支持对应 key 时生效; 面板会按模型能力裁剪). */
const DEFAULTS: ImageParamValues = { quality: 'high', n: 1 };

function load(): ImageParamValues {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

let current: ImageParamValues = load();
const listeners = new Set<() => void>();

function emit(): void {
  try { window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(current)); } catch { /* ignore */ }
  listeners.forEach(l => l());
}

export function getImageParamValues(): ImageParamValues {
  return current;
}

export function setImageParam(key: string, value: ParamValue): void {
  current = { ...current, [key]: value };
  emit();
}

/** 按模型能力裁剪当前值 (去掉该模型不支持的 key), 缺省值补上. 换模型时调. */
export function reconcileImageParams(supportedKeys: string[], defaults: ImageParamValues): void {
  const next: ImageParamValues = {};
  for (const k of supportedKeys) {
    next[k] = current[k] ?? defaults[k];
  }
  current = next;
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useImageParamValues(): ImageParamValues {
  return useSyncExternalStore(subscribe, getImageParamValues, getImageParamValues);
}

/* 出图请求已知字段 (映射到 DirectGenerateOptions 顶层), 其余走 providerOptions. */
const KNOWN_FIELDS = new Set(['quality', 'n', 'size', 'background', 'output_compression']);

export interface BuiltRequestParams {
  /** 出图档位 —— 决定走哪一档渠道 (普通=第三方便宜 / 高级=全参数)。 */
  tier?: 'standard' | 'advanced';
  quality?: string;
  n?: number;
  size?: string;
  background?: 'auto' | 'opaque' | 'transparent';
  outputCompression?: number;
  providerOptions?: Record<string, unknown>;
}

const GPT_SIZE_TABLE: Record<string, Record<string, string>> = {
  '1:1': { '1K': '1024x1024', '2K': '2048x2048', '4K': '3072x3072' },
  '2:3': { '1K': '1024x1536', '2K': '1536x2304', '4K': '2560x3840' },
  '3:2': { '1K': '1536x1024', '2K': '2304x1536', '4K': '3840x2560' },
};

/** 把 store 值拆成 DirectGenerateOptions 字段 + providerOptions 透传. */
export function buildRequestParams(values: ImageParamValues): BuiltRequestParams {
  const out: BuiltRequestParams = {};
  const extra: Record<string, unknown> = {};
  const hasGptAspect = values.aspect !== undefined; // gpt 家族用 'aspect' (区别于 gemini 的 'aspect_ratio')
  const fmt = String(values.output_format || '');   // png 默认
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null || v === '') continue;
    if (k === 'tier') out.tier = v === 'standard' ? 'standard' : 'advanced';
    else if (k === 'quality') out.quality = String(v);
    else if (k === 'n') out.n = Number(v);
    else if (k === 'size') out.size = String(v);
    else if (k === 'background') out.background = v as any;
    else if (k === 'output_compression') {
      /* OpenAI: output_compression 只在 output_format=jpeg/webp 时合法, png 下发会 400. */
      if (fmt === 'jpeg' || fmt === 'webp') out.outputCompression = Number(v);
    }
    else if (k === 'aspect') continue;                       // gpt 内部, 下面算成 size
    else if (k === 'resolution' && hasGptAspect) continue;   // gpt 内部 (有 aspect 时), 参与算 size
    else if (!KNOWN_FIELDS.has(k)) extra[k] = v;             // gemini aspect_ratio/resolution · seed · output_format ...
  }
  /* gpt: 比例 × 清晰度 → size. auto 比例直接 size=auto. */
  if (hasGptAspect && out.size === undefined) {
    const asp = String(values.aspect);
    out.size = asp === 'auto' ? 'auto' : (GPT_SIZE_TABLE[asp]?.[String(values.resolution || '1K')] ?? '1024x1024');
  }
  if (Object.keys(extra).length > 0) out.providerOptions = extra;
  return out;
}
