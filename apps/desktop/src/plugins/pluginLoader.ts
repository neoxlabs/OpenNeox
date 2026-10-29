/**
 * Plugin Loader — 加载已安装插件的组件 (skills/tools/hooks)
 *
 * 核心职责:
 * 1. 读取 plugin.json
 * 2. 加载 skills → 注入 SkillRegistry
 * 3. 加载 tools → 注册为 ToolPack + 注入 ToolPackRegistry
 * 4. 加载 hooks/mcp/agents/commands
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  PluginManifest,
  InstalledPlugin,
  PluginLoadResult,
  PluginViewDefinition,
  PluginAuthProviderDefinition,
  PluginConnectorDefinition,
  PluginExternalAgentDefinition,
} from '@neoxlabs/platform/shared/plugin-types.js';
import { validateManifest } from './pluginSecurity.js';
import {
  declaredPlatforms,
  isPlatformSupported,
  platformLabel,
  platformsLabel,
} from '@neoxlabs/platform/shared/plugin-platform.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ============================================================================
// Manifest Loading
// ============================================================================

/**
 * 从插件目录读取 plugin.json
 */
export async function loadManifest(pluginDir: string): Promise<PluginManifest | null> {
  const manifestPath = path.join(pluginDir, 'plugin.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as PluginManifest;
    return manifest;
  } catch (err: any) {
    cliLogger.error('PLUGIN', `Failed to load manifest from ${pluginDir}: ${err.message}`);
    return null;
  }
}

// ============================================================================
// Plugin Component Loading
// ============================================================================

/**
 * 加载单个插件的所有组件
 */
export async function loadPlugin(
  plugin: InstalledPlugin,
  injectors: PluginInjectors,
): Promise<PluginLoadResult> {
  const result: PluginLoadResult = {
    name: plugin.name,
    success: false,
    loaded: { skills: 0, tools: 0, hooks: 0, mcpServers: 0, agents: 0, commands: 0, views: 0, authProviders: 0, connectorTools: 0, externalAgents: 0 },
    errors: [],
  };

  const pluginDir = plugin.installPath;

  // 1. 加载清单
  const manifest = await loadManifest(pluginDir);
  if (!manifest) {
    result.errors.push('Failed to load plugin.json');
    return result;
  }

  // 2. 校验清单
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    result.errors.push(...validation.errors);
    return result;
  }

  // 3. 加载 Skills
  if (manifest.skills) {
    for (const skillPath of manifest.skills) {
      try {
        const absPath = path.resolve(pluginDir, skillPath);
        const count = await injectors.loadSkills(absPath, plugin.name);
        result.loaded.skills += count;
      } catch (err: any) {
        result.errors.push(`Skills load error (${skillPath}): ${err.message}`);
      }
    }
  }

  // 4. 加载 Tools
  if (manifest.tools) {
    for (const toolPath of manifest.tools) {
      try {
        const absPath = path.resolve(pluginDir, toolPath);
        const count = await injectors.loadTools(absPath, plugin.name, manifest);
        result.loaded.tools += count;
      } catch (err: any) {
        result.errors.push(`Tools load error (${toolPath}): ${err.message}`);
      }
    }
  }

  // 5. 加载 MCP Servers
  if (manifest.mcpServers) {
    for (const [serverId, config] of Object.entries(manifest.mcpServers)) {
      try {
        await injectors.loadMcpServer(serverId, config, plugin.name);
        result.loaded.mcpServers++;
      } catch (err: any) {
        result.errors.push(`MCP server error (${serverId}): ${err.message}`);
      }
    }
  }

  // 6. 加载 Hooks
  if (manifest.hooks) {
    try {
      const hookPath = typeof manifest.hooks === 'string'
        ? path.resolve(pluginDir, manifest.hooks)
        : null;
      const hookConfig = typeof manifest.hooks === 'object' ? manifest.hooks : undefined;
      const count = await injectors.loadHooks(hookPath, hookConfig, plugin.name);
      result.loaded.hooks += count;
    } catch (err: any) {
      result.errors.push(`Hooks load error: ${err.message}`);
    }
  }

  // 7. 加载 Agents
  if (manifest.agents) {
    for (const agentPath of manifest.agents) {
      try {
        const absPath = path.resolve(pluginDir, agentPath);
        const count = await injectors.loadAgents(absPath, plugin.name);
        result.loaded.agents += count;
      } catch (err: any) {
        result.errors.push(`Agents load error (${agentPath}): ${err.message}`);
      }
    }
  }

  // 8. 加载 Commands
  if (manifest.commands) {
    for (const cmdPath of manifest.commands) {
      try {
        const absPath = path.resolve(pluginDir, cmdPath);
        const count = await injectors.loadCommands(absPath, plugin.name);
        result.loaded.commands += count;
      } catch (err: any) {
        result.errors.push(`Commands load error (${cmdPath}): ${err.message}`);
      }
    }
  }

  // 9. 加载 Views (UI 面板)
  if (Array.isArray(manifest.views) && manifest.views.length > 0 && injectors.loadViews) {
    try {
      const count = await injectors.loadViews(manifest.views, plugin.name, pluginDir);
      result.loaded.views = count;
    } catch (err: any) {
      result.errors.push(`Views load error: ${err.message}`);
    }
  }

  // 10. 加载 AuthProvider (kind: auth / authProvider 字段)
  if (manifest.authProvider && injectors.loadAuthProvider) {
    try {
      const count = await injectors.loadAuthProvider(manifest.authProvider, plugin.name, pluginDir);
      result.loaded.authProviders = count;
    } catch (err: any) {
      result.errors.push(`Auth provider load error: ${err.message}`);
    }
  }

  // 11. 加载 Connector (声明式第三方平台接入 → Agent 工具)
  if (manifest.connector && injectors.loadConnector) {
    try {
      const count = await injectors.loadConnector(manifest.connector, plugin.name);
      result.loaded.connectorTools = count;
    } catch (err: any) {
      result.errors.push(`Connector load error: ${err.message}`);
    }
  }

  // 12. 加载 External Agents (委派给本机其它 agent CLI)
  if (Array.isArray(manifest.externalAgents) && manifest.externalAgents.length > 0 && injectors.loadExternalAgents) {
    try {
      const count = await injectors.loadExternalAgents(manifest.externalAgents, plugin.name);
      result.loaded.externalAgents = count;
    } catch (err: any) {
      result.errors.push(`External agent load error: ${err.message}`);
    }
  }

  result.success = result.errors.length === 0;

  const total = Object.values(result.loaded).reduce((a, b) => a + b, 0);
  cliLogger.info('PLUGIN', `Loaded ${plugin.name}@${plugin.version}: ${total} components (${result.errors.length} errors)`);

  return result;
}

