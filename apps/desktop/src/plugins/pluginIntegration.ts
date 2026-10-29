/**
 * Plugin Integration — 将插件组件注入到 Neox 运行时系统
 *
 * 桥接 pluginLoader 的 PluginInjectors 接口到:
 * - SkillRegistry (skills)
 * - ToolPackRegistry (tools)
 * - MCP Manager (mcp servers)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { PluginInjectors } from './pluginLoader.js';
import type { PluginHookConfig, PluginManifest, InstalledPlugin } from '@neoxlabs/platform/shared/plugin-types.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { toolPackRegistry } from '@neoxlabs/core/tools/packs/toolPack.js';
import { pluginHookRegistry } from './pluginHookRegistry.js';
import { agentTypeRegistry } from '@neoxlabs/core/runtime/agent/agentTypeRegistry.js';
import { pluginCommandRegistry } from './pluginCommandRegistry.js';
import { pluginViewRegistry } from './pluginViewRegistry.js';
import { pluginAuthRegistry, type AuthProviderLike } from './pluginAuthRegistry.js';
import { createPluginContext, type PluginContext } from './pluginContext.js';
import { connectorRegistry } from './connector/connectorRegistry.js';
import { externalAgentRegistry } from './externalAgent/externalAgentRegistry.js';
import { createPluginStoreSearchTool } from './storeSearchTool.js';

const PLUGIN_STORE_PACK_ID = 'plugin-store';
import { localized } from '@neoxlabs/platform/shared/plugin-connector.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { pathToFileURL } from 'node:url';
import type { PluginAuthProviderDefinition } from '@neoxlabs/platform/shared/plugin-types.js';

/**
 * 创建插件组件注入器
 *
 * 将插件的 skills/tools/hooks/mcp/agents/commands 注入到运行时系统
 */
