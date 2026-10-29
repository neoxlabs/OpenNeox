/**
 * Plugin System — 核心类型定义
 *
 * 设计参考:
 * - Claude Code: marketplace + policy + multi-scope
 * - Codex Rust: SKILL.md + MCP deps + permission profiles
 * - VS Code: plugin.json manifest + 目录结构
 */

import type { PluginConnectorDefinition } from './plugin-connector.js';
import type { PluginExternalAgentDefinition } from './plugin-external-agent.js';

export type { PluginConnectorDefinition, PluginExternalAgentDefinition };

// ============================================================================
// Plugin Manifest (plugin.json)
// ============================================================================

export interface PluginManifest {
  /** 插件唯一名称 (lowercase + hyphens, max 64 chars) */
  name: string;
  /** 语义化版本号 */
  version: string;
  /** 一句话描述 */
  description: string;
  /** 作者信息 */
  author: PluginAuthor;

  // 可选 metadata
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  category?: PluginCategory;
  /** 图标文件路径 (相对于插件根目录) */
  icon?: string;

  /**
   * 插件形态 — 决定安装 UX / 权限默认值 / 市场筛选.
   * - module: 全访问能力包 (Computer Use、短剧制作、领域编辑器…)
   * - skill / tool / mcp / hook / agent / bundle: 传统分发单元
   * - auth: 官方订阅 OAuth 等凭据插件 (暂不接入产物)
   */
  kind?: PluginKind;

  /** 能力标签 (可多选), 如 computer-use / drama / oauth-codex */
  capabilities?: string[];

  // 组件声明 (相对于插件根目录的路径)
  /** Skill 目录或文件 */
  skills?: string[];
  /** Tool 模块 (TS/JS, export createTools(): Tool[]) */
  tools?: string[];
  /** Hook 配置 */
  hooks?: string | PluginHookConfig;
  /** MCP Server 配置 */
  mcpServers?: Record<string, PluginMcpServerConfig>;
  /** Agent 定义 (.md) */
  agents?: string[];
  /** Slash Command 定义 (.md) */
  commands?: string[];
  /** UI 面板 (侧边栏 / 工作区 / 底部面板) */
  views?: PluginViewDefinition[];
  /**
   * 声明式第三方平台接入 (T0 · 无代码)。
   *
   * 这是「连接万物」的载体: 插件只声明 (capability, HTTP 映射, 权限理由),
   * 宿主负责闸门与凭据注入 —— 插件全程拿不到 token。没有可执行代码,
   * 所以可以自动上架, 也是绝大多数 connector 的形态。
   *
   * 见 shared/plugin-connector.ts 的能力契约。
   */
  connector?: PluginConnectorDefinition;
  /**
   * 外部 Agent 委派 (T2 · 跑在用户本机)。
   *
   * 把活派给用户机器上已装好的另一个 agent CLI (Codex / Claude Code / …),
   * 进程由宿主起 —— worktree 隔离、流式接 timeline、可中断、有超时。
   * 插件交的是命令行映射表, 不是可执行代码。
   *
   * 见 shared/plugin-external-agent.ts。
   */
  externalAgents?: PluginExternalAgentDefinition[];
  /**
   * 官方订阅 OAuth AuthProvider 入口 (`kind: "auth"`).
   * 宿主动态 import entry，调用 export 工厂拿到 AuthProvider。
   */
  authProvider?: PluginAuthProviderDefinition;

  // 权限声明
  permissions?: PluginPermissions;

  // 依赖
  dependencies?: PluginDependencies;

  // 用户可配置项
  userConfig?: Record<string, PluginConfigField>;

  // 兼容性
  engines?: { neox?: string };
  platform?: NodeJS.Platform[];
}

export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

export type PluginCategory =
  | 'devops'
  | 'database'
  | 'web'
  | 'testing'
  | 'ai-ml'
  | 'security'
  | 'language'
  | 'productivity'
  | 'documentation'
  | 'community'
  | 'media'
  | 'automation'
  | 'connector'
  | 'auth';

