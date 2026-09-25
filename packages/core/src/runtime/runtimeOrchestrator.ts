import type { RuntimeMetadata, AgentRuntimeEvent, AgentRuntimeHost, RunTaskResult } from './agentRuntimeHost.js';
import type { RuntimeHostService, RuntimeHostConfig } from './runtimeHostService.js';
import type { RuntimeCheckpointService } from './checkpoint/runtimeCheckpointService.js';
import { setTurnFileBaseline } from './checkpoint/turnBaselineRegistry.js';
import type { ProviderConfigEntry, SideAgentConfig } from '@neoxlabs/platform/utils/config.js';
import type { ModelRouteConfig } from '@neoxlabs/platform/utils/config.js';
import type { ResolvedRoute, ModelRouter } from '../services/modelRouter.js';
import type { ActionLogService, ActionLogEventInput } from '../platform/actionLog/index.js';
import type { RuntimeEventHub, RuntimeEventTracker } from './runtimeEventHub.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { ErrorCategory, NeoxError } from '@neoxlabs/kernel/types/errors.js';
import { createClaudeSideAgentAdapter } from './claude/sideAgentAdapterImpl.js';
import type { SessionTitlePersistMeta } from './sideAgentAdapter.js';
import { appendDiagLog } from './agent/diagLogFile.js';
import { withWatchdog, envTimeoutMs } from '@neoxlabs/kernel/utils/stallGuard.js';
import { getActiveRunDiagnostics } from '@neoxlabs/kernel/utils/runTrace.js';

/** 单次 run attempt 看门狗阈值:LLM 尝试超过此时长开始打"还在跑"日志(仅观测) */
const RUN_ATTEMPT_WATCH_MS = envTimeoutMs('NEOX_RUN_ATTEMPT_WATCH_MS', 180_000);
/** runAttempt 看门狗的"真卡住"判据: run 至少这么久没 touch 才算无进展。默认 90s。 */
const RUN_ATTEMPT_IDLE_MS = envTimeoutMs('NEOX_RUN_ATTEMPT_IDLE_MS', 90_000);

function runIsMakingProgress(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  try {
    const runs = getActiveRunDiagnostics();
    const mine = runs.filter(r => r.sessionId === sessionId);
    if (mine.length === 0) return false;
    return mine.some(r => r.idleMs < RUN_ATTEMPT_IDLE_MS);
  } catch {
    return false;
  }
}

export type { RuntimeEventTracker } from './runtimeEventHub.js';

const MAX_SUMMARY_LENGTH = 240;
const MAX_DETAIL_LENGTH = 2000;

function truncateForLog(text: string, maxLength: number): string {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trimEnd() + '...';
}

export interface ProviderResolution {
  provider: ProviderConfigEntry | null;
  llmConfig: any | null;
}

export interface RuntimeOrchestratorOptions {
  hostService: RuntimeHostService;
  checkpointService?: RuntimeCheckpointService;
  resolveProvider: (providerId?: string, modelName?: string) => ProviderResolution;
  actionLog?: ActionLogService;
  /** 当前生效的 side-agent 配置 — 没配返回 undefined,adapter 走默认 */
  getSideAgentConfig?: () => SideAgentConfig | undefined;
  /** 任务 Agent 配置 — sideAgent 没配 providerId/model 时复用 */
  getTaskAgentRoute?: (mainModel?: string) => { providerId: string; modelName: string } | null;
  /** 标题落库回调 — 由 desktop/CLI 实现,写 sessionStore.title */
  persistSessionTitle?: (sessionId: string, title: string, meta?: SessionTitlePersistMeta) => void | Promise<void>;
  /**
   * 当用户没走 auto-route 但当前 provider 发生 fatal_auth/fatal_limit (403/余额耗尽/quota)
   * 时, 返回同 model 或等价 model 的备用 provider 列表, 让 orchestrator 自动跳到下一家.
   *
   * 传 undefined = 不做 auto fallback (跟旧行为一致).
   * 返回空数组 = 没有可用备胎 (原 error 抛出).
   *
   * 顺序建议: 按用户 provider 配置顺序 / 或 latency 记录; orchestrator 不排序, 只按数组顺序试.
   * originalProviderId/modelName 用于让实现方排除自己 + 匹配 model.
   */
  listAlternateProviders?: (originalProviderId: string | undefined, modelName: string | undefined) =>
    Array<{ providerId: string; modelName: string }>;
}

