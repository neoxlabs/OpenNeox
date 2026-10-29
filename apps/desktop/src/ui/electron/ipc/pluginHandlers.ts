/**
 * Plugin IPC Handlers — Electron 主进程处理插件请求
 *
 * 本地管理 (列表 / 安装 / 启停 / 连接器 / 视图) 在这里。插件市场是发行版能力:
 * 官方市场的 IPC 与 marketplace 安装来源由主进程发行版入口 (../mainEdition.ts) 注册,
 * 这里只通过 pluginInstallSources 按来源名找实现, 不 import 任何市场模块。
 */

import { ipcMain, BrowserWindow, dialog } from 'electron';
import { PLUGIN_IPC_CHANNELS } from '@neoxlabs/platform/shared/ipc/plugin.js';
import { pluginViewRegistry } from '../../../plugins/pluginViewRegistry.js';
import { getPluginInstallSource } from '../../../plugins/pluginInstallSources.js';
import { registerOpenMarketplaceIpcHandlers } from './openMarketplaceHandlers.js';
import { spawn } from 'child_process';
import * as nodePath from 'path';
import * as nodeFs from 'fs/promises';
import type { PluginConnectorSummary } from '@neoxlabs/platform/shared/ipc/plugin.js';
import { summarizeComponents, summarizeConnectorPermissions, summarizePermissions } from '../../../plugins/permissionSummary.js';

async function activatePluginBestEffort(plugin: any): Promise<void> {
  if (!plugin?.enabled || !plugin?.installPath) return;
  try {
    const { activatePluginRuntime } = await import('../../../plugins/pluginIntegration.js');
    const result = await activatePluginRuntime(plugin);
    if (!result.success) {
      console.warn('[PLUGIN] activate errors:', plugin?.name, result.errors);
    }
  } catch (err: any) {
    console.warn('[PLUGIN] activate failed:', plugin?.name, err?.message ?? err);
  }
}

async function deactivatePluginBestEffort(name: string): Promise<void> {
  try {
    const { disablePluginRuntime } = await import('../../../plugins/pluginIntegration.js');
    disablePluginRuntime(name);
  } catch (err: any) {
    console.warn('[PLUGIN] deactivate failed:', name, err?.message ?? err);
  }
}

// ============================================================================
// LIST 结果缓存 —— 避免 settings 页面反复磁盘扫描
// 2s TTL + 写操作立即失效, 设置页每次打开/刷新几乎都能命中
// ============================================================================
const LIST_CACHE_TTL_MS = 2000;
type PluginListResult = {
  plugins: any[];
  stats: { total: number; enabled: number; disabled: number };
};
let _listCache: { at: number; value: PluginListResult } | null = null;
let _listInflight: Promise<PluginListResult> | null = null;
function invalidatePluginListCache(): void {
  _listCache = null;
}

/** 发行版注册的插件 IPC (官方市场的安装入口) 复用的两件事: 列表缓存失效 + 装完立即激活。 */
export const pluginIpcHost = { invalidatePluginListCache, activatePluginBestEffort };

// ============================================================================
// 权限 / 组件 摘要 — 用于 preflight 给 UI 展示安装前风险
// ============================================================================
// 实现在 plugins/permissionSummary.ts (纯函数, 可单测)

/**
 * 注册所有插件 IPC handlers
 */
