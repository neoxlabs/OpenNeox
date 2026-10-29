
import { getSchemaRegistry } from './loader.js';
import type { FamilySchema, ModelSchema } from './types.js';

/** 截断档 —— runner 按这个决定 readfile / search 的预算。 */
export type TruncationProfile = 'small-window' | 'large-window';

/** 一个模型的能力快照 —— PROMPT / LOOP 的契约 (见 code-master-plan §5.2)。 */
export interface ModelCapability {
  modelId: string;
  /** 是否支持**强制**工具选择 (tool_choice=required / 具名函数)。只支持 auto 的算 false。 */
  supportsToolChoice: boolean;
  /** 一轮最多并行的工具调用数。1 = 不并行。 */
  maxParallelToolCalls: number;
  /** 是否支持思考/推理档位 (thinking 或 reasoning_effort 任一)。 */
  supportsThinking: boolean;
  /** 上下文窗口 (tokens)。 */
  contextWindow: number;
  /** 截断档 —— 跟 runner 的窗口分界同源。 */
  truncationProfile: TruncationProfile;
}

/**
 * 窗口 ≥ 这个值算大窗口。
 * 与 `core/runnerToolResultPreparationUtils.ts` 的 FILE_READ_LARGE_WINDOW_TOKENS 同值 ——
 * 那边决定 readfile 给 12K 还是 160K, 两处必须一起改。
 */
export const LARGE_CONTEXT_WINDOW_TOKENS = 200_000;

const DEFAULT_PARALLEL_TOOL_CALLS = 8;

/** family 级工具策略 —— 只放 yaml 表达不了的字段。 */
export interface FamilyToolPolicy {
  supportsToolChoice: boolean;
  maxParallelToolCalls: number;
}

/**
 * 代码化能力表 (按 family)。
 *
 * 依据:
 *   · openai      — chat completions / responses 都支持 tool_choice 具名与 required。
 *   · claude      — Messages API 支持 {type:'tool'} / any / none。
 *   · gemini      — functionCallingConfig 有 AUTO / ANY / NONE。
 *   · deepseek    — OpenAI 兼容, tool_choice=required 与具名均可用。
 *   · doubao      — OpenAI 兼容, 同上。
 *   · qwen        — DashScope / OpenAI 兼容端点, 同上。
 *   · xai         — OpenAI 兼容, 同上。
 *   · glm         — **只认 'auto'**: 传 required / 具名会 400 (glm.ts 的 mapTools 注释,
 *                   packages/core/src/models/constraints/glm.ts 同款校验)。
 *   · kimi        — **不认 required** (packages/core/src/models/constraints/kimi.ts);
 *                   并行也不可靠 (families/kimi.yaml: parallel_tool_use: false)。
 *   · mimo        — 没有强制 tool_choice 的证据, 保守给 false。
 *
 * 不在表里的 family 走 UNKNOWN_FAMILY_POLICY (保守: 不强制选择、不并行)。
 */
export const MODEL_CAPABILITY_TABLE: Readonly<Record<string, FamilyToolPolicy>> = Object.freeze({
  openai:   { supportsToolChoice: true,  maxParallelToolCalls: DEFAULT_PARALLEL_TOOL_CALLS },
  claude:   { supportsToolChoice: true,  maxParallelToolCalls: DEFAULT_PARALLEL_TOOL_CALLS },
  gemini:   { supportsToolChoice: true,  maxParallelToolCalls: 1 }, // families/gemini.yaml: parallel_tool_use: false
  deepseek: { supportsToolChoice: true,  maxParallelToolCalls: DEFAULT_PARALLEL_TOOL_CALLS },
  doubao:   { supportsToolChoice: true,  maxParallelToolCalls: DEFAULT_PARALLEL_TOOL_CALLS },
  glm:      { supportsToolChoice: false, maxParallelToolCalls: DEFAULT_PARALLEL_TOOL_CALLS },
  kimi:     { supportsToolChoice: false, maxParallelToolCalls: 1 }, // families/kimi.yaml: parallel_tool_use: false
  qwen:     { supportsToolChoice: true,  maxParallelToolCalls: DEFAULT_PARALLEL_TOOL_CALLS },
  xai:      { supportsToolChoice: true,  maxParallelToolCalls: DEFAULT_PARALLEL_TOOL_CALLS },
  mimo:     { supportsToolChoice: false, maxParallelToolCalls: DEFAULT_PARALLEL_TOOL_CALLS },
});

