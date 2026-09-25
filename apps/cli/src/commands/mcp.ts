/**
 * MCP Command Handlers
 * Handles MCP server configuration and connection management
 */

import { getLanguage } from '../i18n/index.js';
import { colors } from '../constants.js';
import { cliPrintln } from '../utils/output.js';
import type { SelectionChoice } from '../cliTypes.js';
import type { MCPServerConfig, MCPTransport } from '@neoxlabs/platform/utils/config.js';
import {
  MCPClientManager,
  addMcpServer,
  removeMcpServer,
  updateMcpServer,
  listMcpServers,
  isWorkspaceServerTrusted,
  trustWorkspaceServer,
  revokeWorkspaceTrust,
  type MCPConfigScope,
} from '@neoxlabs/core/mcp/index.js';

function outputToUI(ctx: { outputLines?: (lines: string[]) => void }, lines: string[]): void {
  if (ctx.outputLines) {
    ctx.outputLines(lines);
  } else {
    lines.forEach((line) => cliPrintln(line));
  }
}

export interface McpCommandContext {
  workDir: string;
  mcpManager: MCPClientManager;
  promptSelect: (question: string, choices: SelectionChoice[], defaultValue?: string, hint?: string) => Promise<string>;
  promptText: (question: string, options?: { allowEmpty?: boolean; defaultValue?: string }) => Promise<string | null>;
  logInfo: (message: string, details?: string) => void;
  refreshMcpTools?: () => Promise<void>;
  outputLines?: (lines: string[]) => void;
}

export async function handleMcpCommand(ctx: McpCommandContext, subCmd?: string): Promise<void> {
  let normalized = (subCmd || '').trim().toLowerCase();

  if (!normalized) {
    try {
      // 获取当前 MCP 全局开关状态
      const mcpEnabled = ctx.mcpManager.isEnabled();
      const zh = getLanguage() === 'zh';
      normalized = await ctx.promptSelect(
        zh ? 'MCP 服务器' : 'MCP commands',
        [
          { label: zh ? '管理服务器' : 'Manage servers', value: 'list' },
          {
            label: mcpEnabled
              ? (zh ? '停用 MCP' : 'Disable MCP')
              : (zh ? '启用 MCP' : 'Enable MCP'),
            value: 'toggle-global',
          },
        ],
        'list',
        zh ? '↑↓ 选择, Enter 确认' : 'Use ↑↓ then Enter',
      );
    } catch (error: any) {
      if (error?.message !== 'cancelled') {
        ctx.logInfo('MCP menu closed', error?.message);
      }
      return;
    }
  }

  switch (normalized) {
    case 'list':
      await handleMcpListInteractive(ctx);
      break;
    case 'toggle-global':
      await handleMcpToggleGlobal(ctx);
      break;
    case 'add':
      await handleMcpAddInteractive(ctx);
      break;
    case 'remove':
      await handleMcpRemoveInteractive(ctx);
      break;
    case 'connect':
      await handleMcpConnect(ctx);
      break;
    case 'test':
      await handleMcpTest(ctx);
      break;
    case 'enable':
      await handleMcpToggle(ctx, true);
      break;
    case 'disable':
      await handleMcpToggle(ctx, false);
      break;
    default:
      ctx.logInfo('Unknown MCP command', `Command: ${normalized}`);
  }
}

