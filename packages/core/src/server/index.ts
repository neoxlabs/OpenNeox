/**
 * Neox Server — HTTP + SSE 服务
 *
 * 独立进程运行，持有所有 runtime 实例。
 * 所有客户端（CLI / Electron / Android / Web）通过 HTTP + SSE 统一通信。
 */

import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { touchActivity, sseClientConnected, sseClientDisconnected } from './serverActivity.js';
import { EventBus, type ServerEvent } from './eventBus.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { writeStallFile } from '@neoxlabs/kernel/utils/stallGuard.js';
import { assistantLog } from '@neoxlabs/platform/platform/assistantLogger.js';
import { AuthGate, type AuthConfig } from './middleware/auth.js';
import { rateLimitMiddleware, type RateLimitConfig } from './middleware/rateLimit.js';
import { DeviceManager, deviceMiddleware, type DeviceManagerConfig } from './middleware/device.js';
import { ChannelRegistry } from '../channels/registry.js';
import type { ChannelConfig } from '@neoxlabs/platform/channels/types.js';
import type { DeviceInfo, Capability } from './client-agent/protocol.js';
import type { ModelRouteConfig } from '@neoxlabs/platform/shared/ipc/modelRouting.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

export { BoundedUUIDSet } from './boundedUUIDSet.js';
export { FlushGate } from './flushGate.js';
export {
  SessionManager,
  type SessionMetadata,
  type SessionStatus,
  type SessionSnapshot,
  type CreateSessionOptions,
  type SessionStats,
} from './sessionManager.js';
export {
  DeliveryTracker,
  type DeliveryStatus,
  type DeliveryRecord,
  type DeliveryStats,
} from './deliveryTracker.js';
export {
  type NeoxTransport,
  type TransportState,
  type TransportMessage,
  type TransportDebugInfo,
  WebSocketTransport,
  SSETransport,
} from './transport.js';
export {
  isControlRequest,
  isControlResponse,
  handleControlRequest,
  ControlRequester,
  type ControlRequest,
  type ControlResponse,
  type ControlRequestSubtype,
  type ControlRequestHandlers,
} from './controlProtocol.js';
export { WSGateway, attachWSGateway, type WSGatewayOptions } from './wsGateway.js';

// ============================================================================
// Types
// ============================================================================

export interface NeoxServerConfig {
  /** 工作目录 */
  workDir: string;
  /** 端口 */
  port?: number;
  /** 认证配置（不传则不启用认证） */
  auth?: AuthConfig;
  /** 限流配置（不传则不启用限流） */
  rateLimit?: RateLimitConfig;
  /** 额外允许的 CORS origins */
  corsOrigins?: string[];
  /** Channel 适配器配置 */
  channels?: ChannelConfig;
}

export interface ChatRequest {
  prompt: string;
  mode?: string;
  attachments?: Array<{
    type: 'image' | 'url' | 'file';
    data: string;
    name?: string;
    path?: string;
    mediaType?: string;
  }>;
  providerId?: string;
  modelName?: string;
  isAutoRouted?: boolean;
  routeConfig?: ModelRouteConfig;
  modelConfig?: {
    reasoningEffort?: string;
    reasoningSummary?: string;
    verbosity?: string;
    serviceTier?: string;
  };

  effortLevel?: string;

  /** 多根工作区所有项目路径 */
  workspaceRoots?: string[];
  /** desktop / mobile-{deviceId} / cli / unknown — server 落盘 + bus 转发时带上, 接力 initiatedBy 用 */
  userMessageSource?: string;
  /** desktop / mobile 已生成的 message id — server 不重生, 跨端去重靠这个 */
  userMessageId?: string;
  /** true = 续 LLM 不算新 user input, 跳过 appendMessage + bus.publish('user_message') */
  isResume?: boolean;
  /** 错误卡"重试": 在现有 memory 上重跑这一轮, 不追加新的 user 消息 (见 server/main.ts 的说明)。 */
  isRetry?: boolean;
  /** 错误卡"继续": 从断掉的那半截往下接着写, 不是重来一遍 (见 agenticRuntime 的 isContinue)。 */
  isContinue?: boolean;
  agentMode?: string;
  /** 聊天模式 (输入框 + 菜单里切) —— 精简 prompt, 不带工具。见 runtime/turnTier.ts */
  chatMode?: boolean;
}

export interface PermissionReply {
  approved: boolean;
  message?: string;
  remember?: boolean;
}

export interface PermissionCancelRequest {
  reason?: 'resolved' | 'timeout' | 'manual_cancel' | 'session_aborted' | 'stale';
}

export interface AskUserReply {
  answers: Record<string, string>;
}

export interface DangerousModeConfirmation {
  acknowledgeNoApproval: boolean;
  acknowledgeHighRiskExecution: boolean;
}

function hasDangerousModeDoubleConfirmation(value: unknown): value is DangerousModeConfirmation {
  const payload = value as Partial<DangerousModeConfirmation> | undefined;
  return payload?.acknowledgeNoApproval === true && payload?.acknowledgeHighRiskExecution === true;
}