export type PluginKind =
  | 'module'   // 全访问扩展模块 (默认高权限, 安装需确认)
  | 'skill'
  | 'tool'
  | 'mcp'
  | 'hook'
  | 'agent'
  | 'bundle'
  | 'connector' // 声明式第三方平台接入 (见 manifest.connector)
  | 'auth';   // 订阅 OAuth 等 (Codex/Claude/Grok), 暂不打包进发布

export interface PluginPermissions {
  /** 依赖的内置工具 */
  tools?: string[];
  /** 需要网络访问 */
  network?: boolean;
  /**
   * 全访问模块: 声明后安装页强调风险, 运行时仍受 sandbox / 用户确认约束.
   * Computer Use / 系统自动化类插件应显式设为 true.
   */
  fullAccess?: boolean;
  /** 文件系统权限 */
  filesystem?: {
    read?: string[];
    write?: string[];
  };
}

export interface PluginDependencies {
  /** 依赖的其他插件 ("name" 或 "name@registry") */
  plugins?: string[];
  /** npm 依赖 (自动安装到插件目录) */
  npm?: string[];
  /** 需要的环境变量 */
  env?: string[];
}

export interface PluginConfigField {
  type: 'string' | 'number' | 'boolean' | 'select';
  description: string;
  /** 中文界面显示的说明 (可选, 详情页设置表单用) */
  descriptionZh?: string;
  default?: string | number | boolean;
  options?: string[];
  /** 敏感字段 (API key 等)，存入安全存储 */
  sensitive?: boolean;
}

export interface PluginHookConfig {
  preToolCall?: PluginHookEntry[];
  postToolCall?: PluginHookEntry[];
}

export interface PluginHookEntry {
  /** 匹配的工具名 (glob) */
  toolPattern: string;
  /** 执行的命令或脚本路径 */
  command: string;
}

export interface PluginMcpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: 'stdio' | 'http';
}

// ============================================================================
// UI View — 供 PPT / 视频 / 领域专属编辑器挂载
// ============================================================================

export type PluginViewLocation =
  /** 左侧边栏 tab (图标 + 面板) */
  | 'sidebar'
  /** 工作区主区 tab (作为文件类型关联) */
  | 'workspace'
  /** 底部面板 tab (类似 终端 / 输出) */
  | 'panel';

/**
 * Auth 插件声明 — 对应 plugin.json `authProvider`.
 * 实现包在插件目录内自带 (不依赖宿主打包 @neoxlabs/oauth-*).
 */
export interface PluginAuthProviderDefinition {
  /** 稳定 id: claude / codex / grok / ... */
  id: string;
  /** UI 显示名 */
  displayName: string;
  /** 相对插件根的 ESM 入口 (如 index.js) */
  entry: string;
  /** 工厂导出名 (如 createClaudeAuthProvider) */
  export: string;
}

export interface PluginViewDefinition {
  /** 视图唯一 id (形如 'ppt.editor', 'video.timeline') */
  id: string;
  /** 显示标题 */
  title: string;
  /** 展示位置 */
  location: PluginViewLocation;
  /** 图标 (相对于插件根目录的文件路径 / 或 emoji 字符) */
  icon?: string;
  /** HTML 入口文件 (相对于插件根目录), 会在 iframe 中加载 */
  entry: string;
  /** 激活条件 (类 VSCode when 子集, 可选).
   *  例如 'resourceExtname == .pptx' — 只有打开 .pptx 文件时激活
   *  暂不强制, 仅记录. */
  when?: string;
  /** 默认宽度/高度 (仅供 sidebar/panel 使用, 可选) */
  preferredSize?: { width?: number; height?: number };
}

// ============================================================================
// Installed Plugin Record
// ============================================================================