export async function handleMcpCliCommand(
  argv: string[],
  options: { workDir: string }
): Promise<number> {
  const [subCmd, ...rest] = argv;
  const normalized = (subCmd || '').trim().toLowerCase();

  try {
    switch (normalized) {
      case 'add': {
        const parsed = parseMcpAddArgs(rest);
        const server = buildServerFromParsed(parsed);

        if (server.transport === 'stdio' && !parsed.yes) {
          if (!process.stdin.isTTY) {
            cliPrintln(colors.error('✗ MCP stdio server 非交互模式 add 需带 --yes (CI 显式信任)'));
            return 1;
          }
          cliPrintln('');
          cliPrintln(colors.warning('⚠ 你正在 add 一个 MCP stdio server — 它会在每次 neox 启动时 spawn 跑'));
          cliPrintln(colors.dim('  这等价让 Neox 执行任意代码. 仅当你完全信任源时才继续.'));
          cliPrintln('');
          cliPrintln(colors.dim('  Command:  ') + colors.info(`${server.command} ${(server.args || []).join(' ')}`));
          cliPrintln(colors.dim('  Scope:    ') + parsed.scope);
          const envKeys = Object.keys(server.env || {});
          if (envKeys.length > 0) {
            cliPrintln(colors.dim('  Env keys: ') + envKeys.join(', '));
          }
          cliPrintln('');
          /* mcp add 是 CLI 命令行入口 (不在 Ink REPL 内), stdin line mode 可用 readline */
          const { createInterface } = await import('node:readline/promises');
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question('继续 add 吗? [y/N]: ').catch(() => '');
          rl.close();
          const confirmed = answer.trim().toLowerCase().startsWith('y');
          if (!confirmed) {
            cliPrintln(colors.dim('已取消, 没改 config. 加 --yes 跳过此 confirm.'));
            return 0;
          }
        }

        addMcpServer(options.workDir, parsed.scope, server);
        cliPrintln(colors.success(`✓ MCP server "${server.id}" added (${parsed.scope})`));
        cliPrintln(colors.dim(`  Transport: ${server.transport}`));
        if (server.transport === 'stdio') {
          cliPrintln(colors.dim(`  Command: ${server.command} ${(server.args || []).join(' ')}`));
        } else {
          cliPrintln(colors.dim(`  URL: ${server.url}`));
        }
        return 0;
      }
      case 'list': {
        const servers = listMcpServers(options.workDir);
        outputServerList({ outputLines: (lines) => lines.forEach(cliPrintln) }, servers);
        /* 仓库带的、还没批准的要单独点出来 —— 不说的话用户在 .neox/mcp.json 里明明
         * 看得见配置, 却发现工具没出现, 只会以为 MCP 坏了。 */
        const untrusted = servers.filter(
          (s) => s.scope === 'workspace' && !isWorkspaceServerTrusted(options.workDir, s));
        if (untrusted.length > 0) {
          cliPrintln('');
          cliPrintln(colors.warning(`⚠ ${untrusted.length} 台来自这个仓库的 server 还没批准, 不会被连接:`));
          for (const s of untrusted) cliPrintln(colors.dim(`    ${s.id}  ${s.command ?? s.url ?? ''}`));
          cliPrintln(colors.dim('  看过配置确认没问题后: neox mcp trust <id>'));
        }
        return 0;
      }
      /* 仓库带的 MCP server 默认不连 (见 core/mcp/mcpTrust.ts): `.neox/mcp.json` 是仓库里的
       * 一个文件, 一条 stdio server 就是"打开这个工作区就执行任意命令"。
       * `mcp add` 那条确认防的是"用户自己抄别人的命令", 这条防的是"clone 下来就带着"。 */
      case 'trust':
      case 'untrust': {
        const serverId = (rest[0] ?? '').trim();
        if (!serverId) {
          cliPrintln(colors.error(`✗ 用法: neox mcp ${normalized} <server-id>`));
          return 1;
        }
        const server = listMcpServers(options.workDir).find((s) => s.id === serverId);
        if (!server) {
          cliPrintln(colors.warning(`MCP server "${serverId}" 不存在`));
          return 1;
        }
        if (normalized === 'untrust') {
          revokeWorkspaceTrust(options.workDir, server);
          cliPrintln(colors.success(`✓ 已撤销对 "${serverId}" 的信任`));
          return 0;
        }
        if (server.scope !== 'workspace') {
          cliPrintln(colors.dim(`"${serverId}" 是用户级配置 (你自己加的), 本来就不过这道闸。`));
          return 0;
        }
        /* 批准之前把它到底会跑什么**原样摆出来** —— 让人闭着眼点同意的确认没有价值 */
        cliPrintln('');
        cliPrintln(colors.warning('⚠ 这台 server 来自当前仓库的 .neox/mcp.json, 不是你加的'));
        cliPrintln(colors.dim('  批准之后, 每次在这个工作区启动都会把它跑起来:'));
        cliPrintln('');
        cliPrintln(colors.dim('  Transport: ') + (server.transport ?? 'stdio'));
        if (server.command) {
          cliPrintln(colors.dim('  Command:   ') + colors.info(`${server.command} ${(server.args || []).join(' ')}`));
        }
        if (server.url) cliPrintln(colors.dim('  URL:       ') + colors.info(server.url));
        const envKeys = Object.keys(server.env || {});
        if (envKeys.length > 0) cliPrintln(colors.dim('  Env keys:  ') + envKeys.join(', '));
        cliPrintln('');
        if (!process.stdin.isTTY) {
          cliPrintln(colors.error('✗ 非交互模式不能批准 —— 这一步必须由人看过再点头'));
          return 1;
        }
        const { createInterface } = await import('node:readline/promises');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question('批准它吗? [y/N]: ').catch(() => '');
        rl.close();
        if (!answer.trim().toLowerCase().startsWith('y')) {
          cliPrintln(colors.dim('没批准, 配置没动。'));
          return 0;
        }
        if (!trustWorkspaceServer(options.workDir, server)) {
          cliPrintln(colors.error('✗ 这台 server 的配置残缺 (算不出签名), 没法记录信任'));
          return 1;
        }
        cliPrintln(colors.success(`✓ 已批准 "${serverId}" —— 改动它的 command 后需要重新批准`));
        return 0;
      }
      case 'remove': {
        const { serverId, scope } = parseMcpRemoveArgs(rest);
        const removed = removeMcpServer(options.workDir, scope, serverId);
        if (!removed) {
          cliPrintln(colors.warning(`MCP server "${serverId}" not found in ${scope} scope`));
          return 1;
        }
        cliPrintln(colors.success(`✓ MCP server "${serverId}" removed (${scope})`));
        return 0;
      }
      case 'enable':
      case 'disable': {
        const enabled = normalized === 'enable';
        const { serverId, scope } = parseMcpRemoveArgs(rest);
        const updated = updateMcpServer(options.workDir, scope, serverId, { enabled });
        if (!updated) {
          cliPrintln(colors.warning(`MCP server "${serverId}" not found in ${scope} scope`));
          return 1;
        }
        cliPrintln(colors.success(`✓ MCP server "${serverId}" ${enabled ? 'enabled' : 'disabled'} (${scope})`));
        return 0;
      }
      case 'connect':
      case 'test': {
        const serverId = rest[0];
        if (!serverId) {
          cliPrintln(colors.warning('Usage: neox mcp connect <serverId>'));
          return 1;
        }
        const scopeArg = parseScopeArg(rest.slice(1));
        const manager = new MCPClientManager({ workDir: options.workDir });
        if (normalized === 'connect') {
          await manager.connect(serverId);
          const toolDefs = await manager.getToolDefinitions(serverId);
          const scope = resolveScopeForId(options.workDir, serverId, scopeArg);
          if (scope) {
            updateMcpServer(options.workDir, scope, serverId, {
              toolCache: toolDefs,
              toolCacheUpdatedAt: new Date().toISOString(),
            });
          }
          cliPrintln(colors.success(`✓ MCP server "${serverId}" connected`));
          return 0;
        }
        const toolDefs = await manager.getToolDefinitions(serverId);
        const result = { toolCount: toolDefs.length, tools: toolDefs.map((tool) => tool.name) };
        const scope = resolveScopeForId(options.workDir, serverId, scopeArg);
        if (scope) {
          updateMcpServer(options.workDir, scope, serverId, {
            toolCache: toolDefs,
            toolCacheUpdatedAt: new Date().toISOString(),
          });
        }
        cliPrintln(colors.success(`✓ MCP server "${serverId}" ok (${result.toolCount} tools)`));
        if (result.toolCount > 0) {
          result.tools.forEach((tool) => cliPrintln(colors.dim(`  - ${tool}`)));
        }
        return 0;
      }
      case '':
      case 'help':
      case '--help':
      case '-h':
        printMcpCliUsage();
        return 0;
      default:
        cliPrintln(colors.error(`✗ Unknown mcp subcommand: "${normalized}"`));
        printMcpCliUsage();
        return 1;
    }
  } catch (error: any) {
    cliPrintln(colors.error(`✗ MCP command failed: ${error?.message || error}`));
    return 1;
  }
}

