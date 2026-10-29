import type { StreamEvent, SessionCacheUsage } from '../../shared/ipc';
import type { AgentRuntimeEvent } from '@neoxlabs/core/runtime/agentRuntimeHost.js';
import { normalizeContextBreakdown } from '@neoxlabs/kernel/utils/contextBreakdown.js';
import { tokenUsageService, type TokenUsageService } from '@neoxlabs/platform/platform/tokenUsageService.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { assistantLog } from '@neoxlabs/platform/platform/assistantLogger.js';
import { getGlobalCostTracker } from '@neoxlabs/platform/platform/costTracker.js';
import { getGlobalHealthTracker } from '@neoxlabs/platform/platform/providerHealthState.js';
import { onToolSummaryEvent } from '@neoxlabs/kernel/core/toolSummaryGenerator.js';
import type { ContextTokenBreakdown } from '@neoxlabs/kernel/utils/contextBreakdown.js';
import { writeStallFile } from '@neoxlabs/kernel/utils/stallGuard.js';
import { isNeoxCloudProvider } from '../../shared/neoxCloud.js';
import { lazyElectron } from '../lazyElectron.js';
import { flushTaskDirRenames } from './taskDirNaming.js';

/* electron 运行时取 —— 顶层静态 import 会让整个 bundle 在纯 Node 后端里加载失败。 */
const BrowserWindow = lazyElectron<typeof import('electron').BrowserWindow>('BrowserWindow');

export type RuntimeEventTracker = {
  contextUsed: number;
  startTime: number;
  provider: string;
  model: string;
  turnStartTime?: number;
  firstTokenTime?: number;
  lastTokenTime?: number;
};

type AskUserNeededRuntimeEvent = {
  type: 'ask_user_needed';
  requestId: string;
  questions: Array<{ question: string; options?: Array<{ label: string; description?: string }> }>;
  timestamp?: number;
  taskAgentId?: string;
};

type ApprovalNeededRuntimeEvent = {
  type: 'approval_needed';
  requestId: string;
  toolName: string;
  args?: Record<string, any>;
  reason?: string;
  allowRemember?: boolean;
  scopeKey?: string;
  risk?: Extract<StreamEvent, { type: 'approval_needed' }>['risk'];
  provenance?: Extract<StreamEvent, { type: 'approval_needed' }>['provenance'];
  timestamp?: number;
  taskAgentId?: string;
};

type ApprovalCancelledRuntimeEvent = {
  type: 'approval_cancelled';
  requestId: string;
  reason: 'resolved' | 'timeout' | 'manual_cancel' | 'session_aborted' | 'stale';
  approved?: boolean;
  timestamp?: number;
  taskAgentId?: string;
};

type WorkerStartRuntimeEvent = Extract<AgentRuntimeEvent, { type: 'worker_start' }> & {
  groupMembers?: NonNullable<Extract<StreamEvent, { type: 'worker_start' }>['groupMembers']>;
};

function normalizeToolArgs(value: any): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, any>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function resolveToolId(event: any): string | undefined {
  const candidate = event?.toolId || event?.id || event?.toolCallId;
  return typeof candidate === 'string' && candidate.trim() ? candidate : undefined;
}

function estimateOutputTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0) || 0;
    if ((code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3000 && code <= 0x303F) ||
      (code >= 0xFF00 && code <= 0xFFEF) ||
      (code >= 0xAC00 && code <= 0xD7AF)) {
      tokens += 0.67;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.floor(value));
}

function deriveContextByType(breakdown: ContextTokenBreakdown | any): Record<string, { count: number; tokens: number }> | undefined {
  if (!breakdown || typeof breakdown !== 'object') return undefined;
  const system = breakdown.systemTokens || 0;
  const messages = breakdown.messageTokens || breakdown.userTokens || 0;
  const tools = breakdown.toolTokens || ((breakdown.toolCallTokens || 0) + (breakdown.toolResultTokens || 0));
  const byType: Record<string, { count: number; tokens: number }> = {};
  if (system > 0) byType.system = { count: 1, tokens: system };
  if (messages > 0) byType.messages = { count: 1, tokens: messages };
  if (tools > 0) byType.tools = { count: 1, tokens: tools };
  return Object.keys(byType).length > 0 ? byType : undefined;
}

export class RuntimeEventForwarder {
  /** 已经报过"没有 case"的事件类型 — 每种只报一次, 见 forward() 的 default 分支。 */
  private static readonly unknownTypesSeen = new Set<string>();

  private emitStream: (event: StreamEvent) => void;
  private accumulatedTextBeforeToolCall: Map<string, string> = new Map();
  private eventSequenceCounters: Map<string, number> = new Map();
  // Incoming runtime sequence watermark. Do NOT mix this with synthetic UI sequence counters:
  // unsequenced/local events may be emitted before runtime sequence=1, and using one counter
  // made the first real status/tool/run_result look stale, leaving the desktop stuck running.
  private runtimeSequenceWatermarks: Map<string, number> = new Map();
  // 否则在 explore 等长耗时子代理跑的过程中, 大量子代理事件会把主 session 的计数器
  // 推得很高 (e.g. 主 session 自己才到 5, 子代理跑完后已经到 200), 当主 runner 第二轮
  // LLM 调用产出 text 事件时, sequence=6 会被 shouldDropStaleEvent 判定为 stale 而丢弃,
  // 导致 "GPT 用完 explore 就没有第二段话" 的现象.
  // 用 `${mainSessionId}::${taskAgentId}` 作为 key, 每个子代理一条独立计数链.
  private taskAgentSequenceCounters: Map<string, number> = new Map();
  private sessionSequenceResetHints: Map<string, number> = new Map();
  private streamingToolStats: Map<string, { name: string; totalChars: number; totalTokens: number }> = new Map();
  private streamingToolWarnings: Map<string, Set<string>> = new Map();
  /** 本轮压缩是否已经报过"开始" — 防止每条 compacting 都刷一条进行中事件 */
  private compactionAnnounced = new Set<string>();
  private latestBreakdownBySession: Map<string, ContextTokenBreakdown> = new Map();
  /* 会话累积用量(含子 agent)。内存累加, 首见时用 DB 历史做种子(BYOK 有历史,
   * NeoxCloud 托管跳过本地落库 → 种子为 0, 累积从 app 启动起算)。
   * 不随 resetSession 清: 累积语义跨轮存活, 重开 app 靠 DB 种子恢复(BYOK)。 */
  private sessionUsageTotals: Map<string, {
    requests: number;
    inputTokens: number;
    baseInputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    /* 每轮 request breakdown 逐字段求和 — "整个会话按类别烧了多少 token"
     * (每轮重发全量上下文, 求和 = 各类别真实处理总量, 口径与 inputTokens 一致) */
    breakdown?: Record<string, any>;
  }> = new Map();
  private tokenUsage?: TokenUsageService;

  constructor(options: { emitStream: (event: StreamEvent) => void; tokenUsage?: TokenUsageService }) {
    this.emitStream = options.emitStream;
    this.tokenUsage = options.tokenUsage;

    onToolSummaryEvent((evt) => {
      if (evt.type === 'summary_failed') {
        this.emitStream({
          type: 'warning',
          sessionId: '',
          message: `Tool summary failed: ${evt.toolName} (model ${evt.model} unavailable)`,
          timestamp: Date.now(),
        } as any);
      }
    });
  }

  resetSession(sessionId: string): void {
    this.accumulatedTextBeforeToolCall.set(sessionId, '');
    this.eventSequenceCounters.set(sessionId, 0);
    this.runtimeSequenceWatermarks.set(sessionId, 0);
    const prefix = `${sessionId}::`;
    for (const key of this.taskAgentSequenceCounters.keys()) {
      if (key.startsWith(prefix)) this.taskAgentSequenceCounters.delete(key);
    }
    this.sessionSequenceResetHints.delete(sessionId);
    this.streamingToolStats.delete(sessionId);
    this.streamingToolWarnings.delete(sessionId);
    this.latestBreakdownBySession.delete(sessionId);
  }