export function registerPluginIpcHandlers(): void {
  /* GitHub 源市场 (marketplace:*), 两个发行版都有; 官方市场由发行版入口另行注册 */
  registerOpenMarketplaceIpcHandlers(pluginIpcHost);

  // ============================================================================
  // Management — 本地操作，延迟 import
  // ============================================================================

  async function collectPluginList(): Promise<PluginListResult> {
    const plugins: any[] = [];
    const seenNames = new Set<string>();

    // 1. 从 pluginRegistry 读取
    try {
      const mod = await import('../../../plugins/pluginRegistry.js');
      await mod.pluginRegistry.load();
      for (const p of mod.pluginRegistry.getAll()) {
        plugins.push(p);
        seenNames.add(p.name);
      }
    } catch { /* registry not available */ }


    const enabled = plugins.filter(p => p.enabled !== false).length;
    return {
      plugins,
      stats: { total: plugins.length, enabled, disabled: plugins.length - enabled },
    };
  }

  ipcMain.handle(PLUGIN_IPC_CHANNELS.LIST, async () => {
    const now = Date.now();
    if (_listCache && now - _listCache.at < LIST_CACHE_TTL_MS) {
      return _listCache.value;
    }
    // 并发请求合流 —— 同一时间只会有一次磁盘扫描
    if (_listInflight) return _listInflight;
    _listInflight = (async () => {
      try {
        const value = await collectPluginList();
        _listCache = { at: Date.now(), value };
        return value;
      } finally {
        _listInflight = null;
      }
    })();
    return _listInflight;
  });

  ipcMain.handle(PLUGIN_IPC_CHANNELS.INSTALL, async (_event, request: { nameOrPath: string; source: string }) => {
    try {
      const mod = await import('../../../plugins/pluginManager.js');
      let result: any;
      if (request.source === 'local') {
        result = await mod.installFromPath(request.nameOrPath);
      } else if (request.source === 'url') {
        result = await mod.installFromUrl(request.nameOrPath);
      } else if (request.source === 'package') {
        /* .neox-plugin — 逐文件哈希 + 可选签名校验后再落盘 */
        const { installFromFile } = await import('../../../plugins/pluginPackager.js');
        result = await installFromFile(request.nameOrPath);
      } else {
        /* 其余来源 (官方市场 = 'marketplace') 由发行版注册; 没注册就是这个构建不支持 */
        const source = getPluginInstallSource(request.source);
        if (!source) {
          return { success: false, errors: [`Unknown source: ${request.source}`], warnings: [] };
        }
        result = await source.install(request.nameOrPath);
      }
      invalidatePluginListCache();
      if (result?.success && result.plugin) {
        await activatePluginBestEffort(result.plugin);
      }
      return result;
    } catch (err: any) {
      return { success: false, errors: [err.message], warnings: [] };
    }
  });

  ipcMain.handle(PLUGIN_IPC_CHANNELS.UNINSTALL, async (_event, name: string) => {
    try {
      await deactivatePluginBestEffort(name);
      const mod = await import('../../../plugins/pluginManager.js');
      const result = await mod.uninstallPlugin(name);
      invalidatePluginListCache();
      return result;
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(PLUGIN_IPC_CHANNELS.ENABLE, async (_event, name: string) => {
    try {
      const mod = await import('../../../plugins/pluginManager.js');
      const result = await mod.enablePlugin(name);
      invalidatePluginListCache();
      if (result?.success) {
        const { pluginRegistry } = await import('../../../plugins/pluginRegistry.js');
        await pluginRegistry.load();
        const plugin = pluginRegistry.get(name);
        if (plugin) await activatePluginBestEffort(plugin);
      }
      return result;
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(PLUGIN_IPC_CHANNELS.DISABLE, async (_event, name: string) => {
    try {
      await deactivatePluginBestEffort(name);
      const mod = await import('../../../plugins/pluginManager.js');
      const result = await mod.disablePlugin(name);
      invalidatePluginListCache();
      return result;
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(PLUGIN_IPC_CHANNELS.INFO, async (_event, name: string) => {
    try {
      const mod = await import('../../../plugins/pluginManager.js');
      return await mod.getPluginInfo(name);
    } catch {
      return null;
    }
  });

  ipcMain.handle(PLUGIN_IPC_CHANNELS.CONFIG_GET, async (_event, name: string) => {
    try {
      const mod = await import('../../../plugins/pluginRegistry.js');
      return await mod.pluginRegistry.getUserConfig(name);
    } catch {
      return {};
    }
  });

  ipcMain.handle(PLUGIN_IPC_CHANNELS.CONFIG_SET, async (_event, name: string, config: Record<string, any>) => {
    try {
      const mod = await import('../../../plugins/pluginRegistry.js');
      await mod.pluginRegistry.saveUserConfig(name, config);
      return { success: true };
    } catch {
      return { success: false };
    }
  });

  // ============================================================================
  // Scaffold — 创建插件模板工程
  // ============================================================================

  ipcMain.handle(PLUGIN_IPC_CHANNELS.SCAFFOLD, async (_event, options: {
    name: string;
    template?: 'basic' | 'tool' | 'skill' | 'ui-view';
    targetDir?: string;
    author?: string;
    description?: string;
    force?: boolean;
  }) => {
    try {
      const { scaffoldPlugin } = await import('../../../plugins/pluginScaffold.js');
      return await scaffoldPlugin(options);
    } catch (err: any) {
      return { success: false, created: [], pluginDir: '', error: err?.message };
    }
  });

  // ============================================================================
  // Preflight — 安装前权限摘要 (给 UI 弹权限确认对话框用)
  // ============================================================================

  ipcMain.handle(PLUGIN_IPC_CHANNELS.PREFLIGHT_PERMISSIONS, async (_event, request: {
    source: 'local' | 'url' | 'marketplace' | 'package';
    nameOrPath: string;
    lang?: 'zh' | 'en';
  }) => {
    try {
      // 轻量级预读 manifest 而不真正安装.
      // 对于发行版注册的来源 (marketplace), 由来源自己读清单 (官方市场 = 从 registry fetch).
      // 对于 local, 直接读 plugin.json.
      // 对于 url, 暂不支持预读 (需要下载; 安装前跳过预读).
      let manifest: any = null;
      if (request.source === 'local') {
        const { loadManifest } = await import('../../../plugins/pluginLoader.js');
        manifest = await loadManifest(request.nameOrPath);
      } else if (request.source === 'package') {
        /* .neox-plugin: 解到临时目录只为读清单, 真正的完整性校验在安装那一步 */
        const os = await import('os');
        const tmp = await nodeFs.mkdtemp(nodePath.join(os.tmpdir(), 'neox-plugin-preflight-'));
        try {
          await new Promise<void>((resolve, reject) => {
            const child = spawn('tar', ['-xzf', request.nameOrPath, '-C', tmp], { stdio: 'ignore' });
            child.on('error', reject);
            child.on('close', code => code === 0 ? resolve() : reject(new Error(`tar exit ${code}`)));
          });
          const { loadManifest } = await import('../../../plugins/pluginLoader.js');
          const entries = await nodeFs.readdir(tmp, { withFileTypes: true });
          for (const e of entries) {
            if (!e.isDirectory()) continue;
            manifest = await loadManifest(nodePath.join(tmp, e.name));
            if (manifest) break;
          }
        } finally {
          await nodeFs.rm(tmp, { recursive: true, force: true }).catch(() => {});
        }
      } else if (request.source !== 'url') {
        manifest = await getPluginInstallSource(request.source)?.readManifest(request.nameOrPath) ?? null;
      }
      if (!manifest) return { available: false, permissions: [] };
      return {
        available: true,
        manifest: {
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          author: manifest.author,
        },
        /* 带 sensitive 标记, 渲染端不再靠中文关键词 ('网络' / '写入') 猜哪条要标黄 */
        permissions: [
          ...summarizePermissions(manifest.permissions, request.lang === 'en' ? 'en' : 'zh'),
          ...summarizeConnectorPermissions(manifest, request.lang === 'en' ? 'en' : 'zh'),
        ],
        components: summarizeComponents(manifest, request.lang === 'en' ? 'en' : 'zh'),
      };
    } catch (err: any) {
      return { available: false, permissions: [], error: err?.message };
    }
  });

  // ============================================================================
  // Pick install source — 让用户选本地文件夹 or .tar.gz 文件, 返回适合的 source 类型
  // ============================================================================

  ipcMain.handle(PLUGIN_IPC_CHANNELS.PICK_INSTALL_SOURCE, async (_event, options?: {
    title?: string;
    buttonLabel?: string;
  }) => {
    try {
      const result = await dialog.showOpenDialog({
        title: options?.title || 'Install plugin',
        buttonLabel: options?.buttonLabel || 'Install',
        properties: ['openFile', 'openDirectory'],
        filters: [
          { name: 'Neox plugin', extensions: ['neox-plugin'] },
          { name: 'Plugin archive', extensions: ['tar.gz', 'tgz', 'tar'] },
          { name: 'All', extensions: ['*'] },
        ],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false };
      }
      const picked = result.filePaths[0];
      const stat = await nodeFs.stat(picked).catch(() => null);
      if (!stat) return { ok: false, error: 'Path not accessible' };
      if (stat.isDirectory()) {
        return { ok: true, pathOrUrl: picked, source: 'local' };
      }
      // .neox-plugin → 走带完整性校验的导入路径 (逐文件哈希 + 可选签名)
      if (/\.neox-plugin$/i.test(picked)) {
        return { ok: true, pathOrUrl: picked, source: 'package' };
      }
      // tarball 文件 → 先解压到 temp dir, 再当普通 local 目录安装
      if (/\.(tar\.gz|tgz|tar)$/i.test(picked)) {
        const os = await import('os');
        const tmpRoot = await nodeFs.mkdtemp(nodePath.join(os.tmpdir(), 'neox-plugin-import-'));
        await new Promise<void>((resolve, reject) => {
          const child = spawn('tar', ['-xzf', picked, '-C', tmpRoot], { stdio: 'ignore' });
          child.on('error', reject);
          child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar extract exit ${code}`)));
        });
        // 找到真正含 plugin.json 的目录 (最多 2 层深)
        async function findRoot(dir: string, depth = 0): Promise<string | null> {
          try { await nodeFs.access(nodePath.join(dir, 'plugin.json')); return dir; } catch { /* continue */ }
          if (depth >= 2) return null;
          const entries = await nodeFs.readdir(dir, { withFileTypes: true }).catch(() => []);
          for (const e of entries) {
            if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const found = await findRoot(nodePath.join(dir, e.name), depth + 1);
            if (found) return found;
          }
          return null;
        }
        const root = await findRoot(tmpRoot);
        if (!root) return { ok: false, error: 'No plugin.json found in archive' };
        return { ok: true, pathOrUrl: root, source: 'local' };
      }
      return { ok: false, error: 'Unsupported file type' };
    } catch (err: any) {
      return { ok: false, error: err?.message };
    }
  });

  // ============================================================================
  // Export — 把已装插件打包成 .tar.gz, 弹 showSaveDialog 选落地位置
  // ============================================================================

  ipcMain.handle(PLUGIN_IPC_CHANNELS.EXPORT, async (_event, pluginName: string) => {
    try {
      const { pluginRegistry } = await import('../../../plugins/pluginRegistry.js');
      await pluginRegistry.load();
      const plugin = pluginRegistry.get(pluginName);
      if (!plugin) return { success: false, error: `Plugin "${pluginName}" not found` };

      const result = await dialog.showSaveDialog({
        title: `Export ${pluginName}`,
        defaultPath: `${pluginName}-${plugin.version || '0.0.0'}.neox-plugin`,
        filters: [{ name: 'Neox plugin', extensions: ['neox-plugin'] }],
      });
      if (result.canceled || !result.filePath) return { success: false };

      /* 走 packPlugin 而不是裸 tar: 包里要带逐文件哈希清单, 导入端才有东西可校验。
       * 裸 tar 导出的包在对面只能「解开就装」, 完整性无从谈起。 */
      const { packPlugin } = await import('../../../plugins/pluginPackager.js');
      const packed = await packPlugin(plugin.installPath, { outFile: result.filePath });

      return { success: true, filePath: packed.outFile, fileCount: packed.fileCount, bytes: packed.bytes };
    } catch (err: any) {
      return { success: false, error: err?.message };
    }
  });

  // ============================================================================
  // Connector — 凭据 / 授权 / 连通性
  //
  //    渲染进程没有任何需要看到 token 的场景, 让它能看到就是白送一个泄漏面。
  // ============================================================================

  ipcMain.handle(PLUGIN_IPC_CHANNELS.CONNECTOR_LIST, async (_event, request?: { lang?: 'zh' | 'en' }) => {
    const { connectorRegistry } = await import('../../../plugins/connector/connectorRegistry.js');
    const { hasCredential, getConnection } = await import('../../../plugins/connector/credentialStore.js');
    const { getGrants, getBudgetState } = await import('../../../plugins/connector/grantStore.js');
    const { localized: localizedAny } = await import('@neoxlabs/platform/shared/plugin-connector.js');
    /* 按界面语言挑文案 —— 不传 lang 时 localized 默认中文, 英文界面里说明和权限理由整块是中文 */
    const lang = request?.lang === 'en' ? 'en' : 'zh';
    const localized = (t: Parameters<typeof localizedAny>[0]) => localizedAny(t, lang);
    const { pluginRegistry } = await import('../../../plugins/pluginRegistry.js');
    await pluginRegistry.load();

    const out: PluginConnectorSummary[] = [];
    for (const entry of connectorRegistry.list()) {
      const { connector, pluginName } = entry;
      const granted = new Set(getGrants(pluginName));
      out.push({
        pluginName,
        namespace: connector.namespace,
        displayName: localized(connector.displayName) || pluginName,
        enabled: pluginRegistry.get(pluginName)?.enabled ?? false,
        connected: await hasCredential(pluginName),
        authKind: connector.auth.kind,
        authInstructions:
          connector.auth.kind === 'token' ? localized(connector.auth.instructions) : undefined,
        permissions: connector.permissions.map(p => ({
          capability: p.capability,
          effect: p.effect,
          reason: localized(p.reason),
          granted: granted.has(p.capability),
          approxUsd: p.cost?.approxUsd,
        })),
        tools: entry.tools.map(t => t.name),
        connectionFields: (connector.connectionFields ?? []).map(f => ({
          key: f.key,
          label: localized(f.label),
          required: f.required ?? false,
          placeholder: f.placeholder,
        })),
        connection: await getConnection(pluginName),
        budget: getBudgetState(pluginName),
      });
    }
    return out;
  });

  ipcMain.handle(PLUGIN_IPC_CHANNELS.CONNECTOR_CONNECT, async (_event, request: {
    pluginName: string;
    token?: string;
    connection?: Record<string, unknown>;
  }) => {
    try {
      const { connectorRegistry } = await import('../../../plugins/connector/connectorRegistry.js');
      const { saveCredential, setConnection } = await import('../../../plugins/connector/credentialStore.js');
      const entry = connectorRegistry.get(request?.pluginName);
      if (!entry) return { success: false, error: `未找到已启用的连接器: ${request?.pluginName}` };

      const authKind = entry.connector.auth.kind;
      if (authKind === 'token') {
        const token = request?.token?.trim();
        if (!token) return { success: false, error: '请填写访问令牌' };
        await saveCredential(request.pluginName, { kind: 'token', token });
      } else if (authKind === 'none') {
        await saveCredential(request.pluginName, { kind: 'none' });
      } else {
        /* OAuth 授权码流程要起本地回调服务, 归 oauthFlow 那条线管;
         * 这里明确报错而不是假装成功 —— 静默失败会让用户以为已连上。 */
        return { success: false, error: 'OAuth 连接器请走授权登录入口，暂不支持直接粘贴令牌' };
      }

      if (request?.connection) {
        await setConnection(request.pluginName, request.connection);
      }
      /* 第一次连上还没勾能力 = 装了不能用。默认授予清单里声明的全部能力,
       * 用户仍可在卡片上逐条关掉。 */
      const { getGrants, setGrants } = await import('../../../plugins/connector/grantStore.js');
      if (getGrants(request.pluginName).length === 0) {
        setGrants(request.pluginName, entry.connector.permissions.map(p => p.capability));
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message };
    }
  });

  ipcMain.handle(PLUGIN_IPC_CHANNELS.CONNECTOR_DISCONNECT, async (_event, pluginName: string) => {
    try {
      const { deleteCredential, clearConnection } = await import('../../../plugins/connector/credentialStore.js');
      const { revokeGrants } = await import('../../../plugins/connector/grantStore.js');
      await deleteCredential(pluginName);
      await clearConnection(pluginName);
      /* 断开连接连授权一起清: 留着旧 grant, 下次接上另一个账号会直接沿用 */
      revokeGrants(pluginName);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message };
    }
  });

  ipcMain.handle(PLUGIN_IPC_CHANNELS.CONNECTOR_SET_GRANTS, async (_event, request: {
    pluginName: string;
    capabilities: string[];
    budgetUsd?: number;
  }) => {
    try {
      const { connectorRegistry } = await import('../../../plugins/connector/connectorRegistry.js');
      const { setGrants } = await import('../../../plugins/connector/grantStore.js');
      const entry = connectorRegistry.get(request?.pluginName);
      if (!entry) return { success: false, error: `未找到已启用的连接器: ${request?.pluginName}` };

      /* 只接受清单里声明过的能力 —— 渲染进程传什么都不能凭空造出授权 */
      const declared = new Set(entry.connector.permissions.map(p => p.capability));
      const unknown = (request?.capabilities ?? []).filter(c => !declared.has(c as any));
      if (unknown.length > 0) {
        return { success: false, error: `这些能力不在插件声明中: ${unknown.join(', ')}` };
      }

      setGrants(request.pluginName, request.capabilities as any, { budgetUsd: request?.budgetUsd });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message };
    }
  });

  ipcMain.handle(PLUGIN_IPC_CHANNELS.CONNECTOR_TEST, async (_event, request: {
    pluginName: string;
    capability: string;
    input?: Record<string, unknown>;
  }) => {
    try {
      const { connectorRegistry } = await import('../../../plugins/connector/connectorRegistry.js');
      const entry = connectorRegistry.get(request?.pluginName);
      let capability = request?.capability as any;
      const hasExplicitInput = !!request?.input && Object.keys(request.input).length > 0;
      let synthesized: Record<string, unknown> | undefined;
      if (entry && capability && !hasExplicitInput) {
        const { getGrants } = await import('../../../plugins/connector/grantStore.js');
        const { pickSelfTestProbe } = await import('../../../plugins/connector/selfTestProbe.js');
        const probe = pickSelfTestProbe(entry.connector, new Set(getGrants(request.pluginName)), capability);
        if (probe.kind === 'none') {
          return {
            success: false,
            code: 'no_probe',
            error: '这个连接器没有可自动探测的只读能力 —— 直接让 Agent 调用它的工具试一次即可。',
          };
        }
        capability = probe.capability;
        if (probe.placeholder) synthesized = probe.input;
      }
      const result = await connectorRegistry.invoke(
        request?.pluginName,
        capability as any,
        /* 渲染端会传空对象 input: {} —— 用 ?? 的话它会盖掉占位参数 */
        hasExplicitInput ? request.input! : (synthesized ?? {}),
      );
      /* 用占位参数探测时, 结果内容没意义, 只看凭据被不被接受 */
      if (synthesized && !result.ok) {
        const authFailed = result.status === 401 || result.status === 403;
        return authFailed
          ? { success: false, code: 'unauthorized', error: `凭据被拒绝 (HTTP ${result.status}) —— 令牌可能无效或没有权限。` }
          : { success: true, status: result.status, preview: `凭据可用 (HTTP ${result.status}; 探测用的是占位参数, 返回内容本身无意义)` };
      }
      if (result.ok) {
        const preview = typeof result.data === 'string'
          ? result.data.slice(0, 2000)
          : JSON.stringify(result.data ?? null).slice(0, 2000);
        return { success: true, status: result.status, preview };
      }
      return { success: false, code: result.code, error: result.message };
    } catch (err: any) {
      return { success: false, error: err?.message };
    }
  });

  ipcMain.handle(PLUGIN_IPC_CHANNELS.CONNECTOR_OAUTH, async (_event, request: {
    pluginName: string;
    connection?: Record<string, unknown>;
  }) => {
    try {
      const { connectorRegistry } = await import('../../../plugins/connector/connectorRegistry.js');
      const { saveCredential, setConnection, getConnection } = await import('../../../plugins/connector/credentialStore.js');
      const { startConnectorOAuth } = await import('../../../plugins/connector/oauth.js');
      const { getGrants, setGrants } = await import('../../../plugins/connector/grantStore.js');
      const entry = connectorRegistry.get(request?.pluginName);
      if (!entry) return { success: false, error: `未找到已启用的连接器: ${request?.pluginName}` };
      if (entry.connector.auth.kind !== 'oauth2') {
        return { success: false, error: '这个连接器不是 OAuth, 请粘贴令牌。' };
      }
      if (request?.connection) {
        await setConnection(request.pluginName, request.connection);
      }
      const connection = await getConnection(request.pluginName);
      const tokens = await startConnectorOAuth({
        pluginName: request.pluginName,
        auth: entry.connector.auth,
        connection,
      });
      await saveCredential(request.pluginName, {
        kind: 'oauth2',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      });
      if (getGrants(request.pluginName).length === 0) {
        setGrants(request.pluginName, entry.connector.permissions.map(p => p.capability));
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message };
    }
  });

  // ============================================================================
  // External Agents — 委派给本机其它 agent CLI
  // ============================================================================

  ipcMain.handle(PLUGIN_IPC_CHANNELS.EXTERNAL_AGENT_LIST, async () => {
    const { externalAgentRegistry } = await import('../../../plugins/externalAgent/externalAgentRegistry.js');
    /* status() 会去 spawn `--version` 探测, 结果在 runner 里缓存 5 分钟,
     * 所以设置页反复打开不会反复起进程 */
    return externalAgentRegistry.status();
  });

  // ============================================================================
  // UI Views — 插件贡献的 iframe 面板
  // ============================================================================

  ipcMain.handle(PLUGIN_IPC_CHANNELS.LIST_VIEWS, async () => {
    return pluginViewRegistry.serialize();
  });

  // 注册一次变更广播, 重复调用 registerPluginIpcHandlers 不应叠加监听.
  if (!(globalThis as any).__neox_plugin_view_change_subscribed) {
    (globalThis as any).__neox_plugin_view_change_subscribed = true;
    pluginViewRegistry.onChange(() => {
      const payload = pluginViewRegistry.serialize();
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          win.webContents.send(PLUGIN_IPC_CHANNELS.VIEWS_CHANGED, payload);
        } catch { /* window 已关闭 */ }
      }
    });
  }


  console.log('[PLUGIN_IPC] Plugin IPC handlers registered');
}

/** App 启动时加载已启用插件 (views / auth / tools…). */
export async function bootstrapDesktopPlugins(): Promise<void> {
  try {
    const { bootstrapPlugins } = await import('../../../plugins/pluginIntegration.js');
    await bootstrapPlugins();
  } catch (err: any) {
    console.warn('[PLUGIN] bootstrap failed:', err?.message ?? err);
  }
}