export function createPluginInjectors(options?: {
  skillRegistry?: any;
  workspacePath?: string;
  /** 查 installed plugin (用于构 PluginContext). 不提供则 tool 不拿 context. */
  getInstalled?: (name: string) => InstalledPlugin | undefined;
  /**
   * Agent runtime 线程用: 只注入模型能调到的东西, 不登记 views/auth、不写 MCP 配置。
   * 主进程管 UI, worker 管工具表, 两边抢同一份 mcp-servers.json 会互相覆盖。
   */
  runtimeOnly?: boolean;
}): PluginInjectors {
  const contextCache = new Map<string, PluginContext>();

  const getContext = (manifest: PluginManifest, installDir?: string): PluginContext | undefined => {
    const existing = contextCache.get(manifest.name);
    if (existing) return existing;
    const installed = options?.getInstalled?.(manifest.name);
    const dir = installDir ?? installed?.installPath;
    if (!dir) return undefined;
    const ctx = createPluginContext({
      manifest,
      installDir: dir,
      workspacePath: options?.workspacePath,
      userConfig: installed?.userConfig,
    });
    contextCache.set(manifest.name, ctx);
    return ctx;
  };

  const injectors: PluginInjectors = {
    // ========================================================================
    // Skills — 加载 SKILL.md 文件到 SkillRegistry
    // ========================================================================
    async loadSkills(dirOrFile: string, pluginName: string): Promise<number> {
      let count = 0;
      const stat = await fs.stat(dirOrFile);

      if (stat.isDirectory()) {
        // 扫描目录中的 SKILL.md
        const entries = await fs.readdir(dirOrFile, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillMd = path.join(dirOrFile, entry.name, 'SKILL.md');
            try {
              await fs.access(skillMd);
              // 如果有 skillRegistry，注入到全局注册表
              if (options?.skillRegistry) {
                await options.skillRegistry.loadSkillFromPath(skillMd, 'plugin');
              }
              count++;
            } catch { /* no SKILL.md in this subdir */ }
          }
        }
      } else if (stat.isFile() && dirOrFile.endsWith('.md')) {
        if (options?.skillRegistry) {
          await options.skillRegistry.loadSkillFromPath(dirOrFile, 'plugin');
        }
        count++;
      }

      cliLogger.info('PLUGIN', `[${pluginName}] Loaded ${count} skills from ${dirOrFile}`);
      return count;
    },

    // ========================================================================
    // Tools — 动态加载 TS/JS 模块，注册为 ToolPack
    // ========================================================================
    async loadTools(modulePath: string, pluginName: string, manifest: PluginManifest): Promise<number> {
      try {
        // 动态导入工具模块
        const module = await import(modulePath);

        // 构 PluginContext 并传给 createTools (用户工具可访问 dataDir/io/logger/config)
        const ctx = getContext(manifest, path.dirname(modulePath));

        // 支持多种导出格式
        let tools: Tool[] = [];
        if (typeof module.createTools === 'function') {
          tools = await module.createTools(ctx);
        } else if (typeof module.default === 'function') {
          tools = await module.default(ctx);
        } else if (Array.isArray(module.default)) {
          tools = module.default;
        } else if (Array.isArray(module.tools)) {
          tools = module.tools;
        }

        if (tools.length === 0) {
          cliLogger.warn('PLUGIN', `[${pluginName}] No tools exported from ${modulePath}`);
          return 0;
        }

        // 注册为 ToolPack
        toolPackRegistry.register({
          id: `plugin:${pluginName}`,
          label: manifest.description || pluginName,
          icon: '◌',
          description: `Plugin: ${manifest.description || pluginName}`,
          group: 'community',
          tier: 'extended',
          keywords: manifest.keywords ?? [],
          toolNames: tools.map(t => t.name),
          createTools: () => tools,
        });

        cliLogger.info('PLUGIN', `[${pluginName}] Registered ${tools.length} tools as pack "plugin:${pluginName}"`);
        return tools.length;
      } catch (err: any) {
        cliLogger.error('PLUGIN', `[${pluginName}] Tool module load failed: ${err.message}`);
        throw err;
      }
    },

    // ========================================================================
    // MCP Servers — 注册到 MCP Manager
    // ========================================================================
    async loadMcpServer(serverId: string, config: any, pluginName: string): Promise<void> {
      // MCP 配置写入全局 config，MCP Manager 会在下次启动时读取
      const configPath = path.join(process.env.HOME || '~', '.neox', 'mcp-servers.json');
      let mcpConfig: Record<string, any> = {};
      try {
        const raw = await fs.readFile(configPath, 'utf-8');
        mcpConfig = JSON.parse(raw);
      } catch { /* new file */ }

      mcpConfig[`plugin:${pluginName}:${serverId}`] = {
        ...config,
        _source: `plugin:${pluginName}`,
      };

      await fs.writeFile(configPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');
      cliLogger.info('PLUGIN', `[${pluginName}] MCP server "${serverId}" registered`);
    },

    // ========================================================================
    // Hooks — 加载 hook 配置
    // ========================================================================
    async loadHooks(configPath: string | null, inlineConfig: any, pluginName: string): Promise<number> {
      let hookConfig: PluginHookConfig | undefined = inlineConfig;
      if (configPath) {
        try {
          const raw = await fs.readFile(configPath, 'utf-8');
          hookConfig = JSON.parse(raw) as PluginHookConfig;
        } catch (err: any) {
          cliLogger.error('PLUGIN', `[${pluginName}] Hook config load failed: ${err.message}`);
          return 0;
        }
      }
      if (!hookConfig) return 0;

      const count = pluginHookRegistry.registerPluginHooks(pluginName, hookConfig);
      cliLogger.info('PLUGIN', `[${pluginName}] ${count} hooks registered`);
      return count;
    },

    // ========================================================================
    // Agents — 加载 .md agent 定义
    // ========================================================================
    async loadAgents(dirOrFile: string, pluginName: string): Promise<number> {
      const count = await agentTypeRegistry.loadFromDirectory(dirOrFile, 'plugin', pluginName);
      cliLogger.info('PLUGIN', `[${pluginName}] ${count} agent definitions registered`);
      return count;
    },

    // ========================================================================
    // Commands — 加载 slash command 定义
    // ========================================================================
    async loadCommands(dirOrFile: string, pluginName: string): Promise<number> {
      const count = await pluginCommandRegistry.loadFromPath(dirOrFile, pluginName);
      cliLogger.info('PLUGIN', `[${pluginName}] ${count} commands registered`);
      return count;
    },

    // ========================================================================
    // Views — 插件 UI 面板 (PPT 编辑器 / 视频预览 等领域面板)
    // ========================================================================
    async loadViews(views, pluginName, installDir) {
      const count = pluginViewRegistry.registerPluginViews({
        pluginName,
        installDir,
        views,
      });
      cliLogger.info('PLUGIN', `[${pluginName}] ${count} views registered`);
      return count;
    },

    // ========================================================================
    // Connector — 声明式第三方平台接入, materialize 成 Agent 工具
    //
    // 单独成一个 pack (`connector:<name>`) 而不是混进 `plugin:<name>`:
    // 两者的失效路径不同 —— connector 工具在凭据失效时会集体失灵, 用户要能
    // 一眼看出「Notion 那一组都不能用了」而不是在一堆插件工具里找。
    // ========================================================================
    async loadConnector(connector, pluginName) {
      const tools = connectorRegistry.register(pluginName, connector);
      if (tools.length === 0) {
        cliLogger.warn('PLUGIN', `[${pluginName}] connector registered 0 tools`);
        return 0;
      }

      const label = localized(connector.displayName) || pluginName;
      const packId = `connector:${pluginName}`;
      toolPackRegistry.register({
        id: packId,
        label,
        icon: '🔌',
        description: `${label} 连接器: ${tools.map(t => t.name).join(', ')}`,
        group: 'community',
        tier: 'extended',
        keywords: [connector.namespace, pluginName, 'connector'],
        /* 已装连接器两个模式都能用 —— 市场热门按 PLUGIN_AUDIENCE 藏卡, 工具表不跟。
         * 不写 modes 也等于全开; 写明白避免以后有人给 community 包默认 modes:['code']。 */
        modes: ['work', 'code'],
        toolNames: tools.map(t => t.name),
        createTools: () => tools,
      });
      /* register 是 void, 校验不过只 console.warn 一句就把 pack 丢了 ——
       * 结果是「插件装好了但一个工具都没有」, 而用户那边没有任何解释。
       * 这里显式确认它真的落上了, 落不上就当加载失败上报。 */
      if (!toolPackRegistry.get(packId)) {
        connectorRegistry.unregister(pluginName);
        throw new Error(`tool pack "${packId}" was rejected by the registry (see console for the reason)`);
      }

      cliLogger.info('PLUGIN', `[${pluginName}] connector "${connector.namespace}" → ${tools.length} agent tools`);
      return tools.length;
    },

    // ========================================================================
    // External Agents — 委派给本机其它 agent CLI (Codex / Claude Code / …)
    //
    // 单独成 pack `extagent:<name>`: 这类工具的失效原因跟别的都不一样
    // (对面 CLI 没装 / 被卸载), 混在一起用户排查不了。
    // ========================================================================
    async loadExternalAgents(agents, pluginName) {
      const tools = externalAgentRegistry.register(pluginName, agents);
      if (tools.length === 0) return 0;

      const packId = `extagent:${pluginName}`;
      toolPackRegistry.register({
        id: packId,
        label: `${pluginName} 外部 Agent`,
        icon: '🤝',
        description: `委派给外部 Agent: ${agents.map(a => localized(a.displayName)).join(', ')}`,
        group: 'agent',
        tier: 'extended',
        keywords: [
          ...agents.flatMap(a => [a.id, a.command, localized(a.displayName)].map(k => k.toLowerCase())),
          'delegate', 'external', 'agent',
        ],
        toolNames: tools.map(t => t.name),
        createTools: () => tools,
      });
      /* 同上: 静默丢 pack = 工具凭空消失, 必须变成一条用户看得见的加载错误 */
      if (!toolPackRegistry.get(packId)) {
        externalAgentRegistry.unregister(pluginName);
        throw new Error(`tool pack "${packId}" was rejected by the registry (see console for the reason)`);
      }

      cliLogger.info('PLUGIN', `[${pluginName}] ${tools.length} external agent(s): ${tools.map(t => t.name).join(', ')}`);
      return tools.length;
    },

    // ========================================================================
    // AuthProvider — 官方订阅 OAuth (Claude / Codex / Grok)
    // ========================================================================
    async loadAuthProvider(def: PluginAuthProviderDefinition, pluginName, installDir) {
      if (!def?.id || !def.entry || !def.export) {
        throw new Error('authProvider requires id, entry, export');
      }
      const absEntry = path.resolve(installDir, def.entry);
      const href = `${pathToFileURL(absEntry).href}?t=${Date.now()}`;
      const mod = await import(href);
      const factory = mod?.[def.export];
      if (typeof factory !== 'function') {
        throw new Error(`authProvider export "${def.export}" is not a function in ${def.entry}`);
      }
      const instance = factory() as AuthProviderLike;
      if (!instance || typeof instance.login !== 'function' || typeof instance.status !== 'function') {
        throw new Error(`authProvider factory "${def.export}" did not return a valid AuthProvider`);
      }
      pluginAuthRegistry.register({
        pluginName,
        providerId: def.id || instance.id,
        displayName: def.displayName || instance.displayName || def.id,
        authKind: instance.authKind || 'oauth_pkce',
        installDir,
        entry: def.entry,
        exportName: def.export,
        instance,
      });
      return 1;
    },
  };

  if (options?.runtimeOnly) {
    delete injectors.loadViews;
    delete injectors.loadAuthProvider;
    injectors.loadMcpServer = async () => {
      /* worker 不写 mcp-servers.json, 避免和主进程抢同一份文件 */
    };
  }

  return injectors;
}

