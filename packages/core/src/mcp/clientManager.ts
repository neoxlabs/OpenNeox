import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory, ToolPermission } from '@neoxlabs/kernel/types/permissions.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { VERSION } from '@neoxlabs/kernel/version.js';
import { listMcpServers, type MCPServerEntry } from './configStore.js';
import { splitByTrust, isWorkspaceServerTrusted } from './mcpTrust.js';
import { formatMcpToolName, dedupeMcpToolName } from './utils.js';
import {
  ConnectionHealthTracker,
  isTerminalConnectionError,
  isMcpSessionExpiredError,
  McpSessionExpiredError,
  withTimeout,
  getConnectionTimeoutMs,
  getToolCallTimeoutMs,
  truncateToolDescription,
  gracefulKillProcess,
  getDiagnosticMessage,
  MAX_SESSION_RETRIES,
  isMcpOAuthError,
  markServerNeedsAuth,
} from './connectionGuard.js';
import { getValidAccessToken, performOAuthFlow } from './oauth.js';
import {
  API_IMAGE_MAX_BASE64_SIZE,
  buildImageToolResult,
  compressImageDataUrlIfNeeded,
} from '../tools/image/imageProcessor.js';

interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

interface MCPConnection {
  server: MCPServerEntry;
  client: Client;
  transport: Transport;
  tools: MCPToolDefinition[];
  /** stdio 子进程 PID（用于优雅终止） */
  pid?: number;
}

export class MCPClientManager {
  private workDir: string;
  private connections = new Map<string, MCPConnection>();
  private connecting = new Map<string, Promise<MCPConnection>>();
  /* 5.4: 重连退避 — 失败时记 failCount + nextAttemptAt, ensureConnected 在 cooldown
   *   期间直接抛 backoff 错, 防"100ms 内 1000 次 ensureConnected"打死失败的远端.
   *   退避按 1s → 2s → 4s → 8s → 30s 封顶; 成功一次清空. */
  private reconnectBackoff = new Map<string, { failCount: number; nextAttemptAt: number }>();
  private toolsCache: Tool[] | null = null;
  private _enabled = true;
  private healthTracker = new ConnectionHealthTracker();
  /** 每台 stdio server 最近几行 stderr —— 连接失败时拼进报错, 见 withServerStderr */
  private recentStderr = new Map<string, string[]>();

  constructor(options: { workDir: string }) {
    this.workDir = options.workDir;
  }

  isEnabled(): boolean {
    return this._enabled;
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    if (!enabled) {
      this.toolsCache = null;
    }
  }

  setWorkDir(workDir: string): void {
    if (this.workDir !== workDir) {
      this.workDir = workDir;
      this.toolsCache = null;
    }
  }

  listServers(): MCPServerEntry[] {
    return listMcpServers(this.workDir);
  }

  /**
   * 真正会被连的那些 —— 工作区带的 server 要用户点过头 (见 mcpTrust.ts)。
   *
   * `<工作区>/.neox/mcp.json` 是仓库里的一个文件, 一条 stdio server 就是一条任意
   * 命令执行, 而且是"打开这个工作区就起"。所以它默认不连。
   */
  listConnectableServers(): MCPServerEntry[] {
    const { allowed, blocked } = splitByTrust(this.workDir, this.listServers());
    /* 被拦下的**必须留痕**: 用户在仓库里看到 mcp.json 却发现工具没出现, 会以为 MCP 坏了。 */
    if (blocked.length > 0) {
      cliLogger.warn('MCP',
        `${blocked.length} 台工作区 MCP server 未经批准, 已跳过: ${blocked.map((s) => s.id).join(', ')}`
        + ' —— 它们来自这个仓库的 .neox/mcp.json, 一条 stdio server 就能执行任意命令。'
        + ' 确认没问题的话用 /mcp trust <id> 批准。');
    }
    return allowed;
  }