function printMcpCliUsage(): void {
  cliPrintln('Usage: neox mcp <list|add|remove|enable|disable|connect|test> ...');
  cliPrintln('');
  cliPrintln('  list                                     List configured MCP servers');
  cliPrintln('  add <id> [--scope user|workspace] [--transport stdio|http|sse] [--url <url>] [--env K=V] [--yes] <command...>');
  cliPrintln('  remove <id> [--scope user|workspace]     Remove a server');
  cliPrintln('  enable|disable <id> [--scope ...]        Toggle a server');
  cliPrintln('  connect <id>                             Connect and cache tool list');
  cliPrintln('  test <id>                                Test connection, print tools');
}

async function handleMcpList(ctx: McpCommandContext): Promise<void> {
  const servers = listMcpServers(ctx.workDir);
  outputServerList(ctx, servers);
}

async function handleMcpAddInteractive(ctx: McpCommandContext): Promise<void> {
  const id = await ctx.promptText('MCP 服务器名 (id)', { allowEmpty: false });
  if (!id) {
    return;
  }

  const scope = await ctx.promptSelect(
    '作用范围',
    [
      { label: '全局', value: 'user', description: '所有项目可用' },
      { label: '当前工作区', value: 'workspace', description: '只在这个项目里' },
    ],
    'user',
  );

  const transport = await ctx.promptSelect(
    '连接方式',
    [
      { label: 'stdio', value: 'stdio', description: '本地命令启动 (最常见)' },
      { label: 'http', value: 'http', description: 'Streamable HTTP' },
      { label: 'sse', value: 'sse', description: '旧版 SSE' },
    ],
    'stdio',
  );

  const server: MCPServerConfig = {
    id,
    name: id,
    transport: transport as MCPTransport,
    enabled: true,
    autoConnect: false,
  };

  if (server.transport === 'stdio') {
    const cmdLine = await ctx.promptText('Command (e.g. npx chrome-devtools-mcp@latest)', {
      allowEmpty: false,
    });
    if (!cmdLine) {
      return;
    }
    const parts = splitCommandLine(cmdLine);
    server.command = parts[0];
    server.args = parts.slice(1);
  } else {
    const url = await ctx.promptText(server.transport === 'sse' ? 'SSE URL' : 'URL', { allowEmpty: false });
    if (!url) {
      return;
    }
    server.url = url;
  }

  try {
    addMcpServer(ctx.workDir, scope as MCPConfigScope, server);
    await ctx.refreshMcpTools?.();
    ctx.logInfo('MCP server added', `${server.id} (${scope})`);
  } catch (error: any) {
    ctx.logInfo('Failed to add MCP server', error?.message || String(error));
  }
}