/**
 * 给 External Agent 子系统装上宿主钩子。
 *
 *   registry 本身不 import core —— 桌面端、CLI、将来的 server 拿到的
 *   workspace / 流式通道 / worktree 实现不一定是同一套。这里是桌面/CLI 这条
 *   进程内的接线点。
 *
 *   流式回调是**每次调用时现取**而不是启动时取一次: shell 的 UI 回调是在
 *   窗口就绪后才注册的, 启动时取到的会永远是 null, 结果就是外部 agent 跑了
 *   二十分钟 timeline 上一个字都没有。
 */
const xmlEsc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 外部 agent 后台结束 → 主 agent 收件箱里的那段 (跟内置子 agent 的 <agent-completion> 同形, 界面同一张卡) */
export function externalAgentCompletionXml(info: {
  agentId: string; displayName: string; ok: boolean; prompt: string; elapsedMs: number; toolUseCount: number; summary: string;
}): string {
  const retry = info.ok ? ''
    : '\n<retry-advice>先看 summary 里的原因再决定: 额度 / 登录 / 鉴权问题原样重派还会失败, 直接告诉用户怎么处理。</retry-advice>';
  return `<agent-completion>
<agent-id>${xmlEsc(`extagent:${info.agentId}`)}</agent-id>
<name>${xmlEsc(info.displayName)}</name>
<status>${info.ok ? 'completed' : 'failed'}</status>
<elapsed-seconds>${Math.round(info.elapsedMs / 1000)}</elapsed-seconds>
<tool-use-count>${info.toolUseCount}</tool-use-count>
<description>${xmlEsc(info.prompt.slice(0, 300))}</description>${retry}
<summary>${xmlEsc(info.summary.slice(0, 4000))}</summary>
</agent-completion>`;
}