  /** 这个工作区里被信任闸拦下的 server —— 给 UI/CLI 列给用户看并让他批。 */
  listUntrustedServers(): MCPServerEntry[] {
    return splitByTrust(this.workDir, this.listServers()).blocked;
  }

  async refreshTools(): Promise<Tool[]> {
    await this.disconnectAll();
    this.toolsCache = null;
    return this.getTools({ refresh: true });
  }

  async getTools(options?: { refresh?: boolean }): Promise<Tool[]> {
    // 如果 MCP 被禁用，返回空数组
    if (!this._enabled) {
      return [];
    }

    if (options?.refresh) {
      this.toolsCache = null;
    }
    if (!options?.refresh && this.toolsCache) {
      return this.toolsCache;
    }

    const tools: Tool[] = [];
    const takenNames = new Set<string>();
    const servers = this.listConnectableServers();

    for (const server of servers) {
      if (server.enabled === false) {
        continue;
      }
      try {
        const filtered = await this.getToolDefsForServer(server);
        for (const toolDef of filtered) {
          const tool = this.createTool(server, toolDef);
          tool.name = dedupeMcpToolName(tool.name, server.id, toolDef.name, takenNames);
          takenNames.add(tool.name);
          tools.push(tool);
        }
      } catch (error: any) {
        cliLogger.warn('MCP', `Failed to load tools for ${server.id}: ${error?.message || error}`);
      }
    }

    this.toolsCache = tools;
    return tools;
  }

  async connect(serverId: string): Promise<MCPConnection> {
    const server = this.listServers().find((entry) => entry.id === serverId);
    if (!server) {
      throw new Error(`MCP server not found: ${serverId}`);
    }
    /* 这里也要过闸 —— 只在 getTools 里过的话, 从 UI/CLI 直接点"连接"就绕过去了。
     * 报错要说清是**没批准**而不是连不上, 这两件事的下一步完全不同。 */
    if (server.scope === 'workspace' && !isWorkspaceServerTrusted(this.workDir, server)) {
      throw new Error(
        `MCP server "${serverId}" 来自这个仓库的 .neox/mcp.json, 还没有被批准。`
        + ' 仓库带的 server 一条 stdio 命令就能在你机器上执行任意代码, 所以默认不连。'
        + ' 看过它的配置确认没问题后, 用 /mcp trust ' + serverId + ' 批准。',
      );
    }
    const connection = await this.ensureConnected(server);
    this.toolsCache = null;
    return connection;
  }

  /**
   * 启动时把勾了「启动时自动连接」(autoConnect) 的 server 连上。
   *
   * 设置页的表单一直有这个开关, 配置里也一直存着 autoConnect: true —— 但**没有任何代码读它**。
   * 桌面端又不写 toolCache (那是 CLI `neox mcp connect` 才写的), 于是每次重启 App,
   * MCP 工具就从模型工具表里消失, 直到用户回设置页手动点一次「连接」。
   *
   * 并行连, 一台失败不拖累其它台; 失败原样返回给调用方记日志 (不吞)。
   * MCP 总开关关着时什么都不连 —— 不该因为一个关掉的功能在后台起子进程。
   */
  async connectAutoConnectServers(): Promise<{ connected: string[]; failed: Array<{ id: string; error: string }> }> {
    const connected: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    if (!this._enabled) return { connected, failed };
    const targets = this.listConnectableServers()
      .filter((s) => s.enabled !== false && s.autoConnect === true && !this.connections.has(s.id));
    const results = await Promise.allSettled(targets.map((s) => this.ensureConnected(s)));
    results.forEach((r, i) => {
      const id = targets[i].id;
      if (r.status === 'fulfilled') connected.push(id);
      else failed.push({ id, error: r.reason?.message || String(r.reason) });
    });
    if (connected.length > 0) this.toolsCache = null;
    return { connected, failed };
  }