function getRemoteAddressFromContextEnv(env: unknown): string | undefined {
  const incoming = (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress;
}

/** 运行时初始化器 — server 不直接依赖 CLI 的初始化逻辑 */
export interface RunStateSnapshot {
  sessionId: string;
  status: 'idle' | 'running' | 'paused' | 'awaiting_approval' | 'awaiting_user';
  running: boolean;
  /**
   * 引擎是否**真的在执行**(LLM 请求 / 工具调用 in-flight)。
   * 只有 status === 'running' 或 chat 还在 in-flight 时为 true。
   * 所有"是否需要兜底收敛"的判断都应该看这个字段。
   */
  executing: boolean;
  blockedBy?: 'pause' | 'approval' | 'ask_user';
  /**
   * server **认不认识**这个会话 —— 状态机里有条目, 或 chat 还在 in-flight。
   *
   * 点名查询 (getRunStates([...])) 对完全没见过的 sessionId 也会返回一条 status:'idle'
   * 的快照, 于是"它空闲"和"我压根不知道它"长得一模一样。下游拿这种 idle 去收敛运行态,
   * 就会误伤根本不走本地 runtime 的会话 (cloud transport 是典型)。
   * known=false 的快照只说明"这里没有它的信息", 不构成"它没在跑"的证据。
   */
  known: boolean;
  turnId?: string;
  pendingToolCalls: Array<{ toolCallId: string; toolName: string; args?: any; startedAt: number }>;
  initiatedBy?: string;
  pausedAt?: number;
  /** 状态最后一次**变更**的时刻 (心跳重播不刷新) */
  updatedAt: number;
  /** 本次快照的观测时刻 — 下游判新鲜度用 */
  observedAt: number;
}

export interface RuntimeBridge {
  /** 拿到主 AgenticRuntime 引用 — crash-resume scanner 用来 fire-and-forget 调
   *  chat({ isResume: true }). 没暴露给 SDK 用户, 只内部用. */
  getAgenticRuntime?(): unknown;
  /** 发送聊天消息，事件通过 eventBus 推送 */
  chat(sessionId: string, request: ChatRequest): Promise<void>;
  channels?: ChannelRegistry;
  /** 中断执行 */
  abort(sessionId: string): void;
  /** 回复工具审批 */
  replyPermission(requestId: string, approved: boolean, message?: string, remember?: boolean): void;
  /** 取消工具审批 */
  cancelPermission?(requestId: string, reason?: PermissionCancelRequest['reason']): void;
  /** 回复 ask_user 交互 */
  /** 返回值: 给 UI 透传状态.
   *   · 'resolved': 内存 Promise 命中, agentLoop 在跑, 答案已注入
   *   · 'resumed':  仅磁盘命中 (服务期间重启过), 答案追加成 tool_result + 触发 chat({isResume:true})
   *   · 'orphan':   都没命中, 答案丢失, UI 应当提示用户改用普通消息重发 */
  replyAskUser?(
    requestId: string,
    answers: Record<string, string>,
  ): Promise<{ status: 'resolved' | 'resumed' | 'orphan'; reason?: string }> | { status: 'resolved' | 'resumed' | 'orphan'; reason?: string };
  /** 获取活跃 session 列表 */
  getActiveSessions(): string[];
  getRunState?(sessionId: string): RunStateSnapshot;
  /** 运行态权威 pull — 整表对账。默认只回非 idle 的会话 (没出现 = idle),
   *  sessionIds 里点名的无论什么状态都回。 */
  getRunStates?(sessionIds?: string[]): RunStateSnapshot[];
  /** 切换运行模式 */
  setRunMode?(mode: string): void;
  /** 获取当前运行模式 */
  getRunMode?(): string;
  /** 切换 session 用途模式 (assistant 生活 / work 工作 / code 编码), 返回归一后的值。下一轮 chat 生效。 */
  setAgentMode?(sessionId: string, mode: string): string;
  /** 查询 session 用途模式 (未设置时回落 config.defaultAgentMode → code)。 */
  getAgentMode?(sessionId: string): string;
  /** Jev 加持: 输入框草稿预判要用的工具包, 发送时同一段文字直接取结果。没开 Jev 时什么都不做。 */
  jevPrefetch?(text: string): void;
  /** 注入消息（Network 模式） */
  /** @returns 队列位置; 0 = **没排上** (没有在跑的 host)。调用方必须看返回值。 */
  injectMessage?(sessionId: string, message: string, images?: Array<{ mediaType: string; data: string; name?: string }>): number | void;
  describeInjectTarget?(sessionId: string): { hasHost: boolean; isRunning: boolean; hostSessionIds: string[] };
  grantTargetConsent?(sessionId: string): Promise<void>;
  /** 第二次回车 = 立即转向: 打断在途模型输出, 刚排进去的插话下一步就生效。@returns 是否真的打断了 */
  steerSession?(sessionId: string): boolean;
  rememberTargetUserText?(sessionId: string, text: string): Promise<void>;
  /** 诊断用: 这条 session 在 runtime 线程上到底有没有授权。 */
  hasTargetConsent?(sessionId: string): Promise<boolean>;
  targetCommand?(
    sessionId: string,
    cmd: 'pause' | 'continue' | 'stop' | 'off' | 'refine',
    arg?: string,
  ): Promise<{ live: boolean; ok: boolean; status?: string; error?: string }>;
  /** 看板上把一条需求改派给某个成员 (memberId=null 收回) —— 必须打到跑 agent 的那条线程,
   *  主进程直接改自己那份 teamPlanStore 副本等于没改 (worker 有独立模块注册表)。 */
  assignTeamRequirement?(
    sessionId: string,
    requirementId: string,
    memberId: string | null,
  ): Promise<Record<string, unknown> | null>;
  /** 执行期改方案: 重派 / 跳过 / 改派 —— 同样必须打到跑调度器的那条线程
   *  (主进程那份 teamExecStore 是副本, 改了正在跑的调度器读不到)。 */
  /** 退出团队模式 —— 清掉规划态+执行态 (在跑时要 force) */
  teamDismiss?(sessionId: string, force?: boolean): Promise<{ ok: boolean; reason?: string; runningTasks?: string[] }>;
  teamExecCommand?(
    sessionId: string,
    cmd: 'retry' | 'skip' | 'reassign',
    taskId: string,
    arg?: string,
  ): Promise<Record<string, unknown> | null>;
  /** 撤回最后一条排队消息 (↑ 拉回输入框编辑), 返回其文本 (空队列 null) */
  removeLastPendingMessage?(sessionId: string): string | null;
  /** UI 拉完整 bg shell 列表 (running + 5min 内退出的). 走 server 这边的 processManager,
   *  跟 LLM 看到的一致. 服务治理面板专用. 返回 plain object array (Date 字段已 ISO 字符串). */
  listBackgroundTasks?(): Array<Record<string, unknown>>;
  /** runtime 销毁时摘掉服务快照订阅, 防止往已 dispose 的 bus 上推。 */
  disposeSnapshotTick?(): void;
  listServiceHistory?(workspaceRoot: string): Promise<Array<Record<string, unknown>>>;
  readServiceLog?(pid: number, startTimeMs?: number): string;
  /** Logs 面板拉某个 pid 的累积 stdout/stderr. 跨进程必走这里. */
  getBackgroundTaskOutput?(pid: number): string;
  /** Services panel 的 Shell 控制台开一个独立可交互 PTY shell (bash -i / $SHELL -i),
   *  跟 service 解耦. 返回新 PTY 的 pid + toolId — pid 用于 stdin/resize 双向写,
   *  toolId 用于 terminalChunkBus 字节流订阅 (替代 1s polling, 零延迟回显). */
  openInteractiveShell?(args: { cwd?: string; command?: string }): Promise<{ pid: number | null; toolId?: string; error?: string }>;
  /** 用户从 UI 主动 kill 一个后台任务 (区别于 LLM 自己调 bash_kill) */
  killBackgroundTask?(pid: number, force?: boolean): void;
  killAllTrackedProcesses?(opts?: {
    workspaceRoot?: string;
    terminatedBy?: 'user' | 'agent' | 'system';
  }): Promise<{ killed: number; skipped: number; hardKilled: number }>;
  /** per-session 列出活跃 sub-agent — UI SubAgentsBar 用 (跟 background_task 是两条平行链路) */
  listSubAgents?(sessionId: string): Array<{
    agentId: string;
    name?: string;
    sessionId?: string;
    description: string;
    status: string;
    elapsed: number;
    toolUseCount: number;
  }>;
  /** 用户从 UI 停一个 sub-agent (走 BackgroundAgentManager.abort) */
  abortSubAgent?(agentId: string): { ok: boolean };
  /** "从列表移除" — 不杀进程, 只从 processManager.processes Map 把 pid 擦掉.
   *   UI 用于清理 ad-hoc 残留 (agent 早期凑出来的脏 pid, 但 RunConfig 已经 bind 不上).
   *   推荐配合 kill 一起用: 先 kill, 等 process exit 再 untrack. */
  untrackProcess?(pid: number): { ok: boolean; removed: boolean };
  startServiceByConfig?(workspaceRoot: string, configId: string, sessionId?: string): Promise<{ ok: boolean; pid?: number; reused?: boolean; output?: string; error?: string }>;
  /** UI 上的 Adopt 按钮: 把已运行的 ad-hoc pid 绑到一个 RunConfig 名下.
   *   跟 startServiceByConfig 同款理由 — pid 真身在 server 这边的 processManager,
   *   electron-main 的 processManager 是空壳, 直接调它的 bindConfig 没意义. */
  bindRunConfig?(pid: number, configId: string): { ok: boolean; error?: string };
  /** UI 切到一个新 workspace 时, 第一次扫端口接管该 workspace 的孤儿进程.
   *   server 启动时已经为初始 workspace 跑过, 但 workspace tab 切换时仅 server 端能感知,
   *   UI 触发的这一次必须也落在 server 上, 不然 main 的空 processManager 里接管不到东西. */
  /** UI 新建/编辑/复制 RunConfig 时走这条. 写文件 + 更新 server 端 ServiceConfigStore cache.
   *   electron-main 端也有 store, 但跨进程 cache 不一致 — server 后续 start/auto-restart
   *   会读老缓存找不到刚加的 config (虽然 serviceLauncher 入口已经 invalidate, 这里再让 server
   *   是 truth source, 避免依赖兜底). 返回最终落盘的 config 给 UI 二次确认. */
  upsertServiceConfig?(workspaceRoot: string, config: Record<string, unknown>): Promise<{ ok: boolean; config?: Record<string, unknown>; error?: string }>;
  /** UI 删除 RunConfig 时走这条. 同 upsert: 让 server 端 cache 立即一致. */
  removeServiceConfig?(workspaceRoot: string, id: string): Promise<{ ok: boolean; removed: boolean; error?: string }>;

  /* ── Browser Surface tools (B Day 2-) ── */
  /** B Day 2: 浏览器导航. 跟 agent 后面的 browser_navigate 工具用同一份实现. */
  browserNavigate?(args: { surfaceId: string; url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }):
    Promise<{ ok: boolean; url?: string; title?: string; error?: string }>;
  /** B Day 2: 浏览器截图. 返回 PNG/JPEG base64. */
  browserScreenshot?(args: { surfaceId: string; fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number }; format?: 'png' | 'jpeg'; quality?: number }):
    Promise<{ ok: boolean; base64?: string; width?: number; height?: number; error?: string }>;
  /** B Day 2: 当前 URL / title 状态. */
  browserGetState?(args: { surfaceId: string }):
    Promise<{ ok: boolean; url?: string; title?: string; error?: string }>;
  /* ── B Day 3: DOM 感知 + 交互. 全部委派到 browserTools — 类型也在那边定. ── */
  browserGetAriaTree?(args: any): Promise<any>;
  browserQuery?(args: any): Promise<any>;
  browserGetText?(args: any): Promise<any>;
  browserClick?(args: any): Promise<any>;
  browserType?(args: any): Promise<any>;
  browserPressKey?(args: any): Promise<any>;
  browserScroll?(args: any): Promise<any>;
  browserHover?(args: any): Promise<any>;
  browserSelectOption?(args: any): Promise<any>;
  browserFillForm?(args: any): Promise<any>;
  /* B Day 4: 等待 + 网络 */
  browserWaitFor?(args: any): Promise<any>;
  browserWaitForNavigation?(args: any): Promise<any>;
  browserGetConsoleLogs?(args: any): Promise<any>;
  browserGetNetwork?(args: any): Promise<any>;
  browserGetResponseBody?(args: any): Promise<any>;
  /* B Day 5: 导航补 + 断言 + eval */
  browserBack?(args: any): Promise<any>;
  browserForward?(args: any): Promise<any>;
  browserReload?(args: any): Promise<any>;
  browserExpect?(args: any): Promise<any>;
  browserEval?(args: any): Promise<any>;
  /* C Day 1: cookies / storage */
  browserGetCookies?(args: any): Promise<any>;
  browserSetCookies?(args: any): Promise<any>;
  browserClearCookies?(args: any): Promise<any>;
  browserGetLocalStorage?(args: any): Promise<any>;
  browserSetLocalStorage?(args: any): Promise<any>;
  /* C Day 2: 网络 mock + 文件上传 */
  browserMockResponse?(args: any): Promise<any>;
  browserClearMocks?(args: any): Promise<any>;
  browserListMocks?(args: any): Promise<any>;
  browserSetInputFiles?(args: any): Promise<any>;
  browserSetViewport?(args: any): Promise<any>;
  /** 用户从 UI 暂停后台任务 (SIGTSTP) — 不杀进程, 让它停在当前点 */
  pauseBackgroundTask?(pid: number): void;
  /** 用户从 UI 恢复被暂停的后台任务 (SIGCONT) */
  resumeBackgroundTask?(pid: number): void;
  /** 转正/取消转正 —— 后台任务默认会话级, 这是唯一的跨会话晋升途径 */
  setBackgroundTaskPersistent?(pid: number, persistent: boolean): void;
  /** xterm onData → PTY stdin (真·交互终端) */
  /** return true 表示真的写进了 helper daemon socket; false 表示没找到 pid 对应的 active socket
   *  (PTY 已退出 / daemon 重启过 / shellWorkerClient 模块状态不一致). 给 UI 端定位用. */
  sendShellStdin?(pid: number, data: string): boolean;
  /** xterm 容器尺寸变化 → PTY cols/rows */
  resizeShell?(pid: number, cols: number, rows: number): void;
  createLeaderTeam?(sessionId: string, goal: string): any;
  leaderRecruitMember?(sessionId: string, teamId: string, payload: { role: string; task: string; providerId?: string; model?: string }): any;
  leaderRequestCapability?(sessionId: string, teamId: string, capability: string, reason: string): any;
  getStewardRuntimeSnapshot?(sessionId: string): any;
  cancelCommitment?(sessionId: string, commitmentId: string): { success: boolean } | Promise<{ success: boolean }>;

  // ---- Session / Host 管理 ----
  setSandboxMode?(sessionId: string, enabled: boolean): void;
  setApprovalMode?(
    sessionId: string,
    mode: 'auto' | 'manual' | 'dangerous',
    options?: {
      scope?: 'global' | 'agent';
      scopeKey?: string;
      inherit?: boolean;
      dangerousConfirmation?: DangerousModeConfirmation;
    }
  ): void;
  /** per-session 审批模式读 — 真值 (DB seed + in-memory scopedModes) 而不是客户端缓存 */
  getApprovalMode?(sessionId: string): 'auto' | 'manual' | 'dangerous';
  compactSession?(sessionId: string, modelOverride?: string): Promise<void>;
  clearSession?(sessionId: string): void;
  /** 只忘不存档 —— 对话回退用 (见 server/main.ts forgetSession) */
  forgetSession?(sessionId: string): void;
  getContextHealth?(sessionId: string): any;
  getSessionInfo?(sessionId: string): Promise<any>;
  setCompressionMode?(sessionId: string, mode: 'sync' | 'async'): void;
  /** 设置页「上下文」的触发阈值 (0..1) 与自动压缩开关。undefined = 该项不动。 */
  setContextCompression?(
    sessionId: string,
    next: { mode?: 'sync' | 'async'; threshold?: number; autoEnabled?: boolean },
  ): void;
  interruptSession?(sessionId: string): void;
  pauseAll?(sessionId: string): { mainPaused: boolean; workersPaused: number };
  resumeAll?(sessionId: string): { mainResumed: boolean; workersResumed: number };
  pauseProcess?(pid: string): boolean;
  resumeProcess?(pid: string): boolean;

  // ---- Memory ----
  getMemoryStats?(sessionId: string): any;
  clearMemory?(sessionId: string): void;
  addMemoryMessage?(sessionId: string, role: string, content: string): void;
  setMemoryMessages?(sessionId: string, messages: import('@neoxlabs/kernel/types/index.js').Message[]): void;

  // ---- Tools ----
  getToolList?(): { count: number; names: string[] };
  reloadTools?(workDir: string): Promise<void>;

  // ---- Workspace ----
  setWorkspace?(workDir: string): Promise<void>;

  // ---- Checkpoint ----
  startCheckpointWatching?(sessionId: string): Promise<string | null>;
  stopCheckpointWatching?(): Promise<void>;
  createCheckpoint?(sessionId: string, label?: string): Promise<any>;
  rollbackToCheckpoint?(checkpointId: string): Promise<any>;
  rollbackSingleFile?(filePath: string): Promise<any>;
  reapplySingleFile?(filePath: string): Promise<any>;
  getCheckpoints?(limit?: number, sessionId?: string): Promise<any[]>;
  getCheckpointStats?(): Promise<any>;
  getCheckpointChanges?(): Promise<any[]>;
  setCheckpointEnabled?(enabled: boolean): void;
  isCheckpointEnabled?(): boolean;
  cleanupCheckpoints?(): Promise<void>;

  // ---- Host Introspection (从 Client Agent 迁移) ----
  getHostStatus?(): Promise<any>;
  getHostAgents?(): Promise<any[]>;
  getHostActivity?(limit?: number): Promise<any[]>;
  getHostSession?(): Promise<any>;
  getHostSystem?(): Promise<any>;
  hostInterrupt?(reason?: string): Promise<{ interrupted: boolean; taskId?: string }>;
  hostSendCommand?(text: string, priority?: string): Promise<any>;

  // ---- TTS ----
  setTTSEnabled?(enabled: boolean): void;
  isTTSEnabled?(): boolean;
  getTTSConfig?(): any;
  updateTTSConfig?(config: any): void;
  speakTTS?(text: string): Promise<{ audio: string; format: string; voiceSummary: string; durationMs?: number } | { error: string } | null>;

  // ---- STT (语音识别) ----
  transcribeAudio?(audioBase64: string, format?: string): Promise<{ text: string }>;

  // ---- MCP 管理 (Electron解耦) ----
  listMcpServers?(): any[];
  isMcpEnabled?(): boolean;
  setMcpEnabled?(enabled: boolean): void;
  addMcpServer?(scope: string, server: any): void;
  removeMcpServer?(scope: string, id: string): boolean | Promise<boolean>;
  updateMcpServer?(scope: string, id: string, updates: any): boolean;
  connectMcpServer?(id: string): Promise<void>;
  disconnectMcpServer?(id: string): Promise<void>;
  testMcpServer?(id: string): Promise<any>;
  getMcpServerTools?(id: string): Promise<any[]>;

  // ---- Skills 管理 (Electron解耦) ----
  listSkills?(options?: any): Promise<any[]>;
  getSkill?(id: string): Promise<any>;
  refreshSkills?(): Promise<void>;
  createSkill?(options: any): Promise<any>;
  deleteSkill?(id: string): Promise<any>;
  importSkillFromUrl?(url: string, target: string): Promise<any>;
  importSkillFromPath?(sourcePath: string, target: string): Promise<any>;
  getSkillDirs?(): { user: string; workspace: string };
  activateSkillsForPaths?(filePaths: string[]): string[];
  getSkillStats?(): { total: number; conditional: number; dynamic: number; commands: number };

  // ---- 代码索引 (Electron解耦) ----
  getIndexStats?(): Promise<any>;
  buildIndex?(force?: boolean): Promise<any>;
  clearIndex?(): Promise<void>;
  searchIndex?(query: string, kind?: string, limit?: number): Promise<any[]>;

  // ---- Version ----
  getVersion?(): string;

  // ---- Kernel Diagnostics ----
  getKernelDiagnostics?(): any;
}

