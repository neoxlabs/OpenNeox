/**
 * Multi-Agent 系统核心类型定义
 *
 * 设计原则：
 * - Agent 都是通用的，不预定义角色
 * - 默认单Agent执行，除非业务模块高度割裂
 * - 失败时通知用户，不自动重试
 * - 并行执行，独立线程
 */

// ============ Agent 状态 ============

export type AgentStatus =
  | 'idle'       // 就绪
  | 'running'    // 运行中
  | 'waiting'    // 等待（等待依赖或用户输入）
  | 'completed'  // 完成
  | 'error';     // 错误

// ============ Agent 信息 ============

export interface AgentInfo {
  /** 唯一ID: "agent-1", "agent-2" */
  id: string;
  /** 序号: 1, 2, 3... */
  index: number;
  /** 当前状态 */
  status: AgentStatus;
  /** 执行进度 0-100 */
  progress: number;
  /** 当前任务描述 */
  currentTask?: string;
  /** 开始时间戳 */
  startedAt?: number;
  /** 完成时间戳 */
  completedAt?: number;
}

// ============ Agent 事件 ============

export type AgentEventType =
  // Supervisor 事件
  | 'supervisor_message'
  | 'supervisor_thinking'
  // Agent 生命周期
  | 'agent_spawned'
  | 'agent_status'
  | 'agent_progress'
  | 'agent_completed'
  | 'agent_error'
  | 'agent_terminated'
  // Agent 流式文本
  | 'agent_text'
  // Agent 工具调用
  | 'agent_tool_call'
  // Agent 上下文统计
  | 'agent_context_update'
  // 数据流（用于UI动画）
  | 'data_flow'
  // Timeline
  | 'timeline';

/** Supervisor 消息事件 */
export interface SupervisorMessageEvent {
  type: 'supervisor_message';
  message: string;
  timestamp: number;
}

/** Supervisor 思考事件 */
export interface SupervisorThinkingEvent {
  type: 'supervisor_thinking';
  thinking: string;
  timestamp: number;
}

/** Agent 创建事件 */
export interface AgentSpawnedEvent {
  type: 'agent_spawned';
  agent: AgentInfo;
  timestamp: number;
}

/** Agent 状态变更事件 */
export interface AgentStatusEvent {
  type: 'agent_status';
  agentId: string;
  status: AgentStatus;
  message?: string;
  timestamp: number;
}

/** Agent 进度事件 */
export interface AgentProgressEvent {
  type: 'agent_progress';
  agentId: string;
  progress: number;
  message?: string;
  timestamp: number;
}

/** Agent 完成事件 */
export interface AgentCompletedEvent {
  type: 'agent_completed';
  agentId: string;
  result?: string;
  timestamp: number;
}

/** Agent 错误事件 */
export interface AgentErrorEvent {
  type: 'agent_error';
  agentId: string;
  error: string;
  timestamp: number;
}

/** Agent 终止事件 */
export interface AgentTerminatedEvent {
  type: 'agent_terminated';
  agentId: string;
  reason?: string;
  timestamp: number;
}

/** NEW: Agent 流式文本事件 */
export interface AgentTextEvent {
  type: 'agent_text';
  agentId: string;
  text: string;
  roleId?: string;
  timestamp: number;
}

/** NEW: Agent 工具调用事件 */
export interface AgentToolCallEvent {
  type: 'agent_tool_call';
  agentId: string;
  agentIndex: number;
  roleId?: string;
  toolName: string;
  toolArgs?: Record<string, any>;
  status: 'start' | 'end';
  message?: string;
  timestamp: number;
}

/** 数据流事件（用于UI连接线动画） */
export interface DataFlowEvent {
  type: 'data_flow';
  from: 'supervisor' | string;
  to: string;
  label?: string;
  timestamp: number;
}

/** Timeline 条目级别 */
export type TimelineLevel = 'info' | 'action' | 'result' | 'error';

/** Timeline 条目 */
export interface AgentTimelineEntry {
  id: string;
  timestamp: number;
  /** 来源: supervisor 或 agent-id */
  source: 'supervisor' | string;
  /** 图标 emoji */
  icon?: string;
  /** 标题 */
  title: string;
  /** 描述 */
  description?: string;
  /** 级别 */
  level: TimelineLevel;
}

