/**
 * Ghost Text Provider —— AI inline completions for Monaco Editor
 *
 * Optimized for low-latency editor UX:
 *   1. Per-model debounce / cache / dedupe
 *   2. Bounded prefix/suffix extraction (no full-document copy)
 *   3. Lower false-positive rate in comments / huge files / empty contexts
 *   4. Explicit trigger returns multiple candidates for cycling
 */

import type { Monaco } from '@monaco-editor/react';
import type { languages, editor } from 'monaco-editor';

const FAST_AUTO_DEBOUNCE_MS = 90;
const AUTO_DEBOUNCE_MS = 160;
const SLOW_AUTO_DEBOUNCE_MS = 260;
const MAX_PREFIX_CHARS = 2000;
const MAX_SUFFIX_CHARS = 500;
const MAX_MODEL_CHARS = 300_000;
const MAX_LINE_CHARS = 500;
const MIN_PREFIX_CHARS = 3;
const CACHE_TTL_MS = 15_000;
const EMPTY_CACHE_TTL_MS = 2_500;
const MAX_CACHE_ENTRIES = 32;
const MAX_EXPLICIT_CANDIDATES = 3;
const SUPPRESSION_TTL_MS = 45_000;
const SUPPRESSION_MUTE_MS = 2_500;
const MAX_SUPPRESSION_ENTRIES = 64;
const MAX_SUPPRESSED_ITEMS_PER_KEY = 4;
const SUPPRESSION_PREFIX_TAIL_CHARS = 160;
const SUPPRESSION_SUFFIX_HEAD_CHARS = 80;

const SUPPORTED_LANGUAGES = [
  'typescript', 'typescriptreact',
  'javascript', 'javascriptreact',
  'python', 'go', 'rust', 'java', 'c', 'cpp', 'csharp',
  'css', 'scss', 'less', 'html', 'xml', 'json', 'yaml', 'markdown',
  'shell', 'sh', 'sql', 'kotlin', 'ruby', 'php', 'swift', 'scala', 'dockerfile',
] as const;
const SUPPORTED_LANGUAGE_SET = new Set<string>(SUPPORTED_LANGUAGES);

interface CacheEntry {
  items: string[];
  createdAt: number;
  version: number;
}

interface PendingRequest {
  key: string;
  version: number;
  promise: Promise<string[]>;
  cancel: () => void;
}

interface InflightRequest {
  key: string;
  version: number;
  promise: Promise<string[]>;
  /** Cancel the in-flight LLM call in the main process. Idempotent. */
  abort: () => void;
}

interface SuppressionEntry {
  items: string[];
  createdAt: number;
  muteUntil: number;
}

interface NeoxInlineCompletionMeta {
  model: editor.ITextModel;
  suppressionKey: string;
  explicit: boolean;
  insertText: string;
}

type NeoxInlineCompletion = languages.InlineCompletion & { neoxMeta: NeoxInlineCompletionMeta };
type NeoxInlineCompletions = languages.InlineCompletions<NeoxInlineCompletion>;

interface ModelState {
  requestSeq: number;
  pending: PendingRequest | null;
  inflight: InflightRequest | null;
  cache: Map<string, CacheEntry>;
  suppressed: Map<string, SuppressionEntry>;
}

let registered = false;
const modelStates = new WeakMap<editor.ITextModel, ModelState>();

function getModelState(model: editor.ITextModel): ModelState {
  let state = modelStates.get(model);
  if (!state) {
    state = { requestSeq: 0, pending: null, inflight: null, cache: new Map(), suppressed: new Map() };
    modelStates.set(model, state);
  }
  return state;
}