/**
 * 加载所有已启用的插件
 */
export async function loadAllPlugins(
  plugins: InstalledPlugin[],
  injectors: PluginInjectors,
): Promise<PluginLoadResult[]> {
  const results: PluginLoadResult[] = [];
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    /* 平台不匹配的插件不进运行时。
     *
     * 为什么连加载也要判 (安装闸已经拦了新的): 这道闸是为**已经装上的**那批 ——
     * 声明了 darwin 的 computer-use 躺在 Windows 用户的注册表里时, 它贡献的 skill
     * 会照常注册 (SKILL.md 写着「操作 macOS 上的原生应用」), 而工具永远到不了模型
     * 手里。于是模型以为自己有这个能力, 一调就是「工具不存在」。
     * 不卸载、不改启用状态 (那是用户的决定), 只是不让它进运行时。 */
    const platforms = declaredPlatforms(plugin.manifest);
    if (!isPlatformSupported(platforms, process.platform)) {
      cliLogger.warn(
        'PLUGIN',
        `跳过 ${plugin.name}: 声明只支持 ${platformsLabel(platforms, false)}, 当前是 ${platformLabel(process.platform, false)}`,
      );
      continue;
    }
    const result = await loadPlugin(plugin, injectors);
    results.push(result);
  }
  return results;
}

// ============================================================================
// Injector Interface
// ============================================================================

/**
 * 插件组件注入器 — 由调用方提供具体实现
 *
 * 解耦 pluginLoader 和 SkillRegistry/ToolPackRegistry 等具体系统
 */
export interface PluginInjectors {
  /** 从目录加载 skills，返回加载数量 */
  loadSkills: (dirOrFile: string, pluginName: string) => Promise<number>;
  /** 从 TS/JS 模块加载 tools，返回加载数量 */
  loadTools: (modulePath: string, pluginName: string, manifest: PluginManifest) => Promise<number>;
  /** 注册 MCP server */
  loadMcpServer: (serverId: string, config: any, pluginName: string) => Promise<void>;
  /** 加载 hooks */
  loadHooks: (configPath: string | null, inlineConfig: any | undefined, pluginName: string) => Promise<number>;
  /** 加载 agents */
  loadAgents: (dirOrFile: string, pluginName: string) => Promise<number>;
  /** 加载 slash commands */
  loadCommands: (dirOrFile: string, pluginName: string) => Promise<number>;
  /** 加载 UI views (可选 — 仅 Electron 下有实现) */
  loadViews?: (views: PluginViewDefinition[], pluginName: string, installDir: string) => Promise<number>;
  /** 注册声明式 connector, 返回贡献给 Agent 的工具数 (可选) */
  loadConnector?: (
    connector: PluginConnectorDefinition,
    pluginName: string,
  ) => Promise<number>;
  /** 注册外部 Agent 委派, 返回贡献给 Agent 的工具数 (可选) */
  loadExternalAgents?: (
    agents: PluginExternalAgentDefinition[],
    pluginName: string,
  ) => Promise<number>;
  /** 加载 AuthProvider (可选 — Electron / CLI) */
  loadAuthProvider?: (
    def: PluginAuthProviderDefinition,
    pluginName: string,
    installDir: string,
  ) => Promise<number>;
}
