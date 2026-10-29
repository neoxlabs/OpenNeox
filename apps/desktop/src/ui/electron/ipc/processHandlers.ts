import { ipcMain } from './ipcMainBridged.js';
import { lazyElectron } from '../lazyElectron.js';
import type { IpcMainInvokeEvent } from 'electron';

/* electron 运行时取 —— 顶层静态 import 会让整个 bundle 在纯 Node 后端里加载失败,
 * 连累同包所有 handler (见 lazyElectron.ts)。ipcMain 走桥的替身。 */
const BrowserWindow = lazyElectron<typeof import('electron').BrowserWindow>('BrowserWindow');
import { processManager } from '@neoxlabs/platform/platform/processManager.js';
import { getServiceConfigStore } from '@neoxlabs/core/runtime/services/serviceConfigStoreCache.js';
import { attachAutoRestart } from '@neoxlabs/core/runtime/services/autoRestartManager.js';
import { makeOptionalBridgeResolver } from './scopeResolvers.js';
import type { ProjectManager } from '../context/ProjectManager.js';

/* P2-1: 全进程一次性订阅 ProcessManager 端口探测事件, 转 IPC 广播给所有 renderer.
 *   renderer 端 NeoxRuntimeBridge 收到 → 派 neox:open-surface CustomEvent → 开 web surface. */
function ensureAutoOpenBroadcast(): void {
  const g = globalThis as any;
  if (g.__neox_services_autoopen_subscribed) return;
  g.__neox_services_autoopen_subscribed = true;
  processManager.on('process:port-detected', (proc) => {
    if (!proc.configId || !proc.port) return;
    /* 找 ServiceConfig — 取所有 workspaceRoot 的 store, 哪个有这个 id 用哪个. */
    const stores = (g.__neox_service_config_stores ?? []) as string[];
    /* 我们没有 per-workspace 注册机制, 退一步: 直接读 proc.cwd 推断 workspaceRoot 用. */
    const workspaceRoot = proc.cwd;
    try {
      const store = getServiceConfigStore(workspaceRoot);
      const config = store.get(proc.configId);
      if (!config?.autoOpenSurface) return;
      const url = `http://localhost:${proc.port}`;
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          win.webContents.send('services:auto-open', {
            kind: 'web',
            source: { type: 'url', url },
            title: config.name || proc.configId,
            pinned: true,
          });
        } catch { /* window closing */ }
      }
    } catch { /* 找不到 config / store 读盘失败, 静默 */ }
  });
}

