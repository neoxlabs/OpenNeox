/**
 * Plugin Manager — 安装/卸载/更新/启用/禁用
 *
 * 核心操作入口，协调 Registry + Loader + Security
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { pluginRegistry, PluginRegistry } from './pluginRegistry.js';
import { loadManifest } from './pluginLoader.js';
import { validateManifest, scanPluginDirectory, checkNeoxEngine, checkPluginPlatform } from './pluginSecurity.js';
import type { InstalledPlugin, PluginManifest, PluginSource } from '@neoxlabs/platform/shared/plugin-types.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { newPermissionsSince, revokeGrants, setGrants } from './connector/grantStore.js';
import { deleteCredential, clearConnection } from './connector/credentialStore.js';

// ============================================================================
// Install
// ============================================================================

export interface InstallOptions {
  /** 来源 */
  source: PluginSource;
  /** 启用 (默认 true) */
  enable?: boolean;
  /** 用户配置 */
  userConfig?: Record<string, any>;
  /** 跳过安全扫描 (开发模式) */
  skipScan?: boolean;
  /** 包校验得出的信任级别 (仅 .neox-plugin 路径有) */
  trust?: InstalledPlugin['trust'];
  /** 当前 Neox 版本。打包桌面会走 NEOX_APP_VERSION; 单测显式传入 */
  neoxVersion?: string;
  /** 当前平台 (process.platform)。单测显式传入 —— 要在一个系统上把两条路都试一遍 */
  currentPlatform?: string;
  /** 放行「声明不支持当前系统」的插件。只给 dev 加载用, 见 checkPluginPlatform */
  allowUnsupportedPlatform?: boolean;
}

export interface InstallResult {
  success: boolean;
  plugin?: InstalledPlugin;
  manifest?: PluginManifest;
  errors: string[];
  warnings: string[];
}

/**
 * 从本地路径安装插件
 */
export async function installFromPath(sourcePath: string, options?: Partial<InstallOptions>): Promise<InstallResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. 读取清单
  const absPath = path.resolve(sourcePath);
  const manifest = await loadManifest(absPath);
  if (!manifest) {
    return { success: false, errors: ['Failed to load plugin.json from ' + absPath], warnings: [] };
  }

  // 2. 校验清单
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    return { success: false, errors: validation.errors, warnings: validation.warnings };
  }
  warnings.push(...validation.warnings);

  const engine = checkNeoxEngine(manifest, {
    neoxVersion: options?.neoxVersion,
  });
  warnings.push(...engine.warnings);
  if (!engine.ok) {
    return { success: false, errors: engine.errors, warnings };
  }

  /* 平台声明。跟 engines 同一层: 声明了不支持当前系统就别装 —— 工具到不了模型手里,
   * 只剩一个「装上了但没用」的墓碑 (Windows 装 mac-only 的 computer-use 就是这么回事)。 */
  const platform = checkPluginPlatform(manifest, {
    currentPlatform: options?.currentPlatform,
    allowUnsupported: options?.allowUnsupportedPlatform,
  });
  if (!platform.ok) {
    return { success: false, errors: platform.errors, warnings };
  }

  // 3. 安全扫描
  if (!options?.skipScan) {
    const scanIssues = await scanPluginDirectory(absPath);
    if (scanIssues.length > 0) {
      warnings.push(...scanIssues.map(i => `Security: ${i}`));
      // 危险文件是硬错误
      const dangerous = scanIssues.filter(i => i.startsWith('Dangerous file'));
      if (dangerous.length > 0) {
        return { success: false, errors: dangerous, warnings };
      }
    }
  }

  // 4. 检查是否已安装
  await pluginRegistry.load();
  const existing = pluginRegistry.get(manifest.name);
  if (existing) {
    // 更新
    cliLogger.info('PLUGIN', `Updating ${manifest.name} from ${existing.version} to ${manifest.version}`);
  }

  // 5. 复制到安装目录 (dev 模式直接链接)
  const isDev = options?.source?.type === 'dev';
  const installDir = isDev
    ? absPath
    : pluginRegistry.getInstallDir(manifest.name, manifest.version);

  if (!isDev) {
    await fs.mkdir(installDir, { recursive: true });
    await copyDirectory(absPath, installDir);
  }

  // 6. 注册
  const plugin: InstalledPlugin = {
    name: manifest.name,
    version: manifest.version,
    installPath: installDir,
    source: options?.source ?? { type: 'local', path: absPath },
    enabled: options?.enable !== false,
    installedAt: new Date().toISOString(),
    userConfig: options?.userConfig,
    manifest,
    trust: options?.trust,
  };

  await pluginRegistry.register(plugin);

  // 7. connector 授权
  //
  //    首装 = 用户看过权限清单后点了安装, 这一步就是授权本身, 全量授予。
  //    升级则**只保留已授予的**, 新增能力留在未授予状态并回一条警告 ——
  //    「装的时候人畜无害, 更新时提权」是插件市场最核心的一条攻击路径,
  //    静默继承授权等于把这条路铺好。
  if (manifest.connector?.permissions?.length) {
    const declared = manifest.connector.permissions.map(p => p.capability);
    if (existing) {
      const pending = newPermissionsSince(manifest.name, declared);
      if (pending.length > 0) {
        warnings.push(
          `新版本请求了尚未授予的能力: ${pending.join(', ')} — 请在 设置 → 插件 中确认后才会生效`,
        );
      }
      setGrants(manifest.name, declared.filter(c => !pending.includes(c)));
    } else {
      setGrants(manifest.name, declared);
    }
  }

  cliLogger.info('PLUGIN', `Installed ${manifest.name}@${manifest.version} → ${installDir}`);
  return { success: true, plugin, manifest, errors: [], warnings };
}

