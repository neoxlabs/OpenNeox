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
