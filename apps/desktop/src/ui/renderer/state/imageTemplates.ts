
import { useSyncExternalStore } from 'react';
import type { ImageParamValues } from './imageGenParams';

export interface ImageTemplateSlot {
  key: string;              // prompt 里的 {key}
  label: string;
  placeholder?: string;
  optional?: boolean;
}

export type ImageTemplateStepOp = 'generate' | 'edit' | 'cutout';

export interface ImageTemplateStep {
  op: ImageTemplateStepOp;
  /** generate/edit 步的提示词 (可带 {槽位}); 不填 = 用模板顶层 prompt. cutout 步不需要. */
  prompt?: string;
  /** 该步参数覆盖 (size/quality/n…). */
  params?: Partial<ImageParamValues>;
  /** 该步模型路由 (专精模型接入点, 如换装路由可灵). */
  model?: string;
}

export interface ImageTemplate {
  id: string;
  name: string;
  emoji?: string;
  /** 单色线条 icon path (24 viewBox) — 能力 chip 用. */
  iconPath?: string;
  desc?: string;
  /** 电商 / 人像 / 修图 / 创意 / 我的 … 插件包可自带新分类. */
  category?: string;
  mode: 'generate' | 'edit';
  /** edit 类要用户主图 (edit 默认 true, 显式 false 可关). */
  needsInput?: boolean;
  /** 要一张参考图 (换装的服装图). */
  needsReference?: boolean;
  referenceLabel?: string;
  /** 出图尺寸提到最大 (高清放大). */
  upscale?: boolean;
  /** 提示词模板, 可带 {槽位}. 智能全在这. */
  prompt: string;
  slots?: ImageTemplateSlot[];
  /** 参数预设 (quality/size/aspect/n…). */
  params?: Partial<ImageParamValues>;
  /** 多步管线 (抠图→合成→…). 不填 = 单步 (mode + prompt). */
  steps?: ImageTemplateStep[];
  /** 模型路由: 这条能力用哪个模型最好 (不填 = 用户当前选中). */
  model?: string;
  /** 示例图 (system/插件模板配真图). */
  cover?: string;
  source: 'system' | 'user';
  createdAt?: number;
}

/* ---------------- 系统内置模板 (原 SYSTEM_CAPABILITIES 收编, id 不变) ---------------- */

export const SYSTEM_TEMPLATES: ImageTemplate[] = [
  {
    id: 'remove-watermark', name: '去水印', emoji: '🧽', category: '修图', mode: 'edit', source: 'system',
    iconPath: 'M20 20H9l-5-5a2 2 0 0 1 0-2.8l8.5-8.5a2 2 0 0 1 2.8 0l4.5 4.5a2 2 0 0 1 0 2.8L13 20 M7.5 11.5l5 5',
    desc: '抹掉水印 / 文字 / logo, 背后自动补全',
    prompt: 'Remove all watermarks, text overlays, logos and stamps from the image. Seamlessly reconstruct the content behind them using the surrounding texture. Keep everything else pixel-identical — do not change the subject, colors, or composition.',
  },
  {
    id: 'upscale', name: '高清放大', emoji: '🔍', category: '修图', mode: 'edit', source: 'system', upscale: true,
    iconPath: 'M15 3h6v6 M9 21H3v-6 M21 3l-7 7 M3 21l7-7',
    desc: '修清晰: 锐化细节、去噪、还原画质',
    prompt: 'Enhance this image to high resolution. Sharpen fine details, remove noise, blur and compression artifacts, restore natural texture and clarity. Do NOT change the content, subject, colors or composition — only improve image quality.',
  },
  {
    id: 'try-on', name: '模特换装', emoji: '👗', category: '电商', mode: 'edit', source: 'system',
    iconPath: 'M20.4 6.5 16 2H8L3.6 6.5a2 2 0 0 0 0 2.8L6 12v9h12v-9l2.4-2.7a2 2 0 0 0 0-2.8Z M9 2a3 3 0 0 0 6 0',
    desc: '上传一件衣服, 换到模特身上 (脸/姿势不变)',
    needsReference: true, referenceLabel: '上传服装图',
    /* 换装提示词 (gpt-image-2 认真调, 不靠换模型): 只换衣服, 其余一切照旧. */
    prompt: 'Edit the FIRST image only. From the SECOND image, take ONLY the clothing garment itself — completely ignore the second image\'s person, face, hair, hat, accessories, pose and background; do NOT copy anything from the second image except the garment. Put that garment onto the person in the first image, replacing their current outfit. Keep absolutely everything else in the first image identical: the exact same face, facial features, expression, hairstyle, skin tone, body shape, pose, hands, headwear, and the entire background, lighting and camera angle. Do NOT add any hat or accessory that is not already in the first image. Do not alter the person\'s identity in any way. Fit the new garment naturally with realistic drape, folds and shadows matching the original lighting. Photorealistic, seamless, indistinguishable from a real photo of the same person wearing the new outfit.',
  },
  {
    id: 'white-bg', name: '白底主图', emoji: '⬜', category: '电商', mode: 'edit', source: 'system',
    iconPath: 'M3 4h18v16H3z M8 15l3-3 2 2 3-3 3 3',
    desc: '换成电商白底主图 (商品不变, 柔光+倒影)',
    prompt: 'Place the product from this image on a clean, seamless pure white studio background (#FFFFFF). Soft even softbox lighting, a subtle natural floor reflection under the product, crisp and centered, e-commerce marketplace hero shot. Keep the product itself EXACTLY identical — same shape, proportions, color, material, texture, text and logo — do not redesign, restyle or add anything to it. Photorealistic professional product photography.',
  },
  {
    id: 'scene', name: '场景图', emoji: '🏞️', category: '电商', mode: 'edit', source: 'system',
    iconPath: 'M3 4h18v16H3z M3 16l5-5 3 3 4-4 6 6 M8.5 9a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4',
    desc: '商品放进真实生活场景 (直接出图, 不合成)',
    prompt: 'Place the product from this image naturally into a beautiful, realistic lifestyle scene that suits this kind of product (a styled tabletop, cozy interior, or fitting outdoor setting). Realistic environment with tasteful props and soft natural lighting, magazine-quality lifestyle product photography. Keep the product itself EXACTLY identical — same shape, proportions, color, material, texture, text and logo — correctly scaled and grounded with realistic contact shadows and reflections. Do NOT alter, restyle or redesign the product.',
  },
];