async function handleMcpRemoveInteractive(ctx: McpCommandContext): Promise<void> {
  const servers = listMcpServers(ctx.workDir);
  if (servers.length === 0) {
    ctx.logInfo('No MCP servers configured');
    return;
  }
  const { serverId, scope } = await selectServer(ctx, servers, 'Remove MCP server');
  const removed = removeMcpServer(ctx.workDir, scope, serverId);
  if (!removed) {
    ctx.logInfo('MCP server not found', `${serverId} (${scope})`);
    return;
  }
  await ctx.refreshMcpTools?.();
  ctx.logInfo('MCP server removed', `${serverId} (${scope})`);
}

async function handleMcpToggle(ctx: McpCommandContext, enabled: boolean): Promise<void> {
  const servers = listMcpServers(ctx.workDir);
  if (servers.length === 0) {
    ctx.logInfo('No MCP servers configured');
    return;
  }
  const { serverId, scope } = await selectServer(
    ctx,
    servers,
    enabled ? 'Enable MCP server' : 'Disable MCP server',
  );
  const updated = updateMcpServer(ctx.workDir, scope, serverId, { enabled });
  if (!updated) {
    ctx.logInfo('MCP server not found', `${serverId} (${scope})`);
    return;
  }
  await ctx.refreshMcpTools?.();
  ctx.logInfo('MCP server updated', `${serverId} (${enabled ? 'enabled' : 'disabled'})`);
}

async function handleMcpConnect(ctx: McpCommandContext): Promise<void> {
  const servers = listMcpServers(ctx.workDir);
  if (servers.length === 0) {
    ctx.logInfo('No MCP servers configured');
    return;
  }
  const { serverId, scope } = await selectServer(ctx, servers, 'Connect MCP server');
  try {
    await ctx.mcpManager.connect(serverId);
    const toolDefs = await ctx.mcpManager.getToolDefinitions(serverId);
    updateMcpServer(ctx.workDir, scope, serverId, {
      toolCache: toolDefs,
      toolCacheUpdatedAt: new Date().toISOString(),
    });
    await ctx.refreshMcpTools?.();
    ctx.logInfo('MCP connected', serverId);
  } catch (error: any) {
    ctx.logInfo('MCP connect failed', error?.message || String(error));
  }
}

