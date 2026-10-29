/**
 * GitHub 源插件市场的 IPC (marketplace:*) —— 两个发行版都有。
 *
 * 实现在 apps/desktop/src/marketplace/openMarketplaceService.ts: 用户把 GitHub 仓库加成
 * 市场源, 从仓库归档里读 marketplace.json 再装里面的插件 / 技能。跟官方市场
 * (plugin:search / plugin:marketplace-install, 商业发行版在 ../mainEdition.ts 注册) 互不相干。
 *
 * 服务按需加载: 模块顶层会 new 出单例 (读 ~/.neox 下的源列表), 不打开市场页就没必要付这个成本。
 */
import { ipcMain } from 'electron';
import { PLUGIN_IPC_CHANNELS } from '@neoxlabs/platform/shared/ipc/plugin.js';
import type { InstalledPlugin } from '@neoxlabs/platform/shared/plugin-types.js';

interface OpenMarketplaceIpcHost {
  invalidatePluginListCache(): void;
  activatePluginBestEffort(plugin: InstalledPlugin): Promise<void>;
}

const service = async () => (await import('../../../marketplace/openMarketplaceService.js')).openMarketplaceService;

export function registerOpenMarketplaceIpcHandlers(host: OpenMarketplaceIpcHost): void {
  ipcMain.handle(PLUGIN_IPC_CHANNELS.OPEN_MARKETPLACE_SOURCES, async () => (await service()).listSources());
  ipcMain.handle(PLUGIN_IPC_CHANNELS.OPEN_MARKETPLACE_SOURCE_ADD, async (_event, input) => (await service()).addSource(input));
  ipcMain.handle(PLUGIN_IPC_CHANNELS.OPEN_MARKETPLACE_SOURCE_UPDATE, async (_event, id: string, patch) => (await service()).updateSource(id, patch));
  ipcMain.handle(PLUGIN_IPC_CHANNELS.OPEN_MARKETPLACE_SOURCE_REMOVE, async (_event, id: string) => {
    (await service()).removeSource(id);
    return { success: true };
  });
  ipcMain.handle(PLUGIN_IPC_CHANNELS.OPEN_MARKETPLACE_SOURCE_REFRESH, async (_event, id: string) => (await service()).refresh(id));
  ipcMain.handle(PLUGIN_IPC_CHANNELS.OPEN_MARKETPLACE_SEARCH, async (_event, options) => (await service()).search(options));
  ipcMain.handle(PLUGIN_IPC_CHANNELS.OPEN_MARKETPLACE_TOKEN_SET, async (_event, id: string, token?: string) => {
    await (await service()).setToken(id, token);
    return { success: true };
  });
  ipcMain.handle(PLUGIN_IPC_CHANNELS.OPEN_MARKETPLACE_INSTALL, async (_event, request: { sourceId: string; type: 'plugin' | 'skill'; slug: string; confirmConflict?: boolean }) => {
    try {
      const result = await (await service()).install(request.sourceId, request.type, request.slug, request.confirmConflict === true);
      /* 跟 plugin:install 同一套收尾: 列表缓存失效, 装上的插件立即激活 */
      if (result.success) {
        host.invalidatePluginListCache();
        if (result.plugin) await host.activatePluginBestEffort(result.plugin);
      }
      return result;
    } catch (error: any) {
      return { success: false, error: error?.message ?? String(error) };
    }
  });
}
