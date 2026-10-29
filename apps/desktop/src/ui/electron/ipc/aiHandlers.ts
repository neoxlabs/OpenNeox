/**
 * AI IPC Handlers —— editor-level AI features
 *
 * 所有调用都通过 configService.getDefaultProviderEntry() + buildProvider()
 * 走 Neox 自己的 LLM stack，无需硬编码任何协议。
 *
 * 当前功能：
 *   ai:inline-complete   —— Ghost text FIM 补全（同步返回 insertText）
 *   ai:rank-completions —— 对本地 completion 候选做 AI 重排
 */

import { ipcMain } from './ipcMainBridged.js';
/* 类型是纯类型导入, 编译后完全擦除 —— 不会在运行时把 electron 拉进来。
 * 值 (ipcMain) 走桥的替身, 于是这个文件在纯 Node 后端里也 import 得动。 */
import type { IpcMainInvokeEvent } from 'electron';
import { configService } from '@neoxlabs/platform/platform/configService.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { buildProvider } from '@neoxlabs/core/runtime/runtimeBuilder.js';
import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import type { LLMProvider } from '@neoxlabs/kernel/types/index.js';
import { getWriteIntentRegistry } from '../services/writeIntentService.js';
import type { WriteIntentToken } from '@neoxlabs/platform/shared/async/writeIntent.js';

// ── FIM prompt ──────────────────────────────────────────────────────────────

const MAX_PREFIX = 2000; // chars sent before cursor
const MAX_SUFFIX = 500;  // chars sent after cursor
const MAX_INLINE_EDIT_PREFIX = 1600;
const MAX_INLINE_EDIT_SUFFIX = 1200;
const MAX_RERANK_PREFIX = 120;
const MAX_RERANK_BEFORE = 1200;
const MAX_RERANK_AFTER = 400;
const MAX_RERANK_CANDIDATES = 8;

// ── Fast model selection ────────────────────────────────────────────────────
// Inline completion 强烈偏好低延迟小模型. 用户没显式配置时, 我们优先挑出
// 带 haiku/mini/flash/nano/turbo/lite/small 这类 hint 的 model name.
// 排序按 hint 出现顺序: haiku > mini > flash > nano > turbo > lite > small.

const FAST_MODEL_HINTS = ['haiku', 'mini', 'flash', 'nano', 'turbo', 'lite', 'small', 'fast'] as const;

function pickFastModel(provider: ProviderConfigEntry): string | undefined {
  const models = provider.models?.map((m) => m.name).filter((name): name is string => !!name) ?? [];
  if (models.length === 0) return undefined;
  const lowerModels = models.map((name) => ({ name, lower: name.toLowerCase() }));
  for (const hint of FAST_MODEL_HINTS) {
    const match = lowerModels.find((m) => m.lower.includes(hint));
    if (match) return match.name;
  }
  return undefined;
}

function pickInlineCompleteModel(provider: ProviderConfigEntry): string | undefined {
  return (
    pickFastModel(provider) ||
    provider.lastSelectedModel ||
    provider.defaultModel ||
    provider.models?.[0]?.name
  );
}

/**
 * Resolve (provider, model, source) for inline completion.
 * Source = 'override' (user pinned in settings) or 'auto' (default + fast hint).
 * Returns null when no provider is configured.
 */
export function resolveInlineCompleteTarget(): {
  provider: ProviderConfigEntry;
  model: string;
  source: 'override' | 'auto';
} | null {
  const override = configService.resolveInlineCompletionTarget();
  if (override) {
    return { provider: override.provider, model: override.model, source: 'override' };
  }
  const cfg = configService.getInlineCompletionConfig();
  const pinned = cfg.providerId ? configService.getProviderEntryById(cfg.providerId) : null;
  if (!pinned) {
    const current = currentChatModelTarget();
    if (current) return { ...current, source: 'auto' };
  }
  const provider = pinned ?? configService.getDefaultProviderEntry() ?? fallbackInlineProvider();
  if (!provider) return null;
  const model = pickInlineCompleteModel(provider);
  if (!model) return null;
  return { provider, model, source: 'auto' };
}

