/**
 * Web 端 MonitorState 契约 —— 镜像 packages/devtools/src/types.ts。
 * 内部工具, 保持手动同步即可(字段变更时两处一起改)。
 */

export type RenderState =
  | 'idle' | 'thinking' | 'tool_running' | 'streaming' | 'completed' | 'error' | 'paused';

export type AlertLevel = 'info' | 'warn' | 'error';

export interface PlanStep {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface PathNode {
  ts: number;
  agentId: string;
  kind: 'iteration' | 'tool' | 'plan' | 'spawn' | 'dag_node' | 'error' | 'approval' | 'compaction';
  label: string;
  ok?: boolean;
  durationMs?: number;
  detail?: string;
}

export interface SessionEfficiency {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitRate: number;
  toolSuccess: number;
  toolFailure: number;
  toolSuccessRate: number;
  avgIterationMs: number;
  compactions: number;
  repeatToolCalls: number;
  thinkRatio: number;
}

export interface AgentNode {
  id: string;
  sessionId: string;
  kind: 'main' | 'sub' | 'background';
  parentId?: string;
  depth: number;
  state: RenderState;
  currentTool?: string;
  toolElapsedMs?: number;
  iteration: number;
  toolCalls: number;
  loopInterventions: number;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  lastEventAt: number;
}

export interface SessionMonitor {
  sessionId: string;
  state: RenderState;
  iteration: number;
  toolCalls: number;
  startedAt: number;
  lastEventAt: number;
  ctxUsed: number;
  ctxMax: number;
  tokensIn: number;
  tokensOut: number;
  agents: AgentNode[];
  lastError?: string;
  plan: PlanStep[];
  path: PathNode[];
  efficiency: SessionEfficiency;
}

export interface MonitorAlert {
  id: string;
  level: AlertLevel;
  kind: string;
  sessionId?: string;
  agentId?: string;
  message: string;
  stallId?: number;
  ts: number;
}

export interface RiskEvent {
  id: string;
  ts: number;
  sessionId?: string;
  agentId?: string;
  kind: string;
  level: AlertLevel;
  toolName?: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  message: string;
}

export interface MonitorMetrics {
  activeSessions: number;
  activeAgents: number;
  totalToolCalls: number;
  toolLatencyP50: number;
  toolLatencyP95: number;
  tokensPerMin: number;
  streamRetries: number;
  failovers: number;
  tokensTotal: number;
  cacheHitRate: number;
  toolSuccessRate: number;
  highRiskToolCalls: number;
  approvals: number;
  toolErrors: number;
}

export interface ControlPlaneSnapshot {
  inflightStalls: Array<{
    stallId: number;
    label: string;
    ageMs: number;
    kind: 'timeout' | 'watchdog';
    timeoutMs?: number;
    context?: Record<string, unknown>;
  }>;
  available: boolean;
}

export interface ServerEndpoint {
  host: string;
  port: number;
  pid?: number;
  workDir?: string;
  source: 'pidfile' | 'manual';
}

export interface MonitorState {
  endpoint: ServerEndpoint | null;
  connected: boolean;
  mode: 'subscription' | 'attached';
  sessions: SessionMonitor[];
  alerts: MonitorAlert[];
  riskEvents: RiskEvent[];
  metrics: MonitorMetrics;
  controlPlane: ControlPlaneSnapshot;
  eventsReceived: number;
  lastUpdatedAt: number;
}
