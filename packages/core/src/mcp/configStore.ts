import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

import { loadConfig, saveConfig, type MCPConfig, type MCPServerConfig } from '@neoxlabs/platform/utils/config.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export type MCPConfigScope = 'user' | 'workspace';

export interface MCPServerEntry extends MCPServerConfig {
  scope: MCPConfigScope;
}

const WORKSPACE_MCP_DIR = '.neox';
const WORKSPACE_MCP_FILE = 'mcp.json';

export function getWorkspaceMcpPath(workDir: string): string {
  return path.join(workDir, WORKSPACE_MCP_DIR, WORKSPACE_MCP_FILE);
}

export function loadWorkspaceMcpConfig(workDir: string): MCPConfig {
  const filePath = getWorkspaceMcpPath(workDir);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as MCPConfig;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export function saveWorkspaceMcpConfig(workDir: string, config: MCPConfig): void {
  const filePath = getWorkspaceMcpPath(workDir);
  atomicWriteJson(filePath, config);
}

export function loadUserMcpConfig(): MCPConfig {
  const config = loadConfig();
  return config.mcp ?? {};
}

export function saveUserMcpConfig(mcp: MCPConfig): void {
  const config = loadConfig();
  config.mcp = mcp;
  saveConfig(config);
}


export function keepValidServers(list: unknown, where = 'config'): MCPServerConfig[] {
  if (!Array.isArray(list)) {
    if (list != null) cliLogger.warn('MCP', `${where}: servers 不是数组, 已忽略`, { got: typeof list });
    return [];
  }
  const out: MCPServerConfig[] = [];
  let dropped = 0;
  for (const item of list) {
    if (item && typeof item === 'object' && typeof (item as MCPServerConfig).id === 'string'
      && (item as MCPServerConfig).id.trim().length > 0) {
      out.push(item as MCPServerConfig);
    } else {
      dropped++;
    }
  }
  if (dropped > 0) {
    cliLogger.warn('MCP', `${where}: 丢掉 ${dropped} 条非法 server 配置 (null / 非对象 / 缺 id)`, {
      kept: out.length,
    });
  }
  return out;
}

export function listMcpServers(workDir: string): MCPServerEntry[] {
  const userServers = keepValidServers(loadUserMcpConfig().servers, 'user config').map((server) => ({
    ...normalizeServer(server),
    scope: 'user' as const,
  }));
  const workspaceServers = keepValidServers(loadWorkspaceMcpConfig(workDir).servers, 'workspace config').map((server) => ({
    ...normalizeServer(server),
    scope: 'workspace' as const,
  }));

  // ID-based merge (workspace wins)
  const merged = new Map<string, MCPServerEntry>();
  for (const server of userServers) {
    merged.set(server.id, server);
  }
  for (const server of workspaceServers) {
    merged.set(server.id, server);
  }

  let servers = Array.from(merged.values());

  servers = servers.map(server => {
    const { expanded } = expandEnvVars(server);
    return { ...expanded, scope: server.scope } as MCPServerEntry;
  });

  const { deduped } = dedupServers(servers);
  return deduped;
}

function normalizeServer(server: MCPServerConfig): MCPServerConfig {
  return {
    ...server,
    transport: server.transport ?? 'stdio',
    enabled: server.enabled ?? true,
    autoConnect: server.autoConnect ?? false,
  };
}

export function addMcpServer(
  workDir: string,
  scope: MCPConfigScope,
  server: MCPServerConfig,
  options?: { replace?: boolean }
): void {
  if (!server || typeof server !== 'object') {
    throw new Error(`addMcpServer: server 必须是对象, 收到 ${server === null ? 'null' : typeof server}`);
  }
  if (typeof server.id !== 'string' || server.id.trim().length === 0) {
    throw new Error('addMcpServer: server.id 必须是非空字符串');
  }
  if (scope === 'workspace') {
    const config = loadWorkspaceMcpConfig(workDir);
    const servers = config.servers ?? [];
    const existingIndex = servers.findIndex((entry) => entry.id === server.id);
    if (existingIndex >= 0 && !options?.replace) {
      throw new Error(`MCP server "${server.id}" already exists in workspace config`);
    }
    if (existingIndex >= 0) {
      servers[existingIndex] = server;
    } else {
      servers.push(server);
    }
    saveWorkspaceMcpConfig(workDir, { ...config, servers });
    return;
  }

  const config = loadConfig();
  const mcp = config.mcp ?? {};
  const servers = mcp.servers ?? [];
  const existingIndex = servers.findIndex((entry) => entry.id === server.id);
  if (existingIndex >= 0 && !options?.replace) {
    throw new Error(`MCP server "${server.id}" already exists in user config`);
  }
  if (existingIndex >= 0) {
    servers[existingIndex] = server;
  } else {
    servers.push(server);
  }
  config.mcp = { ...mcp, servers };
  saveConfig(config);
}

export function removeMcpServer(workDir: string, scope: MCPConfigScope, serverId: string): boolean {
  if (scope === 'workspace') {
    const config = loadWorkspaceMcpConfig(workDir);
    const servers = config.servers ?? [];
    const nextServers = servers.filter((server) => server.id !== serverId);
    if (nextServers.length === servers.length) {
      return false;
    }
    saveWorkspaceMcpConfig(workDir, { ...config, servers: nextServers });
    return true;
  }

  const config = loadConfig();
  const mcp = config.mcp ?? {};
  const servers = mcp.servers ?? [];
  const nextServers = servers.filter((server) => server.id !== serverId);
  if (nextServers.length === servers.length) {
    return false;
  }
  config.mcp = { ...mcp, servers: nextServers };
  saveConfig(config);
  return true;
}

export function updateMcpServer(
  workDir: string,
  scope: MCPConfigScope,
  serverId: string,
  updates: Partial<MCPServerConfig>
): boolean {
  if (scope === 'workspace') {
    const config = loadWorkspaceMcpConfig(workDir);
    const servers = config.servers ?? [];
    const index = servers.findIndex((server) => server.id === serverId);
    if (index < 0) {
      return false;
    }
    servers[index] = { ...servers[index], ...updates };
    saveWorkspaceMcpConfig(workDir, { ...config, servers });
    return true;
  }

  const config = loadConfig();
  const mcp = config.mcp ?? {};
  const servers = mcp.servers ?? [];
  const index = servers.findIndex((server) => server.id === serverId);
  if (index < 0) {
    return false;
  }
  servers[index] = { ...servers[index], ...updates };
  config.mcp = { ...mcp, servers };
  saveConfig(config);
  return true;
}

// ============================================================================
// ============================================================================

function atomicWriteJson(filePath: string, data: any): void {
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const content = JSON.stringify(data, null, 2) + '\n';
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`;

  try {
    // 保留原文件权限
    let mode: number | undefined;
    try {
      const stat = fs.statSync(filePath);
      mode = stat.mode;
    } catch {
      // 文件不存在，用默认权限
    }

    const fd = fs.openSync(tmpPath, 'w', mode ?? 0o644);
    try {
      fs.writeSync(fd, content, null, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    // 清理临时文件
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw error;
  }
}

export function expandEnvVars(
  server: MCPServerConfig,
): { expanded: MCPServerConfig; missingVars: string[] } {
  const missingVars: string[] = [];

  function expand(value: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const envValue = process.env[varName];
      if (envValue !== undefined) {
        return envValue;
      }
      missingVars.push(varName);
      return match; // 保留原始引用
    });
  }

  const expanded: MCPServerConfig = { ...server };

  // 展开 command
  if (expanded.command) {
    expanded.command = expand(expanded.command);
  }

  // 展开 url
  if (expanded.url) {
    expanded.url = expand(expanded.url);
  }

  // 展开 args
  if (expanded.args) {
    expanded.args = expanded.args.map(arg => expand(arg));
  }

  // 展开 env values
  if (expanded.env) {
    const envCopy: Record<string, string> = {};
    for (const [key, val] of Object.entries(expanded.env)) {
      envCopy[key] = expand(val);
    }
    expanded.env = envCopy;
  }

  if (missingVars.length > 0) {
    cliLogger.warn('MCP',
      `Server "${server.id}" references undefined env vars: ${missingVars.join(', ')}`,
    );
  }

  return { expanded, missingVars };
}

export function getMcpServerSignature(server: MCPServerConfig): string | null {
  if (server.transport === 'stdio' && server.command) {
    const cmdParts = [server.command, ...(server.args ?? [])];
    return `stdio:${JSON.stringify(cmdParts)}`;
  }
  if ((server.transport === 'sse' || server.transport === 'http') && server.url) {
    return `url:${server.url}`;
  }
  return null;
}

/**
 * 从服务器列表中去除重复（基于内容签名）
 * 后出现的配置赢（workspace > user）
 *
 * @returns 去重后的列表 + 被抑制的列表
 */
export function dedupServers(
  servers: MCPServerEntry[],
): { deduped: MCPServerEntry[]; suppressed: Array<{ id: string; duplicateOf: string }> } {
  const signatureMap = new Map<string, MCPServerEntry>();
  const suppressed: Array<{ id: string; duplicateOf: string }> = [];

  for (const server of servers) {
    const sig = getMcpServerSignature(server);
    if (!sig) {
      // 无签名的保留
      continue;
    }

    const existing = signatureMap.get(sig);
    if (existing && existing.id !== server.id) {
      // 后来者赢，旧的被抑制
      suppressed.push({ id: existing.id, duplicateOf: server.id });
    }
    signatureMap.set(sig, server);
  }

  if (suppressed.length === 0) {
    return { deduped: servers, suppressed };
  }

  const suppressedIds = new Set(suppressed.map(s => s.id));
  const deduped = servers.filter(s => !suppressedIds.has(s.id));

  cliLogger.info('MCP',
    `Deduplicated ${suppressed.length} servers: ${suppressed.map(s => `${s.id} → ${s.duplicateOf}`).join(', ')}`,
  );

  return { deduped, suppressed };
}
