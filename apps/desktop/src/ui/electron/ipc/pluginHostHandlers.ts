/**
 * Plugin Host IPC — 插件 iframe 通过 postMessage → 渲染进程 → 主进程 访问受控 API.
 *
 * Channels (plugin:host:*):
 *   - getActiveFile                     → { path, content, language }
 *   - readPluginData(pluginName, rel)   → string (插件自己的 dataDir)
 *   - writePluginData(pluginName, rel)  → ok
 *   - readFile(pluginName, absPath)     → string  (需要 permissions.filesystem.read 覆盖)
 *   - writeFile(pluginName, absPath)    → ok      (需要 permissions.filesystem.write 覆盖)
 *   - invokeTool(pluginName, name, args)→ string  (需要 permissions.tools 白名单)
 *
 * 所有调用先从 pluginRegistry 查 manifest, 按 permissions 校验.
 */

import { ipcMain, BrowserWindow } from 'electron';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

// ==================== 权限 ====================

const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const PLUGIN_DATA_MAX_BYTES = 10 * 1024 * 1024;
const PLUGIN_REL_PATH_MAX_BYTES = 1024;
const PLUGIN_FILE_PATH_MAX_BYTES = 4096;
const PLUGIN_TOOL_NAME_MAX_BYTES = 128;

function normalizePluginName(pluginName: unknown): string {
  if (typeof pluginName !== 'string') {
    throw new Error('Invalid plugin name');
  }
  const name = pluginName.trim();
  if (name.length > 64 || !PLUGIN_NAME_PATTERN.test(name)) {
    throw new Error('Invalid plugin name');
  }
  return name;
}

async function loadPluginPermissions(pluginName: string): Promise<{
  manifest: any | null;
  installDir: string | null;
}> {
  try {
    const mod = await import('../../../plugins/pluginRegistry.js');
    await mod.pluginRegistry.load();
    const plugin = mod.pluginRegistry.get(pluginName);
    if (!plugin) return { manifest: null, installDir: null };
    let manifest = plugin.manifest;
    if (!manifest) {
      const loader = await import('../../../plugins/pluginLoader.js');
      manifest = await loader.loadManifest(plugin.installPath) ?? undefined;
    }
    return { manifest: manifest ?? null, installDir: plugin.installPath };
  } catch {
    return { manifest: null, installDir: null };
  }
}

async function requireInstalledPluginName(pluginName: unknown): Promise<string> {
  const name = normalizePluginName(pluginName);
  const { manifest, installDir } = await loadPluginPermissions(name);
  if (!manifest && !installDir) throw new Error(`Plugin "${name}" not found`);
  return name;
}

