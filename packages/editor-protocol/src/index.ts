
export const EDITOR_PROTOCOL_VERSION = 1;

/* ── 基本类型 ── */

export type ApprovalMode = 'auto' | 'manual' | 'dangerous';

export interface ModelRef {
  providerId: string;
  modelName: string;
}

/** 模型来源 (选择器按它分组, 计费完全不同):
 *   cloud    订阅套餐里的 (走账号额度, providerId = neox-cloud)
 *   platform 按量, 从平台余额按官方价扣 (providerId = neox-cloud-payg; 套餐里也有的同样单独一条)
 *   byok     用户自己加的服务商, 花自己的 key */
export type ModelSource = 'cloud' | 'platform' | 'byok';

/** 按量模型要知道「从哪个 providerId 选」—— 跟 core providerResolver 的路由记号一致 */
export const PLATFORM_PROVIDER_ID = 'neox-cloud-payg';

export interface ModelEntry {
  providerId: string;
  providerName: string;
  model: string;
  source: ModelSource;
  /** 服务端给的显示名 (cloud / platform) */
  displayName?: string;
  /** cloud: 当前套餐能不能用 (false = 灰显不可选, 网关会直接拒) */
  allowed?: boolean;
  /** cloud: 是否含在套餐额度里 (false = 超出部分按量) */
  included?: boolean;
  /** 额度消耗速度, claude-sonnet-5 = 1.0 (cloud 已含套餐倍率; platform 按官方价算)。缺 = 不画消耗条 */
  relativeCost?: number | null;
  /** platform: 官方价, 美元 / 百万 token */
  price?: { inputPerMtok: number; outputPerMtok: number };
  /** 能看图 (服务端权威; 缺 = 不知道) */
  vision?: boolean;
}

/** 按量 (平台余额) 的状态: 余额 + 能不能扣 (额外用量关着 / 没余额 都不能) */
export interface PlatformBalance {
  balanceUsd: number;
  usable: boolean;
  blockedReason: 'extra_usage_off' | 'no_balance' | null;
}

export interface SessionSummary {
  id: string;
  title: string;
  /** epoch ms */
  updatedAt: number;
}

/** 历史回放的一项 (从库里的消息重建; 过程态如思考 / 审批不在里面) */
export type HistoryItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  /** text = 一行摘要 (路径 / 命令); args = 调用参数, 长字符串已截断 */
  | { kind: 'tool'; name: string; text: string; args?: Record<string, unknown> };

export interface InitializeResult {
  protocol: number;
  cliVersion: string;
  /** 引擎的工作目录 (= 插件起进程时的 cwd) */
  workDir: string;
  workspaceName: string;
  account: {
    /** 这个发行版有没有 Neox 账号 (开源版没有, 只能用自己的 Key) */
    supported: boolean;
    loggedIn: boolean;
    email: string | null;
  };
  /** 当前默认模型; null = 还没登录也没加过 Key */
  model: ModelRef | null;
  hasProvider: boolean;
}

/* ── 请求 (插件 → 引擎) ── */

/** 插件自报家门: 名字 + 能替引擎做哪些编辑器侧的事 */
export interface EditorClientInfo {
  name: string;
  version?: string;
  capabilities?: {
    /** 能回 editor/diagnostics (编辑器的实时诊断) —— 引擎据此把 read_lints 放上工具桌 */
    diagnostics?: boolean;
  };
}

export interface EditorRpcMethods {
  /** 第一个请求。client 决定引擎开哪些编辑器能力 (引擎起运行时之前就得知道) */
  initialize: { params: { client?: EditorClientInfo }; result: InitializeResult };

  /** 浏览器登录: 拿到授权地址时发 auth/url 通知; 用户在浏览器里完成后才返回 */
  'auth.login': { params: Record<string, never>; result: { email: string; model: ModelRef | null } };
  'auth.cancelLogin': { params: Record<string, never>; result: Record<string, never> };
  'auth.logout': { params: Record<string, never>; result: { serverRevokeFailed: boolean } };

  /** plan = 套餐名 (没登录 = null); platform = 按量余额 (没登录 / 老服务端 = null) */
  'models.list': { params: Record<string, never>; result: { models: ModelEntry[]; current: ModelRef | null; errors: string[]; plan?: string | null; platform?: PlatformBalance | null } };
  /** 设为默认 (落盘, 跟 CLI / 桌面共用配置) */
  'model.set': { params: ModelRef; result: { model: ModelRef | null } };
  /** 加一个自带 Key 的服务商并设为默认 */
  'providers.add': {
    params: { name: string; protocol: 'openai' | 'anthropic' | 'openai-responses'; baseUrl?: string; apiKey: string; models: string[] };
    result: { model: ModelRef | null };
  };

  /** 当前工作目录下的会话, 新的在前, 最多 100 条 */
  'sessions.list': { params: Record<string, never>; result: { sessions: SessionSummary[] } };
  'session.history': { params: { sessionId: string }; result: { items: HistoryItem[] } };
  'session.delete': { params: { sessionId: string }; result: Record<string, never> };

  /**
   * 发一条消息。立即返回 sessionId (没传就新建会话), 过程和结束都走 event 通知,
   * 以 run_result 收尾。approvalMode 只作用于这个会话。
   */
  'chat.send': {
    params: { sessionId?: string; prompt: string; approvalMode?: ApprovalMode } & Partial<ModelRef>;
    result: { sessionId: string };
  };
  'chat.abort': { params: { sessionId: string }; result: Record<string, never> };