/** Timeline 事件 */
export interface TimelineEvent {
  type: 'timeline';
  entry: AgentTimelineEntry;
  timestamp: number;
}

/** Agent 事件联合类型 */
export type AgentEvent =
  | SupervisorMessageEvent
  | SupervisorThinkingEvent
  | AgentSpawnedEvent
  | AgentStatusEvent
  | AgentProgressEvent
  | AgentCompletedEvent
  | AgentErrorEvent
  | AgentTerminatedEvent
  | AgentTextEvent
  | AgentToolCallEvent
  | AgentContextUpdateEvent
  | DataFlowEvent
  | TimelineEvent;

// ============ 任务规划 ============

/** 任务描述 */
export interface TaskDescription {
  /** 任务ID */
  id: string;
  /** 任务描述/prompt */
  description: string;
  /** 优先级 (越小越先执行) */
  priority?: number;
  /** 依赖的任务ID列表 */
  dependsOn?: string[];
}

/** 任务规划结果 */
export interface TaskPlan {
  /** 是否需要派发Agent */
  needsAgents: boolean;
  /** Agent数量 (默认1) */
  agentCount: number;
  /** 任务列表 */
  tasks: TaskDescription[];
  /** 规划说明 */
  explanation?: string;
}

/** 任务规划评估维度 */
export interface TaskAnalysis {
  /** 任务复杂度: 1-10 */
  complexity: number;
  /** 业务模块关联度: 1-10 (低=可并行) */
  moduleCoupling: number;
  /** 是否有数据依赖 */
  hasDataDependency: boolean;
  /** 建议Agent数量 */
  suggestedAgentCount: number;
  /** 分析说明 */
  reasoning: string;
}

// ============ Agent 事件总线接口 ============

export interface IAgentEventBus {
  /** 发布事件 */
  emit(event: AgentEvent): void;

  /** 订阅所有事件 */
  subscribe(handler: (event: AgentEvent) => void): () => void;

  /** 按类型订阅 */
  on<T extends AgentEvent['type']>(
    type: T,
    handler: (event: Extract<AgentEvent, { type: T }>) => void
  ): () => void;

  /** 获取历史事件 */
  getHistory(limit?: number): AgentEvent[];
}

// ============ Agent 实例配置 ============

export interface AgentInstanceConfig {
  /** Agent ID */
  id: string;
  /** 任务描述 */
  task: TaskDescription;
  /** 会话ID */
  sessionId: string;
  /** 工作目录 */
  workDir: string;
}

// ============ Agent 执行结果 ============

export interface AgentExecutionResult {
  /** 是否成功 */
  success: boolean;
  /** 结果摘要 */
  summary: string;
  /** 详细输出 */
  output?: string;
  /** 错误信息 */
  error?: string;
  /** 执行时长 (ms) */
  duration: number;
}

// ============ Agent 上下文统计 ============

/** 单个 Agent 的上下文统计信息 */
export interface AgentContextStats {
  /** Agent ID: "supervisor" | "agent-1" | "agent-2" */
  agentId: string;
  /** 显示标签使用稳定的角色名或序号，例如 "Supervisor"、"Agent 1"、"Agent 2"。 */
  agentLabel: string;
  /** 当前状态 */
  status?: AgentStatus;
  /** 当前任务描述 */
  currentTask?: string;
  /** 输入 tokens */
  input: number;
  /** 输出 tokens */
  output: number;
  /** 上下文窗口大小 */
  contextWindow: number;
  /** 已使用的上下文 tokens */
  tokensUsedForContext: number;
  /** 压力值 0-1 */
  pressure: number;
  /** 缓存创建 tokens */
  cacheCreationTokens?: number;
  /** 缓存读取 tokens */
  cacheReadTokens?: number;
  /** Worker 角色: "scout" | "worker" | "verifier" | "compressor" | "coordinator" */
  workerRole?: string;
  /** 任务摘要（固定不变，不随工具切换） */
  workerTask?: string;
  /** 工具调用次数 */
  toolUseCount?: number;
  /** 已耗时（毫秒） */
  elapsedMs?: number;
}

/** Agent 上下文更新事件 */
export interface AgentContextUpdateEvent {
  type: 'agent_context_update';
  agentId: string;
  stats: AgentContextStats;
  timestamp: number;
}