// ============================================================================
// Server
// ============================================================================

export interface CreateServerResult {
  app: Hono;
  authGate: AuthGate;
  deviceManager: DeviceManager;
  channelRegistry: ChannelRegistry;
}

export function createNeoxServer(
  config: NeoxServerConfig,
  bridge: RuntimeBridge,
  bus: EventBus,
  deviceManager?: DeviceManager,
  sessionManager?: import('./sessionManager.js').SessionManager,
): CreateServerResult {
  const app = new Hono();

  // --- CORS ---
  const allowList = new Set(['tauri://localhost', ...(config.corsOrigins ?? [])]);
  const isLocalOrigin = (o: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

  app.use('*', cors({
    origin: (origin) => (!origin || isLocalOrigin(origin) || allowList.has(origin) ? origin || '*' : null),
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Device-Id'],
  }));

  // --- Auth 中间件（动态可控） ---
  const authGate = new AuthGate(config.auth);
  app.use('*', authGate.middleware());

  // --- 限流中间件 ---
  if (config.rateLimit) {
    app.use('*', rateLimitMiddleware(config.rateLimit));
  }

  // --- 设备中间件 ---
  const devices = deviceManager ?? new DeviceManager();
  app.use('*', deviceMiddleware(devices));

  app.use('*', async (c, next) => {
    const isHealth = c.req.path === '/health';
    const isInteractiveClient = !!c.req.header('x-neox-client');
    if (!isHealth || isInteractiveClient) {
      touchActivity();
    }
    if (c.req.path !== '/events' && c.req.path !== '/status' && c.req.path !== '/health') {
      cliLogger.info('SERVER', `${c.req.method} ${c.req.path}`);
    }
    await next();
  });

  // =========================================================================
  // SSE 事件流
  // =========================================================================

  app.get('/events', (c) => {
    const sessionId = c.req.query('sessionId') || undefined;
    const reconnect = c.req.query('reconnect') === 'true';
    const lastSeq = parseInt(c.req.query('last_seq') || '0', 10) || 0;

    cliLogger.info('SERVER', `SSE client ${reconnect ? 're' : ''}connected`, {
      sessionId: sessionId ?? 'all',
      lastSeq: lastSeq || undefined,
    });

    return streamSSE(c, async (stream) => {
      sseClientConnected();  // daemon 空闲退出: 有 SSE 客户端连着就不算空闲
      const sub = bus.subscribe(sessionId, lastSeq > 0 ? lastSeq : undefined);

      const heartbeat = setInterval(async () => {
        try {
          await stream.writeSSE({
            event: 'heartbeat',
            data: JSON.stringify({ ts: Date.now(), seq: bus.currentSeq }),
          });
        } catch (err: any) {
          cliLogger.debug('SERVER', `SSE heartbeat write failed (stream closed): ${err?.message}`);
        }
      }, 15_000);

      // 连接确认（带当前 seq 信息）
      await stream.writeSSE({
        event: 'connected',
        data: JSON.stringify({
          sessionId: sessionId ?? 'all',
          timestamp: Date.now(),
          reconnect,
          currentSeq: bus.currentSeq,
          capabilities: ['seq_num', 'replay_from_seq'],
        }),
      });

      // 仍然回放最近的 run_result（旧客户端行为）
      if (reconnect && sessionId && lastSeq === 0) {
        const lastResult = bus.getLastRunResult(sessionId);
        if (lastResult) {
          cliLogger.info('SERVER', `Replaying missed run_result for session ${sessionId}`);
          await stream.writeSSE({
            event: lastResult.type,
            data: JSON.stringify(lastResult),
          });
        }
      }

      try {
        for await (const event of sub) {
          await stream.writeSSE({
            id: String(event.seq),
            event: event.type,
            data: JSON.stringify(event),
          });
        }
      } catch (err: any) {
        cliLogger.debug('SERVER', `SSE event stream error (client disconnected): ${err?.message}`);
      } finally {
        clearInterval(heartbeat);
        sub.close();
        sseClientDisconnected();  // daemon 空闲退出: 客户端走了, 计数减
        cliLogger.info('SERVER', `SSE client disconnected`, { sessionId: sessionId ?? 'all' });
      }
    });
  });


  // =========================================================================
  // Chat
  // =========================================================================

  app.post('/session/:sessionId/chat', async (c) => {
    const { sessionId } = c.req.param();
    const body = await c.req.json<ChatRequest>();

    // 模式优先级: request.mode > device.preferredMode > global mode
    if (!body.mode) {
      const deviceId = c.req.header('x-device-id');
      if (deviceId) {
        const deviceMode = devices.getPreferredMode(deviceId);
        if (deviceMode) body.mode = deviceMode;
      }
    }

    assistantLog.info('CHAIN', `[L1] POST /session/${sessionId}/chat promptLen=${body.prompt?.length || 0} prompt="${(body.prompt || '').substring(0, 60)}" mode=${body.mode || 'default'} providerId=${body.providerId || 'none'} modelName=${body.modelName || 'none'}`);

    // 非阻塞启动，事件通过 SSE 推送
    bridge.chat(sessionId, body).catch(err => {
      assistantLog.error('CHAIN', `[L1] bridge.chat() THREW: ${err.message} sessionId=${sessionId}`, {
        stack: err?.stack,
        code: err?.code,
      });
      // eslint-disable-next-line no-console
      console.error(`[server] bridge.chat threw for ${sessionId}:`, err?.stack ?? err);
      try {
        const dir = nodePath.join(nodeOs.homedir(), NEOX_HOME_DIRNAME, 'logs');
        nodeFs.mkdirSync(dir, { recursive: true });
        nodeFs.appendFileSync(
          nodePath.join(dir, 'chat-errors.log'),
          `${new Date().toISOString()} session=${sessionId}\n${err?.stack ?? err}\n\n`,
        );
      } catch { /* 日志失败不影响主流程 */ }
      bus.publish({
        sessionId,
        type: 'error',
        data: { type: 'error', message: err?.message ?? String(err), code: err?.code, timestamp: Date.now() },
        timestamp: Date.now(),
      });
    });

    return c.json({ status: 'started', sessionId });
  });

  // =========================================================================
  // Abort
  // =========================================================================

  app.get('/session/:sessionId/run-state', (c) => {
    const { sessionId } = c.req.param();
    const snapshot = bridge.getRunState?.(sessionId)
      /* 老 bridge 没实现时给个保守兜底: 报 idle 会让 UI 假装空闲, 报 running 只会多显示
       * 一个停止按钮 — 用 activeSessions 这条已有证据, 拿不到就 idle。 */
      ?? {
        sessionId,
        status: (bridge.getActiveSessions().includes(sessionId) ? 'running' : 'idle') as RunStateSnapshot['status'],
        running: bridge.getActiveSessions().includes(sessionId),
        pendingToolCalls: [],
        updatedAt: 0,
        observedAt: Date.now(),
      };
    return c.json(snapshot);
  });

  /* 整表对账 — sessionIds 可选, 逗号分隔; 不传则只回非 idle 的会话。 */
  app.get('/run-states', (c) => {
    const raw = c.req.query('sessionIds');
    const ids = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const snapshots = bridge.getRunStates?.(ids)
      ?? bridge.getActiveSessions().map((sessionId) => ({
        sessionId,
        status: 'running' as const,
        running: true,
        pendingToolCalls: [],
        updatedAt: 0,
        observedAt: Date.now(),
      }));
    return c.json({ runStates: snapshots });
  });

  app.post('/session/:sessionId/abort', async (c) => {
    const { sessionId } = c.req.param();
    bridge.abort(sessionId);
    return c.json({ status: 'aborted', sessionId });
  });

  // =========================================================================
  // =========================================================================

  app.post('/session/:sessionId/pause', (c) => {
    const { sessionId } = c.req.param();
    const result = bridge.pauseAll?.(sessionId) ?? { mainPaused: false, workersPaused: 0 };
    return c.json(result);
  });

  app.post('/session/:sessionId/resume', (c) => {
    const { sessionId } = c.req.param();
    const result = bridge.resumeAll?.(sessionId) ?? { mainResumed: false, workersResumed: 0 };
    return c.json(result);
  });

  app.post('/process/:pid/pause', (c) => {
    const { pid } = c.req.param();
    const ok = bridge.pauseProcess?.(pid) ?? false;
    return c.json({ paused: ok });
  });

  app.post('/process/:pid/resume', (c) => {
    const { pid } = c.req.param();
    const ok = bridge.resumeProcess?.(pid) ?? false;
    return c.json({ resumed: ok });
  });

  // =========================================================================
  // Permission
  // =========================================================================

  app.post('/permission/:requestId/reply', async (c) => {
    const { requestId } = c.req.param();
    const body = await c.req.json<PermissionReply>();
    bridge.replyPermission(requestId, body.approved, body.message, body.remember);
    return c.json({ status: 'ok' });
  });

  app.post('/permission/:requestId/cancel', async (c) => {
    const { requestId } = c.req.param();
    const body = await c.req.json<PermissionCancelRequest>().catch(err => { cliLogger.debug('SERVER', `Non-critical: ${err?.message}`); return {} as PermissionCancelRequest; });
    bridge.cancelPermission?.(requestId, body.reason);
    return c.json({ status: 'ok' });
  });

  app.post('/ask-user/:requestId/reply', async (c) => {
    const { requestId } = c.req.param();
    const body = await c.req.json<AskUserReply>();
    /* bridge.replyAskUser 现在返 { status, reason? } — 'resolved' | 'resumed' | 'orphan'.
     * orphan = 答案丢失 (服务重启 + 磁盘记录也没了), UI 应当提示用户重发. */
    const result = await Promise.resolve(
      bridge.replyAskUser?.(requestId, body.answers || {}),
    );
    if (!result) return c.json({ status: 'orphan', reason: 'bridge_unavailable' });
    return c.json(result);
  });

  /* P3+: 服务治理面板要拿"完整 bg shell 列表" — agent 在 server 进程里跑,
   * processManager 是 server 这边的单例, electron main 那边的 processManager 是空的.
   * UI 走 SDK 来这个 endpoint 拿真实数据. */
  app.get('/background-tasks', async (c) => {
    const list = bridge.listBackgroundTasks?.() ?? [];
    return c.json({ tasks: list });
  });

  app.get('/service/history', async (c) => {
    const workspaceRoot = c.req.query('workspaceRoot');
    if (!workspaceRoot) return c.json({ instances: [], error: 'workspaceRoot required' }, 400);
    const instances = (await bridge.listServiceHistory?.(workspaceRoot)) ?? [];
    return c.json({ instances });
  });

  app.get('/service/log/:pid', (c) => {
    const pid = Number(c.req.param('pid'));
    if (!Number.isFinite(pid) || pid <= 0) return c.json({ output: '', error: 'invalid pid' }, 400);
    const st = c.req.query('startTime');
    const startTimeMs = st ? Number(st) : undefined;
    return c.json({ output: bridge.readServiceLog?.(pid, startTimeMs) ?? '' });
  });

  app.post('/background-task/:pid/kill', async (c) => {
    const pid = Number(c.req.param('pid'));
    if (!Number.isFinite(pid) || pid <= 0) {
      return c.json({ status: 'error', error: 'invalid pid' }, 400);
    }
    const body = await c.req.json<{ force?: boolean }>().catch(() => ({} as { force?: boolean }));
    bridge.killBackgroundTask?.(pid, body.force === true);
    return c.json({ status: 'ok' });
  });

  /* sub-agent 列表 / 终止 — 跟 background-task 是两条平行链路, 别 typo 成 background-task */
  app.get('/session/:sessionId/sub-agents', (c) => {
    const { sessionId } = c.req.param();
    const list = bridge.listSubAgents?.(sessionId) ?? [];
    return c.json({ agents: list });
  });

  app.post('/sub-agent/:agentId/abort', (c) => {
    const { agentId } = c.req.param();
    const r = bridge.abortSubAgent?.(agentId) ?? { ok: false };
    return c.json(r);
  });

  app.post('/background-task/:pid/untrack', (c) => {
    const pid = Number(c.req.param('pid'));
    if (!Number.isFinite(pid) || pid <= 0) {
      return c.json({ ok: false, removed: false, error: 'invalid pid' }, 400);
    }
    if (!bridge.untrackProcess) {
      return c.json({ ok: false, removed: false, error: 'bridge.untrackProcess not implemented' }, 501);
    }
    const r = bridge.untrackProcess(pid);
    return c.json(r);
  });

  /* P3-2: 从 UI 触发 RunConfig 启动. 必须落在 server 这边的 processManager —
   * Electron 主进程的 ProcessManager 是空壳 (没真进程), 直接调 serviceLauncher 起出来的服务
   * 在 process:list 里看不到, 用户感知为"启动按了没反应". 这里走 bridge 把启动委托回 server. */
  app.post('/service/start-config', async (c) => {
    const body = await c.req.json<{ workspaceRoot?: string; configId?: string; sessionId?: string }>().catch(() => ({} as any));
    if (!body.workspaceRoot || !body.configId) {
      return c.json({ ok: false, error: 'workspaceRoot and configId required' }, 400);
    }
    if (!bridge.startServiceByConfig) {
      return c.json({ ok: false, error: 'bridge.startServiceByConfig not implemented' }, 501);
    }
    const r = await bridge.startServiceByConfig(body.workspaceRoot, body.configId, body.sessionId);
    return c.json(r);
  });

  /* P3-1: Adopt — 把 ad-hoc pid 绑到一个新建的 RunConfig.
   *   electron-main 端直接调 processManager.bindConfig 对 server 端真进程无效 (跨进程),
   *   走这条路由让 server 自己 mark. */
  app.post('/service/bind-run-config', async (c) => {
    const body = await c.req.json<{ pid?: number; configId?: string }>().catch(() => ({} as any));
    const pid = Number(body.pid);
    if (!Number.isFinite(pid) || pid <= 0 || !body.configId) {
      return c.json({ ok: false, error: 'pid and configId required' }, 400);
    }
    if (!bridge.bindRunConfig) {
      return c.json({ ok: false, error: 'bridge.bindRunConfig not implemented' }, 501);
    }
    const r = bridge.bindRunConfig(pid, body.configId);
    return c.json(r);
  });

  /* P3+: UI 新建/编辑/复制 RunConfig 走 server, 让 server 端 cache 立刻一致.
   * 同款写盘+invalidate, electron-main 那边只是个透传, 真正持有运行时 cache 的是 server. */
  app.post('/service/upsert-config', async (c) => {
    const body = await c.req.json<{ workspaceRoot?: string; config?: Record<string, unknown> }>().catch(() => ({} as any));
    if (!body.workspaceRoot || !body.config) {
      return c.json({ ok: false, error: 'workspaceRoot and config required' }, 400);
    }
    if (!bridge.upsertServiceConfig) {
      return c.json({ ok: false, error: 'bridge.upsertServiceConfig not implemented' }, 501);
    }
    const r = await bridge.upsertServiceConfig(body.workspaceRoot, body.config);
    return c.json(r);
  });

  app.post('/service/remove-config', async (c) => {
    const body = await c.req.json<{ workspaceRoot?: string; id?: string }>().catch(() => ({} as any));
    if (!body.workspaceRoot || !body.id) {
      return c.json({ ok: false, removed: false, error: 'workspaceRoot and id required' }, 400);
    }
    if (!bridge.removeServiceConfig) {
      return c.json({ ok: false, removed: false, error: 'bridge.removeServiceConfig not implemented' }, 501);
    }
    const r = await bridge.removeServiceConfig(body.workspaceRoot, body.id);
    return c.json(r);
  });

  /* ── Browser Surface tools (B Day 2-) ──
   * 见 内部设计文档. server 端通过 Playwright connectOverCDP 拿到
   * 对应 BrowserView 的 Page (Electron 跑时带了 --remote-debugging-port). 所有
   * browser_* 工具走这些 endpoint, agent 后续也用同一份. */
  app.post('/browser/navigate', async (c) => {
    const body = await c.req.json<any>().catch(() => ({}));
    if (!body?.surfaceId || !body?.url) {
      return c.json({ ok: false, error: 'surfaceId and url required' }, 400);
    }
    if (!bridge.browserNavigate) {
      return c.json({ ok: false, error: 'bridge.browserNavigate not implemented' }, 501);
    }
    const r = await bridge.browserNavigate(body);
    return c.json(r);
  });

  app.post('/browser/screenshot', async (c) => {
    const body = await c.req.json<any>().catch(() => ({}));
    if (!body?.surfaceId) {
      return c.json({ ok: false, error: 'surfaceId required' }, 400);
    }
    if (!bridge.browserScreenshot) {
      return c.json({ ok: false, error: 'bridge.browserScreenshot not implemented' }, 501);
    }
    const r = await bridge.browserScreenshot(body);
    return c.json(r);
  });

  app.post('/browser/get-state', async (c) => {
    const body = await c.req.json<any>().catch(() => ({}));
    if (!body?.surfaceId) {
      return c.json({ ok: false, error: 'surfaceId required' }, 400);
    }
    if (!bridge.browserGetState) {
      return c.json({ ok: false, error: 'bridge.browserGetState not implemented' }, 501);
    }
    const r = await bridge.browserGetState(body);
    return c.json(r);
  });

  /* ── B Day 3 routes ──
   * 共同模板: 收 body, 校验 surfaceId 必填, 委托 bridge, 透传结果. 错误统一 ok:false. */
  const browserToolRoute = (path: string, bridgeMethod: keyof RuntimeBridge) => {
    app.post(`/browser/${path}`, async (c) => {
      const body = await c.req.json<any>().catch(() => ({}));
      if (!body?.surfaceId) return c.json({ ok: false, error: 'surfaceId required' }, 400);
      const fn = (bridge as any)[bridgeMethod];
      if (typeof fn !== 'function') return c.json({ ok: false, error: `bridge.${String(bridgeMethod)} not implemented` }, 501);
      const r = await fn(body);
      return c.json(r);
    });
  };
  browserToolRoute('get-aria-tree', 'browserGetAriaTree');
  browserToolRoute('query',          'browserQuery');
  browserToolRoute('get-text',       'browserGetText');
  browserToolRoute('click',          'browserClick');
  browserToolRoute('type',           'browserType');
  browserToolRoute('press-key',      'browserPressKey');
  browserToolRoute('scroll',         'browserScroll');
  browserToolRoute('hover',          'browserHover');
  browserToolRoute('select-option',  'browserSelectOption');
  browserToolRoute('fill-form',      'browserFillForm');
  /* B Day 4 — 等待 + 网络 */
  browserToolRoute('wait-for',            'browserWaitFor');
  browserToolRoute('wait-for-navigation', 'browserWaitForNavigation');
  browserToolRoute('get-console-logs',    'browserGetConsoleLogs');
  browserToolRoute('get-network',         'browserGetNetwork');
  browserToolRoute('get-response-body',   'browserGetResponseBody');
  /* B Day 5 — 导航补 + 断言 + eval */
  browserToolRoute('back',     'browserBack');
  browserToolRoute('forward',  'browserForward');
  browserToolRoute('reload',   'browserReload');
  browserToolRoute('expect',   'browserExpect');
  browserToolRoute('eval',     'browserEval');
  /* C Day 1 — cookies / storage */
  browserToolRoute('get-cookies',       'browserGetCookies');
  browserToolRoute('set-cookies',       'browserSetCookies');
  browserToolRoute('clear-cookies',     'browserClearCookies');
  browserToolRoute('get-local-storage', 'browserGetLocalStorage');
  browserToolRoute('set-local-storage', 'browserSetLocalStorage');
  /* C Day 2 — mock + file upload */
  browserToolRoute('mock-response',     'browserMockResponse');
  browserToolRoute('clear-mocks',       'browserClearMocks');
  browserToolRoute('list-mocks',        'browserListMocks');
  browserToolRoute('set-input-files',   'browserSetInputFiles');
  browserToolRoute('set-viewport',      'browserSetViewport');

  /* P4+: Logs 面板拉单个 pid 的累积输出 — server 端的 processManager 持有真实 buffer,
   * electron-main 端是空 singleton, UI 走这里跨进程拉. */
  app.get('/background-task/:pid/output', (c) => {
    const pid = Number(c.req.param('pid'));
    if (!Number.isFinite(pid) || pid <= 0) {
      return c.json({ status: 'error', error: 'invalid pid' }, 400);
    }
    const output = bridge.getBackgroundTaskOutput?.(pid) ?? '';
    return c.json({ output });
  });

  /* P5: Shell 控制台开一个独立可交互 PTY shell — UI 通过 xterm 双向接 stdin/stdout,
   * 跟 services 解耦. 走 helper daemon, 返回新 PTY 的 pid. */
  app.post('/shell/open-interactive', async (c) => {
    const body = await c.req.json<{ cwd?: string; command?: string }>().catch(() => ({}));
    const r = await bridge.openInteractiveShell?.(body) ?? { pid: null };
    return c.json(r);
  });

  app.post('/background-task/:pid/pause', (c) => {
    const pid = Number(c.req.param('pid'));
    if (!Number.isFinite(pid) || pid <= 0) {
      return c.json({ status: 'error', error: 'invalid pid' }, 400);
    }
    bridge.pauseBackgroundTask?.(pid);
    return c.json({ status: 'ok' });
  });

  app.post('/background-task/:pid/resume', (c) => {
    const pid = Number(c.req.param('pid'));
    if (!Number.isFinite(pid) || pid <= 0) {
      return c.json({ status: 'error', error: 'invalid pid' }, 400);
    }
    bridge.resumeBackgroundTask?.(pid);
    return c.json({ status: 'ok' });
  });

  /* 转正 / 取消转正. body = { persistent: boolean } */
  app.post('/background-task/:pid/persistent', async (c) => {
    const pid = Number(c.req.param('pid'));
    if (!Number.isFinite(pid) || pid <= 0) {
      return c.json({ status: 'error', error: 'invalid pid' }, 400);
    }
    let persistent = true;
    try {
      const body = await c.req.json().catch(() => ({}));
      persistent = (body as { persistent?: unknown })?.persistent !== false;
    } catch { /* 无 body 视为转正 */ }
    bridge.setBackgroundTaskPersistent?.(pid, persistent);
    return c.json({ status: 'ok' });
  });

  /* xterm onData → PTY stdin. body = { data: string } */
  app.post('/shell/:pid/stdin', async (c) => {
    const pid = Number(c.req.param('pid'));
    if (!Number.isFinite(pid) || pid <= 0) {
      return c.json({ status: 'error', error: 'invalid pid' }, 400);
    }
    const body = await c.req.json<{ data?: string }>().catch(() => ({} as { data?: string }));
    if (typeof body.data !== 'string') {
      return c.json({ status: 'error', error: 'data must be string' }, 400);
    }
    const delivered = bridge.sendShellStdin?.(pid, body.data) ?? false;
    return c.json({ status: 'ok', delivered });
  });

  /* xterm 容器尺寸变化 → PTY cols/rows. body = { cols, rows } */
  app.post('/shell/:pid/resize', async (c) => {
    const pid = Number(c.req.param('pid'));
    if (!Number.isFinite(pid) || pid <= 0) {
      return c.json({ status: 'error', error: 'invalid pid' }, 400);
    }
    const body = await c.req.json<{ cols?: number; rows?: number }>().catch(() => ({} as { cols?: number; rows?: number }));
    const cols = Number(body.cols);
    const rows = Number(body.rows);
    if (!Number.isFinite(cols) || cols <= 0 || !Number.isFinite(rows) || rows <= 0) {
      return c.json({ status: 'error', error: 'invalid cols/rows' }, 400);
    }
    bridge.resizeShell?.(pid, cols | 0, rows | 0);
    return c.json({ status: 'ok' });
  });

  // =========================================================================
  // Run Mode
  // =========================================================================

  app.get('/mode', (c) => {
    return c.json({ mode: bridge.getRunMode?.() ?? 'agentic' });
  });

  app.post('/mode', async (c) => {
    const { mode } = await c.req.json<{ mode: string }>();
    bridge.setRunMode?.(mode);
    return c.json({ status: 'ok', mode });
  });

  // =========================================================================
  // Inject Message (Network mode)
  // =========================================================================

  app.post('/session/:sessionId/inject', async (c) => {
    const { sessionId } = c.req.param();
    const { message, images } = await c.req.json<{
      message: string;
      images?: Array<{ mediaType: string; data: string; name?: string }>;
    }>();
    const position = bridge.injectMessage?.(sessionId, message, images);
    const queued = typeof position === 'number' && position > 0;
    const detail = queued ? undefined : bridge.describeInjectTarget?.(sessionId);
    return c.json({ status: queued ? 'ok' : 'not_queued', queued, position: position ?? 0, ...(detail ? { detail } : {}) });
  });

  // 撤回最后一条排队消息 → 返回其文本, 客户端把它放回输入框编辑
  app.post('/session/:sessionId/dequeue-last', async (c) => {
    const { sessionId } = c.req.param();
    const text = bridge.removeLastPendingMessage?.(sessionId) ?? null;
    return c.json({ status: 'ok', text });
  });

  app.post('/session/:sessionId/assistant/team', async (c) => {
    const { sessionId } = c.req.param();
    const { goal } = await c.req.json<{ goal: string }>();
    const team = await bridge.createLeaderTeam?.(sessionId, goal);
    return c.json(team ?? { error: 'Failed to create team' });
  });

  app.post('/session/:sessionId/assistant/team/:teamId/recruit', async (c) => {
    const { sessionId, teamId } = c.req.param();
    const payload = await c.req.json<{ role: string; task: string; providerId?: string; model?: string }>();
    const result = await bridge.leaderRecruitMember?.(sessionId, teamId, payload);
    return c.json(result ?? { error: 'Failed to recruit member' });
  });

  app.post('/session/:sessionId/assistant/team/:teamId/capability', async (c) => {
    const { sessionId, teamId } = c.req.param();
    const { capability, reason } = await c.req.json<{ capability: string; reason: string }>();
    const result = await bridge.leaderRequestCapability?.(sessionId, teamId, capability, reason);
    return c.json(result ?? { error: 'Failed to request capability' });
  });

  app.get('/session/:sessionId/assistant/steward-snapshot', async (c) => {
    const { sessionId } = c.req.param();
    const snapshot = await bridge.getStewardRuntimeSnapshot?.(sessionId);
    return c.json(snapshot ?? { error: 'Failed to get steward snapshot' });
  });

  app.post('/session/:sessionId/assistant/cancel-commitment', async (c) => {
    const { sessionId } = c.req.param();
    const { commitmentId } = await c.req.json<{ commitmentId: string }>();
    const result = await bridge.cancelCommitment?.(sessionId, commitmentId);
    return c.json(result ?? { success: false });
  });

  // =========================================================================
  // Session / Host 管理
  // =========================================================================

  app.post('/session/:sessionId/sandbox', async (c) => {
    const { sessionId } = c.req.param();
    const { enabled } = await c.req.json<{ enabled: boolean }>();
    bridge.setSandboxMode?.(sessionId, enabled);
    return c.json({ status: 'ok', enabled });
  });

  app.get('/session/:sessionId/approval', (c) => {
    const { sessionId } = c.req.param();
    const mode = bridge.getApprovalMode?.(sessionId) ?? 'auto';
    return c.json({ mode });
  });

  app.post('/session/:sessionId/approval', async (c) => {
    const { sessionId } = c.req.param();
    const body = await c.req.json<{
      mode: 'auto' | 'manual' | 'dangerous';
      scope?: 'global' | 'agent';
      scopeKey?: string;
      inherit?: boolean;
      dangerousConfirmation?: DangerousModeConfirmation;
    }>();
    if (body.mode === 'dangerous' && !hasDangerousModeDoubleConfirmation(body.dangerousConfirmation)) {
      return c.json({
        status: 'error',
        code: 'dangerous_confirmation_required',
        message: 'Dangerous mode requires double confirmation',
      }, 400);
    }
    bridge.setApprovalMode?.(sessionId, body.mode, {
      scope: body.scope,
      scopeKey: body.scopeKey,
      inherit: body.inherit,
      dangerousConfirmation: body.dangerousConfirmation,
    });
    return c.json({
      status: 'ok',
      mode: body.mode,
      scope: body.scope,
      scopeKey: body.scopeKey,
      inherit: body.inherit === true,
    });
  });

  app.post('/session/:sessionId/compact', async (c) => {
    const { sessionId } = c.req.param();
    try {
      const body = await c.req.json().catch(() => ({} as any));
      const modelOverride = typeof body?.model === 'string' && body.model ? body.model : undefined;
      await bridge.compactSession?.(sessionId, modelOverride);
      return c.json({ status: 'ok' });
    } catch (err: any) {
      const msg = err?.message || String(err);
      cliLogger.error('SERVER', `compact failed for ${sessionId}: ${msg}`, { stack: err?.stack });
      writeStallFile('error', 'COMPACT', `compact failed: ${msg}`, { sessionId, stack: err?.stack });
      return c.text(`压缩失败: ${msg}`, 500);
    }
  });

  app.post('/session/:sessionId/clear', async (c) => {
    const { sessionId } = c.req.param();
    bridge.clearSession?.(sessionId);
    return c.json({ status: 'ok' });
  });

  app.post('/session/:sessionId/forget', async (c) => {
    const { sessionId } = c.req.param();
    bridge.forgetSession?.(sessionId);
    return c.json({ status: 'ok' });
  });

  app.post('/session/:sessionId/agent-mode', async (c) => {
    const { sessionId } = c.req.param();
    const body = await c.req.json().catch(() => ({} as any));
    const applied = bridge.setAgentMode?.(sessionId, String(body?.mode ?? '')) ?? 'code';
    return c.json({ status: 'ok', agentMode: applied });
  });

  app.get('/session/:sessionId/agent-mode', (c) => {
    const { sessionId } = c.req.param();
    return c.json({ agentMode: bridge.getAgentMode?.(sessionId) ?? 'code' });
  });

  app.get('/session/:sessionId/context-health', (c) => {
    const { sessionId } = c.req.param();
    const health = bridge.getContextHealth?.(sessionId);
    return c.json(health ?? null);
  });

  app.get('/session/:sessionId/info', async (c) => {
    const { sessionId } = c.req.param();
    const info = await bridge.getSessionInfo?.(sessionId);
    return c.json(info ?? null);
  });

  app.post('/session/:sessionId/compression', async (c) => {
    const { sessionId } = c.req.param();
    const { mode } = await c.req.json<{ mode: 'sync' | 'async' }>();
    bridge.setCompressionMode?.(sessionId, mode);
    return c.json({ status: 'ok', mode });
  });

  /* 触发阈值 / 自动压缩开关 — 跟上面的 compression 分开, 因为它俩语义不同:
   * mode 是"怎么压", 这里是"什么时候压 / 压不压"。 */
  app.post('/session/:sessionId/context-compression', async (c) => {
    const { sessionId } = c.req.param();
    const next = await c.req.json<{
      mode?: 'sync' | 'async';
      threshold?: number;
      autoEnabled?: boolean;
    }>();
    bridge.setContextCompression?.(sessionId, next);
    return c.json({ status: 'ok', ...next });
  });

  // =========================================================================
  // Memory
  // =========================================================================

  app.get('/session/:sessionId/memory', (c) => {
    const { sessionId } = c.req.param();
    const stats = bridge.getMemoryStats?.(sessionId);
    return c.json(stats ?? null);
  });

  app.post('/session/:sessionId/memory/clear', (c) => {
    const { sessionId } = c.req.param();
    bridge.clearMemory?.(sessionId);
    return c.json({ status: 'ok' });
  });

  app.post('/session/:sessionId/memory/add', async (c) => {
    const { sessionId } = c.req.param();
    const { role, content } = await c.req.json<{ role: string; content: string }>();
    bridge.addMemoryMessage?.(sessionId, role, content);
    return c.json({ status: 'ok' });
  });

  app.post('/session/:sessionId/memory/set', async (c) => {
    const { sessionId } = c.req.param();
    const { messages } = await c.req.json<{ messages: import('@neoxlabs/kernel/types/index.js').Message[] }>();
    bridge.setMemoryMessages?.(sessionId, Array.isArray(messages) ? messages : []);
    return c.json({ status: 'ok' });
  });

  // =========================================================================
  // Tools
  // =========================================================================

  app.get('/tools', (c) => {
    const list = bridge.getToolList?.();
    return c.json(list ?? { count: 0, names: [] });
  });

  app.post('/tools/reload', async (c) => {
    const { workDir } = await c.req.json<{ workDir: string }>();
    await bridge.reloadTools?.(workDir);
    return c.json({ status: 'ok' });
  });

  // =========================================================================
  // Workspace
  // =========================================================================

  app.post('/workspace', async (c) => {
    const { workDir } = await c.req.json<{ workDir: string }>();
    await bridge.setWorkspace?.(workDir);
    return c.json({ status: 'ok', workDir });
  });

  // =========================================================================
  // Checkpoint
  // =========================================================================

  app.post('/checkpoint/start-watching', async (c) => {
    const { sessionId } = await c.req.json<{ sessionId: string }>();
    const id = await bridge.startCheckpointWatching?.(sessionId);
    return c.json({ checkpointId: id });
  });

  app.post('/checkpoint/stop-watching', async (c) => {
    await bridge.stopCheckpointWatching?.();
    return c.json({ status: 'ok' });
  });

  app.post('/checkpoint/create', async (c) => {
    const { sessionId, label } = await c.req.json<{ sessionId: string; label?: string }>();
    const checkpoint = await bridge.createCheckpoint?.(sessionId, label);
    return c.json(checkpoint ?? null);
  });

  app.post('/checkpoint/rollback', async (c) => {
    const { checkpointId } = await c.req.json<{ checkpointId: string }>();
    const result = await bridge.rollbackToCheckpoint?.(checkpointId);
    return c.json(result ?? { success: false });
  });

  app.post('/checkpoint/rollback-file', async (c) => {
    const { filePath } = await c.req.json<{ filePath: string }>();
    const result = await bridge.rollbackSingleFile?.(filePath);
    return c.json(result ?? { success: false });
  });

  app.post('/checkpoint/reapply-file', async (c) => {
    const { filePath } = await c.req.json<{ filePath: string }>();
    const result = await bridge.reapplySingleFile?.(filePath);
    return c.json(result ?? { success: false });
  });

  app.get('/checkpoints', async (c) => {
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined;
    const sessionId = c.req.query('sessionId') || undefined;
    const list = await bridge.getCheckpoints?.(limit, sessionId);
    return c.json(list ?? []);
  });

  app.get('/checkpoint/stats', async (c) => {
    const stats = await bridge.getCheckpointStats?.();
    return c.json(stats ?? { created: 0, modified: 0, deleted: 0, directories: 0, total: 0 });
  });

  app.get('/checkpoint/changes', async (c) => {
    const changes = await bridge.getCheckpointChanges?.();
    return c.json(changes ?? []);
  });

  app.post('/checkpoint/enabled', async (c) => {
    const { enabled } = await c.req.json<{ enabled: boolean }>();
    bridge.setCheckpointEnabled?.(enabled);
    return c.json({ status: 'ok', enabled });
  });

  app.get('/checkpoint/enabled', (c) => {
    const enabled = bridge.isCheckpointEnabled?.() ?? true;
    return c.json({ enabled });
  });

  app.post('/checkpoint/cleanup', async (c) => {
    await bridge.cleanupCheckpoints?.();
    return c.json({ status: 'ok' });
  });

  // =========================================================================
  // Status
  // =========================================================================

  app.get('/status', (c) => {
    return c.json({
      status: 'ok',
      uptime: process.uptime(),
      pid: process.pid,
      workDir: config.workDir,
      activeSessions: bridge.getActiveSessions(),
      mode: bridge.getRunMode?.() ?? 'agentic',
      version: bridge.getVersion?.() ?? '',
    });
  });

  // =========================================================================
  // Health (简单探活)
  // =========================================================================

  app.get('/health', (c) => c.text('ok'));

  if (process.env.NEOX_EDITION === 'lite') {
    /* 先把 handler 装进路由表 —— 表是 import 时的副作用填的, 极简版后端没有任何
     * 别的东西 import 它们。少了这一步, 下面的转发端点存在但表是空的,
     * 每一条调用都回 "没有注册 channel", renderer 第一个调用就崩在启动。
     *
     * 动态 import 而不是静态: 依赖方向是 core 在下 desktop 在上, 静态 import
     * 会形成反向依赖 (typecheck 当场报)。这里按运行时相对路径取同目录的打包产物。 */
    /* 把 EventBus 交给 desktop 侧的广播出口 (services/rendererBroadcast.ts)。
     *
     * 极简版没有 BrowserWindow, 那边推给渲染层的事件要改走 SSE, 而 SSE 的源头就是这条总线。
     * 走 globalThis 是因为依赖方向: desktop 在上、core 在下, core 不能 import desktop,
     * desktop 也不该反过来去 import core 的 server 实例。 */
    (globalThis as any).__neoxServerEventBus__ = bus;

    void (async () => {
      try {
        /* 说明符走变量, 不写成字面量。
         *
         * 这是**运行时**依赖: liteHandlers.js 是 desktop 侧的独立打包产物,
         * 跟 server/main.js 同目录, 编译期在 core 的源码树里根本不存在
         * (写成字面量 typecheck 会报 TS2307 —— 而那不是错, 是这条路本来的样子)。
         * 依赖方向也不允许 core 静态 import desktop。 */
        const spec = './liteHandlers.js';
        const mod = await import(spec);
        mod.registerLiteBridgedHandlers?.();
      } catch (e: any) {
        /* 这一步失败 = 极简版整个界面起不来, 必须喊出来, 绝不能静默吞掉。 */
        // eslint-disable-next-line no-console
        console.error('[lite] IPC 桥 handler 装载失败, 界面将无法启动:', e?.message ?? e);
      }
    })();

    app.get('/oauth/callback', async (c) => {
      const full = new URL(c.req.url);
      const ok = await (async () => {
        /* oauthFlow 的实例在 desktop 那侧 (authHandlers 里), 而依赖方向是 core 在下、
         * desktop 在上 —— core 不能 import 它。走 globalThis 交接, 跟 EventBus 同一个办法。 */
        try {
          const flow = (globalThis as any).__neoxOAuthFlow__;
          return await flow?.handleDeepLink?.(full.toString());
        } catch { return false; }
      })();
      return c.html(
        `<!doctype html><meta charset="utf-8"><title>Neox Lite</title>`
        + `<body style="font:15px/1.6 -apple-system,system-ui;display:grid;place-items:center;height:90vh;margin:0;background:#111;color:#eee">`
        + `<div style="text-align:center">`
        + (ok
          ? `<h2 style="font-weight:600">登录完成</h2><p style="opacity:.7">回到 Neox Lite 继续吧, 这个页面可以关了。</p>`
          : `<h2 style="font-weight:600">这次回调没被接住</h2><p style="opacity:.7">可能是登录已超时或已在别处完成。回 Neox Lite 重新点一次登录。</p>`)
        + `</div></body>`,
      );
    });

    app.post('/ipc/:channel', async (c) => {
      const channel = c.req.param('channel');
      let args: unknown[] = [];
      try {
        const body = await c.req.json<{ args?: unknown[] }>();
        if (Array.isArray(body?.args)) args = body.args;
      } catch { /* 无 body = 无参调用 */ }
      try {
        const { invokeBridge } = await import('@neoxlabs/platform/shared/ipc.js');
        return c.json({ ok: true, value: await invokeBridge(channel, args) });
      } catch (e: any) {
        /* 把原始错误原样带回去 —— renderer 侧的调用方大量靠 message 判分支,
         * 吞成一句通用错误会让上层走错路。 */
        return c.json({ ok: false, error: e?.message ?? String(e) }, 500);
      }
    });
  }

  if (process.env.NEOX_LITE_PROBE === '1') {
    app.get('/__probe', (c) => {
      // eslint-disable-next-line no-console
      console.error('[probe]', c.req.query('s') ?? '');
      return c.text('ok');
    });
    app.get('/__shimlog', (c) => {
      // eslint-disable-next-line no-console
      console.error(`[renderer:${c.req.query('tag')}]`, c.req.query('m') ?? '');
      return c.text('ok');
    });
  }

  // =========================================================================
  // =========================================================================

  if (sessionManager) {
    /** 列举所有会话 */
    app.get('/sessions', (c) => {
      const status = c.req.query('status') as any;
      const deviceId = c.req.query('deviceId');
      return c.json(sessionManager.list({ status, deviceId: deviceId || undefined }));
    });

    /** 创建会话 */
    app.post('/sessions', async (c) => {
      const body = await c.req.json<{ title?: string; deviceId?: string; mode?: string }>();
      const deviceId = body.deviceId || c.req.header('x-device-id') || 'unknown';
      try {
        const session = sessionManager.create({
          ownerDeviceId: deviceId,
          title: body.title,
          workDir: config.workDir,
          mode: body.mode,
        });
        return c.json(session, 201);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    });

    /** 获取单个会话 */
    app.get('/sessions/:id', (c) => {
      const session = sessionManager.get(c.req.param('id'));
      if (!session) return c.json({ error: 'Session not found' }, 404);
      return c.json({
        ...session,
        subscribers: Array.from(session.subscribers),
      });
    });

    /** 归档会话 */
    app.post('/sessions/:id/archive', (c) => {
      const ok = sessionManager.archive(c.req.param('id'));
      return ok ? c.json({ status: 'archived' }) : c.json({ error: 'Not found or already archived' }, 404);
    });

    /** 销毁会话 */
    app.delete('/sessions/:id', (c) => {
      const id = c.req.param('id');
      bus.clearSessionBuffer(id);
      const ok = sessionManager.destroy(id);
      return ok ? c.json({ status: 'destroyed' }) : c.json({ error: 'Not found' }, 404);
    });

    /** Bump epoch（重连时调用） */
    app.post('/sessions/:id/reconnect', (c) => {
      try {
        const newEpoch = sessionManager.bumpEpoch(c.req.param('id'));
        return c.json({ epoch: newEpoch, seqHighWater: bus.getSeqHighWater(c.req.param('id')) });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 404);
      }
    });

    /** 订阅会话（设备加入） */
    app.post('/sessions/:id/subscribe', async (c) => {
      const body = await c.req.json<{ deviceId: string }>();
      const ok = sessionManager.subscribe(c.req.param('id'), body.deviceId);
      return ok ? c.json({ status: 'subscribed' }) : c.json({ error: 'Session not found or inactive' }, 404);
    });

    /** 取消订阅 */
    app.post('/sessions/:id/unsubscribe', async (c) => {
      const body = await c.req.json<{ deviceId: string }>();
      sessionManager.unsubscribe(c.req.param('id'), body.deviceId);
      return c.json({ status: 'unsubscribed' });
    });
  }

  // =========================================================================
  // =========================================================================

  app.get('/kernel/diagnostics', (c) => {
    const diagnostics = bridge.getKernelDiagnostics?.();
    if (!diagnostics) {
      return c.json({ status: 'inactive', message: 'Kernel not active' }, 200);
    }
    return c.json({ status: 'active', ...diagnostics });
  });

  // =========================================================================
  // TTS 控制
  // =========================================================================

  app.post('/tts', async (c) => {
    const { enabled } = await c.req.json<{ enabled: boolean }>();
    bridge.setTTSEnabled?.(enabled);
    return c.json({ enabled: bridge.isTTSEnabled?.() ?? false });
  });

  /* /tts/speak —— 一次性合成任意文本 (消息脚注"重新朗读") */
  app.post('/tts/speak', async (c) => {
    if (!bridge.speakTTS) return c.json({ error: 'TTS 未启用' }, 501);
    const { text } = await c.req.json<{ text: string }>();
    if (!text?.trim()) return c.json({ error: '缺少 text' }, 400);
    try {
      const result = await bridge.speakTTS(text);
      if (!result) return c.json({ error: '合成失败 — 检查设置里的语音合成配置' }, 502);
      if ('error' in result) return c.json({ error: result.error }, 502);
      return c.json(result);
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 502);
    }
  });

  /* /tts/config —— 全量同步 TTS 配置 (provider/voice/speed/format/...) 到运行中 daemon.
   * 设置页改 provider (edge↔neoxcloud) 走这里即时 re-init, 不必重启 app. */
  app.post('/tts/config', async (c) => {
    const { config } = await c.req.json<{ config: any }>();
    bridge.updateTTSConfig?.(config ?? {});
    return c.json({ enabled: bridge.isTTSEnabled?.() ?? false });
  });

  /* /audio/transcribe —— 输入框语音按钮: base64 音频 → 网关 ASR → 文本.
   * 渲染端录音 (MediaRecorder) → 主进程 IPC → 这里 → 网关 /n1/audio/transcriptions. */
  app.post('/audio/transcribe', async (c) => {
    if (!bridge.transcribeAudio) {
      return c.json({ error: 'STT 未启用' }, 501);
    }
    const { audio, format } = await c.req.json<{ audio: string; format?: string }>();
    if (!audio) {
      return c.json({ error: '缺少 audio 字段' }, 400);
    }
    try {
      const result = await bridge.transcribeAudio(audio, format);
      return c.json(result);
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 502);
    }
  });

  app.get('/tts', (c) => {
    return c.json({
      enabled: bridge.isTTSEnabled?.() ?? false,
      config: bridge.getTTSConfig?.() ?? { enabled: false },
    });
  });

  // =========================================================================
  // Device Management (从 Client Agent 迁移)
  // =========================================================================

  app.post('/device/register', async (c) => {
    const { device, capabilities } = await c.req.json<{
      device: DeviceInfo;
      capabilities: Capability[];
    }>();
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      || c.req.header('x-real-ip')
      || getRemoteAddressFromContextEnv(c.env)
      || 'unknown';
    const deviceId = devices.register(device, capabilities, ip);
    cliLogger.info('SERVER', `Device registered: ${device.type} - ${device.name} (${deviceId})`);
    return c.json({ deviceId, status: 'registered' });
  });

  app.get('/device/:deviceId', (c) => {
    const { deviceId } = c.req.param();
    const device = devices.getDevice(deviceId);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    return c.json(device);
  });

  app.get('/devices', (c) => {
    const all = devices.getAll();
    return c.json({ count: all.length, devices: all });
  });

  app.delete('/device/:deviceId', (c) => {
    const { deviceId } = c.req.param();
    const removed = devices.removeDevice(deviceId);
    return c.json({ status: removed ? 'removed' : 'not_found' });
  });

  // 设备级运行模式偏好
  app.post('/device/:deviceId/mode', async (c) => {
    const { deviceId } = c.req.param();
    const { mode } = await c.req.json<{ mode: string }>();
    devices.setPreferredMode(deviceId, mode);
    return c.json({ status: 'ok', deviceId, mode });
  });

  app.get('/device/:deviceId/mode', (c) => {
    const { deviceId } = c.req.param();
    const device = devices.getDevice(deviceId);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    return c.json({ mode: device.preferredMode ?? bridge.getRunMode?.() ?? 'agentic' });
  });

  // =========================================================================
  // Host Introspection (从 Client Agent hostTools 迁移)
  // =========================================================================

  app.get('/host/status', async (c) => {
    const status = await bridge.getHostStatus?.();
    return c.json(status ?? { error: 'not available' });
  });

  app.get('/host/agents', async (c) => {
    const agents = await bridge.getHostAgents?.();
    return c.json(agents ?? []);
  });

  app.get('/host/activity', async (c) => {
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!) : 10;
    const activity = await bridge.getHostActivity?.(limit);
    return c.json(activity ?? []);
  });

  app.get('/host/session', async (c) => {
    const session = await bridge.getHostSession?.();
    return c.json(session ?? null);
  });

  app.get('/host/system', async (c) => {
    const system = await bridge.getHostSystem?.();
    return c.json(system ?? null);
  });

  app.post('/host/interrupt', async (c) => {
    const { reason } = await c.req.json<{ reason?: string }>().catch(err => { cliLogger.debug('SERVER', `Non-critical: ${err?.message}`); return { reason: undefined }; });
    const result = await bridge.hostInterrupt?.(reason);
    return c.json(result ?? { interrupted: false });
  });

  app.post('/host/command', async (c) => {
    const { text, priority } = await c.req.json<{ text: string; priority?: string }>();
    const result = await bridge.hostSendCommand?.(text, priority);
    return c.json(result ?? { queued: false });
  });

  // =========================================================================
  // Admin — 运行时 auth 控制（仅本地可调用）
  // =========================================================================

  const localOnly: MiddlewareHandler = async (c, next) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      || c.req.header('x-real-ip')
      || getRemoteAddressFromContextEnv(c.env);
    const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
    if (!ip || !LOCAL.has(ip)) {
      return c.json({ error: 'Admin endpoints are local-only' }, 403);
    }
    return next();
  };

  app.get('/admin/auth', localOnly, (c) => {
    return c.json({ enabled: authGate.enabled, hasToken: !!authGate.token });
  });

  app.post('/admin/auth', localOnly, async (c) => {
    const { enabled, token } = await c.req.json<{ enabled?: boolean; token?: string }>();
    if (token) authGate.updateToken(token);
    if (enabled === true && token) authGate.enable(token);
    else if (enabled === true && authGate.token) authGate.enable(authGate.token);
    else if (enabled === false) authGate.disable();
    cliLogger.info('SERVER', `Auth ${authGate.enabled ? 'enabled' : 'disabled'}`);
    return c.json({ enabled: authGate.enabled });
  });

  // =========================================================================
  // Channel 适配器
  // =========================================================================

  /* channel 在 initRuntimeBridge 里已经组好并启动 (桌面/CLI/server 三端同一份); server 只是把 HTTP 入口接上去 */
  const channelRegistry = bridge.channels ?? new ChannelRegistry();

  app.get('/channels', (c) => {
    return c.json(channelRegistry.list());
  });

  app.post('/channels/:id/toggle', async (c) => {
    const { id } = c.req.param();
    const { enabled } = await c.req.json<{ enabled: boolean }>();
    const ok = await channelRegistry.toggle(id, enabled);
    return c.json({ status: ok ? 'ok' : 'not_found', id, enabled });
  });

  app.post('/webhook/:channelId', async (c) => {
    const { channelId } = c.req.param();
    const signature = c.req.header('x-hub-signature-256') || c.req.header('x-signature');
    /* 先取原文再解析: GitHub 的 HMAC 是对原始字节算的, JSON.stringify 一遍就对不上了 */
    const rawBody = await c.req.text();
    let body: unknown;
    try { body = JSON.parse(rawBody); } catch { return c.json({ error: 'body is not JSON' }, 400); }
    try {
      const reply = await channelRegistry.handleWebhook(channelId, body, {
        signature, rawBody, event: c.req.header('x-github-event'),
      });
      if (reply === null) {
        return c.json({ error: 'Channel not found or disabled' }, 404);
      }
      return c.json({ reply });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  // =========================================================================
  // =========================================================================

  app.get('/mcp/servers', (c) => {
    const list = bridge.listMcpServers?.() ?? [];
    return c.json(list);
  });

  app.get('/mcp/enabled', (c) => {
    const enabled = bridge.isMcpEnabled?.() ?? false;
    return c.json({ enabled });
  });

  app.post('/mcp/enabled', async (c) => {
    const { enabled } = await c.req.json<{ enabled: boolean }>();
    bridge.setMcpEnabled?.(enabled);
    return c.json({ status: 'ok', enabled });
  });

  app.post('/mcp/servers', async (c) => {
    const { scope, server } = await c.req.json<{ scope: string; server: any }>();
    try {
      bridge.addMcpServer?.(scope, server);
      return c.json({ status: 'ok' });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.delete('/mcp/servers/:id', async (c) => {
    const { id } = c.req.param();
    const scope = c.req.query('scope') || 'global';
    try {
      const result = (await bridge.removeMcpServer?.(scope, id)) ?? false;
      return c.json({ status: result ? 'ok' : 'not_found' });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.patch('/mcp/servers/:id', async (c) => {
    const { id } = c.req.param();
    const { scope, updates } = await c.req.json<{ scope: string; updates: any }>();
    try {
      const result = bridge.updateMcpServer?.(scope, id, updates) ?? false;
      return c.json({ status: result ? 'ok' : 'not_found' });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.post('/mcp/servers/:id/connect', async (c) => {
    const { id } = c.req.param();
    try {
      await bridge.connectMcpServer?.(id);
      return c.json({ status: 'ok' });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.post('/mcp/servers/:id/disconnect', async (c) => {
    const { id } = c.req.param();
    try {
      await bridge.disconnectMcpServer?.(id);
      return c.json({ status: 'ok' });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.post('/mcp/servers/:id/test', async (c) => {
    const { id } = c.req.param();
    try {
      const result = await bridge.testMcpServer?.(id);
      return c.json({ status: 'ok', ...(result ?? {}) });
    } catch (e: any) {
      return c.json({ error: e.message, toolCount: 0, tools: [] }, 400);
    }
  });

  app.get('/mcp/servers/:id/tools', async (c) => {
    const { id } = c.req.param();
    try {
      const tools = await bridge.getMcpServerTools?.(id);
      return c.json({ tools: tools ?? [] });
    } catch (e: any) {
      return c.json({ error: e.message, tools: [] }, 400);
    }
  });

  // =========================================================================
  // =========================================================================

  app.get('/skills', async (c) => {
    const scope = c.req.query('scope');
    const category = c.req.query('category');
    try {
      const list = await bridge.listSkills?.({ scope, category }) ?? [];
      return c.json(list);
    } catch (e: any) {
      return c.json([], 200);
    }
  });

  app.get('/skills/:id', async (c) => {
    const { id } = c.req.param();
    try {
      const skill = await bridge.getSkill?.(id);
      return c.json(skill ?? null);
    } catch (err: any) {
      cliLogger.debug('SERVER', `Get skill ${id} failed: ${err?.message}`);
      return c.json(null);
    }
  });

  app.post('/skills/refresh', async (c) => {
    try {
      await bridge.refreshSkills?.();
      return c.json({ status: 'ok' });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.post('/skills', async (c) => {
    const body = await c.req.json();
    try {
      const result = await bridge.createSkill?.(body);
      return c.json(result ?? null);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.delete('/skills/:id', async (c) => {
    const { id } = c.req.param();
    try {
      const result = await bridge.deleteSkill?.(id);
      return c.json(result ?? { success: false });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.post('/skills/import-url', async (c) => {
    const { url, target } = await c.req.json<{ url: string; target: string }>();
    try {
      const result = await bridge.importSkillFromUrl?.(url, target);
      return c.json(result ?? null);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.post('/skills/import-path', async (c) => {
    const { sourcePath, target } = await c.req.json<{ sourcePath: string; target: string }>();
    try {
      const result = await bridge.importSkillFromPath?.(sourcePath, target);
      return c.json(result ?? null);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.get('/skills/dirs', (c) => {
    const dirs = bridge.getSkillDirs?.();
    return c.json(dirs ?? { user: '', workspace: '' });
  });

  app.post('/skills/activate', async (c) => {
    try {
      const { filePaths } = await c.req.json<{ filePaths: string[] }>();
      const activated = bridge.activateSkillsForPaths?.(filePaths) ?? [];
      return c.json({ activated });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.get('/skills/stats', (c) => {
    const stats = bridge.getSkillStats?.() ?? { total: 0, conditional: 0, dynamic: 0, commands: 0 };
    return c.json(stats);
  });

  // =========================================================================
  // =========================================================================

  app.get('/index/stats', async (c) => {
    try {
      const stats = await bridge.getIndexStats?.();
      return c.json(stats ?? { hasIndex: false, fileCount: 0, symbolCount: 0, lastUpdated: null, size: 0 });
    } catch (err: any) {
      cliLogger.debug('SERVER', `Index stats failed: ${err?.message}`);
      return c.json({ hasIndex: false, fileCount: 0, symbolCount: 0, lastUpdated: null, size: 0 });
    }
  });

  app.post('/index/build', async (c) => {
    const { force } = await c.req.json<{ force?: boolean }>().catch(err => { cliLogger.debug('SERVER', `Non-critical: ${err?.message}`); return { force: false }; });
    try {
      const result = await bridge.buildIndex?.(force);
      return c.json(result ?? { success: false, filesIndexed: 0, symbolsFound: 0, timeMs: 0, errors: [] });
    } catch (e: any) {
      return c.json({ success: false, filesIndexed: 0, symbolsFound: 0, timeMs: 0, errors: [{ file: '', error: e.message }] });
    }
  });

  app.post('/index/clear', async (c) => {
    try {
      await bridge.clearIndex?.();
      return c.json({ status: 'ok' });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.post('/index/search', async (c) => {
    const { query, kind, limit } = await c.req.json<{ query: string; kind?: string; limit?: number }>();
    try {
      const results = await bridge.searchIndex?.(query, kind, limit) ?? [];
      return c.json(results);
    } catch (err: any) {
      cliLogger.debug('SERVER', `Index search failed: ${err?.message}`);
      return c.json([]);
    }
  });

  return { app, authGate, deviceManager: devices, channelRegistry };
}