export interface RuntimeOrchestratorRunOptions {
  sessionId: string;
  prompt: string;
  metadata?: RuntimeMetadata;
  providerId?: string;
  modelName?: string;
  startedAt?: number;
  isAutoRouted?: boolean;
  routeConfig?: ModelRouteConfig;
  modelRouter?: ModelRouter | null;
  eventHub?: RuntimeEventHub;
  abortSignal?: AbortSignal;
  buildHostConfig: (provider: ProviderConfigEntry, llmConfig: any) => RuntimeHostConfig;
  onHostReady?: (host: AgentRuntimeHost) => void;
  onRuntimeEvent?: (event: AgentRuntimeEvent, tracker: RuntimeEventTracker) => void;
  onStatus?: (level: 'info' | 'warning' | 'error', message: string) => void;
  onRouteResolved?: (resolved: ResolvedRoute) => void;
}

export interface RuntimeOrchestratorResult {
  summary: RunTaskResult;
  contextUsed: number;
  providerId: string;
  modelName: string;
}

export class RuntimeOrchestratorError extends Error {
  readonly code: 'missing_provider';

  constructor(message: string) {
    super(message);
    this.code = 'missing_provider';
  }
}

export class RuntimeOrchestrator {
  private static warnedNoCheckpointService = false;
  private hostService: RuntimeHostService;
  private checkpointService?: RuntimeCheckpointService;
  private resolveProvider: RuntimeOrchestratorOptions['resolveProvider'];
  private actionLog?: ActionLogService;
  private getSideAgentConfig?: () => SideAgentConfig | undefined;
  private getTaskAgentRoute?: (mainModel?: string) => { providerId: string; modelName: string } | null;
  private persistSessionTitle?: (sessionId: string, title: string, meta?: SessionTitlePersistMeta) => void | Promise<void>;
  private listAlternateProviders?: RuntimeOrchestratorOptions['listAlternateProviders'];

  constructor(options: RuntimeOrchestratorOptions) {
    this.hostService = options.hostService;
    this.checkpointService = options.checkpointService;
    this.resolveProvider = options.resolveProvider;
    this.actionLog = options.actionLog;
    this.getSideAgentConfig = options.getSideAgentConfig;
    this.getTaskAgentRoute = options.getTaskAgentRoute;
    this.persistSessionTitle = options.persistSessionTitle;
    this.listAlternateProviders = options.listAlternateProviders;
  }

