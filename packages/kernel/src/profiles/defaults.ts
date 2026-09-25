import type { ModelProfile } from './types.js';

// ============================================================================
// Intermediate finalization patterns — 通用 (中英文)
// ============================================================================
const INTERMEDIATE_PATTERNS = [
  '^\\s*(好|好的|收到|明白|ok)[^\\n]{0,40}(继续|开始|处理)',
  '^\\s*我先[^\\n]{0,80}(继续|处理|修复|开始|马上|着手)',
  '^\\s*继续第?\\d+\\s*项',
  '^\\s*(马上|正在|先)\\s*(处理|修复|实现|开始)',
  '^\\s*要继续哪一项任务',
  '^\\s*(继续|先)\\s*(读|读取|查看|检查|分析|补齐|定位)',
  '^\\s*我将\\s*(继续|开始)\\s*(读|读取|查看|检查|分析|修复|实现)',
  // 包含"第N步"引用且暗示未来动作
  '(开始|进行|执行|处理|着手)\\s*第\\d+[步项]',
  // "建/制定...计划/方案" 紧跟动作
  '(建|制定|列出|写)[^\\n]{0,40}(计划|方案|步骤)[^\\n]{0,30}(开始|执行|进行|第)',
  // "开始+动词" — 如 "开始改 bills.ejs"
  '^\\s*开始[改修做写创添删移搬编构配部搭实处读查看检分调测重]',
  // 英文
  "^\\s*I(?:'ll| will)\\s+(?:continue|start|proceed)",
  '^\\s*Let me\\s+(?:continue|start|first)',
  "^\\s*Next[,，]?\\s+I(?:'ll| will)",
];

// ============================================================================
// GPT 专用中间文本 patterns — 覆盖 GPT 模型常见的"先说计划不调工具"行为
// ============================================================================
const GPT_EXTRA_INTERMEDIATE_PATTERNS = [
  // 英文 — GPT 高频中间文本
  "^\\s*I(?:'ll| will| need to| should| can)\\s+(?:now |first |then )?(?:look|read|check|open|find|search|examine|review|inspect|create|make|build|implement|fix|modify|update|write)",
  "^\\s*(?:First|Now|Next|Then),?\\s+(?:let me|I(?:'ll| will))",
  "^\\s*Let me\\s+(?:take a look|check|examine|review|analyze|investigate|see|read|open|find|start|create|make|build|implement|fix)",
  "^\\s*(?:OK|Okay|Alright|Sure|Got it)[.,!]?\\s+(?:Let me|I(?:'ll| will))",
  "^\\s*I(?:'m going to|'ll go ahead and)\\s+",
  '^\\s*To (?:fix|solve|address|resolve|implement|handle) this',
  '^\\s*(?:Based on|Looking at|From) (?:the|this|my)',
  "^\\s*(?:Here'?s|Here is) (?:my|the) (?:plan|approach|strategy)",
  // 中文 — GPT 中文回复的中间文本
  '^\\s*(?:让我|我来|我需要|我应该)\\s*(?:先|首先)?\\s*(?:看看|检查|读取|打开|查找|分析|了解|开始|建|制定|创建|修改|修复)',
  '^\\s*(?:首先|接下来|然后|下面|现在)[，,]?\\s*(?:我|让我|需要)',
  '^\\s*(?:好的|没问题|了解|明白了)[，,。.！!]?\\s*(?:让我|我来|我先)',
  // GPT 常见的"制定计划后停住"模式
  '(马上|立即|现在|接下来)\\s*(开始|执行|处理|进行|实现|修改|修复)',
  '^\\s*(?:根据|基于)[^\\n]{0,40}(?:分析|结果|代码)[^\\n]{0,40}(?:我|需要|应该)',
  '^\\s*(?:下面|接下来|现在)\\s*(?:我|让我|来|就)',
];