function pathInAllowlist(allowed: string[] | undefined, filePath: string): boolean {
  if (!allowed || allowed.length === 0) return false;
  const abs = path.resolve(filePath);
  return allowed.some(pattern => {
    const base = path.resolve(pattern);
    const rel = path.relative(base, abs);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

function dataDirFor(pluginName: string): string {
  return path.join(os.homedir(), NEOX_HOME_DIRNAME, 'plugins', 'data', pluginName);
}

function resolvePluginDataPath(pluginName: string, relPath: unknown): { base: string; full: string } {
  if (typeof relPath !== 'string') {
    throw new Error('Invalid data path');
  }
  if (Buffer.byteLength(relPath, 'utf8') > PLUGIN_REL_PATH_MAX_BYTES) {
    throw new Error('Data path too long');
  }
  const base = dataDirFor(pluginName);
  const full = path.resolve(base, relPath);
  /* path.relative + ".." 检查比 startsWith 严: 防 /base 跟 /base-other 这种前缀混淆,
   * 也防 Windows 混合分隔符的边界 case. */
  const rel = path.relative(base, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path traversal blocked');
  }
  return { base, full };
}

function normalizePluginFilePath(filePath: unknown): string {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('Invalid file path');
  }
  if (Buffer.byteLength(filePath, 'utf8') > PLUGIN_FILE_PATH_MAX_BYTES || /[\u0000]/.test(filePath)) {
    throw new Error('Invalid file path');
  }
  return filePath;
}

function normalizePluginToolName(toolName: unknown): string {
  if (typeof toolName !== 'string' || !toolName.trim()) {
    throw new Error('Invalid tool name');
  }
  if (Buffer.byteLength(toolName, 'utf8') > PLUGIN_TOOL_NAME_MAX_BYTES || /[\u0000-\u001f\u007f]/.test(toolName)) {
    throw new Error('Invalid tool name');
  }
  return toolName;
}

// ==================== 注册 ====================

export function registerPluginHostIpcHandlers(): void {

  // -------- getActiveFile --------
  ipcMain.handle('plugin:host:getActiveFile', async () => {
    // 主进程没有"活动文件"的概念; 由渲染进程自己提供. 这里保留接口兼容性,
    // 实际 UI 应该在发 postMessage 前由 PluginViewHost 直接从 EditorService
    // 状态读出. 本 handler 作为 fallback 返回空值.
    return { path: null, content: null, language: null };
  });

  // -------- readPluginData --------
  ipcMain.handle('plugin:host:readPluginData', async (_event, pluginName: string, relPath: string) => {
    const name = await requireInstalledPluginName(pluginName);
    const { full } = resolvePluginDataPath(name, relPath);
    return fs.readFile(full, 'utf-8');
  });

  // -------- writePluginData --------
  ipcMain.handle('plugin:host:writePluginData', async (_event, pluginName: string, relPath: string, content: string) => {
    if (typeof content !== 'string') {
      throw new Error('Invalid arguments');
    }
    if (Buffer.byteLength(content, 'utf8') > PLUGIN_DATA_MAX_BYTES) {
      throw new Error('Plugin data too large');
    }
    const name = await requireInstalledPluginName(pluginName);
    const { base, full } = resolvePluginDataPath(name, relPath);
    if (!fsSync.existsSync(base)) await fs.mkdir(base, { recursive: true });
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf-8');
    return { ok: true };
  });

  // -------- readFile (受 permissions.filesystem.read 约束) --------
  ipcMain.handle('plugin:host:readFile', async (_event, pluginName: string, filePath: string) => {
    const name = normalizePluginName(pluginName);
    const targetPath = normalizePluginFilePath(filePath);
    const { manifest } = await loadPluginPermissions(name);
    if (!manifest) throw new Error('Plugin not found');
    const perms = manifest.permissions ?? {};
    const readAllowed = perms.filesystem?.read;
    const writeAllowed = perms.filesystem?.write;
    if (!pathInAllowlist(readAllowed, targetPath) && !pathInAllowlist(writeAllowed, targetPath)) {
      throw new Error(`[${name}] filesystem.read permission denied: ${targetPath}`);
    }
    return fs.readFile(targetPath, 'utf-8');
  });

  // -------- writeFile (受 permissions.filesystem.write 约束) --------
  ipcMain.handle('plugin:host:writeFile', async (_event, pluginName: string, filePath: string, content: string) => {
    const name = normalizePluginName(pluginName);
    const targetPath = normalizePluginFilePath(filePath);
    if (typeof content !== 'string') throw new Error('Invalid content');
    if (Buffer.byteLength(content, 'utf8') > PLUGIN_DATA_MAX_BYTES) {
      throw new Error('Plugin write payload too large');
    }
    const { manifest } = await loadPluginPermissions(name);
    if (!manifest) throw new Error('Plugin not found');
    const perms = manifest.permissions ?? {};
    if (!pathInAllowlist(perms.filesystem?.write, targetPath)) {
      throw new Error(`[${name}] filesystem.write permission denied: ${targetPath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, 'utf-8');
    return { ok: true };
  });

  // -------- invokeTool (受 permissions.tools 白名单约束) --------
  ipcMain.handle('plugin:host:invokeTool', async (_event, pluginName: string, toolName: string, args: any) => {
    const name = normalizePluginName(pluginName);
    const requestedTool = normalizePluginToolName(toolName);
    const { manifest } = await loadPluginPermissions(name);
    if (!manifest) throw new Error('Plugin not found');
    const allowedTools: string[] | undefined = manifest.permissions?.tools;
    if (!allowedTools || !allowedTools.includes(requestedTool)) {
      throw new Error(`[${name}] tool "${requestedTool}" not declared in permissions.tools`);
    }

    // 查 toolPackRegistry 找到工具实例并调用
    const { toolPackRegistry } = await import('@neoxlabs/core/tools/packs/toolPack.js');
    const pack = toolPackRegistry.findPackForTool(requestedTool);
    if (!pack || !pack.createTools) {
      throw new Error(`Tool "${requestedTool}" not available`);
    }
    const tools = await pack.createTools();
    const tool = tools.find(t => t.name === requestedTool);
    if (!tool) throw new Error(`Tool "${requestedTool}" not found in pack ${pack.id}`);

    const result = await tool.function(args, { signal: undefined });
    return typeof result === 'string' ? result : JSON.stringify(result);
  });

  console.log('[PLUGIN_HOST_IPC] Plugin host IPC handlers registered');
}
