/**
 * Plugin CLI Commands — /plugins 命令实现
 *
 * 命令:
 *   /plugins                  交互式列表
 *   /plugins list             已安装列表
 *   /plugins install <path>   安装插件
 *   /plugins remove <name>    卸载插件
 *   /plugins enable <name>    启用
 *   /plugins disable <name>   禁用
 *   /plugins info <name>      详细信息
 *   /plugins create <name>    创建模板 (Phase 4)
 *   /plugins dev <path>       开发模式
 *
 * 市场相关的子命令 (search / featured / update …) 不在这里: 发行版通过
 * registerPluginSubcommand 追加 (官方市场见 plugins/marketplace/)。
 */

import {
  installFromPath,
  uninstallPlugin,
  enablePlugin,
  disablePlugin,
  getPluginInfo,
  listPlugins,
  devLoadPlugin,
} from '../pluginManager.js';
import type { InstalledPlugin } from '@neoxlabs/platform/shared/plugin-types.js';
import { getPluginInstallSource } from '../pluginInstallSources.js';

export interface PluginCommandResult {
  output: string;
  success: boolean;
}

/**
 * 发行版追加的子命令 (官方市场的 search / featured / update … 在商业发行版里注册)。
 * 内置子命令优先; 注册表只接住内置 switch 不认识的名字。
 */
export interface PluginSubcommand {
  names: string[];
  run(rest: string): Promise<PluginCommandResult>;
}

export interface PluginHelpContribution {
  /** 插在 install 那组用法后面 */
  install?: string[];
  /** 作为独立一段插在 dev 之后 */
  section?: string[];
}

const extraSubcommands = new Map<string, PluginSubcommand>();
const helpContributions: PluginHelpContribution[] = [];

export function registerPluginSubcommand(command: PluginSubcommand): void {
  for (const name of command.names) extraSubcommands.set(name.toLowerCase(), command);
}

export function registerPluginHelp(help: PluginHelpContribution): void {
  helpContributions.push(help);
}

/**
 * 路由 /plugins 命令
 */
export async function handlePluginCommand(rawArgs: string): Promise<PluginCommandResult> {
  const args = rawArgs.trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase() || 'list';
  const rest = args.slice(1).join(' ').trim();

  switch (subcommand) {
    case 'list':
    case 'ls':
      return handleList();

    case 'install':
    case 'add':
      return handleInstall(rest);

    case 'remove':
    case 'uninstall':
    case 'rm':
      return handleRemove(rest);

    case 'enable':
      return handleEnable(rest);

    case 'disable':
      return handleDisable(rest);

    case 'info':
      return handleInfo(rest);

    case 'dev':
      return handleDev(rest);

    case 'create':
      return handleCreate(rest);

    case 'pack':
      return handlePack(rest);

    case 'connect':
      return handleConnect(rest);

    case 'disconnect':
      return handleDisconnect(rest);

    case 'connectors':
      return handleConnectors();

    case 'agents':
      return handleExternalAgents();

    case 'help':
      return { output: helpText(), success: true };

    default: {
      const extra = extraSubcommands.get(subcommand);
      if (extra) return extra.run(rest);
      return { output: `Unknown subcommand: "${subcommand}"\n\n${helpText()}`, success: false };
    }
  }
}

// ============================================================================
// Subcommand Handlers
// ============================================================================

async function handleList(): Promise<PluginCommandResult> {
  const plugins = await listPlugins();
  if (plugins.length === 0) {
    return {
      output: `No plugins installed.\n\nInstall a plugin:\n  /plugins install ./path/to/plugin\n  /plugins search <keyword>`,
      success: true,
    };
  }

  const lines = ['Installed Plugins:', ''];
  for (const p of plugins) {
    const status = p.enabled ? '✓' : '✗';
    const src = p.source.type === 'dev' ? ' [dev]' : '';
    lines.push(`  ${status} ${p.name} v${p.version}${src}`);
  }
  lines.push('');
  lines.push(`Total: ${plugins.length} (${plugins.filter(p => p.enabled).length} enabled)`);
  lines.push('');
  lines.push('Use /plugins info <name> for details');

  return { output: lines.join('\n'), success: true };
}

