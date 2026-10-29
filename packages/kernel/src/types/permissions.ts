/**
 * Permission System for Tools
 * 工具权限系统 - 整合 Cursor 风格的模式 + Claude Code 风格的权限
 */

/**
 * Agent 运行模式
 * - ask: 只读模式，只允许读取工具
 * - agent: 标准模式，所有工具需要确认（基于权限配置）
 * - auto: 自动模式，所有工具自动批准
 */
export enum AgentMode {
  /** 只读模式 - 只允许读取操作 */
  ASK = 'ask',
  /** 标准代理模式 - 允许所有工具，但需要确认 */
  AGENT = 'agent',
  /** 自动模式 - 所有工具自动批准 */
  AUTO = 'auto',
}

/**
 * 工具权限级别（Claude Code 风格）
 * - allow: 自动允许，无需确认
 * - ask: 需要用户确认
 * - deny: 禁止使用
 */
export enum ToolPermission {
  /** 自动允许 */
  ALLOW = 'allow',
  /** 需要用户确认 */
  ASK = 'ask',
  /** 禁止使用 */
  DENY = 'deny',
}

/**
 * Sandbox Mode — 权限**范围**三档.
 *
 * 跟 AgentMode 是**正交维度**:
 *   AgentMode 控制 "做了要不要问用户" (ask/agent/auto)
 *   SandboxMode 控制 "本次会话允许做什么类型的操作" (read-only/workspace-write/danger-full-access)
 *
 * 实际生效优先级: SandboxMode 是硬约束 (read-only 模式下任何 write 都直接拒, 不走 AgentMode 询问).
 *
 * - READ_ONLY: 只允许读 (readfile / grep / search / git status / curl GET / 等). write/edit/shell
 *   写命令 / git mutate 全部直接拒, 不走审批. 适合: code review / 分析 / 不希望被改的探索.
 * - WORKSPACE_WRITE: 可读, 可改 workspace 内文件 / 跑 shell, 但出工作区路径 (~/.config /etc) 需审批.
 *   默认 + 最常用.
 * - DANGER_FULL_ACCESS: 全开, 任何操作不审批 (toolRiskEvaluator 标 critical 的仍要拦).
 *   适合: 一次性 demo / 一次性脚本 / 用户明确知道在干嘛的场景.
 */
export enum SandboxMode {
  READ_ONLY = 'read-only',
  WORKSPACE_WRITE = 'workspace-write',
  DANGER_FULL_ACCESS = 'danger-full-access',
}

/** 默认 sandbox mode (不设置时行为等同于 'workspace-write') */
export const DEFAULT_SANDBOX_MODE: SandboxMode = SandboxMode.WORKSPACE_WRITE;

/**
 * 工具分类（用于自动判断权限）
 */
export enum ToolCategory {
  /** 只读操作（文件读取、代码搜索等） */
  READ = 'read',
  /** 写入操作（文件编辑、创建等） */
  WRITE = 'write',
  /** 执行操作（运行命令、脚本等） */
  EXECUTE = 'execute',
  /** 网络操作（API 调用、网页抓取等） */
  NETWORK = 'network',
  /** 系统操作（环境变量、配置等） */
  SYSTEM = 'system',
}

/**
 * 工具权限配置
 */
export interface ToolPermissionConfig {
  /** 工具名称 */
  toolName: string;
  /** 权限级别 */
  permission: ToolPermission;
  /** 权限理由（用于向用户解释为什么需要此权限） */
  reason?: string;
  /** 是否允许记住此次选择 */
  allowRemember?: boolean;
}

/**
 * 拒绝种类 —— 结构化的"为什么拒绝"，让 UI 能精确展示而不需要解析 reason 字符串。
 *
 * - 'denied_by_user'  用户在 approval UI 上点了拒绝
 * - 'denied_by_config' 工具的权限配置直接 deny（auto-deny tool）
 * - 'denied_by_mode'  当前 approval mode 不允许（例如 ASK 模式但工具没标记 allowInAskMode）
 * - 'denied_by_hook'  beforeToolCall hook 否决
 * - 'denied_by_skill_scope' (K2) 当前在 limited skill scope 下, 工具不在 skill.allowedTools 里
 * - 'error'           检查过程出错
 */
export type DenyKind =
  | 'denied_by_user'
  | 'denied_by_config'
  | 'denied_by_mode'
  | 'denied_by_hook'
  | 'denied_by_skill_scope'
  | 'error';

/**
 * 权限决策结果
 */
export interface PermissionDecision {
  /** 是否允许执行 */
  allowed: boolean;
  /** 权限来源 */
  source: 'config' | 'mode' | 'user' | 'remembered';
  /** 拒绝原因（如果不允许） */
  reason?: string;
  /**
   * 拒绝种类 —— 比 reason 字符串更稳定的结构化字段。
   * UI / agent 应该优先用这个判断"是不是用户拒绝"而不是匹配 reason 文本。
   */
  denyKind?: DenyKind;
  /** 是否需要用户确认 */
  needsApproval?: boolean;
  /** 用户是否要求记住此次选择 */
  remember?: boolean;
}

/**
 * 工具权限元数据（附加到 Tool 接口）
 */
export interface ToolPermissionMetadata {
  /** 工具分类 */
  category: ToolCategory;
  /** 默认权限级别 */
  defaultPermission?: ToolPermission;
  /** 权限说明 */
  permissionReason?: string;
  /** 是否允许在 ASK 模式下使用 */
  allowInAskMode?: boolean;
}

/**
 * 用户的权限记忆（记住用户的选择）
 */
export interface PermissionMemory {
  /** 工具名称 */
  toolName: string;
  /** 用户的选择 */
  decision: boolean; // true = allow, false = deny
  /** 记忆时间 */
  timestamp: number;
  /** 过期时间（可选，默认永久） */
  expiresAt?: number;
}

/**
 * 权限上下文（传递给权限检查器）
 */
export interface PermissionContext {
  /** 当前模式 */
  mode: AgentMode;
  /** 工具名称 */
  toolName: string;
  /** 工具参数 */
  toolArgs: Record<string, any>;
  /** 工具分类 */
  toolCategory: ToolCategory;
  /** 当前迭代次数 */
  iteration: number;
  /** 是否已有记忆 */
  hasMemory?: boolean;
}
