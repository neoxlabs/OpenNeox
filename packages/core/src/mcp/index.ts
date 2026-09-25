export { MCPClientManager } from './clientManager.js';
export {
  addMcpServer,
  removeMcpServer,
  updateMcpServer,
  listMcpServers,
  loadUserMcpConfig,
  saveUserMcpConfig,
  loadWorkspaceMcpConfig,
  saveWorkspaceMcpConfig,
  getWorkspaceMcpPath,
  expandEnvVars,
  getMcpServerSignature,
  dedupServers,
  type MCPConfigScope,
  type MCPServerEntry,
} from './configStore.js';
export { formatMcpToolName, parseMcpToolName, isMcpToolName } from './utils.js';
// Connection health, session recovery, and timeout exports.
export {
  ConnectionHealthTracker,
  isTerminalConnectionError,
  isMcpSessionExpiredError,
  McpSessionExpiredError,
  withTimeout,
  getConnectionTimeoutMs,
  getToolCallTimeoutMs,
  truncateToolDescription,
  gracefulKillProcess,
} from './connectionGuard.js';
// Remote MCP OAuth exports.
export {
  performOAuthFlow,
  getValidAccessToken,
  discoverOAuthMetadata,
  loadStoredTokens,
  clearStoredTokens,
  type OAuthFlowOptions,
  type OAuthFlowResult,
} from './oauth.js';

/* 工作区 MCP server 的信任闸 —— 仓库带的 server 默认不连, 见 mcpTrust.ts */
export {
  isWorkspaceServerTrusted, trustWorkspaceServer, revokeWorkspaceTrust, splitByTrust,
  type TrustSplit,
} from './mcpTrust.js';
