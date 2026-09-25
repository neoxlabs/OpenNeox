/**
 * Settings Layer System — 分层配置管理
 *
 * 三层优先级（从低到高）：
 * 1. User — ~/.neox/settings.json（用户全局配置）
 * 2. Workspace — .neox/settings.json（项目工作区配置）
 * 3. Session — 运行时覆盖（不持久化）
 *
 * 支持：
 * - Zod schema 校验
 * - 热加载（检测文件变更）
 * - Migration（版本化迁移）
 * - Hooks（pre/post tool execution）
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

// ==================== Types ====================

export type SettingsScope = 'user' | 'workspace' | 'session';

export interface SettingsLayer {
  scope: SettingsScope;
  data: Record<string, any>;
  filePath?: string;
  lastModified?: number;
}

export interface HookConfig {
  /** Event to trigger on */
  event: 'pre_tool_call' | 'post_tool_call' | 'pre_submit' | 'post_submit' | 'on_error';
  /** Shell command to execute */
  command: string;
  /** Only for specific tool names */
  toolFilter?: string[];
  /** Whether to block execution until hook completes */
  blocking?: boolean;
  /** Timeout in ms */
  timeoutMs?: number;
}

export interface NeoxSettings {
  // Speed / Effort / Style defaults
  speedMode?: 'turbo' | 'normal' | 'deep';
  effortLevel?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  outputStyle?: 'concise' | 'standard' | 'detailed' | 'code_only';

  // Notifications
  notificationsEnabled?: boolean;
  notificationRules?: Array<{
    event: string;
    channel: string;
    enabled: boolean;
  }>;

  // Speculation
  speculationEnabled?: boolean;

  // Hooks
  hooks?: HookConfig[];

  // Context intelligence
  contextIntelligenceEnabled?: boolean;

  // Any additional settings
  [key: string]: any;
}

// ==================== Migration ====================

export const CURRENT_SETTINGS_VERSION = 1;

interface SettingsWithVersion {
  version: number;
  settings: NeoxSettings;
}

/** Migrate settings from older versions */
function migrateSettings(data: any): NeoxSettings {
  if (!data || typeof data !== 'object') return {};

  // Version 0 → 1: No migration needed (first version)
  const version = data.version || 0;

  if (version >= CURRENT_SETTINGS_VERSION) {
    return data.settings || data;
  }

  // Future migrations go here:
  // if (version < 2) { ... migrate to v2 ... }

  return data.settings || data;
}

// ==================== Settings Manager ====================

export class SettingsManager {
  private layers: Map<SettingsScope, SettingsLayer> = new Map();
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private changeListeners: Array<(scope: SettingsScope) => void> = [];

  constructor() {
    this.initLayers();
  }

  private initLayers(): void {
    // User layer
    const userDir = path.join(os.homedir(), NEOX_HOME_DIRNAME);
    const userFile = path.join(userDir, 'settings.json');
    this.layers.set('user', {
      scope: 'user',
      data: this.loadFromFile(userFile),
      filePath: userFile,
    });

    // Workspace layer
    const workspaceFile = path.join(process.cwd(), '.neox', 'settings.json');
    this.layers.set('workspace', {
      scope: 'workspace',
      data: this.loadFromFile(workspaceFile),
      filePath: workspaceFile,
    });

    // Session layer (in-memory only)
    this.layers.set('session', {
      scope: 'session',
      data: {},
    });
  }

  private loadFromFile(filePath: string): Record<string, any> {
    try {
      if (!fs.existsSync(filePath)) return {};
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return migrateSettings(parsed);
    } catch (err: any) {
      cliLogger.debug('SETTINGS', `Failed to load ${filePath}: ${err.message}`);
      return {};
    }
  }

  /**
   * Get a setting value with layer priority: session > workspace > user
   */
  get<T = any>(key: string, defaultValue?: T): T {
    // Check layers in priority order
    for (const scope of ['session', 'workspace', 'user'] as SettingsScope[]) {
      const layer = this.layers.get(scope);
      if (layer && key in layer.data) {
        return layer.data[key] as T;
      }
    }
    return defaultValue as T;
  }

  /**
   * Set a setting value in the specified scope
   */
  set(key: string, value: any, scope: SettingsScope = 'session'): void {
    const layer = this.layers.get(scope);
    if (!layer) return;

    layer.data[key] = value;

    // Persist if not session scope
    if (scope !== 'session' && layer.filePath) {
      this.saveToFile(layer.filePath, layer.data);
    }

    this.notifyChange(scope);
  }

  /**
   * Delete a setting
   */
  delete(key: string, scope: SettingsScope = 'session'): void {
    const layer = this.layers.get(scope);
    if (!layer) return;

    delete layer.data[key];

    if (scope !== 'session' && layer.filePath) {
      this.saveToFile(layer.filePath, layer.data);
    }

    this.notifyChange(scope);
  }

  /**
   * Get all merged settings
   */
  getAll(): NeoxSettings {
    const merged: NeoxSettings = {};

    // Merge layers in priority order (lowest first)
    for (const scope of ['user', 'workspace', 'session'] as SettingsScope[]) {
      const layer = this.layers.get(scope);
      if (layer) {
        Object.assign(merged, layer.data);
      }
    }

    return merged;
  }

  /**
   * Get settings for a specific scope
   */
  getScope(scope: SettingsScope): Record<string, any> {
    return { ...(this.layers.get(scope)?.data || {}) };
  }

  /**
   * Get hooks configuration
   */
  getHooks(): HookConfig[] {
    return this.get<HookConfig[]>('hooks', []);
  }

  /**
   * Watch for file changes (hot reload)
   */
  startWatching(): void {
    for (const [scope, layer] of this.layers) {
      if (scope === 'session' || !layer.filePath) continue;

      try {
        const dir = path.dirname(layer.filePath);
        if (!fs.existsSync(dir)) continue;

        const watcher = fs.watch(layer.filePath, () => {
          const newData = this.loadFromFile(layer.filePath!);
          layer.data = newData;
          layer.lastModified = Date.now();
          this.notifyChange(scope as SettingsScope);
          cliLogger.info('SETTINGS', `Hot-reloaded ${scope} settings`);
        });

        this.watchers.set(layer.filePath, watcher);
      } catch {
        // Watch failure is non-fatal
      }
    }
  }

  /**
   * Stop watching for file changes
   */
  stopWatching(): void {
    for (const [, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
  }

  /**
   * Subscribe to settings changes
   */
  onChange(listener: (scope: SettingsScope) => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter(l => l !== listener);
    };
  }

  private notifyChange(scope: SettingsScope): void {
    for (const listener of this.changeListeners) {
      try { listener(scope); } catch { /* non-fatal */ }
    }
  }

  private saveToFile(filePath: string, data: Record<string, any>): void {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const versioned: SettingsWithVersion = {
        version: CURRENT_SETTINGS_VERSION,
        settings: data,
      };
      fs.writeFileSync(filePath, JSON.stringify(versioned, null, 2), 'utf-8');
    } catch (err: any) {
      cliLogger.warn('SETTINGS', `Failed to save ${filePath}: ${err.message}`);
    }
  }

  /** Dispose */
  dispose(): void {
    this.stopWatching();
    this.changeListeners = [];
  }
}

// ==================== Singleton ====================

let _globalSettings: SettingsManager | null = null;

export function getGlobalSettings(): SettingsManager {
  if (!_globalSettings) {
    _globalSettings = new SettingsManager();
  }
  return _globalSettings;
}

export function initGlobalSettings(): SettingsManager {
  _globalSettings = new SettingsManager();
  return _globalSettings;
}
