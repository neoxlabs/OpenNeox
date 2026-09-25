/**
 * Client Agent Protocol - Type Definitions
 *
 * 外部设备与 Neox CLI 通信的协议类型定义
 */

// ==================== 基础类型 ====================

export interface Message {
  type: string;
  id?: string;
  ts?: number;
  payload?: unknown;
}

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_FAILED'
  | 'INVALID_MESSAGE'
  | 'RATE_LIMITED'
  | 'AGENT_BUSY'
  | 'HOST_UNAVAILABLE'
  | 'UNSUPPORTED'
  | 'INTERNAL_ERROR';

// ==================== 设备信息 ====================

export type DeviceType = 'android' | 'ios' | 'watch' | 'web' | 'desktop' | 'cli' | 'other';

export interface DeviceInfo {
  type: DeviceType;
  name: string;
  model?: string;
  os?: string;
  version?: string;
}

export type Capability =
  | 'voice_input'
  | 'voice_output'
  | 'text_input'
  | 'text_output'
  | 'rich_text'
  | 'code_highlight'
  | 'notifications'
  | 'haptic'
  | 'always_on'
  | 'background';

export type ResponseStyle = 'brief' | 'normal' | 'detailed';

export interface ClientPreferences {
  language?: string;
  responseStyle?: ResponseStyle;
}

// ==================== 客户端消息 ====================

export interface AuthMessage extends Message {
  type: 'auth';
  payload: {
    token: string;
  };
}

export interface RegisterMessage extends Message {
  type: 'register';
  payload: {
    device: DeviceInfo;
    capabilities: Capability[];
    preferences?: ClientPreferences;
  };
}

export interface ChatMessage extends Message {
  type: 'chat';
  id: string;
  payload: {
    text: string;
    context?: {
      replyTo?: string;
      attachments?: Attachment[];
    };
  };
}

export interface Attachment {
  type: 'image' | 'file' | 'url';
  data: string;
  name?: string;
  mimeType?: string;
}

export interface VoiceMessage extends Message {
  type: 'voice';
  id: string;
  payload: {
    text?: string;
    audio?: string;
    format?: 'wav' | 'mp3' | 'opus' | 'webm';
    sampleRate?: number;
    language?: string;
  };
}

export type HostEventType =
  | '*'
  | 'task_start'
  | 'task_progress'
  | 'task_complete'
  | 'task_error'
  | 'agent_spawn'
  | 'agent_status'
  | 'agent_complete'
  | 'tool_call'
  | 'tool_result'
  | 'message'
  | 'context_pressure'
  | 'approval_needed'
  | 'approval_cancelled'
  | 'error';

export interface SubscribeMessage extends Message {
  type: 'subscribe';
  payload: {
    events: HostEventType[];
  };
}

export interface UnsubscribeMessage extends Message {
  type: 'unsubscribe';
  payload: {
    events: HostEventType[];
  };
}

export interface PingMessage extends Message {
  type: 'ping';
  ts: number;
}

export interface CloseMessage extends Message {
  type: 'close';
  payload?: {
    reason?: string;
  };
}

export type ClientMessage =
  | AuthMessage
  | RegisterMessage
  | ChatMessage
  | VoiceMessage
  | SubscribeMessage
  | UnsubscribeMessage
  | PingMessage
  | CloseMessage;

// ==================== 服务端消息 ====================

export interface WelcomeMessage extends Message {
  type: 'welcome';
  payload: {
    version: string;
    serverTime: number;
    features: string[];
  };
}

export interface AuthOkMessage extends Message {
  type: 'auth_ok';
  payload: {
    clientId: string;
    expiresAt?: number;
  };
}

export interface AuthFailMessage extends Message {
  type: 'auth_fail';
  payload: {
    reason: string;
  };
}

export interface AgentReadyMessage extends Message {
  type: 'agent_ready';
  payload: {
    agentId: string;
    tools: string[];
    model: string;
  };
}

export interface StreamMessage extends Message {
  type: 'stream';
  id: string;
  payload: {
    delta: string;
    done: boolean;
  };
}