export async function installExternalAgentHostHooks(): Promise<void> {
  const { externalAgentRegistry } = await import('./externalAgent/externalAgentRegistry.js');
  const { getWorkspaceRoot } = await import('@neoxlabs/core/tools/workspace/pathHelpers.js');
  const { getShellOutputStreamCallback } = await import('@neoxlabs/core/tools/shell/shellUiCallbacks.js');
  const { createWorktree, cleanupWorktree } = await import('@neoxlabs/core/runtime/agent/worktreeIsolation.js');

  const { getBackgroundTaskNotifier, currentChatSessionIdForNotify } = await import('@neoxlabs/core/runtime/shell/backgroundTaskNotifier.js');
  const { processManager } = await import('@neoxlabs/platform/platform/processManager.js');
  const { setExternalAgentLaunchHooks } = await import('./externalAgent/launchEnv.js');
  const { getShellEnv } = await import('@neoxlabs/platform/platform/shellEnv.js');
  const { ProviderResolver } = await import('@neoxlabs/core/server/services/providerResolver.js');
  const { loadConfig } = await import('@neoxlabs/platform/utils/config.js');

  /* 外部 CLI 的环境 = 用户登录 shell 的完整环境 (从 Finder 启动时 process.env 只修了 PATH,
   * .zshrc 里 export 的 key 全丢) + 用户没设的厂商 key 从 Neox 里同厂商的服务商取。 */
  setExternalAgentLaunchHooks({
    getEnv: () => { try { return getShellEnv(); } catch { return process.env; } },
    resolveCredential: (hosts) => {
      try {
        /* getAllProviders = 实时 + 解密; loadConfig().providers 的 apiKey 是 enc:v1 密文 */
        for (const p of new ProviderResolver(loadConfig() as never).getAllProviders() as Array<{ baseUrl?: string; apiKey?: string }>) {
          let host = '';
          try { host = new URL(String(p.baseUrl ?? '')).hostname; } catch { continue; }
          if (!hosts.includes(host) || !p.apiKey || String(p.apiKey).startsWith('enc:')) continue;
          return { apiKey: String(p.apiKey), baseUrl: String(p.baseUrl) };
        }
      } catch { /* 读不到配置就不注入, CLI 会报它自己的缺 key */ }
      return null;
    },
  });

  externalAgentRegistry.setHostHooks({
    getWorkspaceRoot,
    onProgress: payload => {
      getShellOutputStreamCallback()?.(payload);
    },
    getSessionId: () => currentChatSessionIdForNotify(),
    onBackgroundFinished: info => {
      if (!info.sessionId) return;
      getBackgroundTaskNotifier().enqueueMessageForSession(info.sessionId, externalAgentCompletionXml(info), {
        kind: 'external-agent',
        command: `extagent:${info.agentId}`,
        status: info.ok ? 'completed' : 'failed',
        osNotice: {
          title: info.ok ? `✓ ${info.displayName} 完成` : `✗ ${info.displayName} 失败`,
          body: info.prompt,
        },
      });
    },
    /* 服务面板 / pid / 停止 / 日志 全部复用宿主那套 —— 外部 agent 不该是面板里
     * 看不见的孤儿进程 (用 execute_shell 跑 codex 本来就登记, 插件反而没有的话,
     * 「用插件」就成了体验倒退)。 */
    processTracker: {
      /* kind 必须显式给 —— 默认的 'background-task' 会因为「跑了超过 15 秒」被服务
       * 面板判成长期服务, 跑完还挂在服务列表里显示「运行中」 */
      register: info => { processManager.register({ ...info, background: true, kind: 'agent-task' }); },
      appendOutput: (pid, text) => { processManager.appendOutput(pid, text); },
      markCompleted: (pid, code) => { processManager.markCompleted(pid, code ?? -1); },
    },
    worktree: {
      create: (workDir, agentId) => createWorktree(workDir, agentId),
      cleanup: (info, workDir) => cleanupWorktree(info, workDir),
    },
  });
}

