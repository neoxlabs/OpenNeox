/**
 * Plugin IPC Types — Electron ↔ Renderer 通信类型
 */

import type {
  MarketplacePlugin,
  InstalledPlugin,
  PluginCategory,
  PluginLoadResult,
} from '../plugin-types.js';

// ============================================================================
// IPC Channel Names
// ============================================================================

export const PLUGIN_IPC_CHANNELS = {
  // Marketplace
  SEARCH: 'plugin:search',
  FEATURED: 'plugin:featured',
  CATEGORIES: 'plugin:categories',
  DETAIL: 'plugin:detail',
  CHECK_UPDATES: 'plugin:check-updates',

  // Management
  LIST: 'plugin:list',
  INSTALL: 'plugin:install',
  UNINSTALL: 'plugin:uninstall',
  ENABLE: 'plugin:enable',
  DISABLE: 'plugin:disable',
  INFO: 'plugin:info',
  CONFIG_GET: 'plugin:config-get',
  CONFIG_SET: 'plugin:config-set',

  // Marketplace Install
  MARKETPLACE_INSTALL: 'plugin:marketplace-install',

  // UI Views (插件贡献的 iframe 面板)
  LIST_VIEWS: 'plugin:list-views',
  VIEWS_CHANGED: 'plugin:views-changed',  // 主 → 渲染 的广播

  // Scaffolding
  SCAFFOLD: 'plugin:scaffold',

  // Preflight: 安装前获取将要请求的权限摘要 (给 UI 弹权限确认框)
  PREFLIGHT_PERMISSIONS: 'plugin:preflight-permissions',

  // Import / Export (用 dialog 弹选择器, 返回用户选的 path/url)
  PICK_INSTALL_SOURCE: 'plugin:pick-install-source',
  EXPORT: 'plugin:export',

  // Connector (声明式第三方平台接入 — 凭据 / 授权 / 连通性)
  CONNECTOR_LIST: 'plugin:connector-list',
  CONNECTOR_CONNECT: 'plugin:connector-connect',
  CONNECTOR_DISCONNECT: 'plugin:connector-disconnect',
  CONNECTOR_SET_GRANTS: 'plugin:connector-set-grants',
  CONNECTOR_TEST: 'plugin:connector-test',
  CONNECTOR_OAUTH: 'plugin:connector-oauth',

  // External Agents (委派给本机其它 agent CLI)
  EXTERNAL_AGENT_LIST: 'plugin:external-agent-list',

  // Auth providers (kind: auth — Claude / Codex / Grok 订阅 OAuth)
  AUTH_LIST: 'plugin:auth-list',
  AUTH_STATUS: 'plugin:auth-status',
  AUTH_LOGIN: 'plugin:auth-login',
  AUTH_LOGOUT: 'plugin:auth-logout',
  /** 内置 auth 插件目录一键安装 / 修复 */
  AUTH_ENSURE: 'plugin:auth-ensure',
  AUTH_CATALOG: 'plugin:auth-catalog',

  // GitHub 源市场 (apps/desktop/src/marketplace/openMarketplaceService) —— 两个发行版都有。
  // 跟上面官方市场的 SEARCH / MARKETPLACE_INSTALL 是两套东西: 频道名 marketplace:* 与
  // 公开仓一致, 键名加 OPEN_ 前缀避免跟官方市场的 MARKETPLACE_INSTALL 撞名。
  OPEN_MARKETPLACE_SOURCES: 'marketplace:sources',
  OPEN_MARKETPLACE_SOURCE_ADD: 'marketplace:source-add',
  OPEN_MARKETPLACE_SOURCE_UPDATE: 'marketplace:source-update',
  OPEN_MARKETPLACE_SOURCE_REMOVE: 'marketplace:source-remove',
  OPEN_MARKETPLACE_SOURCE_REFRESH: 'marketplace:source-refresh',
  OPEN_MARKETPLACE_SEARCH: 'marketplace:search',
  OPEN_MARKETPLACE_TOKEN_SET: 'marketplace:token-set',
  OPEN_MARKETPLACE_INSTALL: 'marketplace:install',

  // Events
  ON_EVENT: 'plugin:on-event',
} as const;

/**
 * 设置页要展示的一个 connector 的完整状态。
 *
 *   凭据本身**永远不出主进程** —— 这里只回 connected 布尔量。UI 没有任何
 *   理由需要看到 token, 让它有机会看到就等于多一个泄漏面 (渲染进程日志、
 *   devtools、崩溃转储)。
 */
export interface PluginConnectorSummary {
  pluginName: string;
  namespace: string;
  displayName: string;
  enabled: boolean;
  /** 是否已存过凭据 */
  connected: boolean;
  authKind: 'oauth2' | 'token' | 'none';
  /** token 模式下引导用户去哪拿 */
  authInstructions?: string;
  /** 声明的能力 + 人话理由 + 用户是否已授予 */
  permissions: Array<{
    capability: string;
    effect: 'readonly' | 'writes' | 'destructive' | 'costly';
    reason: string;
    granted: boolean;
    approxUsd?: number;
  }>;
  /** 暴露给 Agent 的工具全名 */
  tools: string[];
  /** 安装期连接变量 */
  connectionFields: Array<{ key: string; label: string; required: boolean; placeholder?: string }>;
  connection: Record<string, unknown>;
  budget?: { budgetUsd?: number; spentUsd: number };
}

/** 设置页要显示的一个外部 Agent 的状态 */
export interface PluginExternalAgentSummary {
  pluginName: string;
  id: string;
  displayName: string;
  command: string;
  /** 本机装没装 */
  installed: boolean;
  version?: string;
  installHint: string;
  isolation: string;
  examplePrompts: string[];
}

export interface PluginAuthProviderSummary {
  pluginName: string;
  providerId: string;
  displayName: string;
  authKind: string;
  /** logged_out | logged_in | expired | refreshing | unknown */
  state: string;
  accountHint?: string;
  expiresAt?: number;
  /** 对应 BYOK provider id (oauth-<providerId>), 登录后写入 */
  linkedProviderId: string;
}

// ============================================================================
// Plugin View (UI 面板声明) - 仅序列化形式, 绝对路径由 neox-plugin:// 协议解析
// ============================================================================

export interface PluginViewSummary {
  pluginName: string;
  id: string;
  title: string;
  location: 'sidebar' | 'workspace' | 'panel';
  icon?: string;
  iconIsEmoji: boolean;
  entry: string;
  when?: string;
  preferredSize?: { width?: number; height?: number };
}

// ============================================================================
// Request/Response Types
// ============================================================================

export interface PluginSearchRequest {
  query?: string;
  category?: PluginCategory;
  featured?: boolean;
  sort?: 'downloads' | 'rating' | 'newest' | 'name';
  page?: number;
  pageSize?: number;
  cacheOnly?: boolean;
}

export interface PluginSearchResponse {
  plugins: MarketplacePlugin[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PluginInstallRequest {
  /** 插件名 (从市场) 或路径 (本地) */
  nameOrPath: string;
  source: 'marketplace' | 'local' | 'url';
}

export interface PluginInstallResponse {
  success: boolean;
  plugin?: InstalledPlugin;
  errors: string[];
  warnings: string[];
}

export interface PluginListResponse {
  plugins: InstalledPlugin[];
  stats: { total: number; enabled: number; disabled: number };
}

export interface PluginUpdateInfo {
  name: string;
  currentVersion: string;
  latestVersion: string;
}

export interface PluginCategoryInfo {
  id: PluginCategory;
  name: string;
  count: number;
}
