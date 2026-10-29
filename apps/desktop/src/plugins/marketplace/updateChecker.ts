/**
 * Update Checker — 插件更新检查
 *
 * 启动时检查已安装插件是否有更新
 */

import type { InstalledPlugin } from '@neoxlabs/platform/shared/plugin-types.js';
import { MarketplaceClient, DEFAULT_MARKETPLACES } from './marketplaceClient.js';
import { pluginRegistry } from '../pluginRegistry.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export interface UpdateInfo {
  name: string;
  currentVersion: string;
  latestVersion: string;
}

/**
 * 检查所有已安装插件的更新
 */
export async function checkForUpdates(): Promise<UpdateInfo[]> {
  await pluginRegistry.load();
  const installed = pluginRegistry.getAll();

  if (installed.length === 0) return [];

  const updates: UpdateInfo[] = [];
  const client = new MarketplaceClient(DEFAULT_MARKETPLACES[0]);

  try {
    const results = await client.checkUpdates(
      installed.map(p => ({ name: p.name, version: p.version })),
    );

    for (const r of results) {
      if (r.hasUpdate) {
        updates.push({
          name: r.name,
          currentVersion: r.currentVersion,
          latestVersion: r.latestVersion,
        });
      }
    }

    if (updates.length > 0) {
      cliLogger.info('PLUGIN', `${updates.length} plugin update(s) available: ${updates.map(u => `${u.name} ${u.currentVersion}→${u.latestVersion}`).join(', ')}`);
    }
  } catch (err: any) {
    cliLogger.warn('PLUGIN', `Update check failed: ${err.message}`);
  }

  return updates;
}

/**
 * 格式化更新提示 (给 CLI/UI 显示)
 */
export function formatUpdateNotice(updates: UpdateInfo[]): string | null {
  if (updates.length === 0) return null;

  const lines = [`🔄 ${updates.length} plugin update(s) available:`];
  for (const u of updates) {
    lines.push(`  ${u.name}: ${u.currentVersion} → ${u.latestVersion}`);
  }
  lines.push('');
  lines.push('Run /plugins update to install updates.');
  return lines.join('\n');
}
