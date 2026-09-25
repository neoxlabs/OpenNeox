/**
 * neox-devtools 监控数据契约
 *
 * 这是 monitor 的"前端无关"数据模型 —— 进程外订阅(monitorClient)和 in-process
 * attach(attach.ts)都产出同一个 MonitorState, 渲染层(终端 / web)只认这个。
 */

/** agent 运行态(对齐产品侧 HostStateMachine) */
export type RenderState =
  | 'idle'
  | 'thinking'
  | 'tool_running'
  | 'streaming'
  | 'completed'
  | 'error'
  | 'paused';

/** server pidfile 发现出的连接信息 */
export interface ServerEndpoint {
  host: string;
  port: number;
  token?: string;
  pid?: number;
  workDir?: string;
  /** 来源: 'pidfile' | 'manual' */
  source: 'pidfile' | 'manual';
}

/** 单个 agent 节点(主/子/后台) */
export interface AgentNode {
  id: string;
  sessionId: string;
  kind: 'main' | 'sub' | 'background';
  parentId?: string;
  depth: number;
  state: RenderState;
  currentTool?: string;
  /** 当前工具已执行时长(ms), 由 aggregator 按 tool_call_start 计时 */
  toolElapsedMs?: number;
  iteration: number;
  toolCalls: number;
  loopInterventions: number;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  lastEventAt: number;
}

/** 单个 session 监控视图 */
export interface SessionMonitor {
  sessionId: string;
  state: RenderState;
  iteration: number;
  toolCalls: number;
  startedAt: number;
  lastEventAt: number;
  /** 上下文用量 / 上限(从 tracker 或事件推断, 取不到为 0) */
  ctxUsed: number;
  ctxMax: number;
  tokensIn: number;
  tokensOut: number;
  /** 该 session 下的 agent 节点(含 main) */
  agents: AgentNode[];
  lastError?: string;
  /** agent 声明的计划(逻辑路径) */
  plan: PlanStep[];
  /** 执行路径 trace(最近 N 个节点) */
  path: PathNode[];
  /** 效率画像 */
  efficiency: SessionEfficiency;
}

/** 告警级别 */
export type AlertLevel = 'info' | 'warn' | 'error';

/** 计划步骤(来自 plan_update 事件 —— agent 自己声明的逻辑路径) */
export interface PlanStep {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** 路径节点 —— agent 逻辑/执行路径上的一个事件(用于 trace 时间线) */
export interface PathNode {
  ts: number;
  agentId: string;
  kind: 'iteration' | 'tool' | 'plan' | 'spawn' | 'dag_node' | 'error' | 'approval' | 'compaction';
  label: string;
  /** 工具/节点是否成功(适用时) */
  ok?: boolean;
  /** 耗时 ms(适用时) */
  durationMs?: number;
  detail?: string;
}

/** 单 session 效率画像 */
export interface SessionEfficiency {
  /** token 明细(累计) */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  /** 缓存命中率 0~1(cachedTokens / promptTokens) */
  cacheHitRate: number;
  /** 工具成功/失败 */
  toolSuccess: number;
  toolFailure: number;
  /** 工具成功率 0~1 */
  toolSuccessRate: number;
  /** 平均每迭代耗时 ms */
  avgIterationMs: number;
  /** 上下文压缩次数 */
  compactions: number;
  /** 重复工具调用次数(同名同参,效率损耗信号) */
  repeatToolCalls: number;
  /** 思考 vs 工具 时间占比(0~1, thinking 时间 / 总时间) */
  thinkRatio: number;
}

/** 风控事件 */
export interface RiskEvent {
  id: string;
  ts: number;
  sessionId?: string;
  agentId?: string;
  /** 风险类别 */
  kind: 'high_risk_tool' | 'approval' | 'destructive' | 'tool_error' | 'classified_error' | 'rate_limit' | 'ask_user' | 'loop_hard' | 'stall';
  level: AlertLevel;
  toolName?: string;
  /** 风险评级(来自 approval_needed.risk) */
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  message: string;
}



/** 监控告警(loop / stall / lock / pause / error 等) */
export interface MonitorAlert {
  id: string;
  level: AlertLevel;
  kind: 'stall' | 'loop' | 'lock' | 'pause' | 'error' | 'retry' | 'announce' | 'other';
  sessionId?: string;
  agentId?: string;
  message: string;
  /** 关联 stallId(若来自 stallGuard) */
  stallId?: number;
  ts: number;
}

/** 派生指标(节流聚合, 不在热路径算) */
export interface MonitorMetrics {
  activeSessions: number;
  activeAgents: number;
  /** 工具调用总数(累计) */
  totalToolCalls: number;
  /** 最近窗口工具延迟分位(ms), 取不到为 0 */
  toolLatencyP50: number;
  toolLatencyP95: number;
  tokensPerMin: number;
  /** stream 重试 / failover 切换累计 */
  streamRetries: number;
  failovers: number;
  /** 全局效率 */
  tokensTotal: number;
  cacheHitRate: number;
  toolSuccessRate: number;
  /** 风控计数 */
  highRiskToolCalls: number;
  approvals: number;
  toolErrors: number;
}

/** 控制平面信号(仅 in-process attach 深度模式可得;纯订阅模式为空) */
export interface ControlPlaneSnapshot {
  /** stallGuard 当前挂起的操作 */
  inflightStalls: Array<{
    stallId: number;
    label: string;
    ageMs: number;
    kind: 'timeout' | 'watchdog';
    timeoutMs?: number;
    context?: Record<string, unknown>;
  }>;
  /** 来源标记 */
  available: boolean;
}

/** 完整监控状态 —— 渲染层消费的唯一对象 */
export interface MonitorState {
  endpoint: ServerEndpoint | null;
  connected: boolean;
  /** 监控数据深度: 'subscription'(进程外) | 'attached'(in-process 深度) */
  mode: 'subscription' | 'attached';
  sessions: SessionMonitor[];
  alerts: MonitorAlert[];
  /** 风控事件流(高危工具/审批/破坏性/错误/限流等) */
  riskEvents: RiskEvent[];
  metrics: MonitorMetrics;
  controlPlane: ControlPlaneSnapshot;
  /** 收到的事件总数(健康自检) */
  eventsReceived: number;
  lastUpdatedAt: number;
}

/** WSGateway 服务端消息(镜像产品侧 wsGateway.ts 的 WSServerMessage 形状) */
export interface WSServerMessage {
  type: 'event' | 'status' | 'error' | 'ack' | 'welcome' | 'control_request' | 'control_response';
  seq?: number;
  event?: {
    sessionId: string;
    eventType: string;
    data: any;
    seq: number;
    timestamp: number;
  };
  status?: any;
  error?: string;
  info?: any;
}

export function emptyMonitorState(): MonitorState {
  return {
    endpoint: null,
    connected: false,
    mode: 'subscription',
    sessions: [],
    alerts: [],
    riskEvents: [],
    metrics: {
      activeSessions: 0,
      activeAgents: 0,
      totalToolCalls: 0,
      toolLatencyP50: 0,
      toolLatencyP95: 0,
      tokensPerMin: 0,
      streamRetries: 0,
      failovers: 0,
      tokensTotal: 0,
      cacheHitRate: 0,
      toolSuccessRate: 0,
      highRiskToolCalls: 0,
      approvals: 0,
      toolErrors: 0,
    },
    controlPlane: { inflightStalls: [], available: false },
    eventsReceived: 0,
    lastUpdatedAt: Date.now(),
  };
}
