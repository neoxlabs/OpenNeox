type MCPConfigScope = import('../../ipc.js').MCPConfigScope;
type MCPServerEntry = import('../../ipc.js').MCPServerEntry;
type MCPServerInput = import('../../ipc.js').MCPServerInput;
type MCPToolInfo = import('../../ipc.js').MCPToolInfo;

export interface RendererAPIMcp {
  // ==================== MCP 服务器管理 ====================
  mcpList: () => Promise<MCPServerEntry[]>;
  mcpGetEnabled: () => Promise<boolean>;
  mcpSetEnabled: (enabled: boolean) => Promise<void | { runtimeWarning?: string }>;
  mcpAdd: (scope: MCPConfigScope, server: MCPServerInput) => Promise<void>;
  mcpRemove: (scope: MCPConfigScope, serverId: string) => Promise<void>;
  mcpUpdate: (scope: MCPConfigScope, serverId: string, updates: Partial<MCPServerInput>) => Promise<void>;
  mcpConnect: (serverId: string) => Promise<void>;
  mcpDisconnect: (serverId: string) => Promise<void>;
  mcpTest: (serverId: string) => Promise<{ success: boolean; error?: string }>;
  mcpGetTools: (serverId: string) => Promise<MCPToolInfo[] | null>;
}
