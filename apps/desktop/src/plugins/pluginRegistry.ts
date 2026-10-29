/**
 * Plugin Registry — 已安装插件注册表
 *
 * 持久化到 ~/.neox/plugins/registry.json
 * 管理插件的安装/卸载/启用/禁用状态
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { InstalledPlugin, PluginRegistryData, PluginEventCallback, PluginEvent } from '@neoxlabs/platform/shared/plugin-types.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

const NEOX_PLUGINS_DIR = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'plugins');
const REGISTRY_FILE = path.join(NEOX_PLUGINS_DIR, 'registry.json');
const INSTALLED_DIR = path.join(NEOX_PLUGINS_DIR, 'installed');
const USER_CONFIG_DIR = path.join(NEOX_PLUGINS_DIR, 'user-config');

export class PluginRegistry {
  private data: PluginRegistryData = { version: 1, plugins: {} };
  private loaded = false;
  private listeners: PluginEventCallback[] = [];

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /** 加载注册表 (幂等) */
  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      await fs.mkdir(NEOX_PLUGINS_DIR, { recursive: true });
      await fs.mkdir(INSTALLED_DIR, { recursive: true });
      await fs.mkdir(USER_CONFIG_DIR, { recursive: true });
      const raw = await fs.readFile(REGISTRY_FILE, 'utf-8');
      this.data = JSON.parse(raw);
      if (!this.data.version || !this.data.plugins) {
        this.data = { version: 1, plugins: {} };
      }
    } catch {
      this.data = { version: 1, plugins: {} };
    }
    this.loaded = true;
  }

  /** 丢掉内存缓存, 再读一次磁盘 —— worker 要看见主进程刚写下的安装/启用变更 */
  async reload(): Promise<void> {
    this.loaded = false;
    await this.load();
  }

  /** 保存注册表 */
  async save(): Promise<void> {
    await fs.mkdir(NEOX_PLUGINS_DIR, { recursive: true });
    await fs.writeFile(REGISTRY_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  // ============================================================================
  // CRUD
  // ============================================================================

  /** 获取所有已安装插件 */
  getAll(): InstalledPlugin[] {
    return Object.values(this.data.plugins);
  }

  /** 获取已启用的插件 */
  getEnabled(): InstalledPlugin[] {
    return this.getAll().filter(p => p.enabled);
  }

  /** 获取单个插件 */
  get(name: string): InstalledPlugin | undefined {
    return this.data.plugins[name];
  }

  /** 检查是否已安装 */
  isInstalled(name: string): boolean {
    return name in this.data.plugins;
  }

  /** 注册新安装的插件 */
  async register(plugin: InstalledPlugin): Promise<void> {
    this.data.plugins[plugin.name] = plugin;
    await this.save();
    this.emit({ type: 'installed', pluginName: plugin.name, version: plugin.version, timestamp: Date.now() });
  }

  /** 注销 (卸载) */
  async unregister(name: string): Promise<void> {
    const plugin = this.data.plugins[name];
    if (!plugin) return;
    delete this.data.plugins[name];
    await this.save();
    this.emit({ type: 'uninstalled', pluginName: name, timestamp: Date.now() });
  }

  /** 启用插件 */
  async enable(name: string): Promise<boolean> {
    const plugin = this.data.plugins[name];
    if (!plugin) return false;
    plugin.enabled = true;
    await this.save();
    this.emit({ type: 'enabled', pluginName: name, timestamp: Date.now() });
    return true;
  }

  /** 禁用插件 */
  async disable(name: string): Promise<boolean> {
    const plugin = this.data.plugins[name];
    if (!plugin) return false;
    plugin.enabled = false;
    await this.save();
    this.emit({ type: 'disabled', pluginName: name, timestamp: Date.now() });
    return true;
  }

  /** 更新版本 */
  async updateVersion(name: string, version: string, installPath: string): Promise<boolean> {
    const plugin = this.data.plugins[name];
    if (!plugin) return false;
    plugin.version = version;
    plugin.installPath = installPath;
    plugin.updatedAt = new Date().toISOString();
    await this.save();
    this.emit({ type: 'updated', pluginName: name, version, timestamp: Date.now() });
    return true;
  }

  /** 保存用户配置 */
  async saveUserConfig(name: string, config: Record<string, any>): Promise<void> {
    const plugin = this.data.plugins[name];
    if (plugin) {
      plugin.userConfig = config;
      await this.save();
    }
    // 同时写入独立配置文件
    await fs.writeFile(
      path.join(USER_CONFIG_DIR, `${name}.json`),
      JSON.stringify(config, null, 2),
      'utf-8',
    );
  }

  /** 读取用户配置 */
  async getUserConfig(name: string): Promise<Record<string, any>> {
    // 优先从注册表读
    const plugin = this.data.plugins[name];
    if (plugin?.userConfig) return plugin.userConfig;
    // 回退到独立文件
    try {
      const raw = await fs.readFile(path.join(USER_CONFIG_DIR, `${name}.json`), 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  // ============================================================================
  // Events
  // ============================================================================

  onEvent(callback: PluginEventCallback): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }

  private emit(event: PluginEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* ignore */ }
    }
  }

  // ============================================================================
  // Paths
  // ============================================================================

  /** 获取插件安装目录 */
  getInstallDir(name: string, version: string): string {
    return path.join(INSTALLED_DIR, `${name}@${version}`);
  }

  /** 获取插件目录根 */
  static get pluginsDir(): string { return NEOX_PLUGINS_DIR; }
  static get installedDir(): string { return INSTALLED_DIR; }
  static get registryFile(): string { return REGISTRY_FILE; }

  // ============================================================================
  // Stats
  // ============================================================================

  getStats(): { total: number; enabled: number; disabled: number } {
    const all = this.getAll();
    return {
      total: all.length,
      enabled: all.filter(p => p.enabled).length,
      disabled: all.filter(p => !p.enabled).length,
    };
  }
}

/** 全局单例 */
export const pluginRegistry = new PluginRegistry();