/** 输入框当前选的模型 (uiState `lastModelId` = `providerId:model`); 对不上已配置的服务商就返回 null。 */
function currentChatModelTarget(): { provider: ProviderConfigEntry; model: string } | null {
  try {
    const raw = getDatabase().getAppState<string | null>('ui:lastModelId', null);
    if (typeof raw !== 'string') return null;
    const idx = raw.indexOf(':');
    if (idx <= 0 || idx === raw.length - 1) return null;
    const provider = configService.getProviderEntryById(raw.slice(0, idx));
    if (!provider || /images?$/i.test(String((provider as any).protocol ?? ''))) return null;
    return { provider, model: raw.slice(idx + 1) };
  } catch {
    return null;
  }
}

function fallbackInlineProvider(): ProviderConfigEntry | null {
  const chatProviders = configService.getProviders().filter((p) => !/images?$/i.test(String(p.protocol ?? '')));
  const pick = chatProviders.find((p) => !!pickFastModel(p as unknown as ProviderConfigEntry))
    ?? chatProviders.find((p) => !!p.lastSelectedModel);
  return pick ? configService.getProviderEntryById(pick.id) : null;
}

function pickInlineEditModel(provider: ProviderConfigEntry): string | undefined {
  // Cmd+K 对质量要求略高, 优先 last-selected / default; fast model 仅作回退.
  return (
    provider.lastSelectedModel ||
    provider.defaultModel ||
    pickFastModel(provider) ||
    provider.models?.[0]?.name
  );
}

// ── Provider build cache (LRU) ──────────────────────────────────────────────
// buildProvider 会构造 SDK client + token cache + protocol adapter,
// 冷启动一次 ~50-200ms. 第一次按键不应承担这个成本.

interface CachedProviderEntry {
  result: ReturnType<typeof buildProvider>;
  providerSnapshot: string;
  createdAt: number;
}

const PROVIDER_CACHE_MAX = 4;
const PROVIDER_CACHE_TTL_MS = 10 * 60 * 1000;
const providerCache = new Map<string, CachedProviderEntry>();

function snapshotProvider(provider: ProviderConfigEntry): string {
  return [
    provider.id,
    provider.protocol,
    provider.baseUrl ?? '',
    provider.apiKey ?? '',
  ].join('\u0000');
}

function getCachedBuildProvider(
  provider: ProviderConfigEntry,
  model: string,
  sessionId: string,
): ReturnType<typeof buildProvider> {
  const snapshot = snapshotProvider(provider);
  const key = `${provider.id}::${model}`;
  const existing = providerCache.get(key);
  const now = Date.now();
  if (
    existing &&
    existing.providerSnapshot === snapshot &&
    now - existing.createdAt < PROVIDER_CACHE_TTL_MS
  ) {
    providerCache.delete(key);
    providerCache.set(key, existing);
    return existing.result;
  }

  const result = buildProvider({ provider, model, sessionId, runtimeMode: 'default' });
  providerCache.set(key, { result, providerSnapshot: snapshot, createdAt: now });
  while (providerCache.size > PROVIDER_CACHE_MAX) {
    const oldestKey = providerCache.keys().next().value;
    if (!oldestKey) break;
    providerCache.delete(oldestKey);
  }
  return result;
}

function warmupDefaultProvider(): void {
  // Fire-and-forget: 不阻塞 IPC 注册, 失败也不影响主流程.
  setImmediate(() => {
    try {
      // Inline completion: 走 override → 否则 default + fast hint.
      const completeTarget = resolveInlineCompleteTarget();
      if (completeTarget) {
        getCachedBuildProvider(completeTarget.provider, completeTarget.model, 'ghost-text-warmup');
      }
      // Inline edit (Cmd+K): 始终用 default provider.
      const editProvider = configService.getDefaultProviderEntry();
      if (editProvider) {
        const editModel = pickInlineEditModel(editProvider);
        if (editModel && (!completeTarget || editModel !== completeTarget.model || editProvider.id !== completeTarget.provider.id)) {
          getCachedBuildProvider(editProvider, editModel, 'inline-edit-warmup');
        }
      }
    } catch {
      // ignore — provider 还没配置好或 build 失败, 真实请求时会再试
    }
  });
}