// ============================================================================
// GPT Persistence Instructions — 源自 Codex gpt_5_1_prompt.md
// 这是防止 GPT 模型中途停住的核心手段，Codex 不靠代码拦截，靠的就是这段 prompt
// ============================================================================
const GPT_PERSISTENCE_INSTRUCTIONS = `
## Autonomy and Persistence
Persist until the task is fully handled end-to-end within the current turn whenever feasible: do not stop at analysis or partial fixes; carry changes through implementation, verification, and a clear explanation of outcomes unless the user explicitly pauses or redirects you.

Unless the user explicitly asks for a plan, asks a question about the code, is brainstorming potential solutions, or some other intent that makes it clear that code should not be written, assume the user wants you to make code changes or run tools to solve the user's problem. In these cases, it's bad to output your proposed solution in a message, you should go ahead and actually implement the change. If you encounter challenges or blockers, you should attempt to resolve them yourself.

## Task execution
You are a coding agent. You must keep going until the query or task is completely resolved, before ending your turn and yielding back to the user. Persist until the task is fully handled end-to-end within the current turn whenever feasible and persevere even when function calls fail. Only terminate your turn when you are sure that the problem is solved. Autonomously resolve the query to the best of your ability, using the tools available to you, before coming back to the user. Do NOT guess or make up an answer.

IMPORTANT: Do NOT end your turn by merely describing what you plan to do. Actually use the tools to do it. If you say "I will modify file X", you must call the edit tool right away — do not stop and wait.

## Tool usage signals
When you respond WITHOUT calling any tools, the system treats this as your final answer — your turn ends immediately. If you still have work to do, you MUST call a tool in this response; do not just describe what you plan to do next and stop.

For conversational questions (greetings, general questions, explanations of concepts, or questions where no code changes are needed), you may respond with text only — no tool calls are required. The system will accept your text response as a complete answer.
`.trim();

// ============================================================================
// Profile 定义
// ============================================================================

export const BASE_MODEL_PROFILE: ModelProfile = {
  id: 'default',
  label: 'Default profile',
  priority: 0,
  prompt: {
    style: 'layered',
  },
  completion: {
    enforceExecutionEvidence: true,
    requireValidationAfterMutation: true,
    blockIntermediateFinalization: true,
    intermediatePatterns: INTERMEDIATE_PATTERNS,
    unknownTaskFallback: 'lenient',
    textOnlyCompletionGrace: 0,
    minSuccessfulToolCalls: 0,
    detectToolEnvelopeLeak: false,
    nudgeToolUsageOnTextOnly: false,
  },
  behavior: {
    retryOnIncompleteStream: false,
    suspectTruncationOnStopWithoutTools: false,
    minResponseTokens: 0,
  },
};

export const OPENAI_CHAT_PROFILE: ModelProfile = {
  id: 'openai-chat',
  label: 'OpenAI chat-completions',
  priority: 20,
  match: {
    protocols: ['openai'],
  },
  prompt: {
    style: 'layered',
    appendInstructions: GPT_PERSISTENCE_INSTRUCTIONS,
  },
  completion: {
    unknownTaskFallback: 'lenient',
    textOnlyCompletionGrace: 1,
    minSuccessfulToolCalls: 1,
    detectToolEnvelopeLeak: true,
    nudgeToolUsageOnTextOnly: true,
    detectContinuationIntent: true,
    intermediatePatterns: [...INTERMEDIATE_PATTERNS, ...GPT_EXTRA_INTERMEDIATE_PATTERNS],
  },
  behavior: {
    retryOnIncompleteStream: true,
    suspectTruncationOnStopWithoutTools: true,
    minResponseTokens: 10,
  },
  are: {
    maxLevel: 2,
    verificationThreshold: 3,
  },
};

export const GPT4_SERIES_PROFILE: ModelProfile = {
  id: 'gpt-4-series',
  label: 'GPT-4/4o series',
  priority: 26,
  match: {
    modelRegex: '^(gpt-4(\\.1)?|gpt-4o)(-|$)',
  },
  prompt: {
    style: 'layered',
    appendInstructions: GPT_PERSISTENCE_INSTRUCTIONS,
  },
  completion: {
    unknownTaskFallback: 'lenient',
    textOnlyCompletionGrace: 1,
    minSuccessfulToolCalls: 1,
    detectToolEnvelopeLeak: true,
    nudgeToolUsageOnTextOnly: true,
    detectContinuationIntent: true,
  },
  behavior: {
    retryOnIncompleteStream: true,
    suspectTruncationOnStopWithoutTools: true,
    minResponseTokens: 10,
  },
};