  /** 回复 approval_needed; remember = 以后同类操作不再问 */
  'approval.reply': { params: { requestId: string; approved: boolean; remember?: boolean }; result: Record<string, never> };
  /** 回复 ask_user_needed; answers 以问题原文为键 */
  'askUser.reply': { params: { requestId: string; answers: Record<string, string> }; result: { status: string } };
  /** 只改这个会话的审批档 (不动全局配置) */
  'approvalMode.set': { params: { sessionId: string; mode: ApprovalMode }; result: { mode: ApprovalMode } };
}

export type EditorRpcMethod = keyof EditorRpcMethods;
export type EditorRpcParams<M extends EditorRpcMethod> = EditorRpcMethods[M]['params'];
export type EditorRpcResult<M extends EditorRpcMethod> = EditorRpcMethods[M]['result'];

/** 错误码 (JSON-RPC error.code) */
export const EditorRpcErrorCode = {
  ParseError: -32700,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32000,
  /** 这个发行版没有账号体系 */
  NoAccount: -32001,
  /** 没有可用模型: 先登录或加 Key */
  NoModel: -32002,
} as const;

/* ── 引擎 → 插件的请求 (编辑器能力) ── */

export interface EditorDiagnostic {
  /** 相对工作目录的路径 (工作目录外的给绝对路径) */
  path: string;
  /** 1-based */
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: string;
}

export interface EditorHostRequests {
  /** 编辑器当前的诊断 (VS Code 的「问题」面板) —— read_lints 用 */
  'editor/diagnostics': { params: { paths?: string[]; limit?: number }; result: { items: EditorDiagnostic[] } };
}

export type EditorHostMethod = keyof EditorHostRequests;

/* ── 通知 (引擎 → 插件) ── */

export interface EditorNotifications {
  /** 进程起来了, 可以发请求 */
  ready: { protocol: number };
  /** 登录授权地址; opened = 引擎已经替用户打开了浏览器 */
  'auth/url': { url: string; opened: boolean };
  /** 某个会话的运行事件 (只有主 agent 的, 子 agent 不转) */
  event: { sessionId?: string; event: EditorEvent };
}

export type EditorNotificationMethod = keyof EditorNotifications;

/* ── 运行事件 (event 通知里的 event) ──
 * 引擎运行时事件的子集, 只列插件用得到的字段。长字符串已截断 (discardedText 除外)。 */

export interface ToolArgs { [k: string]: unknown }

export type EditorEvent =
  | { type: 'text'; delta: string }
  | { type: 'text_complete' }
  | { type: 'reasoning'; delta: string }
  | { type: 'thinking'; iteration?: number }
  | { type: 'tool_call_start'; name: string; toolId?: string; args?: ToolArgs; targetPath?: string; description?: string }
  | {
    type: 'tool_call_end'; name: string; success: boolean; toolId?: string; args?: ToolArgs; targetPath?: string;
    /** 给人看的输出: 引擎已拆掉工具回执的 JSON 信封 (取 content), 再截断 */
    output?: string;
    /** 一句话结果 (如 `"sum" — 2 matches`) */
    summary?: string;
    /** 后台命令 (bash_output) 的退出码; 前台命令的退出码在 output 末尾的 `[exit N]` 行 */
    exitCode?: number;
    /** 被守卫拦下 (不是工具跑失败); userNotice = 给用户看的一句话 */
    blockedBy?: string; userNotice?: string;
  }
  | { type: 'approval_needed'; requestId: string; toolName: string; args?: ToolArgs; reason?: string; allowRemember?: boolean }
  | { type: 'approval_cancelled'; requestId: string; reason: string; approved?: boolean }
  | {
    type: 'ask_user_needed'; requestId: string; timeoutSec?: number;
    questions: Array<{ question: string; options?: Array<{ label: string; description?: string }> }>;
  }
  | { type: 'ask_user_expired'; requestId: string; reason?: 'timeout' | 'aborted' }
  | { type: 'stream_retry'; attempt: number; maxRetries: number; discardedText?: string; discardPartialToolCalls?: boolean }
  | { type: 'plan_update'; explanation?: string; plan: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }> }
  | { type: 'context_compaction'; status: 'started' | 'compressing' | 'completed' }
  | { type: 'session_title_generated'; sessionId: string; title: string }
  | { type: 'token_usage'; [k: string]: unknown }
  | { type: 'run_result'; output?: string; interrupted?: boolean; failed?: boolean; interruptReason?: string }
  | { type: 'error'; message: string; code?: string };

export type EditorEventType = EditorEvent['type'];

/** 引擎转发给插件的事件类型 —— 其余 (tool_call_delta / memory_snapshot ...) 不过管道 */
export const FORWARDED_EVENT_TYPES: readonly EditorEventType[] = [
  'text', 'text_complete', 'reasoning', 'thinking',
  'tool_call_start', 'tool_call_end',
  'approval_needed', 'approval_cancelled', 'ask_user_needed', 'ask_user_expired',
  'stream_retry', 'plan_update', 'context_compaction',
  'session_title_generated', 'token_usage', 'run_result', 'error',
];

/** 转给插件前字符串字段截到这么长 */
export const MAX_EVENT_STRING_CHARS = 8000;