function getInlineContextWindow(
  model: editor.ITextModel,
  position: { lineNumber: number; column: number },
): { prefix: string; suffix: string } {
  const cursorOffset = model.getOffsetAt(position);
  const prefixStartOffset = Math.max(0, cursorOffset - MAX_PREFIX_CHARS);
  const suffixEndOffset = Math.min(model.getValueLength(), cursorOffset + MAX_SUFFIX_CHARS);
  const prefixStart = model.getPositionAt(prefixStartOffset);
  const suffixEnd = model.getPositionAt(suffixEndOffset);

  return {
    prefix: model.getValueInRange({
      startLineNumber: prefixStart.lineNumber,
      startColumn: prefixStart.column,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    }),
    suffix: model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: position.column,
      endLineNumber: suffixEnd.lineNumber,
      endColumn: suffixEnd.column,
    }),
  };
}

function hasMeaningfulContext(prefix: string, beforeCursor: string): boolean {
  if (prefix.trim().length < MIN_PREFIX_CHARS) return false;
  if (beforeCursor.trim().length > 0) return true;
  if (!/\n[ \t]*$/.test(prefix)) return false;
  return prefix.slice(-200).split('\n').reverse().some((line) => line.trim().length > 0);
}

function looksLikeCommentContext(beforeCursor: string, prefix: string, suffix: string): boolean {
  if (/^\s*(\/\/|#|--\s)/.test(beforeCursor)) return true;
  const recentPrefix = prefix.slice(-300);
  const nearSuffix = suffix.slice(0, 200);
  if (/\/\*[\s\S]*$/.test(recentPrefix) && !/\*\//.test(nearSuffix)) return true;
  if (/<!--[\s\S]*$/.test(recentPrefix) && !/-->/.test(nearSuffix)) return true;
  return false;
}

function isWordChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_$]/.test(char);
}

function isMidWordContext(beforeCursor: string, suffix: string): boolean {
  return isWordChar(beforeCursor.slice(-1)) && isWordChar(suffix.slice(0, 1));
}

function isStrongAutoTriggerPoint(beforeCursor: string, prefix: string): boolean {
  if (/\n[ \t]*[A-Za-z0-9_$]*$/.test(prefix)) return true;
  if (/(?:return|yield|await|throw|case|new)\s+$/.test(beforeCursor)) return true;
  if (/(?:\.|->|::)$/.test(beforeCursor.trimEnd())) return true;
  if (/[({[=:,]\s*$/.test(beforeCursor)) return true;
  return false;
}

function getAutoDebounceMs(beforeCursor: string, prefix: string, suffix: string): number {
  if (isStrongAutoTriggerPoint(beforeCursor, prefix)) return FAST_AUTO_DEBOUNCE_MS;
  if (isMidWordContext(beforeCursor, suffix)) return SLOW_AUTO_DEBOUNCE_MS;
  if (isWordChar(beforeCursor.slice(-1))) return 210;
  return AUTO_DEBOUNCE_MS;
}

function buildInlineHint(
  monaco: Monaco,
  position: { lineNumber: number; column: number },
  insertText: string,
  explicit: boolean,
  totalItems: number,
): languages.InlineCompletionHint | undefined {
  if (!insertText) return undefined;

  const parts = ['Tab'];
  parts.push('⌘→ word');
  if (insertText.includes('\n')) parts.push('⌘⇧→ line');
  if (explicit && totalItems > 1) parts.push('Alt+[ / ]');

  return {
    range: {
      startLineNumber: position.lineNumber,
      startColumn: position.column,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    },
    style: monaco.languages.InlineCompletionHintStyle.Label,
    content: parts.join(' · '),
    jumpToEdit: false,
  };
}

function buildCacheKey(language: string, prefix: string, suffix: string, explicit: boolean, maxCandidates: number): string {
  return `${language}\u0000${explicit ? 'explicit' : 'auto'}\u0000${maxCandidates}\u0000${prefix}\u0000${suffix}`;
}

function normalizeCompletionText(text: string): string {
  return text.replace(/\r\n/g, '\n').trimEnd();
}

function stripTrailingPartialToken(text: string): string {
  return text.replace(/[A-Za-z0-9_$]+$/, '');
}

function buildSuppressionKey(language: string, prefix: string, suffix: string): string {
  const prefixAnchor = stripTrailingPartialToken(prefix).slice(-SUPPRESSION_PREFIX_TAIL_CHARS);
  const suffixHead = suffix.slice(0, SUPPRESSION_SUFFIX_HEAD_CHARS);
  return `${language}\u0000${prefixAnchor}\u0000${suffixHead}`;
}

function getSuppressionEntry(state: ModelState, key: string): SuppressionEntry | undefined {
  const entry = state.suppressed.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > SUPPRESSION_TTL_MS) {
    state.suppressed.delete(key);
    return undefined;
  }

  state.suppressed.delete(key);
  state.suppressed.set(key, entry);
  return entry;
}

function isEquivalentSuppressedItem(left: string, right: string): boolean {
  const normalizedLeft = normalizeCompletionText(left);
  const normalizedRight = normalizeCompletionText(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  if (Math.min(normalizedLeft.length, normalizedRight.length) < 16) return false;
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}

function shouldMuteAutoSuggestion(state: ModelState, key: string): boolean {
  const entry = getSuppressionEntry(state, key);
  return !!entry && Date.now() < entry.muteUntil;
}

function filterSuppressedItems(state: ModelState, key: string, items: string[]): string[] {
  const entry = getSuppressionEntry(state, key);
  if (!entry || entry.items.length === 0) return items;
  return items.filter((item) => !entry.items.some((suppressed) => isEquivalentSuppressedItem(item, suppressed)));
}

function setSuppressedItems(state: ModelState, key: string, items: string[]): void {
  const now = Date.now();
  state.suppressed.delete(key);
  state.suppressed.set(key, { items, createdAt: now, muteUntil: now + SUPPRESSION_MUTE_MS });
  while (state.suppressed.size > MAX_SUPPRESSION_ENTRIES) {
    const oldestKey = state.suppressed.keys().next().value;
    if (!oldestKey) break;
    state.suppressed.delete(oldestKey);
  }
}

function suppressItem(state: ModelState, key: string, item: string): void {
  const normalizedItem = normalizeCompletionText(item);
  if (!normalizedItem) return;

  const existing = getSuppressionEntry(state, key);
  const nextItems = (existing?.items ?? []).filter((existingItem) => !isEquivalentSuppressedItem(existingItem, normalizedItem));
  nextItems.unshift(normalizedItem);
  setSuppressedItems(state, key, nextItems.slice(0, MAX_SUPPRESSED_ITEMS_PER_KEY));
}

function unsuppressItem(state: ModelState, key: string, item: string): void {
  const entry = getSuppressionEntry(state, key);
  if (!entry) return;

  const remaining = entry.items.filter((existingItem) => !isEquivalentSuppressedItem(existingItem, item));
  state.suppressed.delete(key);
  if (remaining.length === 0) return;

  state.suppressed.set(key, {
    items: remaining,
    createdAt: Date.now(),
    muteUntil: entry.muteUntil,
  });
}

function getCachedCompletion(state: ModelState, key: string, version: number, allowEmpty: boolean): string[] | undefined {
  const entry = state.cache.get(key);
  if (!entry) return undefined;
  if (entry.version !== version) {
    state.cache.delete(key);
    return undefined;
  }

  const ttl = entry.items.length > 0 ? CACHE_TTL_MS : EMPTY_CACHE_TTL_MS;
  if (Date.now() - entry.createdAt > ttl) {
    state.cache.delete(key);
    return undefined;
  }
  if (!allowEmpty && entry.items.length === 0) return undefined;

  state.cache.delete(key);
  state.cache.set(key, entry);
  return entry.items;
}

function setCachedCompletion(state: ModelState, key: string, version: number, items: string[]): void {
  state.cache.delete(key);
  state.cache.set(key, { items, createdAt: Date.now(), version });
  while (state.cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = state.cache.keys().next().value;
    if (!oldestKey) break;
    state.cache.delete(oldestKey);
  }
}

function normalizeItems(items: string[], maxCandidates: number): string[] {
  const unique = new Set<string>();
  const normalized: string[] = [];
  for (const item of items) {
    if (!item || unique.has(item)) continue;
    unique.add(item);
    normalized.push(item);
    if (normalized.length >= maxCandidates) break;
  }
  return normalized;
}

// Diagnostics — surface why ghost text didn't appear. Logs are throttled so
// a misconfigured provider doesn't flood the console on every keystroke.
let lastGhostLogAt = 0;
let lastGhostLogKey = '';
function logGhostDiagnostic(kind: 'no-bridge' | 'error' | 'empty', detail?: string): void {
  const key = `${kind}::${detail ?? ''}`;
  const now = Date.now();
  if (key === lastGhostLogKey && now - lastGhostLogAt < 5000) return;
  lastGhostLogKey = key;
  lastGhostLogAt = now;
  if (kind === 'no-bridge') {
    console.warn('[GhostText] preload bridge missing — window.neox.aiInlineComplete is undefined.');
    surfaceGhostFailure('补全不可用: 编辑器没接到补全服务', 'Inline completion unavailable: bridge missing');
  } else if (kind === 'error') {
    console.warn('[GhostText] backend returned error:', detail);
    surfaceGhostFailure(`补全失败: ${String(detail ?? '').slice(0, 120)}`, `Inline completion failed: ${String(detail ?? '').slice(0, 120)}`);
  } else {
    console.warn('[GhostText] backend returned no items (LLM said nothing or filtered).', detail ?? '');
  }
}

/** 把补全失败告诉用户 —— 只对 error / no-bridge 出提示; 'empty'(模型选择不补) 是正常情况, 不打扰。 */
function surfaceGhostFailure(zh: string, en: string): void {
  void (async () => {
    try {
      const notify = await import('../../components/notifyEvents');
      const isZh = (document.documentElement.lang || 'zh').startsWith('zh');
      notify.dispatchHint(isZh ? zh : en, 'warning');
    } catch { /* 提示通道自己坏了就算了, 不能让它反过来影响编辑 */ }
  })();
}

function generateCompletionRequestId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  return `gt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function requestInlineCompletion(
  prefix: string,
  suffix: string,
  language: string,
  explicit: boolean,
  maxCandidates: number,
  requestId: string,
): Promise<string[]> {
  try {
    const neox = (window as any).neox;
    if (!neox?.aiInlineComplete) {
      logGhostDiagnostic('no-bridge');
      return [];
    }
    const result = await neox.aiInlineComplete({
      prefix,
      suffix,
      language,
      explicit,
      maxCandidates,
      requestId,
    });
    if (result?.aborted) return [];
    if (result?.error) {
      logGhostDiagnostic('error', result.error);
    }
    if (result?.debug) {
      const tag = result.debug.isFast ? '⚡ fast' : '🐢 SLOW (no fast model in provider)';
      console.log(
        `[GhostText] ${result.debug.latencyMs}ms · ${tag} · model=${result.debug.model} · provider=${result.debug.provider}`,
      );
    }
    const items = normalizeItems(result?.items || [result?.insertText ?? ''], maxCandidates);
    if (items.length === 0 && !result?.error && explicit) {
      logGhostDiagnostic('empty');
    }
    return items;
  } catch (err) {
    logGhostDiagnostic('error', (err as { message?: string })?.message ?? String(err));
    return [];
  }
}

function abortInlineCompletion(requestId: string): void {
  try {
    const neox = (window as any).neox;
    neox?.aiInlineCompleteAbort?.(requestId);
  } catch {
    // bridge 不存在或窗口销毁 —— 无所谓, main 端也会随窗口 GC
  }
}

function scheduleCompletion(
  state: ModelState,
  key: string,
  version: number,
  requestSeq: number,
  prefix: string,
  suffix: string,
  language: string,
  explicit: boolean,
  maxCandidates: number,
  debounceMs: number,
): Promise<string[]> {
  let finish: (value: string[]) => void = () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  const promise = new Promise<string[]>((resolve) => {
    finish = (value: string[]) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(value);
    };

    timer = setTimeout(async () => {
      if (state.pending?.key === key && state.pending.version === version) state.pending = null;
      if (requestSeq !== state.requestSeq) return finish([]);

      const existingInflight = state.inflight;
      if (existingInflight && existingInflight.key === key && existingInflight.version === version) {
        try { return finish(await existingInflight.promise); } catch { return finish([]); }
      }

      // 如果 inflight 存在但 key/version 已过时, 主动 abort —— 节省 LLM 配额
      if (existingInflight && (existingInflight.key !== key || existingInflight.version !== version)) {
        existingInflight.abort();
        state.inflight = null;
      }

      const requestId = generateCompletionRequestId();
      let abortCalled = false;
      const doAbort = () => {
        if (abortCalled) return;
        abortCalled = true;
        abortInlineCompletion(requestId);
      };

      const inflightPromise = requestInlineCompletion(prefix, suffix, language, explicit, maxCandidates, requestId)
        .then((items) => {
          setCachedCompletion(state, key, version, items);
          return items;
        })
        .catch(() => [])
        .finally(() => {
          abortCalled = true;  // 已返回, 后续 abort 调用变成 no-op
          if (state.inflight?.key === key && state.inflight.version === version) state.inflight = null;
        });

      state.inflight = { key, version, promise: inflightPromise, abort: doAbort };
      try { finish(await inflightPromise); } catch { finish([]); }
    }, debounceMs);
  });

  state.pending = {
    key,
    version,
    promise,
    cancel: () => {
      if (state.pending?.key === key && state.pending.version === version) state.pending = null;
      finish([]);
    },
  };

  return promise;
}

function buildInlineCompletions(
  monaco: Monaco,
  model: editor.ITextModel,
  position: { lineNumber: number; column: number },
  items: string[],
  explicit: boolean,
  suppressionKey: string,
): NeoxInlineCompletions | null {
  const visibleItems = explicit ? items : items.slice(0, 1);
  if (visibleItems.length === 0) return null;

  return {
    items: visibleItems.map((insertText) => ({
      insertText,
      completeBracketPairs: true,
      range: {
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      },
      command: {
        id: 'editor.action.inlineSuggest.trigger',
        title: 'Trigger Inline Suggestion',
        arguments: [{ explicit: false, showNoResultNotification: false }],
      },
      hint: buildInlineHint(monaco, position, insertText, explicit, visibleItems.length),
      neoxMeta: { model, suppressionKey, explicit, insertText },
    }) as NeoxInlineCompletion),
    enableForwardStability: false,
  };
}

function makeInlineCompletionsProvider(monaco: Monaco): languages.InlineCompletionsProvider<NeoxInlineCompletions> {
  return {
    handleItemDidShow(_completions, item, updatedInsertText): void {
      if (updatedInsertText) item.neoxMeta.insertText = updatedInsertText;
    },

    handleEndOfLifetime(_completions, item, reason, lifetimeSummary): void {
      const meta = item.neoxMeta;
      if (!meta || meta.explicit) return;

      const state = modelStates.get(meta.model);
      if (!state) return;
      if (reason.kind === monaco.languages.InlineCompletionEndOfLifeReasonKind.Accepted) {
        unsuppressItem(state, meta.suppressionKey, meta.insertText);
        return;
      }

      if (
        lifetimeSummary.partiallyAccepted > 0
        || lifetimeSummary.partiallyAcceptedCountSinceOriginal > 0
        || lifetimeSummary.partiallyAcceptedCharactersSinceOriginal > 0
      ) return;

      if (reason.kind === monaco.languages.InlineCompletionEndOfLifeReasonKind.Rejected) {
        suppressItem(state, meta.suppressionKey, meta.insertText);
        return;
      }

      if (
        reason.kind === monaco.languages.InlineCompletionEndOfLifeReasonKind.Ignored
        && (reason as { userTypingDisagreed?: boolean }).userTypingDisagreed === true
      ) {
        suppressItem(state, meta.suppressionKey, meta.insertText);
      }
    },

    async provideInlineCompletions(model, position, context, token): Promise<NeoxInlineCompletions | null> {
      const language = model.getLanguageId();
      if (!SUPPORTED_LANGUAGE_SET.has(language)) return null;

      const explicit = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
      const maxCandidates = explicit ? MAX_EXPLICIT_CANDIDATES : 1;
      if (!explicit && model.getValueLength() > MAX_MODEL_CHARS) return null;

      const currentLine = model.getLineContent(position.lineNumber);
      if (!explicit && currentLine.length > MAX_LINE_CHARS) return null;

      const beforeCursor = currentLine.slice(0, position.column - 1);
      const { prefix, suffix } = getInlineContextWindow(model, position);
      if (!explicit && context.selectedSuggestionInfo) return null;
      if (!explicit && looksLikeCommentContext(beforeCursor, prefix, suffix)) return null;
      if (!explicit && isMidWordContext(beforeCursor, suffix)) return null;
      if (!explicit && !hasMeaningfulContext(prefix, beforeCursor)) return null;
      if (token.isCancellationRequested) return null;

      const state = getModelState(model);
      const suppressionKey = buildSuppressionKey(language, prefix, suffix);
      if (!explicit && shouldMuteAutoSuggestion(state, suppressionKey)) return null;

      const version = model.getAlternativeVersionId();
      const key = buildCacheKey(language, prefix, suffix, explicit, maxCandidates);
      const cached = getCachedCompletion(state, key, version, !explicit);
      if (cached !== undefined) {
        const visibleItems = explicit ? cached : filterSuppressedItems(state, suppressionKey, cached);
        return token.isCancellationRequested ? null : buildInlineCompletions(monaco, model, position, visibleItems, explicit, suppressionKey);
      }

      if (state.pending && state.pending.key === key && state.pending.version === version) {
        const items = await state.pending.promise;
        const visibleItems = explicit ? items : filterSuppressedItems(state, suppressionKey, items);
        return token.isCancellationRequested ? null : buildInlineCompletions(monaco, model, position, visibleItems, explicit, suppressionKey);
      }

      if (state.inflight && state.inflight.key === key && state.inflight.version === version) {
        const items = await state.inflight.promise;
        const visibleItems = explicit ? items : filterSuppressedItems(state, suppressionKey, items);
        return token.isCancellationRequested ? null : buildInlineCompletions(monaco, model, position, visibleItems, explicit, suppressionKey);
      }

      state.pending?.cancel();
      const requestSeq = ++state.requestSeq;
      const items = await scheduleCompletion(
        state,
        key,
        version,
        requestSeq,
        prefix,
        suffix,
        language,
        explicit,
        maxCandidates,
        explicit ? 0 : getAutoDebounceMs(beforeCursor, prefix, suffix),
      );

      if (token.isCancellationRequested || requestSeq !== state.requestSeq) return null;
      const visibleItems = explicit ? items : filterSuppressedItems(state, suppressionKey, items);
      return buildInlineCompletions(monaco, model, position, visibleItems, explicit, suppressionKey);
    },

    disposeInlineCompletions(): void {
      // no-op
    },
  };
}

export function registerGhostTextProvider(monaco: Monaco): void {
  if (registered) return;
  registered = true;

  const provider = makeInlineCompletionsProvider(monaco);
  for (const language of SUPPORTED_LANGUAGES) {
    monaco.languages.registerInlineCompletionsProvider(language, provider);
  }
}