export const OPENAI_RESPONSES_CODEX_PROFILE: ModelProfile = {
  id: 'openai-responses-codex',
  label: 'OpenAI Responses (Codex-style)',
  priority: 30,
  match: {
    protocols: ['openai-responses'],
  },
  prompt: {
    style: 'codex_official',
    appendInstructions: GPT_PERSISTENCE_INSTRUCTIONS,
  },
  reasoning: {
    effort: 'low',
    summary: 'auto',
  },
  completion: {
    blockIntermediateFinalization: true,
    unknownTaskFallback: 'lenient',
    textOnlyCompletionGrace: 1,
    minSuccessfulToolCalls: 1,
    detectToolEnvelopeLeak: true,
    nudgeToolUsageOnTextOnly: true,
    detectContinuationIntent: true,
    intermediatePatterns: [...INTERMEDIATE_PATTERNS, ...GPT_EXTRA_INTERMEDIATE_PATTERNS],
  },
  behavior: {
    retryOnIncompleteStream: true,
    suspectTruncationOnStopWithoutTools: true,
    minResponseTokens: 10,
  },
  transport: {
    openai: {
      forceResponsesAPI: true,
      requestTimeoutMs: 150000,
      streamRequestTimeoutMs: 480000,
      retry: {
        requestMaxRetries: 3,
        streamMaxRetries: 3,
      },
      parallelToolCalls: true,
    },
  },
};

export const GPT5_SERIES_PROFILE: ModelProfile = {
  id: 'gpt-5-series',
  label: 'GPT-5 series',
  priority: 36,
  match: {
    modelRegex: '^gpt-5(\\.[0-9]+)?($|-)',
  },
  prompt: {
    style: 'codex_official',
    appendInstructions: GPT_PERSISTENCE_INSTRUCTIONS,
  },
  completion: {
    blockIntermediateFinalization: true,
    unknownTaskFallback: 'lenient',
    textOnlyCompletionGrace: 2,
    minSuccessfulToolCalls: 1,
    detectToolEnvelopeLeak: true,
    nudgeToolUsageOnTextOnly: true,
    detectContinuationIntent: true,
    intermediatePatterns: [...INTERMEDIATE_PATTERNS, ...GPT_EXTRA_INTERMEDIATE_PATTERNS],
    extraEnvelopePatterns: [
      'tool_call\\s*\\(',
      '```tool_code',
    ],
  },
  behavior: {
    retryOnIncompleteStream: true,
    suspectTruncationOnStopWithoutTools: true,
    minResponseTokens: 15,
  },
  transport: {
    openai: {
      forceResponsesAPI: true,
      requestTimeoutMs: 150000,
      streamRequestTimeoutMs: 540000,
      retry: {
        requestMaxRetries: 3,
        streamMaxRetries: 3,
      },
      parallelToolCalls: true,
    },
  },
};

export const GPT53_CODEX_PROFILE: ModelProfile = {
  id: 'gpt-5.3-codex',
  label: 'GPT-5.3 Codex',
  priority: 43,
  match: {
    modelRegex: '^gpt-5\\.3-codex($|-)',
  },
  prompt: {
    style: 'codex_official',
    appendInstructions: GPT_PERSISTENCE_INSTRUCTIONS,
  },
  reasoning: {
    effort: 'high',
    summary: 'auto',
  },
  completion: {
    blockIntermediateFinalization: true,
    unknownTaskFallback: 'lenient',
    textOnlyCompletionGrace: 2,
    minSuccessfulToolCalls: 1,
    detectToolEnvelopeLeak: true,
    nudgeToolUsageOnTextOnly: true,
    detectContinuationIntent: false,
    intermediatePatterns: [...INTERMEDIATE_PATTERNS, ...GPT_EXTRA_INTERMEDIATE_PATTERNS],
    extraEnvelopePatterns: [
      'tool_call\\s*\\(',
      '```tool_code',
    ],
  },
  behavior: {
    retryOnIncompleteStream: true,
    suspectTruncationOnStopWithoutTools: true,
    minResponseTokens: 15,
  },
  loop: {
    strategy: 'fast_converge',
  },
  transport: {
    openai: {
      forceResponsesAPI: true,
      requestTimeoutMs: 150000,
      streamRequestTimeoutMs: 300000,
      retry: {
        requestMaxRetries: 3,
        streamMaxRetries: 3,
      },
      parallelToolCalls: true,
      strictSSEDone: false,
    },
  },
};

