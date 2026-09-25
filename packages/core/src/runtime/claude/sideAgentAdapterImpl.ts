import { ClaudeSideAgentService } from './ClaudeSideAgentService.js';
import { appendDiagLog } from '../agent/diagLogFile.js';
import {
  buildSessionTitleMessages,
  buildToolUseSummaryMessages,
  SIDE_AGENT_SESSION_TITLE_MAX_TOKENS,
  SIDE_AGENT_TOOL_SUMMARY_MAX_TOKENS,
} from './sideAgentPrompts.js';
import type { ProviderResolution } from '../runtimeOrchestrator.js';
import type {
  SessionTitlePersistMeta,
  SessionTitleRequest,
  SideAgentAdapter,
  ToolBatchSummaryRequest,
} from '../sideAgentAdapter.js';
import type { SideAgentConfig, SideAgentFeatures } from '@neoxlabs/platform/utils/config.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';

const TITLE_HARD_CAP = 60;

function sideAgentUiLanguage(): 'zh' | 'en' {
  try { return (loadConfig() as any)?.language === 'en' ? 'en' : 'zh'; } catch { return 'zh'; }
}

export interface ClaudeSideAgentAdapterOptions {
  /** 当前会话的主 provider/model — 最低优先级 fallback,实际跑 side-agent 时还会过 Haiku 决策 */
  getSessionRoute: () => { providerId: string; modelName: string } | null;
  /** 任务 Agent 配置 — 当 sideAgent 自身无 providerId/model 时复用 (用户语义: 侧路 Agent 默认复用任务 Agent) */
  getTaskAgentRoute?: (mainModel?: string) => { providerId: string; modelName: string } | null;
  /** 用户配置的 side-agent 偏好 — 没配返回 undefined,adapter 走默认 */
  getSideAgentConfig: () => SideAgentConfig | undefined;
  /** Provider 解析,转给 ClaudeSideAgentService */
  resolveProvider: (providerId?: string, modelName?: string) => ProviderResolution;
  /** 标题落库回调 — 异步写 session.title,失败可静默 */
  persistSessionTitle?: (sessionId: string, title: string, meta?: SessionTitlePersistMeta) => void | Promise<void>;
}

const OPT_IN_FEATURES: ReadonlySet<keyof SideAgentFeatures> = new Set(['toolUseSummary'] as const);

function isFeatureEnabled(
  config: SideAgentConfig | undefined,
  feature: keyof SideAgentFeatures,
): boolean {
  const optIn = OPT_IN_FEATURES.has(feature);
  if (!config) return !optIn;                          // 没配置 → 缺省开 (opt-in 特性除外)
  if (config.enabled === false) return false;          // 全局关
  const v = config.features?.[feature];
  if (v === false) return false;
  if (optIn) return v === true;                        // opt-in: 必须显式打开
  return true;
}

function trimTitle(text: string): string {
  const flat = text.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > TITLE_HARD_CAP ? flat.slice(0, TITLE_HARD_CAP) : flat;
}

