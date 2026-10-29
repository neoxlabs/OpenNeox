/**
 * 思考档位 —— 纯函数 (单测入口)。界面见 ThinkLevel.tsx。
 *
 * 档位是各模型 schema 的 effort_map key, 不是全产品一套: GPT 有 minimal…max / ultra, Claude 有 low…max,
 * Gemini 老 key 是 fast/standard/deep/max, 开关式模型只有 off/on。这里把每一种 key 都给上中文名和釉色,
 * 保证同一根滑杆上不会出现英文混中文、也不会有没颜色的档。
 */

export type EffortLevel = string;
export type SchemaEffortInfo = {
  hasEffortMap: boolean;
  effectiveLevels?: EffortLevel[];
  defaultEffortLevel?: EffortLevel;
  billingMultipliers?: Partial<Record<EffortLevel, number>>;
  capabilities?: { reasoningEffortSupported?: boolean; thinkingSupported?: boolean };
  family?: string;
};

/** 釉色: 素坯 → 淡钴 → 钴蓝 → 琥珀 → 赭陶 → 金釉 → 至臻 (贝母) */
export type Glaze = 'off' | 'low' | 'mid' | 'high' | 'xhigh' | 'max' | 'ultra';

const GLAZE_OF: Record<string, Glaze> = {
  off: 'off', fast: 'off',
  minimal: 'low', low: 'low',
  medium: 'mid', standard: 'mid', on: 'mid', auto: 'mid',
  high: 'high', deep: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'ultra',
};
export function glazeOf(level: EffortLevel): Glaze {
  return GLAZE_OF[level] ?? 'mid';
}

const ZH: Record<string, string> = {
  off: '关', fast: '关', minimal: '最少', low: '低', medium: '中', standard: '标准', auto: '自动',
  on: '开', high: '高', deep: '深', xhigh: '超高', max: '极限', ultra: '至臻',
};
const EN: Record<string, string> = {
  off: 'Off', fast: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Med', standard: 'Std', auto: 'Auto',
  on: 'On', high: 'High', deep: 'Deep', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra',
};

/** 档位名。`on` 在只有开/关两档时叫「开」, 跟其它深浅档排在一起时叫「标准」(思考开着、正常深度) */
export function thinkLabel(level: EffortLevel, levels: readonly EffortLevel[], zh: boolean): string {
  if (level === 'on' && levels.length > 2) return zh ? '标准' : 'Std';
  const map = zh ? ZH : EN;
  return map[level] ?? level.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

/**
 * 交互形态:
 *   fixed  —— 只有一档 (glm-5.3 / kimi-k3 / fable 这种上游关不掉也调不动): 不给假控件
 *   toggle —— 只有「关」+ 一档: 点按钮直接切, 不弹卡
 *   slider —— 其余: 弹一根滑杆
 */
export type ThinkMode = 'fixed' | 'toggle' | 'slider';
export function thinkMode(levels: readonly EffortLevel[]): ThinkMode {
  if (levels.length <= 1) return 'fixed';
  if (levels.length === 2 && levels.some((l) => l === 'off' || l === 'fast')) return 'toggle';
  return 'slider';
}


export function deriveFamilyFromName(idOrName: string): string {
  const n = (idOrName || '').toLowerCase();
  if (/claude|anthropic/.test(n)) return 'claude';
  if (/\bgpt\b|openai|^o\d|\bcodex\b/.test(n)) return 'openai';
  if (/gemini|google/.test(n)) return 'gemini';
  if (/glm|zhipu|z-ai/.test(n)) return 'glm';
  if (/mimo|xiaomi/.test(n)) return 'mimo';
  if (/qwen|dashscope/.test(n)) return 'qwen';
  if (/deepseek/.test(n)) return 'deepseek';
  return n.split(/[-/]/, 1)[0];
}

export function fallbackLevelsForFamily(family: string): EffortLevel[] {
  if (family === 'claude' || family === 'anthropic') return ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (family === 'openai' || family === 'gpt') return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  if (family === 'gemini' || family === 'google') return ['fast', 'standard', 'deep', 'max'];
  if (family === 'deepseek') return ['off', 'low', 'high', 'max'];
  if (family === 'kimi' || family === 'moonshot' || family === 'glm' || family === 'zhipu' || family === 'qwen') return ['off', 'on', 'max'];
  if (family === 'doubao') return ['off', 'auto', 'on'];
  return ['fast', 'standard', 'deep', 'max'];
}

/** schema 是唯一真源; fallback 只在 schema 没回来时用 */
export function effectiveLevelsForFamily(family: string, schemaLevels?: EffortLevel[]): EffortLevel[] {
  if (schemaLevels && schemaLevels.length > 0) return [...schemaLevels];
  return fallbackLevelsForFamily(family);
}

export function defaultEffortForFamily(family: string, modelId?: string): EffortLevel {
  const n = (modelId || '').toLowerCase();
  if (family === 'claude' || family === 'anthropic') return /opus-4-7/.test(n) ? 'xhigh' : 'medium';
  if (family === 'openai' || family === 'gpt') return 'medium';
  if (family === 'gemini' || family === 'google') return 'standard';
  if (family === 'deepseek') return 'high';
  if (family === 'kimi' || family === 'moonshot' || family === 'glm' || family === 'zhipu' || family === 'qwen') return 'on';
  if (family === 'doubao') return 'auto';
  return 'standard';
}

export function defaultEffortForModel(modelId: string, info?: SchemaEffortInfo | null): EffortLevel {
  if (info?.defaultEffortLevel) return info.defaultEffortLevel;
  return defaultEffortForFamily(info?.family ?? deriveFamilyFromName(modelId), modelId);
}

/**
 * 按钮 / 滑杆上显示哪一档 —— 必须等于这一轮真正发出去的那档。
 * sent 是运行时算好的 (Work 默认 low、Pilot 关思考都在里面); 'standard' = 没指定, 显示这个模型的默认档。
 * 不在档位表里的 (换了模型, 旧值留着) 也回默认档, 不显示一个点不到的档。
 */
export function shownLevel(sent: EffortLevel | undefined, levels: readonly EffortLevel[], fallback: EffortLevel): EffortLevel {
  if (sent && sent !== 'standard' && levels.includes(sent)) return sent;
  if (levels.includes(fallback)) return fallback;
  return levels.find((l) => l !== 'off' && l !== 'fast') ?? levels[0] ?? fallback;
}

/** 滑杆上 x 落在哪一档 (0..1 → 最近一档) */
export function nearestStop(ratio: number, count: number): number {
  if (count <= 1) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
}