async function handleMcpDisconnect(ctx: McpCommandContext): Promise<void> {
  const servers = listMcpServers(ctx.workDir);
  if (servers.length === 0) {
    ctx.logInfo('No MCP servers configured');
    return;
  }
  const { serverId } = await selectServer(ctx, servers, 'Disconnect MCP server');
  try {
    await ctx.mcpManager.disconnect(serverId);
    await ctx.refreshMcpTools?.();
    ctx.logInfo('MCP disconnected', serverId);
  } catch (error: any) {
    ctx.logInfo('MCP disconnect failed', error?.message || String(error));
  }
}

async function handleMcpTest(ctx: McpCommandContext): Promise<void> {
  const servers = listMcpServers(ctx.workDir);
  if (servers.length === 0) {
    ctx.logInfo('No MCP servers configured');
    return;
  }
  const { serverId, scope } = await selectServer(ctx, servers, 'Test MCP server');
  try {
    const toolDefs = await ctx.mcpManager.getToolDefinitions(serverId);
    const result = { toolCount: toolDefs.length, tools: toolDefs.map((tool) => tool.name) };
    updateMcpServer(ctx.workDir, scope, serverId, {
      toolCache: toolDefs,
      toolCacheUpdatedAt: new Date().toISOString(),
    });
    ctx.logInfo('MCP test ok', `${serverId} (${result.toolCount} tools)`);
    if (result.toolCount > 0) {
      const lines = result.tools.map((tool) => colors.dim(`  - ${tool}`));
      outputToUI(ctx, [''].concat(lines));
    }
  } catch (error: any) {
    ctx.logInfo('MCP test failed', error?.message || String(error));
  }
}

async function selectServer(
  ctx: McpCommandContext,
  servers: ReturnType<typeof listMcpServers>,
  title: string,
): Promise<{ serverId: string; scope: MCPConfigScope }> {
  const choices: SelectionChoice[] = servers.map((server) => ({
    label: `${server.id} (${server.scope})`,
    value: server.id,
    description: server.transport === 'stdio'
      ? `${server.command || ''} ${(server.args || []).join(' ')}`.trim()
      : server.url || '',
  }));
  const selected = await ctx.promptSelect(title, choices);
  const match = servers.find((server) => server.id === selected);
  if (!match) {
    throw new Error('Selected MCP server not found');
  }
  return { serverId: match.id, scope: match.scope };
}

function outputServerList(
  ctx: { outputLines?: (lines: string[]) => void },
  servers: ReturnType<typeof listMcpServers>,
): void {
  if (servers.length === 0) {
    outputToUI(ctx, ['', colors.info('No MCP servers configured.'), '']);
    return;
  }

  const lines: string[] = [''];
  lines.push(colors.highlight('  MCP Servers'));
  lines.push(colors.dim('  ─────────────────────────────────────────'));
  for (const server of servers) {
    const status = server.enabled === false ? colors.warning('disabled') : colors.success('enabled');
    const scope = colors.dim(`[${server.scope}]`);
    const transport = colors.dim(server.transport);
    const toolCount = server.toolCache ? server.toolCache.length : 0;
    const toolInfo = colors.dim(`tools:${toolCount}`);
    const detail = server.transport === 'stdio'
      ? `${server.command || ''} ${(server.args || []).join(' ')}`.trim()
      : server.url || '';
    lines.push(`  ${colors.primary(server.id)} ${scope} ${status} ${transport} ${toolInfo}`);
    if (detail) {
      lines.push(colors.dim(`    ${detail}`));
    }
  }
  lines.push('');
  outputToUI(ctx, lines);
}