  async disconnect(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      return;
    }
    this.connections.delete(serverId);
    this.toolsCache = null;
    try {
      await connection.client.close();
    } catch {
      // Ignore close errors
    }
    try {
      await connection.transport.close?.();
    } catch {
      // Ignore close errors
    }
    if (connection.pid) {
      try {
        await gracefulKillProcess(connection.pid);
      } catch {
        // Process already gone
      }
    }
  }

  async disconnectAll(): Promise<void> {
    const servers = Array.from(this.connections.keys());
    for (const serverId of servers) {
      await this.disconnect(serverId);
    }
    this.healthTracker.clearAll();
  }

  async testServer(serverId: string): Promise<{ toolCount: number; tools: string[] }> {
    const connection = await this.connect(serverId);
    const filtered = this.filterTools(connection.tools, connection.server);
    return { toolCount: filtered.length, tools: filtered.map((tool) => tool.name) };
  }

  async getToolDefinitions(serverId: string): Promise<MCPToolDefinition[]> {
    const connection = await this.connect(serverId);
    return this.filterTools(connection.tools, connection.server);
  }

  private async ensureConnected(server: MCPServerEntry): Promise<MCPConnection> {
    const existing = this.connections.get(server.id);
    if (existing) {
      return existing;
    }

    const inflight = this.connecting.get(server.id);
    if (inflight) {
      return inflight;
    }

    /* 5.4: cooldown 期间直接抛, 不放新 connect 进 pipeline 打死远端 */
    const backoff = this.reconnectBackoff.get(server.id);
    if (backoff && Date.now() < backoff.nextAttemptAt) {
      const waitMs = backoff.nextAttemptAt - Date.now();
      throw new Error(
        `MCP ${server.id} in reconnect backoff (${backoff.failCount} failures); retry in ${Math.ceil(waitMs / 1000)}s`,
      );
    }

    const promise = this.createConnection(server);
    this.connecting.set(server.id, promise);
    try {
      const connection = await promise;
      this.connections.set(server.id, connection);
      /* 成功 → 清退避 */
      this.reconnectBackoff.delete(server.id);
      return connection;
    } catch (err) {
      /* 失败 → 累加退避: 1s/2s/4s/8s/30s cap. 跟 ensureConnected 上面的 cooldown 配对. */
      const prev = this.reconnectBackoff.get(server.id);
      const failCount = (prev?.failCount ?? 0) + 1;
      const nextWaitMs = Math.min(30_000, 1000 * Math.pow(2, failCount - 1));
      this.reconnectBackoff.set(server.id, {
        failCount,
        nextAttemptAt: Date.now() + nextWaitMs,
      });
      throw err;
    } finally {
      this.connecting.delete(server.id);
    }
  }

  private async createConnection(server: MCPServerEntry): Promise<MCPConnection> {
    const transport = this.createTransport(server);
    const client = new Client(
      { name: 'neox', version: VERSION },
      { capabilities: {} },
    );

    const timeoutMs = getConnectionTimeoutMs();
    try {
      await withTimeout(
        client.connect(transport),
        timeoutMs,
        `MCP connect to ${server.id}`,
      );
    } catch (error: any) {
      // 连接失败时清理 transport
      try { await transport.close?.(); } catch { /* ignore */ }
      this.healthTracker.recordError(server.id, error);

      /* W3 wire: OAuth 401 检测 → mark needsAuth cache + 友好日志.
       * 下次 caller (ensureConnected / UI 主动重连) 调 cachedNeedsAuth() 可以拿到 true,
       * 跳过"先 connect → catch 401"慢路径, 直接走 OAuth flow.
       * 实际 token refresh + retry connect 留给上层调用方决策 (避免在 catch 里嵌套
       * 创建新 transport+client). 上层可调 retryWithOAuthRefresh 拿 typed error
       * (McpAuthError / McpAuthPermanentError) 分类后给 UX 提示. */
      if (server.url && isMcpOAuthError(error)) {
        markServerNeedsAuth(server.id, server.url);
        cliLogger.error('MCP_OAUTH',
          `MCP server "${server.id}" 401 unauthorized — marked needsAuth (15min cache). ` +
          `User must complete OAuth in UI or call retryWithOAuthRefresh(serverId, url, reconnectFn).`,
        );
      }

      throw withServerStderr(error, this.recentStderr.get(server.id));
    }

    /* connect 成功之后的任何失败都要把 transport 收掉 —— 原来 listTools 抛了就直接冒泡,
     * stdio 子进程留在 Neox 名下一直活着 (connection 没进 Map, disconnect 也找不到它)。
     * 每次重试都再起一个, 攒一串孤儿。
     * 另外: 不声明 tools 能力的 server (只提供 resources/prompts) 是合法的, 不该去调
     * listTools 换一个 "Method not found" 当连接失败。 */
    let tools: MCPToolDefinition[] = [];
    try {
      if (client.getServerCapabilities()?.tools) {
        const list = await withTimeout(client.listTools(), timeoutMs, `MCP tools/list on ${server.id}`);
        tools = (list?.tools ?? []) as MCPToolDefinition[];
      }
    } catch (error: any) {
      this.healthTracker.recordError(server.id, error);
      /* SDK 的 stdio close 自己会 stdin.end → SIGTERM → SIGKILL 逐级收 */
      try { await client.close(); } catch { /* ignore */ }
      try { await transport.close?.(); } catch { /* ignore */ }
      const wrapped = new Error(
        `MCP server "${server.id}" connected but listing its tools failed: ${error?.message || String(error)}`,
        { cause: error },
      );
      if (error?.code !== undefined) (wrapped as any).code = error.code;
      throw wrapped;
    }

    this.healthTracker.recordSuccess(server.id);

    // 获取 stdio PID（用于优雅终止）
    let pid: number | undefined;
    if (server.transport === 'stdio' && (transport as any)._process?.pid) {
      pid = (transport as any)._process.pid;
    }

    cliLogger.info('MCP', `Connected ${server.id} (${tools.length} tools, ${timeoutMs}ms timeout)`);

    client.onclose = () => {
      cliLogger.warn('MCP', `[${server.id}] transport closed, dropping cached connection`);
      this.connections.delete(server.id);
      this.toolsCache = null;
      this.healthTracker.recordError(server.id, new Error('transport closed'));
    };
    client.onerror = (error: any) => {
      cliLogger.warn('MCP', `[${server.id}] transport error: ${error?.message || error}`);
      this.healthTracker.recordError(server.id, error);
      /* 不立刻 delete connection — protocol 自己可能恢复; 等 onclose 真触发再清. */
    };

    return { server, client, transport, tools, pid };
  }

  private createTransport(server: MCPServerEntry): Transport {
    if (server.transport === 'sse') {
      if (!server.url) {
        throw new Error(`MCP server ${server.id} missing url for sse transport`);
      }
      // 检查是否有存储的 OAuth token 或静态 headers
      return new SSEClientTransport(new URL(server.url));
    }

    if (server.transport === 'http') {
      if (!server.url) {
        throw new Error(`MCP server ${server.id} missing url for http transport`);
      }
      return new StreamableHTTPClientTransport(new URL(server.url));
    }

    /* 手写配置里的 "streamable-http" / "ws" 之类: 说清是协议名不认识, 而不是落到 stdio
     * 分支报一句让人摸不着头脑的 "missing command" */
    if (server.transport !== 'stdio' && server.transport !== undefined) {
      throw new Error(
        `MCP server ${server.id}: unsupported transport "${String(server.transport)}" (expected stdio / sse / http)`,
      );
    }

    if (!server.command) {
      throw new Error(`MCP server ${server.id} missing command for stdio transport`);
    }

    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: buildEnv(server.env),
      stderr: 'pipe',
    });
    this.attachStdioStderrLogger(transport, server);
    return transport;
  }

  async ensureAuthenticated(server: MCPServerEntry): Promise<string | null> {
    if (server.transport === 'stdio' || !server.url) {
      return null; // stdio 不需要认证
    }

    // 检查是否有有效的 access_token
    const token = await getValidAccessToken(server.id, server.url);
    if (token) return token;

    // 需要完整 OAuth 流程 — 由调用方（CLI command）决定是否触发
    return null;
  }

  private createTool(server: MCPServerEntry, toolDef: MCPToolDefinition): Tool {
    const toolName = formatMcpToolName(server.id, toolDef.name);
    const description = truncateToolDescription(
      `[MCP:${server.id}] ${toolDef.description || toolDef.name}`,
    );

    return {
      name: toolName,
      description,
      parameters: normalizeParameters(toolDef.inputSchema),
      function: async (args: any) => {
        const toolTimeoutMs = getToolCallTimeoutMs();
        let retries = 0;

        while (retries <= MAX_SESSION_RETRIES) {
          const connection = await this.ensureConnected(server);
          try {
            const result = await withTimeout(
              connection.client.callTool({
                name: toolDef.name,
                arguments: args ?? {},
              }),
              toolTimeoutMs,
              `MCP tool ${server.id}/${toolDef.name}`,
            );

            this.healthTracker.recordSuccess(server.id);
            return await formatToolResult(result, { serverId: server.id, toolName: toolDef.name });
          } catch (error: any) {
            if (isMcpSessionExpiredError(error) && retries < MAX_SESSION_RETRIES) {
              cliLogger.warn('MCP',
                `[${server.id}] Session expired, clearing cache and reconnecting...`,
              );
              await this.disconnect(server.id);
              this.healthTracker.clear(server.id);
              retries++;
              continue;
            }

            const needsReconnect = this.healthTracker.recordError(server.id, error);
            if (needsReconnect) {
              cliLogger.warn('MCP',
                `[${server.id}] Too many terminal errors, forcing reconnection`,
              );
              await this.disconnect(server.id);
            }

            throw error;
          }
        }

        throw new McpSessionExpiredError(server.id);
      },
      permission: {
        category: ToolCategory.NETWORK,
        defaultPermission: ToolPermission.ASK,
        permissionReason: `MCP tool from ${server.id}`,
      },
    };
  }

  private attachStdioStderrLogger(transport: StdioClientTransport, server: MCPServerEntry): void {
    const stderr = transport.stderr;
    if (!stderr) {
      return;
    }

    let pending = '';
    /* 每次新起进程都从空开始 —— 上一次的 stderr 不该混进这一次的报错里 */
    const recent: string[] = [];
    this.recentStderr.set(server.id, recent);
    const remember = (line: string): void => {
      /* 栈帧 (`at foo (file:1:2)`) 不进报错 —— node 崩溃时尾部全是它, 会把真正那句
       * `Error: missing API key` 挤出窗口 */
      if (/^at\s/.test(line)) return;
      recent.push(line.length > 500 ? `${line.slice(0, 500)}...` : line);
      if (recent.length > STDERR_TAIL_LINES) recent.shift();
    };
    stderr.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const truncated = trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}...` : trimmed;
        remember(trimmed);
        cliLogger.warn('MCP_STDERR', `[${server.id}] ${truncated}`);
      }
    });

    stderr.on('error', (error: Error) => {
      cliLogger.warn('MCP_STDERR', `stderr stream error from ${server.id}: ${error.message}`);
    });

    stderr.on('end', () => {
      const trimmed = pending.trim();
      if (trimmed) {
        remember(trimmed);
        const truncated = trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}...` : trimmed;
        cliLogger.warn('MCP_STDERR', `[${server.id}] ${truncated}`);
      }
      pending = '';
    });
  }

  private filterTools(tools: MCPToolDefinition[], server: MCPServerEntry): MCPToolDefinition[] {
    const allowlist = server.allowlist ?? [];
    const denylist = server.denylist ?? [];
    return tools.filter((tool) => {
      if (denylist.length > 0 && matchesAny(tool.name, denylist)) {
        return false;
      }
      if (allowlist.length > 0) {
        return matchesAny(tool.name, allowlist);
      }
      return true;
    });
  }

  private async getToolDefsForServer(server: MCPServerEntry): Promise<MCPToolDefinition[]> {
    const isConnected = this.connections.has(server.id);

    // 只有在已经连接的情况下才返回实时工具列表
    // autoConnect 不再在这里触发连接，而是使用缓存
    if (isConnected) {
      const connection = this.connections.get(server.id)!;
      return this.filterTools(connection.tools, server);
    }

    // 未连接时使用缓存（懒加载模式）
    const cached = server.toolCache ?? [];
    return this.filterTools(cached, server);
  }
}

