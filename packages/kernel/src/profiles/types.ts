import type { ProviderRetryConfig } from '../types/retryConfig.js';

export type PromptStyle = 'layered' | 'codex_official' | 'kimi';

export interface PromptProfile {
  style?: PromptStyle;
  language?: 'zh' | 'en';
  fullInstructions?: string;
  appendInstructions?: string;
}

export interface CompletionProfile {
  enforceExecutionEvidence?: boolean;
  requireValidationAfterMutation?: boolean;
  blockIntermediateFinalization?: boolean;
  intermediatePatterns?: string[];

  /** 任务意图推断不出时的默认策略
   *  - 'lenient': 归类为 conversation，不要求工具证据 (适合 Claude 等行为良好的模型)
   *  - 'strict': 归类为 execution，要求至少一次工具调用 (适合 GPT 等容易纯文本完成的模型)
   */
  unknownTaskFallback?: 'lenient' | 'strict';

  /** 纯文本完成的宽限次数 (默认 0)
   *  模型连续回复纯文本(无 tool_calls)时，前 N 次被拦截并注入 nudge，超过后走 completion gate
   */
  textOnlyCompletionGrace?: number;

  /** 最少成功工具调用次数才允许完成 (默认 0) */
  minSuccessfulToolCalls?: number;

  /** 是否检测 tool envelope 文本泄露 (默认 true) */
  detectToolEnvelopeLeak?: boolean;

  /** 额外的 tool envelope 泄露检测 pattern */
  extraEnvelopePatterns?: string[];

  /** 纯文本回复时是否自动注入 "请使用工具" 的 nudge (默认 false) */
  nudgeToolUsageOnTextOnly?: boolean;

  /** nudge 提示的自定义模板 (支持 {toolNames} 占位符) */
  toolUsageNudgeTemplate?: string;

  /** 检测"继续意图" — 模型已使用工具后输出短文本含未来动作词却没有完成标志时拦截 (默认 false) */
  detectContinuationIntent?: boolean;
}

export interface OpenAITransportProfile {
  forceResponsesAPI?: boolean;
  requestTimeoutMs?: number;
  streamRequestTimeoutMs?: number;
  retry?: ProviderRetryConfig;
  parallelToolCalls?: boolean;
  strictSSEDone?: boolean;
}

export interface TransportProfile {
  openai?: OpenAITransportProfile;
}

export interface ProfileMatchRule {
  protocols?: string[];
  modelIncludes?: string[];
  modelRegex?: string;
  baseUrlIncludes?: string[];
}

export interface ToolsetProfile {
  /** 禁用的工具名列表 */
  disabledTools?: string[];
}

export interface BehaviorProfile {
  /** SSE 流结束时未收到 [DONE] 且有部分内容，是否触发重试 (默认 false) */
  retryOnIncompleteStream?: boolean;

  /** finish_reason=stop 但无 tool_calls 时，是否视为可疑截断 (默认 false) */
  suspectTruncationOnStopWithoutTools?: boolean;

  /** 单轮回复最小 token 估算数，低于此值视为异常短回复 (默认 0 = 不检查) */
  minResponseTokens?: number;
}

export interface ReasoningDefaults {
  /** 默认 reasoning effort (max/ultra = GPT-5.6, ultra 仅 Sol/Terra) */
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  /** 默认 reasoning summary */
  summary?: 'auto' | 'concise' | 'detailed';
}

/** ARE (Adaptive Reasoning Engine) 行为配置 */
export interface AREProfile {
  /** 是否启用 ARE（默认 true） */
  enabled?: boolean;
  /** 最高允许的推理级别（0=NONE, 1=LIGHT, 2=DEEP，默认 2）
   *  例如 Claude 行为良好，设为 1 即可；GPT 可能需要 2 */
  maxLevel?: 0 | 1 | 2;
  /** Pre-Action 门控的最小触发迭代（默认 0）
   *  设大可以延迟门控介入，减少简单任务的干扰 */
  minIterationForGate?: number;
  /** 连续 mutation 多少次后触发验证提醒（默认 3）
   *  行为良好的模型可以设大，减少干扰 */
  verificationThreshold?: number;
  /** 推理提示语言（默认跟随全局 language）*/
  promptLanguage?: 'zh' | 'en';
}

export interface LoopProfile {
  /** 主循环策略：balanced 为默认稳健，fast_converge 偏向最快收敛 */
  strategy?: 'balanced' | 'fast_converge';
  /** 关闭低进展门控，减少无效追问循环 */
  disableProgressGate?: boolean;
  /** 关闭 post-action reflection 注入，减少每轮后处理 */
  disablePostActionReflection?: boolean;
  /** 关闭 planner 自动 follow-up，避免“计划后再追一轮” */
  disablePlannerAutoFollowup?: boolean;
}

export interface ModelProfile {
  id: string;
  label?: string;
  priority?: number;
  match?: ProfileMatchRule;
  prompt?: PromptProfile;
  completion?: CompletionProfile;
  transport?: TransportProfile;
  behavior?: BehaviorProfile;
  toolset?: ToolsetProfile;
  /** Codex / Responses API 模型的默认 reasoning 配置 */
  reasoning?: ReasoningDefaults;
  /** ARE (Adaptive Reasoning Engine) 行为配置 */
  are?: AREProfile;
  /** 主循环收敛策略 */
  loop?: LoopProfile;
  telemetry?: {
    verboseStreamLifecycle?: boolean;
  };
}

export interface ResolvedModelProfile extends ModelProfile {
  sourceProfileIds: string[];
}

export interface ResolveModelProfileInput {
  protocol?: string;
  model?: string;
  baseUrl?: string;
  explicitProfileId?: string;
  candidates?: ModelProfile[];
}
