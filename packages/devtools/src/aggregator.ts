/**
 * MonitorAggregator —— 把零散的 agent runtime 事件滚成 MonitorState。
 *
 * 覆盖三类监控:
 *   · 效率: token 明细/缓存命中、工具成功率、平均迭代耗时、思考/工具时间占比、重复调用
 *   · 逻辑路径: plan_update 计划、工具调用序列、worker/dag 多agent 路径(path trace)
 *   · 风控: 高危工具(approval_needed.risk)、破坏性操作、工具错误、分类错误、限流、ask_user
 *
 * 性能铁律:record(event) 热路径只做 O(1) 更新;派生率(成功率/命中率/分位)在 snapshot() 冷路径算。
 */

import type {
  AgentNode,
  MonitorAlert,
  MonitorMetrics,
  MonitorState,
  PathNode,
  PlanStep,
  RenderState,
  RiskEvent,
  SessionEfficiency,
  SessionMonitor,
  ServerEndpoint,
} from './types.js';

interface NormalizedEvent {
  sessionId: string;
  eventType: string;
  data: any;
  timestamp: number;
}

/** 内部计时累加器(不进公共 MonitorState) */
interface SessionInternal {
  iterationCount: number;
  iterationMsSum: number;
  lastIterationAt: number;
  thinkMs: number;
  toolMs: number;
  lastStateAt: number;
  lastState: RenderState;
  /** 重复工具检测: 工具签名 → 次数 */
  toolSig: Map<string, number>;
}

const ALERT_CAP = 200;
const RISK_CAP = 300;
const PATH_CAP = 300;
const TOOL_LATENCY_SAMPLE_CAP = 500;
const DESTRUCTIVE_TOOLS = new Set(['delete_file', 'execute_shell', 'execute_bash', 'bash', 'run_command']);
const DESTRUCTIVE_CMD = /\brm\s+-rf|\bgit\s+reset\s+--hard|\bdrop\s+(table|database)|\bgit\s+push\s+.*--force|\b:>\s|\bmkfs\b/i;

export class MonitorAggregator {
  private sessions = new Map<string, SessionMonitor>();
  private internal = new Map<string, SessionInternal>();
  private agents = new Map<string, AgentNode>();
  private alerts: MonitorAlert[] = [];
  private riskEvents: RiskEvent[] = [];
  private toolLatencies: number[] = [];
  private toolStartAt = new Map<string, number>();
  private tokenWindow: Array<{ ts: number; tokens: number }> = [];

  private eventsReceived = 0;
  private totalToolCalls = 0;
  private streamRetries = 0;
  private failovers = 0;
  private highRiskToolCalls = 0;
  private approvals = 0;
  private toolErrors = 0;
  private endpoint: ServerEndpoint | null = null;
  private connected = false;
  private mode: 'subscription' | 'attached' = 'subscription';

  setEndpoint(ep: ServerEndpoint | null): void { this.endpoint = ep; }
  setConnected(v: boolean): void { this.connected = v; }
  setMode(m: 'subscription' | 'attached'): void { this.mode = m; }

  record(ev: NormalizedEvent): void {
    this.eventsReceived++;
    const now = ev.timestamp || Date.now();
    const sessionId = ev.sessionId || 'unknown';
    const session = this.ensureSession(sessionId, now);
    const internal = this.internal.get(sessionId)!;
    session.lastEventAt = now;

    const data = ev.data || {};
    const agentId: string = data.agentId || data.agent_id || 'main';
    const agent = this.ensureAgent(sessionId, agentId, data, now);
    agent.lastEventAt = now;

    this.accrueStateTime(internal, agent.state, now);
    this.applyEvent(session, internal, agent, ev.eventType, data, now);
  }