async function handleInstall(input: string): Promise<PluginCommandResult> {
  const arg = input.trim();
  if (!arg) {
    return {
      output: [
        'Usage:',
        '  /plugins install <path>                 — Install from local path',
        '  /plugins install <url>                  — Install from tarball or git URL',
        ...(getPluginInstallSource('marketplace')
          ? ['  /plugins install --marketplace <name>   — Install from marketplace']
          : []),
      ].join('\n'),
      success: false,
    };
  }

  // 显式 --<来源> 前缀 (例: --marketplace <name>), 来源由发行版注册
  const sourceFlag = /^--([a-z][\w-]*)(?:[ =]|$)/.exec(arg);
  if (sourceFlag) {
    const sourceId = sourceFlag[1]!;
    const source = getPluginInstallSource(sourceId);
    if (!source) return { output: `✗ Unknown install source: --${sourceId}`, success: false };
    const name = arg.slice(sourceFlag[0].length).trim();
    if (!name) return { output: `Usage: /plugins install --${sourceId} <name>`, success: false };
    return formatResult(await source.install(name));
  }

  // URL: tarball 或 git
  if (/^(https?:\/\/|git@|git\+)/.test(arg) || arg.endsWith('.git')) {
    const { installFromRemoteUrl } = await import('../pluginInstaller.js');
    return formatResult(await installFromRemoteUrl(arg));
  }

  // .neox-plugin 包 — 走带完整性校验的导入
  if (/\.neox-plugin$/i.test(arg)) {
    const { installFromFile } = await import('../pluginPackager.js');
    const result = await installFromFile(arg);
    const formatted = formatResult(result);
    if (result.success && result.trust) {
      formatted.output += `\n  签名: ${TRUST_LABEL[result.trust]}`;
    }
    return formatted;
  }

  // Fallback: local path
  return formatResult(await installFromPath(arg));
}

const TRUST_LABEL: Record<string, string> = {
  official: '官方签名',
  'signed-unknown': '已签名 (公钥未在受信任列表)',
  unsigned: '未签名',
};

// ============================================================================
// 打包 / 连接器
// ============================================================================

async function handlePack(input: string): Promise<PluginCommandResult> {
  const args = input.trim().split(/\s+/).filter(Boolean);
  const dir = args[0];
  if (!dir) {
    return {
      output: [
        'Usage:',
        '  /plugins pack <dir> [--out=<file>] [--key=<ed25519-private-key.pem>]',
        '',
        '产出 .neox-plugin: 逐文件 sha256 清单 + 可选 ed25519 签名。',
        '不带 --key 也能打, 导入端会显示「未签名」。',
      ].join('\n'),
      success: false,
    };
  }

  const outArg = args.find(a => a.startsWith('--out='))?.slice(6);
  const keyArg = args.find(a => a.startsWith('--key='))?.slice(6);

  try {
    const { packPlugin } = await import('../pluginPackager.js');
    let privateKeyPem: string | undefined;
    if (keyArg) {
      const fs = await import('fs/promises');
      privateKeyPem = await fs.readFile(keyArg, 'utf-8');
    }
    const result = await packPlugin(dir, { outFile: outArg, privateKeyPem });
    return {
      output: [
        `✅ ${result.manifest.name} v${result.manifest.version} → ${result.outFile}`,
        `  ${result.fileCount} 个文件, ${(result.bytes / 1024).toFixed(1)} KB`,
        `  digest: ${result.manifest.digest.slice(0, 16)}…`,
        `  签名: ${result.manifest.signature ? 'ed25519' : '无'}`,
      ].join('\n'),
      success: true,
    };
  } catch (err: any) {
    return { output: `✗ 打包失败: ${err?.message ?? String(err)}`, success: false };
  }
}

async function handleConnectors(): Promise<PluginCommandResult> {
  const { connectorRegistry } = await import('../connector/connectorRegistry.js');
  const { hasCredential } = await import('../connector/credentialStore.js');
  const { getGrants } = await import('../connector/grantStore.js');
  const { localized } = await import('@neoxlabs/platform/shared/plugin-connector.js');

  const list = connectorRegistry.list();
  if (list.length === 0) {
    return {
      output: '当前没有已启用的连接器。\n\n导入一个: /plugins install <文件.neox-plugin>',
      success: true,
    };
  }

  const lines = ['Connectors:', ''];
  for (const entry of list) {
    const connected = await hasCredential(entry.pluginName);
    const granted = getGrants(entry.pluginName).length;
    lines.push(`  ${connected ? '●' : '○'} ${localized(entry.connector.displayName) || entry.pluginName} (${entry.connector.namespace})`);
    lines.push(`      ${connected ? '已连接' : '未连接'} · 已授予 ${granted}/${entry.connector.permissions.length} 项能力`);
    lines.push(`      工具: ${entry.tools.map(t => t.name).join(', ')}`);
  }
  lines.push('');
  lines.push('连接: /plugins connect <name> <token>');
  return { output: lines.join('\n'), success: true };
}

