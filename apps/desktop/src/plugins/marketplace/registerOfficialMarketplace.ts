/**
 * 官方市场 (NeoxCloud 插件目录) 接进桌面主进程。
 *
 * 由主进程发行版入口 ui/electron/mainEdition.ts 调用; 公开构建没有这个目录, 那边的
 * 发行版入口是空实现, 共享代码 (pluginHandlers / pluginCommands) 也就没有 marketplace
 * 这个安装来源、没有 search/featured 等子命令、没有 plugin:search 等 IPC。
 *
 *   registerOfficialMarketplace()     安装来源 + /plugins 子命令 + 市场地址 (进程启动即注册)
 *   registerOfficialMarketplaceIpc()  plugin:search / featured / categories / detail /
 *                                     check-updates / marketplace-install 这几条 IPC
 */
import { ipcMain } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PLUGIN_IPC_CHANNELS } from '@neoxlabs/platform/shared/ipc/plugin.js';
import type { PluginSearchRequest } from '@neoxlabs/platform/shared/ipc/plugin.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { resolveCloudEndpoints } from '../../ui/electron/services/cloudEndpoints.js';
import { pluginIpcHost } from '../../ui/electron/ipc/pluginHandlers.js';
import { registerPluginInstallSource } from '../pluginInstallSources.js';
import { registerPluginHelp, registerPluginSubcommand } from '../cli/pluginCommands.js';
import { resolveMarketplaceBase, setMarketplaceBase } from './endpoint.js';
import { fetchCatalogJson, readCatalogCache } from './catalogFetch.js';
import { marketplacePluginHelp, marketplacePluginSubcommands } from './marketplacePluginCommands.js';

/**
 * 把 cloudEndpoints 的结论灌进插件市场地址解析。
 *
 *   桌面端是唯一能区分 dev/packaged 的进程 (app.isPackaged), CLI 做不到 ——
 *   所以这层判断只能在这里下, 下完注入给共享模块。
 */
export function installMarketplaceBase(): void {
  setMarketplaceBase(`${resolveCloudEndpoints().api.replace(/\/+$/, '')}/api/v1`);
}

/* 市场地址收口到 plugins/marketplace/endpoint —— 之前这里硬编码回退 localhost,
 * 发布出去的客户端永远看到空目录, 且看不出原因。桌面端能靠 app.isPackaged 区分
 * dev/prod, 所以启动时把 cloudEndpoints 的结论注入进去 (见 installMarketplaceBase)。 */
function apiBase(): string {
  return resolveMarketplaceBase();
}

export function registerOfficialMarketplace(): void {
  registerPluginInstallSource('marketplace', {
    install: async (name) => {
      const { installFromMarketplace } = await import('./marketplaceInstaller.js');
      return installFromMarketplace(name, { registryUrl: apiBase() });
    },
    readManifest: async (name) => {
      const res = await fetch(`${apiBase()}/plugins/${encodeURIComponent(name)}`);
      if (!res.ok) return null;
      const record = (await res.json()) as { manifest?: unknown } | null;
      return record?.manifest && typeof record.manifest === 'object' ? record.manifest : null;
    },
  });

  for (const command of marketplacePluginSubcommands) registerPluginSubcommand(command);
  registerPluginHelp(marketplacePluginHelp);
}