/**
 * 启动时加载所有已启用的插件
 */
/**
 * 读已启用插件的 manifest, 把它们声明的 capabilities 打开。
 *
 * 为什么从磁盘重读 manifest 而不是信 registry 里的记录: registry 存的是安装那一刻的
 * 元数据, 插件升级换了 capabilities 它是不知道的。能力是"放不放一整块权限出来"这种
 * 级别的开关, 宁可多读一次盘。
 */
async function applyPluginCapabilities(
  enabled: Array<{ name: string; installPath: string }>,
  options?: { promptComputerUse?: boolean },
): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const { enableHostCapability } = await import('@neoxlabs/kernel');
  let hasComputerUse = false;
  // eslint-disable-next-line no-console
  console.log(`[PLUGIN] applyPluginCapabilities: ${enabled.length} 个已启用插件 (${enabled.map((p) => p.name).join(', ')})`);
  for (const plugin of enabled) {
    try {
      const raw = await fs.readFile(path.join(plugin.installPath, 'plugin.json'), 'utf-8');
      const caps = (JSON.parse(raw) as { capabilities?: unknown }).capabilities;
      if (!Array.isArray(caps)) continue;
      for (const cap of caps) {
        if (typeof cap !== 'string') continue;
        if (cap === 'computer-use') hasComputerUse = true;
        enableHostCapability(cap);
        /* 用 console 而不是 cliLogger: 主进程里 cliLogger 默认不落盘, 出问题时等于没有留痕。
         * 能力开关是"整块功能在不在"级别的事, 值得在启动日志里占一行。 */
        // eslint-disable-next-line no-console
        console.log(`[PLUGIN] capability "${cap}" enabled by ${plugin.name}`);
      }
    } catch (err: any) {
      cliLogger.warn('PLUGIN', `读 ${plugin.name} 的 capabilities 失败: ${err?.message ?? err}`);
    }
  }

  /* 装了 computer-use 却实际用不了 → 启动自检.
   * macOS: TCC 必须由主进程请求, 条目才会记成 Neox.
   * Windows: 只记日志, 不弹升权窗 — 普通应用直接能控. */
  if (hasComputerUse && options?.promptComputerUse !== false) {
    void (async () => {
      try {
        const { ensureComputerUseAccessOnBoot } = await import('./computerUseAccess.js');
        await ensureComputerUseAccessOnBoot(true);
      } catch (err: any) {
        cliLogger.warn('PLUGIN', `computer use 授权自检失败: ${err?.message ?? err}`);
      }
    })();
  }
}

