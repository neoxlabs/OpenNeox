const { contextBridge, ipcRenderer, app, webUtils } = require('electron');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

/* preload 端 debug log — main 我们能写 ~/.neox/logs/workspace-watcher.log,
 * preload 写同一个文件, 通过 prefix [PRELOAD] 区分. 用来确认 IPC 'workspace:fs-event'
 * 是否真到了 renderer 进程 (而不只是 main 端 chokidar fire 了). */
const WATCHER_LOG = path.join(os.homedir(), '.neox-lite', 'logs', 'workspace-watcher.log');
const WATCHER_LOG_MAX_BYTES = 8 * 1024 * 1024;
let _watcherLogEnsured = false;
let _watcherLogWriteCount = 0;

function _diagLogOn(channel) {
  const raw = String(process.env.NEOX_DIAG_LOG || '').trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (lower === '1' || lower === 'all' || lower === 'true') return true;
  return lower.split(/[,\s]+/).includes(channel);
}
function rotateWatcherLogIfOversized() {
  try {
    const st = fs.statSync(WATCHER_LOG);
    if (st.size > WATCHER_LOG_MAX_BYTES) {
      try { fs.renameSync(WATCHER_LOG, `${WATCHER_LOG}.1`); } catch { /* 并发滚动竞争 — 忽略 */ }
    }
  } catch { /* 文件还不存在 */ }
}
function preloadLog(tag, msg) {
  if (!_diagLogOn('workspace-watcher')) return;
  try {
    if (!_watcherLogEnsured) {
      fs.mkdirSync(path.dirname(WATCHER_LOG), { recursive: true });
      _watcherLogEnsured = true;
      rotateWatcherLogIfOversized();
      /* 0600 — 内容是用户工作区的绝对路径 */
      try { fs.chmodSync(WATCHER_LOG, 0o600); } catch { /* 还不存在 */ }
    }
    if (++_watcherLogWriteCount % 500 === 0) rotateWatcherLogIfOversized();
    fs.appendFileSync(WATCHER_LOG, `[${new Date().toISOString()}] [PRELOAD] [${tag}] ${msg}\n`, { mode: 0o600 });
  } catch { /* ignore */ }
}

/* 全局 always-on listener — 不管 renderer 有没有挂自己的 listener, 我们
 * 总能在 log 里看到 IPC 确实到了 preload (隔离 main fire vs IPC 到达 vs renderer 处理). */
if (_diagLogOn('workspace-watcher')) {
  ipcRenderer.on('workspace:fs-event', (_e, payload) => {
    try {
      preloadLog('fs-event-received', `kind=${payload?.kind} path=${payload?.path}`);
    } catch { /* ignore */ }
  });
  preloadLog('preload-loaded', 'preload script initialized, always-on fs-event listener attached');
}

/* OS 信息 — 给 xterm 显示真实 prompt 用 (exampleuser@host:cwd %).
   preload 同步抓取一次, renderer 直接同步读, 不用 IPC 往返. */
try {
  if (typeof PerformanceObserver !== 'undefined'
    && (PerformanceObserver.supportedEntryTypes || []).includes('long-animation-frame')) {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < 1000) continue;
        try {
          ipcRenderer.send('hang:long-frame', {
            duration: e.duration,
            blockingDuration: e.blockingDuration,
            styleAndLayoutDuration: e.styleAndLayoutStart ? (e.startTime + e.duration - e.styleAndLayoutStart) : undefined,
            route: (globalThis.location && globalThis.location.hash) || '',
            scripts: (e.scripts || []).map((s) => ({
              invoker: s.invoker,
              invokerType: s.invokerType,
              sourceURL: s.sourceURL,
              sourceFunctionName: s.sourceFunctionName,
              sourceCharPosition: s.sourceCharPosition,
              duration: s.duration,
              forcedStyleAndLayoutDuration: s.forcedStyleAndLayoutDuration,
            })),
          });
        } catch { /* 主进程没装监听也无所谓 */ }
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  }
} catch { /* ignore */ }

function buildOsInfo() {
  let username = '';
  let homedir = '';
  try {
    const u = os.userInfo();
    username = u.username || '';
    homedir = u.homedir || '';
  } catch { /* 沙箱环境可能拒绝, 兜底 */ }
  let hostname = '';
  try { hostname = os.hostname() || ''; } catch {}
  /* macOS 主机名习惯去 .local 尾巴 — 真实 zsh prompt 默认就这么处理 */
  hostname = hostname.replace(/\.local$/i, '');
  return { username, hostname, homedir };
}
const OS_INFO = buildOsInfo();

/* ============================================================
 * cloudEndpoints — preload 同步暴露 NeoxCloud 接入地址给 renderer.
 *
 *   决策规则
 *   --------
 *     1. 显式环境变量 (NEOX_API_BASE / NEOX_GATEWAY_BASE / NEOX_WEB_BASE) 最高优先,
 *        用户用 `NEOX_API_BASE=xxx npx electron .` 自启时尊重
 *     2. 否则:
 *        - app.isPackaged === true (打包后)→ prod 三件套
 *        - 否则 (dev: npm run ui:dev / npx electron .) → local localhost
 *
 *   renderer 的 auth/config.ts 读 window.neox.cloudEndpoints.active 同步拿到.
 *   切换需要重 build (打包) 或改启动环境变量, 不在 UI 里暴露 — 避免 token /
 *   cached membership 跟 server 错位.
 * ============================================================ */
const PRESETS = {
  local: { api: 'http://localhost:3721',       gateway: 'http://localhost:8088',       web: 'http://localhost:3000' },
  /* api/web 橙云; 订阅 LLM 灰云 gateway.neox-dev.com. 跟 cloudEndpoints.ts 保持一致. */
  prod:  { api: 'https://neox-dev.com',        gateway: 'https://gateway.neox-dev.com', web: 'https://neox-dev.com' },
};

/* dev 模式默认走 local, 但作者本人 dev 时通常没起本地 control-plane (它在
 * the server 服务器上跑), 直接连 localhost 会假报"云端不可达".
 * 加一次同步 TCP 探活: dev 模式启动瞬间连 localhost:3721 (300ms 超时),
 *   · connect 成功 → 用 local 预设 (真在本地跑服务)
 *   · connect 失败 → 静默 fallback prod (预期路径)
 * preload 是 CJS 同步执行, 用 net.Socket 做 SYN 探测, 本机 loopback 拒连是毫秒级. */
function isLocalServiceUp(host, port, timeoutMs) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const net = require('net');
    return new Promise(function (resolve) {
      const sock = new net.Socket();
      let done = false;
      const finish = (up) => { if (done) return; done = true; try { sock.destroy(); } catch (e) { /* ignore */ } resolve(up); };
      sock.setTimeout(timeoutMs);
      sock.once('connect', () => finish(true));
      sock.once('error', () => finish(false));
      sock.once('timeout', () => finish(false));
      try { sock.connect(port, host); } catch (e) { finish(false); }
    });
  } catch (e) {
    return Promise.resolve(false);
  }
}
/* 只在 pickBaseProfile 里同步用. Promise 不好接, 就跑一个短的 net.Socket 探活,
 * 用一个 shared cache 变量 sync 拿(启动时会 await 到 __probeResult 里). */
let __localProbePromise = null;
function ensureLocalProbe() {
  if (__localProbePromise) return __localProbePromise;
  __localProbePromise = isLocalServiceUp('127.0.0.1', 3721, 300);
  return __localProbePromise;
}

function pickBaseProfile(localUp) {
  const explicit = (process.env.NEOX_PROFILE || '').toLowerCase();
  if (explicit === 'prod' || explicit === 'local') return PRESETS[explicit];
  const looksProd = [process.env.NEOX_API_BASE, process.env.NEOX_GATEWAY_BASE, process.env.NEOX_WEB_BASE]
    .some((v) => typeof v === 'string' && v && !/^https?:\/\/(?:localhost|127\.|0\.0\.0\.0)/i.test(v));
  if (looksProd) return PRESETS.prod;
  const isPackaged = app && app.isPackaged === true;
  if (isPackaged) return PRESETS.prod;
  return PRESETS.prod;
}
function resolveCloudEndpoints(localUp) {
  const base = pickBaseProfile(localUp);
  return {
    api:     process.env.NEOX_API_BASE     || base.api,
    gateway: process.env.NEOX_GATEWAY_BASE || base.gateway,
    web:     process.env.NEOX_WEB_BASE     || base.web,
  };
}
function describeProfile(localUp) {
  return (process.env.NEOX_PROFILE || '').toLowerCase() === 'local' ? 'local' : 'prod';
}

/* 探活 → 决 endpoint. preload 是 CJS, 无 top-level await, 但 net.Socket 探活是 promise;
 * renderer 拿 window.neox.cloudEndpoints 时不能 block, 所以策略:
 *   1. 先给一个 optimistic 值 (isPackaged→prod, 否则 local — 老行为)
 *   2. 探活完成后异步 mutate __cloudEndpoints 引用. renderer 首次读可能是 local, 但 400ms
 *      内会更新到实际值; cloudHealthStore 也会在初次探活失败后指数退避重试. */
let __cloudEndpoints = {
  profile: describeProfile(undefined),
  active: resolveCloudEndpoints(undefined),
};
/* 启动 → 探活 → 更新 endpoints. 400ms 上限, 探活失败即用 prod. */
void ensureLocalProbe().then((localUp) => {
  const nextActive = resolveCloudEndpoints(localUp);
  if (JSON.stringify(nextActive) !== JSON.stringify(__cloudEndpoints.active)) {
    __cloudEndpoints.active = nextActive;
    __cloudEndpoints.profile = describeProfile(localUp);
    try { console.log('[preload/cloudEndpoints] endpoint resolved:', JSON.stringify(__cloudEndpoints)); } catch (e) { /* ignore */ }
  }
});

/* 诊断 log — renderer DevTools console 能看到, 一眼确认是不是连了对的环境 */
try {
  console.log('[preload/cloudEndpoints] initial:', JSON.stringify(__cloudEndpoints));
} catch { /* ignore */ }

/* 桌宠 IPC 子集 — 主窗口操作独立 pet 窗口的接口.
 *   spawn/destroy: 启用/禁用 (跟 PetTab 的 enabled toggle 联动)
 *   updateConfig:  PetTab 改了配置后告诉 main, main 把变化推给 pet window
 *   forwardAgentEvent: NeoxRuntimeBridge 订阅 SSE 后, 过滤简化推到 pet window
 *   onDismissedByUser: pet window 内 用户右键关闭, 主窗口 PetTab 同步 toggle 状态
 */
const petApi = {
  spawn: (cfg) => ipcRenderer.invoke('pet:spawn', cfg),
  destroy: () => ipcRenderer.invoke('pet:destroy'),
  updateConfig: (cfg) => ipcRenderer.invoke('pet:update-config', cfg),
  forwardAgentEvent: (event) => ipcRenderer.invoke('pet:forward-agent-event', event),
  onDismissedByUser: (handler) => {
    const wrapped = () => { try { handler(); } catch (e) { console.error('[pet:dismissed] handler error', e); } };
    ipcRenderer.on('pet:dismissed-by-user', wrapped);
    return () => ipcRenderer.off('pet:dismissed-by-user', wrapped);
  },
  /* 用户 .glb 导入 / 列表 / 删除 — userData/pets/<uuid>.glb */
  listCustomSkins: () => ipcRenderer.invoke('pet:list-custom-skins'),
  importGlb: () => ipcRenderer.invoke('pet:import-glb'),
  deleteCustomSkin: (id) => ipcRenderer.invoke('pet:delete-custom-skin', id),
  /* 用户 sprite sheet (.webp/.png) 导入 / 列表 / 删除 — userData/pets/sprites/<uuid>.webp */
  listCustomSprites: () => ipcRenderer.invoke('pet:list-custom-sprites'),
  importSprite: () => ipcRenderer.invoke('pet:import-sprite'),
  importPetBundle: () => ipcRenderer.invoke('pet:import-pet-bundle'),
  discoverPacks: () => ipcRenderer.invoke('pet:discover-packs'),
  importDiscovered: (dir) => ipcRenderer.invoke('pet:import-discovered', dir),
  ensureRenderer: (mode) => ipcRenderer.invoke('pet:ensure-renderer', mode),
  removeRenderer: (mode) => ipcRenderer.invoke('pet:remove-renderer', mode),
  deleteCustomSprite: (id) => ipcRenderer.invoke('pet:delete-custom-sprite', id),
};