export interface InstalledPlugin {
  /** 插件名 */
  name: string;
  /** 已安装版本 */
  version: string;
  /** 安装路径 */
  installPath: string;
  /** 来源 */
  source: PluginSource;
  /** 是否启用 */
  enabled: boolean;
  /** 安装时间 */
  installedAt: string;
  /** 更新时间 */
  updatedAt?: string;
  /** 用户配置 */
  userConfig?: Record<string, any>;
  /** 解析后的清单 (缓存) */
  manifest?: PluginManifest;
  /**
   * 安装时的包信任级别。
   *
   *   只有走 .neox-plugin 导入这条路才有值 —— 目录安装 / 本地目录装没有包清单
   *   可校验。记在安装记录上而不是只在安装那一刻提示: 用户三个月后想知道
   *   「我装的这个到底是不是官方的」, 得能查得到。
   */
  trust?: 'official' | 'signed-unknown' | 'unsigned';
}

export type PluginSource =
  | { type: 'marketplace'; registry: string }
  | { type: 'url'; url: string }
  | { type: 'local'; path: string }
  | { type: 'dev'; path: string };

// ============================================================================
// Plugin Registry (registry.json)
// ============================================================================

export interface PluginRegistryData {
  version: 1;
  plugins: Record<string, InstalledPlugin>;
}

// ============================================================================
// Marketplace Types
// ============================================================================

export interface MarketplacePlugin {
  name: string;
  version: string;
  description: string;
  author: PluginAuthor;
  category: PluginCategory;
  keywords: string[];
  icon?: string;
  downloads: number;
  rating: number;
  ratingCount: number;
  featured?: boolean;
  official?: boolean;
  publishedAt: string;
  source: MarketplacePluginSource;
  /** 市场侧插件形态 (与 PluginManifest.kind 对齐) */
  kind?: PluginKind;
  /** @deprecated 用 kind; 保留兼容旧市场 JSON */
  pluginType?: string;
  capabilities?: string[];
  /**
   * 分面 (多值) —— 市场按「能帮我干什么」分类, 由清单贡献点推导。
   * 服务端返回; 老服务端没有这个字段时客户端从 manifest 兜底推导。
   * 见 shared/plugin-facets.ts。
   */
  facets?: string[];
  /** 完整清单 (服务端存的那份), 客户端用它兜底推导 facets */
  manifest?: Record<string, unknown>;
  i18n?: Record<string, { description?: string; displayName?: string }>;
  /** 老字段: 中文描述。新服务端从 i18n.zh 派生, 老服务端一直是空 */
  descriptionZh?: string | null;
}

export type MarketplacePluginSource =
  /** 官方分发格式 .neox-plugin: 带逐文件哈希清单 + 可选签名 */
  | { type: 'package'; url: string; sha256?: string }
  | { type: 'tarball'; url: string }
  | { type: 'git'; repo: string; ref?: string };

// ============================================================================
// Plugin Load Result
// ============================================================================

export interface PluginLoadResult {
  /** 插件名 */
  name: string;
  /** 是否加载成功 */
  success: boolean;
  /** 加载的组件计数 */
  loaded: {
    skills: number;
    tools: number;
    hooks: number;
    mcpServers: number;
    agents: number;
    commands: number;
    views: number;
    authProviders: number;
    /** connector 贡献的 Agent 工具数 */
    connectorTools: number;
    /** externalAgents 贡献的 Agent 工具数 */
    externalAgents: number;
  };
  /** 错误信息 */
  errors: string[];
}

// ============================================================================
// Plugin Events
// ============================================================================

export type PluginEventType =
  | 'installed'
  | 'uninstalled'
  | 'enabled'
  | 'disabled'
  | 'updated'
  | 'loaded'
  | 'error';

export interface PluginEvent {
  type: PluginEventType;
  pluginName: string;
  version?: string;
  message?: string;
  timestamp: number;
}

export type PluginEventCallback = (event: PluginEvent) => void;

/* 插件的模式可见性 / 主流判定 (纯函数, 无依赖) —— 渲染端插件页从这里拿。
 * 渲染端原来深引 shared/pluginModes.js, 3.7.0 发包被 check:boundaries 拦下 (深引面只减不增);
 * plugin-types.js 是渲染端已有的公开入口, 从这里转出。 */
export { isMainstreamPlugin, isPluginVisibleInMode } from './pluginModes.js';