export const GPT5_CODEX_PROFILE: ModelProfile = {
  id: 'gpt-5-codex',
  label: 'GPT-5 Codex family',
  priority: 40,
  match: {
    modelRegex: '^(gpt-5(\\.[0-9]+)?-codex|o3-codex|codex-)',
  },
  prompt: {
    style: 'codex_official',
    appendInstructions: GPT_PERSISTENCE_INSTRUCTIONS,
  },
  completion: {
    blockIntermediateFinalization: true,
    unknownTaskFallback: 'lenient',
    textOnlyCompletionGrace: 2,
    minSuccessfulToolCalls: 1,
    detectToolEnvelopeLeak: true,
    nudgeToolUsageOnTextOnly: true,
    detectContinuationIntent: false,
    intermediatePatterns: [...INTERMEDIATE_PATTERNS, ...GPT_EXTRA_INTERMEDIATE_PATTERNS],
    extraEnvelopePatterns: [
      'tool_call\\s*\\(',
      '```tool_code',
    ],
  },
  behavior: {
    retryOnIncompleteStream: true,
    suspectTruncationOnStopWithoutTools: true,
    minResponseTokens: 15,
  },
  loop: {
    strategy: 'fast_converge',
  },
  transport: {
    openai: {
      forceResponsesAPI: true,
      requestTimeoutMs: 150000,
      streamRequestTimeoutMs: 300000,
      retry: {
        requestMaxRetries: 3,
        streamMaxRetries: 3,
      },
      parallelToolCalls: true,
      strictSSEDone: false,
    },
  },
};

// ============================================================================
//  Anthropic / Claude Profile
// Claude 行为良好：很少中途停住，不泄露 tool envelope，tool calling 规范。
// 最轻量的 CompletionProfile，减少干扰。
// ============================================================================

export const ANTHROPIC_PROFILE: ModelProfile = {
  id: 'anthropic',
  label: 'Anthropic / Claude',
  priority: 20,
  match: {
    protocols: ['anthropic', 'anthropic-openai'],
  },
  prompt: {
    style: 'layered',
    // Claude 不需要 persistence instructions — 它天然会持续执行
  },
  completion: {
    unknownTaskFallback: 'lenient',      // Claude 行为良好，不需要 strict
    textOnlyCompletionGrace: 0,          // Claude 几乎不会中途纯文本停住
    minSuccessfulToolCalls: 0,           // 不强制要求最低工具调用
    detectToolEnvelopeLeak: false,       // Claude 不泄露 tool envelope
    nudgeToolUsageOnTextOnly: false,     // 不需要 nudge
    detectContinuationIntent: false,     // Claude 不需要 continuation 检测
    blockIntermediateFinalization: false, // Claude 很少中间停住
    intermediatePatterns: INTERMEDIATE_PATTERNS, // 保留基础 patterns 以防万一
  },
  behavior: {
    retryOnIncompleteStream: false,       // Claude 流式稳定
    suspectTruncationOnStopWithoutTools: false,
    minResponseTokens: 0,
  },
  are: {
    maxLevel: 1,                          // Claude 自带推理能力，LIGHT 足够
    minIterationForGate: 2,               // 延迟介入，减少简单任务干扰
    verificationThreshold: 5,             // Claude 写操作通常正确，放宽验证阈值
  },
};

// ============================================================================
//  DeepSeek Profile
// DeepSeek 走 OpenAI 兼容协议，但行为介于 GPT 和 Claude 之间。
// 有时会纯文本回复，需要适度的 completion 约束。
// DeepSeek-R1 有内置推理，V3 没有。
// ============================================================================

