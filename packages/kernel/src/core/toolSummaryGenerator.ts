/**
 * Generate tool-result summaries asynchronously.
 *
 * The model selector prefers a lightweight same-family model and falls back to
 * the active model; summaries replace oversized tool results.
 */

import type { LLMProvider, Message } from '../types/index.js';
import { cliLogger } from '../platform/cliLogger.js';

//  全局事件回调 — 让 CLI/Electron 能收到摘要失败通知
type SummaryEventListener = (event: {
  type: 'summary_failed' | 'summary_applied';
  toolName: string;
  model: string;
  reason?: string;
}) => void;

let _summaryEventListener: SummaryEventListener | null = null;

/** CLI/Electron 启动时注册，接收摘要状态事件 */
export function onToolSummaryEvent(listener: SummaryEventListener): void {
  _summaryEventListener = listener;
}

/**
 * 轻量模型映射表
 *
 *  修复：GPT-5.x 系列不再硬编码 gpt-4o-mini（代理可能不支持）
 * 策略：同系列 mini 模型 > 同系列 codex-mini > 主模型本身（兜底）
 */
/** 无 -mini SKU 的 GPT-5.x 小版本 — 摘要/降级必须留在本代，禁止落到 gpt-5-mini */
const GPT5_NO_MINI_FAMILIES = new Set(['gpt-5.5', 'gpt-5.6']);

const SUMMARY_MODEL_MAP: Record<string, string> = {
  // ==================== OpenAI GPT-5.x ====================
  //  同系列 mini/低 effort，不跨代降级到 gpt-4o-mini
  // 5.5 / 5.6 没有 -mini：5.5 留本模型；5.6 轻量档用 Luna
  'gpt-5.6-sol': 'gpt-5.6-luna',
  'gpt-5.6-terra': 'gpt-5.6-luna',
  'gpt-5.6-luna': 'gpt-5.6-luna',
  'gpt-5.5': 'gpt-5.5',
  'gpt-5.5-pro': 'gpt-5.5',
  'gpt-5.4': 'gpt-5.4-mini',
  'gpt-5.3': 'gpt-5.3-mini',
  'gpt-5.3-codex': 'gpt-5.1-codex-mini',
  'gpt-5.2': 'gpt-5.2-mini',
  'gpt-5.2-codex': 'gpt-5.1-codex-mini',
  'gpt-5.2-codex-high': 'gpt-5.1-codex-mini',
  'gpt-5.1': 'gpt-5.1-mini',
  'gpt-5.1-codex': 'gpt-5.1-codex-mini',
  'gpt-5': 'gpt-5-mini',

  // OpenAI 4.x / o-series → gpt-4.1-mini（同代 mini）
  'gpt-4.1': 'gpt-4.1-mini',
  'gpt-4o': 'gpt-4o-mini',
  'o3': 'o4-mini',
  'o3-mini': 'o4-mini',
  'o4-mini': 'o4-mini',
  'o1': 'o1-mini',
  'o1-mini': 'o1-mini',

  // ==================== Anthropic ====================
  'claude-opus-4-6': 'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6': 'claude-haiku-4-5-20251001',
  'claude-opus-4-5-20251101': 'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20250929': 'claude-haiku-4-5-20251001',
  'claude-sonnet-4-20250514': 'claude-3-5-haiku-20241022',
  'claude-opus-4-20250514': 'claude-3-5-haiku-20241022',
  'claude-3-5-sonnet-20241022': 'claude-3-5-haiku-20241022',

  // ==================== GLM ====================
  'glm-5': 'glm-4-flash',
  'glm-4.7': 'glm-4-flash',
  'glm-4.6': 'glm-4-flash',
  'glm-4.5': 'glm-4-flash',
  'glm-4-plus': 'glm-4-flash',

  // ==================== Gemini ====================
  'gemini-3-pro-preview': 'gemini-2.5-flash',
  'gemini-3.0-pro': 'gemini-2.5-flash',
  'gemini-2.5-pro': 'gemini-2.5-flash',
  'gemini-2.5-flash': 'gemini-2.0-flash',
  'gemini-2.0-flash': 'gemini-2.0-flash',
  'gemini-1.5-pro': 'gemini-1.5-flash',

  // ==================== DeepSeek ====================
  'deepseek-v3.2': 'deepseek-chat',
  'deepseek-v3.1': 'deepseek-chat',
  'deepseek-coder': 'deepseek-chat',
  'deepseek-reasoner': 'deepseek-chat',

  // ==================== Kimi ====================
  'kimi-k2.5': 'kimi-k2.5',
};