/**
 * 从 URL 安装插件 (下载 tarball / git clone)
 *
 * 具体实现见 pluginInstaller.ts. 支持:
 *   - https://xxx.tar.gz / .tgz
 *   - git@host:owner/repo / https://github.com/owner/repo.git
 */
export async function installFromUrl(url: string, options?: Partial<InstallOptions>): Promise<InstallResult> {
  const { installFromRemoteUrl } = await import('./pluginInstaller.js');
  return installFromRemoteUrl(url, {
    enable: options?.enable,
    userConfig: options?.userConfig,
    skipScan: options?.skipScan,
  });
}

// ============================================================================
// Uninstall
// ============================================================================

export async function uninstallPlugin(name: string): Promise<{ success: boolean; error?: string }> {
  await pluginRegistry.load();
  const plugin = pluginRegistry.get(name);
  if (!plugin) {
    return { success: false, error: `Plugin "${name}" is not installed` };
  }

  // 清理安装目录 (dev 模式不删除源目录)
  if (plugin.source.type !== 'dev') {
    try {
      await fs.rm(plugin.installPath, { recursive: true, force: true });
    } catch (err: any) {
      cliLogger.warn('PLUGIN', `Failed to clean install dir: ${err.message}`);
    }
  }

  /* 卸载要连凭据和授权一起清: 留着的话重装同名插件会直接继承上一次的授权,
   * 而用户以为自己装的是一个全新的东西 */
  await deleteCredential(name).catch(() => {});
  await clearConnection(name).catch(() => {});
  revokeGrants(name);

  await pluginRegistry.unregister(name);
  cliLogger.info('PLUGIN', `Uninstalled ${name}`);
  return { success: true };
}

// ============================================================================
// Enable / Disable
// ============================================================================

export async function enablePlugin(name: string): Promise<{ success: boolean; error?: string }> {
  await pluginRegistry.load();
  if (!pluginRegistry.isInstalled(name)) {
    return { success: false, error: `Plugin "${name}" is not installed` };
  }
  const ok = await pluginRegistry.enable(name);
  return ok ? { success: true } : { success: false, error: 'Failed to enable' };
}

export async function disablePlugin(name: string): Promise<{ success: boolean; error?: string }> {
  await pluginRegistry.load();
  if (!pluginRegistry.isInstalled(name)) {
    return { success: false, error: `Plugin "${name}" is not installed` };
  }
  const ok = await pluginRegistry.disable(name);
  return ok ? { success: true } : { success: false, error: 'Failed to disable' };
}

// ============================================================================
// Reload (手动热更新 · ESM 世界的最大公约数)
// ============================================================================

/**
 * 重新加载一个 plugin。
 *
 * **ESM 限制说明**:Node.js ESM 的 module cache 是进程级不可清的, 意味着 plugin
 * 源码修改后真正的 "零进程重启热更新" 在纯 ESM 下做不到(Claude-Code / OpenCode
 * 也都没实装)。
 *
 * 本函数提供**操作级** reload:disable → re-read manifest → enable。适用场景:
 *   · Plugin manifest.json 改了(添加/删除命令/技能)
 *   · Plugin 依赖配置变了(userConfig)
 *   · Plugin 实例化参数需要重设
 * 不适用:plugin 源码文件本体变了 —— 这种情况 Node ESM 仍会用缓存的旧代码。
 * 唯一彻底解决办法是重启 Neox 进程。
 *
 * 对开发者场景已经够用(大部分 plugin 调试是改配置 / 改 manifest 而非改代码),
 * chokidar watch + 自动触发 reload 这种"看起来很美"的功能会给人虚假安全感,
 * 故意不加。
 */