export const DEEPSEEK_PROFILE: ModelProfile = {
  id: 'deepseek',
  label: 'DeepSeek',
  priority: 25,
  match: {
    // DeepSeek 走 openai 协议，但 model 名以 deepseek- 开头
    modelRegex: '^deepseek-',
  },
  prompt: {
    style: 'layered',
    appendInstructions: GPT_PERSISTENCE_INSTRUCTIONS, // DeepSeek 也需要持续执行提示
  },
  completion: {
    unknownTaskFallback: 'strict',        // DeepSeek 有时纯文本完成，需要 strict
    textOnlyCompletionGrace: 1,
    minSuccessfulToolCalls: 1,
    detectToolEnvelopeLeak: true,          // DeepSeek 可能泄露
    nudgeToolUsageOnTextOnly: true,
    detectContinuationIntent: true,
    blockIntermediateFinalization: true,
    intermediatePatterns: [...INTERMEDIATE_PATTERNS, ...GPT_EXTRA_INTERMEDIATE_PATTERNS],
  },
  behavior: {
    retryOnIncompleteStream: true,
    suspectTruncationOnStopWithoutTools: true,
    minResponseTokens: 10,
  },
  are: {
    maxLevel: 2,                           // DeepSeek 需要完整 ARE 支持
    verificationThreshold: 3,
  },
};

// ============================================================================
//  Kimi (Moonshot) Profile
// Kimi K2.5 有内置 thinking 模式，行为较规范。
// 从 OPENAI_CHAT_PROFILE 独立出来，减少不必要的 GPT 特定约束。
// ============================================================================

export const KIMI_PROFILE: ModelProfile = {
  id: 'kimi',
  label: 'Kimi (Moonshot)',
  priority: 22,
  match: {
    protocols: ['kimi'],
  },
  prompt: {
    style: 'kimi',
    // Kimi 使用专属 KimiPromptBuilder（正反例驱动 + K2.5 Thinking 指导）
  },
  completion: {
    unknownTaskFallback: 'lenient',
    textOnlyCompletionGrace: 1,
    minSuccessfulToolCalls: 1,
    detectToolEnvelopeLeak: false,          // Kimi 不泄露 tool envelope
    nudgeToolUsageOnTextOnly: true,         // 有时需要 nudge
    detectContinuationIntent: true,
    blockIntermediateFinalization: true,
    intermediatePatterns: INTERMEDIATE_PATTERNS, // 基础 patterns 即可，不需要 GPT 额外的
  },
  behavior: {
    retryOnIncompleteStream: true,
    suspectTruncationOnStopWithoutTools: false,
    minResponseTokens: 5,
  },
  are: {
    maxLevel: 2,
    minIterationForGate: 1,                 // K2.5 有 thinking，略延迟介入
    verificationThreshold: 3,
  },
};

// ============================================================================
//  Gemini Profile
// Gemini 使用 Google 专属协议，行为稳定但有自己的特点。
// Function calling 格式标准，流式支持好。
// ============================================================================

export const GEMINI_PROFILE: ModelProfile = {
  id: 'gemini',
  label: 'Google Gemini',
  priority: 20,
  match: {
    protocols: ['gemini'],
  },
  prompt: {
    style: 'layered',
  },
  completion: {
    unknownTaskFallback: 'lenient',
    textOnlyCompletionGrace: 1,
    minSuccessfulToolCalls: 0,
    detectToolEnvelopeLeak: false,
    nudgeToolUsageOnTextOnly: false,
    detectContinuationIntent: false,
    blockIntermediateFinalization: false,
    intermediatePatterns: INTERMEDIATE_PATTERNS,
  },
  behavior: {
    retryOnIncompleteStream: false,
    suspectTruncationOnStopWithoutTools: false,
    minResponseTokens: 0,
  },
  are: {
    maxLevel: 1,                            // Gemini 有内置推理，LIGHT 足够
    minIterationForGate: 2,
    verificationThreshold: 4,
  },
};