// ── In-flight abort registries ──────────────────────────────────────────────
// 两个独立 registry, 避免 inline-edit (慢、streaming) 和 inline-complete
// (快、密集) 的 requestId 互相踩. inline-complete 的 id 由 ghostTextProvider
// 每次按键生成 (typically uuid), 过期请求被主动 abort 以节省 LLM 配额.

const inFlightAborts = new Map<string, AbortController>();
const inFlightCompletionAborts = new Map<string, AbortController>();

function registerAbort(requestId: string): AbortController {
  const existing = inFlightAborts.get(requestId);
  if (existing) existing.abort();
  const controller = new AbortController();
  inFlightAborts.set(requestId, controller);
  return controller;
}

function clearAbort(requestId: string): void {
  inFlightAborts.delete(requestId);
}

function abortRequest(requestId: string): boolean {
  const controller = inFlightAborts.get(requestId);
  if (!controller) return false;
  controller.abort();
  inFlightAborts.delete(requestId);
  return true;
}

function registerCompletionAbort(requestId: string): AbortController {
  const existing = inFlightCompletionAborts.get(requestId);
  if (existing) existing.abort();
  const controller = new AbortController();
  inFlightCompletionAborts.set(requestId, controller);
  return controller;
}

function clearCompletionAbort(requestId: string): void {
  inFlightCompletionAborts.delete(requestId);
}

function abortCompletionRequest(requestId: string): boolean {
  const controller = inFlightCompletionAborts.get(requestId);
  if (!controller) return false;
  controller.abort();
  inFlightCompletionAborts.delete(requestId);
  return true;
}

function isAbortLikeError(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: string }).name;
  if (name === 'AbortError') return true;
  const message = (err as { message?: string }).message;
  if (typeof message === 'string' && /abort|cancel/i.test(message)) return true;
  return false;
}

interface InlineCompletionRequest {
  prefix: string;
  suffix: string;
  language: string;
  explicit?: boolean;
  maxCandidates?: number;
  /**
   * Opaque id from renderer. If present, this request becomes abortable
   * via `ai:inline-complete:abort` (used when Monaco cancels its token or
   * the user types past the pending suggestion).
   */
  requestId?: string;
}

interface CompletionRerankRequest {
  language: string;
  prefix: string;
  beforeCursor: string;
  afterCursor: string;
  candidates: string[];
  explicit?: boolean;
}

interface InlineEditRequest {
  requestId: string;
  selectedCode: string;
  instruction: string;
  language: string;
  /**
   * 目标文件绝对路径. 用于发起 WriteIntent —— 流式期间后端 semantic 查询
   * 这个文件的 read 会被 cancel, 避免拿到半写状态的分析结果.
   * 不传则退化为 workspace-scope intent (影响所有后台 read —— 更保守).
   */
  filePath?: string;
  prefix?: string;
  suffix?: string;
}

function trimTail(text: string, limit: number): string {
  return text.length > limit ? text.slice(text.length - limit) : text;
}