const STDERR_TAIL_LINES = 8;

/**
 * stdio server 起来就挂时, SDK 给的只有一句 "MCP error -32000: Connection closed" ——
 * 真正的原因 (缺 API key / 命令参数错 / 依赖没装) 在子进程的 stderr 里, 而那只进了日志。
 * 用户在设置页看到的就是"连接失败: Connection closed", 完全不知道该改什么。
 * 把最后几行 stderr 拼进报错; code 原样带过去 (IPC 层会把它透给界面)。
 */
function withServerStderr(error: any, stderrTail: string[] | undefined): any {
  if (!stderrTail || stderrTail.length === 0) return error;
  const base = error?.message || String(error);
  const enriched = new Error(`${base}\nserver stderr:\n${stderrTail.join('\n')}`, { cause: error });
  if (error?.code !== undefined) (enriched as any).code = error.code;
  return enriched;
}

function normalizeParameters(schema?: Record<string, any>): Tool['parameters'] {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }

  const properties = typeof schema.properties === 'object' && schema.properties !== null
    ? schema.properties
    : {};
  const required = Array.isArray(schema.required) ? schema.required : undefined;
  const additionalProperties = typeof schema.additionalProperties === 'boolean'
    ? schema.additionalProperties
    : undefined;

  return {
    type: 'object',
    properties,
    required,
    additionalProperties,
  };
}

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(value, pattern));
}