const api = {
  /* 暴露给 renderer 启动同步使用 — auth/config.ts 直接读 .active.
   * 不提供 set — 切换需要重启 + 重 build, 在 UI 里切会乱套 (token/cached 跟 server 强绑). */
  cloudEndpoints: __cloudEndpoints,
  /* osInfo — 同步暴露 username/hostname/homedir, xterm 拼真实 prompt 用 */
  osInfo: OS_INFO,
  /* pet — 桌宠独立窗口控制 (生命周期 + 跨窗口转发) */
  pet: petApi,
  // App
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  diagnosticsAppend: (payload) => ipcRenderer.invoke('diagnostics:append', payload),
  diagnosticsOpenFolder: () => ipcRenderer.invoke('diagnostics:open-folder'),

  /* logDebug — renderer 日志转发到 main 进程 neoxLogger,
   * 落盘 ~/.neox/logs/neox-app-*.log. 用法:
   *   window.neox.logDebug('EDIT_DEBUG', 'handleToolCall', { toolId, ... })
   * 单向 send, 不 await. */
  logDebug: (tag, message, data) => {
    try { ipcRenderer.send('renderer:log', 'debug', tag, message, data); } catch { /* ignore */ }
  },
  logInfo: (tag, message, data) => {
    try { ipcRenderer.send('renderer:log', 'info', tag, message, data); } catch { /* ignore */ }
  },
  logWarn: (tag, message, data) => {
    try { ipcRenderer.send('renderer:log', 'warn', tag, message, data); } catch { /* ignore */ }
  },
  logError: (tag, message, data) => {
    try { ipcRenderer.send('renderer:log', 'error', tag, message, data); } catch { /* ignore */ }
  },

  // Dialog
  openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),
  openFileDialog: (opts) => ipcRenderer.invoke('dialog:open-file', opts),
  saveFileDialog: (opts) => ipcRenderer.invoke('dialog:save-file', opts),

  // Workspace
  setWorkspace: (path) => ipcRenderer.invoke('workspace:set', path),
  /* opts.detach=true 才解绑窗口 scope; 默认只清持久化指针 (见 workspaceHandlers 说明) */
  clearLastWorkspace: (opts) => ipcRenderer.invoke('workspace:clear-last', opts),
  // 多根工作区
  getWorkspaceRoots: (primaryPath) => ipcRenderer.invoke('workspace:get-roots', primaryPath),
  setWorkspaceRoots: (primaryPath, roots) => ipcRenderer.invoke('workspace:set-roots', primaryPath, roots),
  // 工作区实体: 重命名/删除/设主/列举
  setWorkspaceName: (primaryPath, name) => ipcRenderer.invoke('workspace:set-name', primaryPath, name),
  deleteWorkspace: (primaryPath) => ipcRenderer.invoke('workspace:delete', primaryPath),
  setPrimaryRoot: (oldPrimary, newPrimary) => ipcRenderer.invoke('workspace:set-primary', oldPrimary, newPrimary),
  listWorkspaces: () => ipcRenderer.invoke('workspace:list'),
  // 最近打开的文件 (欢迎页)
  addRecentFile: (workspacePath, filePath) => ipcRenderer.invoke('files:add-recent', workspacePath, filePath),
  getRecentFiles: (workspacePath, limit) => ipcRenderer.invoke('files:get-recent', workspacePath, limit),
  libraryList: (dirPath) => ipcRenderer.invoke('library:list', dirPath),
  /* 从 Finder/Explorer 拖进来的 File 对象 → 绝对路径。Electron 32+ 删了 File.path,
   * 必须走 webUtils.getPathForFile (preload 端调, File 可跨 contextBridge 传入)。 */
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || null; }
    catch { return null; }
  },

  // UI State
  getLastState: (workspacePath) => ipcRenderer.invoke('ui:get-last-state', workspacePath),
  setThemePreference: (darkMode, colorTheme) => ipcRenderer.invoke('ui:set-theme', darkMode, colorTheme),
  getThemePreference: () => ipcRenderer.invoke('ui:get-theme'),
  setThemePreset: (preset) => ipcRenderer.invoke('ui:set-theme-preset', preset),
  setThemePack: (packId) => ipcRenderer.invoke('ui:set-theme-pack', packId),
  syncTitleBar: (payload) => ipcRenderer.invoke('ui:sync-titlebar', payload),
  /* macOS 窗口毛玻璃开关 —— 关掉可以把窗口切回**不透明合成路径**, 省掉 WindowServer
     每帧的实时模糊。低配机的性能挡位, 也是排查粘滞时的对照组。 */
  setWindowVibrancy: (payload) => ipcRenderer.invoke('ui:set-window-vibrancy', payload),
  setOnboardingCompleted: (completed) => ipcRenderer.invoke('ui:set-onboarding-completed', completed),
  /** Dock / Win taskbar overlay badge — unread count (0 clears). */
  setAppBadge: (count) => ipcRenderer.invoke('ui:set-app-badge', count),

  // Chat
  sendMessage: (payload) => ipcRenderer.invoke('chat:send', payload),
  interruptSession: (sessionId) => ipcRenderer.invoke('chat:interrupt', sessionId),
  /* probeSessionIds: renderer 本地认为还在跑的会话 — 必须点名, 否则跨 workspace 换过
   * bridge 实例的老会话在 main 的 Map 里查不到, 幽灵运行态永远没人纠正。 */
  getExecutionStates: (probeSessionIds) => ipcRenderer.invoke('chat:getExecutionStates', probeSessionIds),
  injectMessage: (payload) => ipcRenderer.invoke('chat:inject', payload),
  steerSession: (payload) => ipcRenderer.invoke('chat:steer', payload),
  dequeueLastQueued: (payload) => ipcRenderer.invoke('chat:dequeue-last', payload),
  /** 监控药丸: 会话在跑的监控 / 停掉一个 ({ sessionId, id }) */
  monitorList: (sessionId) => ipcRenderer.invoke('monitor:list', sessionId),
  monitorStop: (payload) => ipcRenderer.invoke('monitor:stop', payload),
  pauseSession: (sessionId) => ipcRenderer.invoke('chat:pause', sessionId),
  resumeSession: (sessionId) => ipcRenderer.invoke('chat:resume', sessionId),
  pauseProcess: (pid) => ipcRenderer.invoke('process:pause', pid),
  resumeProcess: (pid) => ipcRenderer.invoke('process:resume', pid),
  onStream: (callback) => {
    const listener = (_event, data) => {
      if (data && Array.isArray(data.__streamBatch)) {
        for (const evt of data.__streamBatch) callback(evt);
        return;
      }
      callback(data);
    };
    ipcRenderer.on('chat:stream', listener);
    return () => ipcRenderer.removeListener('chat:stream', listener);
  },
  setSessionTimeline: (sessionId, timeline) =>
    ipcRenderer.invoke('session:set-timeline', sessionId, timeline),
  clearSessionTimeline: (sessionId) =>
    ipcRenderer.invoke('session:clear-timeline', sessionId),

  timelineUpsertBatch: (sessionId, entries) =>
    ipcRenderer.invoke('timeline:upsert-batch', sessionId, entries),
  timelinePage: (sessionId, opts) =>
    ipcRenderer.invoke('timeline:page', sessionId, opts),
  /* 侧栏工作台 / 全景墙: 一批会话「现在什么样」→ { [id]: { waiting, activity, lastLine, lastTs } } */
  sessionGlance: (sessionIds) =>
    ipcRenderer.invoke('session:glance', sessionIds),
  /* 成品架: 所有会话做出来的成品 → { items: [{ path, ext, name, size, mtime, ts, sessionId, sessionTitle }] } */
  librarySessionOutputs: () =>
    ipcRenderer.invoke('library:session-outputs'),
  timelineDeleteEntry: (sessionId, entryId) =>
    ipcRenderer.invoke('timeline:delete-entry', sessionId, entryId),
  timelineCount: (sessionId) =>
    ipcRenderer.invoke('timeline:count', sessionId),
  timelineClear: (sessionId) =>
    ipcRenderer.invoke('timeline:clear', sessionId),
  timelineMigrationState: (op, key) =>
    ipcRenderer.invoke('timeline:migration-state', op, key),
  /** 其它窗口写入同 session 时的失效通知 (多窗缓存一致性) */
  onTimelineChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('timeline:changed', listener);
    return () => ipcRenderer.removeListener('timeline:changed', listener);
  },
  setSessionFileCheckpoints: (sessionId, rollbackId, reapplyId, fileRevertedMap, fileConfirmedMap) =>
    ipcRenderer.invoke('session:set-file-checkpoints', sessionId, rollbackId, reapplyId, fileRevertedMap, fileConfirmedMap),

  // Sessions
  getSessions: (workspacePath) => ipcRenderer.invoke('session:get-all', workspacePath),
  /* 侧栏刷新专用: 比 getSessions 少三个 usage 字段 (#109) */
  getSessionsLite: (workspacePath) => ipcRenderer.invoke('session:get-all-lite', workspacePath),
  /* 全量列表 (含 messages) — 只给按需场景 (搜索 palette), 用完即弃, 别常驻 store. */
  getSessionsFull: (workspacePath) => ipcRenderer.invoke('session:get-all-full', workspacePath),
  /* 跨会话全文搜索 —— 匹配在主进程做, 只回命中项 (≤100 条片段)。
     取代"把 33.5MB 全量会话搬进渲染进程再自己遍历"的老路。 */
  searchSessions: (payload) => ipcRenderer.invoke('session:search', payload),
  getSession: (sessionId) => ipcRenderer.invoke('session:get', sessionId),
  /* 只读版 (不切当前会话、不动历史缓存) —— 设置页之类只是看一眼的地方用这个 */
  peekSession: (sessionId) => ipcRenderer.invoke('session:peek', sessionId),
  /* 团队规划看板 —— 内存 store 只是缓存, 切会话/刷新/重启都从这里把真相捞回来 */
  getTeamExec: (sessionId) => ipcRenderer.invoke('team:get-exec', sessionId),
  teamExecCommand: (payload) => ipcRenderer.invoke('team:exec-command', payload),
  teamDismiss: (payload) => ipcRenderer.invoke('team:dismiss', payload),
  getTeamPlan: (sessionId) => ipcRenderer.invoke('team:get-plan', sessionId),
  /* 看板上把一条需求分配给某个成员 (memberId=null 收回) */
  assignTeamRequirement: (payload) => ipcRenderer.invoke('team:assign', payload),
  createSession: (workspacePath, modelId, opts) =>
    ipcRenderer.invoke('session:create', workspacePath, modelId, opts),
  deleteSession: (sessionId) =>
    ipcRenderer.invoke('session:delete', sessionId),
  renameSession: (sessionId, name) =>
    ipcRenderer.invoke('session:rename', sessionId, name),
  undoSession: (sessionId, count) =>
    ipcRenderer.invoke('session:undo', sessionId, count),
  checkpointSession: (sessionId, name) =>
    ipcRenderer.invoke('session:checkpoint', sessionId, name),
  getSessionCheckpoints: (sessionId) =>
    ipcRenderer.invoke('session:get-checkpoints', sessionId),
  rollbackSession: (sessionId, checkpointId) =>
    ipcRenderer.invoke('session:rollback', sessionId, checkpointId),
  clearSession: (sessionId) =>
    ipcRenderer.invoke('session:clear', sessionId),
  /* 「编辑并重发」: 从倒数第 k 条用户消息起裁掉 SQLite + 让 worker 忘掉缓存。
   * k 从 1 开始 (1 = 最后一条用户消息)。返回 {ok, removed, reason?} —— ok=false 时
   * 调用方必须中止发送, 否则就成了"界面裁了、模型没裁"的两边对不上。 */
  truncateFromUserMessage: (sessionId, k) =>
    ipcRenderer.invoke('session:truncate-from-user-message', sessionId, k),
  compactSession: (sessionId) =>
    ipcRenderer.invoke('session:compact', sessionId),
  setAgentMode: (sessionId, mode) =>
    ipcRenderer.invoke('session:set-agent-mode', sessionId, mode),
  getAgentMode: (sessionId) =>
    ipcRenderer.invoke('session:get-agent-mode', sessionId),
  setSessionChatMode: (sessionId, on) =>
    ipcRenderer.invoke('session:set-chat-mode', sessionId, on),
  getSessionChatMode: (sessionId) =>
    ipcRenderer.invoke('session:get-chat-mode', sessionId),
  /* 按会话持久化模型选择 — 切会话时还原, 不等 sendMessage */
  setSessionModel: (sessionId, modelId) =>
    ipcRenderer.invoke('session:set-model', sessionId, modelId),
  setSessionWorkspacePath: (sessionId, workspacePath) =>
    ipcRenderer.invoke('session:set-workspace-path', sessionId, workspacePath),
  targetCommand: (sessionId, subCmd, arg) =>
    ipcRenderer.invoke('session:target:cmd', sessionId, subCmd, arg),
  /* 会话预算: cmd = 'get' | 'set' | 'clear', config = { limitUsd, advisor, prices } */
  sessionBudget: (sessionId, cmd, config) =>
    ipcRenderer.invoke('session:budget', sessionId, cmd, config),
  /** Phase A · 订阅 target 状态 push. 后端 targetEvents 每次 mutation 都 emit 一次
   *   完整 snapshot, renderer 用这个 API 拿到实时更新, 不再靠 timeline 派生. */
  onTargetSnapshot: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('neox:target:snapshot', listener);
    return () => ipcRenderer.removeListener('neox:target:snapshot', listener);
  },
  /** Phase E · IPC 心跳订阅. 主进程每 15s 发一次, renderer 侧 hook 用它判断
   *   主进程活性 (30s 无 heartbeat = IPC 死). 配合 STALE_WATCHDOG stream 侧检测. */
  onHeartbeat: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('neox:heartbeat', listener);
    return () => ipcRenderer.removeListener('neox:heartbeat', listener);
  },
  getStatus: () =>
    ipcRenderer.invoke('server:get-status'),

  // Menu events
  onMenuAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('menu:action', listener);
    return () => ipcRenderer.removeListener('menu:action', listener);
  },

  // Export
  exportSession: (sessionId, format) =>
    ipcRenderer.invoke('session:export', sessionId, format),

  // Assistant manual team control
  createLeaderTeam: (goal) => ipcRenderer.invoke('assistant:create-team', goal),
  leaderRecruitMember: (teamId, payload) => ipcRenderer.invoke('assistant:recruit-member', teamId, payload),
  leaderRequestCapability: (teamId, capability, reason) => ipcRenderer.invoke('assistant:request-capability', teamId, capability, reason),
  getStewardRuntimeSnapshot: () => ipcRenderer.invoke('assistant:get-steward-snapshot'),
  cancelCommitment: (commitmentId) => ipcRenderer.invoke('steward:cancel-commitment', commitmentId),
  getKernelDiagnostics: () => ipcRenderer.invoke('kernel:get-diagnostics'),

  // Graph State (SQLite 持久化 worker/team 编排数据)
  saveGraphSnapshot: (sessionId, workers, teams, communications) => ipcRenderer.invoke('graph:save-snapshot', sessionId, workers, teams, communications),
  loadGraphSnapshot: (sessionId) => ipcRenderer.invoke('graph:load-snapshot', sessionId),
  deleteGraphSnapshot: (sessionId) => ipcRenderer.invoke('graph:delete-snapshot', sessionId),

  // ==================== Provider 配置管理 ====================
  getProviders: () => ipcRenderer.invoke('provider:get-all'),
  getProvider: (id) => ipcRenderer.invoke('provider:get', id),
  getDefaultProvider: () => ipcRenderer.invoke('provider:get-default'),
  onProvidersChanged: (handler) => {
    const wrapped = (_evt, payload) => {
      try { handler(payload); } catch (e) { console.warn('[providers.onChanged] handler threw:', e); }
    };
    ipcRenderer.on('providers:changed', wrapped);
    return () => ipcRenderer.removeListener('providers:changed', wrapped);
  },
  addProvider: (input) => ipcRenderer.invoke('provider:add', input),
  updateProvider: (id, updates) => ipcRenderer.invoke('provider:update', id, updates),
  deleteProvider: (id) => ipcRenderer.invoke('provider:delete', id),
  setDefaultProvider: (id) => ipcRenderer.invoke('provider:set-default', id),
  fetchProviderModels: (request) => ipcRenderer.invoke('provider:fetch-models', request),

  // Model 管理
  addModel: (providerId, modelName, makeDefault) =>
    ipcRenderer.invoke('model:add', providerId, modelName, makeDefault),
  removeModel: (providerId, modelName) =>
    ipcRenderer.invoke('model:remove', providerId, modelName),
  setSelectedModel: (providerId, modelName) =>
    ipcRenderer.invoke('model:set-selected', providerId, modelName),

  // 获取可用模型列表
  getAvailableModels: () => ipcRenderer.invoke('model:get-available'),

  // Phase 2.6 schema info (per-model effort_map + billing_multiplier).
  // Renderer 调它拿当前 model 的 schema effort info, 不再硬编码档位 mirror.
  getSchemaModelInfo: (modelId) => ipcRenderer.invoke('schema:model-info', modelId),

  // 配置文件路径 (调试用)
  getConfigPath: () => ipcRenderer.invoke('config:get-path'),

  // Runtime 控制
  getSandboxStatus: (sessionId) => ipcRenderer.invoke('runtime:get-sandbox', sessionId),
  setSandboxStatus: (sessionId, enabled, modelId) => ipcRenderer.invoke('runtime:set-sandbox', sessionId, enabled, modelId),
  getApprovalMode: (sessionId) => ipcRenderer.invoke('runtime:get-approval', sessionId),
  listAlwaysAllow: () => ipcRenderer.invoke('runtime:list-always-allow'),
  revokeAlwaysAllow: (toolName) => ipcRenderer.invoke('runtime:revoke-always-allow', toolName),
  setApprovalMode: (sessionId, mode, modelId, options) => ipcRenderer.invoke('runtime:set-approval', sessionId, mode, modelId, options),
  replyPermission: (requestId, approved, remember) => ipcRenderer.invoke('runtime:reply-permission', requestId, approved, remember),
  cancelPermission: (requestId, reason) => ipcRenderer.invoke('runtime:cancel-permission', requestId, reason),
  replyAskUser: (requestId, answers) => ipcRenderer.invoke('runtime:reply-ask-user', requestId, answers),
  killBackgroundTask: (pid, force) => ipcRenderer.invoke('runtime:kill-background-task', pid, !!force),
  pauseBackgroundTask: (pid) => ipcRenderer.invoke('runtime:pause-background-task', pid),
  resumeBackgroundTask: (pid) => ipcRenderer.invoke('runtime:resume-background-task', pid),
  /* 转正/取消 —— 后台任务默认只在自己会话可见, 这是唯一的跨会话晋升途径 */
  setBackgroundTaskPersistent: (pid, persistent) =>
    ipcRenderer.invoke('runtime:set-background-task-persistent', pid, !!persistent),
  shellStdin: (pid, data) => ipcRenderer.invoke('runtime:shell-stdin', pid, data),
  shellResize: (pid, cols, rows) => ipcRenderer.invoke('runtime:shell-resize', pid, cols, rows),
  listBackgroundTasks: () => ipcRenderer.invoke('runtime:list-background-tasks'),
  /* sub-agent (BackgroundAgentManager) per-session 列 + abort. 跟 background-task (shell) 分开 */
  listSubAgents: (sessionId) => ipcRenderer.invoke('runtime:list-sub-agents', sessionId),
  abortSubAgent: (agentId) => ipcRenderer.invoke('runtime:abort-sub-agent', agentId),
  /* 独立可交互 PTY shell - Services panel Shell 控制台用 */
  openInteractiveShell: (args) => ipcRenderer.invoke('runtime:open-interactive-shell', args),
  /* 用户手动重启 server daemon — 改完 core 代码想立刻见效用 */
  restartServer: () => ipcRenderer.invoke('runtime:restart-server'),

  // Language preference
  getLanguagePreference: () => ipcRenderer.invoke('config:get-language'),
  setLanguagePreference: (language) => ipcRenderer.invoke('config:set-language', language),
  getPiiFilterPreference: () => ipcRenderer.invoke('config:get-pii-filter'),
  setPiiFilterPreference: (enabled) => ipcRenderer.invoke('config:set-pii-filter', enabled),
  getCrashReportPreference: () => ipcRenderer.invoke('config:get-crash-report'),
  setCrashReportPreference: (enabled) => ipcRenderer.invoke('config:set-crash-report', enabled),
  getBrowserUseConfig: () => ipcRenderer.invoke('config:get-browser-use'),
  setBrowserUseConfig: (patch) => ipcRenderer.invoke('config:set-browser-use', patch),
  syncDailyLogins: () => ipcRenderer.invoke('browser:sync-daily-logins'),
  listDailyChromeProfiles: () => ipcRenderer.invoke('browser:list-daily-profiles'),
  onDailyLoginsAsk: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('browser:daily-logins-ask', h);
    return () => ipcRenderer.removeListener('browser:daily-logins-ask', h);
  },
  dailyLoginsAck: (id) => ipcRenderer.send(`browser:daily-logins-ack-${id}`),
  dailyLoginsAnswer: (id, allow) => ipcRenderer.send('browser:daily-logins-answer', { id, allow: allow === true }),
  getGithubChannelConfig: () => ipcRenderer.invoke('config:get-github-channel'),
  setGithubChannelConfig: (patch) => ipcRenderer.invoke('config:set-github-channel', patch),
  getGithubChannelStatus: () => ipcRenderer.invoke('config:get-github-channel-status'),
  getGithubTokenInfo: () => ipcRenderer.invoke('github:token-info'),
  getCliDebugPreference: () => ipcRenderer.invoke('config:get-cli-debug'),
  setCliDebugPreference: (enabled) => ipcRenderer.invoke('config:set-cli-debug', enabled),

  // Reasoning effort
  getReasoningEffort: () => ipcRenderer.invoke('config:get-reasoning-effort'),
  setReasoningEffort: (effort) => ipcRenderer.invoke('config:set-reasoning-effort', effort),

  // Model Config (Codex-style)
  getModelConfig: () => ipcRenderer.invoke('config:get-model-config'),
  setModelConfig: (config) => ipcRenderer.invoke('config:set-model-config', config),

  // Tools enabled state
  getEnabledTools: () => ipcRenderer.invoke('config:get-enabled-tools'),
  setEnabledTools: (enabledTools) => ipcRenderer.invoke('config:set-enabled-tools', enabledTools),

  // Provider health check interval
  getHealthCheckInterval: () => ipcRenderer.invoke('config:get-health-interval'),
  setHealthCheckInterval: (minutes) => ipcRenderer.invoke('config:set-health-interval', minutes),
  // Auto health check toggle
  getAutoHealthCheck: () => ipcRenderer.invoke('config:get-auto-health-check'),
  setAutoHealthCheck: (enabled) => ipcRenderer.invoke('config:set-auto-health-check', enabled),

  // Agent Settings
  getAgentSettings: () => ipcRenderer.invoke('config:get-agent-settings'),
  setAgentSettings: (settings) => ipcRenderer.invoke('config:set-agent-settings', settings),

  // ==================== 多模型协作配置 ====================
  getOrchestratorConfig: () => ipcRenderer.invoke('config:get-orchestrator-config'),
  setOrchestratorConfig: (config) => ipcRenderer.invoke('config:set-orchestrator-config', config),
  getOrchestratorEnabled: () => ipcRenderer.invoke('config:get-orchestrator-enabled'),
  setOrchestratorEnabled: (enabled) => ipcRenderer.invoke('config:set-orchestrator-enabled', enabled),

  // Java Debug
  getJavaDebugStatus: () => ipcRenderer.invoke('config:get-java-debug-status'),
  downloadJavaDebugJar: () => ipcRenderer.invoke('config:download-java-debug-jar'),

  // Storage info
  getStorageInfo: () => ipcRenderer.invoke('storage:get-info'),
  readConfigFile: (filePath) => ipcRenderer.invoke('storage:read-file', filePath),
  listConfigDir: (dirPath) => ipcRenderer.invoke('storage:list-dir', dirPath),
  openInFinder: (filePath) => ipcRenderer.invoke('storage:open-in-finder', filePath),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  // Checkpoint 存储清理
  clearCheckpointStorage: (workspacePath) => ipcRenderer.invoke('storage:clear-checkpoint', workspacePath),
  clearStaleDbBackups: () => ipcRenderer.invoke('storage:clear-stale-db-backups'),
  clearStaleCliBinaries: () => ipcRenderer.invoke('storage:clear-stale-cli-binaries'),
  clearOrphanSemanticIndexes: () => ipcRenderer.invoke('storage:clear-orphan-semantic'),
  clearAllCheckpointStorage: () => ipcRenderer.invoke('storage:clear-all-checkpoints'),
  // 一键备份 (~/.neox + 会话 SQLite → 用户选定 zip)
  backupAll: () => ipcRenderer.invoke('storage:backup-all'),

  // Token usage statistics
  getUsageSummary: () => ipcRenderer.invoke('usage:get-summary'),
  getDailyUsage: (days) => ipcRenderer.invoke('usage:get-daily', days),
  getSessionTurnUsage: (sessionId) => ipcRenderer.invoke('usage:get-session-turns', sessionId),
  /* 分享卡片: 渲染 → 复制/另存 */
  renderShareCard: (req) => ipcRenderer.invoke('share:render-card', req),
  copyShareCard: (dataUrl) => ipcRenderer.invoke('share:copy-card', dataUrl),
  saveShareCard: (dataUrl) => ipcRenderer.invoke('share:save-card', dataUrl),
  shareCardToX: (dataUrl, text) => ipcRenderer.invoke('share:share-x', dataUrl, text),
  getProviderUsageStats: () => ipcRenderer.invoke('usage:get-provider-stats'),
  getProviderUsageRecords: (provider, limit) => ipcRenderer.invoke('usage:get-provider-records', provider, limit),
  getRecentUsageRecords: (limit) => ipcRenderer.invoke('usage:get-recent-records', limit),
  clearUsageStats: () => ipcRenderer.invoke('usage:clear-all'),
  clearProviderUsageStats: (provider) => ipcRenderer.invoke('usage:clear-provider', provider),

  // Provider health check (runs in main process to avoid browser CORS issues)
  checkProviderHealth: (request) => ipcRenderer.invoke('provider:health-check', request),

  // 图片模式直连 (bypass LLM, 用于 "创建图片" chip 和 图片 surface)
  imageDirectGenerate: (request) => ipcRenderer.invoke('image:direct-generate', request),
  imageDirectGenerateStream: (request) => ipcRenderer.invoke('image:direct-generate-stream', request),
  imageDirectGenerateAbort: (streamId) => ipcRenderer.invoke('image:direct-generate-abort', streamId),
  onImageStreamEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('image:stream-event', listener);
    return () => ipcRenderer.removeListener('image:stream-event', listener);
  },
  /** 任意路径 imageDirectGenerate 成功落盘后广播 — timeline 桥接用 (与图库扫盘互补). */
  onImageGenerated: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('image:generated', listener);
    return () => ipcRenderer.removeListener('image:generated', listener);
  },
  imageDirectEdit: (request) => ipcRenderer.invoke('image:direct-edit', request),
  imageDirectCutout: (request) => ipcRenderer.invoke('image:direct-cutout', request),
  imageGalleryList: (opts) => ipcRenderer.invoke('image:gallery-list', opts),
  imageDeleteFile: (absPath) => ipcRenderer.invoke('image:delete-file', absPath),
  imageRevealFile: (absPath) => ipcRenderer.invoke('image:reveal-file', absPath),
  imageShareFile: (absPath, pos) => ipcRenderer.invoke('image:share-file', absPath, pos),
  imageCopyFile: (absPath) => ipcRenderer.invoke('image:copy-file', absPath),
  imageExportSizes: (req) => ipcRenderer.invoke('image:export-sizes', req),
  imageTrack: (ev) => ipcRenderer.invoke('image:track', ev),
  // 素材库 / 项目
  imageProjectList: () => ipcRenderer.invoke('image:project-list'),
  imageProjectCreate: (name) => ipcRenderer.invoke('image:project-create', name),
  imageProjectRename: (id, name) => ipcRenderer.invoke('image:project-rename', id, name),
  imageProjectDelete: (id) => ipcRenderer.invoke('image:project-delete', id),
  imageAssetAssign: (assetPath, projectId) => ipcRenderer.invoke('image:asset-assign', assetPath, projectId),
  imageProjectMap: () => ipcRenderer.invoke('image:project-map'),
  imageShowcase: () => ipcRenderer.invoke('image:showcase'),
  // 图片会话 turn 持久化 (Phase A)
  imageSaveTurn: (req) => ipcRenderer.invoke('image:save-turn', req),
  imageListTurns: (sessionId) => ipcRenderer.invoke('image:list-turns', sessionId),
  /* 清空某个槽的出图记录 (「新建图片」清草稿槽用; 不删图片文件, 图库仍有) */
  imageDeleteTurns: (sessionId) => ipcRenderer.invoke('image:delete-turns', sessionId),
  // 图像模型能力目录 (参数面板数据驱动)
  imageModelCapabilities: () => ipcRenderer.invoke('image:model-capabilities'),

  // Kimi 余额查询 (runs in main process to avoid browser CORS issues)
  providerBalance: (providerId) => ipcRenderer.invoke('provider:balance', providerId),
  providerChatProbe: (req) => ipcRenderer.invoke('provider:chat-probe', req),

  // Health check data persistence (持久化健康检测数据)
  getHealthData: () => ipcRenderer.invoke('health:get-all'),
  updateHealthData: (providerId, status, latency, error, httpStatus, model) => ipcRenderer.invoke('health:update', providerId, status, latency, error, httpStatus, model),
  setAllHealthData: (data) => ipcRenderer.invoke('health:set-all', data),
  deleteHealthData: (providerId) => ipcRenderer.invoke('health:delete', providerId),
  clearAllHealthData: () => ipcRenderer.invoke('health:clear-all'),

  // NeoxCloud 存活探测 — 同样跑在主进程避开 CORS (dev 的 origin 是
  // http://127.0.0.1:5180, 生产控制面只放行 file://, 直接 fetch 会被判 403)。
  // 不收 url 参数: base 由主进程从 NEOX_API_BASE 自己读, 不给 renderer 开任意请求代理。
  probeCloudHealth: (timeoutMs) => ipcRenderer.invoke('cloud:health-probe', timeoutMs),

  // ==================== 模型路由管理 ====================
  getModelRoutingEnabled: () => ipcRenderer.invoke('routing:get-enabled'),
  setModelRoutingEnabled: (enabled) => ipcRenderer.invoke('routing:set-enabled', enabled),
  getModelRoutingConfig: () => ipcRenderer.invoke('routing:get-config'),
  getModelRoutes: () => ipcRenderer.invoke('routing:get-routes'),
  getModelRoute: (modelAlias) => ipcRenderer.invoke('routing:get-route', modelAlias),
  setModelRoute: (modelAlias, route) => ipcRenderer.invoke('routing:set-route', modelAlias, route),
  deleteModelRoute: (modelAlias) => ipcRenderer.invoke('routing:delete-route', modelAlias),
  autoDetectModelRoutes: (modelName) => ipcRenderer.invoke('routing:auto-detect', modelName),
  getAutoRoutedModels: () => ipcRenderer.invoke('routing:get-auto-models'),

  // File operations (for edit approval/revert) - 支持两种模式
  // mode: 'file' = 回退整个文件（使用 checkpoint）, 'edit' = 只回退这一次 edit
  revertFileEdit: (filePath, oldString, newString, mode = 'file') =>
    ipcRenderer.invoke('file:revert-edit', filePath, oldString, newString, mode),
  /* per-hunk Reject (E-03) — startLine 锚定精准定位, 多 hunk 同文件场景必须用这个,
   *  revertFileEdit 用 String.replace 永远命中第一个 newString, 拒绝后面的 hunk 时会误删前面. */
  revertFileHunk: (args) => ipcRenderer.invoke('file:revert-hunk', args),
  /* write_file 整文件覆盖的 Undo —— 从覆盖前存的快照还原, 不依赖 Shadow Git checkpoint. */
  restoreFileSnapshot: (args) => ipcRenderer.invoke('file:restore-snapshot', args),
  /* 撤销 agent 的 delete_file —— 按 manifest 把整棵树写回原位. */
  restoreDeletion: (args) => ipcRenderer.invoke('file:restore-deletion', args),
  reapplyFileEdit: (filePath, oldString, newString, mode = 'file') =>
    ipcRenderer.invoke('file:reapply-edit', filePath, oldString, newString, mode),
  deleteFile: (filePath) => ipcRenderer.invoke('file:delete', filePath),
  removeDirectory: (dirPath) => ipcRenderer.invoke('file:rmdir', dirPath),

  // Document parse 本地缓存 (F7+N4 v2 — Files API 范式)
  // 客户端解析完文档拿到 markdown → 写本地缓存; agent read_document 工具读
  documentCacheWrite: (fileId, markdown) => ipcRenderer.invoke('document-cache:write', fileId, markdown),
  documentCacheRead: (fileId) => ipcRenderer.invoke('document-cache:read', fileId),

  // ==================== Checkpoint 系统 (Shadow Git) ====================
  // 启动/停止文件监控
  startCheckpointWatching: (sessionId) => ipcRenderer.invoke('checkpoint:start-watching', sessionId),
  stopCheckpointWatching: () => ipcRenderer.invoke('checkpoint:stop-watching'),
  // 创建/回滚 checkpoint
  createFileCheckpoint: (sessionId, label) => ipcRenderer.invoke('checkpoint:create', sessionId, label),
  rollbackToFileCheckpoint: (checkpointId) => ipcRenderer.invoke('checkpoint:rollback', checkpointId),
  // 获取 checkpoint 列表和当前变更
  getFileCheckpoints: (limit, sessionId) => ipcRenderer.invoke('checkpoint:list', limit, sessionId),
  getCurrentChangeStats: () => ipcRenderer.invoke('checkpoint:get-stats'),
  getCurrentChanges: () => ipcRenderer.invoke('checkpoint:get-changes'),
  // 开关控制
  setCheckpointEnabled: (enabled) => ipcRenderer.invoke('checkpoint:set-enabled', enabled),
  isCheckpointEnabled: () => ipcRenderer.invoke('checkpoint:is-enabled'),
  // 清理
  cleanupFileCheckpoints: () => ipcRenderer.invoke('checkpoint:cleanup'),

  // ==================== Workspace 外部 fs watcher ====================
  // 用户在 Finder 等系统文件管理器手动改文件时, 让文件树自动刷新.
  // main: @parcel/watcher (失败才 chokidar polling), 推 'workspace:fs-event' 回 renderer.
  workspaceWatchStart: (root) => ipcRenderer.invoke('workspace:watch-start', root),
  workspaceWatchStop: () => ipcRenderer.invoke('workspace:watch-stop'),
  /** 工作区被切换 (含直接调 workspace:set 的非 UI 路径) — AppShell 据此同步 renderer 状态 */
  onWorkspaceChanged: (handler) => {
    const listener = (_e, ws) => handler(ws);
    ipcRenderer.on('neox:workspace-changed', listener);
    return () => ipcRenderer.removeListener('neox:workspace-changed', listener);
  },
  onWorkspaceFsEvent: (callback) => {
    preloadLog('listener-attach', `onWorkspaceFsEvent called, will wrap callback`);
    const listener = (_event, payload) => {
      preloadLog('listener-fire', `dispatching to renderer callback kind=${payload?.kind}`);
      try {
        callback(payload);
        preloadLog('listener-fire-ok', `callback returned without throw`);
      } catch (e) {
        preloadLog('listener-fire-error', `callback threw: ${e?.message || String(e)}`);
      }
    };
    ipcRenderer.on('workspace:fs-event', listener);
    return () => ipcRenderer.removeListener('workspace:fs-event', listener);
  },

  // ==================== 终端服务 (xterm.js + node-pty) ====================
  terminalCreate: (options) => ipcRenderer.invoke('terminal:create', options),
  terminalWrite: (sessionId, data) => ipcRenderer.invoke('terminal:write', sessionId, data),
  terminalResize: (sessionId, cols, rows) => ipcRenderer.invoke('terminal:resize', sessionId, cols, rows),
  terminalDestroy: (sessionId) => ipcRenderer.invoke('terminal:destroy', sessionId),
  terminalExecute: (sessionId, command, timeout) => ipcRenderer.invoke('terminal:execute', sessionId, command, timeout),
  onTerminalData: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onTerminalExit: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  },
  onTerminalRequest: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('terminal:request', listener);
    return () => ipcRenderer.removeListener('terminal:request', listener);
  },
  terminalRequestComplete: (requestId, result) =>
    ipcRenderer.invoke('terminal:request-complete', requestId, result),

  // IDE diagnostics (Monaco markers) — main → renderer → complete
  onDiagnosticsRequest: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('editor:diagnostics-request', listener);
    return () => ipcRenderer.removeListener('editor:diagnostics-request', listener);
  },
  diagnosticsRequestComplete: (requestId, result) =>
    ipcRenderer.invoke('editor:diagnostics-complete', requestId, result),

  // ==================== 调试服务 (Debug Service) ====================
  debugAddBreakpoint: (breakpoint) => ipcRenderer.invoke('debug:add-breakpoint', breakpoint),
  debugRemoveBreakpoint: (fileOrId, line) => ipcRenderer.invoke('debug:remove-breakpoint', fileOrId, line),
  debugToggleBreakpoint: (file, line) => ipcRenderer.invoke('debug:toggle-breakpoint', file, line),
  debugGetBreakpoints: (file) => ipcRenderer.invoke('debug:get-breakpoints', file),
  debugClearBreakpoints: (file, source) => ipcRenderer.invoke('debug:clear-breakpoints', file, source),
  debugStartSession: (config) => ipcRenderer.invoke('debug:start-session', config),
  debugStopSession: (sessionId) => ipcRenderer.invoke('debug:stop-session', sessionId),
  debugContinue: (sessionId) => ipcRenderer.invoke('debug:continue', sessionId),
  debugStepOver: (sessionId) => ipcRenderer.invoke('debug:step-over', sessionId),
  debugStepInto: (sessionId) => ipcRenderer.invoke('debug:step-into', sessionId),
  debugStepOut: (sessionId) => ipcRenderer.invoke('debug:step-out', sessionId),
  debugPause: (sessionId) => ipcRenderer.invoke('debug:pause', sessionId),
  debugEvaluate: (sessionId, expression, frameId) => ipcRenderer.invoke('debug:evaluate', sessionId, expression, frameId),
  debugGetVariables: (sessionId, frameId) => ipcRenderer.invoke('debug:get-variables', sessionId, frameId),
  debugGetStackTrace: (sessionId) => ipcRenderer.invoke('debug:get-stack-trace', sessionId),
  onDebugEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('debug:event', listener);
    return () => ipcRenderer.removeListener('debug:event', listener);
  },
  // Legacy compat aliases
  debugSetBreakpoint: (file, line, enabled) => ipcRenderer.invoke('debug:add-breakpoint', { file, line, enabled: enabled ?? true, source: 'user' }),
  debugStop: (sessionId) => ipcRenderer.invoke('debug:stop-session', sessionId),

  // ==================== Debug Session (M0+: 真实会话, DebuggerManager + JvmDapBackend) ====================
  // 老的 debug:start-session/continue/... 是 stub, 新代码请用 debug:session-* 这一套
  debugSessionStart: (config) => ipcRenderer.invoke('debug:session-start', config),
  debugSessionDisconnect: (sessionId, terminate) => ipcRenderer.invoke('debug:session-disconnect', sessionId, terminate),
  debugSessionList: () => ipcRenderer.invoke('debug:session-list'),
  debugSessionResume: (sessionId, threadId) => ipcRenderer.invoke('debug:session-resume', sessionId, threadId),
  debugSessionPause: (sessionId, threadId) => ipcRenderer.invoke('debug:session-pause', sessionId, threadId),
  debugSessionStepOver: (sessionId, threadId) => ipcRenderer.invoke('debug:session-step-over', sessionId, threadId),
  debugSessionStepInto: (sessionId, threadId) => ipcRenderer.invoke('debug:session-step-into', sessionId, threadId),
  debugSessionStepOut: (sessionId, threadId) => ipcRenderer.invoke('debug:session-step-out', sessionId, threadId),
  debugSessionThreads: (sessionId) => ipcRenderer.invoke('debug:session-threads', sessionId),
  debugSessionStackTrace: (sessionId, threadId) => ipcRenderer.invoke('debug:session-stack-trace', sessionId, threadId),
  debugSessionScopes: (sessionId, frameId) => ipcRenderer.invoke('debug:session-scopes', sessionId, frameId),
  debugSessionVariables: (sessionId, variablesReference) => ipcRenderer.invoke('debug:session-variables', sessionId, variablesReference),
  debugSessionEvaluate: (sessionId, expression, frameId) => ipcRenderer.invoke('debug:session-evaluate', sessionId, expression, frameId),
  debugSessionSetLineBreakpoints: (sessionId, file, breakpoints) => ipcRenderer.invoke('debug:session-set-line-breakpoints', sessionId, file, breakpoints),
  /** 收 main → renderer 推送的会话事件 (session-added/removed/status-changed/event). 返回 dispose. */
  onDebugSessionEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('debug:session-event', listener);
    return () => ipcRenderer.removeListener('debug:session-event', listener);
  },

  // ==================== MCP 服务器管理 ====================
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpGetEnabled: () => ipcRenderer.invoke('mcp:get-enabled'),
  mcpSetEnabled: (enabled) => ipcRenderer.invoke('mcp:set-enabled', enabled),
  mcpAdd: (scope, server) => ipcRenderer.invoke('mcp:add', scope, server),
  mcpRemove: (scope, serverId) => ipcRenderer.invoke('mcp:remove', scope, serverId),
  mcpUpdate: (scope, serverId, updates) => ipcRenderer.invoke('mcp:update', scope, serverId, updates),
  mcpConnect: (serverId) => ipcRenderer.invoke('mcp:connect', serverId),
  mcpDisconnect: (serverId) => ipcRenderer.invoke('mcp:disconnect', serverId),
  mcpTest: (serverId) => ipcRenderer.invoke('mcp:test', serverId),
  mcpGetTools: (serverId) => ipcRenderer.invoke('mcp:get-tools', serverId),
  mcpTrust: (serverId, trust) => ipcRenderer.invoke('mcp:trust', serverId, trust),

  // ==================== 自动化 (定时任务) ====================
  automationsList: (extraRoots) => ipcRenderer.invoke('automations:list', extraRoots),
  automationsDelete: (root, id) => ipcRenderer.invoke('automations:delete', root, id),

  // ==================== Skills 管理 ====================
  skillsList: (options) => ipcRenderer.invoke('skills:list', options),
  skillsGet: (skillId) => ipcRenderer.invoke('skills:get', skillId),
  skillsRefresh: () => ipcRenderer.invoke('skills:refresh'),
  skillsCreate: (options) => ipcRenderer.invoke('skills:create', options),
  skillsDelete: (skillId) => ipcRenderer.invoke('skills:delete', skillId),
  skillsImportUrl: (url, target) => ipcRenderer.invoke('skills:import-url', url, target),
  skillsImportPath: (sourcePath, target, mode) => ipcRenderer.invoke('skills:import-path', sourcePath, target, mode),
  skillsDiscoverExternal: () => ipcRenderer.invoke('skills:discover-external'),

  /* 迁移 (Claude Code / Codex / Cursor -> Neox). scan 只读, apply 才写盘。 */
  migrateScan: () => ipcRenderer.invoke('migrate:scan'),
  migrateApply: (payload) => ipcRenderer.invoke('migrate:apply', payload),
  /* 只扫 MCP (设置 → MCP → 从本机导入), 不读历史会话 */
  migrateScanMcp: () => ipcRenderer.invoke('migrate:scan-mcp'),
  /* BYOK 检测 —— 只有用户按按钮才会走到这里, 没有自动触发路径 */
  migrateScanProviders: () => ipcRenderer.invoke('migrate:scan-providers'),
  migrateImportProviders: (payload) => ipcRenderer.invoke('migrate:import-providers', payload),
  skillsReadRaw: (skillId) => ipcRenderer.invoke('skills:read-raw', skillId),
  skillsWriteContent: (skillId, content) => ipcRenderer.invoke('skills:write-content', skillId, content),
  skillsGetDirs: () => ipcRenderer.invoke('skills:get-dirs'),
  skillsGetHistory: () => ipcRenderer.invoke('skills:get-history'),
  skillsClearHistory: () => ipcRenderer.invoke('skills:clear-history'),
  /* K4-MVP: 商店安装 lifecycle */
  skillsInstall: (url, options) => ipcRenderer.invoke('skills:install', url, options),
  skillsPreviewInstall: (url) => ipcRenderer.invoke('skills:preview-install', url),
  skillsUpdate: (skillId) => ipcRenderer.invoke('skills:update', skillId),
  skillsUninstall: (skillId) => ipcRenderer.invoke('skills:uninstall', skillId),
  skillsTrust: (skillId) => ipcRenderer.invoke('skills:trust', skillId),
  skillsUntrust: (skillId) => ipcRenderer.invoke('skills:untrust', skillId),
  skillsListInstalled: () => ipcRenderer.invoke('skills:list-installed'),

  // ==================== 代码索引管理 ====================
  indexGetStats: () => ipcRenderer.invoke('index:get-stats'),
  indexBuild: (force) => ipcRenderer.invoke('index:build', force),
  indexClear: () => ipcRenderer.invoke('index:clear'),
  indexSearch: (query, kind, limit) => ipcRenderer.invoke('index:search', query, kind, limit),
  indexGetConfig: () => ipcRenderer.invoke('index:get-config'),
  indexSetConfig: (config) => ipcRenderer.invoke('index:set-config', config),
  onIndexProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('index:progress', listener);
    return () => ipcRenderer.removeListener('index:progress', listener);
  },

  // ==================== 知识库 (文档路径引用 manifest) ====================
  knowledgeListDocs: () => ipcRenderer.invoke('knowledge:list-docs'),
  knowledgeAddDocs: (docs) => ipcRenderer.invoke('knowledge:add-docs', docs),
  knowledgeRemoveDoc: (id) => ipcRenderer.invoke('knowledge:remove-doc', id),
  knowledgeListCards: () => ipcRenderer.invoke('knowledge:list-cards'),
  knowledgeReadCard: (id) => ipcRenderer.invoke('knowledge:read-card', id),
  knowledgeSetCardTrust: (id, trust) => ipcRenderer.invoke('knowledge:set-card-trust', id, trust),
  knowledgeDeleteCard: (id) => ipcRenderer.invoke('knowledge:delete-card', id),
  knowledgeSetCardAlways: (id, always) => ipcRenderer.invoke('knowledge:set-card-always', id, always),
  knowledgeUpdateCardMeta: (id, updates) => ipcRenderer.invoke('knowledge:update-card-meta', id, updates),
  knowledgeRefreshDoc: (id, newFileId) => ipcRenderer.invoke('knowledge:refresh-doc', id, newFileId),
  knowledgeCurationConfigGet: () => ipcRenderer.invoke('knowledge:curation-config-get'),
  knowledgeCurationConfigSet: (updates) => ipcRenderer.invoke('knowledge:curation-config-set', updates),
  knowledgeCurationLogGet: () => ipcRenderer.invoke('knowledge:curation-log-get'),
  knowledgeCurationLogAppend: (entry) => ipcRenderer.invoke('knowledge:curation-log-append', entry),

  // ==================== 记忆系统管理 ====================
  memoryGetStats: () => ipcRenderer.invoke('memory:get-stats'),
  memoryGetConfig: () => ipcRenderer.invoke('memory:get-config'),
  memorySetConfig: (config) => ipcRenderer.invoke('memory:set-config', config),
  memoryGetInjectionPreview: () => ipcRenderer.invoke('memory:get-injection-preview'),
  memoryBrowse: (options) => ipcRenderer.invoke('memory:browse', options),
  memoryClear: (type) => ipcRenderer.invoke('memory:clear', type),
  memoryDelete: (id) => ipcRenderer.invoke('memory:delete', id),
  memoryDiscoverExternal: () => ipcRenderer.invoke('memory:discover-external'),
  memoryImportExternal: (keys) => ipcRenderer.invoke('memory:import-external', keys),

  // ==================== 上下文管理 ====================
  contextGetUsage: (sessionId) => ipcRenderer.invoke('context:get-usage', sessionId),
  contextGetConfig: () => ipcRenderer.invoke('context:get-config'),
  contextSetConfig: (config) => ipcRenderer.invoke('context:set-config', config),
  contextTriggerCompaction: (sessionId) => ipcRenderer.invoke('context:trigger-compaction', sessionId),
  outputStyleList: () => ipcRenderer.invoke('output-style:list'),
  outputStyleSet: (id) => ipcRenderer.invoke('output-style:set', id),
  diagnosticsSummary: (hours) => ipcRenderer.invoke('diagnostics:summary', hours),
  shareGetConfig: () => ipcRenderer.invoke('share:get-config'),
  shareSetConfig: (cfg) => ipcRenderer.invoke('share:set-config', cfg),
  shareTest: () => ipcRenderer.invoke('share:test'),


  // ==================== 模型定价配置 ====================
  pricingGetAll: () => ipcRenderer.invoke('pricing:get-all'),
  pricingSetAll: (pricing) => ipcRenderer.invoke('pricing:set-all', pricing),
  pricingUpsert: (pricing) => ipcRenderer.invoke('pricing:upsert', pricing),
  pricingDelete: (pattern) => ipcRenderer.invoke('pricing:delete', pattern),

  // ==================== TTS 语音管理 ====================
  ttsGetConfig: () => ipcRenderer.invoke('tts:get-config'),
  ttsSpeak: (text, voice) => ipcRenderer.invoke('tts:speak', text, voice),
  ttsSetConfig: (updates) => ipcRenderer.invoke('tts:set-config', updates),
  ttsSetEnabled: (enabled) => ipcRenderer.invoke('tts:set-enabled', enabled),

  pilotCallCurrent: () => ipcRenderer.invoke('pilot-call:current'),
  pilotCallAction: (action) => ipcRenderer.invoke('pilot-call:action', action),
  pilotCallStartOutgoing: (sessionId) => ipcRenderer.invoke('pilot-call:start-outgoing', sessionId),
  pilotCallReport: (report) => ipcRenderer.send('pilot-call:report', report),
  pilotCallLog: () => ipcRenderer.invoke('pilot-call:log'),
  pilotCallTestRing: (req) => ipcRenderer.invoke('pilot-call:test-ring', req),
  /* 这个账号开通了 Pilot 没有 (Pilot 住在云端, 没开通的账号不显示 Pilot 模式) */
  pilotAvailable: () => ipcRenderer.invoke('pilot:available'),
  pilotProfiles: () => ipcRenderer.invoke('pilot:profiles'),
  pilotGetSettings: () => ipcRenderer.invoke('pilot:get-settings'),
  pilotSaveSettings: (next) => ipcRenderer.invoke('pilot:save-settings', next),
  pilotSaveProfile: (sessionId, patch) => ipcRenderer.invoke('pilot:save-profile', sessionId, patch),
  pilotTelegramStatus: () => ipcRenderer.invoke('pilot:telegram-status'),
  pilotTelegramSetToken: (token) => ipcRenderer.invoke('pilot:telegram-set-token', token),
  pilotTelegramPair: () => ipcRenderer.invoke('pilot:telegram-pair'),
  pilotTelegramDisconnect: () => ipcRenderer.invoke('pilot:telegram-disconnect'),
  /* 汇报账本 (report_to_user) */
  pilotReports: () => ipcRenderer.invoke('pilot:reports'),
  pilotReportsRead: (sessionId) => ipcRenderer.invoke('pilot:reports-read', sessionId),
  pilotSyncHistory: (sessionId) => ipcRenderer.invoke('pilot:sync-history', sessionId),
  pilotReminders: (sessionId) => ipcRenderer.invoke('pilot:reminders', sessionId),
  pilotCancelReminder: (reminderId) => ipcRenderer.invoke('pilot:cancel-reminder', reminderId),
  pilotAddReminder: (sessionId, r) => ipcRenderer.invoke('pilot:add-reminder', sessionId, r),
  pilotMemories: (sessionId) => ipcRenderer.invoke('pilot:memories', sessionId),
  pilotAddMemory: (sessionId, text) => ipcRenderer.invoke('pilot:add-memory', sessionId, text),
  pilotForgetMemory: (memoryId) => ipcRenderer.invoke('pilot:forget-memory', memoryId),
  pilotFiles: (sessionId, path) => ipcRenderer.invoke('pilot:files', sessionId, path),
  pilotOpenFile: (sessionId, path, mode) => ipcRenderer.invoke('pilot:open-file', sessionId, path, mode),
  pilotPlaces: (q, lang) => ipcRenderer.invoke('pilot:places', q, lang),
  pilotWeather: (lat, lng) => ipcRenderer.invoke('pilot:weather', lat, lng),
  pilotReportAnswer: (id, answer) => ipcRenderer.invoke('pilot:report-answer', id, answer),
  pilotActions: (sessionId) => ipcRenderer.invoke('pilot:actions', sessionId),
  /* 这台电脑当 Pilot 的节点 —— 「连接」页 (商业版 cloud-session/pilotNodeIpc.ts) */
  pilotNodeStatus: () => ipcRenderer.invoke('pilot-node:status'),
  pilotNodeSetSource: (key, on) => ipcRenderer.invoke('pilot-node:set-source', key, on),
  pilotNodeSetActions: (on) => ipcRenderer.invoke('pilot-node:set-actions', on),
  pilotNodeSyncNow: (key) => ipcRenderer.invoke('pilot-node:sync-now', key),
  pilotNodeForget: (key) => ipcRenderer.invoke('pilot-node:forget', key),
  pilotNodeOpenPrivacy: (which) => ipcRenderer.invoke('pilot-node:open-privacy', which),
  onPilotReportsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('pilot-report:changed', listener);
    return () => { try { ipcRenderer.off('pilot-report:changed', listener); } catch { /* ignore */ } };
  },
  /* state / incoming / connect / end / log-changed / open-session */
  onPilotCall: (event, callback) => {
    const channels = ['state', 'incoming', 'connect', 'end', 'log-changed', 'open-session'];
    if (!channels.includes(event)) return () => {};
    const channel = `pilot-call:${event}`;
    const listener = (_e, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => { try { ipcRenderer.off(channel, listener); } catch { /* ignore */ } };
  },

  // ==================== 本地语音引擎 (Mac, 模型插件式下载) ====================
  localvoiceStatus: () => ipcRenderer.invoke('localvoice:status'),
  localvoiceDownload: (id, source) => ipcRenderer.invoke('localvoice:download', id, source),
  localvoiceRemove: (id) => ipcRenderer.invoke('localvoice:remove', id),
  localvoicePause: (id) => ipcRenderer.invoke('localvoice:pause', id),
  localvoiceImportModel: () => ipcRenderer.invoke('localvoice:import-model'),
  onLocalvoiceProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('localvoice:progress', listener);
    return () => ipcRenderer.removeListener('localvoice:progress', listener);
  },
  // ==================== 可选原生引擎包 (按需下载, 见 services/assetPackService.ts) ====
  assetpackStatus: () => ipcRenderer.invoke('assetpack:status'),
  assetpackDownload: (id) => ipcRenderer.invoke('assetpack:download', id),
  assetpackCancel: (id) => ipcRenderer.invoke('assetpack:cancel', id),
  assetpackRemove: (id) => ipcRenderer.invoke('assetpack:remove', id),
  onAssetpackProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('assetpack:progress', listener);
    return () => ipcRenderer.removeListener('assetpack:progress', listener);
  },
  // ==================== 声纹锁 (嘈杂环境 L2, 全本地 CAM++ ONNX) ====================
  voiceprintStatus: () => ipcRenderer.invoke('voiceprint:status'),
  voiceprintEnroll: (pcmBase64) => ipcRenderer.invoke('voiceprint:enroll', pcmBase64),
  voiceprintVerify: (pcmBase64) => ipcRenderer.invoke('voiceprint:verify', pcmBase64),
  voiceprintClear: () => ipcRenderer.invoke('voiceprint:clear'),
  // ==================== 个人档案 (设置·个人信息页, 免登录本地文件) ====================
  profileGet: (scope) => ipcRenderer.invoke('profile:get', scope),
  profileSet: (scope, content) => ipcRenderer.invoke('profile:set', scope, content),
  // ==================== STT 语音识别 (输入框语音按钮) ====================
  sttTranscribe: (audioBase64, format) => ipcRenderer.invoke('stt:transcribe', audioBase64, format),
  sttGetConfig: () => ipcRenderer.invoke('stt:get-config'),
  voiceRevealSecret: (section, field) => ipcRenderer.invoke('voice:reveal-secret', section, field),
  sttSetConfig: (updates) => ipcRenderer.invoke('stt:set-config', updates),
  // 流式 STT (边说边出字)
  sttStreamStart: (model) => ipcRenderer.invoke('stt:stream-start', model),
  sttStreamAudio: (streamId, chunk) => ipcRenderer.send('stt:stream-audio', streamId, chunk),
  sttStreamStop: (streamId) => ipcRenderer.invoke('stt:stream-stop', streamId),
  onSttStreamEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('stt:stream-event', listener);
    return () => ipcRenderer.removeListener('stt:stream-event', listener);
  },
  /* 探询主进程当前哪些 STT provider 可用 (official/xfyun/custom/local), 供前端错误引导 */
  sttProbeProviders: () => ipcRenderer.invoke('stt:probe-providers'),

  wakeWordGetState: () => ipcRenderer.invoke('wake-word:get-state'),
  wakeWordSetConfig: (cfg) => ipcRenderer.invoke('wake-word:set-config', cfg),
  wakeWordSubscribe: () => ipcRenderer.invoke('wake-word:subscribe'),
  onWakeWordEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('wake-word:event', listener);
    return () => ipcRenderer.removeListener('wake-word:event', listener);
  },

  // ==================== 实验性功能 ====================
  experimentalGetConfig: () => ipcRenderer.invoke('experimental:get-config'),
  experimentalSetConfig: (updates) => ipcRenderer.invoke('experimental:set-config', updates),
  experimentalJevTest: (apiKey) => ipcRenderer.invoke('experimental:jev-test', apiKey),
  jevPrefetch: (text) => ipcRenderer.invoke('jev:prefetch', text),

  // ==================== 用途模式 (assistant 生活 / work 工作 / code 编码) ====================
  agentModeGetDefault: () => ipcRenderer.invoke('agent-mode:get-default'),
  agentModeSetDefault: (mode) => ipcRenderer.invoke('agent-mode:set-default', mode),
  agentModeSaveProfile: (mode, markdown) => ipcRenderer.invoke('agent-mode:save-profile', mode, markdown),
  agentModeReadProfile: (mode) => ipcRenderer.invoke('agent-mode:read-profile', mode),
  agentModeEnsureHome: (mode) => ipcRenderer.invoke('agent-mode:ensure-home', mode),
  /* Work 项目 (工作/<项目>/ 文件夹 + .neox-project.json) */
  workProjectList: () => ipcRenderer.invoke('work-project:list'),
  workProjectCreate: (name) => ipcRenderer.invoke('work-project:create', name),
  workProjectUpdate: (dir, patch) => ipcRenderer.invoke('work-project:update', dir, patch),
  workProjectAssignTask: (sessionId, dir) => ipcRenderer.invoke('work-project:assign-task', sessionId, dir),
  workProjectDetail: (dir) => ipcRenderer.invoke('work-project:detail', dir),
  workProjectSaveNotes: (dir, notes) => ipcRenderer.invoke('work-project:save-notes', dir, notes),
  workProjectSaveProfile: (dir, profile) => ipcRenderer.invoke('work-project:save-profile', dir, profile),
  workProjectAddMaterials: (dir, paths) => ipcRenderer.invoke('work-project:add-materials', dir, paths),
  codeProjectCreate: (name) => ipcRenderer.invoke('code-project:create', name),

  sessionBackfillAgentModes: () => ipcRenderer.invoke('session:backfill-agent-modes'),

  voiceConfigGet: () => ipcRenderer.invoke('voice-config:get'),
  voiceConfigSet: (patch) => ipcRenderer.invoke('voice-config:set', patch),

  // ==================== Life Events (outcome/reminder/brief_hint 共享基座) ====================
  lifeEvents: {
    create: (input) => ipcRenderer.invoke('life-events:create', input),
    transition: (id, toStatus, reason) => ipcRenderer.invoke('life-events:transition', id, toStatus, reason),
    update: (id, patch) => ipcRenderer.invoke('life-events:update', id, patch),
    delete: (id) => ipcRenderer.invoke('life-events:delete', id),
    get: (id) => ipcRenderer.invoke('life-events:get', id),
    listByKind: (kind, opts) => ipcRenderer.invoke('life-events:list-by-kind', kind, opts),
    listDueReminders: (before) => ipcRenderer.invoke('life-events:list-due-reminders', before),
    listForBrief: (now) => ipcRenderer.invoke('life-events:list-for-brief', now),
    listForSession: (sessionId) => ipcRenderer.invoke('life-events:list-for-session', sessionId),
    transitions: (id) => ipcRenderer.invoke('life-events:transitions', id),
    /* 订阅变更: renderer 传 callback, 返回 unsubscribe. 底层用 on 走 IPC 广播. */
    onChanged: (callback) => {
      const listener = () => { try { callback(); } catch (e) { console.error('[lifeEvents.onChanged] handler error:', e); } };
      ipcRenderer.on('life-events:changed', listener);
      return () => { try { ipcRenderer.off('life-events:changed', listener); } catch { /* ignore */ } };
    },
    /* 用户点击 reminder 通知时触发. main 广播 'life-reminder:activated' 带 {eventId, sessionId, title, context}. */
    onReminderActivated: (callback) => {
      const listener = (_event, payload) => { try { callback(payload); } catch (e) { console.error('[lifeEvents.onReminderActivated] handler error:', e); } };
      ipcRenderer.on('life-reminder:activated', listener);
      return () => { try { ipcRenderer.off('life-reminder:activated', listener); } catch { /* ignore */ } };
    },
    onReminderFired: (callback) => {
      const listener = (_event, payload) => { try { callback(payload); } catch (e) { console.error('[lifeEvents.onReminderFired] handler error:', e); } };
      ipcRenderer.on('life-reminder:fired', listener);
      return () => { try { ipcRenderer.off('life-reminder:fired', listener); } catch { /* ignore */ } };
    },
    /* 调试用: 立刻扫一次 due (跳过 30s tick 等待) */
    debugFlushDueReminders: () => ipcRenderer.invoke('life-reminder:debug-flush'),
  },

  // ==================== Supervisor 配置 ====================
  supervisorGetConfig: () => ipcRenderer.invoke('supervisor:get-config'),
  supervisorSetConfig: (updates) => ipcRenderer.invoke('supervisor:set-config', updates),

  // ==================== 窗口控制 (自绘 min/max/close · Win) ====================
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximizeToggle: () => ipcRenderer.invoke('window:maximize-toggle'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  /** 窗口全屏状态。macOS 原生全屏在 renderer 侧完全不可见, 只能靠主进程推。 */
  onWindowFullScreenChanged: (callback) => {
    const listener = (_e, full) => {
      try { callback(!!full); } catch (e) { console.error('[onWindowFullScreenChanged]', e); }
    };
    ipcRenderer.on('window:fullscreen-changed', listener);
    return () => { try { ipcRenderer.off('window:fullscreen-changed', listener); } catch { /* ignore */ } };
  },

  onWindowMaximizedChanged: (callback) => {
    const listener = (_event, maximized) => {
      try { callback(!!maximized); } catch (e) { console.error('[onWindowMaximizedChanged]', e); }
    };
    ipcRenderer.on('window:maximized-changed', listener);
    return () => { try { ipcRenderer.off('window:maximized-changed', listener); } catch { /* ignore */ } };
  },

  // ==================== Surface 标签拖出来的独立窗口 (主进程 surfacePopouts.ts) ====================
  /** 挪动 / 停下 / 关掉 / 收起状态变化, 由主进程推 (renderer 不轮询窗口位置) */
  onSurfacePopoutEvent: (callback) => {
    const listener = (_e, payload) => {
      try { callback(payload); } catch (e) { console.error('[onSurfacePopoutEvent]', e); }
    };
    ipcRenderer.on('surface-popout:event', listener);
    return () => { try { ipcRenderer.off('surface-popout:event', listener); } catch { /* ignore */ } };
  },
  surfacePopoutPeek: (name, on) => ipcRenderer.invoke('surface-popout:peek', name, on),
  surfacePopoutUntuck: (name) => ipcRenderer.invoke('surface-popout:untuck', name),
  surfacePopoutTuck: (name) => ipcRenderer.invoke('surface-popout:tuck', name),
  surfacePopoutPin: (name, on) => ipcRenderer.invoke('surface-popout:pin', name, on),

  // ==================== RunConfig (运行配置) ====================
  runconfigGet: () => ipcRenderer.invoke('runconfig:get'),
  runconfigSetModeConfig: (mode, config) => ipcRenderer.invoke('runconfig:set-mode-config', mode, config),
  getOrganizationConfigStatus: () => ipcRenderer.invoke('organization:get-status'),
  createOrganizationDefaultConfig: () => ipcRenderer.invoke('organization:create-default-config'),

  // ==================== Agent 运行模式 ====================
  getRunMode: () => ipcRenderer.invoke('config:get-run-mode'),
  setRunMode: (mode) => ipcRenderer.invoke('config:set-run-mode', mode),

  // ==================== 协作模式配置 ====================
  getCollabConfig: () => ipcRenderer.invoke('config:get-assistant-config'),
  setCollabConfig: (updates) => ipcRenderer.invoke('config:set-assistant-config', updates),
  getAssistantConfig: () => ipcRenderer.invoke('config:get-assistant-config'),
  setAssistantConfig: (config) => ipcRenderer.invoke('config:set-assistant-config', config),

  getMainAgent: () => ipcRenderer.invoke('config:get-main-agent'),
  setMainAgent: (agent) => ipcRenderer.invoke('config:set-main-agent', agent),
  getWorkerPool: () => ipcRenderer.invoke('config:get-worker-pool'),
  setWorkerPool: (pool) => ipcRenderer.invoke('config:set-worker-pool', pool),
  addWorkerToPool: (worker) => ipcRenderer.invoke('config:add-worker-to-pool', worker),
  removeWorkerFromPool: (providerId, model) => ipcRenderer.invoke('config:remove-worker-from-pool', providerId, model),
  // CCB review mode is a team capability (ccb_review), not a standalone config toggle.
  // Removed dead getCCBReviewMode / setCCBReviewMode — no IPC handlers existed for them.

  // ==================== 通知声音管理 ====================
  listAvailableSounds: () => ipcRenderer.invoke('sound:list-available'),
  playSound: (soundId) => ipcRenderer.invoke('sound:play', soundId),
  /** 主进程发系统通知 — 走 Electron Notification 跟 app identity 绑定.
   *  dev 模式 macOS 显示 "Electron" 是 framework 限制, 打包后会是 "Neox". */
  notifyShow: (opts) => ipcRenderer.invoke('notify:show', opts),
  notifySetLifePrefs: (prefs) => ipcRenderer.invoke('notify:set-life-prefs', prefs),

  // ==================== 进程管理 ====================
  processList: () => ipcRenderer.invoke('process:list'),
  processGetOutput: (pid) => ipcRenderer.invoke('process:get-output', pid),
  processKill: (pid) => ipcRenderer.invoke('process:kill', pid),
  processKillAll: () => ipcRenderer.invoke('process:kill-all'),
  processUntrack: (pid) => ipcRenderer.invoke('process:untrack', pid),

  // ==================== 浏览器 (Browser Surface) ====================
  // 终选方案: BrowserView (OS native view, agent CDP 直接可见, 视觉完美嵌入).
  // DOM overlay 弹出时通过 suppress/capture + DOM 端 fade overlay 做平滑过渡.
  // 详见 内部设计文档.
  embeddedBrowserMount:         (payload) => ipcRenderer.invoke('embedded-browser:mount', payload),
  embeddedBrowserSetBounds:     (payload) => ipcRenderer.invoke('embedded-browser:set-bounds', payload),
  embeddedBrowserBringToFront:  (payload) => ipcRenderer.invoke('embedded-browser:bring-to-front', payload),
  embeddedBrowserHide:          (payload) => ipcRenderer.invoke('embedded-browser:hide', payload),
  embeddedBrowserShow:          (payload) => ipcRenderer.invoke('embedded-browser:show', payload),
  embeddedBrowserNavigate:      (payload) => ipcRenderer.invoke('embedded-browser:navigate', payload),
  embeddedBrowserBack:          (payload) => ipcRenderer.invoke('embedded-browser:back', payload),
  embeddedBrowserForward:       (payload) => ipcRenderer.invoke('embedded-browser:forward', payload),
  embeddedBrowserReload:        (payload) => ipcRenderer.invoke('embedded-browser:reload', payload),
  embeddedBrowserGetState:      (payload) => ipcRenderer.invoke('embedded-browser:get-state', payload),
  embeddedBrowserToggleDevTools:(payload) => ipcRenderer.invoke('embedded-browser:toggle-devtools', payload),
  embeddedBrowserCapture:       (payload) => ipcRenderer.invoke('embedded-browser:capture', payload),
  embeddedBrowserDestroy:       (payload) => ipcRenderer.invoke('embedded-browser:destroy', payload),
  embeddedBrowserList:          ()        => ipcRenderer.invoke('embedded-browser:list'),
  embeddedBrowserSuppress:      (payload) => ipcRenderer.invoke('embedded-browser:suppress', payload),
  embeddedBrowserRestore:       (payload) => ipcRenderer.invoke('embedded-browser:restore', payload),
  embeddedBrowserSuppressAll:   ()        => ipcRenderer.invoke('embedded-browser:suppress-all'),
  embeddedBrowserRestoreAll:    ()        => ipcRenderer.invoke('embedded-browser:restore-all'),

  // ==================== Browser Mode 查询 + 外置 Chrome 控制 ====================
  // renderer 侧 WebSurfaceViewer 读 mode 决定是不是要 mount BrowserView.
  browserModeGet:          ()        => ipcRenderer.invoke('browser-mode:get'),
  startupWaitReady:        ()        => ipcRenderer.invoke('startup:wait-ready'),
  externalChromeEnsure:    (payload) => ipcRenderer.invoke('external-chrome:ensure', payload),
  externalChromeStatus:    ()        => ipcRenderer.invoke('external-chrome:status'),
  linkPreview:             (url)     => ipcRenderer.invoke('link:preview', url),
  externalChromeShutdown:  ()        => ipcRenderer.invoke('external-chrome:shutdown'),
  externalChromeFocus:     ()        => ipcRenderer.invoke('external-chrome:focus'),

  // ==================== Agent 工具 (走 server, Playwright connectOverCDP) ====================
  // 基础: navigate / screenshot / get-state
  browserToolNavigate:   (payload) => ipcRenderer.invoke('browser-tool:navigate', payload),
  browserToolScreenshot: (payload) => ipcRenderer.invoke('browser-tool:screenshot', payload),
  browserToolGetState:   (payload) => ipcRenderer.invoke('browser-tool:get-state', payload),

  // B Day 3: DOM 感知 + 交互
  browserToolGetAriaTree: (payload) => ipcRenderer.invoke('browser-tool:get-aria-tree', payload),
  browserToolQuery:       (payload) => ipcRenderer.invoke('browser-tool:query', payload),
  browserToolGetText:     (payload) => ipcRenderer.invoke('browser-tool:get-text', payload),
  browserToolClick:       (payload) => ipcRenderer.invoke('browser-tool:click', payload),
  browserToolType:        (payload) => ipcRenderer.invoke('browser-tool:type', payload),
  browserToolPressKey:    (payload) => ipcRenderer.invoke('browser-tool:press-key', payload),
  browserToolScroll:      (payload) => ipcRenderer.invoke('browser-tool:scroll', payload),
  browserToolHover:       (payload) => ipcRenderer.invoke('browser-tool:hover', payload),
  browserToolSelectOption:(payload) => ipcRenderer.invoke('browser-tool:select-option', payload),
  browserToolFillForm:    (payload) => ipcRenderer.invoke('browser-tool:fill-form', payload),

  // B Day 4: 等待 + 网络
  browserToolWaitFor:            (payload) => ipcRenderer.invoke('browser-tool:wait-for', payload),
  browserToolWaitForNavigation:  (payload) => ipcRenderer.invoke('browser-tool:wait-for-navigation', payload),
  browserToolGetConsoleLogs:     (payload) => ipcRenderer.invoke('browser-tool:get-console-logs', payload),
  browserToolGetNetwork:         (payload) => ipcRenderer.invoke('browser-tool:get-network', payload),
  browserToolGetResponseBody:    (payload) => ipcRenderer.invoke('browser-tool:get-response-body', payload),

  // B Day 5: 导航补 + 断言 + eval
  browserToolBack:    (payload) => ipcRenderer.invoke('browser-tool:back', payload),
  browserToolForward: (payload) => ipcRenderer.invoke('browser-tool:forward', payload),
  browserToolReload:  (payload) => ipcRenderer.invoke('browser-tool:reload', payload),
  browserToolExpect:  (payload) => ipcRenderer.invoke('browser-tool:expect', payload),
  browserToolEval:    (payload) => ipcRenderer.invoke('browser-tool:eval', payload),

  // C Day 1: cookies / storage
  browserToolGetCookies:      (payload) => ipcRenderer.invoke('browser-tool:get-cookies', payload),
  browserToolSetCookies:      (payload) => ipcRenderer.invoke('browser-tool:set-cookies', payload),
  browserToolClearCookies:    (payload) => ipcRenderer.invoke('browser-tool:clear-cookies', payload),
  browserToolGetLocalStorage: (payload) => ipcRenderer.invoke('browser-tool:get-local-storage', payload),
  browserToolSetLocalStorage: (payload) => ipcRenderer.invoke('browser-tool:set-local-storage', payload),

  // C Day 2: mock + file upload
  browserToolMockResponse:    (payload) => ipcRenderer.invoke('browser-tool:mock-response', payload),
  browserToolClearMocks:      (payload) => ipcRenderer.invoke('browser-tool:clear-mocks', payload),
  browserToolListMocks:       (payload) => ipcRenderer.invoke('browser-tool:list-mocks', payload),
  browserToolSetInputFiles:   (payload) => ipcRenderer.invoke('browser-tool:set-input-files', payload),
  browserToolSetViewport:     (payload) => ipcRenderer.invoke('browser-tool:set-viewport', payload),

  // ==================== 服务治理 (RunConfig + Services panel) ====================
  serviceListConfigs:  (workspaceRoot)         => ipcRenderer.invoke('service:list-configs', workspaceRoot),
  serviceUpsertConfig: (workspaceRoot, config) => ipcRenderer.invoke('service:upsert-config', workspaceRoot, config),
  serviceRemoveConfig: (workspaceRoot, id)     => ipcRenderer.invoke('service:remove-config', workspaceRoot, id),
  serviceBind:         (pid, configId)         => ipcRenderer.invoke('service:bind', pid, configId),
  serviceListHistory:  (workspaceRoot)         => ipcRenderer.invoke('service:list-history', workspaceRoot),
  serviceReadLog:      (pid, startTimeMs)      => ipcRenderer.invoke('service:read-log', pid, startTimeMs),
  serviceScanImportable: (workspaceRoot)       => ipcRenderer.invoke('service:scan-importable', workspaceRoot),
  serviceScanWorkspace:  (workspaceRoot)       => ipcRenderer.invoke('service:scan-workspace', workspaceRoot),
  serviceStartConfig:  (workspaceRoot, configId, sessionId) => ipcRenderer.invoke('service:start-config', workspaceRoot, configId, sessionId),
  serviceSuggestConfig: (workspaceRoot, draft) => ipcRenderer.invoke('service:suggest-config', workspaceRoot, draft),
  serviceProjectInfo: (workspaceRoot, draft) => ipcRenderer.invoke('service:project-info', workspaceRoot, draft),

  // ==================== UI 状态持久化 (SQLite app_state) ====================
  uiStateGetLastSession: (workspaceRoot)             => ipcRenderer.invoke('ui-state:get-last-session', workspaceRoot),
  uiStateSetLastSession: (workspaceRoot, id)         => ipcRenderer.invoke('ui-state:set-last-session', workspaceRoot, id),
  uiStateGetSurfaces:    (sessionId)                 => ipcRenderer.invoke('ui-state:get-surfaces', sessionId),
  uiStateSetSurfaces:    (sessionId, state)          => ipcRenderer.invoke('ui-state:set-surfaces', sessionId, state),
  /* 通用 KV — 任意 UI 偏好都走这, 替换分散 localStorage. key 加 'ui:' 前缀 */
  uiStateGet:            (key)                       => ipcRenderer.invoke('ui-state:get', key),
  uiStateSet:            (key, value)                => ipcRenderer.invoke('ui-state:set', key, value),
  /* P2-1: 服务起来 + autoOpenSurface=true 时主进程派的事件. 注册一个 listener,
   * NeoxRuntimeBridge 收到后派 neox:open-surface 让右栏自动开 web preview. */
  onServicesAutoOpen: (callback) => {
    const handler = (_event, detail) => callback(detail);
    ipcRenderer.on('services:auto-open', handler);
    return () => ipcRenderer.removeListener('services:auto-open', handler);
  },

  agentWakeups: () => ipcRenderer.invoke('agent:wakeups'),
  agentBudgetSnapshot: () => ipcRenderer.invoke('agent:budget-snapshot'),

  getAgentRuntimeConfig: () => ipcRenderer.invoke('config:get-agent-runtime'),
  setAgentRuntimeConfig: (partial) => ipcRenderer.invoke('config:set-agent-runtime', partial),

  getTaskBoard: (sessionId) => ipcRenderer.invoke('taskboard:get-board', sessionId),
  getTaskBoardStats: () => ipcRenderer.invoke('taskboard:get-stats'),
  getTaskBoardTrees: () => ipcRenderer.invoke('taskboard:get-trees'),
  clearTaskBoard: () => ipcRenderer.invoke('taskboard:clear-all'),

  // Rate Limit
  getRateLimitUsage: (provider) => ipcRenderer.invoke('rate-limit:get-usage', provider),
  isRateLimitNearLimit: (provider) => ipcRenderer.invoke('rate-limit:is-near-limit', provider),
  getRateLimitSummary: (provider) => ipcRenderer.invoke('rate-limit:get-summary', provider),

  // ==================== 文件操作 (Monaco Editor) ====================
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  /* Surface viewer 专用 — bypass workspace 限制, 返回 { success, content, mtimeMs }.
   * agent 经常把 surface 临时产出物写到 /tmp / .neox/cache / Desktop, 这些都不在 workspace
   * 内, 走 file:read 会被 path traversal 拦截; 也没 mtime 导致 polling 不知道文件何时变.
   * 加这个 bridge 是 Surface 自动 reload 工作的关键. */
  /* options.encoding: 'utf-8' (default, 文本) | 'base64' (二进制, .xlsx/.png/...)
   * options.workspacePath: 会话工作区根 — 切窗后仍可稳定读会话文件 */
  surfaceReadFile: (filePath, options) => ipcRenderer.invoke('surface:read-file', filePath, options),
  /* surface viewer 自动 save 用 — SheetSurfaceViewer 把 Univer 内存数据序列化后写回原 .xlsx */
  surfaceWriteFile: (filePath, content, options) => ipcRenderer.invoke('surface:write-file', filePath, content, options),
  /* 右栏表格保存 .xlsx: 只把改过的格原地补回去 (公式/样式/图表都留着), 不再整本重写 */
  surfacePatchXlsx: (filePath, sheet, edits, options) => ipcRenderer.invoke('surface:patch-xlsx', filePath, sheet, edits, options),
  /* 打开 Surface / Agent 触达文件时预批准 path+root, 用户无感 */
  surfaceRememberAccess: (payload) => ipcRenderer.invoke('surface:remember-access', payload),
  /* "在外部 app 打开" — shell.openPath 让 OS 用默认 office 启动 (WPS/Word/Excel/Numbers/Acrobat) */
  surfaceOpenExternal: (filePath) => ipcRenderer.invoke('surface:open-external', filePath),
  /* 另存为一份产物 (视频/图片「下载」) — 目标路径来自 saveFileDialog, 已预批准 */
  surfaceCopyFile: (srcPath, destPath) => ipcRenderer.invoke('surface:copy-file', srcPath, destPath),
  /* 检测可用的外部 app 列表 (按 ext 过滤) — 返 [{id, name, exists}], appPath 不出 main */
  surfaceListExternalApps: (filePath) => ipcRenderer.invoke('surface:list-external-apps', filePath),
  /* 用指定 app 打开 — appId='__default__' 走系统默认; main 按 appId 自行解析 appPath */
  surfaceOpenWith: (filePath, appId, appPath) => ipcRenderer.invoke('surface:open-with', filePath, appId, appPath),
  /* 任意 HTML 渲染成 PDF — 用 Electron 自带 Chromium printToPDF, 零依赖跨平台.
   * docx/xlsx/md 都先转 HTML 再走这条路统一导. */
  exportHtmlToPdf: (html, savePath, options) => ipcRenderer.invoke('export:html-to-pdf', html, savePath, options),

  /* Mobile Bridge (LAN P2P) — Settings UI / Composer cloud icon 用.
   * 协议详见 内部设计文档 Mode A.
   * onSessionsChanged / onMobileActiveSession: Mobile 端动作触发 Desktop UI 联动 */
  mobileBridge: {
    status: () => ipcRenderer.invoke('mobileBridge:status'),
    startPairing: () => ipcRenderer.invoke('mobileBridge:start-pairing'),
    cancelPairing: (token) => ipcRenderer.invoke('mobileBridge:cancel-pairing', token),
    listPaired: () => ipcRenderer.invoke('mobileBridge:list-paired'),
    removePaired: (deviceId) => ipcRenderer.invoke('mobileBridge:remove-paired', deviceId),
    renamePaired: (deviceId, name) => ipcRenderer.invoke('mobileBridge:rename-paired', deviceId, name),
    setDeviceName: (name) => ipcRenderer.invoke('mobileBridge:set-device-name', name),
    // M4 Mode B Cloud Relay 控制
    cloudLogin: (serverBaseUrl, email, password) => ipcRenderer.invoke('mobileBridge:cloud-login', serverBaseUrl, email, password),
    cloudLogout: () => ipcRenderer.invoke('mobileBridge:cloud-logout'),
    cloudStart: () => ipcRenderer.invoke('mobileBridge:cloud-start'),
    cloudStop: () => ipcRenderer.invoke('mobileBridge:cloud-stop'),
    cloudStatus: () => ipcRenderer.invoke('mobileBridge:cloud-status'),
    cloudSetAutoStart: (enabled) => ipcRenderer.invoke('mobileBridge:cloud-set-auto-start', enabled),
    selfRelayGet: () => ipcRenderer.invoke('mobileBridge:self-relay-get'),
    selfRelaySet: (input) => ipcRenderer.invoke('mobileBridge:self-relay-set', input),
    selfRelayClear: () => ipcRenderer.invoke('mobileBridge:self-relay-clear'),
    onSessionsChanged: (handler) => {
      const listener = () => handler();
      ipcRenderer.on('neox:sessions-changed', listener);
      return () => ipcRenderer.removeListener('neox:sessions-changed', listener);
    },
    onMobileActiveSession: (handler) => {
      const listener = (_e, sessionId) => handler(sessionId);
      ipcRenderer.on('neox:mobile-active-session', listener);
      return () => ipcRenderer.removeListener('neox:mobile-active-session', listener);
    },
  },
  cloudMigration: {
    push: (input) => ipcRenderer.invoke('cloud-migration:push', input),
    pushViaGit: (input) => ipcRenderer.invoke('cloud-migration:push-via-git', input),
    pull: (input) => ipcRenderer.invoke('cloud-migration:pull', input),
    status: (sessionId) => ipcRenderer.invoke('cloud-migration:status', sessionId),
    analyze: (workspacePath) => ipcRenderer.invoke('cloud-migration:analyze', workspacePath),
    onProgress: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('cloud-migration:progress', listener);
      return () => ipcRenderer.removeListener('cloud-migration:progress', listener);
    },
  },
  // Cloud Session — 新建/销毁/列 desktop 直连云端的 session (内部设计文档)
  // relayKey 永远不返 renderer, 仅 main 进程内存
  cloudSession: {
    create: (input) => ipcRenderer.invoke('cloud-session:create', input),
    terminate: (sessionId) => ipcRenderer.invoke('cloud-session:terminate', sessionId),
    list: () => ipcRenderer.invoke('cloud-session:list'),
    listRemote: () => ipcRenderer.invoke('cloud-session:list-remote'),
    control: (sessionId, patch) => ipcRenderer.invoke('cloud-session:control', sessionId, patch),
    featureFlags: () => ipcRenderer.invoke('cloud-session:feature-flags'),
    /** lazy 确保 sessionId 在 main 进程 cloudSessionStore — 选中 cloud session 进
     *  timeline 前调一次, 避免 chat:send 路由错走 local. */
    ensure: (sessionId) => ipcRenderer.invoke('cloud-session:ensure', sessionId),
    /** 从 pod 读文件内容 (path 在 workspace 内). cloud 模式渲染时拉 pod 文件用. */
    fsRead: (sessionId, path, maxBytes) =>
      ipcRenderer.invoke('cloud-session:fs-read', sessionId, path, maxBytes),
    /** 列 pod workspace 下的目录 (cloud 模式 @file picker). */
    fsList: (sessionId, path, limit) =>
      ipcRenderer.invoke('cloud-session:fs-list', sessionId, path, limit),
  },
  writeFile: (filePath, content) => ipcRenderer.invoke('file:write', filePath, content),
  listFiles: (dirPath, pattern, options) => ipcRenderer.invoke('file:list', dirPath, pattern, options),
  statFile: (filePath) => ipcRenderer.invoke('file:stat', filePath),
  readFileDataUrl: (filePath) => ipcRenderer.invoke('file:read-data-url', filePath),
  searchContent: (query, options) => ipcRenderer.invoke('file:search-content', query, options),
  searchFiles: (pattern, options) => ipcRenderer.invoke('file:search-files', pattern, options),
  // 分页读 (大文件 viewer 专用, 借鉴 IntelliJ LargeFileEditor)
  largeFile: {
    open: (filePath) => ipcRenderer.invoke('large-file:open', filePath),
    readLines: (handle, from, to) => ipcRenderer.invoke('large-file:read', handle, from, to),
    close: (handle) => ipcRenderer.invoke('large-file:close', handle),
    setEncoding: (handle, encoding) => ipcRenderer.invoke('large-file:set-encoding', handle, encoding),
    supportedEncodings: () => ipcRenderer.invoke('large-file:supported-encodings'),
    search: (handle, query, opts) => ipcRenderer.invoke('large-file:search', handle, query, opts ?? {}),
  },
  // Semantic layer: 一次性列出工作区所有文件（Command Palette 用）
  semanticListFiles: (options) => ipcRenderer.invoke('semantic:list-files', options),
  // Semantic layer (IDEA-like): main 进程 SemanticBridge 接口
  semantic: {
    // 生命周期 / 状态
    init: (cwd) => ipcRenderer.invoke('semantic:init', cwd),
    getProgress: () => ipcRenderer.invoke('semantic:progress'),
    isReady: () => ipcRenderer.invoke('semantic:is-ready'),
    // 搜索
    searchFiles: (query, limit) => ipcRenderer.invoke('semantic:search-files', query, limit),
    searchSymbols: (query, limit) => ipcRenderer.invoke('semantic:search-symbols', query, limit),
    searchPalette: (query, limit) => ipcRenderer.invoke('semantic:search-palette', query, limit),
    // 符号查询
    fileOutline: (filePath) => ipcRenderer.invoke('semantic:file-outline', filePath),
    getSymbol: (symbolId) => ipcRenderer.invoke('semantic:get-symbol', symbolId),
    findSymbolsByName: (name, limit) => ipcRenderer.invoke('semantic:find-symbols-by-name', name, limit),
    // Find Usages
    findUsages: (name, options) => ipcRenderer.invoke('semantic:find-usages', name, options),
    // Rename
    getRenameEdits: (oldName, newName) => ipcRenderer.invoke('semantic:rename-edits', oldName, newName),
    // Debug
    listIndexedFiles: () => ipcRenderer.invoke('semantic:list-indexed-files'),
  },
  // 编辑器布局持久化 —— 保存打开文件 / 视图模式 / 侧边栏状态
  saveEditorLayout: (layout) => ipcRenderer.invoke('ui:save-editor-layout', layout),

  // TypeScript Language Server —— 真实语义引用（不是文本搜索）
  tsserver: {
    references: (filePath, line, offset) => ipcRenderer.invoke('tsserver:references', filePath, line, offset),
    definition: (filePath, line, offset) => ipcRenderer.invoke('tsserver:definition', filePath, line, offset),
    quickinfo: (filePath, line, offset) => ipcRenderer.invoke('tsserver:quickinfo', filePath, line, offset),
  },

  // ==================== Project View 文件操作 (IDEA-style) ====================
  fsRename: (oldPath, newName) => ipcRenderer.invoke('file:rename', oldPath, newName),
  fsCreate: (parentDir, name, isDirectory) => ipcRenderer.invoke('file:create', parentDir, name, isDirectory),
  fsDuplicate: (srcPath) => ipcRenderer.invoke('file:duplicate', srcPath),
  fsCopyTo: (srcPath, destDir, opts) => ipcRenderer.invoke('file:copy-to', srcPath, destDir, opts),
  fsMoveTo: (srcPath, destDir) => ipcRenderer.invoke('file:move-to', srcPath, destDir),
  fsTrash: (filePath) => ipcRenderer.invoke('file:trash', filePath),
  fsRevealInFinder: (filePath) => ipcRenderer.invoke('file:reveal-in-finder', filePath),
  fsOpenInTerminal: (dirPath) => ipcRenderer.invoke('file:open-in-terminal', dirPath),
  fsExists: (filePath) => ipcRenderer.invoke('file:exists', filePath),

  // ==================== Project View 视图设置(SQLite app_state) ====================
  getExplorerSettings: () => ipcRenderer.invoke('explorer-settings:get'),
  setExplorerSettings: (settings) => ipcRenderer.invoke('explorer-settings:set', settings),

  // ==================== 全局 Keymap 绑定(SQLite app_state) ====================
  getKeymapBindings: () => ipcRenderer.invoke('keymap-bindings:get'),
  setKeymapBindings: (bindings) => ipcRenderer.invoke('keymap-bindings:set', bindings),
  resetKeymapBindings: () => ipcRenderer.invoke('keymap-bindings:reset'),

  // ==================== Model Profile 查看 ====================
  modelProfileGetCurrent: () => ipcRenderer.invoke('model-profile:get-current'),
  modelProfileGetAll: () => ipcRenderer.invoke('model-profile:get-all'),
  modelProfileGetToolsetOverride: (params) => ipcRenderer.invoke('model-profile:get-toolset-override', params),
  modelProfileListTools: () => ipcRenderer.invoke('model-profile:list-tools'),
  modelProfileResolve: (params) => ipcRenderer.invoke('model-profile:resolve', params),
  modelProfileGetTaskAgentMap: () => ipcRenderer.invoke('model-profile:get-task-agent-map'),
  modelProfileSetTaskAgentForModel: (params) => ipcRenderer.invoke('model-profile:set-task-agent-for-model', params),
  modelProfileSetFieldOverride: (params) => ipcRenderer.invoke('model-profile:set-field-override', params),
  modelProfileGetFieldOverrides: (params) => ipcRenderer.invoke('model-profile:get-field-overrides', params),
  modelProfileSetToolsetOverride: (params) => ipcRenderer.invoke('model-profile:set-toolset-override', params),
  modelProfileClearToolsetOverride: (params) => ipcRenderer.invoke('model-profile:clear-toolset-override', params),

  // ==================== 版本更新 (Desktop Auto-Update) ====================
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateCheckRelease: () => ipcRenderer.invoke('update:check-release'),
  /* 就绪态: 后台已预下载完成的更新 ({ready, version}) — 关于页开页即查, 直接呈现「重启安装」 */
  updateStagedStatus: () => ipcRenderer.invoke('update:staged-status'),
  updateDownload: (url) => ipcRenderer.invoke('update:download', url),
  /* 暂停 / 继续 / 取消 / 查断点 —— action: 'pause'|'resume'|'cancel'|'state'。
     只有 mac 自研 updater 支持, 别的平台回 {supported:false} (见 updateHandlers)。 */
  updateDownloadControl: (action) => ipcRenderer.invoke('update:download-control', action),
  updateInstall: (filePath) => ipcRenderer.invoke('update:install', filePath),
  /* 「更新就绪」自研弹窗 — 主进程推 update:ready, 渲染层必须先 ack (否则 1.5s 后
   * 主进程落回原生 dialog), 再按用户选择回 accept / dismiss。 */
  onUpdateReady: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('update:ready', h);
    return () => ipcRenderer.removeListener('update:ready', h);
  },
  updateReadyAck: (id) => ipcRenderer.send(`update:ready-ack-${id}`),
  updateReadyAccept: (id) => ipcRenderer.send('update:ready-accept', id),
  updateReadyDismiss: (id) => ipcRenderer.send('update:ready-dismiss', id),
  updateOpenReleases: () => ipcRenderer.invoke('update:open-releases'),
  onUpdateProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  },
  onUpdateError: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('update:error', listener);
    return () => ipcRenderer.removeListener('update:error', listener);
  },

  // ==================== Plugin Marketplace ====================
  pluginSearch: (request) => ipcRenderer.invoke('plugin:search', request),
  pluginFeatured: () => ipcRenderer.invoke('plugin:featured'),
  pluginCategories: () => ipcRenderer.invoke('plugin:categories'),
  pluginDetail: (name) => ipcRenderer.invoke('plugin:detail', name),
  pluginCheckUpdates: () => ipcRenderer.invoke('plugin:check-updates'),
  pluginList: () => ipcRenderer.invoke('plugin:list'),
  pluginInstall: (request) => ipcRenderer.invoke('plugin:install', request),
  pluginUninstall: (name) => ipcRenderer.invoke('plugin:uninstall', name),
  pluginEnable: (name) => ipcRenderer.invoke('plugin:enable', name),
  pluginDisable: (name) => ipcRenderer.invoke('plugin:disable', name),
  pluginInfo: (name) => ipcRenderer.invoke('plugin:info', name),
  pluginConfigGet: (name) => ipcRenderer.invoke('plugin:config-get', name),
  pluginConfigSet: (name, config) => ipcRenderer.invoke('plugin:config-set', name, config),
  pluginMarketplaceInstall: (plugin) => ipcRenderer.invoke('plugin:marketplace-install', plugin),

  // Plugin Views (PPT / 视频 等领域面板)
  pluginListViews: () => ipcRenderer.invoke('plugin:list-views'),
  pluginOnViewsChanged: (callback) => {
    const listener = (_e, views) => callback(views);
    ipcRenderer.on('plugin:views-changed', listener);
    return () => ipcRenderer.removeListener('plugin:views-changed', listener);
  },

  // Plugin Scaffold + Preflight
  pluginScaffold: (options) => ipcRenderer.invoke('plugin:scaffold', options),
  pluginPreflight: (request) => ipcRenderer.invoke('plugin:preflight-permissions', request),

  // Plugin Import (弹 dialog 选本地文件/目录) + Export (打包 tarball)
  pluginPickInstallSource: (options) => ipcRenderer.invoke('plugin:pick-install-source', options),
  pluginExport: (name) => ipcRenderer.invoke('plugin:export', name),

  // Connector — 声明式第三方平台接入 (凭据只进不出: 没有任何读 token 的通道)
  pluginConnectorList: (request) => ipcRenderer.invoke('plugin:connector-list', request),
  pluginConnectorConnect: (request) => ipcRenderer.invoke('plugin:connector-connect', request),
  pluginConnectorDisconnect: (name) => ipcRenderer.invoke('plugin:connector-disconnect', name),
  pluginConnectorSetGrants: (request) => ipcRenderer.invoke('plugin:connector-set-grants', request),
  pluginConnectorTest: (request) => ipcRenderer.invoke('plugin:connector-test', request),
  pluginConnectorOAuth: (request) => ipcRenderer.invoke('plugin:connector-oauth', request),

  pluginExternalAgentList: () => ipcRenderer.invoke('plugin:external-agent-list'),

  // GitHub 源插件市场 (marketplace:*, ipc/openMarketplaceHandlers.ts) —— 跟上面官方市场的
  // pluginSearch / pluginMarketplaceInstall 是两套; 名字与公开仓一致
  marketplaceSources: () => ipcRenderer.invoke('marketplace:sources'),
  marketplaceSourceAdd: (input) => ipcRenderer.invoke('marketplace:source-add', input),
  marketplaceSourceUpdate: (id, patch) => ipcRenderer.invoke('marketplace:source-update', id, patch),
  marketplaceSourceRemove: (id) => ipcRenderer.invoke('marketplace:source-remove', id),
  marketplaceSourceRefresh: (id) => ipcRenderer.invoke('marketplace:source-refresh', id),
  marketplaceSearch: (options) => ipcRenderer.invoke('marketplace:search', options),
  marketplaceTokenSet: (id, token) => ipcRenderer.invoke('marketplace:token-set', id, token),
  marketplaceInstall: (request) => ipcRenderer.invoke('marketplace:install', request),

  // Plugin Host API — 供 PluginViewHost 桥接 iframe 调用.
  // 权限校验全在主进程, renderer 只是转发.
  pluginHost: {
    getActiveFile: () => ipcRenderer.invoke('plugin:host:getActiveFile'),
    readPluginData: (pluginName, relPath) => ipcRenderer.invoke('plugin:host:readPluginData', pluginName, relPath),
    writePluginData: (pluginName, relPath, content) => ipcRenderer.invoke('plugin:host:writePluginData', pluginName, relPath, content),
    readFile: (pluginName, filePath) => ipcRenderer.invoke('plugin:host:readFile', pluginName, filePath),
    writeFile: (pluginName, filePath, content) => ipcRenderer.invoke('plugin:host:writeFile', pluginName, filePath, content),
    invokeTool: (pluginName, toolName, args) => ipcRenderer.invoke('plugin:host:invokeTool', pluginName, toolName, args),
  },

  // ==================== Git VCS ====================
  /** opts.fresh: 跳过主进程缓存强制重算 (用户刚做完 git 操作时用) */
  gitStatus: (cwd, opts) => ipcRenderer.invoke('git:status', cwd, opts),
  /** 持续看某仓库: 返回完整状态, 之后变化经 onGitStatusChanged 增量推送 */
  gitStatusSubscribe: (cwd) => ipcRenderer.invoke('git:status-subscribe', cwd),
  gitStatusUnsubscribe: (cwd) => ipcRenderer.invoke('git:status-unsubscribe', cwd),
  /** 让主进程按缓存规则复核 (fresh=true 强制重算); 有变化走推送, 本身不返回状态 */
  gitStatusRevalidate: (cwd, fresh) => ipcRenderer.invoke('git:status-revalidate', cwd, fresh),
  /** 仓库状态变了 → { cwds, root, version, prevVersion, summary, delta }; 返回退订函数 */
  onGitStatusChanged: (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on('git:status-changed', listener);
    return () => ipcRenderer.removeListener('git:status-changed', listener);
  },
  gitStage: (cwd, paths) => ipcRenderer.invoke('git:stage', cwd, paths),
  gitUnstage: (cwd, paths) => ipcRenderer.invoke('git:unstage', cwd, paths),
  gitStageAll: (cwd) => ipcRenderer.invoke('git:stage-all', cwd),
  gitUnstageAll: (cwd) => ipcRenderer.invoke('git:unstage-all', cwd),
  gitCommit: (cwd, message, amend) => ipcRenderer.invoke('git:commit', cwd, message, amend),
  gitDiffFile: (cwd, filePath, staged) => ipcRenderer.invoke('git:diff-file', cwd, filePath, staged),
  gitLog: (cwd, count) => ipcRenderer.invoke('git:log', cwd, count),
  gitLogDetailed: (cwd, count) => ipcRenderer.invoke('git:log-detailed', cwd, count),
  gitRefs: (cwd) => ipcRenderer.invoke('git:refs', cwd),
  gitShowCommit: (cwd, hash) => ipcRenderer.invoke('git:show-commit', cwd, hash),
  gitFileAtCommit: (cwd, hash, path) => ipcRenderer.invoke('git:file-at-commit', cwd, hash, path),
  gitDiffCommits: (cwd, hash, path) => ipcRenderer.invoke('git:diff-commits', cwd, hash, path),
  gitCherryPick: (cwd, hash) => ipcRenderer.invoke('git:cherry-pick', cwd, hash),
  gitCheckout: (cwd, ref) => ipcRenderer.invoke('git:checkout', cwd, ref),
  gitRevert: (cwd, hash) => ipcRenderer.invoke('git:revert', cwd, hash),
  gitResetTo: (cwd, hash, mode) => ipcRenderer.invoke('git:reset-to', cwd, hash, mode),
  gitCreateBranch: (cwd, name, startPoint) => ipcRenderer.invoke('git:create-branch', cwd, name, startPoint),
  gitCreateTag: (cwd, name, hash) => ipcRenderer.invoke('git:create-tag', cwd, name, hash),
  gitStash: (cwd, message) => ipcRenderer.invoke('git:stash', cwd, message),
  gitDiscardWorktree: (cwd) => ipcRenderer.invoke('git:discard-worktree', cwd),
  gitCleanPreview: (cwd) => ipcRenderer.invoke('git:clean-preview', cwd),
  gitDiscardFile: (cwd, filePath, area) => ipcRenderer.invoke('git:discard-file', cwd, filePath, area),
  gitAppendGitignore: (cwd, patterns) => ipcRenderer.invoke('git:append-gitignore', cwd, patterns),
  /** git push — 旧签名 (cwd, remote?, branch?) 还能用; 新调用方建议传 opts 对象 {remote, branch, setUpstream}. */
  gitPush: (cwd, opts, branch) => ipcRenderer.invoke('git:push', cwd, opts, branch),
  gitPull: (cwd, remote, branch) => ipcRenderer.invoke('git:pull', cwd, remote, branch),
  /** git clone <url> <dest> — 返回 { ok, path } 或 { ok:false, error, code }. */
  gitClone: (opts) => ipcRenderer.invoke('git:clone', opts),
  /** git init <dest> — "新建工作区" 选空目录时静默初始化. */
  gitInit: (dest) => ipcRenderer.invoke('git:init', dest),
  gitDeleteBranch: (cwd, name, force) => ipcRenderer.invoke('git:delete-branch', cwd, name, force),
  gitFetch: (cwd, remote, prune) => ipcRenderer.invoke('git:fetch', cwd, remote, prune),
  gitMerge: (cwd, branch, noFf) => ipcRenderer.invoke('git:merge', cwd, branch, noFf),
  gitRebase: (cwd, onto) => ipcRenderer.invoke('git:rebase', cwd, onto),
  gitRebaseAbort: (cwd) => ipcRenderer.invoke('git:rebase-abort', cwd),
  gitRebaseContinue: (cwd) => ipcRenderer.invoke('git:rebase-continue', cwd),
  gitOpAbort: (cwd) => ipcRenderer.invoke('git:op-abort', cwd),
  gitOpContinue: (cwd) => ipcRenderer.invoke('git:op-continue', cwd),
  gitOpSkip: (cwd) => ipcRenderer.invoke('git:op-skip', cwd),
  /** 冲突文件一键取一边: side = 'ours' | 'theirs'; 解完自动 add */
  gitResolveWith: (cwd, filePath, side) => ipcRenderer.invoke('git:resolve-with', cwd, filePath, side),
  gitRemoteList: (cwd) => ipcRenderer.invoke('git:remote-list', cwd),
  gitRemoteAdd: (cwd, name, url) => ipcRenderer.invoke('git:remote-add', cwd, name, url),
  gitRemoteSetUrl: (cwd, name, url) => ipcRenderer.invoke('git:remote-set-url', cwd, name, url),
  gitRemoteRemove: (cwd, name) => ipcRenderer.invoke('git:remote-remove', cwd, name),
  gitRenameBranch: (cwd, oldName, newName) => ipcRenderer.invoke('git:rename-branch', cwd, oldName, newName),
  gitBranchDivergence: (cwd, branchName, baseName) => ipcRenderer.invoke('git:branch-divergence', cwd, branchName, baseName),
  gitStashList: (cwd) => ipcRenderer.invoke('git:stash-list', cwd),
  gitStashPop: (cwd, index) => ipcRenderer.invoke('git:stash-pop', cwd, index),
  gitStashApply: (cwd, index) => ipcRenderer.invoke('git:stash-apply', cwd, index),
  gitStashDrop: (cwd, index) => ipcRenderer.invoke('git:stash-drop', cwd, index),
  /** 订阅 git clone stderr 进度 (git --progress). 返回 unsubscribe 函数. */
  onGitCloneProgress: (cb) => {
    const listener = (_event, chunk) => cb(chunk);
    ipcRenderer.on('git:clone:progress', listener);
    return () => ipcRenderer.removeListener('git:clone:progress', listener);
  },
  gitCurrentBranch: (cwd) => ipcRenderer.invoke('git:current-branch', cwd),
  // AI commit message generation — fire-and-forget; chunks arrive via events below
  gitGenerateCommitMsg: (cwd, paths) => ipcRenderer.invoke('git:generate-commit-msg', cwd, paths),
  onGitCommitMsgChunk: (callback) => {
    const listener = (_event, chunk) => callback(chunk);
    ipcRenderer.on('git:commit-msg:chunk', listener);
    return () => ipcRenderer.removeListener('git:commit-msg:chunk', listener);
  },
  onGitCommitMsgDone: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('git:commit-msg:done', listener);
    return () => ipcRenderer.removeListener('git:commit-msg:done', listener);
  },
  onGitCommitMsgError: (callback) => {
    const listener = (_event, err) => callback(err);
    ipcRenderer.on('git:commit-msg:error', listener);
    return () => ipcRenderer.removeListener('git:commit-msg:error', listener);
  },

  // ==================== AI Editor Features ====================
  // Returns Promise<{ insertText: string, items: string[], aborted?: boolean }>
  // —— empty string means no suggestion. request.requestId is optional; when
  // provided, the call becomes cancelable via aiInlineCompleteAbort(requestId).
  aiInlineComplete: (request) =>
    ipcRenderer.invoke('ai:inline-complete', request),
  aiInlineCompleteAbort: (requestId) =>
    ipcRenderer.invoke('ai:inline-complete:abort', requestId),
  aiRankCompletions: (request) =>
    ipcRenderer.invoke('ai:rank-completions', request),

  // Cmd+K inline edit — streaming rewrite
  aiInlineEdit: (request) =>
    ipcRenderer.invoke('ai:inline-edit', request),
  onInlineEditChunk: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('ai:inline-edit:chunk', listener);
    return () => ipcRenderer.removeListener('ai:inline-edit:chunk', listener);
  },
  onInlineEditDone: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('ai:inline-edit:done', listener);
    return () => ipcRenderer.removeListener('ai:inline-edit:done', listener);
  },
  onInlineEditError: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('ai:inline-edit:error', listener);
    return () => ipcRenderer.removeListener('ai:inline-edit:error', listener);
  },
  onInlineEditAborted: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('ai:inline-edit:aborted', listener);
    return () => ipcRenderer.removeListener('ai:inline-edit:aborted', listener);
  },
  aiInlineEditAbort: (requestId) =>
    ipcRenderer.invoke('ai:inline-edit:abort', requestId),
  aiGetInlineCompleteConfig: () =>
    ipcRenderer.invoke('ai:get-inline-complete-config'),
  aiSetInlineCompleteConfig: (updates) =>
    ipcRenderer.invoke('ai:set-inline-complete-config', updates),

  // Codebase embedding index + @codebase search (cwd = workspace path)
  embeddingInit: (cwd) => ipcRenderer.invoke('embedding:init', cwd),
  embeddingBuild: (cwd, force) => ipcRenderer.invoke('embedding:build', cwd, force),
  embeddingStatus: (cwd) => ipcRenderer.invoke('embedding:status', cwd),
  projectStartupNotifyRendererReady: (cwd) => ipcRenderer.invoke('project-startup:renderer-ready', cwd),
  projectStartupGetStatus: (cwd) => ipcRenderer.invoke('project-startup:status', cwd),

  // ==================== WriteIntent (P4: IDEA 读写锁) ====================
  // Renderer 发起批量 apply / save 前调 begin, 完成后 end (finally 必须!)
  // 建议传 timeoutMs 兜底: renderer 崩溃不会永久卡住 main 侧后台 read.
  writeIntentBegin: (request) => ipcRenderer.invoke('write-intent:begin', request),
  writeIntentEnd: (id) => ipcRenderer.invoke('write-intent:end', id),
  writeIntentSnapshot: () => ipcRenderer.invoke('write-intent:snapshot'),
  /**
   * Subscribe to main→renderer push of ProjectStartupStatus. Replaces the
   * 500ms polling in useSemanticProgress. Returns an unsubscribe function.
   * Callback fires with the latest snapshot whenever phase/semantic/embedding changes.
   */
  onProjectStartupChanged: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('project-startup:state-changed', listener);
    return () => ipcRenderer.removeListener('project-startup:state-changed', listener);
  },
  embeddingSearch: (cwd, query, topK) => ipcRenderer.invoke('embedding:search', cwd, query, topK),
  embeddingClear: (cwd) => ipcRenderer.invoke('embedding:clear', cwd),
  onEmbeddingProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('embedding:progress', listener);
    return () => ipcRenderer.removeListener('embedding:progress', listener);
  },

  // ==================== Run/Debug Configurations (IDEA-style) ====================
  runConfigLoad: (workspacePath) => ipcRenderer.invoke('run-config:load', workspacePath),
  runConfigSave: (workspacePath, file) => ipcRenderer.invoke('run-config:save', workspacePath, file),
  runLaunchStart: (spec) => ipcRenderer.invoke('run-launch:start', spec),
  runLaunchStop: (processId) => ipcRenderer.invoke('run-launch:stop', processId),
  runLaunchStdin: (processId, data) => ipcRenderer.invoke('run-launch:stdin', processId, data),
  runLaunchResize: (processId, cols, rows) => ipcRenderer.invoke('run-launch:resize', processId, cols, rows),
  runLaunchGetRunning: () => ipcRenderer.invoke('run-launch:get-running'),
  onRunLaunchEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('run-launch:event', listener);
    return () => ipcRenderer.removeListener('run-launch:event', listener);
  },
  runNpmScanPackageJsons: (workspacePath) => ipcRenderer.invoke('run-npm:scan-package-jsons', workspacePath),
  runNpmScanPackageManagers: () => ipcRenderer.invoke('run-npm:scan-package-managers'),
  runNpmScanNode: () => ipcRenderer.invoke('run-npm:scan-node'),

  // ==================== 多窗口 ====================
  openWindowWithWorkspace: (workspacePath) => ipcRenderer.invoke('window:open-with-workspace', workspacePath),
  focusWorkspaceWindow: (workspacePath) => ipcRenderer.invoke('window:focus-workspace', workspacePath),

  // ==================== 外部编辑器插件 (neox://editor/*, 见 services/editorLink.ts) ====================
  editorLinkDrain: () => ipcRenderer.invoke('editor-link:drain'),
  onEditorLinkPing: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('editor-link:ping', handler);
    return () => ipcRenderer.removeListener('editor-link:ping', handler);
  },

  // ==================== Auth (NeoxCloud) ====================
  // token 用 main 自加密存到 auth.enc; renderer 不读取 raw access/refresh token
  // launchOAuth: 浏览器 PKCE 登录主入口, 主进程包办整个流, 仅返回 user 公开资料
  auth: {
    // 旧兼容桩: main 侧不再返回 raw token
    getTokens: () => ipcRenderer.invoke('auth:get-tokens'),
    getSessionStatus: () => ipcRenderer.invoke('auth:get-session-status'),
    fetch: (request) => ipcRenderer.invoke('auth:fetch', request),
    completeLogin: (request) => ipcRenderer.invoke('auth:complete-login', request),
    // 旧兼容桩: main 侧拒绝 renderer 写 raw token
    setTokens: (tokens) => ipcRenderer.invoke('auth:set-tokens', tokens),
    logout: () => ipcRenderer.invoke('auth:logout'),
    clearTokens: () => ipcRenderer.invoke('auth:clear-tokens'),
    launchOAuth: (params) => ipcRenderer.invoke('auth:launch-oauth', params || {}),
    cancelOAuth: () => ipcRenderer.invoke('auth:cancel-oauth'),
    /* 设备指纹 — 服务端 device_fingerprints 表绑定 + JWT claim. AuthClient 启动一次缓存. */
    getDeviceFingerprint: () => ipcRenderer.invoke('auth:device-fingerprint'),
    getDeviceHeaders: () => ipcRenderer.invoke('auth:device-headers'),
    /* 旧兼容桩: main 侧不再给 renderer 任意路径 HMAC 签名能力. */
    signRequest: (path, bodySha256Hex) => ipcRenderer.invoke('auth:sign-request', path, bodySha256Hex),
    /** 监听 auth 状态变化广播 — main 端登出会 push 给所有 BrowserWindow.
     *   payload 形如 { type:'logout', previousUserId } / { type:'login', userId }.
     *   返回 unsubscribe 函数. */
    onChanged: (handler) => {
      const wrapped = (_evt, payload) => { try { handler(payload); } catch (e) { console.warn('[auth.onChanged] handler threw:', e); } };
      ipcRenderer.on('auth:changed', wrapped);
      return () => ipcRenderer.removeListener('auth:changed', wrapped);
    },
    /** @deprecated sessions 已全局化, 登录不再执行 anonymous → per-user DB 迁移. */
    onAnonymousMigrated: () => () => {},
  },

  /* Neox 路由桥 — main 进程对 neox-core providerResolver 钩子的 IPC 入口.
   *   renderer 拿到 /membership/me 后调 setPlan 推当前 plan, 供 main status/debug 使用.
   *   BYOK 已套餐无关; main 只把 neox-cloud / neox-managed 托管 provider 改写到网关. */
  neoxRouting: {
    setPlan: (payload) => ipcRenderer.invoke('neox-routing:set-plan', payload),
    setEnabled: (enabled) => ipcRenderer.invoke('neox-routing:set-enabled', enabled),
    refreshToken: () => ipcRenderer.invoke('neox-routing:refresh-token'),
    describe: (provider) => ipcRenderer.invoke('neox-routing:describe', provider),
    status: () => ipcRenderer.invoke('neox-routing:status'),
    /* 订阅模型列表 push → main 缓存, mobile-bridge model.list RPC 读这份 */
    setSubscriptionModels: (models) => ipcRenderer.invoke('neox-routing:set-subscription-models', models),
  },

  gatewayKey: {
    get: () => ipcRenderer.invoke('gateway-key:get'),
    set: (payload) => ipcRenderer.invoke('gateway-key:set', payload),
    clear: () => ipcRenderer.invoke('gateway-key:clear'),
    /** 校验 gateway key 是否归属当前 userId — 不匹配时 caller 应强制 re-mint. */
    checkOwner: (userId) => ipcRenderer.invoke('gateway-key:check-owner', userId),
  },

};

/* main 端"配额耗尽"事件转发 — preload 接 IPC, 重新派发为 'neox-quota-exhausted'
 *   window 事件, 跟 renderer-side dispatchQuotaExhausted 走同一总线, 单源订阅.
 *   QuotaExhaustedModal 不需要改任何代码就自动接管 cloud-relay/consumer 等 main 路径的 402. */
try {
  ipcRenderer.on('quota:exhausted', (_evt, payload) => {
    try {
      window.dispatchEvent(new CustomEvent('neox-quota-exhausted', { detail: payload }));
    } catch (e) {
      console.warn('[preload] forward quota:exhausted to window event failed:', e);
    }
  });
} catch (e) {
  console.warn('[preload] install quota:exhausted listener failed:', e);
}

contextBridge.exposeInMainWorld('neox', api);