function trimHead(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function stripCodeWrappers(raw: string): string {
  let text = raw.replace(/\r\n?/g, '\n').trim();
  text = text.replace(/^```[\w-]*\n?/, '');
  text = text.replace(/\n?```$/, '');
  text = text.replace(/^<replacement>\s*/i, '');
  text = text.replace(/\s*<\/replacement>$/i, '');
  text = text.replace(/^<code>\s*/i, '');
  text = text.replace(/\s*<\/code>$/i, '');
  return text.replace(/<CURSOR>/g, '');
}

function trimCompletionOverlap(prefix: string, suffix: string, raw: string): string {
  let text = stripCodeWrappers(raw);

  const maxPrefixOverlap = Math.min(prefix.length, text.length);
  for (let size = maxPrefixOverlap; size > 0; size -= 1) {
    if (prefix.endsWith(text.slice(0, size))) {
      text = text.slice(size);
      break;
    }
  }

  const maxSuffixOverlap = Math.min(suffix.length, text.length);
  for (let size = maxSuffixOverlap; size > 0; size -= 1) {
    if (suffix.startsWith(text.slice(text.length - size))) {
      text = text.slice(0, text.length - size);
      break;
    }
  }

  const lines = text.split('\n');
  if (lines.length > 24) {
    text = lines.slice(0, 24).join('\n');
  }
  if (text.length > 1200) {
    text = text.slice(0, 1200);
  }
  return text;
}

function parseCompletionItems(prefix: string, suffix: string, raw: string, maxCandidates: number): string[] {
  const matches = Array.from(raw.matchAll(/<completion>([\s\S]*?)<\/completion>/gi));
  const candidates = matches.length > 0
    ? matches.map((match) => match[1] || '')
    : [raw];

  const unique = new Set<string>();
  const items: string[] = [];
  for (const candidate of candidates) {
    const text = trimCompletionOverlap(prefix, suffix, candidate);
    if (!text || unique.has(text)) continue;
    unique.add(text);
    items.push(text);
    if (items.length >= maxCandidates) break;
  }
  return items;
}

function buildFimPrompt(prefix: string, suffix: string, language: string, explicit = false, maxCandidates = 1): string {
  const p = trimTail(prefix, MAX_PREFIX);
  const s = trimHead(suffix, MAX_SUFFIX);

  if (explicit) {
    return `You are a low-latency code completion engine for ${language || 'code'}.
Generate up to ${maxCandidates} strong alternatives for the exact cursor position (marked by <CURSOR>).

<prefix>
${p}<CURSOR>
</prefix>
<suffix>
${s}
</suffix>

Rules:
- Output ONLY alternatives wrapped in <completion>...</completion>.
- Each <completion> must contain ONLY the text to insert at <CURSOR>.
- Never repeat existing prefix or suffix text.
- No explanation, no markdown fences, no extra XML tags.
- Alternatives should be meaningfully different, but all must fit local style.
- Prefer short, high-confidence completions.
- Prefer a conservative best-effort completion over returning empty.
- Return empty only when the cursor is clearly a bad fit for code completion.`;
  }

  return `You are a low-latency code completion engine for ${language || 'code'}.
Complete the code exactly at the cursor position (marked by <CURSOR>).

<prefix>
${p}<CURSOR>
</prefix>
<suffix>
${s}
</suffix>

Rules:
- Output ONLY the text to insert at <CURSOR>.
- Never repeat existing prefix or suffix text.
- No explanation, no markdown fences, no XML tags.
- Match local naming, indentation, and surrounding style exactly.
- Prefer a short completion that finishes the current thought cleanly.
- Prefer a conservative best-effort completion over returning empty.
- Return empty only when the cursor is clearly in a comment, string, or invalid spot.`;
}

function buildFallbackFimPrompt(prefix: string, suffix: string, language: string, explicit = false, maxCandidates = 1): string {
  const p = trimTail(prefix, MAX_PREFIX);
  const s = trimHead(suffix, MAX_SUFFIX);

  if (explicit) {
    return `Complete this ${language || 'code'} cursor location.
Return up to ${maxCandidates} candidates wrapped in <completion>...</completion>.

<prefix>
${p}<CURSOR>
</prefix>
<suffix>
${s}
</suffix>

Rules:
- Return insert-text only.
- Keep local style and indentation.
- Finish the current statement or line when possible.
- No explanation, no markdown fences.`;
  }

  return `Complete this ${language || 'code'} cursor location.
Return only the text to insert.

<prefix>
${p}<CURSOR>
</prefix>
<suffix>
${s}
</suffix>

Rules:
- Return insert-text only.
- Keep local style and indentation.
- Finish the current statement or line when possible.
- No explanation, no markdown fences.`;
}

async function resolveInlineCompletionItems(
  llmProvider: Pick<LLMProvider, 'chat'>,
  model: string,
  request: InlineCompletionRequest,
  maxCandidates: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const requestItems = async (prompt: string, temperature: number, maxTokens: number): Promise<string[]> => {
    const response = await llmProvider.chat(
      [{ role: 'user', content: prompt }],
      {
        model,
        disableSystemPrompt: true,
        temperature,
        maxTokens,
        signal,
      },
    );

    return parseCompletionItems(
      request.prefix,
      request.suffix,
      response.choices?.[0]?.message?.content ?? '',
      maxCandidates,
    );
  };

  const primary = await requestItems(
    buildFimPrompt(request.prefix, request.suffix, request.language, !!request.explicit, maxCandidates),
    request.explicit ? 0.2 : 0,
    request.explicit ? 192 : 96,
  );
  if (primary.length > 0 || request.prefix.trim().length < 3) return primary;
  if (signal?.aborted) return [];

  return requestItems(
    buildFallbackFimPrompt(request.prefix, request.suffix, request.language, !!request.explicit, maxCandidates),
    request.explicit ? 0.25 : 0.1,
    request.explicit ? 192 : 96,
  );
}

function buildInlineEditPrompt(request: InlineEditRequest): string {
  const prefix = trimTail(request.prefix || '', MAX_INLINE_EDIT_PREFIX);
  const suffix = trimHead(request.suffix || '', MAX_INLINE_EDIT_SUFFIX);
  const filePath = request.filePath || 'unknown';

  return `You are an expert code editor. Rewrite ONLY the selected ${request.language || 'code'} according to the instruction.

<file_path>
${filePath}
</file_path>

<before_selection>
${prefix}
</before_selection>

<selected_code>
${request.selectedCode}
</selected_code>

<after_selection>
${suffix}
</after_selection>

<instruction>
${request.instruction}
</instruction>

Rules:
- Output ONLY the replacement for <selected_code>.
- No explanation, no markdown fences, no XML tags.
- Keep imports, identifiers, indentation, and project style consistent with surrounding code.
- Preserve behavior unless the instruction explicitly changes it.
- If instruction is ambiguous, make the smallest correct edit.`;
}

function buildCompletionRerankPrompt(request: CompletionRerankRequest): string {
  const prefix = trimTail(request.prefix || '', MAX_RERANK_PREFIX);
  const beforeCursor = trimTail(request.beforeCursor || '', MAX_RERANK_BEFORE);
  const afterCursor = trimHead(request.afterCursor || '', MAX_RERANK_AFTER);
  const candidates = request.candidates.filter(Boolean).slice(0, MAX_RERANK_CANDIDATES);

  return `You are reranking code completion candidates for ${request.language || 'code'}.
Choose the best ordering from the provided candidates only.

<context_before>
${beforeCursor}
</context_before>
<cursor_prefix>
${prefix}
</cursor_prefix>
<context_after>
${afterCursor}
</context_after>
<candidates>
${JSON.stringify(candidates, null, 2)}
</candidates>

Rules:
- Return ONLY a JSON array of candidate strings.
- Use only strings from <candidates>.
- Do not add, merge, rename, or explain candidates.
- Put the single best candidate first.
- Prefer locally relevant scope, naming, and API usage.
- If unsure, keep the most conservative valid ordering.`;
}

function parseCompletionRerank(raw: string, candidates: string[]): string[] {
  const allowed = new Map(candidates.map((candidate) => [candidate, candidate] as const));
  const match = stripCodeWrappers(raw).match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];

    const unique = new Set<string>();
    const ordered: string[] = [];
    for (const value of parsed) {
      if (typeof value !== 'string') continue;
      const normalized = allowed.get(value.trim());
      if (!normalized || unique.has(normalized)) continue;
      unique.add(normalized);
      ordered.push(normalized);
    }
    return ordered;
  } catch {
    return [];
  }
}