export async function reloadPlugin(
  name: string,
): Promise<{ success: boolean; error?: string; warnings: string[] }> {
  await pluginRegistry.load();
  if (!pluginRegistry.isInstalled(name)) {
    return { success: false, error: `Plugin "${name}" is not installed`, warnings: [] };
  }

  const warnings: string[] = [];
  const wasEnabled = pluginRegistry.get(name)?.enabled ?? false;

  // 1. 强制 disable(即使当前是 disabled 状态, 确保清理)
  try {
    await pluginRegistry.disable(name);
  } catch (err: any) {
    warnings.push(`disable step threw: ${err?.message ?? String(err)}`);
  }

  // 2. 如果原本是 enabled, 再 enable(会重读 manifest, 重新注册 commands/skills/hooks)
  if (wasEnabled) {
    const ok = await pluginRegistry.enable(name);
    if (!ok) {
      return {
        success: false,
        error: 'Failed to re-enable plugin after disable',
        warnings,
      };
    }
  }

  warnings.push(
    'Note: Node ESM cache is not cleared — if you modified plugin source code (.js/.ts), ' +
      'you must restart Neox for changes to take effect. reloadPlugin only re-reads manifest/config.',
  );

  cliLogger.info('PLUGIN', `Reloaded ${name} (was ${wasEnabled ? 'enabled' : 'disabled'})`);
  return { success: true, warnings };
}

// ============================================================================
// List / Info
// ============================================================================

export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  author: string;
  enabled: boolean;
  source: string;
  installedAt: string;
  components: {
    skills: string[];
    tools: string[];
    mcpServers: string[];
    /** connector 贡献给 Agent 的工具全名 */
    connectorTools: string[];
  };
  permissions: string[];
}

export async function getPluginInfo(name: string): Promise<PluginInfo | null> {
  await pluginRegistry.load();
  const plugin = pluginRegistry.get(name);
  if (!plugin) return null;

  const manifest = plugin.manifest ?? await loadManifest(plugin.installPath);
  if (!manifest) return null;

  return {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author.name,
    enabled: plugin.enabled,
    source: plugin.source.type,
    installedAt: plugin.installedAt,
    components: {
      skills: manifest.skills ?? [],
      tools: manifest.tools ?? [],
      mcpServers: Object.keys(manifest.mcpServers ?? {}),
      connectorTools: (manifest.connector?.tools ?? [])
        .map(t => `${manifest.connector!.namespace}_${t.name}`),
    },
    permissions: formatPermissions(manifest),
  };
}

export async function listPlugins(): Promise<InstalledPlugin[]> {
  await pluginRegistry.load();
  return pluginRegistry.getAll();
}

// ============================================================================
// Dev Mode
// ============================================================================

/**
 * 开发模式加载 (不复制，直接链接源目录)
 */
export async function devLoadPlugin(pluginPath: string): Promise<InstallResult> {
  return installFromPath(pluginPath, {
    source: { type: 'dev', path: path.resolve(pluginPath) },
    skipScan: true,
    enable: true,
    /* dev 是**作者在开发它**, 不是用户在装它 —— 别让「在我这台机器上写一个只给
     * 别的平台用的插件」变成不可能。真正的用户路径 (市场 / URL / 本地导入) 照拦。 */
    allowUnsupportedPlatform: true,
  });
}

// ============================================================================
// Internal Helpers
// ============================================================================

function formatPermissions(manifest: PluginManifest): string[] {
  const perms: string[] = [];
  /* connector 的能力用人话展示 —— `design.read` 对用户没有任何信息量 */
  for (const p of manifest.connector?.permissions ?? []) {
    const reason = p.reason.zh ?? p.reason.en;
    const cost = p.cost ? ` · 约 $${p.cost.approxUsd}/${p.cost.unit}` : '';
    perms.push(`${reason} [${p.effect}${cost}]`);
  }
  if (manifest.permissions?.tools?.length) {
    perms.push(`Tools: ${manifest.permissions.tools.join(', ')}`);
  }
  if (manifest.permissions?.network) {
    perms.push('Network access');
  }
  if (manifest.permissions?.filesystem?.read?.length) {
    perms.push(`Read: ${manifest.permissions.filesystem.read.join(', ')}`);
  }
  if (manifest.permissions?.filesystem?.write?.length) {
    perms.push(`Write: ${manifest.permissions.filesystem.write.join(', ')}`);
  }
  if (manifest.dependencies?.env?.length) {
    perms.push(`Env vars: ${manifest.dependencies.env.join(', ')}`);
  }
  return perms;
}

async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}