async function handleExternalAgents(): Promise<PluginCommandResult> {
  const { externalAgentRegistry } = await import('../externalAgent/externalAgentRegistry.js');
  const list = await externalAgentRegistry.status();
  if (list.length === 0) {
    return {
      output: '当前没有已启用的外部 Agent。\n\n导入一个: /plugins install <文件.neox-plugin>',
      success: true,
    };
  }

  const lines = ['External agents:', ''];
  for (const a of list) {
    lines.push(`  ${a.installed ? '●' : '○'} ${a.displayName}  →  ${a.id}_delegate`);
    lines.push(`      ${a.installed ? a.version ?? '已安装' : '未安装'} · ${a.isolation === 'worktree' ? '独立 worktree' : '⚠ 直接改工作区'}`);
    if (!a.installed) lines.push(`      ${a.installHint}`);
    for (const p of a.examplePrompts.slice(0, 2)) lines.push(`      例:「${p}」`);
  }
  return { output: lines.join('\n'), success: true };
}

async function handleConnect(input: string): Promise<PluginCommandResult> {
  const [name, ...rest] = input.trim().split(/\s+/).filter(Boolean);
  const token = rest.join(' ');
  if (!name || !token) {
    return {
      output: 'Usage: /plugins connect <name> <token>\n\n拿 token 的方式: /plugins info <name>',
      success: false,
    };
  }

  const { connectorRegistry } = await import('../connector/connectorRegistry.js');
  const entry = connectorRegistry.get(name);
  if (!entry) return { output: `✗ 未找到已启用的连接器: ${name}`, success: false };
  if (entry.connector.auth.kind !== 'token') {
    return { output: `✗ ${name} 用的是 ${entry.connector.auth.kind} 授权, 不能直接粘贴令牌`, success: false };
  }

  const { saveCredential } = await import('../connector/credentialStore.js');
  await saveCredential(name, { kind: 'token', token });
  return {
    output: `✅ ${name} 已连接。凭据已加密存放, 只有本机能解开。\n可用工具: ${entry.tools.map(t => t.name).join(', ')}`,
    success: true,
  };
}

async function handleDisconnect(name: string): Promise<PluginCommandResult> {
  if (!name) return { output: 'Usage: /plugins disconnect <name>', success: false };
  const { deleteCredential, clearConnection } = await import('../connector/credentialStore.js');
  const { revokeGrants } = await import('../connector/grantStore.js');
  await deleteCredential(name);
  await clearConnection(name);
  revokeGrants(name);
  return { output: `✅ ${name} 已断开连接, 凭据与授权已清除。`, success: true };
}

function formatResult(result: {
  success: boolean;
  errors: string[];
  warnings: string[];
  manifest?: { name: string; version: string; skills?: string[]; tools?: string[]; mcpServers?: Record<string, unknown> };
}): PluginCommandResult {
  if (!result.success) {
    return {
      output: `✗ Installation failed:\n${result.errors.map(e => `  - ${e}`).join('\n')}`,
      success: false,
    };
  }
  const m = result.manifest;
  const lines: string[] = [];
  if (m) {
    lines.push(`✅ ${m.name} v${m.version} installed successfully!`);
    if (m.skills?.length) lines.push(`  Skills: ${m.skills.length} skill(s)`);
    if (m.tools?.length) lines.push(`  Tools: ${m.tools.length} tool module(s)`);
    if (m.mcpServers && Object.keys(m.mcpServers).length) lines.push(`  MCP Servers: ${Object.keys(m.mcpServers).length}`);
  } else {
    lines.push('✅ Installed successfully.');
  }
  if (result.warnings.length) {
    lines.push('');
    lines.push('Warnings:');
    result.warnings.forEach(w => lines.push(`  ⚠ ${w}`));
  }
  return { output: lines.join('\n'), success: true };
}

async function handleRemove(name: string): Promise<PluginCommandResult> {
  if (!name) return { output: 'Usage: /plugins remove <name>', success: false };

  const result = await uninstallPlugin(name);
  if (!result.success) {
    return { output: `✗ ${result.error}`, success: false };
  }
  return { output: `✅ ${name} uninstalled.`, success: true };
}

async function handleEnable(name: string): Promise<PluginCommandResult> {
  if (!name) return { output: 'Usage: /plugins enable <name>', success: false };
  const result = await enablePlugin(name);
  if (!result.success) return { output: `✗ ${result.error}`, success: false };
  return { output: `✅ ${name} enabled. Restart session to apply.`, success: true };
}

async function handleDisable(name: string): Promise<PluginCommandResult> {
  if (!name) return { output: 'Usage: /plugins disable <name>', success: false };
  const result = await disablePlugin(name);
  if (!result.success) return { output: `✗ ${result.error}`, success: false };
  return { output: `✅ ${name} disabled.`, success: true };
}