export interface ToolSummaryResult {
  toolName: string;
  toolCallId: string;
  originalLength: number;
  summary: string;
  summaryModel: string;
  /** 如果失败，携带错误信息供 UI 显示 */
  failed?: boolean;
  failReason?: string;
}

/**
 * 获取摘要用的轻量模型
 *
 *  策略优先级：
 * 1. 精确映射（同系列 mini）
 * 2. 前缀模糊匹配
 * 3. GPT-5.x 自动推断 mini 名
 * 4. 回退到主模型（保证代理一定支持）
 */
/* 重载: string 入则 string 出, undefined/null 入则 undefined 出.
 * Why: print mode 没传 --model 时 runner.this.model = undefined, 调到这里 currentModel
 * 是 undefined → undefined.startsWith() TypeError → 整个 runner 挂掉 → -p 死等.
 * 返回 undefined 让 caller 的 fallbackModel !== this.model 判定为 false, 不走 fallback. */
/** provider 前缀剥离：mkgpt:gpt-5.5 / openai/gpt-5.5 → gpt-5.5 */
function bareModelId(modelId: string): string {
  const noProvider = modelId.includes(':') ? modelId.slice(modelId.lastIndexOf(':') + 1) : modelId;
  const slash = noProvider.lastIndexOf('/');
  return slash >= 0 ? noProvider.slice(slash + 1) : noProvider;
}

/** 前缀匹配边界：允许 gpt-5 → gpt-5-mini，禁止 gpt-5 → gpt-5.5 */
function prefixMatches(model: string, pattern: string): boolean {
  if (model === pattern) return true;
  if (!model.startsWith(pattern)) return false;
  const next = model.charAt(pattern.length);
  return next === '-' || next === '/' || next === '_' || next === ':';
}

export function getSummaryModel(currentModel: string): string;
export function getSummaryModel(currentModel: string | undefined | null): string | undefined;
export function getSummaryModel(currentModel: string | undefined | null): string | undefined {
  if (!currentModel) return undefined;

  const bare = bareModelId(currentModel);

  // 精确匹配（先 bare，再原串）
  if (SUMMARY_MODEL_MAP[bare]) {
    return SUMMARY_MODEL_MAP[bare];
  }
  if (SUMMARY_MODEL_MAP[currentModel]) {
    return SUMMARY_MODEL_MAP[currentModel];
  }

  // 模糊匹配：长前缀优先，且要求边界字符（避免 gpt-5 吃掉 gpt-5.5）
  const patterns = Object.keys(SUMMARY_MODEL_MAP).sort((a, b) => b.length - a.length);
  for (const pattern of patterns) {
    if (prefixMatches(bare, pattern)) {
      return SUMMARY_MODEL_MAP[pattern];
    }
  }

  // GPT-5.x 自动推断：有 -mini 的代 → family-mini；5.5/5.6 无 mini → 留本模型
  const gpt5Match = bare.match(/^(gpt-5\.\d+)/);
  if (gpt5Match) {
    const family = gpt5Match[1];
    if (GPT5_NO_MINI_FAMILIES.has(family)) {
      return bare;
    }
    return `${family}-mini`;
  }

  // 回退到当前模型（代理一定支持当前模型，只是贵一点）
  return currentModel;
}

/** 摘要生成的最大重试次数 — 远少于主模型的 14 次 */
const SUMMARY_MAX_RETRIES = 2;
/** 摘要生成的超时 — 远短于主模型的 540s */
const SUMMARY_TIMEOUT_MS = 30_000;