export function looksLikeTitle(raw: string): boolean {
  const t = (raw || '').trim();
  if (!t) return false;
  if (t.includes('```')) return false;                    /* 代码块 */
  if (/\n/.test(raw.trim())) return false;                /* 多行 = 不是标题 */
  if (t.length > TITLE_HARD_CAP) return false;            /* 超长 = 它在答题 */
  /* 代码/结构化输出的特征词与符号 */
  if (/\b(def|function|class|import|return|const|let|var|public|SELECT|INSERT)\b/.test(t)) return false;
  if (/[{};]|=>|\breturn\b|\bfor\s*\(/.test(t)) return false;
  return true;
}

export function createClaudeSideAgentAdapter(opts: ClaudeSideAgentAdapterOptions): SideAgentAdapter {
  const service = new ClaudeSideAgentService(opts.resolveProvider);

  function resolveRoute(config: SideAgentConfig | undefined): { providerId: string; modelName: string } | null {
    // 优先级: sideAgent 显式配置 > taskAgent 配置 (用户希望 sideAgent 默认复用 taskAgent) > 主会话
    if (config?.providerId && config.model) {
      return { providerId: config.providerId, modelName: config.model };
    }
    const taskRoute = opts.getTaskAgentRoute?.();
    if (taskRoute?.providerId && taskRoute?.modelName) {
      return taskRoute;
    }
    return opts.getSessionRoute();
  }

  return {
    scheduleToolBatchSummary(request: ToolBatchSummaryRequest): void {
      const config = opts.getSideAgentConfig();
      if (!isFeatureEnabled(config, 'toolUseSummary')) return;
      const route = resolveRoute(config);
      if (!route) return;

      void service
        .query({
          providerId: route.providerId,
          modelName: route.modelName,
          messages: buildToolUseSummaryMessages(request.toolCalls),
          maxTokens: SIDE_AGENT_TOOL_SUMMARY_MAX_TOKENS,
          temperature: 0,
          allowOpusFallback: config?.claudeFallbackToOpusWhenNoHaiku,
          disableThinking: config?.disableThinking ?? true,
          signal: request.abortSignal,
        })
        .then((result) => {
          const summary = result.text?.trim();
          if (!summary) return;
          request.emit(summary);
          cliLogger.debug('SIDE_AGENT', `toolUseSummary[${request.batchId}] via ${result.modelName}: ${summary}`);
        })
        .catch((err: any) => {
          if (err?.name === 'AbortError' || request.abortSignal?.aborted) return;
          cliLogger.warn('SIDE_AGENT', `toolUseSummary[${request.batchId}] failed: ${err?.message}`);
        });
    },

    scheduleSessionTitle(request: SessionTitleRequest): void {
      const config = opts.getSideAgentConfig();
      const enabled = isFeatureEnabled(config, 'sessionTitle');
      const route = enabled ? resolveRoute(config) : null;
      appendDiagLog('SIDE_AGENT_TITLE', { stage: 'schedule', enabled, route, sessionId: request.sessionId });
      if (!enabled || !route) return;

      void service
        .query({
          providerId: route.providerId,
          modelName: route.modelName,
          messages: buildSessionTitleMessages(request.firstUserMessage, sideAgentUiLanguage(), request.recentUserMessages),
          maxTokens: SIDE_AGENT_SESSION_TITLE_MAX_TOKENS,
          temperature: 0.2,
          allowOpusFallback: config?.claudeFallbackToOpusWhenNoHaiku,
          disableThinking: config?.disableThinking ?? true,
          signal: request.abortSignal,
        })
        .then((result) => {
          const raw = result.text || '';
          const title = trimTitle(raw);
          const sane = looksLikeTitle(raw) && looksLikeTitle(title);
          appendDiagLog('SIDE_AGENT_TITLE', { stage: 'result', raw: raw.slice(0, 80), title, sane, hasPersist: !!opts.persistSessionTitle });
          if (!title) return;
          if (!sane) {
            /* 模型没听话 (返回了代码/长篇/多行) —— 保留原名, 别把垃圾写进侧栏 */
            cliLogger.warn('SIDE_AGENT', `sessionTitle[${request.sessionId}] 结果不像标题, 已丢弃: ${title.slice(0, 40)}`);
            return;
          }
          request.emit?.(title);
          if (opts.persistSessionTitle) {
            try {
              const ret = opts.persistSessionTitle(request.sessionId, title, {
                aggregatedFromUserMessages: request.aggregatedFromUserMessages,
                expectedCurrentTitle: request.expectedCurrentTitle,
              });
              if (ret && typeof (ret as Promise<void>).catch === 'function') {
                (ret as Promise<void>).catch((err) => {
                  cliLogger.warn('SIDE_AGENT', `persistSessionTitle failed: ${err?.message}`);
                });
              }
            } catch (err: any) {
              cliLogger.warn('SIDE_AGENT', `persistSessionTitle threw: ${err?.message}`);
            }
          }
          cliLogger.debug('SIDE_AGENT', `sessionTitle[${request.sessionId}] via ${result.modelName}: ${title}`);
        })
        .catch((err: any) => {
          appendDiagLog('SIDE_AGENT_TITLE', { stage: 'error', name: err?.name, message: err?.message });
          if (err?.name === 'AbortError' || request.abortSignal?.aborted) return;
          cliLogger.warn('SIDE_AGENT', `sessionTitle[${request.sessionId}] failed: ${err?.message}`);
        });
    },
  };
}
