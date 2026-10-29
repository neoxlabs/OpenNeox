import { ipcMain } from './ipcMainBridged.js';
import { configService } from '@neoxlabs/platform/platform/configService.js';
import { neoxLogger } from '@neoxlabs/kernel/platform/neoxLogger.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { AGENT_BRIDGE } from '../context/tokens.js';

interface RegisterConfigGeneralIpcHandlersOptions {
  projectManager: ProjectManager;
}

export function registerConfigGeneralIpcHandlers(
  options: RegisterConfigGeneralIpcHandlersOptions,
): void {
  const { projectManager } = options;

  ipcMain.handle('config:get-language', () => {
    return configService.getLanguagePreference();
  });

  ipcMain.handle('config:set-language', (_event, language: 'zh' | 'en') => {
    configService.setLanguagePreference(language);
    // Broadcast to all open project bridges — language 是全局设置, 每个 bridge 都要同步
    for (const scope of projectManager.listAll()) {
      scope.peekService(AGENT_BRIDGE)?.setLanguage(language);
    }
  });

  ipcMain.handle('config:get-pii-filter', () => {
    return configService.getPiiFilterPreference();
  });

  ipcMain.handle('config:set-pii-filter', (_event, enabled: boolean) => {
    configService.setPiiFilterPreference(enabled);
  });

  ipcMain.handle('config:get-crash-report', () => {
    return configService.getCrashReportPreference();
  });
  ipcMain.handle('config:set-crash-report', (_event, enabled: boolean) => {
    configService.setCrashReportPreference(enabled === true);
  });

  ipcMain.handle('config:get-browser-use', () => configService.getBrowserUseConfig());
  ipcMain.handle('config:set-browser-use', (_event, patch: Parameters<typeof configService.setBrowserUseConfig>[0]) => {
    configService.setBrowserUseConfig(patch);
  });
  ipcMain.handle('config:get-github-channel', () => configService.getGithubChannelConfig());
  ipcMain.handle('config:set-github-channel', (_event, patch: Parameters<typeof configService.setGithubChannelConfig>[0]) =>
    configService.setGithubChannelConfig(patch));
  ipcMain.handle('config:get-github-channel-status', () => configService.getGithubChannelStatus());
  ipcMain.handle('github:token-info', async () => {
    const { resolveGithubToken, resetGithubTokenCache } = await import('@neoxlabs/core/tools/runtimeTools.js');
    resetGithubTokenCache();
    const token = resolveGithubToken();
    if (!token) return { ok: false, error: 'no-token' };
    const source = process.env.GITHUB_TOKEN || process.env.GH_TOKEN ? 'env' : 'gh';
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'neox-desktop' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, source, error: `HTTP ${res.status}` };
      const me = (await res.json()) as { login?: string };
      return { ok: true, source, login: me.login };
    } catch (err: any) {
      return { ok: false, source, error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle('browser:list-daily-profiles', async () => {
    const { listDailyProfiles, findChromeExecutable } = await import('@neoxlabs/core/tools/runtimeTools.js');
    return listDailyProfiles(findChromeExecutable());
  });
  ipcMain.handle('browser:sync-daily-logins', async () => {
    /* 走 core 的工具实现: 先 disconnect agent Chrome, 再拷, 开关关着时 force —— 用户在设置页
     * 亲手点的"现在同步", 就是明确的授权。 */
    const { browserSyncDailyLogins } = await import('@neoxlabs/core/tools/runtimeTools.js');
    return browserSyncDailyLogins({ force: true });
  });

  ipcMain.handle('config:get-cli-debug', () => {
    return configService.getCliDebugPreference();
  });

  ipcMain.handle('config:set-cli-debug', (_event, enabled: boolean) => {
    /* 单一开关 = 全 Electron 诊断日志总闸.
     *
     *   旧行为: 只翻 process.env.CLI_DEBUG. 但 neoxLogger 是 main.ts 启动时根据
     *   pref 一次性 setEnabled, 翻这里不影响; cliLogger 在 server 子进程里, 看的
     *   是子进程启动时继承的 env, 也不会跟翻. 结果: 用户翻完 toggle 以为开了, 实际
     *   ~/.neox/logs/neox-app-*.log 不写, [INTERRUPT_TRIGGER] 等关键诊断行也不落盘.
     *
     *   现在 main 进程的 neoxLogger 立即跟翻, 翻完不需要重启 (主进程内的事件马上落盘).
     *   server 子进程的 cliLogger 仍需要重启才能跟上 (它的 enabled 是模块加载时 evaluate
     *   的, 子进程已经 spawn 了, 改不了; 用户重启后正常生效). */
    configService.setCliDebugPreference(enabled);
    process.env.CLI_DEBUG = enabled ? '1' : '';
    neoxLogger.setEnabled(enabled);
    if (enabled) {
      neoxLogger.info('CLI_DEBUG', 'Diagnostic logging enabled — neox-app-*.log live; cli-*.log on next restart');
    }
  });

  ipcMain.handle('config:get-enabled-tools', () => {
    return configService.getEnabledTools();
  });

  ipcMain.handle('config:get-reasoning-effort', () => {
    return configService.getReasoningEffort();
  });

  ipcMain.handle('config:set-reasoning-effort', (_event, effort: string) => {
    configService.setReasoningEffort(effort);
    process.env.NEOX_REASONING_EFFORT = effort;
    // console.log('[Main] Reasoning effort set to:', effort);
  });

  ipcMain.handle('config:get-model-config', () => {
    const cfg = configService.getModelConfig();
    process.env.NEOX_REASONING_SUMMARY = cfg.reasoning_summary;
    process.env.NEOX_VERBOSITY = cfg.verbosity;

    process.env.NEOX_WEB_SEARCH = cfg.web_search;
    process.env.NEOX_HIDE_AGENT_REASONING = String(cfg.hide_agent_reasoning);
    process.env.NEOX_CONTEXT_WINDOW = String(cfg.context_window);
    process.env.NEOX_AUTO_COMPACT_LIMIT = String(cfg.auto_compact_limit);
    process.env.NEOX_SERVICE_TIER = cfg.service_tier;
    return cfg;
  });

  ipcMain.handle('config:set-model-config', (_event, config: Record<string, any>) => {
    configService.setModelConfig(config);
    if (config.reasoning_summary !== undefined) process.env.NEOX_REASONING_SUMMARY = config.reasoning_summary;
    if (config.verbosity !== undefined) process.env.NEOX_VERBOSITY = config.verbosity;

    if (config.web_search !== undefined) process.env.NEOX_WEB_SEARCH = config.web_search;
    if (config.hide_agent_reasoning !== undefined) process.env.NEOX_HIDE_AGENT_REASONING = String(config.hide_agent_reasoning);
    if (config.context_window !== undefined) process.env.NEOX_CONTEXT_WINDOW = String(config.context_window);
    if (config.auto_compact_limit !== undefined) process.env.NEOX_AUTO_COMPACT_LIMIT = String(config.auto_compact_limit);
    if (config.service_tier !== undefined) process.env.NEOX_SERVICE_TIER = config.service_tier;
    // console.log('[Main] Model config updated (persisted):', config);
  });

  ipcMain.handle('config:set-enabled-tools', (_event, enabledTools: Record<string, boolean>) => {
    configService.setEnabledTools(enabledTools);
  });

  ipcMain.handle('config:get-agent-settings', () => {
    return configService.getAgentSettings();
  });

  ipcMain.handle('config:set-agent-settings', (_event, settings: { sandboxEnabled?: boolean; approvalMode?: 'auto' | 'manual' | 'dangerous'; webSearchEnabled?: boolean; webSearchUrl?: string; webSearchApiKey?: string; javaDebugEnabled?: boolean; javaDebugHome?: string; javaDebugJarPath?: string }) => {
    configService.setAgentSettings(settings);
  });

  ipcMain.handle('config:get-agent-runtime', () => {
    return configService.getAgentRuntimeConfig();
  });
  ipcMain.handle('config:set-agent-runtime', (_event, partial: any) => {
    configService.setAgentRuntimeConfig(partial);
  });

  ipcMain.handle('config:get-orchestrator-config', () => {
    return configService.getOrchestratorConfig();
  });

  ipcMain.handle('config:set-orchestrator-config', (_event, config: Parameters<typeof configService.setOrchestratorConfig>[0]) => {
    configService.setOrchestratorConfig(config);
  });

  ipcMain.handle('config:get-orchestrator-enabled', () => {
    return configService.getOrchestratorEnabled();
  });

  ipcMain.handle('config:set-orchestrator-enabled', (_event, enabled: boolean) => {
    configService.setOrchestratorEnabled(enabled);
  });
  // (assistant 模式性格/感知配置 handler 已随 assistant 删除移除)
}