export function registerOfficialMarketplaceIpc(): void {
  /* 先把 dev/prod 结论注入市场地址解析, 再注册 handler ——
   * 反过来的话第一次请求会用到默认值。放在 IPC 注册这一步 (而不是进程一启动) 是因为
   * cloudEndpoints 的结论要等主进程把环境变量灌好, 跟原来在 registerPluginIpcHandlers
   * 里调用的时机一致。 */
  installMarketplaceBase();
  /* 告诉 agent 线程「这个发行版有官方商店, 地址在这」—— agent 的 plugin_store_search 跑在 worker 里,
   * 看不见主进程注册的任何东西, 只能继承环境变量 (worker / 子进程都在之后才创建, 会带上它)。
   * 共享代码只读这个变量, 不 import 本目录; 公开版没有这行, 工具就如实说没有商店。 */
  process.env.NEOX_PLUGIN_STORE_API = apiBase();

  // ============================================================================
  // Marketplace — 直接 fetch NeoxCloud API
  // ============================================================================

  ipcMain.handle(PLUGIN_IPC_CHANNELS.SEARCH, async (_event, request: PluginSearchRequest) => {
    try {
      const params = new URLSearchParams();
      if (request.query) params.set('q', request.query);
      if (request.category) params.set('category', request.category);
      if (request.featured) params.set('featured', 'true');
      if (request.sort) params.set('sort', request.sort);
      if (request.page) params.set('page', String(request.page));
      if (request.pageSize) params.set('pageSize', String(request.pageSize));
      const url = `${apiBase()}/plugins?${params.toString()}`;
      if (request.cacheOnly) {
        const hit = await readCatalogCache<any>(url);
        return hit ? { ...hit.data, fromCache: true, cachedAt: hit.at } : null;
      }
      /* 超时 + 重试一次 + ETag 条件请求; 失败时回退缓存 (标 stale), 不再一卡就一直转 */
      const r = await fetchCatalogJson<any>(url);
      if (r.data) return r.stale ? { ...r.data, stale: true, staleReason: r.error } : r.data;
      return { plugins: [], total: 0, page: 1, pageSize: 20, error: r.error || 'network_error' };
    } catch (err: any) {
      console.error('[PLUGIN_IPC] Search failed:', err?.message);
      return {
        plugins: [], total: 0, page: 1, pageSize: 20,
        error: err?.message || 'network_error',
      };
    }
  });

  ipcMain.handle(PLUGIN_IPC_CHANNELS.FEATURED, async () => {
    const r = await fetchCatalogJson<any>(`${apiBase()}/plugins/featured`);
    return r.data ?? { error: r.error || 'network_error', plugins: [] };
  });

  ipcMain.handle(PLUGIN_IPC_CHANNELS.CATEGORIES, async () => {
    const r = await fetchCatalogJson<any>(`${apiBase()}/categories`);
    return Array.isArray(r.data) ? r.data : [];
  });

  ipcMain.handle(PLUGIN_IPC_CHANNELS.DETAIL, async (_event, name: string) => {
    const r = await fetchCatalogJson<any>(`${apiBase()}/plugins/${encodeURIComponent(name)}`);
    return r.data ?? null;
  });

  ipcMain.handle(PLUGIN_IPC_CHANNELS.CHECK_UPDATES, async () => {
    try {
      const { checkAllPluginUpdates } = await import('./marketplaceInstaller.js');
      const all = await checkAllPluginUpdates({ registryUrl: apiBase() });
      return all.filter(u => u.hasUpdate);
    } catch (err: any) {
      console.error('[PLUGIN_IPC] check-updates failed:', err?.message);
      return [];
    }
  });

  // ============================================================================
  // Marketplace Install — 真实安装
  // ============================================================================

  ipcMain.handle(PLUGIN_IPC_CHANNELS.MARKETPLACE_INSTALL, async (_event, plugin: any) => {
    const pType = plugin.pluginType || 'plugin';
    const name = plugin.name;

    try {
      if (pType === 'mcp') {
        // MCP: 直接读写 config.json (避免 Electron dist 模块路径问题)
        const npmPkg = name.startsWith('mcp-server-') ? `@modelcontextprotocol/server-${name.replace('mcp-server-', '')}`
          : name.startsWith('mcp-') ? `@modelcontextprotocol/server-${name.replace('mcp-', '')}`
          : name;

        const configPath = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'config.json');
        let config: any = {};
        try { config = JSON.parse(await fs.readFile(configPath, 'utf-8')); } catch { /* new */ }

        if (!config.mcp) config.mcp = {};
        if (!config.mcp.servers) config.mcp.servers = [];

        // 去重
        config.mcp.servers = config.mcp.servers.filter((s: any) => s.id !== name);
        config.mcp.servers.push({
          id: name,
          name: plugin.description || name,
          transport: 'stdio',
          command: 'npx',
          args: ['-y', npmPkg],
        });

        await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
        console.log(`[PLUGIN] MCP installed to config.json: ${name} → ${npmPkg}`);

        // 持久化到 pluginRegistry
        try {
          const { pluginRegistry } = await import('../pluginRegistry.js');
          await pluginRegistry.load();
          await pluginRegistry.register({
            name, version: plugin.version || '1.0.0',
            installPath: path.join(os.homedir(), NEOX_HOME_DIRNAME), source: { type: 'marketplace', registry: 'official' },
            enabled: true, installedAt: new Date().toISOString(),
            manifest: { name, version: plugin.version || '1.0.0', description: plugin.description, author: plugin.author || { name: 'Community' }, category: plugin.category } as any,
          });
        } catch { /* non-critical */ }

        pluginIpcHost.invalidatePluginListCache();
        return { success: true, type: 'mcp', message: `MCP "${name}" installed.\nPackage: ${npmPkg}\nRestart session to connect.\nVisible in Settings → MCP` };

      } else if (pType === 'skill') {
        // Skill: 生成 SKILL.md 并保存
        const skillsDir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'skills', name);
        await fs.mkdir(skillsDir, { recursive: true });

        const keywords = Array.isArray(plugin.keywords) ? plugin.keywords : [];
        const skillMd = [
          '---',
          `name: ${name}`,
          `description: "${plugin.description}"`,
          'user-invocable: true',
          'neox:',
          `  category: ${plugin.category || 'community'}`,
          keywords.length ? `  aliases: [${keywords.slice(0, 2).join(', ')}]` : '',
          '---',
          '',
          `## ${plugin.description}`,
          '',
          `Perform the task described above. Use best practices for ${plugin.category || 'development'}.`,
          '',
          `Author: ${plugin.author?.name || 'Community'}`,
          `Version: ${plugin.version || '1.0.0'}`,
        ].filter(Boolean).join('\n');

        await fs.writeFile(path.join(skillsDir, 'SKILL.md'), skillMd, 'utf-8');
        console.log(`[PLUGIN] Skill installed: ${name} → ${skillsDir}`);

        // 热加载: 通知 SkillRegistry 重新扫描
        try {
          const { skillRegistry } = await import('@neoxlabs/core/skills/index.js');
          if (skillRegistry?.refresh) await skillRegistry.refresh();
          console.log(`[PLUGIN] Skill registry refreshed`);
        } catch { /* 非关键路径 */ }

        // 持久化到 pluginRegistry
        try {
          const { pluginRegistry } = await import('../pluginRegistry.js');
          await pluginRegistry.load();
          await pluginRegistry.register({
            name, version: plugin.version || '1.0.0',
            installPath: skillsDir, source: { type: 'marketplace', registry: 'official' },
            enabled: true, installedAt: new Date().toISOString(),
            manifest: { name, version: plugin.version || '1.0.0', description: plugin.description, author: plugin.author || { name: 'Neox Team' }, category: plugin.category } as any,
          });
        } catch { /* non-critical */ }

        pluginIpcHost.invalidatePluginListCache();
        return { success: true, type: 'skill', message: `Skill "${name}" installed.\nUse /${name} in chat to invoke.\nPath: ~/.neox/skills/${name}/SKILL.md` };

      } else {
        const { installFromMarketplace } = await import('./marketplaceInstaller.js');
        const result: any = await installFromMarketplace(name, { registryUrl: apiBase() });

        pluginIpcHost.invalidatePluginListCache();
        if (!result?.success) {
          return { success: false, error: (result?.errors ?? []).join('\n') || 'Install failed' };
        }
        await pluginIpcHost.activatePluginBestEffort(result.plugin);
        return {
          success: true,
          type: 'plugin',
          trust: result.trust,
          warnings: result.warnings ?? [],
          message: result.warnings?.length ? result.warnings.join(' · ') : '',
        };
      }
    } catch (err: any) {
      console.error(`[PLUGIN] Install failed: ${name}`, err.message);
      return { success: false, error: err.message };
    }
  });
}