export interface Action {
  type: 'button' | 'link' | 'command';
  label: string;
  value: string;
}

export interface ToolCallInfo {
  name: string;
  args: unknown;
  result: unknown;
  duration: number;
}

export interface ResponseMessage extends Message {
  type: 'response';
  id: string;
  payload: {
    text: string;
    audio?: string;
    audioFormat?: string;
    actions?: Action[];
    toolCalls?: ToolCallInfo[];
    queued?: boolean;
    position?: number;
  };
}

export interface HostEvent {
  event: HostEventType;
  timestamp: number;
  data: unknown;
}

export interface HostEventMessage extends Message {
  type: 'host_event';
  payload: HostEvent;
}

export interface PongMessage extends Message {
  type: 'pong';
  ts: number;
  payload: {
    serverTime: number;
  };
}

export interface CloseAckMessage extends Message {
  type: 'close_ack';
}

export interface ErrorMessage extends Message {
  type: 'error';
  payload: ErrorPayload;
}

export type ServerMessage =
  | WelcomeMessage
  | AuthOkMessage
  | AuthFailMessage
  | AgentReadyMessage
  | StreamMessage
  | ResponseMessage
  | HostEventMessage
  | PongMessage
  | CloseAckMessage
  | ErrorMessage;

// ==================== Host Introspection Types ====================

export type AgentMode = 'agentic';
export type AgentRole = 'main' | 'worker' | 'supervisor';
export type AgentStatus = 'idle' | 'running' | 'waiting' | 'completed' | 'error';
export type GitStatus = 'clean' | 'dirty' | 'unknown';
export type ActivityType = 'tool_call' | 'tool_result' | 'message' | 'error';

export interface HostStatus {
  isRunning: boolean;
  currentTask: string | null;
  mode: AgentMode;
  sessionId: string;
  workingDirectory: string;
  uptime: number;
  memoryUsage: {
    tokensUsed: number;
    contextWindow: number;
    pressure: number;
  };
}

export interface AgentInfo {
  id: string;
  role: AgentRole;
  status: AgentStatus;
  currentTool: string | null;
  progress: number;
  startedAt: number;
}

export interface ActivityRecord {
  timestamp: number;
  type: ActivityType;
  summary: string;
  details?: unknown;
}

export interface SessionInfo {
  sessionId: string;
  messageCount: number;
  tokensUsed: number;
  lastUserMessage: string;
  lastAssistantSummary: string;
  checkpoints: number;
}

export interface SystemInfo {
  platform: string;
  arch: string;
  cwd: string;
  gitBranch: string | null;
  gitStatus: GitStatus;
  nodeVersion: string;
  neoxVersion: string;
}

export interface InterruptResult {
  interrupted: boolean;
  taskId?: string;
}

export interface SendCommandResult {
  queued: boolean;
  position: number;
  estimatedWait?: number;
}

export interface SubscriptionResult {
  subscriptionId: string;
}

// ==================== 连接状态 ====================

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'authenticating'
  | 'authenticated'
  | 'registering'
  | 'ready'
  | 'disconnecting'
  | 'disconnected'
  | 'error';

export interface ClientConnection {
  id: string;
  state: ConnectionState;
  device: DeviceInfo | null;
  capabilities: Capability[];
  agentId: string | null;
  subscriptions: Set<HostEventType>;
  connectedAt: number;
  lastActivity: number;
}

// ==================== 配置 ====================

export interface ClientAgentServerConfig {
  port: number;
  host?: string;
  token: string;
  maxClients?: number;
  maxConnectionsPerIp?: number;
  idleTimeout?: number;
  heartbeatInterval?: number;
  maxPortRetries?: number;
  rateLimit?: {
    messages: number;
    window: number;
  };
}

export const DEFAULT_CONFIG: Partial<ClientAgentServerConfig> = {
  port: 7091,  // Client Agent 专用端口
  host: '0.0.0.0',
  maxClients: 10,
  maxConnectionsPerIp: 3,
  idleTimeout: 5 * 60 * 1000,
  heartbeatInterval: 30 * 1000,
  rateLimit: {
    messages: 60,
    window: 60 * 1000,
  },
};