/* ---------------- 用户模板 store (统一 key + 一次性迁移旧两套) ---------------- */

const KEY = 'neox:image-templates-v1';
const LEGACY_CAP_KEY = 'neox:image-user-capabilities';
const LEGACY_GEN_KEY = 'neox:image-gen-templates';

const listeners = new Set<() => void>();
let cache: ImageTemplate[] | null = null;

/** 一次性迁移: 老 key 里的用户能力/出图模板 → 统一结构. 老 key 不删 (安全回退). */
function migrateLegacy(): ImageTemplate[] {
  const out: ImageTemplate[] = [];
  try {
    const caps = JSON.parse(window.localStorage?.getItem(LEGACY_CAP_KEY) || '[]');
    if (Array.isArray(caps)) {
      for (const c of caps) {
        if (!c?.id || !c?.prompt) continue;
        out.push({
          id: c.id, name: c.name || '未命名', emoji: c.emoji, iconPath: c.iconPath, desc: c.desc,
          category: '我的', mode: 'edit', needsReference: c.needsReference || undefined,
          referenceLabel: c.referenceLabel, upscale: c.upscale || undefined,
          prompt: c.prompt, model: c.model, source: 'user', createdAt: Date.now(),
        });
      }
    }
  } catch { /* ignore */ }
  try {
    const gens = JSON.parse(window.localStorage?.getItem(LEGACY_GEN_KEY) || '[]');
    if (Array.isArray(gens)) {
      for (const g of gens) {
        if (!g?.id || !g?.prompt) continue;
        out.push({
          id: g.id, name: g.name || '未命名', category: '我的', mode: 'generate',
          prompt: g.prompt, params: g.params, source: 'user', createdAt: g.createdAt || Date.now(),
        });
      }
    }
  } catch { /* ignore */ }
  return out;
}

function read(): ImageTemplate[] {
  if (cache) return cache;
  try {
    const raw = window.localStorage?.getItem(KEY);
    if (raw != null) {
      const arr = JSON.parse(raw);
      cache = Array.isArray(arr) ? arr.filter((t) => t && t.id && t.prompt && t.mode) : [];
    } else {
      cache = migrateLegacy();
      window.localStorage?.setItem(KEY, JSON.stringify(cache));
    }
  } catch {
    cache = [];
  }
  return cache!;
}

function write(next: ImageTemplate[]): void {
  cache = next;
  try { window.localStorage?.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  listeners.forEach((l) => { try { l(); } catch { /* ignore */ } });
}

/** 全部模板 (系统 + 用户), 可按 mode/source 过滤. */
export function listImageTemplates(filter?: { mode?: 'generate' | 'edit'; source?: 'system' | 'user' }): ImageTemplate[] {
  let list = [...SYSTEM_TEMPLATES, ...read()];
  if (filter?.mode) list = list.filter(t => t.mode === filter.mode);
  if (filter?.source) list = list.filter(t => t.source === filter.source);
  return list;
}

/** 存用户模板 (同 id 覆盖; dedupName=true 时同名也覆盖 — 兼容旧 GenTemplate 语义). */
export function saveImageTemplate(tpl: Omit<ImageTemplate, 'source' | 'createdAt'> & { createdAt?: number }, opts?: { dedupName?: boolean }): ImageTemplate {
  const full: ImageTemplate = { ...tpl, source: 'user', createdAt: tpl.createdAt ?? Date.now() };
  const rest = read().filter(t => t.id !== full.id && !(opts?.dedupName && t.name === full.name && t.mode === full.mode));
  write([full, ...rest]);
  return full;
}

export function deleteImageTemplate(id: string): void {
  write(read().filter(t => t.id !== id));
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

const getSnapshot = () => read();
export function useImageTemplatesRaw(): ImageTemplate[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
/** 给旧 adapter 用的订阅原语. */
export const __templateStoreInternals = { subscribe };