const SUMMARY_PROMPT = `You are a tool result summarizer. Summarize the following tool execution result concisely, preserving:
1. Key data points, file paths, function names, and error messages
2. The overall outcome (success/failure)
3. Important numbers (line counts, match counts, etc.)

Keep the summary under 500 characters. Be factual, no commentary.`;

/**
 * 异步生成工具执行摘要
 *
 *  修复：
 * 1. 超时保护（30s，不是主模型的 540s）
 * 2. mini 模型失败时回退到主模型而非重试 14 次
 * 3. 错误快速失败，不阻塞主流程
 */
export async function generateToolSummary(
  llmProvider: LLMProvider,
  currentModel: string,
  toolName: string,
  toolCallId: string,
  toolInput: Record<string, unknown>,
  toolOutput: string,
): Promise<ToolSummaryResult | null> {
  if (toolOutput.length < 2000) {
    return null;
  }

  const summaryModel = getSummaryModel(currentModel);
  const inputPreview = JSON.stringify(toolInput).slice(0, 200);
  const outputPreview = toolOutput.slice(0, 3000);

  const messages: Message[] = [
    { role: 'system', content: SUMMARY_PROMPT },
    {
      role: 'user',
      content: `Tool: ${toolName}\nInput: ${inputPreview}\nOutput (${toolOutput.length} chars total):\n${outputPreview}${toolOutput.length > 3000 ? '\n...[truncated]' : ''}`,
    },
  ];

  //  尝试 mini 模型 → 失败则用主模型 → 都失败就放弃
  const modelsToTry = summaryModel !== currentModel
    ? [summaryModel, currentModel]  // mini 优先，主模型兜底
    : [currentModel];               // 没有 mini，直接用主模型

  for (const model of modelsToTry) {
    try {
      //  超时保护：摘要不值得等 30s 以上
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);

      const response = await llmProvider.chat(messages, {
        model,
        temperature: 0,
        signal: controller.signal,
        /* luna 是 5.6 的"轻量档"但仍是 reasoning 模型. 不封顶会按 32K 思考 2–5 分钟. */
        maxTokens: 800,
        effortLevel: 'minimal',
      } as any);

      clearTimeout(timer);

      const summary = response.choices?.[0]?.message?.content ?? '';
      if (!summary) continue;

      cliLogger.debug('ToolSummary', `Generated summary for ${toolName}: ${summary.length} chars (model=${model})`);

      return {
        toolName,
        toolCallId,
        originalLength: toolOutput.length,
        summary: `[Tool Summary] ${summary}`,
        summaryModel: model,
      };
    } catch (error: any) {
      const isTimeout = error.name === 'AbortError';
      cliLogger.warn('ToolSummary', `${isTimeout ? 'Timeout' : 'Failed'} for ${toolName} (model=${model}): ${error.message?.substring(0, 100)}`);
      // 继续尝试下一个模型
    }
  }

  // 全部失败 — 通知 UI + 返回失败标记
  cliLogger.warn('ToolSummary', `All models failed for ${toolName}, skipping summary`);
  _summaryEventListener?.({
    type: 'summary_failed',
    toolName,
    model: summaryModel,
    reason: `Summary model unavailable (tried: ${modelsToTry.join(', ')})`,
  });
  return {
    toolName,
    toolCallId,
    originalLength: toolOutput.length,
    summary: '',
    summaryModel: summaryModel,
    failed: true,
    failReason: `Summary model unavailable (tried: ${modelsToTry.join(', ')})`,
  };
}

/**
 * 管理待处理的异步摘要
 * 在下一轮 LLM 调用前 await，隐藏延迟
 */
export class PendingToolSummaries {
  private pending: Promise<ToolSummaryResult | null>[] = [];

  add(promise: Promise<ToolSummaryResult | null>): void {
    this.pending.push(promise);
  }

  async drain(): Promise<ToolSummaryResult[]> {
    if (this.pending.length === 0) return [];

    const results = await Promise.all(this.pending);
    this.pending = [];

    //  不过滤 failed 结果 — 让 runner yield warning 事件给 UI
    return results.filter((r): r is ToolSummaryResult => r !== null);
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }
}
