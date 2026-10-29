
export type ParamType = 'enum' | 'range' | 'size' | 'boolean';

export interface ParamSpec {
  key: string;                 // 标准参数键 (quality/size/aspect_ratio/resolution/background/n/output_format/output_compression/seed)
  type: ParamType;
  labelZh: string;
  labelEn: string;
  values?: Array<{ v: string; zh?: string; en?: string }>;  // enum/size 取值
  min?: number;
  max?: number;
  step?: number;
  default?: string | number | boolean;
  /** 省钱/高清 语义标注 (UI 显徽标). */
  tierHint?: 'thrift' | 'hq';
  /** 一行说明 (面板里 label 下方小字) —— 消歧义, 如"质量=细节精细度"vs"清晰度=像素尺寸". */
  hintZh?: string;
  hintEn?: string;
}

/* ── 标准参数取值 (对齐 OpenAI / OpenRouter 官方) ── */
/* quality: 官方定义 = 渲染"细节精细度"(算力档), 与像素尺寸独立. 故不用"高清"字样(那是清晰度的事). */
const QUALITY: ParamSpec = {
  key: 'quality', type: 'enum', labelZh: '精细度', labelEn: 'Quality', default: 'high',
  values: [
    { v: 'auto', zh: '自动', en: 'Auto' },
    { v: 'low', zh: '草稿', en: 'Draft' },
    { v: 'medium', zh: '标准', en: 'Std' },
    { v: 'high', zh: '精细', en: 'Fine' },
  ],
};
/* gpt-image: 比例 (aspect) × 清晰度 (resolution) → buildRequestParams 算出 size (WxH). */
const GPT_ASPECT: ParamSpec = {
  key: 'aspect', type: 'enum', labelZh: '比例', labelEn: 'Aspect', default: '1:1',
  values: [
    { v: '1:1', zh: '方 1:1', en: '1:1' },
    { v: '2:3', zh: '竖 2:3', en: '2:3' },
    { v: '3:2', zh: '横 3:2', en: '3:2' },
    { v: 'auto', zh: '自动', en: 'Auto' },
  ],
};
/* resolution: 官方 = 像素尺寸 (size). 清晰度即分辨率, 值就 1K/2K/4K, 不加前缀免换行. */
const GPT_RES: ParamSpec = {
  key: 'resolution', type: 'enum', labelZh: '清晰度', labelEn: 'Resolution', default: '1K',
  values: [
    { v: '1K', zh: '1K', en: '1K' },
    { v: '2K', zh: '2K', en: '2K' },
    { v: '4K', zh: '4K', en: '4K' },
  ],
};
const BG_GPT: ParamSpec = {
  key: 'background', type: 'enum', labelZh: '背景', labelEn: 'Background', default: 'auto',
  values: [{ v: 'auto', zh: '自动', en: 'Auto' }, { v: 'opaque', zh: '不透明', en: 'Opaque' }],
};
const N_1_10: ParamSpec = { key: 'n', type: 'range', labelZh: '张数', labelEn: 'Count', min: 1, max: 10, step: 1, default: 1 };
const OUT_FMT: ParamSpec = {
  key: 'output_format', type: 'enum', labelZh: '格式', labelEn: 'Format', default: 'png',
  values: [{ v: 'png' }, { v: 'webp' }, { v: 'jpeg' }],
};
const OUT_COMPRESS: ParamSpec = { key: 'output_compression', type: 'range', labelZh: '压缩', labelEn: 'Compression', min: 0, max: 100, step: 5 };
const RESOLUTION: ParamSpec = {
  key: 'resolution', type: 'enum', labelZh: '分辨率', labelEn: 'Resolution', default: '1K',
  values: [{ v: '1K', zh: '1K(省钱)' }, { v: '2K' }, { v: '4K', zh: '4K(高清)' }],
};
const ASPECT: ParamSpec = {
  key: 'aspect_ratio', type: 'enum', labelZh: '比例', labelEn: 'Aspect', default: '1:1',
  values: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'].map(v => ({ v })),
};
const SEED: ParamSpec = { key: 'seed', type: 'boolean', labelZh: '固定种子', labelEn: 'Seed', default: false };

export type ImageTier = 'standard' | 'advanced';

export const TIER: ParamSpec = {
  key: 'tier', type: 'enum', labelZh: '档位', labelEn: 'Tier', default: 'standard',
  values: [
    { v: 'standard', zh: '普通', en: 'Standard' },
    { v: 'advanced', zh: '高级', en: 'Advanced' },
  ],
};

/* ── 模型名规范化 ────────────────────────────────────────────────────
 * 家族规则原来直接拿"用户看到的名字"去匹配, 于是订阅侧的展示名一个都对不上:
 *   · nano-banana-2 就是 google/gemini-3.1-flash-image, 但 /gemini.*image/ 认不出
 *     它 → 掉进兜底, 拿到 quality(Gemini 根本没这参数) + n≤10(它只支持 1),
 *     反倒藏掉了真正支持的 resolution / aspect_ratio。订阅用户选它, 参数一个对的都没有。
 *   · grok 的上游真名是 grok-imagine-1 —— "imagine" 里**没有 image 子串**
 *     (imagine vs image), /grok.*image/ 同样匹配不到。
 * 所以匹配前先把别名规范到家族关键词。 */
