/**
 * 官方市场的安装 / 更新检查。
 *
 * 从 registry 查到插件的发布源 (package / tarball / git), 再交给 pluginInstaller 里
 * 通用的远程安装路径 —— 校验、安全扫描、落注册表都在那条路上, 这里只做"查目录"。
 */
import type { MarketplacePlugin } from '@neoxlabs/platform/shared/plugin-types.js';
import type { InstallResult } from '../pluginManager.js';
import {
  installFromGitUrl,
  installFromPackageUrl,
  installFromTarballUrl,
  type RemoteInstallOptions,
} from '../pluginInstaller.js';
import { resolveMarketplaceBase } from './endpoint.js';

export async function installFromMarketplace(
  pluginName: string,
  options?: RemoteInstallOptions & { registryUrl?: string },
): Promise<InstallResult> {
  const registry = options?.registryUrl || resolveMarketplaceBase();
  const manifestUrl = `${registry}/plugins/${encodeURIComponent(pluginName)}`;
  let info: MarketplacePlugin;
  try {
    const res = await fetch(manifestUrl);
    if (!res.ok) {
      return {
        success: false,
        errors: [`Marketplace returned ${res.status} for ${pluginName}`],
        warnings: [],
      };
    }
    info = await res.json() as MarketplacePlugin;
  } catch (err: any) {
    return { success: false, errors: [`Marketplace query failed: ${err?.message}`], warnings: [] };
  }

  const { checkNeoxEngine } = await import('../pluginSecurity.js');
  const engines = (info.manifest as { engines?: { neox?: string } } | undefined)?.engines;
  const engine = checkNeoxEngine({ engines });
  if (!engine.ok) {
    return { success: false, errors: engine.errors, warnings: engine.warnings };
  }

  if (info.source?.type === 'package') {
    return installFromPackageUrl(info.source.url, {
      ...options,
      expectedSha256: options?.expectedSha256 ?? info.source.sha256,
    });
  }
  if (info.source?.type === 'tarball') {
    return installFromTarballUrl(info.source.url, {
      ...options,
    });
  }
  if (info.source?.type === 'git') {
    return installFromGitUrl(info.source.repo, {
      ...options,
      ref: info.source.ref,
    });
  }

  return { success: false, errors: [`Unsupported marketplace source type`], warnings: [] };
}

export interface PluginUpdateCheckResult {
  name: string;
  currentVersion: string;
  latestVersion: string;
  /** 是否有新版本 */
  hasUpdate: boolean;
  /** changelog URL / 文本 (如 registry 提供) */
  changelog?: string;
}

/**
 * 对比所有已安装 (非 dev) 插件的版本与 marketplace 最新版本.
 *
 * 仅对 source.type === 'marketplace' 或注册信息里有 registry URL 的插件做检查.
 * 其余 (url/local/dev) 不在此 check 范围.
 */
export async function checkAllPluginUpdates(options?: {
  registryUrl?: string;
}): Promise<PluginUpdateCheckResult[]> {
  const { pluginRegistry } = await import('../pluginRegistry.js');
  await pluginRegistry.load();
  const registry = options?.registryUrl || resolveMarketplaceBase();
  const checkable = pluginRegistry.getAll().filter(p =>
    p.source.type === 'marketplace' || p.source.type === 'url'
  );

  const results: PluginUpdateCheckResult[] = [];

  // 并行 fetch (上限 8 避免打爆 registry)
  const concurrency = 8;
  for (let i = 0; i < checkable.length; i += concurrency) {
    const batch = checkable.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(async (p) => {
      try {
        const res = await fetch(`${registry}/plugins/${encodeURIComponent(p.name)}`);
        if (!res.ok) return null;
        const info = await res.json() as MarketplacePlugin;
        const latest = info.version;
        return {
          name: p.name,
          currentVersion: p.version,
          latestVersion: latest,
          hasUpdate: semverLess(p.version, latest),
        } as PluginUpdateCheckResult;
      } catch {
        return null;
      }
    }));
    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value) results.push(r.value);
    }
  }

  return results;
}

export function semverLess(a: string, b: string): boolean {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = pa[i] ?? 0, bi = pb[i] ?? 0;
    if (ai < bi) return true;
    if (ai > bi) return false;
  }
  return false;
}