  /** 数值字段逐项求和(details 递归一层), 用于累加 request breakdown */
  private static sumBreakdownInto(target: Record<string, any> | undefined, delta: any): Record<string, any> | undefined {
    if (!delta || typeof delta !== 'object') return target;
    const out = target ?? {};
    for (const [key, value] of Object.entries(delta)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        out[key] = (out[key] || 0) + value;
      } else if (key === 'details' && value && typeof value === 'object') {
        out[key] = RuntimeEventForwarder.sumBreakdownInto(out[key], value);
      }
    }
    return out;
  }

  /** 累加一轮请求进会话累积用量, 返回快照(给 metrics.sessionUsage)。首见 session 用 DB 历史做种子。 */
  private accumulateSessionUsage(sessionId: string, delta: {
    baseInputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    breakdown?: ContextTokenBreakdown;
  }): SessionCacheUsage {
    let totals = this.sessionUsageTotals.get(sessionId);
    if (!totals) {
      totals = {
        requests: 0,
        inputTokens: 0,
        baseInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      };
      try {
        let seed: (SessionCacheUsage & { breakdown?: Record<string, any> }) | null = null;
        try {
          const summary = (this.tokenUsage ?? tokenUsageService).getSessionSummary(sessionId);
          if (summary && summary.requests > 0) seed = summary;
        } catch { /* DB SUM 不可用 → 只试快照 */ }
        try {
          const persisted = getDatabase().getSession(sessionId)?.sessionUsage as
            (SessionCacheUsage & { breakdown?: Record<string, any> }) | null | undefined;
          if (persisted && persisted.requests > (seed?.requests || 0)) seed = persisted;
        } catch { /* 快照不可用 → 保留 DB SUM 种子 */ }
        if (seed) {
          totals.requests = seed.requests;
          totals.inputTokens = seed.inputTokens;
          totals.baseInputTokens = seed.baseInputTokens;
          totals.cacheReadTokens = seed.cacheReadTokens;
          totals.cacheWriteTokens = seed.cacheWriteTokens;
          totals.outputTokens = seed.outputTokens || 0;
          if (seed.breakdown) {
            totals.breakdown = RuntimeEventForwarder.sumBreakdownInto(undefined, seed.breakdown);
          }
        }
      } catch { /* DB 不可用时从 0 起累, 不阻塞 usage 链路 */ }
      this.sessionUsageTotals.set(sessionId, totals);
    }
    totals.requests += 1;
    totals.baseInputTokens += Math.max(0, delta.baseInputTokens);
    totals.cacheReadTokens += Math.max(0, delta.cacheReadTokens);
    totals.cacheWriteTokens += Math.max(0, delta.cacheWriteTokens);
    totals.outputTokens += Math.max(0, delta.outputTokens);
    totals.inputTokens = totals.baseInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
    totals.breakdown = RuntimeEventForwarder.sumBreakdownInto(totals.breakdown, delta.breakdown);
    return {
      requests: totals.requests,
      inputTokens: totals.inputTokens,
      baseInputTokens: totals.baseInputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      outputTokens: totals.outputTokens,
      totalTokens: totals.inputTokens + totals.outputTokens,
      hitRate: totals.inputTokens > 0 ? totals.cacheReadTokens / totals.inputTokens : 0,
      /* 浅拷贝断引用 — totals.breakdown 每轮原地累加, 不能把可变对象直接交给下游 */
      breakdown: totals.breakdown
        ? { ...totals.breakdown, ...(totals.breakdown.details ? { details: { ...totals.breakdown.details } } : {}) } as any
        : undefined,
    };
  }

  markSessionSequenceResetHint(sessionId: string, ttlMs: number = 30_000): void {
    const expiresAt = Date.now() + Math.max(1_000, ttlMs);
    this.sessionSequenceResetHints.set(sessionId, expiresAt);
  }

  private getNextSequence(sessionId: string): number {
    const current = this.eventSequenceCounters.get(sessionId) || 0;
    const next = current + 1;
    this.eventSequenceCounters.set(sessionId, next);
    return next;
  }

  // 这里 +1 不会污染主 session 的 eventSequenceCounters
  private getNextTaskAgentSequence(sessionId: string, taskAgentId: string): number {
    const key = `${sessionId}::${taskAgentId}`;
    const current = this.taskAgentSequenceCounters.get(key) || 0;
    const next = current + 1;
    this.taskAgentSequenceCounters.set(key, next);
    return next;
  }

  private getEventSequence(sessionId: string, event: AgentRuntimeEvent): number {
    // 旧代码这里调 getNextSequence(sessionId) 会把主 session 的计数器顶上去,
    // 导致 explore 跑完后主 runner 的 text 事件 (sequence 还是 5/6/7...) 被
    // shouldDropStaleEvent 判定为 stale 直接丢弃, 用户看到的就是 "explore 完成 → GPT 没了".
    if (event.taskAgentId) {
      return this.getNextTaskAgentSequence(sessionId, event.taskAgentId);
    }
    const incoming = event.sequence;
    if (typeof incoming === 'number' && Number.isFinite(incoming)) {
      const current = this.eventSequenceCounters.get(sessionId) || 0;
      const runtimeWatermark = this.runtimeSequenceWatermarks.get(sessionId) || 0;
      if (incoming > runtimeWatermark) {
        this.runtimeSequenceWatermarks.set(sessionId, incoming);
      }
      if (incoming > current) {
        this.eventSequenceCounters.set(sessionId, incoming);
        return incoming;
      }
    }
    return this.getNextSequence(sessionId);
  }

  private shouldDropStaleEvent(sessionId: string, event: AgentRuntimeEvent): boolean {
    // 否则子代理的高 sequence 会污染计数器，导致主代理的后续事件被误判为 stale
    if (event.taskAgentId) {
      return false;
    }

    const incoming = event.sequence;
    if (typeof incoming !== 'number' || !Number.isFinite(incoming)) {
      return false;
    }
    // Compare only against the last *incoming runtime* sequence. The outgoing UI sequence
    // counter also advances for synthetic/unsequenced events (token deltas, local status,
    // multi-emits from one runtime event). Mixing the two was the root cause of hangs: a
    // synthetic event could set the counter to 1, then the runtime's first real status
    // with sequence=1 was dropped, and later terminal events could be lost too.
    const current = this.runtimeSequenceWatermarks.get(sessionId) || 0;
    if (incoming > current) {
      return false;
    }

    const resetHintExpiresAt = this.sessionSequenceResetHints.get(sessionId);
    if (resetHintExpiresAt && resetHintExpiresAt >= Date.now()) {
      const looksLikeSequenceReset = current >= 20 && incoming <= 10;
      if (!looksLikeSequenceReset) {
        return true;
      }
      this.sessionSequenceResetHints.delete(sessionId);
      // Keep getEventSequence() returning the original incoming sequence.
      this.runtimeSequenceWatermarks.set(sessionId, Math.max(0, incoming - 1));
      this.eventSequenceCounters.set(sessionId, Math.max(0, incoming - 1));
      assistantLog.warn(
        'FORWARDER',
        'accept stale runtime event as sequence reset',
        { sessionId, type: event.type, sequence: incoming, previousSequence: current },
      );
      return false;
    }

    if (resetHintExpiresAt && resetHintExpiresAt < Date.now()) {
      this.sessionSequenceResetHints.delete(sessionId);
    }

    return true;
  }

  private mapCompactingStatus(message: string, detail?: string): string | null {
    const normalizedDetail = detail?.toLowerCase() ?? '';
    if (message.includes('分析') || normalizedDetail.includes('analyzing')) {
      return '分析对话历史...';
    }
    if (message.includes('生成摘要') || message.includes('总结') || normalizedDetail.includes('summarizing')) {
      return '正在生成摘要...';
    }
    if (message.includes('保存') || normalizedDetail.includes('saving')) {
      return '保存压缩结果...';
    }
    /* 手动 /compact 没压的几种 (见 agentRuntimeHost: 正在压缩中 / 没有压缩 / 压缩暂停 / 未获收益 / 压缩失败)
     * 都要把进行中的卡片收掉, 不然它一直转圈; 真实原因随 detail 带过去 */
    if (/无需压缩|未获收益|没有压缩|压缩暂停|正在压缩中|压缩失败/.test(message) || normalizedDetail.includes('no compaction')) {
      return 'No compaction needed';
    }
    if (message.includes('压缩完成') || message.startsWith('✓')) {
      return 'Compaction complete';
    }
    if (
      message.includes('正在智能压缩') ||
      message.includes('正在自动压缩') ||
      normalizedDetail.includes('compacting')
    ) {
      return 'Auto-compacting history...';
    }
    return null;
  }

  private detectUsageFlavor(provider: string, model: string): 'anthropic' | 'openai' | 'generic' {
    const text = `${provider} ${model}`.toLowerCase();
    if (text.includes('anthropic') || text.includes('claude')) return 'anthropic';
    if (text.includes('openai') || text.includes('gpt') || text.includes('o1') || text.includes('o3') || text.includes('o4') || text.includes('kimi') || text.includes('doubao')) {
      return 'openai';
    }
    return 'generic';
  }

  forward(sessionId: string, event: AgentRuntimeEvent, tracker: RuntimeEventTracker): void {
    const taskAgentId = event.taskAgentId;
    const sourceLabel = event.sourceLabel;
    const _origEmit = this.emitStream;
    if (taskAgentId || sourceLabel) {
      this.emitStream = (e: StreamEvent) => _origEmit({
        ...e,
        ...(taskAgentId ? { taskAgentId } : null),
        ...(sourceLabel ? { sourceLabel } : null),
      });
    }
    try {
      /* session_title_changed 不在 AgentRuntimeEvent 类型里 (来自 server/main.ts 的
       * persistSessionTitle → bus.publish), 同 ask_user_needed 一样要在 switch 之前处理。
       * switch 里的 session_title_generated 是侧路 agent 直接 emit 的那一路, 两条都要接。 */
      if ((event as any).type === 'session_title_changed') {
        const t = typeof (event as any).title === 'string' ? (event as any).title.trim() : '';
        if (t) {
          this.emitStream({
            type: 'session_title_changed',
            sessionId,
            title: t,
            timestamp: (event as any).timestamp ?? Date.now(),
          } as any);
        }
        return;
      }

      if ((event as AskUserNeededRuntimeEvent).type === 'ask_user_needed') {
        const askUserEvent = event as AskUserNeededRuntimeEvent;
        this.emitStream({
          type: 'ask_user_needed',
          sessionId,
          requestId: askUserEvent.requestId,
          questions: askUserEvent.questions,
          timestamp: askUserEvent.timestamp ?? Date.now(),
        });
        return;
      }

      if ((event as ApprovalNeededRuntimeEvent).type === 'approval_needed') {
        const approvalEvent = event as ApprovalNeededRuntimeEvent;
        this.emitStream({
          type: 'approval_needed',
          sessionId,
          requestId: approvalEvent.requestId,
          toolName: approvalEvent.toolName,
          args: approvalEvent.args,
          reason: approvalEvent.reason,
          allowRemember: approvalEvent.allowRemember,
          scopeKey: approvalEvent.scopeKey,
          risk: approvalEvent.risk,
          provenance: approvalEvent.provenance,
          timestamp: approvalEvent.timestamp ?? Date.now(),
        });
        return;
      }

      if ((event as ApprovalCancelledRuntimeEvent).type === 'approval_cancelled') {
        const cancelledEvent = event as ApprovalCancelledRuntimeEvent;
        this.emitStream({
          type: 'approval_cancelled',
          sessionId,
          requestId: cancelledEvent.requestId,
          reason: cancelledEvent.reason,
          approved: cancelledEvent.approved,
          timestamp: cancelledEvent.timestamp ?? Date.now(),
        });
        return;
      }

      /* background_task 不在 AgentRuntimeEvent 类型里 (server 端 setBackgroundTaskCallback
         直接发的 bus event), 跟 ask_user_needed 同套先于 switch 处理 — 否则下面 switch
         没 case 会静默丢, 导致 BackgroundTasksBar 看不到任何任务. */
      if ((event as any)?.type === 'background_task') {
        const bgt = event as any;
        this.emitStream({
          ...bgt,
          type: 'background_task',
          sessionId,
          timestamp: bgt.timestamp ?? Date.now(),
        } as any);
        return;
      }

      if ((event as any)?.type === 'target_snapshot') {
        const snap = { ...(event as any) };
        delete snap.type;
        for (const w of BrowserWindow.getAllWindows()) {
          try {
            if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
            w.webContents.send('neox:target:snapshot', { ...snap, sessionId });
          } catch { /* 窗口正在关闭, 不影响其他窗口 */ }
        }
        return;
      }

      if ((event as any)?.type === 'sub_agent') {
        const sub = event as any;
        this.emitStream({
          type: 'sub_agent',
          sessionId,
          action: sub.action,
          agentId: sub.agentId,
          name: sub.name,
          description: sub.description,
          status: sub.status,
          elapsed: sub.elapsed,
          toolUseCount: sub.toolUseCount,
          timestamp: sub.timestamp ?? Date.now(),
        } as any);
        return;
      }
      /* sub_agent_session_created — server 创了 sub-agent 独立 session 时广播, renderer 据此
         重拉 sidebar list 立刻显出子节点. 同样必须早返, 否则 switch 吞掉. */
      if ((event as any)?.type === 'sub_agent_session_created') {
        const sas = event as any;
        this.emitStream({
          type: 'sub_agent_session_created',
          sessionId,
          parentSessionId: sas.parentSessionId,
          childSessionId: sas.childSessionId,
          timestamp: Date.now(),
        } as any);
        return;
      }
      if ((event as { type?: string })?.type === 'ask_user_expired') {
        const e = event as any;
        this.emitStream({
          type: 'ask_user_expired',
          sessionId,
          requestId: e.requestId ?? e.data?.requestId,
          timeoutSec: e.timeoutSec ?? e.data?.timeoutSec,
          /* 手写转发清单, 漏一个字段渲染端就永远收不到 (仓里为此翻过车) */
          reason: e.reason ?? e.data?.reason,
          timestamp: e.timestamp ?? Date.now(),
        } as any);
        return;
      }
      if ((event as { type?: string })?.type === 'ask_user_resolved') {
        const e = event as any;
        this.emitStream({
          type: 'ask_user_resolved',
          sessionId,
          requestId: e.requestId ?? e.data?.requestId,
          answers: e.answers ?? e.data?.answers,
          timestamp: e.timestamp ?? Date.now(),
        } as any);
        return;
      }

      if (typeof (event as any)?.type === 'string' && (event as any).type.startsWith('team_')) {
        this.emitStream({
          ...(event as any),
          sessionId,
          timestamp: (event as any).timestamp ?? Date.now(),
        } as any);
        return;
      }

      if (typeof (event as any)?.type === 'string' && (event as any).type.startsWith('research_')) {
        this.emitStream({
          ...(event as any),
          sessionId,
          timestamp: (event as any).timestamp ?? Date.now(),
        } as any);
        return;
      }

      /* tts_audio — server 端 chatEventPublisher 合成完音频后 bus.publish 进来, 不在
         AgentRuntimeEvent 类型里. 跟 sub_agent / background_task 同套必须早返透传, 否则下面
         switch 没 case 直接吞掉 → renderer 永远收不到音频, 「语音合成」设置形同虚设. */
      if ((event as any)?.type === 'tts_audio') {
        const tts = event as any;
        this.emitStream({
          type: 'tts_audio',
          sessionId,
          audio: tts.audio,
          audioFormat: tts.audioFormat,
          voiceSummary: tts.voiceSummary,
          durationMs: tts.durationMs ?? 0,
          timestamp: tts.timestamp ?? Date.now(),
        } as any);
        return;
      }
      if ((event as any)?.type === 'tts_audio_chunk') {
        const c = event as any;
        this.emitStream({
          type: 'tts_audio_chunk',
          sessionId,
          clipId: c.clipId,
          seq: c.seq,
          audio: c.audio,
          audioFormat: c.audioFormat,
          sampleRate: c.sampleRate,
          voiceSummary: c.voiceSummary,
          final: c.final,
          error: c.error,
          timestamp: c.timestamp ?? Date.now(),
        } as any);
        return;
      }

      if (this.shouldDropStaleEvent(sessionId, event)) {
        assistantLog.warn(
          'FORWARDER',
          'drop stale runtime event',
          { sessionId, type: event.type, sequence: event.sequence },
        );
        return;
      }

      /* 感知延迟打点 — 回合起点 (首个 thinking 状态) 与首/末可见输出时刻。
       * 中途工具间的 thinking 不会覆盖 (turnStartTime 已设); token_usage 落库后复位。 */
      {
        const evtType = (event as any).type;
        if (evtType === 'status' && (event as any).status === 'thinking' && tracker.turnStartTime == null) {
          tracker.turnStartTime = Date.now();
        } else if (evtType === 'token' || evtType === 'text' || evtType === 'reasoning') {
          const now = Date.now();
          if (tracker.turnStartTime == null) tracker.turnStartTime = now;
          if (tracker.firstTokenTime == null) tracker.firstTokenTime = now;
          tracker.lastTokenTime = now;
        }
      }

      if ((event as any).type === 'token') {
        const content = typeof (event as any).content === 'string'
          ? (event as any).content
          : typeof (event as any).delta === 'string'
            ? (event as any).delta
            : '';
        if (content) {
          this.emitStream({
            type: 'token',
            sessionId,
            content,
            timestamp: Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          const currentText = this.accumulatedTextBeforeToolCall.get(sessionId) || '';
          this.accumulatedTextBeforeToolCall.set(sessionId, currentText + content);
        }
        return;
      }

      if ((event as any).type === 'assistant_state_snapshot') {
        const startedAt = Date.now();
        this.emitStream({
          type: 'assistant_state_snapshot' as any,
          sessionId,
          snapshot: (event as any).snapshot,
          timestamp: (event as any).timestamp ?? Date.now(),
        } as any);
        assistantLog.timing('FORWARDER', 'assistant_state_snapshot', Date.now() - startedAt, `session=${sessionId}`);
        return;
      }

      if ((event as any).type === 'assistant_projection') {
        const startedAt = Date.now();
        this.emitStream({
          type: 'assistant_projection' as any,
          sessionId,
          projection: (event as any).projection,
          timestamp: (event as any).timestamp ?? Date.now(),
        } as any);
        assistantLog.timing('FORWARDER', 'assistant_projection', Date.now() - startedAt, `session=${sessionId}`);
        return;
      }

      if ((event as any).type === 'turn_complete') {
        this.emitStream({
          type: 'turn_complete' as any,
          sessionId,
          turnId: (event as any).turnId,
          output: (event as any).output,
          lane: (event as any).lane,
          missionId: (event as any).missionId,
          aborted: (event as any).aborted,
          timestamp: (event as any).timestamp ?? Date.now(),
          sequence: this.getEventSequence(sessionId, event),
        } as any);
        return;
      }


      // 补充转发 runtime 的兼容事件：session_status / worker_activity
      // Assistant 主链路已优先走 snapshot / projection，这里保留全局事件兼容层。
      if ((event as any).type === 'session_status') {
        this.emitStream({
          type: 'session_status' as any,
          sessionId,
          status: (event as any).status || (event as any).to || 'idle',
          queueDepth: (event as any).queueDepth,
          timestamp: (event as any).timestamp ?? Date.now(),
        } as any);
        return;
      }
      if ((event as any).type === 'worker_activity') {
        const actEv = event as any;
        this.emitStream({
          type: 'worker_activity' as any,
          sessionId,
          agentId: actEv.agentId,
          action: actEv.action,         // 'tool_start' | 'tool_complete' 等
          toolName: actEv.toolName,     // 工具名（用于 Worker Timeline 渲染）
          args: actEv.args,
          summary: actEv.summary,
          success: actEv.success,
          activity: actEv.activity,     // 旧字段兼容
          timestamp: actEv.timestamp ?? Date.now(),
        } as any);
        return;
      }

      const tag = (event as { type: string }).type;
      if (tag === 'user_message') {
        const e = event as any;
        this.emitStream({
          type: 'user_message',
          sessionId,
          text: e.text,
          messageId: e.messageId,
          source: e.source,
          seq: e.seq,
          turnId: e.turnId,
          timestamp: e.timestamp ?? Date.now(),
        } as any);
        return;
      }
      if (tag === 'run_state_changed') {
        const e = event as any;
        this.emitStream({
          type: 'run_state_changed',
          sessionId,
          status: e.status,
          turnId: e.turnId,
          lastCommittedSeq: e.lastCommittedSeq,
          pendingToolCalls: e.pendingToolCalls,
          initiatedBy: e.initiatedBy,
          pausedAt: e.pausedAt,
          updatedAt: e.updatedAt,
          heartbeat: e.heartbeat === true,
          emittedAt: e.emittedAt,
          timestamp: e.updatedAt ?? Date.now(),
        } as any);
        return;
      }

      switch (event.type) {
        case 'queued_message_added':
          this.emitStream({
            type: 'queued_message_added',
            sessionId,
            position: event.position,
            text: event.text,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          break;
        case 'queued_messages_processed':
          this.emitStream({
            type: 'queued_messages_processed',
            sessionId,
            count: event.count,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          break;
        case 'user_message_injected':
          /* 排队消息被处理那一刻 → 渲染进 timeline (没这条转发, 桌面永远看不到插入的消息) */
          this.emitStream({
            type: 'user_message_injected',
            sessionId,
            text: event.text,
            images: event.images,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          break;
        case 'queued_message_removed':
          this.emitStream({
            type: 'queued_message_removed',
            sessionId,
            remaining: event.remaining,
            text: event.text,
            images: event.images,
            reason: event.reason,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          break;
        case 'status':
          this.emitStream({
            type: 'status',
            sessionId,
            level: event.status === 'error'
              ? 'error'
              : event.status === 'warning'
                ? 'warning'
                : 'info',
            message: event.message,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          break;
        case 'log':
          this.emitStream({
            type: 'log',
            sessionId,
            level: event.level,
            message: event.message,
            detail: event.detail,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          break;
        case 'compacting': {
          if (!this.compactionAnnounced.has(sessionId)) {
            this.compactionAnnounced.add(sessionId);
            this.emitStream({
              type: 'raw_response_event',
              sessionId,
              data: {
                status: 'started',
                /* 开始时 runtime 不给 tokens, 用 tracker 当前占用兜底,
                 * 否则 renderer 的 detail 会算出 "NaNK tokens" */
                originalTokens: tracker.contextUsed,
              },
              event_type: 'context_compaction',
              timestamp: event.timestamp ?? Date.now(),
              sequence: this.getEventSequence(sessionId, event),
            });
          }
          const statusMessage = this.mapCompactingStatus(event.message, event.detail);
          if (statusMessage) {
            this.emitStream({
              type: 'status',
              sessionId,
              level: 'info',
              message: statusMessage,
              /* "没压"时带上宿主写的那句真实原因 (正在压缩中 / 摘要模型失败 …), 卡片照实显示 */
              ...(statusMessage === 'No compaction needed'
                ? { compactReason: [event.message, event.detail].filter(Boolean).join(' — ') }
                : {}),
              timestamp: event.timestamp ?? Date.now(),
              sequence: this.getEventSequence(sessionId, event),
            } as any);
          }
          break;
        }
        case 'text': {
          this.emitStream({
            type: 'token',
            sessionId,
            content: event.delta,
            timestamp: Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          const currentText = this.accumulatedTextBeforeToolCall.get(sessionId) || '';
          this.accumulatedTextBeforeToolCall.set(sessionId, currentText + event.delta);
          break;
        }
        case 'reasoning':
          // 思维链/思考内容 (如 doubao-seed 模型)
          this.emitStream({
            type: 'reasoning',
            sessionId,
            content: event.delta,
          });
          break;
        case 'thinking':
          this.emitStream({
            type: 'thinking',
            sessionId,
            iteration: event.iteration,
          });
          break;
        case 'tool_call_start': {
          const startedAt = Date.now();
          const toolId = resolveToolId(event);
          this.streamingToolStats.set(sessionId, { name: event.name, totalChars: 0, totalTokens: 0 });
          const prefixText = this.accumulatedTextBeforeToolCall.get(sessionId) || '';
          this.accumulatedTextBeforeToolCall.set(sessionId, '');

          this.emitStream({
            type: 'tool_call',
            sessionId,
            toolName: event.name,
            args: normalizeToolArgs((event as any).arguments ?? event.args),
            timestamp: event.timestamp,
            sequence: this.getEventSequence(sessionId, event),
            // Phase 1: 传递新增字段
            targetPath: event.targetPath,
            description: event.description,
            equivalentCommand: event.equivalentCommand,
            // Phase 3: 传递批量字段
            toolId,
            isBatch: event.isBatch,
            batchId: event.batchId,
            // Phase 4: 工具调用前的解释文字
            prefixText: prefixText.trim() || undefined,
          });
          break;
        }
        case 'tool_call_end':
          {
          const toolId = resolveToolId(event);
          this.streamingToolStats.delete(sessionId);
          this.streamingToolWarnings.delete(sessionId);
          this.emitStream({
            type: 'tool_result',
            sessionId,
            toolName: event.name,
            success: event.success,
            resultLength: event.resultLength || 0,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
            // Phase 1: 传递新增字段
            targetPath: event.targetPath,
            summary: event.summary,
            duration: event.duration,
            output: event.output,
            outputTruncated: event.outputTruncated,
            // Phase 3: 传递批量字段
            toolId,
            batchId: event.batchId,
            // 传递原始工具调用参数（用于 UI 展示 grep pattern 等）
            args: event.args,
            // 双轨道 —— 工具自声明的 UI meta (ToolResult.type/status/error/metadata).
            // 渲染器可以直接消费,不再需要 JSON.parse(event.output) 去猜结构.
            toolStatus: event.toolStatus,
            toolKind: event.toolKind,
            toolError: event.toolError,
            metadata: event.metadata,
            blockedBy: (event as { blockedBy?: string }).blockedBy,
            userNotice: (event as { userNotice?: string }).userNotice,
          });
          break;
          }
        case 'tool_call_delta': {
          if (event.name === 'query_agent') {
            this.emitStream({
              type: 'status',
              sessionId,
              level: 'info',
              message: 'Querying worker status...',
              timestamp: event.timestamp ?? Date.now(),
            });
          break;
          }
          const stats = this.streamingToolStats.get(sessionId);
          const deltaChars = event.argumentsDelta.length;
          const deltaTokens = estimateOutputTokens(event.argumentsDelta);
          const isFirstDelta = !stats || stats.name !== event.name;
          if (isFirstDelta) {
            this.streamingToolStats.set(sessionId, {
              name: event.name,
              totalChars: deltaChars,
              totalTokens: deltaTokens,
            });
            const toolId = resolveToolId(event);
            this.emitStream({
              type: 'tool_call_delta',
              sessionId,
              name: event.name,
              toolName: event.name,
              toolId,
              timestamp: event.timestamp ?? Date.now(),
              sequence: this.getEventSequence(sessionId, event),
            });
          } else {
            stats.totalChars += deltaChars;
            stats.totalTokens += deltaTokens;
          }
          this.emitStream({
            type: 'token',
            sessionId,
            content: event.argumentsDelta,
            source: 'tool_args',
            toolId: resolveToolId(event),
            toolName: event.name,
            timestamp: event.timestamp ?? Date.now(),
          } as any);
          const current = this.streamingToolStats.get(sessionId);
          if (current) {
            /* "Streaming: xxx (yy tokens)" status 是发给 placeholder 卡片更新 token 数用的.
             * 但 agent/explore/query_agent/ask_user/send_message/update_plan/open_surface*
             * 这些工具走独立 UI 通道 (AgentDelegation / ExploreCard / AskUserCard / SurfacePanel),
             * renderer 端 useStreamHandler 不给它们建占位卡 (skipPlaceholder). status 没卡可挂,
             * 会被 useStreamHandler 兜底建一张"流式: agent (828 tokens) ●●●" 孤儿卡, 中间空白
             * 看起来像挂了. 这里直接不发, 让独立 UI 通道自己管自己的进度展示. */
            const nameLower = (current.name || '').toLowerCase();
            const skipStatus =
              nameLower === 'agent'
              || nameLower === 'explore'
              || nameLower === 'query_agent'
              || nameLower === 'ask_user'
              || nameLower === 'send_message'
              || nameLower === 'update_plan'
              || /^(open_surface|update_)/.test(nameLower);
            if (!skipStatus) this.emitStream({
              type: 'status',
              sessionId,
              level: 'info',
              message: `Streaming: ${current.name} (${formatCompactTokens(current.totalTokens)} tokens)`,
              timestamp: event.timestamp ?? Date.now(),
            });

            const normalizedName = (current.name || '').toLowerCase();
            if (normalizedName === 'edit_file' || normalizedName === 'edit') {
              const warned = this.streamingToolWarnings.get(sessionId) || new Set<string>();
              if (!this.streamingToolWarnings.has(sessionId)) {
                this.streamingToolWarnings.set(sessionId, warned);
              }
              if (current.totalChars >= 6000 && !warned.has('edit_payload_large')) {
                warned.add('edit_payload_large');
                this.emitStream({
                  type: 'status',
                  sessionId,
                  level: 'warning',
                  message: 'edit 参数过大，建议拆分为多个小的行号编辑（start_line/end_line）。',
                  timestamp: event.timestamp ?? Date.now(),
                });
              }
            }
          }
          break;
        }
        case 'tool_output':
          {
          const toolId = resolveToolId(event);
          if (!event.success) {
            this.emitStream({
              type: 'tool_error',
              sessionId,
              toolName: event.name,
              error: event.output,
              // 让 renderer TimelineEntry 能精确判断 denied_by_user 等
              errorReason: (event as { errorReason?: 'denied_by_user' | 'denied_by_config' | 'denied_by_mode' | 'denied_by_hook' | 'tool_failure' | 'error' }).errorReason,
              toolId,
              timestamp: event.timestamp ?? Date.now(),
              sequence: this.getEventSequence(sessionId, event),
            });
          }
          break;
          }
        case 'file_stream':
          this.emitStream({
            type: 'file_stream',
            sessionId,
            filePath: event.filePath,
            content: event.content,
            isComplete: event.isComplete,
            language: event.language,
            additions: event.additions,
            removals: event.removals,
            description: event.description,
            sequence: this.getEventSequence(sessionId, event), // 添加序列号确保正确排序
            timestamp: event.timestamp || Date.now(),
          });
          break;
        case 'edit_file_stream':
          this.emitStream({
            type: 'edit_file_stream',
            sessionId,
            toolId: event.toolId,
            filePath: event.filePath,
            oldString: event.oldString,
            newString: event.newString,
            startLine: event.startLine,
            previewTruncated: event.previewTruncated,
            hunksOmitted: event.hunksOmitted,
            hunks: event.hunks,
            isComplete: event.isComplete,
            success: event.success,
            errorMessage: event.errorMessage,
            language: event.language,
            description: event.description,
            sequence: this.getEventSequence(sessionId, event),
            timestamp: event.timestamp || Date.now(),
          });
          break;
        case 'edit_file_stream_preview':
          console.log('[EDIT_STREAM][forwarder-direct]', {
            toolId: event.toolId,
            phase: event.phase,
            newLen: typeof event.newStringPartial === 'string' ? event.newStringPartial.length : undefined,
            oldLen: typeof event.oldContent === 'string' ? event.oldContent.length : undefined,
          });
          this.emitStream({
            type: 'edit_file_stream_preview',
            sessionId,
            toolId: event.toolId,
            filePath: event.filePath,
            phase: event.phase,
            startLine: event.startLine,
            endLine: event.endLine,
            oldContent: event.oldContent,
            newStringPartial: event.newStringPartial,
            language: event.language,
            sequence: this.getEventSequence(sessionId, event),
            timestamp: event.timestamp || Date.now(),
          });
          break;
        case 'write_file_stream':
          this.emitStream({
            type: 'write_file_stream',
            sessionId,
            filePath: event.filePath,
            content: event.content,
            isComplete: event.isComplete,
            language: event.language,
            description: event.description,
            sequence: this.getEventSequence(sessionId, event),
            timestamp: event.timestamp || Date.now(),
          });
          break;
        case 'agent_wrote_path':
          /* WriteLedger: 主进程 Normalizer 记账后同步到 renderer（进程隔离单例不共享） */
          this.emitStream({
            type: 'agent_wrote_path',
            sessionId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            op: event.op,
            paths: event.paths,
            from: event.from,
            evidence: event.evidence,
            timestamp: event.timestamp || Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          break;
        // 双轨道补齐 —— shell 命令执行期间的实时 output 流.CLI 已在
        // 用户看到 shell 卡片只显示最终结果、没有实时输出反馈.
        // executeShellWorker.ts:252 每 500ms 发一次 shell_output_stream,
        // 这里转发到渲染器, 渲染器更新 timeline entry 的 output.
        case 'shell_output_stream':
          this.emitStream({
            type: 'shell_output_stream',
            sessionId,
            toolId: event.toolId,
            command: event.command,
            output: event.output,
            outputDelta: event.outputDelta,
            elapsed: event.elapsed,
            isComplete: event.isComplete,
            exitCode: event.exitCode,
            /* shell_started 这条 event delta='' 但带 pid — 是 helper daemon 告诉 UI
             * "PTY 已起来, pid 是 N". 漏了 pid 字段会导致 renderer commandPid 永远空,
             * 进而 timeline shell 卡片头部的 stop ■ 按钮和 xterm 双向 PTY 接通都拿不到 pid. */
            pid: event.pid,
            sequence: this.getEventSequence(sessionId, event),
            timestamp: event.timestamp || Date.now(),
          });
          break;
        case 'token_usage': {
          const contextInputTokens = event.contextTokens || event.promptTokens || 0;
          /* explore/侧路子 agent(常配 haiku)的 usage 绝不能刷主表盘/Request Cache —
           * 否则主模型(opus)的上下文用量和缓存命中率被子 agent 小请求反复覆盖,
           * 面板"一会显示一会消失"。识别: taskAgentId(镜像事件) 或 runtimeSessionId
           * 以 agent_ 开头(子 agent host 自报)。成本/健康记账不受影响(下方照常执行,
           * 子 agent tokens 是真实计费)。 */
          const isSideAgentUsage = !!(event as any).taskAgentId
            || (typeof (event as any).runtimeSessionId === 'string'
                && (event as any).runtimeSessionId.startsWith('agent_'));
          if (!isSideAgentUsage) {
            tracker.contextUsed = contextInputTokens;
          }
          const billableInputTokens = event.promptTokens || 0;
          const outputTokens = event.completionTokens || 0;
          const cacheReadTokens = event.cacheReadTokens || 0;
          const cacheWriteTokens = event.cacheWriteTokens || 0;
          const effectiveContextUsed = Math.max(tracker.contextUsed || 0, contextInputTokens);

          /* 累积用量: 主 agent + 子 agent 都计入(子 agent tokens 是真实计费/真实缓存流量)。
           * 本轮表盘(下方 metrics 主事件)仍只反映主 agent, 语义分开。 */
          const sessionUsage = this.accumulateSessionUsage(sessionId, {
            baseInputTokens: billableInputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            outputTokens,
            breakdown: event.breakdown,
          });

          const firstTokenMs = tracker.turnStartTime != null && tracker.firstTokenTime != null
            ? Math.max(0, tracker.firstTokenTime - tracker.turnStartTime)
            : undefined;
          const generationMs = tracker.firstTokenTime != null && tracker.lastTokenTime != null
            && tracker.lastTokenTime > tracker.firstTokenTime
            ? tracker.lastTokenTime - tracker.firstTokenTime
            : undefined;
          if (!isSideAgentUsage) {
            if (event.breakdown) {
              this.latestBreakdownBySession.set(sessionId, event.breakdown);
            }

            this.emitStream({
              type: 'metrics',
              sessionId,
              model: (event as any).model,
              tokens: event.totalTokens,
              contextUsed: effectiveContextUsed,
              inputTokens: contextInputTokens,
              billableInputTokens,
              outputTokens,
              cacheReadTokens,
              cacheWriteTokens,
              breakdown: event.breakdown || this.latestBreakdownBySession.get(sessionId),
              sessionUsage,
              generationMs,
              firstTokenMs,
              /* audit §4: 本地估算兜底的 usage 带标记透传 (renderer 不感知也无害)。
               * as any: 字段在 neox-core src 已定义, dist d.ts 待重建 — 同 taskAgentId 手法 */
              ...((event as any).usageEstimated ? { usageEstimated: true } : {}),
            });
            writeStallFile('info', 'FWD_METRICS', 'forwarder emitted metrics', {
              sessionId, contextUsed: effectiveContextUsed, contextTokensIn: event.contextTokens,
              totalTokens: event.totalTokens, hasBreakdown: !!event.breakdown,
            });
          } else {
            /* 子 agent 请求也要刷新累积视图(popup 可能开着看 explore 跑),
             * 但绝不能带本轮字段去覆盖主表盘 — sessionUsageOnly 让 renderer 只取累积。 */
            this.emitStream({
              type: 'metrics',
              sessionId,
              tokens: 0,
              contextUsed: 0,
              sessionUsage,
              sessionUsageOnly: true,
            });
          }
          const duration = Date.now() - tracker.startTime;
          tracker.turnStartTime = undefined;
          tracker.firstTokenTime = undefined;
          tracker.lastTokenTime = undefined;
          /* NeoxCloud 模式 → 跳过本地累积 + 费用估算.
           *
           *   token 真实计费源在网关 (control-plane usage_events 表), 客户端通过
           *   /api/v1/usage/summary 拉聚合数据展示 (见 cloudUsageStore.ts).
           *   这里再写本地 SQLite 会跟云端口径双源 — provider 字段固定是 NEOX_CLOUD_PROVIDER_ID,
           *   单价/缓存拆分都不准, costTracker 估算也按本地 pricing 跑出垃圾数据. */
          const isCloudManaged = isNeoxCloudProvider(tracker.provider);
          if (!isCloudManaged) {
            const usageService = this.tokenUsage ?? tokenUsageService;
            const usageFlavor = this.detectUsageFlavor(tracker.provider, tracker.model);
            usageService.recordUsage({
              timestamp: Date.now(),
              provider: tracker.provider,
              model: tracker.model,
              inputTokens: contextInputTokens,
              billableInputTokens,
              outputTokens,
              totalTokens: event.totalTokens || 0,
              cachedTokens: cacheReadTokens,
              cacheReadTokens,
              cacheWriteTokens,
              openaiCachedTokens: usageFlavor === 'openai' ? cacheReadTokens : 0,
              anthropicCacheReadTokens: usageFlavor === 'anthropic' ? cacheReadTokens : 0,
              anthropicCacheCreationTokens: usageFlavor === 'anthropic' ? cacheWriteTokens : 0,
              duration,
              firstTokenMs,
              generationMs,
              success: true,
              sessionId,
            }).catch(err => {
              // console.warn('[RuntimeEventForwarder] Failed to record token usage:', err.message);
            });

            getGlobalCostTracker().recordRequest({
              model: tracker.model,
              provider: tracker.provider,
              inputTokens: contextInputTokens,
              outputTokens,
              cachedTokens: cacheReadTokens,
              cacheCreationTokens: cacheWriteTokens,
            });
          }

          getGlobalHealthTracker().recordSuccess(tracker.provider);

          const costSnapshot = getGlobalCostTracker().getSnapshot();
          if (costSnapshot.totalCostUsd > 0) {
            this.emitStream({
              type: 'cost_update',
              sessionId,
              totalCostUsd: costSnapshot.totalCostUsd,
              cacheSavingsUsd: costSnapshot.cacheSavingsUsd,
              requestCount: costSnapshot.requestCount,
              timestamp: Date.now(),
            } as any);
          }
          break;
        }
        case 'memory_snapshot':
          this.emitStream({
            type: 'memory',
            sessionId,
            tokensUsed: event.snapshot.tokensUsed,
            contextWindow: event.snapshot.profile.contextWindow,
            state: event.snapshot.state,
            pressure: event.snapshot.pressure,
            byType: deriveContextByType(event.breakdown),
            breakdown: event.breakdown,
          });
          break;
        case 'checkpoint':
          this.emitStream({
            type: 'checkpoint',
            sessionId,
            checkpointId: event.id,
            auto: event.auto,
            timestamp: event.timestamp ?? Date.now(),
          });
          this.emitStream({
            type: 'status',
            sessionId,
            level: 'info',
            message: event.auto ? 'Auto checkpoint created' : 'Checkpoint saved',
          });
          break;
        case 'run_result':
          /* 这一轮结束了, 工作目录不再被 runtime 持有 → 现在改名安全 (work:Q-12) */
          flushTaskDirRenames(sessionId);
          this.emitStream({
            type: 'run_result',
            sessionId,
            iterations: event.iterations,
            toolCalls: event.toolCalls,
            durationMs: event.durationMs,
            totalTokens: event.totalTokens,
            contextUsed: tracker.contextUsed,
            failed: (event as any).failed,
            interrupted: (event as any).interrupted,
            interruptReason: (event as any).interruptReason,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          } as any);
          break;
        case 'context_compaction': {
          let cardOriginal = event.originalTokens;
          let cardFinal = event.finalTokens;
          if (
            event.status === 'completed'
            && !(event as any).tokensIncludeOverhead
            && typeof event.finalTokens === 'number' && event.finalTokens > 0
          ) {
            const overhead = this.latestBreakdownBySession.get(sessionId)?.details?.toolDefinitionsTokens ?? 0;
            cardFinal = event.finalTokens + Math.max(0, overhead);
            cardOriginal = Math.max(
              (event.originalTokens ?? 0) + Math.max(0, overhead),
              tracker?.contextUsed ?? 0,
            );
          }
          this.emitStream({
            type: 'raw_response_event',
            sessionId,
            data: {
              status: event.status,
              originalMessages: event.originalMessages,
              keptMessages: event.keptMessages,
              droppedMessages: event.droppedMessages,
              compressedMessages: event.compressedMessages,
              originalTokens: cardOriginal,
              finalTokens: cardFinal,
              budgetTokens: event.budgetTokens,
              useLLM: event.useLLM,
              compression: (event as any).compression,
            },
            event_type: 'context_compaction',
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          /* 本轮压缩收口 (成功/放弃都算) — 下次 compacting 可以再报一次"开始".
           * 类型上这里只可能是 started/compressing/completed, 用 !== 判收口最稳。 */
          if (event.status !== 'started' && event.status !== 'compressing') {
            this.compactionAnnounced.delete(sessionId);
          }
          if (event.status === 'completed' && typeof cardFinal === 'number' && cardFinal > 0) {
            const staleBreakdown = this.latestBreakdownBySession.get(sessionId);
            const usedAfterCompaction = cardFinal;
            tracker.contextUsed = usedAfterCompaction;
            this.emitStream({
              type: 'metrics',
              sessionId,
              tokens: usedAfterCompaction,
              contextUsed: usedAfterCompaction,
              inputTokens: usedAfterCompaction,
              breakdown: normalizeContextBreakdown(staleBreakdown, usedAfterCompaction),
              compacted: true,
            } as StreamEvent);
          }
          break;
        }
        case 'plan_update':
          this.emitStream({
            type: 'plan_update',
            sessionId,
            explanation: event.explanation,
            plan: event.plan,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          break;
        case 'text_complete':
          this.emitStream({
            type: 'text_complete',
            sessionId,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          break;
        case 'reasoning_complete':
          this.emitStream({
            type: 'reasoning_complete',
            sessionId,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          break;
        case 'error':
          this.emitStream({
            type: 'error',
            sessionId,
            error: event.message,
            code: (event as { code?: string }).code,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          if (tracker?.provider) {
            getGlobalHealthTracker().recordError(tracker.provider, event.message?.substring(0, 80) || 'unknown');
          }
          break;
        case 'stream_retry':
          this.emitStream({
            type: 'stream_retry',
            sessionId,
            error: event.error,
            errorCode: event.errorCode,
            attempt: event.attempt,
            maxRetries: event.maxRetries,
            delayMs: event.delayMs,
            isRateLimit: event.isRateLimit,
            isStreamTimeout: event.isStreamTimeout,
            isNetworkError: event.isNetworkError,
            discardedText: event.discardedText,
            discardPartialToolCalls: event.discardPartialToolCalls,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          break;
        case 'stream_recovered':
          this.emitStream({
            type: 'stream_recovered',
            sessionId,
            attempt: event.attempt,
            maxRetries: event.maxRetries,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          break;
        case 'error_classified':
          this.emitStream({
            type: 'error_classified',
            sessionId,
            category: event.category,
            code: event.code,
            message: event.message,
            suggestion: event.suggestion,
            retryable: event.retryable,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          break;
        case 'raw_response_event':
          if (event.event_type === 'context_compaction') {
            this.emitStream({
              type: 'raw_response_event',
              sessionId,
              data: event.data,
              event_type: event.event_type,
              timestamp: Date.now(),
              sequence: this.getEventSequence(sessionId, event),
            });
          } else {
            this.emitStream({
              type: 'raw_response_event',
              sessionId,
              data: event.data,
              event_type: event.event_type,
            });
          }
          break;
        // ==================== 协作模式事件转发 ====================
        case 'worker_start':
          {
          const workerStartEvent = event as WorkerStartRuntimeEvent;
          /* as StreamEvent: isAgentTool 刚加进 @neoxlabs/platform 的 StreamEvent 定义,
           * 但 tsc 解析的是该包已构建的 dist .d.ts —— 断言避免为一个纯类型字段去重建
           * 依赖包 (会动到别的进程正在懒加载的 dist 文件)。下次正常 build 后即自然类型安全。 */
          this.emitStream({
            type: 'worker_start',
            sessionId,
            agentId: event.agentId,
            task: event.task,
            model: event.model,
            role: event.role,
            roleName: event.roleName,
            workerRole: workerStartEvent.workerRole,
            isBackground: workerStartEvent.isBackground,
            isAgentTool: (workerStartEvent as unknown as { isAgentTool?: boolean }).isAgentTool === true,
            modelInherited: (workerStartEvent as unknown as { modelInherited?: boolean }).modelInherited,
            groupMembers: workerStartEvent.groupMembers,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          } as StreamEvent);
          break;
          }
        case 'worker_event':
          {
            const workerEvent = event as any;
            const innerEvent = workerEvent.event || event.data || {};
            const innerType = innerEvent.type || workerEvent.eventType || '';

            // 这样 UI 监听 'edit_file_stream'/'write_file_stream' 就能直接收到，不需要从 worker_event 里解包
            if (workerEvent.agentId === 'Main') {
              if (innerType === 'edit_file_stream') {
                this.emitStream({
                  type: 'edit_file_stream',
                  sessionId,
                  toolId: innerEvent.toolId,
                  filePath: innerEvent.filePath,
                  oldString: innerEvent.oldString,
                  newString: innerEvent.newString,
                  startLine: innerEvent.startLine,
                  previewTruncated: innerEvent.previewTruncated,
                  hunksOmitted: innerEvent.hunksOmitted,
                  hunks: innerEvent.hunks,
                  isComplete: innerEvent.isComplete,
                  success: innerEvent.success,
                  errorMessage: innerEvent.errorMessage,
                  language: innerEvent.language,
                  timestamp: innerEvent.timestamp ?? Date.now(),
                  sequence: this.getEventSequence(sessionId, event),
                } as any);
                // edit_file_stream 同时仍然作为 worker_event 转发（UI 的 worker_event handler 会忽略它）
              } else if (innerType === 'file_stream') {
                // 否则 assistant 模式下 tool_call_delta 产生的 file_stream 不会创建流式预览卡片
                this.emitStream({
                  type: 'file_stream',
                  sessionId,
                  filePath: innerEvent.filePath,
                  content: innerEvent.content,
                  isComplete: innerEvent.isComplete,
                  language: innerEvent.language,
                  description: innerEvent.description,
                  additions: innerEvent.additions,
                  removals: innerEvent.removals,
                  timestamp: innerEvent.timestamp ?? Date.now(),
                  sequence: this.getEventSequence(sessionId, event),
                } as any);
              } else if (innerType === 'write_file_stream') {
                this.emitStream({
                  type: 'write_file_stream',
                  sessionId,
                  filePath: innerEvent.filePath,
                  content: innerEvent.content,
                  isComplete: innerEvent.isComplete,
                  language: innerEvent.language,
                  description: innerEvent.description,
                  additions: innerEvent.additions,
                  removals: innerEvent.removals,
                  timestamp: innerEvent.timestamp ?? Date.now(),
                  sequence: this.getEventSequence(sessionId, event),
                } as any);
              } else if (innerType === 'edit_file_stream_preview') {
                console.log('[EDIT_STREAM][forwarder-worker]', {
                  toolId: innerEvent.toolId,
                  phase: innerEvent.phase,
                });
                this.emitStream({
                  type: 'edit_file_stream_preview',
                  sessionId,
                  toolId: innerEvent.toolId,
                  filePath: innerEvent.filePath,
                  phase: innerEvent.phase,
                  startLine: innerEvent.startLine,
                  endLine: innerEvent.endLine,
                  oldContent: innerEvent.oldContent,
                  newStringPartial: innerEvent.newStringPartial,
                  language: innerEvent.language,
                  timestamp: innerEvent.timestamp ?? Date.now(),
                  sequence: this.getEventSequence(sessionId, event),
                } as any);
              } else if (innerType === 'plan_update' && Array.isArray(innerEvent.plan)) {
                this.emitStream({
                  type: 'plan_update',
                  sessionId,
                  explanation: innerEvent.explanation,
                  plan: innerEvent.plan,
                  timestamp: innerEvent.timestamp ?? Date.now(),
                  sequence: this.getEventSequence(sessionId, event),
                } as any);
              } else if (innerType === 'memory_snapshot' && innerEvent.snapshot) {
                this.emitStream({
                  type: 'memory',
                  sessionId,
                  tokensUsed: innerEvent.snapshot.tokensUsed,
                  contextWindow: innerEvent.snapshot.profile?.contextWindow,
                  state: innerEvent.snapshot.state,
                  pressure: innerEvent.snapshot.pressure,
                  byType: deriveContextByType(innerEvent.breakdown),
                  breakdown: innerEvent.breakdown,
                } as any);
              } else if (innerType === 'token_usage' && innerEvent.usage) {
                const usage = innerEvent.usage;
                const promptTokens = usage.prompt_tokens || usage.promptTokens || 0;
                const completionTokens = usage.completion_tokens || usage.completionTokens || 0;
                const totalTokens = usage.total_tokens || usage.totalTokens || (promptTokens + completionTokens);
                const cacheReadTokens = usage.cache_read_input_tokens || usage.cacheReadTokens || usage.cached_tokens || 0;
                const cacheWriteTokens = usage.cache_creation_input_tokens || usage.cacheWriteTokens || 0;
                this.emitStream({
                  type: 'metrics',
                  sessionId,
                  tokens: totalTokens,
                  inputTokens: promptTokens,
                  outputTokens: completionTokens,
                  totalTokens,
                  cacheReadTokens,
                  cacheWriteTokens,
                  contextUsed: usage.contextTokens || promptTokens,
                  timestamp: innerEvent.timestamp ?? Date.now(),
                } as any);
              }
            }

            // 所有 worker_event 都正常转发（UI worker_event handler 处理 text/text_complete 等）
            this.emitStream({
              type: 'worker_event',
              sessionId,
              agentId: event.agentId,
              eventType: innerType,
              data: innerEvent,
              workerRole: (event as any).workerRole,
              toolName: (event as any).toolName,
              toolArgs: (event as any).toolArgs,
              timestamp: event.timestamp ?? Date.now(),
              sequence: this.getEventSequence(sessionId, event),
            });
          break;
          }

        case 'worker_complete':
          this.emitStream({
            type: 'worker_complete',
            sessionId,
            agentId: event.agentId,
            success: event.success,
            summary: event.summary,
            error: event.error,
            duration: event.duration,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          break;
        case 'worker_result':
          this.emitStream({
            type: 'worker_result' as any,
            sessionId,
            agentId: event.agentId,
            success: event.success,
            output: event.output,
            direct: event.direct,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          } as any);
          break;
        case 'dag_created':
          this.emitStream({
            type: 'dag_created',
            sessionId,
            dagId: event.dagId,
            nodeCount: event.nodeCount,
            description: event.description,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          break;
        case 'dag_node_started':
          this.emitStream({
            type: 'dag_node_started',
            sessionId,
            dagId: event.dagId,
            nodeId: event.nodeId,
            nodeName: event.nodeName,
            agentId: event.agentId,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          break;
        case 'dag_node_completed':
          this.emitStream({
            type: 'dag_node_completed',
            sessionId,
            dagId: event.dagId,
            nodeId: event.nodeId,
            nodeName: event.nodeName,
            success: event.success,
            output: event.output,
            duration: event.duration,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          break;
        case 'dag_completed':
          this.emitStream({
            type: 'dag_completed',
            sessionId,
            dagId: event.dagId,
            success: event.success,
            totalNodes: event.totalNodes,
            completedNodes: event.completedNodes,
            failedNodes: event.failedNodes,
            duration: event.duration,
            timestamp: event.timestamp ?? Date.now(),
            sequence: this.getEventSequence(sessionId, event),
          });
          break;

        case 'session_title_generated': {
          const title = typeof (event as any).title === 'string' ? (event as any).title.trim() : '';
          if (title) {
            /* 不改任务文件夹名, 见上面 session_title_changed 那条 */
            this.emitStream({
              type: 'session_title_changed',
              sessionId,
              title,
              timestamp: (event as any).timestamp ?? Date.now(),
            } as any);
          }
          break;
        }

        case 'session_resumed':
          this.emitStream({
            type: 'session_resumed',
            sessionId,
            repairedToolCalls: event.repairedToolCalls ?? 0,
            droppedPartialMessages: event.droppedPartialMessages ?? 0,
            timestamp: event.timestamp ?? Date.now(),
          } as any);
          break;

        case 'session_resume_failed':
          this.emitStream({
            type: 'session_resume_failed',
            sessionId,
            reason: event.reason ?? '未知原因',
            timestamp: event.timestamp ?? Date.now(),
          } as any);
          break;

        /* user_message / run_state_changed 已在 switch 上方 type-guard 处理. */

        default: {
          const t = String((event as any)?.type ?? 'unknown');
          if (!RuntimeEventForwarder.unknownTypesSeen.has(t)) {
            RuntimeEventForwarder.unknownTypesSeen.add(t);
            console.warn(`[RuntimeEventForwarder] 运行时事件 "${t}" 没有对应 case, 不会到达界面 —— 新增事件类型要在这里补一条`);
          }
          break;
        }
      }
    } finally {
      if (taskAgentId || sourceLabel) {
        this.emitStream = _origEmit;
      }
    }
  }
}