let lastRuntimeRegistryMtime = Number.NaN;
let lastRuntimePluginNames = new Set<string>();
let runtimeBootstrapDone = false;

async function readRegistryMtime(): Promise<number> {
  try {
    const { PluginRegistry } = await import('./pluginRegistry.js');
    const st = await fs.stat(PluginRegistry.registryFile);
    return st.mtimeMs;
  } catch {
    return 0;
  }
}

function registerPluginStorePack(listInstalled: () => InstalledPlugin[]): void {
  if (toolPackRegistry.get(PLUGIN_STORE_PACK_ID)) return;
  const tool = createPluginStoreSearchTool({
    listInstalled,
    storeBase: () => process.env.NEOX_PLUGIN_STORE_API || undefined,
  });
  toolPackRegistry.register({
    id: PLUGIN_STORE_PACK_ID,
    label: '插件商店',
    icon: '🧩',
    description: 'Search installed plugins and the Neox plugin store — can Neox connect to a service (Jira, Slack, Figma, Google Drive…) or do a job via a plugin? Returns install links.',
    useFor: 'The user wants to use or connect a service/app that no current tool covers (Jira, Slack, Figma, Google Drive, a database, a SaaS), or asks which plugins, integrations or extensions are available.',
    group: 'platform',
    tier: 'primary',
    keywords: ['plugin', 'plugins', 'store', 'marketplace', 'install', 'integration', 'connector', 'extension',
      '插件', '商店', '市场', '安装', '集成', '连接', '接入', 'jira', 'slack', 'figma', 'confluence', 'drive'],
    modes: ['work', 'code'],
    toolNames: [tool.name],
    createTools: () => [tool],
  });
}

export async function bootstrapPlugins(options?: {
  skillRegistry?: any;
  workspacePath?: string;
  runtimeOnly?: boolean;
}): Promise<void> {
  const { pluginRegistry } = await import('./pluginRegistry.js');
  const { loadAllPlugins } = await import('./pluginLoader.js');
  const runtimeOnly = options?.runtimeOnly === true;
  const registryMtime = runtimeOnly ? await readRegistryMtime() : Number.NaN;

  if (runtimeOnly && runtimeBootstrapDone && registryMtime === lastRuntimeRegistryMtime) {
    return;
  }

  if (runtimeOnly) {
    await pluginRegistry.reload();
    if (runtimeBootstrapDone) {
      const enabledNow = new Set(pluginRegistry.getEnabled().map(p => p.name));
      for (const name of lastRuntimePluginNames) {
        if (!enabledNow.has(name)) disablePluginRuntime(name, options);
      }
      /* 插件 skill 由 SkillRegistry.loadPlugins 从登记表读 —— 登记表变了 (装 / 卸 / 启停) 就刷新一次,
       * 否则新装插件的 skill 要等重启 Agent 运行时才出现 */
      try {
        const { skillRegistry } = await import('@neoxlabs/core/skills/index.js');
        await skillRegistry.refresh();
      } catch (err: any) {
        cliLogger.warn('PLUGIN', `Skill refresh after plugin change failed: ${err?.message ?? err}`);
      }
    }
  } else {
    await pluginRegistry.load();
  }
  const enabled = pluginRegistry.getEnabled();

  /* 查插件商店的工具跟「装了哪些插件」无关, 一个没装也要有 —— 放在下面的提前 return 之前 */
  registerPluginStorePack(() => pluginRegistry.getAll());

  try {
    await installExternalAgentHostHooks();
  } catch (err: any) {
    cliLogger.warn('PLUGIN', `External agent host hooks unavailable: ${err?.message ?? err}`);
  }

  if (enabled.length === 0) {
    cliLogger.info('PLUGIN', 'No plugins to load');
    if (runtimeOnly) {
      lastRuntimeRegistryMtime = registryMtime;
      lastRuntimePluginNames = new Set();
      runtimeBootstrapDone = true;
    }
    return;
  }

  /* 能力闸: manifest 里的 capabilities 决定宿主放不放某一整块能力出来。
   *
   * 目前唯一的消费者是 computer-use —— OS 级操作的工具默认**根本不进 toolMap**
   * (见 runtimeTools.applyComputerUseGate), 装了带 `capabilities: ["computer-use"]`
   * 的插件才点亮。用户拍的板: 「Computer use 是以插件的形式存在的, 默认不带」。
   *
   * 必须在 loadAllPlugins **之前**开: 加载过程中就可能有工具被调用, 晚一步就是
   * "装了插件但这一轮还看不见"。 */
  await applyPluginCapabilities(enabled, { promptComputerUse: !runtimeOnly });

  const injectors = createPluginInjectors({
    ...options,
    getInstalled: (name) => pluginRegistry.get(name),
  });
  const results = await loadAllPlugins(enabled, injectors);

  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const totalComponents = results.reduce((sum, r) =>
    sum + Object.values(r.loaded).reduce((a, b) => a + b, 0), 0);

  cliLogger.info('PLUGIN', `Bootstrap complete: ${succeeded} plugins loaded (${totalComponents} components), ${failed} failed`);

  if (runtimeOnly) {
    lastRuntimeRegistryMtime = registryMtime;
    lastRuntimePluginNames = new Set(enabled.map(p => p.name));
    runtimeBootstrapDone = true;
  }
}