/** 表里没有的 family — 宁可少给能力, 不要发上游会 400 的参数。 */
const UNKNOWN_FAMILY_POLICY: FamilyToolPolicy = Object.freeze({
  supportsToolChoice: false,
  maxParallelToolCalls: 1,
});

function toolPolicyFor(familyId: string | undefined): FamilyToolPolicy {
  return (familyId && MODEL_CAPABILITY_TABLE[familyId]) || UNKNOWN_FAMILY_POLICY;
}

/**
 * thinking 支持判定 —— 模型 yaml 有声明就以它为准 (显式 false 也算数),
 * 没声明才按 family 的 thinking.native / reasoning_effort.supported 兜底。
 *
 * 例: claude-haiku-4-5 的模型 yaml 两个字段都没写 → 走 claude family 的 thinking.native:true;
 *     grok-4 的 family 两个都 false → false。
 */
function supportsThinking(model: ModelSchema | undefined, family: FamilySchema | null): boolean {
  const caps = model?.capabilities;
  if (caps && (caps.thinking || caps.reasoning_effort)) {
    return !!(caps.thinking?.supported || caps.reasoning_effort?.supported);
  }
  const familyCaps = family?.capabilities;
  return !!(familyCaps?.thinking?.native || familyCaps?.reasoning_effort?.supported);
}

/** 窗口 → 截断档。分界跟 runner 的 FILE_READ_LARGE_WINDOW_TOKENS 一致。 */
export function truncationProfileFor(contextWindow: number): TruncationProfile {
  return contextWindow >= LARGE_CONTEXT_WINDOW_TOKENS ? 'large-window' : 'small-window';
}

function capabilityFor(model: ModelSchema, family: FamilySchema | null): ModelCapability {
  const contextWindow = Number.isFinite(model.context_window) && model.context_window > 0
    ? model.context_window
    : 0;
  const policy = toolPolicyFor(model.family);
  return {
    modelId: model.id,
    supportsToolChoice: policy.supportsToolChoice,
    maxParallelToolCalls: policy.maxParallelToolCalls,
    supportsThinking: supportsThinking(model, family),
    contextWindow,
    truncationProfile: truncationProfileFor(contextWindow),
  };
}

/**
 * 一个模型的能力。名字走 registry.resolveModel —— 跟推理档位同一套归一化
 * (`neox-cloud:gpt-5.6-sol` / `openai/gpt-5.6-sol` / 带日期后缀都能命中)。
 *
 * @returns null = schema 里没有这个模型 (registry 会做安全的名字归一, 仍查不到就是真未知)。
 *          调用方拿 null 时保持自己的默认值, 不要猜。
 */
export function resolveModelCapability(modelId: string): ModelCapability | null {
  const registry = getSchemaRegistry();
  const model = registry.resolveModel(modelId);
  if (!model) return null;
  const family = registry.resolveFamily(model.family) ?? registry.detectFamily({ model: model.id });
  return capabilityFor(model, family);
}

export interface ListModelCapabilitiesOptions {
  /** 是否带上 preview / hidden 模型。默认只列在售 (availability: ga)。 */
  includeNonGa?: boolean;
}

/**
 * 全部模型的能力清单 —— 这就是"能力表覆盖在售模型"的对外形态。
 * 默认只列 `availability: ga` (当前 35 个), 按 modelId 排序, 结果稳定。
 */
export function listModelCapabilities(opts: ListModelCapabilitiesOptions = {}): ModelCapability[] {
  const registry = getSchemaRegistry();
  const out: ModelCapability[] = [];
  for (const model of registry.models.values()) {
    if (!opts.includeNonGa && model.availability !== 'ga') continue;
    const family = registry.resolveFamily(model.family) ?? registry.detectFamily({ model: model.id });
    out.push(capabilityFor(model, family));
  }
  return out.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/** 同 [listModelCapabilities], 但按 modelId 建索引 —— 调用方要按名字查表时用。 */
export function getModelCapabilityTable(
  opts: ListModelCapabilitiesOptions = {},
): Record<string, ModelCapability> {
  const table: Record<string, ModelCapability> = {};
  for (const cap of listModelCapabilities(opts)) table[cap.modelId] = cap;
  return table;
}