// ── Register ─────────────────────────────────────────────────────────────────

export function registerAiIpcHandlers(): void {
  // 进程启动后预热 default provider —— 避免首次按键背 SDK 冷启动.
  warmupDefaultProvider();

  /**
   * Ghost text inline completion.
   *
   * Returns { insertText, items, error? }.
   * - error 字段非空时, 渲染端可以把它推到状态栏给用户排查.
   * - 没建议时 insertText='' + items=[], 不视为错误.
   */
  ipcMain.handle(
    'ai:inline-complete',
    async (
      _event,
      request: InlineCompletionRequest,
    ): Promise<{ insertText: string; items: string[]; error?: string; aborted?: boolean; debug?: { model: string; provider: string; latencyMs: number; isFast: boolean; source: 'override' | 'auto' } }> => {
      const t0 = Date.now();
      // 若 renderer 带了 requestId, 注册 AbortController 使本次调用可被取消
      // (Monaco token.cancel / 光标移动 / 新按键触发新请求时均会 abort).
      const controller = request.requestId ? registerCompletionAbort(request.requestId) : undefined;
      try {
        if (configService.getInlineCompletionConfig().enabled === false) {
          return { insertText: '', items: [], error: 'Inline completion disabled in settings' };
        }

        // P4: 若当前有 active write intent (inline-edit 流式 / agent apply),
        // 跳过 ghostText —— 用户正在写入时再推补全是冗余, 而且拿到的 prefix
        // 大概率是半写状态, 补全出来的内容不对. write 结束后下一次按键自然
        // 重新触发, 不损失任何功能.
        if (getWriteIntentRegistry().snapshot().writes.length > 0) {
          return { insertText: '', items: [], aborted: true };
        }

        const target = resolveInlineCompleteTarget();
        if (!target) {
          return { insertText: '', items: [], error: 'No provider configured' };
        }

        const fastModelName = pickFastModel(target.provider);
        const isFast = !!fastModelName && fastModelName === target.model;

        const { llmProvider } = getCachedBuildProvider(
          target.provider,
          target.model,
          request.explicit ? 'ghost-text-explicit' : 'ghost-text',
        );

        const maxCandidates = Math.min(Math.max(request.maxCandidates || 1, 1), 3);
        const items = await resolveInlineCompletionItems(
          llmProvider,
          target.model,
          request,
          maxCandidates,
          controller?.signal,
        );
        if (controller?.signal.aborted) {
          return { insertText: '', items: [], aborted: true };
        }
        return {
          insertText: items[0] ?? '',
          items,
          debug: {
            model: target.model,
            provider: target.provider.id,
            latencyMs: Date.now() - t0,
            isFast,
            source: target.source,
          },
        };
      } catch (err: any) {
        if (controller?.signal.aborted || isAbortLikeError(err)) {
          return { insertText: '', items: [], aborted: true };
        }
        return {
          insertText: '',
          items: [],
          error: err?.message ?? String(err),
        };
      } finally {
        if (request.requestId) clearCompletionAbort(request.requestId);
      }
    },
  );

  /**
   * Cancel an in-flight inline completion. No-op if requestId unknown or already done.
   * Called when Monaco cancels its CompletionToken (user moved cursor / typed more).
   */
  ipcMain.handle(
    'ai:inline-complete:abort',
    async (_event, requestId: string): Promise<{ aborted: boolean }> => {
      if (!requestId) return { aborted: false };
      return { aborted: abortCompletionRequest(requestId) };
    },
  );

  ipcMain.handle(
    'ai:rank-completions',
    async (
      _event,
      request: CompletionRerankRequest,
    ): Promise<{ orderedLabels: string[] }> => {
      const candidates = (request.candidates || []).filter((candidate) => !!candidate?.trim()).slice(0, MAX_RERANK_CANDIDATES);
      if (candidates.length < 2) return { orderedLabels: candidates };

      try {
        const target = resolveInlineCompleteTarget();
        if (!target) return { orderedLabels: candidates };
        const { provider: providerEntry, model } = target;

        const { llmProvider } = getCachedBuildProvider(
          providerEntry,
          model,
          request.explicit ? 'completion-rerank-explicit' : 'completion-rerank',
        );

        const prompt = buildCompletionRerankPrompt({ ...request, candidates });
        const response = await llmProvider.chat(
          [{ role: 'user', content: prompt }],
          {
            model,
            disableSystemPrompt: true,
            temperature: 0,
            maxTokens: request.explicit ? 120 : 80,
          },
        );

        const orderedLabels = parseCompletionRerank(
          response.choices?.[0]?.message?.content ?? '',
          candidates,
        );
        return { orderedLabels: orderedLabels.length > 0 ? orderedLabels : candidates };
      } catch {
        return { orderedLabels: candidates };
      }
    },
  );

  /**
   * Cmd+K inline edit — streams LLM rewrite of selected code.
   * Chunks arrive via 'ai:inline-edit:chunk', completion via ':done', errors via ':error'.
   * Cancellation: send 'ai:inline-edit:abort' with the same requestId.
   */
  ipcMain.handle(
    'ai:inline-edit',
    async (event: IpcMainInvokeEvent, request: InlineEditRequest): Promise<void> => {
      const send = (channel: string, data: unknown) => {
        try { event?.sender.send(channel, data); } catch { /* window closed */ }
      };
      const requestId = request?.requestId;
      if (!requestId) {
        send('ai:inline-edit:error', { requestId, message: 'Missing requestId' });
        return;
      }

      const controller = registerAbort(requestId);
      // P4: 声明 write intent —— 流式期间任何 semantic 查询这个文件会被 cancel,
      // 避免 hover / outline 看到半写的代码. stream 结束 (done / error / abort)
      // 统一在 finally 里 end. 60s 兜底超时防 renderer 崩溃.
      let writeToken: WriteIntentToken | null = null;
      try {
        writeToken = getWriteIntentRegistry().begin({
          label: `inline-edit:${requestId}`,
          files: request.filePath ? [request.filePath] : [],
          signal: controller.signal,
          timeoutMs: 60_000,
        });

        const providerEntry = configService.getDefaultProviderEntry();
        if (!providerEntry) {
          send('ai:inline-edit:error', { requestId, message: 'No provider configured' });
          return;
        }
        const model = pickInlineEditModel(providerEntry);
        if (!model) {
          send('ai:inline-edit:error', { requestId, message: 'No model available on provider' });
          return;
        }

        const { llmProvider } = getCachedBuildProvider(providerEntry, model, `inline-edit:${requestId}`);
        const prompt = buildInlineEditPrompt(request);
        const stream = llmProvider.chatStreamed(
          [{ role: 'user', content: prompt }],
          {
            model,
            disableSystemPrompt: true,
            temperature: 0.15,
            maxTokens: 1024,
            signal: controller.signal,
          },
        );

        let fullText = '';
        for await (const chunk of stream) {
          if (controller.signal.aborted) break;
          const text = chunk?.choices?.[0]?.delta?.content;
          if (text) {
            fullText += text;
            send('ai:inline-edit:chunk', { requestId, text });
          }
        }

        if (controller.signal.aborted) {
          send('ai:inline-edit:aborted', { requestId });
          return;
        }

        send('ai:inline-edit:done', {
          requestId,
          text: stripCodeWrappers(fullText),
        });
      } catch (err: any) {
        if (controller.signal.aborted || isAbortLikeError(err)) {
          send('ai:inline-edit:aborted', { requestId });
        } else {
          send('ai:inline-edit:error', { requestId, message: err?.message ?? String(err) });
        }
      } finally {
        if (writeToken) {
          try { getWriteIntentRegistry().end(writeToken); } catch { /* ignore */ }
        }
        clearAbort(requestId);
      }
    },
  );

  /**
   * Cancel an in-flight inline edit. No-op if requestId is unknown / already done.
   * Returns whether the request was actively running.
   */
  ipcMain.handle(
    'ai:inline-edit:abort',
    async (_event, requestId: string): Promise<{ aborted: boolean }> => {
      if (!requestId) return { aborted: false };
      return { aborted: abortRequest(requestId) };
    },
  );

  /**
   * Read current inline completion preference + the resolved (effective) target.
   * Used by Settings UI to show what's actually being called.
   */
  ipcMain.handle(
    'ai:get-inline-complete-config',
    async (): Promise<{
      enabled: boolean;
      providerId?: string;
      model?: string;
      effective?: { providerId: string; model: string; source: 'override' | 'auto'; isFast: boolean };
    }> => {
      const cfg = configService.getInlineCompletionConfig();
      const target = resolveInlineCompleteTarget();
      const effective = target
        ? {
            providerId: target.provider.id,
            model: target.model,
            source: target.source,
            isFast: pickFastModel(target.provider) === target.model,
          }
        : undefined;
      return { ...cfg, effective };
    },
  );

  /**
   * Update inline completion preference. Pass null to clear a field
   * (e.g. providerId=null + model=null => fall back to default + fast hint).
   */
  ipcMain.handle(
    'ai:set-inline-complete-config',
    async (_event, updates: { enabled?: boolean; providerId?: string | null; model?: string | null }) => {
      const next = configService.setInlineCompletionConfig(updates);
      // Pre-warm the new target so first request after switch isn't cold.
      warmupDefaultProvider();
      return next;
    },
  );
}