  async runSession(options: RuntimeOrchestratorRunOptions): Promise<RuntimeOrchestratorResult> {
    const {
      sessionId,
      prompt,
      metadata,
      startedAt = Date.now(),
      isAutoRouted,
      routeConfig,
      modelRouter,
      eventHub,
      abortSignal,
      buildHostConfig,
      onHostReady,
      onRuntimeEvent,
      onStatus,
      onRouteResolved,
    } = options;

    let providerId = options.providerId;
    let modelName = options.modelName;
    let resolvedRoute: ResolvedRoute | null = null;
    const runId = this.actionLog?.createRunId();

    if (this.actionLog) {
      const promptSummary = truncateForLog(prompt, MAX_SUMMARY_LENGTH);
      this.actionLog.record({
        type: 'run_start',
        sessionId,
        runId,
        actor: 'user',
        summary: promptSummary ? `User: ${promptSummary}` : 'User: (empty prompt)',
        data: {
          prompt: truncateForLog(prompt, MAX_DETAIL_LENGTH),
          promptLength: prompt.length,
          attachments: metadata?.attachments?.map(att => ({
            type: att.type,
            name: att.name,
            path: att.path,
          })),
        },
      });
    }

    if (isAutoRouted && routeConfig && modelRouter) {
      resolvedRoute = modelRouter.resolveProvider(routeConfig.modelAlias);
      appendDiagLog('ROUTE_RESOLVED', {
        alias: routeConfig.modelAlias,
        resolved: resolvedRoute ? { providerId: resolvedRoute.providerId, modelName: resolvedRoute.modelName, degraded: resolvedRoute.degraded ?? false } : null,
      });
      if (resolvedRoute) {
        providerId = resolvedRoute.providerId;
        modelName = resolvedRoute.modelName;
        onRouteResolved?.(resolvedRoute);
        if (resolvedRoute.degraded) {
          onStatus?.('warning', `Using degraded provider: ${providerId}`);
        }
      }
    }

    const finalMetadata = metadata;

    if (this.checkpointService) {
      try {
        /* 登记本轮的文件基线, 让同一时刻建的对话检查点能把它写进 fileCheckpointId ——
         * 这是"回滚一次, 对话和文件一起回到同一个时刻"的唯一连接点。 */
        const baseline = await this.checkpointService.startMessage(sessionId);
        setTurnFileBaseline(sessionId, baseline);
      } catch (error) {
        onStatus?.('warning', 'Checkpoint start failed');
      }
    } else if (!RuntimeOrchestrator.warnedNoCheckpointService) {
      /* 没传 checkpointService = 整套「拒绝改动后回滚文件」静默失效。这条只喊一次,
       * 但必须喊 —— 2026-08 就是因为这里静默, 快照断了 9 天没人发现。 */
      RuntimeOrchestrator.warnedNoCheckpointService = true;
      cliLogger.warn('CHECKPOINT', 'orchestrator 没有 checkpointService — 文件快照/回滚全程不可用');
    }
    let checkpointFinalized = false;

    try {
      const runAttempt = async (
        attemptProviderId: string | undefined,
        attemptModelName: string | undefined,
        attemptIndex: number,
      ): Promise<RuntimeOrchestratorResult> => {
        const resolved = this.resolveProvider(attemptProviderId, attemptModelName);
        if (!resolved.provider || !resolved.llmConfig) {
          throw new NeoxError({
            code: 'auth.login_required',
            category: ErrorCategory.FATAL_AUTH,
            retryable: false,
            message: 'No provider configured. Please add an API provider first.',
          });
        }

        onStatus?.('info', `Connecting to ${resolved.llmConfig.model}...`);
        if (this.actionLog) {
          this.actionLog.record({
            type: 'run_attempt',
            sessionId,
            runId,
            actor: 'system',
            summary: `Run: ${resolved.llmConfig.model}`,
            data: {
              providerId: resolved.provider.id,
              providerName: resolved.llmConfig.providerName,
              model: resolved.llmConfig.model,
              attempt: attemptIndex,
              isRetry: attemptIndex > 0,
            },
          });
        }

        const hostConfig = buildHostConfig(resolved.provider, resolved.llmConfig);
        /* 本次 attempt 里 provider 报的分类错误 —— runTask 不抛, 只把 error_classified
         * 事件流出来, 下面把它抬成异常时要靠这个决定是"立刻换下一家"还是"再试一次"。 */
        let lastClassified: { category?: string; code?: string; message?: string } | null = null;
        const tracker: RuntimeEventTracker = {
          contextUsed: 0,
          startTime: Date.now(),
          provider: resolved.llmConfig.providerName || resolved.provider.id || 'unknown',
          model: resolved.llmConfig.model,
        };

        const sessionRoute = {
          providerId: resolved.provider.id,
          modelName: resolved.llmConfig.model,
        };
        const sideAgentAdapter = createClaudeSideAgentAdapter({
          getSessionRoute: () => sessionRoute,
          getTaskAgentRoute: () => this.getTaskAgentRoute?.(sessionRoute.modelName) ?? null,
          getSideAgentConfig: () => this.getSideAgentConfig?.(),
          resolveProvider: this.resolveProvider,
          persistSessionTitle: this.persistSessionTitle,
        });

        const summary = await this.hostService.runTask({
          ...hostConfig,
          sideAgentAdapter,
          prompt,
          metadata: finalMetadata,
          abortSignal,
          onHostReady,
          onEvent: (event) => {
            if (event.type === 'error_classified') {
              lastClassified = {
                category: (event as any).category,
                code: (event as any).code,
                message: (event as any).message,
              };
            }
            if (event.type === 'tool_call_end') {
              cliLogger.info('ORCHESTRATOR', `🔥 onEvent received tool_call_end: name=${event.name} toolId=${event.toolId}`);
            }
            if (this.actionLog) {
              const entry = this.buildActionLogEntry(event, sessionId, runId);
              if (entry) {
                this.actionLog.record(entry);
              }
            }
            eventHub?.emit(sessionId, event, tracker);
            onRuntimeEvent?.(event, tracker);
          },
        });

        if (resolvedRoute && summary?.failed) {
          const c = lastClassified as { category?: string; code?: string; message?: string } | null;
          throw new NeoxError({
            code: c?.code || 'runtime.provider_failed',
            category: (c?.category as ErrorCategory) || ErrorCategory.RETRYABLE_STREAM,
            retryable: true,
            message: c?.message || `Provider ${resolved.provider.id} run failed`,
          });
        }

        return {
          summary,
          contextUsed: tracker.contextUsed,
          providerId: resolved.provider.id,
          modelName: resolved.llmConfig.model,
        };
      };

      const finalizeSuccess = async (result: RuntimeOrchestratorResult): Promise<RuntimeOrchestratorResult> => {
        if (resolvedRoute && result.providerId && modelRouter) {
          const latency = Date.now() - startedAt;
          modelRouter.recordSuccess(result.providerId, latency);
        }

        if (this.checkpointService) {
          try {
            await this.checkpointService.finishMessage(sessionId, 'Message completed');
            checkpointFinalized = true;
          } catch (error) {
            onStatus?.('warning', 'Checkpoint save failed');
          }
        }
        return result;
      };

      // 自动路由：同一 Provider 连续失败 2 次后切换下一家
      if (resolvedRoute && modelRouter && routeConfig?.autoFailover !== false) {
        const chain = [
          { providerId: resolvedRoute.providerId, modelName: resolvedRoute.modelName },
          ...resolvedRoute.fallbackChain.map(item => ({
            providerId: item.providerId,
            modelName: item.modelName,
          })),
        ];
        const maxFailuresBeforeSwitch = 2;
        let globalAttempt = 0;
        let lastError: unknown = null;

        const fatalCategoriesRouted = new Set<string>([
          ErrorCategory.FATAL_AUTH,
          ErrorCategory.FATAL_LIMIT,
        ]);
        for (let i = 0; i < chain.length; i++) {
          const candidate = chain[i];
          for (let failureCount = 0; failureCount < maxFailuresBeforeSwitch; failureCount++) {
            try {
              const attemptNo = globalAttempt++;
              const result = await withWatchdog(
                runAttempt(candidate.providerId, candidate.modelName, attemptNo),
                {
                  label: `runAttempt:${candidate.providerId}/${candidate.modelName}`,
                  warnAfterMs: RUN_ATTEMPT_WATCH_MS,
                  suppressWhen: () => runIsMakingProgress(sessionId),
                  tag: 'ORCHESTRATOR',
                  context: { sessionId, runId, attempt: attemptNo },
                },
              );
              return await finalizeSuccess(result);
            } catch (error) {
              lastError = error;
              const err = error instanceof Error ? error : new Error(String(error));
              const category = (error as any)?.category as string | undefined;
              const isFatalProviderError = !!category && fatalCategoriesRouted.has(category);
              modelRouter.recordFailure(candidate.providerId, err);
              if (isFatalProviderError) {
                /* 同 provider 重试无意义 — 立即跳到下一家 (跳出内 loop) */
                const next = chain[i + 1];
                if (next) {
                  onStatus?.('warning', `Provider ${candidate.providerId} ${category} — fast-fallback → ${next.providerId}`);
                  cliLogger.warn('ORCHESTRATOR', `Auto-route fast-fallback: ${candidate.providerId} ${category} → ${next.providerId}`);
                } else {
                  onStatus?.('error', `Provider ${candidate.providerId} ${category}; no more fallback providers`);
                }
                break;
              }
              const reachedSwitchThreshold = failureCount + 1 >= maxFailuresBeforeSwitch;
              if (!reachedSwitchThreshold) {
                onStatus?.('warning', `Provider ${candidate.providerId} failed, retrying... (${failureCount + 1}/${maxFailuresBeforeSwitch})`);
                continue;
              }
              const next = chain[i + 1];
              if (next) {
                onStatus?.('warning', `Auto switch provider: ${candidate.providerId} → ${next.providerId}`);
              }
            }
          }
        }
        throw (lastError instanceof Error ? lastError : new Error('All routed providers failed.'));
      }

      /* 手动选择 provider 路径 (非 auto-route). 在遇到 fatal_auth/fatal_limit 时,
       *   若上层配了 listAlternateProviders 就自动跳到备胎 provider 试同一 model.
       *   典型场景: 用户选的 anthropic-relay-b 余额耗尽 → 自动切 deepseek/relay-f,
       *   presenter 类长会话不再一次 balance 掉线整个上下文废掉.
       *
       *   fatal_auth/fatal_limit 是 provider 侧的确定性拒绝 (403/quota), 同 provider 重试无意义,
       *   直接跳下一家. 其它类别错误 (retryable_stream/network/rate_limit 等) 保留 runner 里
       *   已有的 stream-retry 逻辑, 不进这里的 fallback. */
      const fatalCategories = new Set<string>([
        ErrorCategory.FATAL_AUTH,
        ErrorCategory.FATAL_LIMIT,
      ]);
      const buildFallbackChain = (): Array<{ providerId?: string; modelName?: string }> => {
        const chain: Array<{ providerId?: string; modelName?: string }> = [
          { providerId, modelName },
        ];
        if (this.listAlternateProviders) {
          const alternates = this.listAlternateProviders(providerId, modelName);
          for (const alt of alternates) {
            if (!alt || !alt.providerId) continue;
            /* 排除自己 (调用方一般已排除, 二次防御) */
            if (alt.providerId === providerId && alt.modelName === modelName) continue;
            chain.push({ providerId: alt.providerId, modelName: alt.modelName });
          }
        }
        return chain;
      };

      const fallbackChain = buildFallbackChain();
      let lastError: unknown = null;
      for (let i = 0; i < fallbackChain.length; i++) {
        const candidate = fallbackChain[i];
        try {
          const result = await withWatchdog(
            runAttempt(candidate.providerId, candidate.modelName, i),
            {
              label: `runAttempt:${candidate.providerId ?? 'default'}/${candidate.modelName ?? 'default'}`,
              warnAfterMs: RUN_ATTEMPT_WATCH_MS,
              suppressWhen: () => runIsMakingProgress(sessionId),
              tag: 'ORCHESTRATOR',
              context: { sessionId, runId, attempt: i },
            },
          );
          if (i > 0) {
            onStatus?.('info', `Recovered on fallback provider: ${candidate.providerId}`);
          }
          return await finalizeSuccess(result);
        } catch (error) {
          lastError = error;
          const category = (error as any)?.category as string | undefined;
          const isFatalProviderError = category && fatalCategories.has(category);
          const hasNext = i + 1 < fallbackChain.length;
          if (!isFatalProviderError || !hasNext) {
            /* 非 fatal 或已用完备胎 — 保持原有语义抛出 */
            throw error;
          }
          const next = fallbackChain[i + 1];
          const errMsg = error instanceof Error ? error.message : String(error);
          onStatus?.('warning',
            `Provider ${candidate.providerId} ${category} (${errMsg}); switching to ${next.providerId}`);
          cliLogger.warn('ORCHESTRATOR', `Fatal ${category} on ${candidate.providerId}, fallback → ${next.providerId}: ${errMsg}`);
        }
      }
      /* 走到这里意味着 loop 里 throw 了但被外层 catch — 理论不该到. 兜底把 lastError 抛回. */
      throw (lastError instanceof Error ? lastError : new Error('All fallback providers failed.'));

    } catch (error) {
      if (this.actionLog) {
        const message = error instanceof Error ? error.message : String(error);
        this.actionLog.record({
          type: 'run_error',
          sessionId,
          runId,
          actor: 'system',
          summary: `Run error: ${truncateForLog(message, MAX_SUMMARY_LENGTH)}`,
          data: { message },
        });
      }
      throw error;
    } finally {
      if (this.checkpointService && !checkpointFinalized) {
        try {
          await this.checkpointService.stopWatching();
        } catch (error) {
          onStatus?.('warning', 'Checkpoint cleanup failed');
        }
      }
    }
  }