/**
 * 从运行时移除一个插件注册的所有组件 (disable / uninstall 时调用).
 *
 * 注意: skill 反注册依赖 skillRegistry.unregisterBySource('plugin', pluginName),
 * 若未提供则仅清 hook/tool/agent/command.
 */
export function disablePluginRuntime(pluginName: string, options?: {
  skillRegistry?: any;
}): { hooks: number; tools: number; agents: number; commands: number; skills: number; views: number; authProviders: number; connectorTools: number; externalAgents: number } {
  const hooks = pluginHookRegistry.unregisterPlugin(pluginName);
  const tools = toolPackRegistry.unregisterByPrefix(`plugin:${pluginName}`);
  /* connector 是独立 pack, prefix 不同 — 漏了它插件禁用后工具还挂在表上, 
   * 模型照样会调, 然后卡在「connector 已被卸载」的错误里 */
  const connectorTools = connectorRegistry.unregister(pluginName);
  toolPackRegistry.unregisterByPrefix(`connector:${pluginName}`);
  const externalAgents = externalAgentRegistry.unregister(pluginName);
  toolPackRegistry.unregisterByPrefix(`extagent:${pluginName}`);
  const agents = agentTypeRegistry.unregisterPlugin(pluginName);
  const commands = pluginCommandRegistry.unregisterPlugin(pluginName);
  const views = pluginViewRegistry.unregisterPlugin(pluginName);
  const authProviders = pluginAuthRegistry.unregisterPlugin(pluginName);
  let skills = 0;
  if (typeof options?.skillRegistry?.unregisterBySource === 'function') {
    skills = options.skillRegistry.unregisterBySource('plugin', pluginName);
  }
  cliLogger.info(
    'PLUGIN',
    `[${pluginName}] disabled: -${hooks} hooks, -${tools} tools, -${agents} agents, -${commands} cmds, -${skills} skills, -${views} views, -${authProviders} auth, -${connectorTools} connector tools, -${externalAgents} external agents`,
  );
  return { hooks, tools, agents, commands, skills, views, authProviders, connectorTools, externalAgents };
}

/**
 * 安装 / 启用后立刻把单个插件注入运行时 (不等重启).
 */
export async function activatePluginRuntime(plugin: InstalledPlugin, options?: {
  skillRegistry?: any;
  workspacePath?: string;
}): Promise<import('@neoxlabs/platform/shared/plugin-types.js').PluginLoadResult> {
  const { pluginRegistry } = await import('./pluginRegistry.js');
  const { loadPlugin } = await import('./pluginLoader.js');
  await pluginRegistry.load();
  const injectors = createPluginInjectors({
    ...options,
    getInstalled: (name) => pluginRegistry.get(name),
  });
  return loadPlugin(plugin, injectors);
}