  // ── 实体管理 ───────────────────────────────────────────────
  private ensureSession(sessionId: string, now: number): SessionMonitor {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId, state: 'idle', iteration: 0, toolCalls: 0,
        startedAt: now, lastEventAt: now, ctxUsed: 0, ctxMax: 0,
        tokensIn: 0, tokensOut: 0, agents: [], plan: [], path: [],
        efficiency: emptyEfficiency(),
      };
      this.sessions.set(sessionId, s);
      this.internal.set(sessionId, {
        iterationCount: 0, iterationMsSum: 0, lastIterationAt: 0,
        thinkMs: 0, toolMs: 0, lastStateAt: now, lastState: 'idle',
        toolSig: new Map(),
      });
    }
    return s;
  }

  private ensureAgent(sessionId: string, agentId: string, data: any, now: number): AgentNode {
    const key = `${sessionId}::${agentId}`;
    let a = this.agents.get(key);
    if (!a) {
      const isMain = agentId === 'main';
      a = {
        id: agentId, sessionId,
        kind: isMain ? 'main' : (data.isBackground || data.__background ? 'background' : 'sub'),
        parentId: data.parentId || data.parent_id,
        depth: typeof data.depth === 'number' ? data.depth : (isMain ? 0 : 1),
        state: 'idle', iteration: 0, toolCalls: 0, loopInterventions: 0,
        status: 'running', startedAt: now, lastEventAt: now,
      };
      this.agents.set(key, a);
    }
    return a;
  }

  /** 累计 think/tool 时间(用于 thinkRatio) */
  private accrueStateTime(internal: SessionInternal, state: RenderState, now: number): void {
    const dt = now - internal.lastStateAt;
    if (dt > 0 && dt < 600_000) {
      if (internal.lastState === 'thinking' || internal.lastState === 'streaming') internal.thinkMs += dt;
      else if (internal.lastState === 'tool_running') internal.toolMs += dt;
    }
    internal.lastStateAt = now;
    internal.lastState = state;
  }

  // ── 事件分发 ───────────────────────────────────────────────
  private applyEvent(
    session: SessionMonitor, internal: SessionInternal, agent: AgentNode,
    type: string, data: any, now: number,
  ): void {
    switch (type) {
      case 'thinking':
      case 'iteration_start': {
        agent.state = 'thinking';
        const iter = typeof data.iteration === 'number' ? data.iteration : agent.iteration + 1;
        agent.iteration = iter;
        if (agent.kind === 'main') session.iteration = iter;
        // 迭代耗时:两次 thinking 之间
        if (internal.lastIterationAt > 0) {
          internal.iterationMsSum += now - internal.lastIterationAt;
          internal.iterationCount++;
        }
        internal.lastIterationAt = now;
        this.pushPath(session, { ts: now, agentId: agent.id, kind: 'iteration', label: `iter ${iter}` });
        break;
      }

      case 'reasoning':
      case 'reasoning_complete':
      case 'text':
      case 'text_complete':
        agent.state = 'thinking';
        break;

      case 'tool_call_start': {
        agent.state = 'tool_running';
        agent.toolCalls++;
        if (agent.kind === 'main') session.toolCalls++;
        this.totalToolCalls++;
        const toolName = data.name || data.toolName || 'unknown';
        agent.currentTool = toolName;
        const tcId = data.toolId || data.toolCallId || data.id || `${toolName}-${now}`;
        this.toolStartAt.set(`${agent.sessionId}::${agent.id}::${tcId}`, now);
        // 重复工具检测(同名 + targetPath 签名)
        const sig = `${toolName}:${data.targetPath || JSON.stringify(data.args || {}).slice(0, 80)}`;
        const cnt = (internal.toolSig.get(sig) || 0) + 1;
        internal.toolSig.set(sig, cnt);
        if (cnt >= 3) {
          session.efficiency.repeatToolCalls++;
          this.addAlert({ level: 'warn', kind: 'loop', sessionId: session.sessionId, agentId: agent.id,
            message: `repeat tool ${toolName} ×${cnt}`, ts: now });
        }
        this.pushPath(session, { ts: now, agentId: agent.id, kind: 'tool',
          label: toolName, detail: data.targetPath || data.description });
        // 风控:破坏性操作
        this.checkDestructive(session, agent, toolName, data, now);
        break;
      }

      case 'tool_call_end':
      case 'tool_output': {
        agent.state = 'thinking';
        const toolName = data.name || data.toolName || agent.currentTool || 'unknown';
        const success = data.success !== false && data.toolStatus !== 'error';
        const tcId = data.toolId || data.toolCallId || data.id || `${toolName}-${now}`;
        const key = `${agent.sessionId}::${agent.id}::${tcId}`;
        const start = this.toolStartAt.get(key);
        const dur = typeof data.duration === 'number' ? data.duration : (start ? now - start : undefined);
        if (start) { this.pushToolLatency(now - start); this.toolStartAt.delete(key); }
        if (success) session.efficiency.toolSuccess++;
        else {
          session.efficiency.toolFailure++;
          this.toolErrors++;
          this.pushRisk({ ts: now, sessionId: session.sessionId, agentId: agent.id, kind: 'tool_error',
            level: 'warn', toolName, message: `tool ${toolName} failed: ${(data.toolError || '').slice(0, 80)}` });
        }
        // 更新最近的 path 节点结果
        this.patchLastToolPath(session, agent.id, toolName, success, dur);
        agent.currentTool = undefined;
        agent.toolElapsedMs = undefined;
        break;
      }

      case 'token_usage': {
        const eff = session.efficiency;
        eff.promptTokens += num(data.promptTokens);
        eff.completionTokens += num(data.completionTokens);
        eff.totalTokens += num(data.totalTokens);
        eff.cachedTokens += num(data.cachedTokens) || num(data.cacheReadTokens) || num(data.anthropicCacheReadTokens);
        if (typeof data.contextTokens === 'number') session.ctxUsed = data.contextTokens;
        if (num(data.completionTokens)) this.tokenWindow.push({ ts: now, tokens: num(data.completionTokens) });
        break;
      }

      case 'plan_update': {
        if (Array.isArray(data.plan)) {
          session.plan = data.plan
            .filter((p: any) => p && typeof p.step === 'string')
            .map((p: any): PlanStep => ({ step: p.step, status: p.status || 'pending' }));
          const done = session.plan.filter(p => p.status === 'completed').length;
          this.pushPath(session, { ts: now, agentId: agent.id, kind: 'plan',
            label: `plan ${done}/${session.plan.length}`, detail: data.explanation });
        }
        break;
      }

      case 'context_compaction':
        session.efficiency.compactions++;
        if (typeof data.budgetTokens === 'number') session.ctxMax = data.budgetTokens;
        if (typeof data.finalTokens === 'number') session.ctxUsed = data.finalTokens;
        this.pushPath(session, { ts: now, agentId: agent.id, kind: 'compaction',
          label: `compact ${data.originalTokens || '?'}→${data.finalTokens || '?'}` });
        break;

      case 'approval_needed': {
        this.approvals++;
        const lvl = data.risk?.level as RiskEvent['riskLevel'] | undefined;
        if (lvl === 'high' || lvl === 'critical') this.highRiskToolCalls++;
        this.pushRisk({ ts: now, sessionId: session.sessionId, agentId: agent.id,
          kind: lvl === 'high' || lvl === 'critical' ? 'high_risk_tool' : 'approval',
          level: lvl === 'critical' ? 'error' : 'warn', toolName: data.toolName, riskLevel: lvl,
          message: `approval: ${data.toolName}${lvl ? ` [${lvl}]` : ''} ${data.reason || ''}`.slice(0, 120) });
        this.pushPath(session, { ts: now, agentId: agent.id, kind: 'approval', label: `approval ${data.toolName}` });
        break;
      }

      case 'ask_user_needed':
        this.pushRisk({ ts: now, sessionId: session.sessionId, agentId: agent.id, kind: 'ask_user',
          level: 'info', message: `ask_user (${(data.questions || []).length} question(s))` });
        break;

      case 'stream_retry':
      case 'stream_recovered': {
        this.streamRetries++;
        const rl = !!data.isRateLimit;
        this.addAlert({ level: 'warn', kind: 'retry', sessionId: session.sessionId, agentId: agent.id,
          message: `stream retry${rl ? ' (rate-limit)' : ''} attempt ${data.attempt ?? '?'}`, ts: now });
        if (rl) this.pushRisk({ ts: now, sessionId: session.sessionId, kind: 'rate_limit', level: 'warn',
          message: `rate limited (attempt ${data.attempt ?? '?'})` });
        break;
      }

      case 'worker_start': {
        agent.kind = data.isBackground ? 'background' : 'sub';
        this.pushPath(session, { ts: now, agentId: agent.id, kind: 'spawn',
          label: `spawn ${data.role || data.roleName || 'sub'}`, detail: (data.task || '').slice(0, 80) });
        break;
      }

      case 'worker_complete':
        agent.status = data.success ? 'completed' : 'failed';
        agent.state = data.success ? 'completed' : 'error';
        break;

      case 'dag_created':
        this.pushPath(session, { ts: now, agentId: agent.id, kind: 'dag_node',
          label: `dag ${data.dagId} (${data.nodeCount} nodes)`, detail: data.description });
        break;

      case 'dag_node_started':
        this.pushPath(session, { ts: now, agentId: data.agentId || agent.id, kind: 'dag_node',
          label: `▶ ${data.nodeName}` });
        break;

      case 'dag_node_completed':
        this.pushPath(session, { ts: now, agentId: agent.id, kind: 'dag_node',
          label: `${data.success ? '✓' : '✗'} ${data.nodeName}`, ok: data.success, durationMs: data.duration });
        break;

      case 'status':
        this.applyStatus(session, agent, data, now);
        break;

      case 'run_result':
        agent.status = data.failed ? 'failed' : 'completed';
        agent.state = data.failed ? 'error' : 'completed';
        if (agent.kind === 'main') session.state = agent.state;
        if (typeof data.totalTokens === 'number') session.efficiency.totalTokens = Math.max(session.efficiency.totalTokens, data.totalTokens);
        break;

      case 'error':
      case 'error_classified': {
        agent.state = 'error';
        if (agent.kind === 'main') session.state = 'error';
        session.lastError = String(data.error || data.message || 'error');
        this.addAlert({ level: 'error', kind: 'error', sessionId: session.sessionId, agentId: agent.id,
          message: session.lastError.slice(0, 200), ts: now });
        this.pushRisk({ ts: now, sessionId: session.sessionId, agentId: agent.id, kind: 'classified_error',
          level: 'error', message: `${data.category || 'error'}/${data.code || ''}: ${session.lastError}`.slice(0, 140) });
        this.pushPath(session, { ts: now, agentId: agent.id, kind: 'error', label: 'error', detail: session.lastError.slice(0, 80) });
        break;
      }
    }

    if (data.tracker && typeof data.tracker.contextUsed === 'number') session.ctxUsed = data.tracker.contextUsed;
    const main = this.agents.get(`${session.sessionId}::main`);
    if (main) session.state = main.state;
  }

  private applyStatus(session: SessionMonitor, agent: AgentNode, data: any, now: number): void {
    switch (data.status) {
      case 'tool_call': agent.state = 'tool_running'; break;
      case 'thinking': agent.state = 'thinking'; break;
      case 'complete': agent.state = 'completed'; agent.status = 'completed'; break;
      case 'error': agent.state = 'error'; agent.status = 'failed'; break;
      case 'compacting': break;
    }
  }

  private checkDestructive(session: SessionMonitor, agent: AgentNode, toolName: string, data: any, now: number): void {
    const cmd = String(data.args?.command || data.args?.cmd || data.equivalentCommand || '');
    const isDestructive = (DESTRUCTIVE_TOOLS.has(toolName.toLowerCase()) && DESTRUCTIVE_CMD.test(cmd))
      || toolName.toLowerCase() === 'delete_file';
    if (isDestructive) {
      this.pushRisk({ ts: now, sessionId: session.sessionId, agentId: agent.id, kind: 'destructive',
        level: 'warn', toolName, message: `destructive: ${toolName} ${cmd.slice(0, 80)}` });
    }
  }

  // ── path / alert / risk ────────────────────────────────────
  private pushPath(session: SessionMonitor, node: PathNode): void {
    session.path.push(node);
    if (session.path.length > PATH_CAP) session.path.splice(0, session.path.length - PATH_CAP);
  }

  private patchLastToolPath(session: SessionMonitor, agentId: string, toolName: string, ok: boolean, dur?: number): void {
    for (let i = session.path.length - 1; i >= 0 && i >= session.path.length - 12; i--) {
      const n = session.path[i];
      if (n.kind === 'tool' && n.agentId === agentId && n.label === toolName && n.ok === undefined) {
        n.ok = ok; n.durationMs = dur; return;
      }
    }
  }

  addAlert(a: Omit<MonitorAlert, 'id'>): void {
    this.alerts.push({ ...a, id: `alert-${Date.now()}-${this.alerts.length}` });
    if (this.alerts.length > ALERT_CAP) this.alerts.splice(0, this.alerts.length - ALERT_CAP);
  }

  private pushRisk(r: Omit<RiskEvent, 'id'>): void {
    this.riskEvents.push({ ...r, id: `risk-${Date.now()}-${this.riskEvents.length}` });
    if (this.riskEvents.length > RISK_CAP) this.riskEvents.splice(0, this.riskEvents.length - RISK_CAP);
  }

  private pushToolLatency(ms: number): void {
    this.toolLatencies.push(ms);
    if (this.toolLatencies.length > TOOL_LATENCY_SAMPLE_CAP) {
      this.toolLatencies.splice(0, this.toolLatencies.length - TOOL_LATENCY_SAMPLE_CAP);
    }
  }

  recordFailover(): void { this.failovers++; }

  // ── 快照(冷路径算派生率) ──────────────────────────────────
  snapshot(controlPlane?: MonitorState['controlPlane']): MonitorState {
    const now = Date.now();

    for (const agent of this.agents.values()) {
      if (agent.state === 'tool_running' && agent.currentTool) {
        let latestStart = 0;
        for (const [k, t] of this.toolStartAt) {
          if (k.startsWith(`${agent.sessionId}::${agent.id}::`) && t > latestStart) latestStart = t;
        }
        if (latestStart) agent.toolElapsedMs = now - latestStart;
      }
    }

    const sessions: SessionMonitor[] = [];
    for (const s of this.sessions.values()) {
      const internal = this.internal.get(s.sessionId)!;
      const eff = s.efficiency;
      const toolTotal = eff.toolSuccess + eff.toolFailure;
      eff.toolSuccessRate = toolTotal ? eff.toolSuccess / toolTotal : 0;
      eff.cacheHitRate = eff.promptTokens ? Math.min(1, eff.cachedTokens / eff.promptTokens) : 0;
      eff.avgIterationMs = internal.iterationCount ? Math.round(internal.iterationMsSum / internal.iterationCount) : 0;
      const tt = internal.thinkMs + internal.toolMs;
      eff.thinkRatio = tt ? internal.thinkMs / tt : 0;

      const agents = [...this.agents.values()]
        .filter((a) => a.sessionId === s.sessionId)
        .sort((a, b) => a.depth - b.depth || a.startedAt - b.startedAt);
      sessions.push({ ...s, agents });
    }
    sessions.sort((a, b) => b.lastEventAt - a.lastEventAt);

    return {
      endpoint: this.endpoint, connected: this.connected, mode: this.mode,
      sessions,
      alerts: [...this.alerts].slice(-50).reverse(),
      riskEvents: [...this.riskEvents].slice(-50).reverse(),
      metrics: this.computeMetrics(now),
      controlPlane: controlPlane ?? { inflightStalls: [], available: false },
      eventsReceived: this.eventsReceived, lastUpdatedAt: now,
    };
  }

  private computeMetrics(now: number): MonitorMetrics {
    const activeAgents = [...this.agents.values()].filter((a) => a.status === 'running').length;
    const activeSessions = [...this.sessions.values()].filter(
      (s) => s.state !== 'completed' && s.state !== 'error' && s.state !== 'idle').length;
    const sorted = [...this.toolLatencies].sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
    const cutoff = now - 60_000;
    this.tokenWindow = this.tokenWindow.filter((t) => t.ts >= cutoff);
    const tokensPerMin = this.tokenWindow.reduce((sum, t) => sum + t.tokens, 0);

    let tokensTotal = 0, prompt = 0, cached = 0, tSucc = 0, tFail = 0;
    for (const s of this.sessions.values()) {
      tokensTotal += s.efficiency.totalTokens;
      prompt += s.efficiency.promptTokens;
      cached += s.efficiency.cachedTokens;
      tSucc += s.efficiency.toolSuccess;
      tFail += s.efficiency.toolFailure;
    }

    return {
      activeSessions, activeAgents, totalToolCalls: this.totalToolCalls,
      toolLatencyP50: pct(0.5), toolLatencyP95: pct(0.95), tokensPerMin,
      streamRetries: this.streamRetries, failovers: this.failovers,
      tokensTotal,
      cacheHitRate: prompt ? Math.min(1, cached / prompt) : 0,
      toolSuccessRate: (tSucc + tFail) ? tSucc / (tSucc + tFail) : 0,
      highRiskToolCalls: this.highRiskToolCalls, approvals: this.approvals, toolErrors: this.toolErrors,
    };
  }
}

function emptyEfficiency(): SessionEfficiency {
  return {
    promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0,
    cacheHitRate: 0, toolSuccess: 0, toolFailure: 0, toolSuccessRate: 0,
    avgIterationMs: 0, compactions: 0, repeatToolCalls: 0, thinkRatio: 0,
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
