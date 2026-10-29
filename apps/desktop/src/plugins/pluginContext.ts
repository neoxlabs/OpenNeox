/**
 * PluginContext — 插件运行时上下文
 *
 * 插件的 `createTools()` / `activate()` 收到这个对象, 用它访问:
 *   - dataDir: 插件独享可读写目录 (~/.neox/plugins/data/<name>/), 不跟 install 目录混
 *   - workspacePath: 当前 Neox 打开的 workspace (如存在)
 *   - logger: 日志 (带 [pluginName] 前缀)
 *   - permissions: manifest 声明的权限 (只读副本)
 *   - userConfig: 用户给插件设置的 userConfig 值
 *   - io: 受权限限制的文件 IO (只允许 permissions.filesystem.read/write 下路径)
 *
 * 不提供 LLM 直接访问: 插件要调 LLM, 走注册 Tool 让主 agent 调度, 或自己处理
 * API key 走 userConfig + 明确声明 network 权限.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { PluginManifest, PluginPermissions } from '@neoxlabs/platform/shared/plugin-types.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

// ==================== 类型 ====================

export interface PluginLogger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface PluginFileIO {
  /** 读文件 — 路径必须在 permissions.filesystem.read 范围内 */
  read(filePath: string): Promise<string>;
  /** 写文件 — 路径必须在 permissions.filesystem.write 范围内 */
  write(filePath: string, content: string): Promise<void>;
  /** 读插件 dataDir 下的相对路径 (无需权限) */
  readData(relPath: string): Promise<string>;
  /** 写插件 dataDir 下的相对路径 (无需权限) */
  writeData(relPath: string, content: string): Promise<void>;
}

export interface PluginContext {
  /** 插件 manifest.name */
  pluginName: string;
  /** 插件版本 */
  version: string;
  /** 插件安装目录 (只读, 不应往里写) */
  installDir: string;
  /** 插件独享数据目录 ~/.neox/plugins/data/<name>/ */
  dataDir: string;
  /** 当前 workspace (如可用) */
  workspacePath?: string;
  /** 权限声明 (只读副本) */
  permissions: Readonly<PluginPermissions>;
  /** 用户配置 */
  userConfig: Readonly<Record<string, any>>;
  /** 日志 */
  logger: PluginLogger;
  /** 受权限保护的文件 IO */
  io: PluginFileIO;
}

// ==================== 实现 ====================

function makeLogger(pluginName: string): PluginLogger {
  return {
    debug: (msg) => cliLogger.debug('PLUGIN', `[${pluginName}] ${msg}`),
    info: (msg) => cliLogger.info('PLUGIN', `[${pluginName}] ${msg}`),
    warn: (msg) => cliLogger.warn('PLUGIN', `[${pluginName}] ${msg}`),
    error: (msg) => cliLogger.error('PLUGIN', `[${pluginName}] ${msg}`),
  };
}

function matchesPathAllowlist(allowed: string[] | undefined, filePath: string): boolean {
  if (!allowed || allowed.length === 0) return false;
  const abs = path.resolve(filePath);
  return allowed.some(pattern => {
    const base = path.resolve(pattern);
    const rel = path.relative(base, abs);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

function makeIO(opts: {
  pluginName: string;
  dataDir: string;
  permissions: PluginPermissions;
}): PluginFileIO {
  const { pluginName, dataDir, permissions } = opts;

  return {
    async read(filePath: string): Promise<string> {
      if (!matchesPathAllowlist(permissions.filesystem?.read, filePath)
        && !matchesPathAllowlist(permissions.filesystem?.write, filePath)) {
        throw new Error(`[${pluginName}] filesystem.read permission denied: ${filePath}`);
      }
      return fs.readFile(filePath, 'utf-8');
    },
    async write(filePath: string, content: string): Promise<void> {
      if (!matchesPathAllowlist(permissions.filesystem?.write, filePath)) {
        throw new Error(`[${pluginName}] filesystem.write permission denied: ${filePath}`);
      }
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      return fs.writeFile(filePath, content, 'utf-8');
    },
    async readData(relPath: string): Promise<string> {
      const full = path.resolve(dataDir, relPath);
      if (!full.startsWith(dataDir)) {
        throw new Error(`[${pluginName}] dataDir path traversal blocked: ${relPath}`);
      }
      return fs.readFile(full, 'utf-8');
    },
    async writeData(relPath: string, content: string): Promise<void> {
      const full = path.resolve(dataDir, relPath);
      if (!full.startsWith(dataDir)) {
        throw new Error(`[${pluginName}] dataDir path traversal blocked: ${relPath}`);
      }
      await fs.mkdir(path.dirname(full), { recursive: true });
      return fs.writeFile(full, content, 'utf-8');
    },
  };
}

export function createPluginContext(opts: {
  manifest: PluginManifest;
  installDir: string;
  workspacePath?: string;
  userConfig?: Record<string, any>;
}): PluginContext {
  const pluginName = opts.manifest.name;
  const dataDir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'plugins', 'data', pluginName);
  if (!fsSync.existsSync(dataDir)) {
    fsSync.mkdirSync(dataDir, { recursive: true });
  }
  const permissions: PluginPermissions = opts.manifest.permissions ?? {};
  const userConfig = Object.freeze({ ...(opts.userConfig ?? {}) });

  return {
    pluginName,
    version: opts.manifest.version,
    installDir: opts.installDir,
    dataDir,
    workspacePath: opts.workspacePath,
    permissions: Object.freeze({ ...permissions }),
    userConfig,
    logger: makeLogger(pluginName),
    io: makeIO({ pluginName, dataDir, permissions }),
  };
}
