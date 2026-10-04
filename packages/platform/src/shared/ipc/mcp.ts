export type MCPTransport = 'stdio' | 'sse' | 'http';
export type MCPConfigScope = 'user' | 'workspace';

export interface MCPServerEntry {
  id: string;
  name?: string;
  transport: MCPTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
  autoConnect?: boolean;
  allowlist?: string[];
  scope: MCPConfigScope;
  /** 仓库 .neox/mcp.json 里的 server 是否已被用户批准; 用户级 server 恒为 true (mcp:list 填) */
  trusted?: boolean;
}

export interface MCPServerInput {
  id: string;
  name?: string;
  transport: MCPTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
  autoConnect?: boolean;
  allowlist?: string[];
}

export interface MCPToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