const MODEL_ALIASES: Array<{ test: RegExp; as: string }> = [
  /* nan[oa]: 中转把它拼成 "nana-banana-2" 的不在少数 (relay-a 就是), 而我们的模型 id
     是 nano-banana-2。只认 nano 的话, BYOK 用户照着第三方的模型名填就会掉进兜底,
     参数面板只剩一个张数 —— 而且不报错, 只是"这个模型怎么没参数"。 */
  { test: /nan[oa]banana/, as: 'geminiimage' },   /* Google Gemini 出图的产品代号 */
  { test: /grokimagine/, as: 'grokimage' },
  { test: /^imagen/, as: 'geminiimage' },
];

function canonical(raw: string): string {
  return (raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeModelName(raw: string): string {
  const c = canonical(raw);
  for (const a of MODEL_ALIASES) if (a.test.test(c)) return a.as;
  return c;
}

/* ── 按模型家族声明支持的标准参数 ── */
interface FamilyRule {
  test: RegExp;
  /** 该家族的完整参数集 (有档位时 = 高级档) */
  specs: ParamSpec[];
  /** 该家族是否有「普通 / 高级」两档 */
  tiered?: boolean;
  /** 普通档的参数集。**不填 = 两档参数集相同**, 档位只影响背后走哪条路由。
   *  GPT 两档背后是两家能力不同的渠道, 所以要分开写;
   *  Grok 两档背后是同一家的两个上游模型, 参数一模一样, 只是画质和价格不同。 */
  standardSpecs?: ParamSpec[];
}

const GPT_ASPECT_STD: ParamSpec = {
  ...GPT_ASPECT,
  /* 去掉 auto: 第三方要求精确 WxH, 传 auto 直接 400。 */
  values: GPT_ASPECT.values!.filter((o) => o.v !== 'auto'),
};
const GPT_STANDARD: ParamSpec[] = [GPT_ASPECT_STD, GPT_RES, N_1_10];
const GPT_ADVANCED: ParamSpec[] = [QUALITY, GPT_ASPECT, GPT_RES, BG_GPT, N_1_10, OUT_FMT, OUT_COMPRESS];

const GEMINI_SPECS: ParamSpec[] = [RESOLUTION, ASPECT, { ...N_1_10, max: 1 }];

const GROK_SIZE: ParamSpec = {
  key: 'size', type: 'enum', labelZh: '尺寸', labelEn: 'Size', default: '1024x1024',
  hintZh: '每个选项都是实测过的尺寸 —— Grok 只认固定几种, 其余会静默退回方图',
  values: [
    { v: '1024x1024', zh: '方 1:1',      en: '1:1' },
    { v: '2048x2048', zh: '方 1:1 · 2K', en: '1:1 2K' },
    { v: '1536x1024', zh: '横 3:2',      en: '3:2' },
    { v: '1024x1536', zh: '竖 2:3',      en: '2:3' },
    { v: '1792x1024', zh: '横 16:9',     en: '16:9' },
    { v: '1024x1792', zh: '竖 9:16',     en: '9:16' },
  ],
};
const GROK_SPECS: ParamSpec[] = [GROK_SIZE, { ...N_1_10, max: 4 }];

const FAMILIES: FamilyRule[] = [
  /* 注意: 这些正则吃的是 canonical 形式 (小写纯字母数字), 所以不写分隔符 */
  { test: /gptimage|gpt[\d]*image/, specs: GPT_ADVANCED, tiered: true, standardSpecs: GPT_STANDARD },
  { test: /geminiimage|gemini.*image/, specs: GEMINI_SPECS },
  { test: /seedream|doubao.*image/,   specs: [RESOLUTION, ASPECT, N_1_10, SEED] },
  { test: /flux/,                     specs: [{ ...OUT_FMT, values: [{ v: 'png' }, { v: 'jpeg' }] }, { ...N_1_10, max: 1 }, SEED] },
  { test: /recraft/,                  specs: [{ ...N_1_10, max: 6 }] },
  /* grok 两档的参数集相同 (差别只在画质和价格), 所以不给 standardSpecs */
  { test: /grokimage|maiimage/,       specs: GROK_SPECS, tiered: true },
];

/** 这个模型有没有"普通/高级"两档。 */
export function modelHasTiers(modelName?: string): boolean {
  const name = normalizeModelName((modelName || '').toLowerCase());
  return FAMILIES.some((f) => f.tiered && f.test.test(name));
}

export function getModelParamSpecs(modelName?: string, tier: ImageTier = 'standard'): ParamSpec[] {
  const name = normalizeModelName((modelName || '').toLowerCase());
  for (const f of FAMILIES) {
    if (!f.test.test(name)) continue;
    if (!f.tiered) return f.specs;
    /* 用**这个家族自己的**普通档参数集, 不要写死成 GPT 的 —— 之前这里硬编码
       GPT_STANDARD/GPT_ADVANCED, 于是任何新加的带档位家族都会拿到 GPT 的参数面板
       (比例/清晰度/背景/格式), 而它们的上游根本不认那些键。 */
    const body = tier === 'standard' ? (f.standardSpecs ?? f.specs) : f.specs;
    return [TIER, ...body];
  }
  return [N_1_10];
}

/** 省钱/高清 分档摘要 (给模型选择器/面板显"档位"). */
export function tierSummary(modelName?: string, values?: Record<string, unknown>): string {
  const specs = getModelParamSpecs(modelName, (values?.['tier'] as ImageTier) ?? 'advanced');
  const parts: string[] = [];
  const q = values?.['quality']; if (specs.some(s => s.key === 'quality') && q) parts.push(String(q));
  const r = values?.['resolution']; if (specs.some(s => s.key === 'resolution') && r) parts.push(String(r));
  return parts.join(' · ');
}