  private buildActionLogEntry(
    event: AgentRuntimeEvent,
    sessionId: string,
    runId?: string
  ): ActionLogEventInput | null {
    if (!this.actionLog) {
      return null;
    }

    const formatPath = (filePath: string) => this.actionLog?.formatFilePath(filePath) ?? filePath;

    switch (event.type) {
      case 'tool_call_start': {
        const targetPath = event.targetPath ? formatPath(event.targetPath) : undefined;
        const summary = targetPath
          ? `Tool start: ${event.name} (${targetPath})`
          : `Tool start: ${event.name}`;
        const argsPreview = event.args
          ? truncateForLog(JSON.stringify(event.args), MAX_DETAIL_LENGTH)
          : undefined;
        return {
          type: 'tool_call_start',
          sessionId,
          runId,
          actor: 'tool',
          summary,
          files: targetPath ? [targetPath] : undefined,
          data: {
            name: event.name,
            toolId: event.toolId,
            batchId: event.batchId,
            targetPath,
            description: event.description,
            equivalentCommand: event.equivalentCommand,
            argsPreview,
          },
        };
      }
      case 'tool_call_end': {
        const targetPath = event.targetPath ? formatPath(event.targetPath) : undefined;
        const summary = targetPath
          ? `Tool ${event.success ? 'done' : 'failed'}: ${event.name} (${targetPath})`
          : `Tool ${event.success ? 'done' : 'failed'}: ${event.name}`;
        const outputPreview = event.output
          ? truncateForLog(event.output, MAX_DETAIL_LENGTH)
          : undefined;
        return {
          type: 'tool_call_end',
          sessionId,
          runId,
          actor: 'tool',
          summary,
          files: targetPath ? [targetPath] : undefined,
          data: {
            name: event.name,
            success: event.success,
            duration: event.duration,
            resultLength: event.resultLength,
            summary: event.summary,
            outputPreview,
            outputTruncated: event.outputTruncated,
            toolId: event.toolId,
            batchId: event.batchId,
            targetPath,
          },
        };
      }
      case 'file_stream': {
        if (!event.isComplete) return null;
        const filePath = formatPath(event.filePath);
        const summary = event.additions || event.removals
          ? `File updated: ${filePath} (+${event.additions ?? 0}/-${event.removals ?? 0})`
          : `File updated: ${filePath}`;
        return {
          type: 'file_change',
          sessionId,
          runId,
          actor: 'tool',
          summary,
          files: [filePath],
          data: {
            filePath,
            additions: event.additions,
            removals: event.removals,
            description: event.description,
            contentLength: event.content?.length ?? 0,
          },
        };
      }
      case 'edit_file_stream': {
        if (!event.isComplete) return null;
        const filePath = formatPath(event.filePath);
        const summary = `File edited: ${filePath}`;
        return {
          type: 'file_change',
          sessionId,
          runId,
          actor: 'tool',
          summary,
          files: [filePath],
          data: {
            filePath,
            startLine: event.startLine,
            hunks: event.hunks?.length ?? 0,
            oldPreview: truncateForLog(event.oldString, 200),
            newPreview: truncateForLog(event.newString, 200),
            description: event.description,
          },
        };
      }
      case 'write_file_stream': {
        if (!event.isComplete) return null;
        const filePath = formatPath(event.filePath);
        const summary = `File written: ${filePath}`;
        return {
          type: 'file_change',
          sessionId,
          runId,
          actor: 'tool',
          summary,
          files: [filePath],
          data: {
            filePath,
            contentLength: event.content?.length ?? 0,
            description: event.description,
          },
        };
      }
      case 'checkpoint': {
        return {
          type: 'checkpoint',
          sessionId,
          runId,
          actor: 'system',
          summary: `Checkpoint saved: ${event.id}`,
          data: { id: event.id, auto: event.auto },
        };
      }
      case 'plan_update': {
        const total = event.plan.length;
        const completed = event.plan.filter(step => step.status === 'completed').length;
        const inProgress = event.plan.filter(step => step.status === 'in_progress').length;
        const pending = total - completed - inProgress;
        return {
          type: 'plan_update',
          sessionId,
          runId,
          actor: 'assistant',
          summary: `Plan update: ${completed} done, ${inProgress} active, ${pending} pending`,
          data: {
            explanation: event.explanation,
            plan: event.plan,
          },
        };
      }
      case 'context_compaction': {
        const status = (event as any).status || 'completed';
        const compression = (event as any).compression;
        const summaryText = status === 'compressing' && compression
          ? `Compressing: ${compression.completedBuckets}/${compression.totalBuckets} buckets (${compression.summaryModel})`
          : status === 'started'
            ? `Context compression started (${event.originalTokens} tokens)`
            : `Context compacted: ${event.originalTokens} -> ${event.finalTokens} tokens`;
        return {
          type: 'context_compaction',
          sessionId,
          runId,
          actor: 'system',
          summary: summaryText,
          data: {
            status,
            originalMessages: event.originalMessages,
            keptMessages: event.keptMessages,
            droppedMessages: event.droppedMessages,
            compressedMessages: event.compressedMessages,
            originalTokens: event.originalTokens,
            finalTokens: event.finalTokens,
            budgetTokens: event.budgetTokens,
            useLLM: event.useLLM,
            compression,
          },
        };
      }
      case 'stream_retry': {
        return {
          type: 'stream_retry',
          sessionId,
          runId,
          actor: 'system',
          summary: `Stream retry ${event.attempt}/${event.maxRetries}: ${event.errorCode}`,
          data: {
            error: event.error,
            errorCode: event.errorCode,
            attempt: event.attempt,
            maxRetries: event.maxRetries,
            delayMs: event.delayMs,
          },
        };
      }
      case 'stream_recovered': {
        return {
          type: 'stream_recovered',
          sessionId,
          runId,
          actor: 'system',
          summary: `Stream recovered (attempt ${event.attempt})`,
          data: {
            attempt: event.attempt,
            maxRetries: event.maxRetries,
          },
        };
      }
      case 'run_result': {
        const failed = !!event.failed;
        return {
          type: 'run_result',
          sessionId,
          runId,
          actor: 'assistant',
          summary: failed
            ? `Run failed in ${event.durationMs}ms, tokens ${event.totalTokens}`
            : `Run completed in ${event.durationMs}ms, tokens ${event.totalTokens}`,
          data: {
            outputPreview: truncateForLog(event.output, MAX_DETAIL_LENGTH),
            totalTokens: event.totalTokens,
            iterations: event.iterations,
            toolCalls: event.toolCalls,
            durationMs: event.durationMs,
            failed,
            /* 逐请求: 耗时 / 首字延迟 / 首字类型 / 工具耗时 —— 基准从 action log 直接读 */
            iterationPerf: event.iterationPerf,
          },
        };
      }
      case 'error': {
        return {
          type: 'run_error',
          sessionId,
          runId,
          actor: 'system',
          summary: `Runtime error: ${truncateForLog(event.message, MAX_SUMMARY_LENGTH)}`,
          data: { message: event.message },
        };
      }
      case 'error_classified': {
        return {
          type: 'run_error',
          sessionId,
          runId,
          actor: 'system',
          summary: `Error ${event.code}: ${truncateForLog(event.message, MAX_SUMMARY_LENGTH)}`,
          data: {
            category: event.category,
            code: event.code,
            message: event.message,
            suggestion: event.suggestion,
            retryable: event.retryable,
          },
        };
      }
      default:
        return null;
    }
  }
}