async function handleInfo(name: string): Promise<PluginCommandResult> {
  if (!name) return { output: 'Usage: /plugins info <name>', success: false };

  const info = await getPluginInfo(name);
  if (!info) return { output: `Plugin "${name}" not found.`, success: false };

  const lines = [
    `${info.name} v${info.version}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Description: ${info.description}`,
    `Author: ${info.author}`,
    `Status: ${info.enabled ? '✓ Enabled' : '✗ Disabled'}`,
    `Source: ${info.source}`,
    `Installed: ${info.installedAt}`,
  ];

  if (info.components.skills.length) lines.push(`Skills: ${info.components.skills.join(', ')}`);
  if (info.components.tools.length) lines.push(`Tools: ${info.components.tools.join(', ')}`);
  if (info.components.mcpServers.length) lines.push(`MCP Servers: ${info.components.mcpServers.join(', ')}`);
  if (info.components.connectorTools.length) {
    lines.push(`Connector tools: ${info.components.connectorTools.join(', ')}`);
  }
  if (info.permissions.length) {
    lines.push(`Permissions:`);
    info.permissions.forEach(p => lines.push(`  - ${p}`));
  }

  return { output: lines.join('\n'), success: true };
}

async function handleDev(pluginPath: string): Promise<PluginCommandResult> {
  if (!pluginPath) return { output: 'Usage: /plugins dev <path>\n\nLoads plugin in dev mode (symlink, no copy)', success: false };

  const result = await devLoadPlugin(pluginPath);
  if (!result.success) {
    return { output: `✗ Dev load failed:\n${result.errors.join('\n')}`, success: false };
  }
  return { output: `✅ ${result.manifest!.name} loaded in dev mode from ${pluginPath}`, success: true };
}

async function handleCreate(rawArgs: string): Promise<PluginCommandResult> {
  if (!rawArgs) return { output: 'Usage: /plugins create <name> [--template=basic|tool|skill|ui-view] [--force]', success: false };

  // 支持 `/plugins create my-plugin --template=ui-view`
  const parts = rawArgs.split(/\s+/);
  const name = parts[0];
  let template: 'basic' | 'tool' | 'skill' | 'ui-view' = 'basic';
  let force = false;
  for (const p of parts.slice(1)) {
    if (p === '--force' || p === '-f') force = true;
    else if (p.startsWith('--template=')) {
      const t = p.slice('--template='.length);
      if (t === 'basic' || t === 'tool' || t === 'skill' || t === 'ui-view') template = t;
    }
  }

  const { scaffoldPlugin } = await import('../pluginScaffold.js');
  const result = await scaffoldPlugin({ name, template, force });
  if (!result.success) {
    return { output: `✗ ${result.error || 'Failed'}`, success: false };
  }
  const lines = [
    `✓ Created ${template} plugin at ${result.pluginDir}`,
    '',
    'Files:',
    ...result.created.map(f => `  ${f}`),
    '',
    'Next steps:',
    `  cd ${result.pluginDir}`,
    `  neox /plugins dev ${result.pluginDir}`,
  ];
  return { output: lines.join('\n'), success: true };
}

// ============================================================================
// Help
// ============================================================================

function helpText(): string {
  const install = helpContributions.flatMap((h) => h.install ?? []);
  const sections = helpContributions
    .filter((h) => h.section?.length)
    .map((h) => `${h.section!.join('\n')}\n\n`)
    .join('');
  return HELP_HEAD + install.map((l) => `${l}\n`).join('') + HELP_MIDDLE + sections + HELP_TAIL;
}

const HELP_HEAD = `Plugin Management Commands:

  /plugins list                              List installed plugins
  /plugins install <path>                    Install from local path
  /plugins install <url>                     Install from tarball or git URL
  /plugins install <file.neox-plugin>        Install a signed package (integrity checked)
`;

const HELP_MIDDLE = `  /plugins remove <name>                     Uninstall plugin
  /plugins enable <name>                     Enable plugin
  /plugins disable <name>                    Disable plugin
  /plugins info <name>                       Show plugin details
  /plugins dev <path>                        Load in dev mode (no copy)

`;

const HELP_TAIL = `  /plugins agents                            List external agents (Codex / Claude Code) + status
  /plugins connectors                        List platform connectors + status
  /plugins connect <name> <token>            Store an access token (encrypted, local only)
  /plugins disconnect <name>                 Clear credentials + grants
  /plugins pack <dir> [--out=] [--key=]      Build a .neox-plugin package

  /plugins create <name> [--template=...]    Create from template
                                             Templates: basic | tool | skill | ui-view
  /plugins help                              Show this help`;