export function registerProcessIpcHandlers(opts: { projectManager: ProjectManager }): void {
  ensureAutoOpenBroadcast();
  /* P3-3: 全进程一次性挂崩溃自愈监听 */
  attachAutoRestart();
  const resolveOptionalBridge = makeOptionalBridgeResolver(opts.projectManager);

  const tasksCacheByWs = new Map<string, { data: any[]; at: number }>();
  const inflightByWs = new Map<string, Promise<any[] | null>>();
  const TASKS_CACHE_TTL_MS = 1500;

  ipcMain.handle('process:list', async (event: IpcMainInvokeEvent) => {
    const now = Date.now();
    const wsKey = opts.projectManager.getBySender(event?.sender as any)?.workspacePath ?? '__no_scope__';
    const cached = tasksCacheByWs.get(wsKey);
    if (cached && now - cached.at < TASKS_CACHE_TTL_MS) {
      return cached.data;
    }
    const pending = inflightByWs.get(wsKey);
    if (pending) return pending;

    const bridge = resolveOptionalBridge(event);
    const client = bridge?.getClient();
    if (client) {
      const inflight = (async () => {
        try {
          const tasks = await client.listBackgroundTasks();
          tasksCacheByWs.set(wsKey, { data: tasks, at: Date.now() });
          return tasks;
        } catch (err: any) {
          console.warn('[process:list] SDK 查 server 失败, 用上次 cache:', err?.message);
          const prev = tasksCacheByWs.get(wsKey);
          if (prev) return prev.data;
          return null; /* 触发下面本地 fallback */
        } finally {
          inflightByWs.delete(wsKey);
        }
      })();
      inflightByWs.set(wsKey, inflight);
      const r = await inflight;
      if (r !== null) return r;
    }
    return [];
  });

  /* P1-4: RunConfig 列表 — Services panel 左栏 Configured 区显示 */
  ipcMain.handle('service:list-configs', async (_event, workspaceRoot: string) => {
    try {
      const store = getServiceConfigStore(workspaceRoot);
      return { success: true, configs: store.list() };
    } catch (error: any) {
      return { success: false, configs: [], error: error.message };
    }
  });

  /* P1-4: upsert RunConfig — UI 上的"新建/编辑" 按钮调.
   *
   *   跨进程一致性: 配置文件本身在 workspace, 两边读到的盘内容最终一样, 但 cache 不一致
   *   会让 server 端 start/autoRestart 读到过时的 list. 优先走 SDK 让 server 当 truth source,
   *   server 不通时 fallback 本地写盘 (server 启动后会自己 invalidate 再读). */
  ipcMain.handle('service:upsert-config', async (event: IpcMainInvokeEvent, workspaceRoot: string, config: any) => {
    const bridge = resolveOptionalBridge(event);
    const client = bridge?.getClient();
    if (client) {
      try {
        const r = await client.upsertServiceConfig(workspaceRoot, config);
        return { success: r.ok, config: r.config, error: r.error };
      } catch (err: any) {
        console.warn('[service:upsert-config] SDK 失败, fallback 本地:', err?.message);
      }
    }
    try {
      const store = getServiceConfigStore(workspaceRoot);
      const final = store.upsert({ ...config, createdBy: config.createdBy || 'user' });
      return { success: true, config: final };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  /* P2-4: 扫 package.json / Procfile, 列出可导入为 RunConfig 的候选 */
  ipcMain.handle('service:scan-importable', async (_event, workspaceRoot: string) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const result: {
      packageJsonScripts: Array<{ name: string; command: string; suggestedId: string }>;
      procfile: Array<{ name: string; command: string; suggestedId: string }>;
    } = { packageJsonScripts: [], procfile: [] };
    try {
      const pkgPath = path.join(workspaceRoot, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const scripts: Record<string, string> | undefined = pkg?.scripts;
        if (scripts && typeof scripts === 'object') {
          const longRunningRe = /\b(dev|start|serve|watch|nodemon|hot)\b/i;
          for (const [name, cmd] of Object.entries(scripts)) {
            if (typeof cmd !== 'string') continue;
            if (!longRunningRe.test(name) && !longRunningRe.test(cmd)) continue;
            result.packageJsonScripts.push({
              name,
              command: `npm run ${name}`,
              suggestedId: name,
            });
          }
        }
      }
    } catch { /* skip */ }
    try {
      const procPath = path.join(workspaceRoot, 'Procfile');
      if (fs.existsSync(procPath)) {
        const raw = fs.readFileSync(procPath, 'utf-8');
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const m = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
          if (!m) continue;
          result.procfile.push({
            name: m[1],
            command: m[2].trim(),
            suggestedId: m[1],
          });
        }
      }
    } catch { /* skip */ }
    return result;
  });

  /* P2: 新版扫描 — 给 spec 模型用. 返回 RunConfigCandidate[], UI / agent 直接 upsert 即可.
   * 旧的 service:scan-importable 上面保留, 避免破坏老 UI 调用. */
  ipcMain.handle('service:scan-workspace', async (_event, workspaceRoot: string) => {
    try {
      const { scanWorkspace } = await import('@neoxlabs/core/runtime/services/scanWorkspace.js');
      const candidates = scanWorkspace(workspaceRoot);
      return { success: true, candidates };
    } catch (err: any) {
      return { success: false, candidates: [], error: err?.message };
    }
  });

  /* 编辑服务弹窗「运行环境」: Spring profile / JDK / Node —— 纯读文件和本机工具链, main 里直接算 */
  ipcMain.handle('service:project-info', async (_event, workspaceRoot: string, draft: { cwd: string; module?: string; command?: string }) => {
    try {
      const { getServiceProjectInfo } = await import('@neoxlabs/core/runtime/services/scanWorkspace.js');
      return { success: true, info: getServiceProjectInfo(workspaceRoot, draft) };
    } catch (err: any) {
      return { success: false, error: err?.message };
    }
  });

  ipcMain.handle('service:remove-config', async (event: IpcMainInvokeEvent, workspaceRoot: string, id: string) => {
    const bridge = resolveOptionalBridge(event);
    const client = bridge?.getClient();
    if (client) {
      try {
        const r = await client.removeServiceConfig(workspaceRoot, id);
        return { success: r.ok && r.removed, error: r.error };
      } catch (err: any) {
        console.warn('[service:remove-config] SDK 失败, fallback 本地:', err?.message);
      }
    }
    try {
      const store = getServiceConfigStore(workspaceRoot);
      const ok = store.remove(id);
      return { success: ok };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  /* P1-4: 把已运行的 pid 绑定到 config — UI 的 [adopt] 按钮调.
   *
   *   跨进程陷阱 (同 service:start-config): 真 pid 在 server 的 processManager,
   *   electron-main 端的 processManager 是空壳, 直接调 bindConfig 没效果. 优先 SDK. */
  ipcMain.handle('service:bind', async (event: IpcMainInvokeEvent, pid: number, configId: string) => {
    const bridge = resolveOptionalBridge(event);
    const client = bridge?.getClient();
    if (client) {
      try {
        const r = await client.bindRunConfig(pid, configId);
        /* 兼容旧 UI: 仍返回 success 字段 */
        return { success: r.ok, error: r.error };
      } catch (err: any) {
        console.warn('[service:bind] SDK 失败, fallback 本地:', err?.message);
      }
    }
    try {
      const proc = processManager.get(pid);
      if (!proc) return { success: false, error: `pid=${pid} not tracked` };
      processManager.bindConfig(pid, configId);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  /* P3-2: UI 上 Start 按钮 — 从 RunConfig 拉起服务.
   *
   *   关键陷阱: electron-main 端的 processManager 是空 singleton, agent 跑在 server 子进程,
   *   真实进程都在 server 那边的 processManager 里. 如果直接 import serviceLauncher 在 main 起,
   *   起出来的进程注册到 main 的空 processManager 上, process:list 永远看不到它 — 用户
   *   反馈"启动按了没反应"就是这个 bug.
   *
   *   修复: 优先走 SDK 让 server 来起 (跟 kill/list 同款代理), 这样 UI 立刻看得到.
   *   server 不通时才 fallback 本地 (调试 / 离线场景). */
  ipcMain.handle('service:start-config', async (event: IpcMainInvokeEvent, workspaceRoot: string, configId: string, sessionId?: string) => {
    const bridge = resolveOptionalBridge(event);
    const client = bridge?.getClient();
    if (client) {
      try {
        /* sessionId 必须透传 — server 推 shell_output_stream 时用它路由到 UI SSE,
         * UI 没传则 server 端解析 session 失败, ShellConsole 永远空. */
        const result = await client.startServiceByConfig(workspaceRoot, configId, sessionId);
        return result;
      } catch (err: any) {
        console.error('[service:start-config] 走 runtime 失败:', err?.message);
        return { ok: false, error: err?.message || String(err) };
      }
    }
    /* 完全没有 client (runtime 还没起来) —— 此时也没有"另一侧"可言, 本地起是唯一选择。 */
    try {
      const { startServiceByConfig } = await import('@neoxlabs/core/runtime/services/serviceLauncher.js');
      const result = await startServiceByConfig(workspaceRoot, configId, sessionId);
      return result;
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('service:suggest-config', async (event: IpcMainInvokeEvent, workspaceRoot: string, draft: any) => {
    const client = resolveOptionalBridge(event)?.getClient();
    if (!client) return { ok: false, error: 'runtime 还没就绪, 稍后再试' };
    try { return await client.suggestServiceConfig(workspaceRoot, draft); }
    catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
  });

  ipcMain.handle('service:list-history', async (event: IpcMainInvokeEvent, workspaceRoot: string) => {
    const client = resolveOptionalBridge(event)?.getClient();
    if (!client) return { success: false, instances: [] };
    try {
      const r = await (client as any).listServiceHistory(workspaceRoot);
      return { success: true, instances: r?.instances ?? [] };
    } catch (err: any) {
      return { success: false, instances: [], error: err?.message };
    }
  });

  ipcMain.handle('service:read-log', async (event: IpcMainInvokeEvent, pid: number, startTimeMs?: number) => {
    const client = resolveOptionalBridge(event)?.getClient();
    if (!client) return { success: false, output: '' };
    try {
      const r = await (client as any).readServiceLog(pid, startTimeMs);
      return { success: true, output: r?.output ?? '' };
    } catch (err: any) {
      return { success: false, output: '', error: err?.message };
    }
  });

  ipcMain.handle('process:get-output', async (event: IpcMainInvokeEvent, pid: number) => {
    /* 跨进程: agent 跑在 server 子进程, output buffer 在那边的 processManager. 优先 SDK 拉,
     * fallback 本地 (调试 / 无 server 的离线场景). */
    const bridge = resolveOptionalBridge(event);
    const client = bridge?.getClient();
    if (client) {
      try {
        const output = await client.getBackgroundTaskOutput(pid);
        return { success: true, output };
      } catch (err: any) {
        console.warn('[process:get-output] SDK 拉失败, fallback 本地:', err?.message);
      }
    }
    try {
      const output = processManager.getOutput(pid);
      return { success: true, output };
    } catch (error: any) {
      return { success: false, output: '', error: error.message };
    }
  });

  ipcMain.handle('process:untrack', async (event: IpcMainInvokeEvent, pid: number) => {
    const bridge = resolveOptionalBridge(event);
    const client = bridge?.getClient();
    if (client) {
      try {
        const tasks = await client.listBackgroundTasks();
        if (tasks.some(t => Number(t?.pid) === pid)) {
          const r = await client.untrackProcess(pid);
          return { success: r.ok, removed: r.removed };
        }
        /* server 不认识这个 pid → 走本地跟踪表二次确认 (离线/本地兜底场景) */
      } catch (err: any) {
        console.warn('[process:untrack] SDK 失败, fallback 本地:', err?.message);
      }
    }
    try {
      if (!processManager.get(pid)) {
        return { success: false, removed: false, error: 'pid not managed by neox' };
      }
      const removed = processManager.untrack(pid);
      return { success: true, removed };
    } catch (error: any) {
      return { success: false, removed: false, error: error.message };
    }
  });

  ipcMain.handle('process:kill', async (event: IpcMainInvokeEvent, pid: number) => {
    /* 跨进程同样问题: kill 必须发到持有真实 pid 的那个 processManager. SDK 优先.
     * pid 归属校验同 process:untrack — 不在托管列表的 pid 一律拒杀. */
    const bridge = resolveOptionalBridge(event);
    const client = bridge?.getClient();
    if (client) {
      try {
        const tasks = await client.listBackgroundTasks();
        if (tasks.some(t => Number(t?.pid) === pid)) {
          await client.killBackgroundTask(pid, false);
          return { success: true };
        }
        /* server 不认识这个 pid → 走本地跟踪表二次确认 (离线/本地兜底场景) */
      } catch (err: any) {
        console.warn('[process:kill] SDK 失败, fallback 本地:', err?.message);
      }
    }
    try {
      if (!processManager.get(pid)) {
        return { success: false, error: 'pid not managed by neox' };
      }
      processManager.kill(pid);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('process:kill-all', async (event: IpcMainInvokeEvent) => {
    const bridge = resolveOptionalBridge(event);
    const client = bridge?.getClient();
    if (client) {
      try {
        const tasks = await client.listBackgroundTasks();
        const running = tasks.filter(t => t.status === 'running');
        await Promise.all(running.map(t => client.killBackgroundTask(t.pid, false).catch(() => undefined)));
        return { success: true, count: running.length };
      } catch (err: any) {
        console.warn('[process:kill-all] SDK 失败, fallback 本地:', err?.message);
      }
    }
    try {
      const running = processManager.getBackgroundRunning();
      for (const proc of running) {
        processManager.kill(proc.pid);
      }
      return { success: true, count: running.length };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });
}