// ============================================================================
//  Doubao (豆包) Profile
// 豆包走 OpenAI 兼容协议，行为与 GPT 类似但中文优化更好。
// doubao-seed 有 reasoning_content。
// ============================================================================

export const DOUBAO_PROFILE: ModelProfile = {
  id: 'doubao',
  label: '豆包 (Doubao)',
  priority: 25,
  match: {
    // 豆包的 model 名以 doubao- 或 ep- 开头
    modelRegex: '^(doubao-|ep-)',
  },
  prompt: {
    style: 'layered',
    language: 'zh',                         // 默认中文
    appendInstructions: GPT_PERSISTENCE_INSTRUCTIONS,
  },
  completion: {
    unknownTaskFallback: 'strict',          // 豆包有时纯文本回复
    textOnlyCompletionGrace: 1,
    minSuccessfulToolCalls: 1,
    detectToolEnvelopeLeak: true,           // 可能泄露
    nudgeToolUsageOnTextOnly: true,
    detectContinuationIntent: true,
    blockIntermediateFinalization: true,
    intermediatePatterns: INTERMEDIATE_PATTERNS,
  },
  behavior: {
    retryOnIncompleteStream: true,
    suspectTruncationOnStopWithoutTools: true,
    minResponseTokens: 5,
  },
  are: {
    maxLevel: 2,
    verificationThreshold: 3,
    promptLanguage: 'zh',                   // 豆包推理提示用中文
  },
};

// ============================================================================
//  GLM (智谱 AI) Profile
// GLM 走自己的协议，中文能力强，行为偏保守。
// ============================================================================

export const GLM_PROFILE: ModelProfile = {
  id: 'glm',
  label: 'GLM (智谱 AI)',
  priority: 20,
  match: {
    protocols: ['glm'],
  },
  prompt: {
    style: 'layered',
    language: 'zh',                         // 默认中文
  },
  completion: {
    unknownTaskFallback: 'strict',          // GLM 有时纯文本回复
    textOnlyCompletionGrace: 1,
    minSuccessfulToolCalls: 1,
    detectToolEnvelopeLeak: false,
    nudgeToolUsageOnTextOnly: true,
    detectContinuationIntent: true,
    blockIntermediateFinalization: true,
    intermediatePatterns: INTERMEDIATE_PATTERNS,
  },
  behavior: {
    retryOnIncompleteStream: true,
    suspectTruncationOnStopWithoutTools: false,
    minResponseTokens: 5,
  },
  are: {
    maxLevel: 2,
    verificationThreshold: 3,
    promptLanguage: 'zh',
  },
};

// ============================================================================
//  注册所有 Profiles
// 按优先级排列：base → protocol-level → model-series-level
// resolver.ts 会自动匹配并 deepMerge
// ============================================================================

export const BUILTIN_MODEL_PROFILES: ModelProfile[] = [
  // ─── Layer 0: 兜底 ───
  BASE_MODEL_PROFILE,

  // ─── Layer 1: 协议级别 (priority 20-22) ───
  OPENAI_CHAT_PROFILE,          // openai 协议
  ANTHROPIC_PROFILE,            // anthropic / anthropic-openai 协议
  KIMI_PROFILE,                 // kimi 协议
  GEMINI_PROFILE,               // gemini 协议
  GLM_PROFILE,                  // glm 协议

  // ─── Layer 2: 模型系列级别 (priority 25-26) ───
  DEEPSEEK_PROFILE,             // deepseek-* 模型（走 openai 协议）
  DOUBAO_PROFILE,               // doubao-* / ep-* 模型（走 openai 协议）
  GPT4_SERIES_PROFILE,          // gpt-4/4o 系列

  // ─── Layer 3: 高级模型 (priority 30-44) ───
  OPENAI_RESPONSES_CODEX_PROFILE,  // openai-responses 协议
  GPT5_SERIES_PROFILE,             // gpt-5 系列
  GPT5_CODEX_PROFILE,              // gpt-5-codex / o3-codex / codex-
  GPT53_CODEX_PROFILE,             // gpt-5.3-codex
];