function parseMcpAddArgs(args: string[]): ParsedMcpAddArgs {
  const [id, ...rest] = args;
  if (!id) {
    throw new Error('Usage: neox mcp add <id> [--scope user|workspace] <command...>');
  }

  const parsed: ParsedMcpAddArgs = {
    id,
    scope: 'user',
    transport: 'stdio',
    enabled: true,
    autoConnect: false,
    env: {},
  };

  const commandParts: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--') {
      commandParts.push(...rest.slice(i + 1));
      break;
    }

    if (!token.startsWith('-')) {
      commandParts.push(...rest.slice(i));
      break;
    }

    switch (token) {
      case '--scope':
        parsed.scope = (rest[++i] as MCPConfigScope) || 'user';
        break;
      case '--name':
        parsed.name = rest[++i];
        break;
      case '--transport':
        parsed.transport = (rest[++i] as MCPTransport) || 'stdio';
        break;
      case '--url':
        parsed.url = rest[++i];
        break;
      case '--env': {
        const raw = rest[++i];
        if (!raw || !raw.includes('=')) {
          throw new Error('Invalid --env format, expected KEY=VALUE');
        }
        const [key, ...valueParts] = raw.split('=');
        parsed.env[key] = valueParts.join('=');
        break;
      }
      case '--auto-connect':
        parsed.autoConnect = true;
        break;
      case '--no-auto-connect':
        parsed.autoConnect = false;
        break;
      case '--yes':
      case '-y':
        parsed.yes = true;
        break;
      case '--allow':
        parsed.allowlist = splitList(rest[++i]);
        break;
      case '--deny':
        parsed.denylist = splitList(rest[++i]);
        break;
      default:
        throw new Error(`Unknown option: ${token}`);
    }
  }

  if (parsed.transport !== 'stdio' && parsed.transport !== 'sse' && parsed.transport !== 'http') {
    throw new Error(`Unknown --transport "${parsed.transport}", expected stdio, http or sse`);
  }
  if (parsed.transport === 'sse' || parsed.transport === 'http') {
    if (!parsed.url) {
      throw new Error(`${parsed.transport} transport requires --url`);
    }
    if (parsed.scope !== 'user' && parsed.scope !== 'workspace') {
      throw new Error('Invalid scope, expected user or workspace');
    }
    return parsed;
  }

  if (commandParts.length === 0) {
    throw new Error('stdio transport requires a command, e.g. npx chrome-devtools-mcp@latest');
  }
  parsed.command = commandParts[0];
  parsed.args = commandParts.slice(1);
  if (parsed.scope !== 'user' && parsed.scope !== 'workspace') {
    throw new Error('Invalid scope, expected user or workspace');
  }
  return parsed;
}

function parseMcpRemoveArgs(args: string[]): { serverId: string; scope: MCPConfigScope } {
  const [serverId, ...rest] = args;
  if (!serverId) {
    throw new Error('Usage: neox mcp remove <id> [--scope user|workspace]');
  }
  let scope: MCPConfigScope = 'user';
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--scope') {
      scope = (rest[i + 1] as MCPConfigScope) || 'user';
      break;
    }
  }
  if (scope !== 'user' && scope !== 'workspace') {
    throw new Error('Invalid scope, expected user or workspace');
  }
  return { serverId, scope };
}

function parseScopeArg(args: string[]): MCPConfigScope | null {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--scope') {
      const scope = (args[i + 1] as MCPConfigScope) || 'user';
      if (scope === 'user' || scope === 'workspace') {
        return scope;
      }
      throw new Error('Invalid scope, expected user or workspace');
    }
  }
  return null;
}

function resolveScopeForId(
  workDir: string,
  serverId: string,
  scopeArg: MCPConfigScope | null
): MCPConfigScope | null {
  if (scopeArg) {
    return scopeArg;
  }
  const servers = listMcpServers(workDir);
  const match = servers.find((server) => server.id === serverId);
  return match?.scope ?? null;
}

function buildServerFromParsed(parsed: ParsedMcpAddArgs): MCPServerConfig {
  return {
    id: parsed.id,
    name: parsed.name ?? parsed.id,
    transport: parsed.transport,
    command: parsed.command,
    args: parsed.args,
    env: Object.keys(parsed.env).length > 0 ? parsed.env : undefined,
    url: parsed.url,
    enabled: parsed.enabled,
    autoConnect: parsed.autoConnect,
    allowlist: parsed.allowlist,
    denylist: parsed.denylist,
  };
}