function matchesPattern(value: string, pattern: string): boolean {
  if (pattern === '*') {
    return true;
  }
  if (!pattern.includes('*')) {
    return value === pattern;
  }
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escaped.replace(/\\\*/g, '.*')}$`);
  return regex.test(value);
}

const MCP_ENV_ALLOWLIST = new Set([
  // POSIX 基础
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TZ',
  'LANG', 'LANGUAGE',
  'TMPDIR', 'TEMP', 'TMP',
  // 运行时/工具发现 (路径, 非密钥)
  'NODE_ENV', 'NVM_DIR', 'FNM_DIR', 'VOLTA_HOME',
  'PYENV_ROOT', 'RBENV_ROOT', 'GOPATH', 'GOROOT', 'CARGO_HOME', 'RUSTUP_HOME',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  // Windows 基础
  'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC', 'ComSpec', 'PATHEXT',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData',
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
]);
/** 前缀白名单 (LC_* 本地化, 都是路径/区域设置, 非密钥). */
const MCP_ENV_ALLOW_PREFIXES = ['LC_'];

function buildEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    const allowed = MCP_ENV_ALLOWLIST.has(key)
      || MCP_ENV_ALLOW_PREFIXES.some((p) => key.startsWith(p));
    if (allowed) env[key] = value;
  }
  /* server 配置里显式声明的 env 始终透传 (用户 opt-in), 可覆盖白名单值。 */
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      env[key] = value;
    }
  }
  return env;
}

export async function formatToolResult(
  result: any,
  ctx: { serverId: string; toolName: string },
): Promise<string> {
  if (!result) {
    return '';
  }

  const { texts, images } = await collectToolContent(result.content);
  const text = texts.join('\n');

  if (result.isError) {
    const detail = text || (images.length > 0 ? `[${images.length} image(s) returned with the error]` : '');
    throw new Error(detail
      ? detail
      : `MCP tool "${ctx.toolName}" on server "${ctx.serverId}" reported an error without a message`);
  }

  /* 只有结构化结果时 (spec 建议同时给 text, 但不少 server 只给 structuredContent) */
  const structured = result.structuredContent !== undefined && result.structuredContent !== null
    ? JSON.stringify(result.structuredContent)
    : '';
  const body = text || structured;

  if (images.length > 0) {
    return buildImageToolResult(images, body || undefined);
  }
  return body || JSON.stringify(result);
}

const OMIT_DATA_NOTE = (kind: string, mimeType: unknown, data: unknown): string => {
  const bytes = typeof data === 'string' ? Math.floor((data.length * 3) / 4) : 0;
  return `[${kind}${typeof mimeType === 'string' && mimeType ? ` ${mimeType}` : ''}${bytes ? `, ~${bytes} bytes` : ''} omitted]`;
};

async function toImage(data: unknown, mimeType: unknown, label?: string): Promise<{ base64: string; mediaType: string; label?: string } | null> {
  if (typeof data !== 'string' || !data) return null;
  let mediaType = typeof mimeType === 'string' && mimeType.startsWith('image/') ? mimeType : 'image/png';
  let base64 = data;
  const funneled = await compressImageDataUrlIfNeeded(`data:${mediaType};base64,${base64}`);
  if (funneled.compressed) {
    const m = funneled.url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
    if (m) { mediaType = m[1]; base64 = m[2]; }
  }
  if (base64.length > API_IMAGE_MAX_BASE64_SIZE) return null;
  return { base64, mediaType, ...(label ? { label } : {}) };
}

async function collectToolContent(content: any): Promise<{
  texts: string[];
  images: Array<{ base64: string; mediaType: string; label?: string }>;
}> {
  const texts: string[] = [];
  const images: Array<{ base64: string; mediaType: string; label?: string }> = [];
  if (!content) return { texts, images };
  if (typeof content === 'string') return { texts: [content], images };
  if (!Array.isArray(content)) return { texts: [JSON.stringify(content)], images };

  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    switch (item.type) {
      case 'text':
        if (typeof item.text === 'string' && item.text) texts.push(item.text);
        break;
      case 'image': {
        const img = await toImage(item.data, item.mimeType);
        if (img) images.push(img);
        else texts.push(OMIT_DATA_NOTE('image too large or empty', item.mimeType, item.data));
        break;
      }
      case 'audio':
        texts.push(OMIT_DATA_NOTE('audio', item.mimeType, item.data));
        break;
      case 'resource': {
        const r = item.resource ?? {};
        const uri = typeof r.uri === 'string' ? r.uri : '';
        if (typeof r.text === 'string') {
          texts.push(uri ? `[resource ${uri}]\n${r.text}` : r.text);
        } else if (typeof r.blob === 'string' && typeof r.mimeType === 'string' && r.mimeType.startsWith('image/')) {
          const img = await toImage(r.blob, r.mimeType, uri || undefined);
          if (img) images.push(img);
          else texts.push(OMIT_DATA_NOTE(`resource ${uri}`, r.mimeType, r.blob));
        } else {
          texts.push(OMIT_DATA_NOTE(`resource ${uri}`, r.mimeType, r.blob));
        }
        break;
      }
      case 'resource_link':
        texts.push(`[resource link: ${item.name ?? ''} ${item.uri ?? ''}]`.replace(/\s+\]/, ']'));
        break;
      default:
        texts.push(JSON.stringify(item));
    }
  }
  return { texts, images };
}