function splitCommandLine(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

function splitList(value?: string): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

interface ParsedMcpAddArgs {
  id: string;
  name?: string;
  scope: MCPConfigScope;
  transport: MCPTransport;
  command?: string;
  args?: string[];
  url?: string;
  env: Record<string, string>;
  autoConnect?: boolean;
  enabled?: boolean;
  allowlist?: string[];
  denylist?: string[];
  /** P1-9: --yes / -y 跳过 confirm (CI 用). 默认 stdio 必须 prompt 确认. */
  yes?: boolean;
}

/**
 * Interactive MCP server list with edit/delete actions
 */
async function handleMcpListInteractive(ctx: McpCommandContext): Promise<void> {
  const servers = listMcpServers(ctx.workDir);
  if (servers.length === 0) {
    ctx.logInfo('No MCP servers configured');
    return;
  }

  while (true) {
    try {
      const choices: SelectionChoice[] = servers.map((server) => {
        const status = server.enabled === false ? colors.error('●') : colors.success('●');
        const toolCount = server.toolCache ? server.toolCache.length : 0;
        const detail = server.transport === 'stdio'
          ? `${server.command || ''} ${(server.args || []).join(' ')}`.trim()
          : server.url || '';
        return {
          label: `${status} ${server.id} [${server.scope}] (${toolCount} tools)`,
          value: server.id,
          description: detail,
        };
      });

      choices.push({ label: '← Back', value: '__back__' });

      const selected = await ctx.promptSelect(
        'MCP Servers (select to manage)',
        choices,
        undefined,
        'Use ↑↓ then Enter'
      );

      if (selected === '__back__') {
        return;
      }

      const server = servers.find((s) => s.id === selected);
      if (!server) {
        continue;
      }

      await handleServerActions(ctx, server);
    } catch (error: any) {
      if (error?.message === 'cancelled') {
        return;
      }
      ctx.logInfo('Error', error?.message || String(error));
      return;
    }
  }
}

/**
 * Handle actions for a selected server
 */
async function handleServerActions(ctx: McpCommandContext, server: MCPServerEntry): Promise<void> {
  const toolCount = server.toolCache ? server.toolCache.length : 0;
  const statusText = server.enabled === false ? 'Disabled' : 'Enabled';

  const action = await ctx.promptSelect(
    `Manage: ${server.id} (${statusText}, ${toolCount} tools)`,
    [
      { label: 'View details', value: 'view' },
      { label: 'Edit', value: 'edit' },
      { label: 'Test connection', value: 'test' },
      { label: server.enabled === false ? 'Enable' : 'Disable', value: 'toggle' },
      { label: 'Delete', value: 'delete' },
      { label: '← Back', value: 'back' },
    ],
    'view',
    'Use ↑↓ then Enter'
  );

  switch (action) {
    case 'view':
      await showServerDetails(ctx, server);
      break;
    case 'edit':
      await editServer(ctx, server);
      break;
    case 'test':
      await testServerConnection(ctx, server);
      break;
    case 'toggle':
      await toggleServerEnabled(ctx, server);
      break;
    case 'delete':
      await deleteServer(ctx, server);
      break;
    case 'back':
      return;
  }
}

/**
 * Show server details
 */
async function showServerDetails(ctx: McpCommandContext, server: MCPServerEntry): Promise<void> {
  const lines: string[] = [''];
  lines.push(colors.highlight(`  Server: ${server.id}`));
  lines.push(colors.dim('  ─────────────────────────────────────────'));
  lines.push(`  ${colors.dim('Name:')} ${server.name || server.id}`);
  lines.push(`  ${colors.dim('Scope:')} ${server.scope}`);
  lines.push(`  ${colors.dim('Transport:')} ${server.transport}`);
  lines.push(`  ${colors.dim('Status:')} ${server.enabled === false ? colors.warning('disabled') : colors.success('enabled')}`);

  if (server.transport === 'stdio') {
    lines.push(`  ${colors.dim('Command:')} ${server.command || ''}`);
    if (server.args && server.args.length > 0) {
      lines.push(`  ${colors.dim('Args:')} ${server.args.join(' ')}`);
    }
  } else {
    lines.push(`  ${colors.dim('URL:')} ${server.url || ''}`);
  }

  const toolCount = server.toolCache ? server.toolCache.length : 0;
  lines.push(`  ${colors.dim('Tools:')} ${toolCount}`);

  if (server.toolCacheUpdatedAt) {
    lines.push(`  ${colors.dim('Cache updated:')} ${new Date(server.toolCacheUpdatedAt).toLocaleString()}`);
  }

  lines.push('');
  outputToUI(ctx, lines);
}

type MCPServerEntry = ReturnType<typeof listMcpServers>[number];

/**
 * Toggle global MCP enabled/disabled
 */
async function handleMcpToggleGlobal(ctx: McpCommandContext): Promise<void> {
  const currentEnabled = ctx.mcpManager.isEnabled();
  const newEnabled = !currentEnabled;
  ctx.mcpManager.setEnabled(newEnabled);
  await ctx.refreshMcpTools?.();
  ctx.logInfo('MCP', newEnabled ? 'Enabled' : 'Disabled');
}

/**
 * Edit server configuration
 */
async function editServer(ctx: McpCommandContext, server: MCPServerEntry): Promise<void> {
  const field = await ctx.promptSelect(
    `Edit ${server.id}`,
    [
      { label: 'Command/URL', value: 'command' },
      { label: 'Name', value: 'name' },
      { label: '← Back', value: 'back' },
    ],
    'command',
  );

  if (field === 'back') {
    return;
  }

  if (field === 'name') {
    const newName = await ctx.promptText('New name', { defaultValue: server.name || server.id });
    if (newName) {
      updateMcpServer(ctx.workDir, server.scope, server.id, { name: newName });
      await ctx.refreshMcpTools?.();
      ctx.logInfo('Server updated', `${server.id}: name = ${newName}`);
    }
    return;
  }

  if (field === 'command') {
    if (server.transport === 'stdio') {
      const currentCmd = `${server.command || ''} ${(server.args || []).join(' ')}`.trim();
      const newCmd = await ctx.promptText('Command', { defaultValue: currentCmd });
      if (newCmd) {
        const parts = newCmd.split(/\s+/).filter(Boolean);
        updateMcpServer(ctx.workDir, server.scope, server.id, {
          command: parts[0],
          args: parts.slice(1),
        });
        await ctx.refreshMcpTools?.();
        ctx.logInfo('Server updated', `${server.id}: command = ${newCmd}`);
      }
    } else {
      const newUrl = await ctx.promptText('URL', { defaultValue: server.url || '' });
      if (newUrl) {
        updateMcpServer(ctx.workDir, server.scope, server.id, { url: newUrl });
        await ctx.refreshMcpTools?.();
        ctx.logInfo('Server updated', `${server.id}: url = ${newUrl}`);
      }
    }
  }
}

/**
 * Test server connection
 */
async function testServerConnection(ctx: McpCommandContext, server: MCPServerEntry): Promise<void> {
  try {
    ctx.logInfo('Testing', server.id);
    const toolDefs = await ctx.mcpManager.getToolDefinitions(server.id);
    updateMcpServer(ctx.workDir, server.scope, server.id, {
      toolCache: toolDefs,
      toolCacheUpdatedAt: new Date().toISOString(),
    });
    ctx.logInfo('Test OK', `${server.id} (${toolDefs.length} tools)`);
    if (toolDefs.length > 0) {
      const lines = toolDefs.slice(0, 10).map((tool) => colors.dim(`  - ${tool.name}`));
      if (toolDefs.length > 10) {
        lines.push(colors.dim(`  ... and ${toolDefs.length - 10} more`));
      }
      outputToUI(ctx, [''].concat(lines));
    }
  } catch (error: any) {
    ctx.logInfo('Test failed', error?.message || String(error));
  }
}

/**
 * Toggle server enabled/disabled
 */
async function toggleServerEnabled(ctx: McpCommandContext, server: MCPServerEntry): Promise<void> {
  const newEnabled = server.enabled === false;
  updateMcpServer(ctx.workDir, server.scope, server.id, { enabled: newEnabled });
  await ctx.refreshMcpTools?.();
  ctx.logInfo('Server updated', `${server.id}: ${newEnabled ? 'enabled' : 'disabled'}`);
}

/**
 * Delete server
 */
async function deleteServer(ctx: McpCommandContext, server: MCPServerEntry): Promise<void> {
  const confirm = await ctx.promptSelect(
    `Delete ${server.id}?`,
    [
      { label: 'Cancel', value: 'no' },
      { label: 'Delete', value: 'yes' },
    ],
    'no',
  );

  if (confirm !== 'yes') {
    return;
  }

  const removed = removeMcpServer(ctx.workDir, server.scope, server.id);
  if (removed) {
    await ctx.refreshMcpTools?.();
    ctx.logInfo('Server deleted', server.id);
  } else {
    ctx.logInfo('Delete failed', 'Server not found');
  }
}
