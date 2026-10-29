/**
 * ServicesSurfaceViewer — 服务治理总控页, master-detail 布局.
 *
 * 左栏: Service list
 *   · Configured 区: 绑定到 RunConfig 的活进程
 *   · Ad-hoc 区: 没绑 RunConfig 但被启发判定为长进程 (有端口 / --watch / nodemon 等)
 *   · "+ 新建 RunConfig" 按钮 → 弹简单表单
 *
 * 右栏: 选中服务详情
 *   · 顶部: status pill + uptime + port + 命令 + [Restart] [Stop] [Open in browser]
 *   · Tab: Logs (默认, tail follow) / Env / Health (P2 加)
 *
 * 数据刷新:
 *   · processList 每 2s 轮询 (跟 BackgroundTaskBar 同款机制)
 *   · 服务日志: processGetOutput(pid) 每 1s 轮询取最新 buffer
 *   · 不订阅事件 (Electron renderer 端目前没有 process 事件流, 轮询足够流畅)
 */

import { formatAgo, formatUptime } from './servicesAiFix';
import { ServiceConfigForm } from './servicesConfigForm';
import { copyToClipboard } from '../../../utils/copyToClipboard';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
/* 菜单 / 弹窗开在操作发生的那个窗口 (服务面板可能被拖成了独立窗口) */
import { interactionDoc } from '../../../utils/ownerDoc';

const SCAN_SOURCES_SUMMARY_ZH = 'package.json / pom.xml / build.gradle / docker-compose.yml / Procfile 等 16 种工程文件';
const SCAN_SOURCES_SUMMARY_EN = 'package.json / pom.xml / build.gradle / docker-compose.yml / Procfile and 11 more project files';
import '@xterm/xterm/css/xterm.css';
import type { Surface } from '../../../state/surfaceStore';
import { useNeoxRuntime } from '../../../app/NeoxRuntimeContext';
import { useVisibilityInterval } from '../../../hooks/useVisibilityInterval';
import { useBackgroundTasks, setBackgroundTaskPersistent } from '../../../state/backgroundTasksStore';
import { buildCommandLine } from './buildCommandLineClient';
import { useSuppressBrowserView } from './useSuppressBrowserView';
import { dispatchOpFailed, dispatchHint } from '../../../components/notifyEvents';
import { confirmAsync } from '../../../components/confirmEvents';
import { useI18n } from '../../../hooks/useI18n';
import { friendlyOpError } from '../../../components/notifyEvents';
import { ServiceKindIcon } from '../../../components/ServiceKindIcon';
import { NeoxIllus } from '../../../media/illus';
import { EnvPane, HealthPane } from './servicesDetailPanes';
import type { TrackedProcessKind } from '@neoxlabs/platform/platform/processManager.js';

export interface ProcessRow {
  pid: number;
  display_name?: string;
  /** IDEA 风格语义化短名 — "Spring Boot" / "HTTP Server :8888" / "Maven: clean" 等.
   *  后端 deriveFriendlyName 派生, UI 列表 + 详情大标题优先用. */
  friendly_name?: string;
  command: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  startTime: number;
  endTime?: number;
  exitCode?: number;
  cwd: string;
  config_id?: string;
  port?: number;
  uptime_sec?: number;
  log_file_path?: string;
  /* P2-2 */
  healthy?: boolean;
  health_checked_at?: number;
  /* 进程种类 — Services 面板按这个过滤, 'free-shell' (用户的交互式 zsh) 不算服务. */
  kind?: TrackedProcessKind;
  /** 归属工程 —— 快照按它过滤, 多项目窗口不再互相看到对方的服务. */
  workspaceRoot?: string;
  /** 'adopted' = 用户自己起的, 只是被纳管; 关 Neox 时不杀它. */
  origin?: 'spawned' | 'adopted';
  /** 有值 = 已退出 (status 由它派生). */
  endedAt?: number;
  startedAt?: number;
  persistent?: boolean;
  /** 起这个进程的会话 —— 临时任务只在自己会话里露面, 免得上个会话的构建串到这个会话。 */
  owner_session_id?: string;
}

/** 历史记录一条 —— 来自 sqlite service_instances (24h), 日志文件另留 7 天。 */
interface ServiceHistoryItem {
  pid: number;
  startTime: number;
  command: string;
  cwd: string;
  status: string;
  exitCode?: number;
  endTime?: number;
  port?: number;
  displayName?: string;
  configId?: string;
  logFilePath?: string;
}

export interface ServiceConfig {
  id: string;
  name: string;
  command: string;
  spec?: import('./buildCommandLineClient').ConfigSpec;
  cwd: string;
  port?: number;
  env?: Record<string, string>;
  healthcheck?: {
    kind: 'http' | 'port' | 'log_pattern';
    target: string;
    timeoutMs?: number;
  };
  autoOpenSurface?: boolean;
  autoRestart?: boolean;
  pinned?: boolean;
  group?: string;
  /** 组内启动顺序, 小的先起 */
  startOrder?: number;
  createdBy: 'user' | 'agent';
  createdAt: number;
  updatedAt?: number;
}

interface RowItem {
  /* 渲染统一形态 — config + 可选的活进程 OR 纯 adhoc 进程 */
  kind: 'configured' | 'adhoc';
  /* config-row 必有 config, 可能 proc undefined (declared but stopped) */
  config?: ServiceConfig;
  /* adhoc-row 必有 proc, config undefined */
  proc?: ProcessRow;
  /* 排序 key */
  pinned: boolean;
  sortBy: number;
  section: 'service' | 'task';
}

interface ServiceStartResult {
  ok: boolean;
  pid?: number;
  reused?: boolean;
  output?: string;
  error?: string;
  /** 端口被占 —— server 预检拦下来了, 没有真去 spawn */
  portConflict?: { port: number; pid: number; command: string; tracked: boolean };
}

interface StartConfigOptions {
  select?: boolean;
  refresh?: boolean;
}


const PORT_FREE_POLL_MS = 150;
const PORT_FREE_TIMEOUT_MS = 6000;

async function waitPortFree(port?: number, timeoutMs = PORT_FREE_TIMEOUT_MS): Promise<void> {
  if (!port) { await new Promise(r => setTimeout(r, 300)); return; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let occupied = true;
    try {
      const list = (await (window as any).neox?.processList?.()) || [];
      occupied = list.some((p: any) => p.port === port && p.status === 'running');
    } catch { /* 查不到就当已释放, 别把重启卡死 */ occupied = false; }
    if (!occupied) return;
    await new Promise(r => setTimeout(r, PORT_FREE_POLL_MS));
  }
}

const POLL_PROCS_MS = 2000;
const POLL_LOG_MS = 1000;
const LOG_MAX_LINES = 1000;


function getRowDisplayName(proc: ProcessRow | undefined, cfg: ServiceConfig | undefined): string {
  if (cfg?.name) return cfg.name;
  if (proc?.friendly_name) return proc.friendly_name;
  if (proc?.display_name) return proc.display_name;
  if (proc?.command) return proc.command.length > 40 ? proc.command.slice(0, 40) + '…' : proc.command;
  return cfg?.id || '(unnamed)';
}

function statusDot(status?: string, hasPid?: boolean, healthy?: boolean, starting?: boolean): React.ReactNode {
  if (starting) return <span className="sfc-svc-dot sfc-svc-dot--starting" />;
  if (!hasPid) return <span className="sfc-svc-dot sfc-svc-dot--stopped" />;
  if (status === 'killed' || status === 'failed') return <span className="sfc-svc-dot sfc-svc-dot--failed" />;
  if (healthy) return <span className="sfc-svc-dot sfc-svc-dot--healthy" />;
  return <span className="sfc-svc-dot sfc-svc-dot--running" />;
}

const IconPlay: React.FC = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5.14v13.72a.5.5 0 0 0 .77.42l10.5-6.86a.5.5 0 0 0 0-.84L8.77 4.72a.5.5 0 0 0-.77.42Z" />
  </svg>
);
const IconStop: React.FC = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="1.6" />
  </svg>
);
const IconRestart: React.FC = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" />
  </svg>
);
const IconMore: React.FC = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
  </svg>
);

interface ContextMenuPos { x: number; y: number; }
interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
}

const RowContextMenu: React.FC<{
  pos: ContextMenuPos;
  items: ContextMenuItem[];
  onClose: () => void;
}> = ({ pos, items, onClose }) => {
  /* 监听全局 click / Escape / scroll → 关菜单. mousedown 而非 click, 避免菜单项点击事件丢失. */
  React.useEffect(() => {
    const onDown = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    /* 用 setTimeout 防止当前 contextmenu 事件本身触发 close */
    const t = setTimeout(() => {
      window.addEventListener('mousedown', onDown);
      window.addEventListener('keydown', onKey);
      window.addEventListener('blur', onClose);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  return createPortal(
    <div
      className="sfc-services__ctxmenu"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      role="menu"
    >
      {items.map((it, i) => it.divider ? (
        <div key={`d-${i}`} className="sfc-services__ctxmenu-divider" role="separator" />
      ) : (
        <button
          key={it.label}
          type="button"
          className={`sfc-services__ctxmenu-item${it.danger ? ' is-danger' : ''}`}
          disabled={it.disabled}
          onClick={() => { onClose(); it.onClick(); }}
          role="menuitem"
        >{it.label}</button>
      ))}
    </div>,
    interactionDoc().body,
  );
};

export const ServicesSurfaceViewer: React.FC<{
  surface: Surface;
  /** IdeBottomPanel 嵌入态: 走左右 master-detail 横向布局.
   *  左窄列表 (220px) + 右侧详情 + 日志 (flex:1), splitter 横向 col-resize.
   *  非嵌入 (独立 Surface) 仍走原来的上下布局. */
  embedded?: boolean;
}> = ({ surface, embedded }) => {
  const { workspacePath, activeSession } = useNeoxRuntime();
  const { isZh } = useI18n();
  const [procs, setProcs] = useState<ProcessRow[]>([]);
  const [configs, setConfigs] = useState<ServiceConfig[]>([]);
  /* P3+: surface.metadata.selectedPid — BgTasksBar 点终端 icon 时带过来,
   * 让 panel 直接预选这个 pid 的服务行. */
  const initialSelected = useMemo(() => {
    const pid = (surface.metadata as any)?.selectedPid;
    return typeof pid === 'number' ? `pid-${pid}` : null;
  }, [surface.metadata]);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelected);
  /* metadata 变 (再次点终端 icon, 切到别的 pid) 也要联动 */
  useEffect(() => {
    if (initialSelected) setSelectedId(initialSelected);
  }, [initialSelected]);
  const [showNewForm, setShowNewForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  /* 编辑模式: 持有要编辑的 ServiceConfig. 跟 showNewForm 互斥 — 都是同一个表单组件,
   *   editTarget !== null 表示弹"编辑", null 时若 showNewForm 为 true 则弹"新建". */
  const [editTarget, setEditTarget] = useState<ServiceConfig | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [snapshotFresh, setSnapshotFresh] = useState(true);
  const [historyItems, setHistoryItems] = useState<ServiceHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySelected, setHistorySelected] = useState<string | null>(null);
  const [historyLog, setHistoryLog] = useState<string>('');
  const [logFilter, setLogFilter] = useState('');
  const [logErrOnly, setLogErrOnly] = useState(false);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  /* 右键菜单状态 — pos + row payload. configId / pid 决定可用项. */
  const [ctxMenu, setCtxMenu] = useState<{
    pos: ContextMenuPos;
    rowId: string;
    configId?: string;
    pid?: number;
    isRunning: boolean;
    hasPort: boolean;
    port?: number;
    /* ad-hoc 行 "保存为 RunConfig" 用 — 不从 rowId 反查避免菜单显示中状态过期 */
    command?: string;
    cwd?: string;
    friendlyName?: string;
  } | null>(null);
  /* 任何 overlay (右键菜单 / 新建表单 / 扫描导入 modal) 显示时 fade-suppress 跟它重叠的 BrowserView,
   * 防 OS native 盖住 DOM. 没传 overlayRef → bbox 检测 fallback 全部 suppress. */
  useSuppressBrowserView(!!ctxMenu || showNewForm || showImport || !!editTarget);
  /* 批量选择: row checkbox 选中的 pid 集合. 选中后顶部出现 batch toolbar (kill / clear) */
  /* 批量选择 — key 是 rowId (configured 用 config.id, adhoc 用 'pid-N'), 不再只用 pid.
   * 这样停止中的 configured 行也能勾, 配合 batch toolbar 的"启动"按钮. */
  const [checkedRowIds, setCheckedRowIds] = useState<Set<string>>(() => new Set());
  const startingConfigIdsRef = useRef<Set<string>>(new Set());
  const [startingConfigIds, setStartingConfigIds] = useState<Set<string>>(() => new Set());
  /* Surface 独立模式 (默认): 上下布局, 列表占顶部固定高度.
   * IDE 嵌入模式 (embedded): 左右布局, 列表占左侧固定宽度.
   *
   *   两种 splitter 共用同一份大小状态 — 在两套布局间切换时不复用 (高度跟宽度量纲不同).
   *   localStorage key 分两份, 互不污染. */
  const [listHeight, setListHeight] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem('neox.services.listHeight'));
      return Number.isFinite(n) && n >= 120 ? n : 220;
    } catch { return 220; }
  });
  const [listWidth, setListWidth] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem('neox.services.listWidth'));
      /* IDE 底部面板窄, 240 够; Surface 整页左右摆时行里还有重启/停止/⋯, 240 会把名字挤没 */
      return Number.isFinite(n) && n >= 200 ? n : (embedded ? 240 : 320);
    } catch { return embedded ? 240 : 320; }
  });
  const [layoutPref, setLayoutPref] = useState<'row' | 'column'>(() => {
    try { return localStorage.getItem('neox.services.layout') === 'column' ? 'column' : 'row'; } catch { return 'row'; }
  });
  const [hideList, setHideList] = useState<boolean>(() => {
    try { return localStorage.getItem('neox.services.hideList') === '1'; } catch { return false; }
  });
  const [hideDetail, setHideDetail] = useState<boolean>(() => {
    try { return localStorage.getItem('neox.services.hideDetail') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try {
      localStorage.setItem('neox.services.layout', layoutPref);
      localStorage.setItem('neox.services.hideList', hideList ? '1' : '0');
      localStorage.setItem('neox.services.hideDetail', hideDetail ? '1' : '0');
    } catch { /* ignore */ }
  }, [layoutPref, hideList, hideDetail]);
  const horizontal = embedded || layoutPref === 'row';

  const onListSplitterDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (horizontal) {
      /* 横向 splitter: 拖动改 list 宽度 */
      const startX = e.clientX;
      const startW = listWidth;
      const onMove = (e2: MouseEvent) => {
        const delta = e2.clientX - startX;
        /* min 200 — header 一行 nowrap 紧凑后, 200px 是 4 icon + count badge 不重叠的下限 */
        const next = Math.max(200, Math.min(480, startW + delta));
        setListWidth(next);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      return;
    }
    /* 上下 splitter: 拖动改 list 高度 (原行为) */
    const startY = e.clientY;
    /* 列表现在按内容收起, 实际高度可能比上限小 —— 从看得见的高度开始拖, 不然一按就跳 */
    const shownH = (e.currentTarget as HTMLElement).previousElementSibling?.getBoundingClientRect().height;
    const startH = shownH && shownH > 0 ? Math.round(shownH) : listHeight;
    const onMove = (e2: MouseEvent) => {
      const delta = e2.clientY - startY;
      const next = Math.max(120, Math.min(600, startH + delta));
      setListHeight(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, [horizontal, listHeight, listWidth]);
  useEffect(() => {
    try { localStorage.setItem('neox.services.listHeight', String(listHeight)); } catch {}
  }, [listHeight]);
  useEffect(() => {
    try { localStorage.setItem('neox.services.listWidth', String(listWidth)); } catch {}
  }, [listWidth]);

  /* poll processes */
  const reloadProcs = useCallback(async () => {
    const list = (await (window as any).neox?.processList?.()) || [];
    setProcs(list);
    /* 拉到的就是 server 快照本身 —— 顺手灌进 store, 让时间线那条后台任务栏跟本面板
     * 用同一份数据。两个视图各说各话 (顶部说 2 个后台任务、面板说 1 个服务) 的老问题
     * 从此在物理上不可能。 */
    try {
      const { ingestServiceSnapshot } = await import('../../../state/backgroundTasksStore');
      ingestServiceSnapshot({ generatedAt: Date.now(), processes: list });
    } catch { /* best-effort */ }
  }, []);
  const loadHistory = useCallback(async () => {
    if (!workspacePath) return;
    setHistoryLoading(true);
    try {
      const r = await (window as any).neox?.serviceListHistory?.(workspacePath);
      setHistoryItems(Array.isArray(r?.instances) ? r.instances : []);
    } catch { setHistoryItems([]); }
    finally { setHistoryLoading(false); }
  }, [workspacePath]);

  const openHistoryLog = useCallback(async (item: ServiceHistoryItem) => {
    setHistorySelected(`${item.pid}-${item.startTime}`);
    setHistoryLog('');
    try {
      const r = await (window as any).neox?.serviceReadLog?.(item.pid, item.startTime);
      setHistoryLog(String(r?.output ?? '') || (isZh ? '（这次运行没有留下输出）' : '(no output recorded for this run)'));
    } catch (err: any) {
      setHistoryLog(isZh ? `读取日志失败: ${err?.message}` : `Failed to read log: ${err?.message}`);
    }
  }, [isZh]);

  useEffect(() => { if (showHistory) void loadHistory(); }, [showHistory, loadHistory]);

  /* 每 2s 复核一次快照新鲜度 —— 见 header 里的失联提示。 */
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (cancelled) return;
      try {
        const { isSnapshotFresh } = await import('../../../state/backgroundTasksStore');
        if (!cancelled) setSnapshotFresh(isSnapshotFresh());
      } catch { /* ignore */ }
    };
    void check();
    const id = window.setInterval(check, 2000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  useEffect(() => {
    void reloadProcs();
  }, [reloadProcs]);
  useVisibilityInterval(reloadProcs, POLL_PROCS_MS);

  /* P3+: backgroundTasksStore 变化 (SSE 推过来 add/update) 时即时 force-refresh,
   * 不用等 2s polling — 起服务后右栏几乎瞬间看到. */
  const bgTasks = useBackgroundTasks(activeSession?.id);
  const lastBgSig = useRef<string>('');
  useEffect(() => {
    const sig = bgTasks.map(t => `${t.pid}|${t.status}`).sort().join(',');
    if (sig === lastBgSig.current) return;
    lastBgSig.current = sig;
    void reloadProcs();
  }, [bgTasks, reloadProcs]);

  /* IDE 底部面板嵌入态启动后, 自动把刚启动的 service 选中 (highlight master row).
   *   左右布局下选中即在右侧详情显示日志, 不需要切独立 tab.
   *   ref 记 "等会 procs 拉到 pid 的 config id", 等真有 pid 推过来设 selectedId. */
  const pendingAutoSelectIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!embedded || pendingAutoSelectIds.current.size === 0) return;
    for (const proc of procs) {
      const cid = proc.config_id;
      if (cid && pendingAutoSelectIds.current.has(cid) && proc.pid && proc.status === 'running') {
        pendingAutoSelectIds.current.delete(cid);
        setSelectedId(cid);
      }
    }
  }, [embedded, procs]);


  /* load configs */
  const reloadConfigs = useCallback(async () => {
    if (!workspacePath) return;
    const r = await (window as any).neox?.serviceListConfigs?.(workspacePath);
    if (r?.success) setConfigs(r.configs || []);
  }, [workspacePath]);
  useEffect(() => {
    void reloadConfigs();
  }, [reloadConfigs]);
  useVisibilityInterval(reloadConfigs, POLL_PROCS_MS * 3);

  const reloadServices = useCallback(() => {
    void reloadProcs();
    void reloadConfigs();
  }, [reloadProcs, reloadConfigs]);

  const startConfig = useCallback(async (
    configId: string,
    options: StartConfigOptions = {},
  ): Promise<ServiceStartResult> => {
    if (!workspacePath) {
      return { ok: false, error: isZh ? 'workspace 未就绪' : 'Workspace is not ready' };
    }
    if (startingConfigIdsRef.current.has(configId)) {
      return { ok: true, reused: true };
    }

    startingConfigIdsRef.current.add(configId);
    setStartingConfigIds(new Set(startingConfigIdsRef.current));
    if (options.select) {
      setSelectedId(configId);
      if (embedded) pendingAutoSelectIds.current.add(configId);
    }

    try {
      const api = (window as any).neox?.serviceStartConfig;
      if (typeof api !== 'function') {
        return { ok: false, error: 'IPC `serviceStartConfig` 未就绪 (preload 没暴露)' };
      }
      const raw = await api(workspacePath, configId, activeSession?.id);
      if (!raw) {
        return { ok: false, error: isZh ? '启动调用返回空, 检查 server 进程是否存活' : 'Start returned empty result; check whether the server process is alive' };
      }
      /* 端口冲突: 不当成普通失败 —— 直接问用户"要不要停掉占用者再起"。
       * 这是开发时最高频的一种启动失败 (上一次没停干净 / 另一个窗口起着同一个服务),
       * 干扔一句 EADDRINUSE 等于让用户自己去 lsof。占用者是 Neox 管的进程时甚至
       * 可以一键接管, 不用离开面板。 */
      if (raw.ok === false && raw.portConflict) {
        const pc = raw.portConflict;
        const ok = await confirmAsync({
          title: isZh ? `端口 ${pc.port} 已被占用` : `Port ${pc.port} is in use`,
          message: isZh
            ? `进程 pid=${pc.pid} 正在监听 ${pc.port}。`
            : `Process pid=${pc.pid} is listening on ${pc.port}.`,
          description: `${pc.command.slice(0, 160)}\n\n` + (pc.tracked
            ? (isZh ? '它也是 Neox 在管的进程 —— 可以直接停掉它再启动。' : "It's also managed by Neox — you can stop it and start this one.")
            : (isZh ? '它不是 Neox 起的进程。停掉它需要你确认。' : 'It was not started by Neox. Stopping it needs your confirmation.')),
          variant: 'danger',
          confirmLabel: isZh ? `停止 pid=${pc.pid} 并启动` : `Stop pid=${pc.pid} and start`,
        });
        if (!ok) return { ok: false, error: raw.error, portConflict: pc };
        try { await (window as any).neox?.processKill?.(pc.pid); } catch { /* 继续 */ }
        await waitPortFree(pc.port);
        const retry = await api(workspacePath, configId, activeSession?.id);
        if (options.refresh !== false) void reloadProcs();
        return retry?.ok === false
          ? { ok: false, error: retry.error || (isZh ? '未知错误' : 'Unknown error') }
          : { ...retry, ok: true };
      }
      const result: ServiceStartResult = raw.ok === false
        ? { ok: false, error: raw.error || (isZh ? '未知错误' : 'Unknown error') }
        : { ...raw, ok: true };
      if (options.refresh !== false) {
        void reloadProcs();
        setTimeout(() => { void reloadProcs(); }, 500);
        setTimeout(() => { void reloadProcs(); }, 2000);
        setTimeout(() => { void reloadProcs(); }, 5000);
      }
      return result;
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    } finally {
      startingConfigIdsRef.current.delete(configId);
      setStartingConfigIds(new Set(startingConfigIdsRef.current));
    }
  }, [workspacePath, isZh, embedded, activeSession?.id, reloadProcs]);

  /** 历史 → 再跑一次: 落一条临时 RunConfig 再走正常启动路径 (于是端口预检 / 自动绑定
   *  / 快照全都自然生效)。已有同命令同目录的配置就直接复用, 不重复堆配置。 */
  const rerunHistory = useCallback(async (h: ServiceHistoryItem) => {
    if (!workspacePath) return;
    const existing = configs.find(c => c.command === h.command && c.cwd === h.cwd);
    let id = existing?.id;
    if (!id) {
      id = slugifyConfigId(h.displayName || h.command, configs);
      const r = await (window as any).neox?.serviceUpsertConfig?.(workspacePath, {
        id, name: h.displayName || id, command: h.command, cwd: h.cwd,
        port: h.port, createdBy: 'user',
      });
      if (r?.ok === false) {
        dispatchOpFailed({ op: isZh ? '再跑一次' : 'Run again', message: r.error || '' });
        return;
      }
      await reloadConfigs();
    }
    setShowHistory(false);
    const res = await startConfig(id, { select: true, refresh: true });
    if (res.ok) dispatchHint(isZh ? '已重新启动' : 'Restarted', 'success');
    else if (res.error) dispatchOpFailed({ op: isZh ? '再跑一次' : 'Run again', message: res.error });
  }, [workspacePath, configs, isZh, reloadConfigs, startConfig]);

  const filteredHistoryLog = useMemo(() => {
    if (!logFilter && !logErrOnly) return historyLog;
    const q = logFilter.trim().toLowerCase();
    const ERR = /\b(error|err|fail(ed|ure)?|exception|fatal|panic|traceback)\b/i;
    return historyLog.split('\n').filter(line => {
      if (logErrOnly && !ERR.test(line)) return false;
      if (q && !line.toLowerCase().includes(q)) return false;
      return true;
    }).join('\n');
  }, [historyLog, logFilter, logErrOnly]);



  /* Manual refresh button — diagnostic / force-poll. */
  const handleForceRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([reloadProcs(), reloadConfigs()]);
    setTimeout(() => setRefreshing(false), 300);
  }, [reloadProcs, reloadConfigs]);

  const [groupBusy, setGroupBusy] = useState<string | null>(null);
  const groupMembers = useCallback((group: string) =>
    configs
      .filter(c => (c.group || '') === group)
      .sort((a, b) => (a.startOrder ?? 0) - (b.startOrder ?? 0) || a.createdAt - b.createdAt),
    [configs]);

  const waitForConfigUp = useCallback(async (configId: string, hasHealthcheck: boolean): Promise<boolean> => {
    const deadline = Date.now() + (hasHealthcheck ? 45_000 : 12_000);
    while (Date.now() < deadline) {
      const list = (await (window as any).neox?.processList?.().catch(() => [])) || [];
      const running = list.find((p: any) => p.config_id === configId && p.status === 'running');
      if (running) {
        if (hasHealthcheck) {
          if (running.healthy === true) return true;
        } else if (running.port !== undefined) {
          return true;
        } else if (typeof running.startTime === 'number' && Date.now() - running.startTime > 3_000) {
          return true; /* 无 healthcheck 无端口: 活过 3s 视为就绪 (worker 类) */
        }
      } else if (list.some((p: any) => p.config_id === configId && p.status !== 'running')) {
        return false; /* 出现过又秒退 → 明确失败 */
      }
      await new Promise(r => setTimeout(r, 1_000));
    }
    return !hasHealthcheck; /* healthcheck 超时算失败; 无 healthcheck 超时放行不阻断组 */
  }, []);

  const startGroup = useCallback(async (group: string) => {
    if (!workspacePath || groupBusy) return;
    const members = groupMembers(group);
    if (members.length === 0) return;
    setGroupBusy(group);
    try {
      let started = 0;
      for (const cfg of members) {
        const alreadyRunning = procs.some(p => p.config_id === cfg.id && p.status === 'running');
        if (alreadyRunning) continue;
        dispatchHint(isZh ? `${group}: 启动 ${cfg.name}…` : `${group}: starting ${cfg.name}…`, 'info');
        try {
          const r = await startConfig(cfg.id, { select: embedded, refresh: false });
          if (!r.ok) throw new Error(r.error || (isZh ? '未知错误' : 'Unknown error'));
        } catch (e: any) {
          dispatchOpFailed({
            op: isZh ? `启动服务组 ${group}` : `Start service group ${group}`,
            message: isZh ? `${cfg.name} 启动失败: ${friendlyOpError(e)}, 组启动中断` : `${cfg.name} failed to start: ${friendlyOpError(e)}. Group aborted.`,
          });
          return;
        }
        const ok = await waitForConfigUp(cfg.id, !!cfg.healthcheck);
        void reloadProcs();
        if (!ok) {
          dispatchOpFailed({
            op: isZh ? `启动服务组 ${group}` : `Start service group ${group}`,
            message: isZh ? `${cfg.name} 未就绪 (健康检查未通过/进程退出), 组启动中断` : `${cfg.name} not ready (health check failed / process exited). Group aborted.`,
          });
          return;
        }
        started++;
      }
      dispatchHint(
        started > 0
          ? (isZh ? `服务组 ${group} 已启动 (${started} 个)` : `Service group ${group} started (${started})`)
          : (isZh ? `服务组 ${group} 已全部在运行` : `Service group ${group} already fully running`),
        'success',
      );
    } finally {
      setGroupBusy(null);
      void reloadProcs();
      setTimeout(() => { void reloadProcs(); }, 2000);
    }
  }, [workspacePath, groupBusy, groupMembers, procs, embedded, waitForConfigUp, reloadProcs, startConfig, isZh]);

  const stopGroup = useCallback(async (group: string) => {
    /* 逆序停: 后起的先停 (下游先于上游) */
    const members = groupMembers(group).slice().reverse();
    const pids = members
      .map(cfg => procs.find(p => p.config_id === cfg.id && p.status === 'running')?.pid)
      .filter((p): p is number => typeof p === 'number');
    if (pids.length === 0) return;
    for (const pid of pids) {
      await (window as any).neox?.killBackgroundTask?.(pid, false)?.catch?.(() => undefined);
    }
    dispatchHint(isZh ? `服务组 ${group} 已停止 (${pids.length} 个)` : `Service group ${group} stopped (${pids.length})`, 'success');
    setTimeout(() => { void reloadProcs(); }, 300);
  }, [groupMembers, procs, reloadProcs]);

  const stopRow = useCallback(async (row: { proc?: ProcessRow; config?: ServiceConfig }) => {
    const pid = row.proc?.pid;
    if (typeof pid !== 'number') return;
    const label = getRowDisplayName(row.proc, row.config);
    try {
      await (window as any).neox?.killBackgroundTask?.(pid, false);
      dispatchHint(isZh ? `${label} 已停止` : `${label} stopped`, 'success');
    } catch (e: any) {
      dispatchOpFailed({
        op: isZh ? `停止 ${label}` : `Stop ${label}`,
        message: friendlyOpError(e),
      });
    }
    setTimeout(() => { void reloadProcs(); }, 300);
  }, [reloadProcs, isZh]);

  const restartRow = useCallback(async (row: { proc?: ProcessRow; config?: ServiceConfig }) => {
    let configId = row.config?.id;
    const label = getRowDisplayName(row.proc, row.config);
    const pid = row.proc?.pid;

    if (!configId) {
      const cmd = row.proc?.command;
      const cwd = row.proc?.cwd;
      if (!cmd) {
        dispatchOpFailed({
          op: isZh ? `重启 ${label}` : `Restart ${label}`,
          message: isZh ? '拿不到这个进程的启动命令, 无法重启' : 'Cannot read this process command; restart is unavailable',
        });
        return;
      }
      const newId = slugifyConfigId(label || `service-${pid ?? Date.now()}`, configs);
      try {
        await (window as any).neox?.serviceUpsertConfig?.(workspacePath, {
          id: newId,
          name: (label || newId).trim(),
          command: cmd,
          cwd,
          createdBy: 'user',
        });
        if (typeof pid === 'number') {
          await (window as any).neox?.serviceBind?.(pid, newId)?.catch?.(() => undefined);
        }
        await reloadConfigs();
        configId = newId;
        dispatchHint(
          isZh ? `已为 ${label} 生成启动配置, 之后可直接启动` : `Created a start config for ${label}`,
          'info',
        );
      } catch (err: any) {
        dispatchOpFailed({
          op: isZh ? `重启 ${label}` : `Restart ${label}`,
          message: isZh ? `无法生成启动配置: ${friendlyOpError(err)}` : `Could not create a start config: ${friendlyOpError(err)}`,
        });
        return;
      }
    }
    if (typeof pid === 'number') {
      const oldPort = procs.find(p => p.pid === pid)?.port;
      try { await (window as any).neox?.killBackgroundTask?.(pid, false); } catch { /* 已经没了也继续起 */ }
      /* 等端口真的释放, 不是猜一个毫秒数 — 见 waitPortFree */
      await waitPortFree(oldPort);
    }
    const res = await startConfig(configId, { select: embedded, refresh: true });
    if (res.ok) {
      dispatchHint(isZh ? `${label} 已重启` : `${label} restarted`, 'success');
    } else {
      dispatchOpFailed({
        op: isZh ? `重启 ${label}` : `Restart ${label}`,
        message: res.error || (isZh ? '未知错误' : 'Unknown error'),
      });
    }
    setTimeout(() => { void reloadProcs(); }, 400);
  }, [startConfig, embedded, reloadProcs, reloadConfigs, configs, workspacePath, isZh]);

  const isLongLived = useCallback((proc: ProcessRow | undefined, cfg: ServiceConfig | undefined): boolean => {
    if (cfg) return true;                        /* 有 RunConfig = 用户/agent 显式声明过 */
    if (!proc) return false;
    if (proc.kind === 'free-shell') return false;
    if (proc.kind === 'agent-task') return false;
    if (proc.config_id) return true;
    /* 用户显式转正, 或 adopt 外部进程 (本身就是用户动作) —— 这是唯一的"常驻"来源。 */
    return proc.persistent === true;
  }, []);

  /* compose rows.
   *   · Configured: 优先 running, 否则 recently-exited (config 永远露面 + 显示死因)
   *   · Adhoc: 排除 kind='free-shell' (用户的交互式 zsh 不算服务)
   *     - 长期 adhoc 一直保留
   *     - 临时 adhoc 退出 > 30s 自动消失 (避免列表被一次性命令填满)
   *   排序: pinned → running → exited */
  const TEMP_EXITED_TTL_MS = 30_000;
  const rows: RowItem[] = useMemo(() => {
    const out: RowItem[] = [];
    for (const cfg of configs) {
      const running = procs.find(p => p.config_id === cfg.id && p.status === 'running');
      const exited = !running
        ? procs.find(p => p.config_id === cfg.id && p.status !== 'running')
        : undefined;
      out.push({
        kind: 'configured',
        config: cfg,
        proc: running ?? exited,
        pinned: cfg.pinned === true,
        sortBy: cfg.createdAt,
        section: 'service',
      });
    }
    const now = Date.now();
    for (const p of procs) {
      if (p.config_id) continue;
      if (p.kind === 'free-shell') continue;
      const longLived = isLongLived(p, undefined);
      /* 临时任务退出 > 30s 自动消失. 长期任务保留. */
      if (!longLived && p.status !== 'running' && p.endTime && now - p.endTime > TEMP_EXITED_TTL_MS) {
        continue;
      }
      if (!longLived && p.owner_session_id && activeSession?.id && p.owner_session_id !== activeSession.id) {
        continue;
      }
      out.push({
        kind: 'adhoc',
        proc: p,
        pinned: false,
        sortBy: p.startTime,
        /* ephemeral (install/build 类一次性命令) 进"一次性任务"分区, 不混进服务区 */
        section: longLived ? 'service' : 'task',
      });
    }
    out.sort((a, b) => {
      /* 服务区永远在前 — 一次性任务不抢占列表头部, 也不抢默认选中 (rows[0] 派生跟随) */
      if (a.section !== b.section) return a.section === 'service' ? -1 : 1;
      /* Compound 组: 未分组在前, 有组的按组名聚拢 (组头渲染依赖同组相邻) */
      const aGroup = a.config?.group || '';
      const bGroup = b.config?.group || '';
      if (aGroup !== bGroup) {
        if (!aGroup) return -1;
        if (!bGroup) return 1;
        return aGroup.localeCompare(bGroup);
      }
      /* 组内: 按 startOrder (组启动顺序即视觉顺序) */
      if (aGroup && a.config && b.config) {
        const orderDiff = (a.config.startOrder ?? 0) - (b.config.startOrder ?? 0);
        if (orderDiff !== 0) return orderDiff;
      }
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const aRun = a.proc?.status === 'running' ? 0 : 1;
      const bRun = b.proc?.status === 'running' ? 0 : 1;
      if (aRun !== bRun) return aRun - bRun;
      return b.sortBy - a.sortBy;
    });
    return out;
  }, [procs, configs, isLongLived, activeSession?.id]);

  const lookupSelection = useCallback((id: string | null) => {
    if (!id) return undefined;
    if (id.startsWith('pid-')) {
      const pid = Number(id.slice(4));
      const proc = procs.find(p => p.pid === pid);
      return proc ? { kind: 'adhoc' as const, proc, config: undefined } : undefined;
    }
    const cfg = configs.find(c => c.id === id);
    if (!cfg) return undefined;
    return { kind: 'configured' as const, config: cfg, proc: procs.find(p => p.config_id === cfg.id) };
  }, [procs, configs]);

  const selected = useMemo(() => {
    const pinned = lookupSelection(selectedId);
    if (pinned) return pinned;
    /* fallback: pin 对象消失或没 pin → 拿 rows[0] 派生 */
    const first = rows[0];
    if (!first) return undefined;
    if (first.kind === 'configured') {
      return { kind: 'configured' as const, config: first.config!, proc: first.proc };
    }
    return { kind: 'adhoc' as const, proc: first.proc!, config: undefined };
  }, [selectedId, lookupSelection, rows]);

  /* 当前生效的 row id — 给 row 高亮和 selectedId 同步使用.
   * 派生模式时它就是 rows[0] 的 id; pin 模式时就是 selectedId. */
  const effectiveSelectedId: string | null = useMemo(() => {
    if (!selected) return null;
    if (selected.kind === 'configured') return selected.config!.id;
    return `pid-${selected.proc!.pid}`;
  }, [selected]);

  const serviceCount = useMemo(
    () => rows.filter(r => r.section === 'service').length,
    [rows],
  );
  const runningCount = useMemo(
    () => rows.filter(r => r.section === 'service' && r.proc?.status === 'running').length,
    [rows],
  );
  const listCountLabel = useMemo(() => {
    if (isZh) {
      if (serviceCount === 0) return '0 个服务';
      if (runningCount > 0 && runningCount !== serviceCount) {
        return `${serviceCount} 个 · ${runningCount} 运行中`;
      }
      if (runningCount > 0) return `${runningCount} 个服务运行中`;
      return `${serviceCount} 个服务`;
    }
    if (serviceCount === 0) return '0 services';
    if (runningCount > 0 && runningCount !== serviceCount) {
      return `${serviceCount} · ${runningCount} running`;
    }
    if (runningCount > 0) return `${runningCount} running`;
    return `${serviceCount} service${serviceCount === 1 ? '' : 's'}`;
  }, [isZh, serviceCount, runningCount]);
  const isEmpty = rows.length === 0;

  /* 搜索过滤: 命中 name 或 command, 大小写不敏感. */
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => {
      const name = getRowDisplayName(r.proc, r.config) || '';
      const cmd = r.proc?.command ?? r.config?.command ?? '';
      return name.toLowerCase().includes(q) || cmd.toLowerCase().includes(q);
    });
  }, [rows, search]);

  /* embedded → 左右 master-detail (IDE 底部面板, 短宽长形场景).
   *   list 占左固定宽 (默认 240, localStorage 持久化), 详情占右 flex:1.
   * 非 embedded (Surface 模式) → 上下 master-detail (原行为). */
  /* 空态必须看得见列表 (那是"扫描 / 新建"的入口); 没服务时详情窗本来就不渲染 */
  const showList = isEmpty || !hideList;
  const showDetail = !isEmpty && !hideDetail;
  const listStyle: React.CSSProperties = (isEmpty || !showDetail || showHistory)
    ? { flex: '1 1 auto', width: 'auto', height: 'auto' }
    : horizontal
      ? { width: listWidth, flexBasis: listWidth }
      : { flex: '0 1 auto', height: 'auto', maxHeight: listHeight };

  /* 窗格控制: 布局方向 + 收起列表 + 收起详情。放在列表头右侧那组图标里, 同一个风格。 */
  const paneBtn = (opts: { title: string; active?: boolean; onClick: () => void; icon: React.ReactNode }) => (
    <button
      type="button"
      className={`sfc-services__list-iconbtn${opts.active ? ' is-active' : ''}`}
      onClick={opts.onClick}
      title={opts.title}
      aria-label={opts.title}
      aria-pressed={opts.active}
    >{opts.icon}</button>
  );
  const iconSplitRow = (
    <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden>
      <rect x="1.5" y="2" width="11" height="10" rx="2" /><path d="M5.5 2 V12" />
    </svg>
  );
  const iconSplitColumn = (
    <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden>
      <rect x="1.5" y="2" width="11" height="10" rx="2" /><path d="M1.5 6 H12.5" />
    </svg>
  );
  const iconDetail = (
    <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="1.5" y="2" width="11" height="10" rx="2" /><path d="M4 6 L5.8 7.5 L4 9" /><path d="M7.2 9 H10" />
    </svg>
  );
  const showListBtn = (
    <button
      type="button"
      className="sfc-services__pane-restore"
      onClick={() => setHideList(false)}
      title={isZh ? '显示服务列表' : 'Show service list'}
    >
      {horizontal ? iconSplitRow : iconSplitColumn}
      <span>{isZh ? '服务列表' : 'Services'}</span>
    </button>
  );
  const paneControls = (
    <>
      {!embedded && paneBtn({
        title: layoutPref === 'row'
          ? (isZh ? '左右布局 · 点一下换成上下' : 'Side by side · click for top/bottom')
          : (isZh ? '上下布局 · 点一下换成左右' : 'Top/bottom · click for side by side'),
        onClick: () => setLayoutPref((v) => (v === 'row' ? 'column' : 'row')),
        icon: layoutPref === 'row' ? iconSplitRow : iconSplitColumn,
      })}
      {!isEmpty && paneBtn({
        title: hideDetail ? (isZh ? '显示详情和终端' : 'Show details & terminal') : (isZh ? '收起详情和终端' : 'Hide details & terminal'),
        active: !hideDetail,
        onClick: () => { setHideDetail((v) => !v); setHideList(false); },
        icon: iconDetail,
      })}
    </>
  );

  return (
    /* --horizontal 是 IDE 底部面板那套 (60 多条窄列压缩规则); Surface 页的左右布局只要结构, 用 --row */
    <div className={`sfc-services${embedded ? ' sfc-services--horizontal' : horizontal ? ' sfc-services--row' : ''}${showHistory ? ' is-history' : ''}`}>
      {/* ───── Master: 服务列表 (左右布局居左固宽, 上下布局居顶) ───── */}
      {showList && (
      <aside
        className={`sfc-services__list${isEmpty ? ' is-empty' : ''}`}
        role="navigation"
        aria-label="Services"
        style={listStyle}
      >
        {/* 头部: 服务列表 · N 个服务 · [新建] [导入] [刷新] (icon-only, 无边框)
         *   早期版本新建/导入是底部全宽按钮, 占额外一行 + 边框很视觉重. 改成 header
         *   右侧 icon, 行为不变, 但列表区净高度 +40px, 列表更聚焦. */}
        <div className="sfc-services__list-header">
          <div className="sfc-services__list-title">{isZh ? '服务列表' : 'Services'}</div>
          <div className="sfc-services__list-header-right">
            <div className="sfc-services__list-count">{listCountLabel}</div>
            <button
              className={`sfc-services__list-iconbtn${searchOpen ? ' is-active' : ''}`}
              onClick={() => {
                const next = !searchOpen;
                setSearchOpen(next);
                if (next) setTimeout(() => searchInputRef.current?.focus(), 0);
                else setSearch('');
              }}
              title={isZh ? '搜索' : 'Search'}
              aria-label={isZh ? '搜索' : 'Search'}
              aria-expanded={searchOpen}
            >
              <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="6" r="4.2" />
                <path d="M9 9 L12 12" />
              </svg>
            </button>
            <button
              className="sfc-services__list-iconbtn"
              onClick={() => setShowNewForm(true)}
              title={isZh ? '新建服务' : 'New service'}
              aria-label={isZh ? '新建' : 'New'}
            >
              <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M7 2 L7 12" />
                <path d="M2 7 L12 7" />
              </svg>
            </button>
            <button
              className="sfc-services__list-iconbtn"
              onClick={() => setShowImport(true)}
              title={isZh
                ? `扫描工程 — 从 ${SCAN_SOURCES_SUMMARY_ZH}自动识别服务`
                : `Scan project — auto-detect services from ${SCAN_SOURCES_SUMMARY_EN}`}
              aria-label={isZh ? '扫描工程' : 'Scan project'}
            >
              <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1.8 4.5 V2.8 a1 1 0 0 1 1-1 H4.5" />
                <path d="M9.5 1.8 H11.2 a1 1 0 0 1 1 1 V4.5" />
                <path d="M12.2 9.5 V11.2 a1 1 0 0 1-1 1 H9.5" />
                <path d="M4.5 12.2 H2.8 a1 1 0 0 1-1-1 V9.5" />
                <path d="M3.8 7 H10.2" />
              </svg>
            </button>
            <button
              className={`sfc-services__list-iconbtn${showHistory ? ' is-active' : ''}`}
              onClick={() => setShowHistory(v => !v)}
              title={isZh
                ? '历史 — 已退出的服务/任务, 记录留 24 小时, 终端输出留 7 天'
                : 'History — exited services/tasks, records kept 24h, terminal output 7 days'}
              aria-label={isZh ? '历史' : 'History'}
              aria-pressed={showHistory}
            >
              {/* 时钟 = 回溯 */}
              <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="7" cy="7" r="5.2" />
                <path d="M7 4 L7 7 L9.2 8.4" />
              </svg>
            </button>
            <button
              className={`sfc-services__list-iconbtn${refreshing ? ' is-spin' : ''}`}
              onClick={handleForceRefresh}
              title={isZh ? '立即刷新' : 'Refresh'}
              aria-label={isZh ? '刷新' : 'Refresh'}
            >
              <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11.5 2.5 v3 h-3" />
                <path d="M11.5 5.5 A4.5 4.5 0 1 0 12 8" />
              </svg>
            </button>
            <span className="sfc-services__list-iconsep" aria-hidden />
            {paneControls}
            {!isEmpty && showDetail && paneBtn({
              title: isZh ? '收起服务列表' : 'Hide service list',
              onClick: () => setHideList(true),
              icon: horizontal ? (
                <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="1.5" y="2" width="11" height="10" rx="2" /><path d="M5.5 2 V12" /><path d="M9.5 5.5 L8 7 L9.5 8.5" />
                </svg>
              ) : (
                <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="1.5" y="2" width="11" height="10" rx="2" /><path d="M1.5 6 H12.5" /><path d="M5.5 9.5 L7 8 L8.5 9.5" />
                </svg>
              ),
            })}
          </div>
        </div>

        {showHistory ? (
          /* ── 历史视图 ────────────────────────────────────────────────────
           * 活跃列表保持干净 (只有在跑的 + 刚退出 5 分钟内的), 想回头看临时服务的终端
           * 就来这里。记录来自 sqlite (24h), 终端输出直接读盘上的日志文件 (7 天) ——
           * 这两份数据一直都在写, 只是以前没有任何入口能看到。 */
          <div className="sfc-services__history">
            <div className="sfc-services__history-head">
              <span>{isZh ? '历史运行记录' : 'Run history'}</span>
              <span className="sfc-services__history-hint">
                {isZh ? '记录 24 小时 · 终端输出 7 天' : 'records 24h · output 7 days'}
              </span>
            </div>
            {historyLoading ? (
              <div className="sfc-services__list-noresult neox-text-shimmer">{isZh ? '加载中…' : 'Loading…'}</div>
            ) : historyItems.length === 0 ? (
              <div className="sfc-services__list-noresult">
                {isZh ? '还没有历史记录' : 'No history yet'}
              </div>
            ) : (
              <div className="sfc-services__history-body">
                <ul className="sfc-services__history-list">
                  {historyItems.map((h) => {
                    const key = `${h.pid}-${h.startTime}`;
                    const bad = typeof h.exitCode === 'number' && h.exitCode !== 0;
                    const ranMs = (h.endTime ?? h.startTime) - h.startTime;
                    return (
                      <li
                        key={key}
                        className={`sfc-services__history-row${historySelected === key ? ' is-active' : ''}`}
                        onClick={() => void openHistoryLog(h)}
                        title={h.command}
                      >
                        <div className="sfc-services__history-name">
                          {h.displayName || (h.command.length > 46 ? h.command.slice(0, 46) + '…' : h.command)}
                        </div>
                        <div className="sfc-services__history-meta">
                          <button
                            type="button"
                            className="sfc-services__history-rerun"
                            title={isZh ? '用同样的命令和目录再跑一次' : 'Run again with the same command and cwd'}
                            onClick={(e) => { e.stopPropagation(); void rerunHistory(h); }}
                          >{isZh ? '再跑一次' : 'Run again'}</button>
                          <span>pid {h.pid}</span>
                          {h.port !== undefined && <span>:{h.port}</span>}
                          <span>{formatUptime(Math.max(0, Math.floor(ranMs / 1000)))}</span>
                          {typeof h.exitCode === 'number' && (
                            <span className={bad ? 'is-bad' : undefined}>exit {h.exitCode}</span>
                          )}
                          {h.endTime && <span>{formatAgo(h.endTime)}{isZh ? ' 前' : ' ago'}</span>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <div className="sfc-services__history-logwrap">
                  {historySelected && (
                    <div className="sfc-services__history-logbar">
                      <input
                        type="search"
                        value={logFilter}
                        onChange={(e) => setLogFilter(e.target.value)}
                        placeholder={isZh ? '过滤日志行…' : 'Filter log lines…'}
                        aria-label={isZh ? '过滤日志' : 'Filter log'}
                      />
                      <button
                        type="button"
                        className={logErrOnly ? 'is-on' : undefined}
                        onClick={() => setLogErrOnly(v => !v)}
                        title={isZh ? '只看包含 error/fail/exception 的行' : 'Only lines with error/fail/exception'}
                      >{isZh ? '只看错误' : 'Errors only'}</button>
                      <button
                        type="button"
                        onClick={() => { void copyToClipboard(historyLog); dispatchHint(isZh ? '已复制' : 'Copied', 'success'); }}
                      >{isZh ? '复制' : 'Copy'}</button>
                    </div>
                  )}
                  <pre className="sfc-services__history-log">
                    {historySelected
                      ? (filteredHistoryLog || (isZh ? '（没有匹配的行）' : '(no matching lines)'))
                      : (isZh ? '← 选一条记录查看它的终端输出' : '← pick a run to see its terminal output')}
                  </pre>
                </div>
              </div>
            )}
          </div>
        ) : isEmpty ? (
          /* 空状态卡片: 左 (插画 + 标题 + 副标题), 右 (按钮组), 两侧整体水平居中 + 垂直居中 */
          <div className="sfc-services__empty-center">
            <div className="sfc-services__empty-left">
              <div className="sfc-services__empty-illu" aria-hidden="true">
                <img className="nx-illus" src={NeoxIllus.code} alt="" draggable={false} />
                <div className="sfc-services__empty-marks">
                  <ServiceKindIcon command="mvn spring-boot:run" size={26} tile />
                  <ServiceKindIcon command="npm run dev" size={26} tile />
                  <ServiceKindIcon command="docker compose up" size={26} tile />
                  <ServiceKindIcon command="python -m uvicorn" size={26} tile />
                  <ServiceKindIcon command="go run ." size={26} tile />
                </div>
              </div>
              <h3 className="sfc-services__empty-title">{isZh ? '还没有服务' : 'No services yet'}</h3>
              <p className="sfc-services__empty-sub">{isZh ? '扫描工程自动识别 Spring Boot / npm dev / Docker 等可启动服务' : 'Scan the project to auto-detect Spring Boot / npm dev / Docker and other runnable services'}</p>
            </div>
            <div className="sfc-services__empty-right">
              {/* 扫描设为 primary — 比手动填表单效率高得多, 大部分用户走这条.
               * embedded 窄列下 CSS 重排为 menu-row (icon + title + sub) 跟右侧 hero feature 同款. */}
              <button
                className="sfc-services__btn-primary"
                onClick={() => setShowImport(true)}
              >
                <span className="sfc-services__btn-icon">
                  <svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6" cy="6" r="4.2" />
                    <path d="M9 9 L12 12" />
                  </svg>
                </span>
                <span className="sfc-services__btn-text">
                  <span className="sfc-services__btn-label">{isZh ? '扫描工程' : 'Scan project'}</span>
                  <span className="sfc-services__btn-sub">{isZh ? '自动识别 Spring Boot / npm / Docker' : 'Auto-detect Spring Boot / npm / Docker'}</span>
                </span>
              </button>
              <button
                className="sfc-services__btn-outline"
                onClick={() => setShowNewForm(true)}
                title={isZh ? '手动新建服务' : 'Create service manually'}
              >
                <span className="sfc-services__btn-icon">
                  <svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M7 2.5 L7 11.5" />
                    <path d="M2.5 7 L11.5 7" />
                  </svg>
                </span>
                <span className="sfc-services__btn-text">
                  <span className="sfc-services__btn-label">{isZh ? '手动新建' : 'Create manually'}</span>
                  <span className="sfc-services__btn-sub">{isZh ? '自行配置 command / cwd / env' : 'Configure command / cwd / env yourself'}</span>
                </span>
              </button>
            </div>
          </div>
        ) : (
          <>
            {searchOpen && (
              <div className="sfc-services__list-search">
                <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="6" cy="6" r="4.2" />
                  <path d="M9 9 L12 12" />
                </svg>
                <input
                  ref={searchInputRef}
                  type="search"
                  placeholder={isZh ? '搜索服务 (Esc 收回)' : 'Search services (Esc to close)'}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') { setSearch(''); setSearchOpen(false); }
                  }}
                  aria-label={isZh ? '搜索服务' : 'Search services'}
                />
                {search && (
                  <button
                    type="button"
                    className="sfc-services__list-search-clear"
                    onClick={() => setSearch('')}
                    title={isZh ? '清空' : 'Clear'}
                    aria-label={isZh ? '清空搜索' : 'Clear search'}
                  >×</button>
                )}
              </div>
            )}
            {/* 服务列表 */}
            {/* batch toolbar — 勾选 ≥1 行时出现.
             *   启动: 选中行里 configured + 没跑的, 全部 serviceStartConfig
             *   停止: 选中行里有 pid + 在跑的, 全部 SIGTERM
             *   按钮按上下文 enable/disable, 不可用时灰掉 (避免点了没反应) */}
            {checkedRowIds.size > 0 && (() => {
              const selectedRows = rows.filter(r => {
                const rid = r.kind === 'configured' ? r.config!.id : `pid-${r.proc!.pid}`;
                return checkedRowIds.has(rid);
              });
              const startable = selectedRows.filter(r =>
                r.kind === 'configured'
                && r.proc?.status !== 'running'
                && !startingConfigIds.has(r.config!.id)
              );
              const stoppable = selectedRows.filter(r => r.proc?.pid !== undefined && r.proc.status === 'running');
              return (
                <div className="sfc-services__batch-bar">
                  <span className="sfc-services__batch-count">{isZh ? `${checkedRowIds.size} 已选` : `${checkedRowIds.size} selected`}</span>
                  <div className="sfc-services__batch-spacer" />
                  <button
                    className="sfc-services__batch-btn"
                    disabled={startable.length === 0 || !workspacePath}
                    title={startable.length === 0
                      ? (isZh ? '选中行里没有可启动的(已在跑 或不是 configured)' : 'None of the selected rows can be started (already running, or not configured)')
                      : (isZh ? `启动 ${startable.length} 个: ${startable.map(r => r.config!.name).join(', ')}` : `Start ${startable.length}: ${startable.map(r => r.config!.name).join(', ')}`)}
                    onClick={async () => {
                      if (!workspacePath) return;
                      /* 串行启动避免一次性飙 N 个 mvn 同时编译爆内存. sessionId 透传给 server
                       * 让 shell_output_stream 推流路由到当前 UI session, 否则 ShellConsole 看不到日志. */
                      const failed: string[] = [];
                      for (const r of startable) {
                        try {
                          const res = await startConfig(r.config!.id, { select: embedded, refresh: false });
                          if (!res.ok) throw new Error(res.error || (isZh ? '未知错误' : 'Unknown error'));
                        } catch (e: any) {
                          failed.push(r.config?.name || r.config?.id || (isZh ? '未知服务' : 'Unknown service'));
                        }
                      }
                      /* 汇总反馈: 全成 / 部分失败 */
                      if (failed.length === 0) {
                        dispatchHint(isZh ? `已启动 ${startable.length} 个服务` : `Started ${startable.length} service${startable.length === 1 ? '' : 's'}`, 'success');
                      } else if (failed.length < startable.length) {
                        dispatchOpFailed({
                          op: isZh ? '批量启动服务' : 'Bulk start services',
                          message: isZh
                            ? `成功 ${startable.length - failed.length}/${startable.length}, 失败: ${failed.join('、')}`
                            : `${startable.length - failed.length}/${startable.length} succeeded. Failed: ${failed.join(', ')}`,
                        });
                      } else {
                        dispatchOpFailed({
                          op: isZh ? '批量启动服务' : 'Bulk start services',
                          message: isZh ? `全部失败: ${failed.join('、')}` : `All failed: ${failed.join(', ')}`,
                        });
                      }
                      setCheckedRowIds(new Set());
                      setTimeout(() => { void reloadProcs(); }, 500);
                      setTimeout(() => { void reloadProcs(); }, 2000);
                      setTimeout(() => { void reloadProcs(); }, 5000);
                    }}
                  >{isZh ? `▶ 启动 (${startable.length})` : `▶ Start (${startable.length})`}</button>
                  <button
                    className="sfc-services__batch-btn"
                    disabled={stoppable.length === 0}
                    title={stoppable.length === 0
                      ? (isZh ? '选中行里没有运行中的进程' : 'None of the selected rows have a running process')
                      : (isZh ? `停止 ${stoppable.length} 个 (SIGTERM, 2s 后 SIGKILL)` : `Stop ${stoppable.length} (SIGTERM, then SIGKILL after 2s)`)}
                    onClick={async () => {
                      const pids = stoppable.map(r => r.proc!.pid);
                      setCheckedRowIds(new Set());
                      await Promise.all(pids.map(p =>
                        (window as any).neox?.killBackgroundTask?.(p, false)?.catch?.(() => undefined),
                      ));
                      setTimeout(() => { void reloadProcs(); }, 300);
                    }}
                  >{isZh ? `■ 停止 (${stoppable.length})` : `■ Stop (${stoppable.length})`}</button>
                  <button
                    className="sfc-services__batch-btn"
                    onClick={() => setCheckedRowIds(new Set())}
                  >{isZh ? '取消选择' : 'Clear selection'}</button>
                </div>
              );
            })()}
            <div className="sfc-services__list-scroll">
              {filteredRows.length === 0 ? (
                <div className="sfc-services__list-noresult">{isZh ? '未找到匹配的服务' : 'No matching services'}</div>
              ) : filteredRows.map((row, rowIdx) => {
                /* 分区头: 排序已保证 task 全在 service 之后, 第一条 task 行前插 "一次性任务" 分隔头 */
                const isFirstTask = row.section === 'task'
                  && (rowIdx === 0 || filteredRows[rowIdx - 1].section !== 'task');
                /* Compound 组头: 同组行已被排序聚拢, 组的第一行前插组头 (名称 + 一键起停) */
                const rowGroup = row.section === 'service' ? (row.config?.group || '') : '';
                const isFirstOfGroup = !!rowGroup
                  && (rowIdx === 0 || (filteredRows[rowIdx - 1].config?.group || '') !== rowGroup);
                const id = row.kind === 'configured' ? row.config!.id : `pid-${row.proc!.pid}`;
                const active = id === effectiveSelectedId;
                const hasPid = !!row.proc;
                const name = getRowDisplayName(row.proc, row.config);
                const port = row.proc?.port ?? row.config?.port;
                const command = row.proc?.command ?? row.config?.command ?? '';
                const isRunning = row.proc?.status === 'running';
                /* meta 列: running 时显示 ":port · uptime" 紧凑组合, exited 时显示 "exit N · Xm前"
                 *   running: `:8888 · 1h39m` (有端口) / `1h39m` (无端口)
                 *   exited:  `exit 0 · 2m 前` */
                const metaParts: string[] = [];
                if (port !== undefined) metaParts.push(`:${port}`);
                if (row.proc) {
                  if (isRunning) {
                    const ut = typeof row.proc.uptime_sec === 'number'
                      ? formatUptime(row.proc.uptime_sec)
                      : formatAgo(row.proc.startTime);
                    metaParts.push(ut);
                  } else if (row.proc.endTime) {
                    const ec = row.proc.exitCode;
                    if (typeof ec === 'number') metaParts.push(`exit ${ec}`);
                    metaParts.push(isZh ? `${formatAgo(row.proc.endTime)} 前` : `${formatAgo(row.proc.endTime)} ago`);
                  }
                }
                /* meta 文案优先级:
                 *   1. 有数据 (端口 / uptime / exit) — 显示完整组合
                 *   2. configured 但没起 — 显示 "未运行" (比 "—" 信息量大)
                 *   3. 兜底 "—" */
                const metaText = metaParts.length > 0
                  ? metaParts.join(' · ')
                  : (row.kind === 'configured' && !row.proc)
                    ? (isZh ? '未运行' : 'Not running')
                    : '—';
                const metaStopped = metaParts.length === 0 && row.kind === 'configured' && !row.proc;
                const longLived = isLongLived(row.proc, row.config);
                const pid = row.proc?.pid;
                /* 行内操作用 — 启动中的 config 不能重复点, 正在批量操作时整行禁用 */
                const isStarting = !!row.config?.id && startingConfigIds.has(row.config.id);
                const busy = isStarting || (!!rowGroup && groupBusy === rowGroup);
                /* checkbox 用 rowId (configured / adhoc 都有), 不再绑 pid (允许选未运行的 config) */
                const isChecked = checkedRowIds.has(id);
                /* 但 adhoc 行没 config 也没 pid 不能勾 (理论上 adhoc 必有 pid, 防御性) */
                const canCheck = row.kind === 'configured' || pid !== undefined;
                const exitCode = !isRunning ? row.proc?.exitCode : undefined;
                const metaBad = typeof exitCode === 'number' && exitCode !== 0;
                return (
                  <React.Fragment key={id}>
                  {isFirstTask && (
                    <div className="sfc-services__section-head" role="presentation">
                      {isZh ? '一次性任务' : 'One-off tasks'}
                    </div>
                  )}
                  {isFirstOfGroup && (() => {
                    const members = groupMembers(rowGroup);
                    const runningInGroup = members.filter(cfg =>
                      procs.some(p => p.config_id === cfg.id && p.status === 'running')).length;
                    const busy = groupBusy === rowGroup || members.some(cfg => startingConfigIds.has(cfg.id));
                    return (
                      <div className="sfc-services__group-head" role="presentation">
                        <span className="sfc-services__group-name" title={isZh ? '服务组 · 按启动顺序串行起, 等健康后起下一个' : 'Service group · started in order, next only after previous is healthy'}>
                          {rowGroup}
                        </span>
                        <span className="sfc-services__group-count">{runningInGroup}/{members.length}</span>
                        <span className="sfc-services__group-actions">
                          <button
                            type="button"
                            className="sfc-services__group-btn"
                            disabled={busy || !workspacePath || runningInGroup === members.length}
                            title={busy
                              ? (isZh ? '组启动中…' : 'Group starting…')
                              : (isZh ? `按顺序启动整组 (${members.length} 个)` : `Start the whole group in order (${members.length})`)}
                            onClick={(e) => { e.stopPropagation(); void startGroup(rowGroup); }}
                          >{busy ? '…' : '▶'}</button>
                          <button
                            type="button"
                            className="sfc-services__group-btn"
                            disabled={busy || runningInGroup === 0}
                            title={isZh ? '逆序停止整组' : 'Stop the whole group in reverse order'}
                            onClick={(e) => { e.stopPropagation(); void stopGroup(rowGroup); }}
                          >■</button>
                        </span>
                      </div>
                    );
                  })()}
                  <div
                    role="row"
                    className={`sfc-services__row${active ? ' is-active' : ''}${row.kind === 'adhoc' ? ' is-adhoc' : ''}${row.section === 'task' ? ' is-task' : ''}`}
                    /* 详情窗收起着时, 点一个服务就是想看它 —— 顺手把详情叫回来 */
                    onClick={() => { setSelectedId(id); setHideDetail(false); }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSelectedId(id);  /* 右键先选中, 让用户清楚操作目标 */
                      setCtxMenu({
                        pos: { x: e.clientX, y: e.clientY },
                        rowId: id,
                        configId: row.config?.id,
                        pid: row.proc?.pid,
                        isRunning,
                        hasPort: port !== undefined,
                        port,
                        command: row.proc?.command ?? row.config?.command,
                        cwd: row.proc?.cwd ?? row.config?.cwd,
                        friendlyName: row.proc?.friendly_name ?? name,
                      });
                    }}
                    title={command ? `${name}\n${command}` : name}
                  >
                    <span
                      className="sfc-services__col-check"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!canCheck) return;
                        setCheckedRowIds(prev => {
                          const next = new Set(prev);
                          if (next.has(id)) next.delete(id);
                          else next.add(id);
                          return next;
                        });
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        readOnly
                        disabled={!canCheck}
                        tabIndex={-1}
                        aria-label={isZh ? `选择 ${name}` : `Select ${name}`}
                      />
                    </span>
                    {/* 技术栈真实 logo — Spring 绿叶 / Docker 蓝鲸 / npm 红 …
                      * 命令优先于 kind 判定: kind='shell' 但命令是 docker compose 时显示鲸鱼 */}
                    <span className={`sfc-services__col-logo${isRunning ? '' : ' is-idle'}${isStarting ? ' is-starting' : ''}`}>
                      <ServiceKindIcon command={command} size={28} tile />
                    </span>
                    <span className="sfc-services__col-main">
                      <span className="sfc-services__col-title">
                        <span className="sfc-services__col-name">{name}</span>
                        {port !== undefined && (
                          <span className="sfc-services__col-port">:{port}</span>
                        )}
                        <span className={`sfc-services__chip sfc-services__chip--${
                          isStarting ? 'starting'
                            : !hasPid ? 'idle'
                              : row.proc?.status === 'failed' ? 'failed'
                                : !isRunning ? 'idle'
                                  : row.proc?.healthy === true ? 'healthy' : 'running'
                        }`}>
                          {isStarting ? (isZh ? '启动中' : 'Starting')
                            : !hasPid ? (isZh ? '未启动' : 'Stopped')
                              : row.proc?.status === 'failed' ? (isZh ? '已失败' : 'Failed')
                                : row.proc?.status === 'killed' ? (isZh ? '已停止' : 'Stopped')
                                  : !isRunning ? (isZh ? '已结束' : 'Exited')
                                    : (isZh ? '运行中' : 'Running')}
                        </span>
                      </span>
                      {/* 副行: 类型 · pid · 运行时长 —— 一行说清"这是什么、跑了多久" */}
                      <span className={`sfc-services__col-sub${metaBad ? ' is-bad' : ''}${metaStopped ? ' is-stopped' : ''}`}>
                        <span className="sfc-services__col-sub-kind">
                          {longLived ? (isZh ? '长期' : 'Long-lived') : (isZh ? '临时' : 'Temporary')}
                        </span>
                        {metaText && <span className="sfc-services__col-sub-sep">·</span>}
                        <span className="sfc-services__col-meta-text">{metaText}</span>
                      </span>
                    </span>
                    {/* 行内操作 —— 启动/停止/重启不再只藏在右键菜单里 */}
                    <span className="sfc-services__col-ops" onClick={(e) => e.stopPropagation()}>
                      {/* 转正 / 取消转正 —— "长期"判据改成只认显式动作之后, 这里必须有个
                        * 地方做这个动作, 否则用户永远没法把一个真服务标成常驻。
                        * adhoc 行才有意义: configured 行本来就是工程级的。 */}
                      {row.kind === 'adhoc' && pid !== undefined && (
                        <button
                          type="button"
                          className={`sfc-services__op sfc-services__op--pin${row.proc?.persistent ? ' is-on' : ''}${
                            !row.proc?.persistent && typeof row.proc?.port === 'number' && row.proc.port > 0 && isRunning
                              ? ' is-suggested' : ''}`}
                          title={row.proc?.persistent
                            ? (isZh ? '取消常驻 — 回到只在本会话可见' : 'Unpin — session-only again')
                            : (typeof row.proc?.port === 'number' && row.proc.port > 0
                              ? (isZh ? `检测到监听 :${row.proc.port} — 设为常驻服务?` : `Listening on :${row.proc.port} — pin as service?`)
                              : (isZh ? '设为常驻服务 — 跨会话可见' : 'Pin as service — visible across sessions'))}
                          aria-label={row.proc?.persistent
                            ? (isZh ? `取消常驻 ${name}` : `Unpin ${name}`)
                            : (isZh ? `设为常驻服务 ${name}` : `Pin ${name} as service`)}
                          aria-pressed={row.proc?.persistent === true}
                          disabled={busy}
                          onClick={() => {
                            void setBackgroundTaskPersistent(pid, !row.proc?.persistent)
                              .then(() => { void reloadProcs(); });
                          }}
                        >📌</button>
                      )}
                      {isRunning ? (
                        <>
                          <button
                            type="button"
                            className="sfc-services__op sfc-services__op--restart"
                            title={isZh ? '重启' : 'Restart'}
                            aria-label={isZh ? `重启 ${name}` : `Restart ${name}`}
                            disabled={busy}
                            onClick={() => { void restartRow(row); }}
                          ><IconRestart /></button>
                          <button
                            type="button"
                            className="sfc-services__op sfc-services__op--stop"
                            title={isZh ? '停止' : 'Stop'}
                            aria-label={isZh ? `停止 ${name}` : `Stop ${name}`}
                            disabled={busy}
                            onClick={() => { void stopRow(row); }}
                          ><IconStop /></button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="sfc-services__op sfc-services__op--start"
                          title={isStarting ? (isZh ? '启动中…' : 'Starting…') : (isZh ? '启动' : 'Start')}
                          aria-label={isZh ? `启动 ${name}` : `Start ${name}`}
                          disabled={busy || isStarting || !row.config?.id}
                          onClick={() => { if (row.config?.id) void startConfig(row.config.id); }}
                        ><IconPlay /></button>
                      )}
                      <button
                        type="button"
                        className="sfc-services__op sfc-services__op--more"
                        title={isZh ? '更多操作' : 'More actions'}
                        aria-label={isZh ? `${name} 的更多操作` : `More actions for ${name}`}
                        onClick={(e) => {
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setSelectedId(id);
                          setCtxMenu({
                            pos: { x: r.right, y: r.bottom + 4 },
                            rowId: id,
                            configId: row.config?.id,
                            pid: row.proc?.pid,
                            isRunning,
                            hasPort: port !== undefined,
                            port,
                            command: row.proc?.command ?? row.config?.command,
                            cwd: row.proc?.cwd ?? row.config?.cwd,
                            friendlyName: row.proc?.friendly_name ?? name,
                          });
                        }}
                      ><IconMore /></button>
                    </span>
                  </div>
                  </React.Fragment>
                );
              })}
            </div>
            {/* 新建 / 导入按钮挪到 header 右侧的 icon 组, 这里不再占空间 */}
          </>
        )}
      </aside>
      )}

      {/* ───── Splitter: 嵌入态横向 col-resize, 否则纵向 row-resize ─────
        * 没有服务时详情栏不渲染, 这根分隔条也跟着撤 —— 否则会剩一根拖不出任何东西的把手 */}
      {showList && showDetail && (
        <div
          className="sfc-services__list-splitter"
          role="separator"
          aria-orientation={horizontal ? 'vertical' : 'horizontal'}
          aria-label={horizontal ? (isZh ? '拖动调整列表宽度' : 'Drag to resize list width') : (isZh ? '拖动调整列表高度' : 'Drag to resize list height')}
          onMouseDown={onListSplitterDown}
        />
      )}

      {showDetail && (
      <section className="sfc-services__detail">
        {!selected && !showList && (
          <div className="sfc-services__detail-head">{showListBtn}</div>
        )}
        {!selected && <ServicesEmptyHero hasRows={rows.length > 0} />}
        {selected && <ServiceDetail
        headLeading={showList ? undefined : showListBtn}
        row={selected}
        configs={configs}
        workspacePath={workspacePath}
        onReload={reloadServices}
        onOpenNewForm={() => setShowNewForm(true)}
        onEditConfig={(cfg) => setEditTarget(cfg)}
        onStartConfig={startConfig}
        startingConfigIds={startingConfigIds}
      />}
      </section>
      )}

      {(showNewForm || editTarget) && workspacePath && (
        <ServiceConfigForm
          key={editTarget?.id ?? '__new__'}  /* key 变化触发 unmount remount, 防 state 残留 */
          workspacePath={workspacePath}
          initial={editTarget ?? undefined}
          onClose={() => { setShowNewForm(false); setEditTarget(null); }}
          onSaved={(savedId, run) => {
            setShowNewForm(false);
            setEditTarget(null);
            void reloadConfigs().then(() => { if (run) void startConfig(savedId); });
          }}
        />
      )}
      {showImport && workspacePath && (
        <ImportWizard
          workspacePath={workspacePath}
          onClose={() => setShowImport(false)}
          onImported={() => {
            setShowImport(false);
            void reloadConfigs();
          }}
        />
      )}

      {ctxMenu && (() => {
        const { configId, pid, isRunning, hasPort } = ctxMenu;
        const configStarting = configId ? startingConfigIds.has(configId) : false;
        const items: ContextMenuItem[] = [];
        /* 启动 — configured + 没运行 */
        if (configId && !isRunning) items.push({
          label: configStarting ? (isZh ? '启动中…' : 'Starting…') : (isZh ? '▶ 启动' : '▶ Start'),
          disabled: configStarting,
          onClick: async () => {
            if (!workspacePath) return;
            const r = await startConfig(configId, { select: true });
            if (!r?.ok) {
              dispatchOpFailed({ op: isZh ? '启动服务' : 'Start service', message: r?.error || (isZh ? '未知错误' : 'Unknown error') });
            }
          },
        });
        if (hasPort && ctxMenu.port !== undefined) {
          const url = `http://localhost:${ctxMenu.port}`;
          items.push({
            label: isZh ? `复制地址 (${url})` : `Copy URL (${url})`,
            onClick: async () => {
              try {
                await copyToClipboard(url);
                dispatchHint(isZh ? `已复制 ${url}` : `Copied ${url}`, 'success');
              } catch {
                dispatchOpFailed({ op: isZh ? '复制地址' : 'Copy URL', message: isZh ? '剪贴板不可用' : 'Clipboard unavailable' });
              }
            },
          });
        }
        /* 停止 — running */
        if (isRunning && pid !== undefined) items.push({
          label: isZh ? '■ 停止' : '■ Stop',
          onClick: async () => {
            await (window as any).neox?.processKill?.(pid);
            setTimeout(() => { void reloadProcs(); }, 400);
          },
        });
        /* 重启 — configured + running */
        if (configId && isRunning && pid !== undefined) items.push({
          label: configStarting ? (isZh ? '重启中…' : 'Restarting…') : (isZh ? '↻ 重启' : '↻ Restart'),
          disabled: configStarting,
          onClick: async () => {
            if (!workspacePath) return;
            const oldPort = procs.find(p => p.pid === pid)?.port;
            await (window as any).neox?.processKill?.(pid);
            await waitPortFree(oldPort);
            const r = await startConfig(configId, { select: true });
            if (!r?.ok) {
              dispatchOpFailed({ op: isZh ? '重启服务' : 'Restart service', message: r?.error || (isZh ? '未知错误' : 'Unknown error') });
            }
          },
        });
        /* 浏览器打开 — running + 有端口 */
        if (isRunning && hasPort) items.push({
          label: isZh ? '在浏览器中打开' : 'Open in browser',
          onClick: () => {
            const proc = procs.find(p => p.pid === pid);
            const port = proc?.port ?? configs.find(c => c.id === configId)?.port;
            if (!port) return;
            const ev = new CustomEvent('neox:open-surface', {
              detail: { kind: 'web', source: { type: 'url', url: `http://localhost:${port}` }, title: 'web', byUser: true },
            });
            window.dispatchEvent(ev);
          },
        });
        if (items.length > 0) items.push({ label: '', onClick: () => {}, divider: true });
        /* 编辑 / 复制 — configured 才有意义 */
        if (configId) {
          const editingCfg = configs.find(c => c.id === configId) ?? null;
          items.push({
            label: isZh ? '编辑配置' : 'Edit config',
            disabled: !editingCfg,
            onClick: () => {
              if (editingCfg) setEditTarget(editingCfg);
            },
          });
          items.push({
            label: isZh ? '复制为新配置' : 'Duplicate as new config',
            onClick: async () => {
              if (!workspacePath) return;
              const src = configs.find(c => c.id === configId);
              if (!src) return;
              const newId = `${src.id}-copy-${Date.now().toString(36).slice(-4)}`;
              await (window as any).neox?.serviceUpsertConfig?.(workspacePath, {
                ...src,
                id: newId,
                name: `${src.name} (copy)`,
                createdBy: 'user',
              });
              void reloadConfigs();
            },
          });
          items.push({ label: '', onClick: () => {}, divider: true });
          /* 服务在跑时, 删了 config 进程会变成"孤儿 adhoc 行"残留. 给用户一个"先停再删"的复合操作. */
          if (isRunning && pid !== undefined) {
            items.push({
              label: isZh ? '停止并删除配置' : 'Stop and delete config',
              danger: true,
              onClick: async () => {
                if (!workspacePath) return;
                const src = configs.find(c => c.id === configId);
                const ok = await confirmAsync({
                  title: isZh ? '停止并删除配置' : 'Stop and delete config',
                  message: src
                    ? (isZh
                        ? `将先停止 "${src.name}" (pid=${pid}) 再删除该配置.`
                        : `Will stop "${src.name}" (pid=${pid}) first, then delete the config.`)
                    : (isZh ? '将先停止该服务再删除配置.' : 'Will stop the service first, then delete the config.'),
                  variant: 'danger',
                  confirmLabel: isZh ? '停止并删除' : 'Stop and delete',
                });
                if (!ok) return;
                /* 1) SIGTERM 进程 (走已经修好的 server-bound kill 链路) */
                try { await (window as any).neox?.processKill?.(pid); } catch { /* 忽略, 接着删 */ }
                /* 2) 给 SIGTERM 一点时间被处理, 再删配置. 不阻塞 UI 太久. */
                await new Promise(r => setTimeout(r, 600));
                await (window as any).neox?.serviceRemoveConfig?.(workspacePath, configId);
                void reloadConfigs();
                void reloadProcs();
                if (selectedId === ctxMenu.rowId) setSelectedId(null);
              },
            });
          }
          items.push({
            label: isZh ? '删除配置' : 'Delete config',
            danger: true,
            onClick: async () => {
              if (!workspacePath) return;
              const src = configs.find(c => c.id === configId);
              /* 服务在跑时单删 config 不停进程 → 进程变 adhoc 行残留. 文案明确给用户提示, 让 ta 知道. */
              const runningTip = (isRunning && pid !== undefined)
                ? (isZh
                    ? `注意: 该服务正在运行 (pid=${pid}). 仅删除配置不会停止进程, 进程会保留为 ad-hoc 行. 如需一并停止, 请使用"停止并删除配置".`
                    : `Note: this service is running (pid=${pid}). Deleting only the config leaves the process as an ad-hoc row. Use "Stop and delete config" to stop it too.`)
                : undefined;
              const ok = await confirmAsync({
                title: isZh ? '删除服务配置' : 'Delete service config',
                message: src
                  ? (isZh
                      ? `确认删除服务配置 "${src.name}" (${src.id})? 该操作不可撤销.`
                      : `Delete service config "${src.name}" (${src.id})? This cannot be undone.`)
                  : (isZh ? '确认删除该配置? 该操作不可撤销.' : 'Delete this config? This cannot be undone.'),
                description: runningTip,
                variant: 'danger',
                confirmLabel: isZh ? '删除' : 'Delete',
              });
              if (!ok) return;
              await (window as any).neox?.serviceRemoveConfig?.(workspacePath, configId);
              void reloadConfigs();
              if (selectedId === ctxMenu.rowId) setSelectedId(null);
            },
          });
        }
        /* Ad-hoc 行 (configId 不存在) — 没"编辑/复制/删配置", 但用户需要"从列表清除"入口,
         * 清掉早期 agent 凑出来的脏 pid 残留 (bind 失败留下来的孤儿). */
        if (!configId && pid !== undefined) {
          /* "保存为 RunConfig" — 把 agent 起的 ad-hoc 服务一键落盘成 RunConfig + bind pid.
           * 下次 Neox 重启 / 用户在面板里点 ▶ 启动 都能直接拉起同样命令.
           * id 用 friendlyName slugify, name 直接用 friendlyName. cmd/cwd 已捎在 ctxMenu 里.
           * 跑中 (isRunning) 时显示更显眼, 退出的 ad-hoc 行也能保留命令配置以便后续启动. */
          if (ctxMenu.command && ctxMenu.cwd && workspacePath) {
            if (items.length > 0) items.push({ label: '', onClick: () => {}, divider: true });
            items.push({
              label: isZh ? '💾 保存为 RunConfig (下次可直接启动)' : '💾 Save as RunConfig (start directly next time)',
              onClick: async () => {
                const id = slugifyConfigId(ctxMenu.friendlyName || `service-${pid}`, configs);
                const name = (ctxMenu.friendlyName || `service-${pid}`).trim();
                try {
                  await (window as any).neox?.serviceUpsertConfig?.(workspacePath, {
                    id,
                    name,
                    command: ctxMenu.command,
                    cwd: ctxMenu.cwd,
                    createdBy: 'user',
                  });
                  /* running 才 bind — 退出的 ad-hoc 没活进程可绑, 只落 config */
                  if (isRunning) {
                    await (window as any).neox?.serviceBind?.(pid, id);
                  }
                  await reloadConfigs();
                  await reloadProcs();
                } catch (err: any) {
                  dispatchOpFailed({ op: isZh ? '保存服务配置' : 'Save service config', message: err?.message || String(err) });
                }
              },
            });
          }
          if (items.length > 0) items.push({ label: '', onClick: () => {}, divider: true });
          /* 还在跑 → 停止 + 立即从列表移除 (复合操作) */
          if (isRunning) {
            items.push({
              label: isZh ? '停止并从列表清除' : 'Stop and remove from list',
              danger: true,
              onClick: async () => {
                const ok = await confirmAsync({
                  title: isZh ? '停止并从列表清除' : 'Stop and remove from list',
                  message: isZh
                    ? `将先停止该 ad-hoc 进程 (pid=${pid}) 再从列表移除.`
                    : `Will stop this ad-hoc process (pid=${pid}) first, then remove it from the list.`,
                  variant: 'danger',
                  confirmLabel: isZh ? '停止并清除' : 'Stop and remove',
                });
                if (!ok) return;
                try { await (window as any).neox?.processKill?.(pid); } catch { /* skip */ }
                await new Promise(r => setTimeout(r, 700));
                await (window as any).neox?.processUntrack?.(pid);
                void reloadProcs();
                if (selectedId === ctxMenu.rowId) setSelectedId(null);
              },
            });
          }
          if (!isRunning) {
            items.push({
              label: isZh ? '从列表移除' : 'Remove from list',
              onClick: async () => {
                await (window as any).neox?.processUntrack?.(pid);
                void reloadProcs();
                if (selectedId === ctxMenu.rowId) setSelectedId(null);
              },
            });
          }
        }
        if (items.length === 0) items.push({ label: isZh ? '(无可用操作)' : '(No actions available)', onClick: () => {}, disabled: true });
        return (
          <RowContextMenu
            pos={ctxMenu.pos}
            items={items}
            onClose={() => setCtxMenu(null)}
          />
        );
      })()}
    </div>
  );
};

/* ──────────────────────────────────────────────────────────────────────
 * ServicesEmptyHero — 右栏空状态 (没选中或没服务). 设计稿同款:
 *   插图 + 标题 + 副标题 + 3 行能力卡片
 * ────────────────────────────────────────────────────────────────────── */
const ServicesEmptyHero: React.FC<{ hasRows: boolean }> = ({ hasRows }) => {
  const { isZh } = useI18n();
  return (
  <div className="sfc-services__hero">
    <div className="sfc-services__hero-left">
    {/* isometric 浏览器窗插画: 主窗口在前, 后面一个半透明窗口透出, 周围虚线装饰. */}
    <div className="sfc-services__hero-illu" aria-hidden="true">
      {/* 颜色 token 化 — 全部 stroke/fill 走 .sfc-illu-windows__* CSS class,
       *  light/dark 主题切换由 surface.css 控制 (前窗口 fill 用 var(--neox-bg-card),
       *  暗色不再显白底矩形) */}
      <svg viewBox="0 0 220 160" width="220" height="160" fill="none" className="sfc-illu-windows">
        {/* 周围虚线装饰 */}
        <g className="sfc-illu-windows__deco" strokeWidth="1" strokeDasharray="3 3" fill="none">
          <path d="M10 20 L40 20" />
          <path d="M180 140 L210 140" />
          <path d="M18 78 L8 78" />
          <path d="M212 60 L202 60" />
          <circle className="sfc-illu-windows__deco-dot" cx="14" cy="50" r="2.5" stroke="none" />
          <circle className="sfc-illu-windows__deco-dot" cx="206" cy="100" r="2.5" stroke="none" />
        </g>
        {/* 后窗口 — 浅描边 + 极浅 tint fill */}
        <g className="sfc-illu-windows__back" strokeWidth="1.2" strokeLinejoin="round">
          <rect x="55" y="20" width="140" height="90" rx="4" />
          <path d="M55 32 H195" />
          <circle className="sfc-illu-windows__back-dot" cx="63" cy="26" r="1.5" stroke="none" />
          <circle className="sfc-illu-windows__back-dot" cx="69" cy="26" r="1.5" stroke="none" />
          <circle className="sfc-illu-windows__back-dot" cx="75" cy="26" r="1.5" stroke="none" />
        </g>
        {/* 前窗口 — 主描边 + 主题感知背景 (light=white, dark=card) */}
        <g className="sfc-illu-windows__front" strokeWidth="1.4" strokeLinejoin="round">
          <rect x="35" y="40" width="140" height="90" rx="5" />
          <path d="M35 54 H175" />
          <circle className="sfc-illu-windows__front-dot" cx="44" cy="47" r="1.6" stroke="none" />
          <circle className="sfc-illu-windows__front-dot" cx="51" cy="47" r="1.6" stroke="none" />
          <circle className="sfc-illu-windows__front-dot" cx="58" cy="47" r="1.6" stroke="none" />
        </g>
        {/* 前窗口内容: 横线 (服务行) + 末端紫色 chip */}
        <g className="sfc-illu-windows__line" strokeWidth="3" strokeLinecap="round">
          <path d="M50 72 H120" />
          <path d="M50 92 H108" />
          <path d="M50 112 H132" />
        </g>
        <g className="sfc-illu-windows__chip">
          <rect x="130" y="68" width="32" height="8" rx="2" />
          <rect x="118" y="88" width="32" height="8" rx="2" />
          <rect x="142" y="108" width="22" height="8" rx="2" />
        </g>
      </svg>
    </div>
    <h3 className="sfc-services__hero-title">
      {isZh ? '选择一个服务查看详情' : 'Pick a service to see its details'}
    </h3>
    <p className="sfc-services__hero-sub">{isZh ? '选择左侧的服务后，这里会显示它的详情。' : 'Pick a service on the left to see its details here.'}</p>
    </div>
    <div className="sfc-services__hero-features">
      <div className="sfc-services__hero-feature">
        <div className="sfc-services__hero-feature-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        </div>
        <div className="sfc-services__hero-feature-text">
          <div className="sfc-services__hero-feature-title">{isZh ? '状态 / 端口 / PID' : 'Status / port / PID'}</div>
          <div className="sfc-services__hero-feature-desc">{isZh ? '运行状态与关键指标' : 'Run status and key metrics'}</div>
        </div>
      </div>
      <div className="sfc-services__hero-feature">
        <div className="sfc-services__hero-feature-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 9 L9 13 L5 17" />
            <path d="M13 17 H19" />
          </svg>
        </div>
        <div className="sfc-services__hero-feature-text">
          <div className="sfc-services__hero-feature-title">{isZh ? '启动命令与环境' : 'Command and environment'}</div>
          <div className="sfc-services__hero-feature-desc">{isZh ? '运行命令与环境变量' : 'The command it runs and its env vars'}</div>
        </div>
      </div>
      <div className="sfc-services__hero-feature">
        <div className="sfc-services__hero-feature-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 4h11l3 3v13H5z" />
            <path d="M14 4v3h3" />
            <path d="M8 13 H15" />
            <path d="M8 16 H13" />
          </svg>
        </div>
        <div className="sfc-services__hero-feature-text">
          <div className="sfc-services__hero-feature-title">{isZh ? '日志与操作' : 'Logs and actions'}</div>
          <div className="sfc-services__hero-feature-desc">{isZh ? '实时日志, 以及启停等常用操作' : 'Live logs, plus start / stop and the rest'}</div>
        </div>
      </div>
    </div>
  </div>
  );
};

/* ──────────────────────────────────────────────────────────────────────
 * ImportWizard — 扫工程 (npm scripts / pom.xml / build.gradle / docker-compose / Procfile),
 * 让用户勾选一键导入为 RunConfig.
 *
 *   走后端 service:scan-workspace IPC, 拿到的候选已经是结构化 spec (kind: maven/npm/...),
 *   保存时按 spec 路径 upsert, 自动派生最终 command. 用户/agent 都不用碰 shell 字符串.
 * ────────────────────────────────────────────────────────────────────── */
interface ScannedCandidate {
  suggestedId: string;
  suggestedName: string;
  source: string;
  sourceFile: string;
  cwd: string;
  spec: import('./buildCommandLineClient').ConfigSpec;
  longLived: boolean;
  /** 同一服务模块的多 profile 候选共享同一 moduleKey, UI 聚合一行 */
  moduleKey: string;
  /** 候选代表的 profile (dev/prod/test/undefined) */
  profile?: string;
}

/** 按 moduleKey 聚合候选成"一个服务一行", 每行内 profile chips 切换 active. */
interface ScannedModule {
  moduleKey: string;
  /* 用第一个 candidate 作为代表展示 name/source 等 */
  representative: ScannedCandidate;
  /* 该模块所有 profile 候选 (profile=undefined 表示无 profile 选项) */
  candidates: ScannedCandidate[];
}

/** 三态 checkbox — checked / indeterminate / unchecked.
 *  React 不把 indeterminate 当 prop, 必须 imperatively 设 DOM 属性. 用 ref+effect 同步. */
const TriStateCheckbox: React.FC<{
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  className?: string;
  ariaLabel?: string;
}> = ({ checked, indeterminate, onChange, className, ariaLabel }) => {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className={className}
      checked={checked}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      aria-label={ariaLabel}
    />
  );
};
const ImportWizard: React.FC<{
  workspacePath: string;
  onClose: () => void;
  onImported: () => void;
}> = ({ workspacePath, onClose, onImported }) => {
  const { isZh } = useI18n();
  const [candidates, setCandidates] = useState<ScannedCandidate[]>([]);
  /* picked 现在是 moduleKey 集合 — 每行 (一个模块) 整体勾选/不选 */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /* 每个模块当前激活的 profile (undefined 表示没 profile 选项的模块).
   * 用户点 profile chip 切换, 导入时按这个找对应 candidate. */
  const [activeProfile, setActiveProfile] = useState<Map<string, string | undefined>>(new Map());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /* "只看长期服务" 过滤 — 默认勾选, 用户多数想要的是 dev server / spring-boot 而不是 build/test 临时任务 */
  const [longOnly, setLongOnly] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const api = (window as any).neox?.serviceScanWorkspace;
        if (typeof api !== 'function') {
          if (alive) setErr('扫描 API 未注册 — 完全退出 Neox 后重开 (Cmd+Q 不够, 进程也得退) 再试.');
          return;
        }
        const r = await api(workspacePath);
        if (!alive) return;
        if (r?.success) {
          const cands = r.candidates as ScannedCandidate[];
          setCandidates(cands);
          /* 默认勾选工程根的 long-lived 模块. 同 moduleKey 多 profile 视作一个模块. */
          const longModuleKeys = new Set<string>();
          const profileChoice = new Map<string, string | undefined>();
          for (const c of cands) {
            if (!c.longLived) continue;
            if (c.cwd === '.' || c.cwd === '') longModuleKeys.add(c.moduleKey);
            /* profile 默认选 dev (有的话), 否则第一个出现的 profile, 没 profile 就 undefined */
            if (!profileChoice.has(c.moduleKey)) {
              profileChoice.set(c.moduleKey, c.profile);
            } else if (c.profile === 'dev') {
              profileChoice.set(c.moduleKey, 'dev');
            }
          }
          setPicked(longModuleKeys);
          setActiveProfile(profileChoice);
        } else {
          setErr(r?.error || '扫描失败 (后端返回 success=false 但无 error 信息)');
        }
      } catch (e: any) {
        if (alive) setErr(`扫描失败: ${friendlyOpError(e)}`);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [workspacePath]);

  const visible = useMemo(
    () => longOnly ? candidates.filter(c => c.longLived) : candidates,
    [candidates, longOnly],
  );

  /* 按 moduleKey 聚合 — 同模块多 profile 候选合并成一个 ScannedModule, UI 渲染一行. */
  const visibleModules = useMemo<ScannedModule[]>(() => {
    const map = new Map<string, ScannedModule>();
    for (const c of visible) {
      let mod = map.get(c.moduleKey);
      if (!mod) {
        mod = { moduleKey: c.moduleKey, representative: c, candidates: [] };
        map.set(c.moduleKey, mod);
      }
      mod.candidates.push(c);
    }
    /* 每个模块内 profile 排序: dev 优先, 然后字母, 无 profile 排最后 */
    for (const mod of map.values()) {
      mod.candidates.sort((a, b) => {
        if (a.profile === 'dev') return -1;
        if (b.profile === 'dev') return 1;
        if (!a.profile && b.profile) return 1;
        if (a.profile && !b.profile) return -1;
        return (a.profile ?? '').localeCompare(b.profile ?? '');
      });
    }
    return [...map.values()];
  }, [visible]);

  const toggleModule = (moduleKey: string) => {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(moduleKey)) next.delete(moduleKey); else next.add(moduleKey);
      return next;
    });
  };

  const setProfile = (moduleKey: string, profile: string | undefined) => {
    setActiveProfile(prev => {
      const next = new Map(prev);
      next.set(moduleKey, profile);
      return next;
    });
  };

  /* 全选当前可见模块 */
  const toggleAllVisible = () => {
    const allKeys = visibleModules.map(m => m.moduleKey);
    const allChecked = allKeys.every(k => picked.has(k));
    setPicked(prev => {
      const next = new Set(prev);
      if (allChecked) for (const k of allKeys) next.delete(k);
      else for (const k of allKeys) next.add(k);
      return next;
    });
  };
  const allVisibleChecked = visibleModules.length > 0 && visibleModules.every(m => picked.has(m.moduleKey));

  /* 分类全选: 给定一组 moduleKey, 全勾时取消, 否则全勾上 (跟 IDEA 多选行为一致) */
  const toggleGroup = (keys: string[]) => {
    const allChecked = keys.length > 0 && keys.every(k => picked.has(k));
    setPicked(prev => {
      const next = new Set(prev);
      if (allChecked) for (const k of keys) next.delete(k);
      else for (const k of keys) next.add(k);
      return next;
    });
  };

  const importPicked = async () => {
    if (picked.size === 0) return;
    setBusy(true); setErr(null);
    try {
      for (const mod of visibleModules) {
        if (!picked.has(mod.moduleKey)) continue;
        /* 选中模块的当前 active profile 对应 candidate. 找不到 (理论不会, 防御) 用代表. */
        const wantProfile = activeProfile.get(mod.moduleKey);
        const cand = mod.candidates.find(c => c.profile === wantProfile) ?? mod.candidates[0];
        /* RunConfig 名带 profile 后缀, 一眼能区分多 profile 配置同 module */
        const finalName = cand.profile
          ? `${cand.suggestedName} (${cand.profile})`
          : cand.suggestedName;
        await (window as any).neox?.serviceUpsertConfig?.(workspacePath, {
          id: cand.suggestedId,
          name: finalName,
          spec: cand.spec,
          cwd: cand.cwd,
          createdBy: 'user',
        });
      }
      onImported();
    } catch (e: any) {
      setErr(e?.message || '导入失败');
    } finally {
      setBusy(false);
    }
  };

  /* 按 spec.kind 分组 — 比 source 文件名更直观:
   *   JVM 系 → Node 系 → 其它语言运行时 → 容器 / 通用
   *   组内按 suggestedName 字母序. */
  const KIND_ORDER: ScannedCandidate['spec']['kind'][] = [
    'maven', 'gradle',
    'npm', 'bun', 'deno',
    'python', 'go', 'cargo', 'dotnet', 'flutter',
    'make', 'docker-compose', 'shell',
  ];
  const KIND_LABEL: Record<ScannedCandidate['spec']['kind'], string> = {
    'maven': 'Spring Boot · Maven',
    'gradle': 'Spring Boot · Gradle',
    'npm': 'Node',
    'bun': 'Bun',
    'deno': 'Deno',
    'python': 'Python',
    'go': 'Go',
    'cargo': 'Rust',
    'dotnet': '.NET',
    'flutter': 'Flutter',
    'make': 'Make',
    'docker-compose': 'Docker',
    'shell': 'Shell',
  };
  const grouped = useMemo(() => {
    const map = new Map<ScannedCandidate['spec']['kind'], ScannedModule[]>();
    for (const mod of visibleModules) {
      const k = mod.representative.spec.kind;
      const arr = map.get(k) ?? [];
      arr.push(mod);
      map.set(k, arr);
    }
    return KIND_ORDER
      .filter(k => map.has(k))
      .map(k => [k, map.get(k)!.sort((a, b) => a.representative.suggestedName.localeCompare(b.representative.suggestedName))] as const);
  }, [visibleModules]);

  /* 实时预览选中候选的最终命令 — 用顶部 import 的 buildCommandLine, ESM 环境用 require 会爆 */

  /* createPortal 渲染到 document.body — 绕过 surface 容器可能存在的 transform/filter/
   * isolation 父级 (会让 position:fixed 退化成 absolute, 弹窗只覆盖 surface 而不是全屏,
   * 截图里"弹窗背景透明能看到底下"就是这个问题). */
  return createPortal(
    <div className="sfc-services__modal-bg" onClick={onClose}>
      <div className="sfc-services__modal sfc-services__modal--scan" onClick={(e) => e.stopPropagation()}>
        {/* 紧凑顶栏: 标题 · 候选总数 · 过滤器 · 全选 — 一行搞定 */}
        <div className="sfc-scan__head">
          <h3 className="sfc-scan__title">{isZh ? '从工程导入' : 'Import from project'}</h3>
          {!loading && (
            <span className="sfc-scan__head-count">
              {visible.length}/{candidates.length} 候选
            </span>
          )}
          <div className="sfc-scan__head-spacer" />
          <label className="sfc-scan__filter">
            <input
              type="checkbox"
              checked={longOnly}
              onChange={(e) => setLongOnly(e.target.checked)}
            />
            <span>{isZh ? '只看长期' : 'Long-running only'}</span>
          </label>
          {!loading && visible.length > 0 && (
            <button
              type="button"
              className="sfc-scan__select-all"
              onClick={toggleAllVisible}
            >{allVisibleChecked ? '取消全选' : '全选'}</button>
          )}
        </div>
        {err && <div className="sfc-services__modal-err">{err}</div>}

        {loading ? (
          <div className="sfc-scan__empty">{isZh ? '扫描工程中…' : 'Scanning the project…'}</div>
        ) : visibleModules.length === 0 ? (
          <div className="sfc-scan__empty">
            {candidates.length === 0
              ? `工程里没找到可导入的服务. 识别: ${SCAN_SOURCES_SUMMARY_ZH}`
              : `${candidates.length} 个候选都是临时任务. 取消"只看长期"查看.`}
          </div>
        ) : (
          <div className="sfc-scan__list">
            {grouped.map(([kind, modules]) => {
              const groupKeys = modules.map(m => m.moduleKey);
              const groupChecked = groupKeys.length > 0 && groupKeys.every(k => picked.has(k));
              const groupIndeterminate = groupKeys.some(k => picked.has(k)) && !groupChecked;
              return (
              <div key={kind} className="sfc-scan__group">
                <div
                  className="sfc-scan__group-head"
                  onClick={() => toggleGroup(groupKeys)}
                  role="button"
                  title={groupChecked ? '取消该分类全部' : '选中该分类全部'}
                >
                  <TriStateCheckbox
                    className="sfc-scan__cb"
                    checked={groupChecked}
                    indeterminate={groupIndeterminate}
                    onChange={() => toggleGroup(groupKeys)}
                    ariaLabel={`选择全部 ${KIND_LABEL[kind]}`}
                  />
                  <span className="sfc-scan__group-label">{KIND_LABEL[kind]}</span>
                  <span className="sfc-scan__group-count">{modules.length}</span>
                  <span className="sfc-scan__group-line" aria-hidden="true" />
                </div>
                {modules.map(mod => {
                  const checked = picked.has(mod.moduleKey);
                  const currentProfile = activeProfile.get(mod.moduleKey);
                  const activeCand = mod.candidates.find(c => c.profile === currentProfile) ?? mod.candidates[0];
                  const finalCmd = buildCommandLine(activeCand.spec);
                  const hasProfiles = mod.candidates.some(c => c.profile);
                  const isRootModule = mod.representative.cwd === '.' || mod.representative.cwd === '';
                  return (
                    <div
                      key={mod.moduleKey}
                      className="sfc-scan__row"
                      title={`${activeCand.sourceFile}\n${finalCmd}`}
                      onClick={() => toggleModule(mod.moduleKey)}
                    >
                      {/* checkbox 区域: 点击切换勾选, 不连带切 profile */}
                      <TriStateCheckbox
                        className="sfc-scan__cb"
                        checked={checked}
                        onChange={() => toggleModule(mod.moduleKey)}
                      />
                      <span className="sfc-scan__row-name">
                        {mod.representative.suggestedName}
                      </span>
                      {/* 目录 —— 一屏几十个模块, 光看名字根本不知道 "BongoCat" 是哪来的
                        * (本仓库里它是 reverse/ 下 clone 的别人的项目)。根模块单独标出来,
                        * 顺便解释了为什么默认只勾了它。 */}
                      <span className={`sfc-scan__row-path${isRootModule ? ' is-root' : ''}`}>
                        {isRootModule ? '工程根' : mod.representative.cwd}
                      </span>
                      {/* profile chips — 仅在模块有多个 profile 时显示 */}
                      {hasProfiles && (
                        <span className="sfc-scan__row-profiles">
                          {mod.candidates.map(c => (
                            <button
                              key={c.profile ?? '__none__'}
                              type="button"
                              className={`sfc-scan__profile-chip${c.profile === currentProfile ? ' is-active' : ''}`}
                              onClick={(e) => { e.stopPropagation(); setProfile(mod.moduleKey, c.profile); }}
                              title={c.profile ? `profile: ${c.profile}` : '无 profile'}
                            >{c.profile || '无'}</button>
                          ))}
                        </span>
                      )}
                      <span className="sfc-scan__row-cmd">{finalCmd}</span>
                    </div>
                  );
                })}
              </div>
              );
            })}
          </div>
        )}

        <div className="sfc-services__modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>{isZh ? '取消' : 'Cancel'}</button>
          <button
            type="button"
            className="sfc-svc-btn"
            disabled={busy || picked.size === 0}
            onClick={importPicked}
          >{busy ? '导入中…' : `导入 ${picked.size} 项`}</button>
        </div>
      </div>
    </div>,
    interactionDoc().body,
  );
};

/* ──────────────────────────────────────────────────────────────────────
 * ServiceDetail — 右栏内容
 * ────────────────────────────────────────────────────────────────────── */
const ServiceDetail: React.FC<{
  row: { kind: 'configured' | 'adhoc'; config?: ServiceConfig; proc?: ProcessRow };
  configs: ServiceConfig[];
  workspacePath?: string;
  /** 编辑当前 RunConfig — 给 Env/Health "立即添加" 用 */
  onEditConfig?: (cfg: ServiceConfig) => void;
  onReload: () => void;
  onOpenNewForm: () => void;
  onStartConfig: (configId: string, options?: StartConfigOptions) => Promise<ServiceStartResult>;
  startingConfigIds: Set<string>;
  /** 头部最左侧的插槽 —— 列表收起时放「显示列表」按钮 */
  headLeading?: React.ReactNode;
}> = ({ row, configs: _configs, workspacePath, onReload, onOpenNewForm, onEditConfig, onStartConfig, startingConfigIds, headLeading }) => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const { isZh } = useI18n();
  const pid = row.proc?.pid;
  const port = row.proc?.port ?? row.config?.port;
  const status = row.proc?.status;
  const cmd = row.proc?.command ?? row.config?.command ?? '';
  const cwd = row.proc?.cwd ?? row.config?.cwd ?? '';
  const name = getRowDisplayName(row.proc, row.config);
  const isRunning = pid !== undefined && status === 'running';

  /* tab 状态提升到 ServiceDetail —— Start 按钮成功后立刻 setTab('logs') 而不是等 isRunning 翻转,
   * 用户点 Start 当下就跳到日志 tab 看启动过程, 体验上避免"按了没事"的错觉. */
  const [tab, setTab] = useState<DetailTabKey>(isRunning ? 'logs' : 'overview');
  /* isRunning 翻转时的 tab 行为 —— 不对称:
   *   · stopped → running  : 跳到 日志 tab (用户最想看启动过程)
   *   · running → stopped  : **不切** (用户正在看日志, 失败 / 崩溃后死活留在日志看错误,
   *     被自动跳回 详情 tab 反而失去现场). 仅当用户当下不在 日志 tab 时, 不动 — 也无需切.
   *   行为只在 isRunning *变化* 时触发, 用户手动切到 Env/Health 不会被覆盖. */
  const lastIsRunningRef = useRef(isRunning);
  useEffect(() => {
    if (lastIsRunningRef.current === isRunning) return;
    lastIsRunningRef.current = isRunning;
    if (isRunning) {
      setTab('logs');
    }
    /* running → stopped: 保持当前 tab. 用户在 logs 上想看失败日志, 强行切回 overview 会
     *   遮掉关键 stderr — 这是用户明确反馈的体验 bug. */
  }, [isRunning]);

  /* ── adopt 给 ad-hoc 行用 ── */
  const [adoptDraftId, setAdoptDraftId] = useState('');
  const handleAdopt = useCallback(async () => {
    if (!pid || !workspacePath) return;
    const id = adoptDraftId.trim() || `service-${pid}`;
    /* 1) 写一份 RunConfig 落盘 */
    await (window as any).neox?.serviceUpsertConfig?.(workspacePath, {
      id,
      name: id,
      command: cmd,
      cwd,
      createdBy: 'user',
    });
    /* 2) 把 pid 绑到 config */
    await (window as any).neox?.serviceBind?.(pid, id);
    onReload();
  }, [adoptDraftId, pid, cmd, cwd, workspacePath, onReload]);

  const handleKill = useCallback(async () => {
    if (!pid) return;
    let confirmMode: 'never' | 'always' = 'never';
    try {
      const rt = await (window as any)?.neox?.getAgentRuntimeConfig?.();
      if (rt?.servicesStopConfirmation != null) {
        confirmMode = rt.servicesStopConfirmation === 'always' ? 'always' : 'never';
      } else {
        /* config 里还没有值 = 迁移尚未完成 (设置页还没被打开过, 或主进程还是不认识这个字段的
         * 旧构建)。这期间回落老键, 保证用户开过的确认框不会先消失一段时间再回来。
         * 迁移成功后老键被删, 这条分支自然失效。 */
        const legacy = localStorage.getItem('neox.services.stopConfirmation');
        if (legacy === 'always') confirmMode = 'always';
      }
    } catch { /* 读不到就按缺省 never — 不因为读配置失败挡住用户停服务 */ }
    if (confirmMode === 'always') {
      const ok = await confirmAsync({
        title: '停止服务',
        message: `确认停止服务 "${name}" (pid=${pid}) ?`,
        description: '会发 SIGTERM, 2s 后升级 SIGKILL.',
        variant: 'danger',
        confirmLabel: '停止',
      });
      if (!ok) return;
    }
    await (window as any).neox?.processKill?.(pid);
    setTimeout(onReload, 500);
  }, [pid, name, onReload]);

  /* ── start (P3-2: 从 RunConfig 拉起, configured 行没 running 进程时显示) ── */
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState<string | null>(null);
  const configStarting = row.config ? startingConfigIds.has(row.config.id) : false;
  const handleStart = useCallback(async () => {
    if (!workspacePath || !row.config) {
      setStartErr('没有可启动的 RunConfig (workspace 未就绪)');
      return;
    }
    setStarting(true); setStartErr(null);
    /* 立刻切到日志 tab — 用户的注意力此刻就在"启动反馈"上, 不等 isRunning 翻转再跳,
     * spring-boot 编译启动需要 5-15s, 那段时间 stdout 实时打出 mvn 下载 / 类加载 / banner,
     * 切到日志 tab 立刻能看到, 即使最终启动失败也能看到具体错误. */
    setTab('logs');
    try {
      const r = await onStartConfig(row.config.id, { select: true });
      if (r.ok === false) {
        setStartErr(r.error || '启动失败 (无具体错误)');
      }
    } catch (e: any) {
      setStartErr(e?.message || String(e));
    } finally {
      setStarting(false);
      /* spring-boot / mvn 编译启动通常 5-15s, 1s 内 procList 大概率没更新 → 多次 reload 兜底.
       * 错峰 0.5s / 2s / 5s 拉三次, 命中其中之一就行. */
      setTimeout(onReload, 500);
      setTimeout(onReload, 2000);
      setTimeout(onReload, 5000);
    }
  }, [workspacePath, row.config, onReload, onStartConfig]);

  /* ── open web ── */
  const handleOpenWeb = useCallback(() => {
    if (!port) return;
    /* 直接派 surface event 开 web viewer */
    const ev = new CustomEvent('neox:open-surface', {
      detail: {
        kind: 'web',
        source: { type: 'url', url: `http://localhost:${port}` },
        title: `${name} (web)`,
        byUser: true,
      },
    });
    window.dispatchEvent(ev);
  }, [port, name]);

  /* Restart = SIGTERM 当前 pid, 等 1.5s 后 RunConfig 重新拉起 (configured 才有). ad-hoc
   * 没 RunConfig 不能 Restart, 只能 Stop. */
  const [restarting, setRestarting] = useState(false);
  const handleRestart = useCallback(async () => {
    if (!pid || !workspacePath || !row.config) return;
    setRestarting(true);
    /* Restart 也直接切日志 tab — 这段等待里用户能看到 SIGTERM 退出消息 + 新进程 banner,
     * 不用手动切 tab. 等待用 waitPortFree 轮询真实状态, 不猜毫秒数. */
    setTab('logs');
    try {
      const oldPort = row.proc?.port;
      await (window as any).neox?.processKill?.(pid);
      await waitPortFree(oldPort);
      const r = await onStartConfig(row.config.id, { select: true });
      if (r.ok === false) {
        setStartErr(r.error || '重启失败 (无具体错误)');
      }
    } finally {
      setRestarting(false);
      setTimeout(onReload, 600);
    }
  }, [pid, workspacePath, row.config, onReload, onStartConfig]);

  const hasEnvVars = !!(row.config?.env && Object.keys(row.config.env).length > 0);
  const hasHealthCheck = !!row.config?.healthcheck;
  const uptimeLabel = isRunning && row.proc?.uptime_sec !== undefined
    ? formatUptime(row.proc.uptime_sec) : null;

  return (
    <div className="sfc-services__detail-body">
      {/* header — 紧凑一行 + status + 主操作按钮. 完整 meta 已挪到"详情"tab, 这里只留视觉锚点. */}
      <header className="sfc-services__detail-head">
        {headLeading}
        <span className={`sfc-services__detail-logo${isRunning ? '' : ' is-idle'}`}>
          <ServiceKindIcon command={cmd} size={26} tile />
        </span>
        <h2 className="sfc-services__detail-name">{name}</h2>
        <span className={`sfc-services__chip sfc-services__chip--${
          isRunning ? 'running' : status === 'failed' ? 'failed' : 'idle'
        }`}>
          {/* 跟列表那颗签同一套说法: 跑过又退出的不叫「未启动」 */}
          {isRunning ? (isZh ? '运行中' : 'Running')
            : status === 'failed' ? (isZh ? '已失败' : 'Failed')
              : status === 'killed' ? (isZh ? '已停止' : 'Stopped')
                : row.proc ? (isZh ? '已结束' : 'Exited')
                  : (isZh ? '未启动' : 'Not started')}
        </span>
        {uptimeLabel && <span className="sfc-services__detail-metatext">{uptimeLabel}</span>}
        {!isRunning && row.proc?.endTime !== undefined && (
          <span className="sfc-services__detail-metatext">
            {formatAgo(row.proc.endTime)}{isZh ? ' 前退出' : ' ago'}
            {row.proc.exitCode !== undefined && row.proc.exitCode !== null
              ? ` · exit ${row.proc.exitCode}` : ''}
          </span>
        )}
        {pid !== undefined && <span className="sfc-services__detail-metatext is-mono">pid {pid}</span>}
        <span className="sfc-services__detail-spacer" />
        <div className="sfc-services__viewswitch" role="tablist">
          <button
            role="tab" aria-selected={tab === 'logs'}
            className={`sfc-services__op${tab === 'logs' ? ' is-on' : ''}`}
            onClick={() => setTab('logs')}
            title={isZh ? '实时日志' : 'Live logs'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </button>
          <button
            role="tab" aria-selected={tab === 'overview'}
            className={`sfc-services__op${tab === 'overview' ? ' is-on' : ''}`}
            onClick={() => setTab('overview')}
            title={isZh ? '详情 (命令 / 目录 / 端口)' : 'Details'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16" /><line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          </button>
          <button
            role="tab" aria-selected={tab === 'env'}
            className={`sfc-services__op${tab === 'env' ? ' is-on' : ''}${hasEnvVars ? ' has-dot' : ''}`}
            onClick={() => setTab('env')}
            title={isZh ? '环境变量' : 'Environment'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 7h6M4 12h9M4 17h5" /><path d="M17 8l3 4-3 4" />
            </svg>
          </button>
          <button
            role="tab" aria-selected={tab === 'health'}
            className={`sfc-services__op${tab === 'health' ? ' is-on' : ''}${hasHealthCheck ? ' has-dot' : ''}`}
            onClick={() => setTab('health')}
            title={isZh ? '健康检查' : 'Health check'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12h4l2.5-6 4 12L16 12h5" />
            </svg>
          </button>
        </div>
        <span className="sfc-services__detail-divider" aria-hidden="true" />
        <div className="sfc-services__detail-actions">
          {row.kind === 'configured' && !isRunning && (
            <button
              className="sfc-services__op sfc-services__op--start"
              onClick={handleStart}
              disabled={starting || configStarting}
              title={isZh ? '启动' : 'Start'}
            ><IconPlay /></button>
          )}
          {isRunning && port && (
            <button
              className="sfc-services__op"
              onClick={handleOpenWeb}
              title={isZh ? `在 Surface 打开 localhost:${port}` : `Open localhost:${port} in Surface`}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
              </svg>
            </button>
          )}
          {isRunning && row.kind === 'configured' && (
            <button
              className="sfc-services__op"
              onClick={handleRestart}
              disabled={restarting || configStarting}
              title={isZh ? '重启' : 'Restart'}
            ><IconRestart /></button>
          )}
          {isRunning && (
            <button
              className="sfc-services__op sfc-services__op--stop"
              onClick={handleKill}
              title={isZh ? '停止' : 'Stop'}
            ><IconStop /></button>
          )}
        </div>
      </header>
      {startErr && (
        <div className="sfc-services__start-err">{zh ? '启动失败: ' : 'Failed to start: '}{startErr}</div>
      )}

      {/* Tab 切换 — 详情 / 日志 / Env / Health. 日志为主战场, 详情/Env/Health 切换看.
       *   默认 tab: 运行中 → 日志, 停止中 → 详情. 用户的注意力跟着状态走. */}
      <DetailTabs
        row={row}
        pid={pid}
        cmd={cmd}
        cwd={cwd}
        port={port}
        uptimeLabel={uptimeLabel}
        isRunning={isRunning}
        name={name}
        adoptDraftId={adoptDraftId}
        setAdoptDraftId={setAdoptDraftId}
        handleAdopt={handleAdopt}
        onOpenNewForm={onOpenNewForm}
        tab={tab}
        setTab={setTab}
        onEditConfig={row.config && onEditConfig ? () => onEditConfig(row.config!) : undefined}
        starting={starting || restarting || configStarting}
      />
    </div>
  );
};

type DetailTabKey = 'overview' | 'logs' | 'env' | 'health';

const DetailTabs: React.FC<{
  row: { kind: 'configured' | 'adhoc'; config?: ServiceConfig; proc?: ProcessRow };
  pid?: number;
  cmd: string;
  cwd: string;
  port?: number;
  uptimeLabel: string | null;
  isRunning: boolean;
  name: string;
  adoptDraftId: string;
  setAdoptDraftId: (s: string) => void;
  handleAdopt: () => void;
  onOpenNewForm: () => void;
  /** 受控 tab state — 由 ServiceDetail 持有, Start/Restart 时立即 setTab('logs') 切到日志. */
  tab: DetailTabKey;
  setTab: (t: DetailTabKey) => void;
  /** 打开当前 service 的编辑表单 — Env/Health 空状态 "立即添加" 按钮调. */
  onEditConfig?: () => void;
  /** 用户刚点 Start, isRunning 还没翻转 — 给日志 tab 显示"等待进程启动" spinner */
  starting?: boolean;
}> = ({ row, pid, cmd, cwd, port, uptimeLabel, isRunning, name, adoptDraftId, setAdoptDraftId, handleAdopt, onOpenNewForm, tab, setTab, onEditConfig, starting }) => {
  const { isZh } = useI18n();
  const [liveFilter, setLiveFilter] = useState('');
  const [liveErrOnly, setLiveErrOnly] = useState(false);
  const [liveBuf, setLiveBuf] = useState('');
  const lensOn = liveFilter.trim().length > 0 || liveErrOnly;

  /* 过滤开启时才去拉 server 侧的完整 buffer, 每 1.5s 刷一次 —— 关掉就不拉,
   * 不给常态路径加任何开销。已退出的进程读盘上日志 (getOutput 已带回落)。 */
  useEffect(() => {
    if (!lensOn || pid === undefined) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const r = await (window as any).neox?.processGetOutput?.(pid);
        if (!cancelled) setLiveBuf(String(r?.output ?? ''));
      } catch { /* ignore */ }
    };
    void pull();
    const id = window.setInterval(pull, 1500);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [lensOn, pid]);

  const liveFiltered = useMemo(() => {
    if (!lensOn) return '';
    const q = liveFilter.trim().toLowerCase();
    const ERR = /\b(error|err|fail(ed|ure)?|exception|fatal|panic|traceback)\b/i;
    return liveBuf.split('\n').filter(line => {
      if (liveErrOnly && !ERR.test(line)) return false;
      if (q && !line.toLowerCase().includes(q)) return false;
      return true;
    }).join('\n');
  }, [liveBuf, liveFilter, liveErrOnly, lensOn]);
  const hasEnv = !!(row.config?.env && Object.keys(row.config.env).length > 0);
  const hasHc = !!row.config?.healthcheck;
  const exitCode = !isRunning ? row.proc?.exitCode : undefined;

  return (
    <div className="sfc-services__tabs sfc-services__tabs--main">
      <div className="sfc-services__tabs-body sfc-services__tabs-body--main">
        {tab === 'overview' && (
          <div className="sfc-services__overview">
            <div className="sfc-services__detail-meta">
              <div><label>COMMAND</label><code>{cmd}</code></div>
              <div><label>CWD</label><code>{cwd}</code></div>
              {pid !== undefined && <div><label>PID</label><code>{pid}</code></div>}
              {port !== undefined && <div><label>PORT</label><code>{port}</code></div>}
              {uptimeLabel && <div><label>UPTIME</label><code>{uptimeLabel}</code></div>}
              {typeof exitCode === 'number' && (
                <div><label>EXIT</label><code className={exitCode !== 0 ? 'is-bad' : undefined}>{exitCode}</code></div>
              )}
              {row.config?.id && <div><label>CONFIG ID</label><code>{row.config.id}</code></div>}
              {row.proc?.log_file_path && <div><label>LOG FILE</label><code>{row.proc.log_file_path}</code></div>}
            </div>
            {row.kind === 'adhoc' && pid !== undefined && (
              <div className="sfc-services__adopt-strip">
                <span>{isZh ? '这是一个 ad-hoc 进程，给它命名以后就能从这里直接重启：' : 'This is an ad-hoc process — name it and you can restart it from here:'}</span>
                <input
                  type="text"
                  placeholder="config id (e.g. backend)"
                  value={adoptDraftId}
                  onChange={(e) => setAdoptDraftId(e.target.value)}
                />
                <button className="sfc-svc-btn" onClick={handleAdopt}>Adopt</button>
              </div>
            )}
          </div>
        )}
        {/* 日志 tab — ShellConsole 填满 body, 拿到下半窗整片高度.
         *   隐藏(display:none)切换其它 tab 时不 unmount, 切回来时 xterm 实例还在,
         *   不重新订阅 chunk bus, 滚动位置和未读 chunk 都保留. */}
        <div
          className="sfc-services__tabs-pane-logs"
          style={tab === 'logs' ? undefined : { display: 'none' }}
        >
          {pid !== undefined && (
            <div className="sfc-services__loglens">
              <input
                type="search"
                value={liveFilter}
                onChange={(e) => setLiveFilter(e.target.value)}
                placeholder={isZh ? '过滤日志行…' : 'Filter log lines…'}
                aria-label={isZh ? '过滤日志' : 'Filter log'}
              />
              <button
                type="button"
                className={liveErrOnly ? 'is-on' : undefined}
                onClick={() => setLiveErrOnly(v => !v)}
                title={isZh ? '只看包含 error/fail/exception 的行' : 'Only lines with error/fail/exception'}
              >{isZh ? '只看错误' : 'Errors only'}</button>
              {lensOn && (
                <span className="sfc-services__loglens-hint">
                  {isZh ? '过滤视图 · 清空条件回到实时终端' : 'Filtered view · clear to return to live terminal'}
                </span>
              )}
            </div>
          )}
          {lensOn ? (
            <pre className="sfc-services__loglens-out">{liveFiltered || (isZh ? '（没有匹配的行）' : '(no matching lines)')}</pre>
          ) : (
          <ShellConsole
            pid={pid}
            name={name}
            onOpenNewForm={onOpenNewForm}
            fillParent
            starting={starting && !pid}
            emptyHint={
              !row.proc && row.config
                ? `${name} 未运行 — 点上方 ▶ Start 启动后日志会出现在这里`
                : row.proc && !isRunning
                  ? `已退出 — 缓冲已清, 重启后会重新流式`
                  : undefined
            }
          />
          )}
        </div>
        {tab === 'env' && <EnvPane env={row.config?.env} onEditConfig={onEditConfig} />}
        {tab === 'health' && <HealthPane config={row.config} proc={row.proc} onEditConfig={onEditConfig} />}
      </div>
    </div>
  );
};

/* ──────────────────────────────────────────────────────────────────────
 * ShellConsole — selected service 的实时 stdout 镜像 (只读).
 *
 * 设计语义:
 *   服务详情面板的核心使命 = 看选中服务在干什么. 控制台不再是一个独立 zsh, 而是
 *   "选中谁就镜像谁" — 切换 selected service → xterm 自动切到那个 pid 的 stdout 流.
 *   起 dev server / 看 build log / 调 dev console 全在这里看, 跟 IDEA 的服务管理一致.
 *
 *   想要独立 free shell (curl 验证 / git status 等) 走顶栏单独入口, 不混在服务详情里.
 *
 * 数据回路:
 *   selected service.pid → subscribeTerminalChunkByPid → chunk bus 实时推送
 *   ring buffer 自动 replay 历史. 同时 mount 时拉一次 processGetOutput 作为
 *   "已退出服务的历史" 兜底 (chunk bus 重启后空, outputBuffer 还在 server 端).
 *
 *   · 顶栏: 标题 / live 点 / clean / fullscreen / 更多
 *   · 中央: xterm.js 实例, ANSI 真彩, 鼠标可选择复制
 *   · readonly: 不接 stdin (这是 LLM 执行的进程, 用户不该往里写)
 *   · 顶部 splitter: 上下拖动改自身高度
 *   · 全屏: position fixed 占满 viewport
 * ────────────────────────────────────────────────────────────────────── */
const SHELL_CONSOLE_MIN_H = 180;
const SHELL_CONSOLE_MAX_H = 900;
const SHELL_CONSOLE_DEFAULT_H = 360;

export const ShellConsole: React.FC<{
  /* selected service 的 pid — 控制台镜像这个 pid 的 stdout 流. undefined 时显示空状态. */
  pid?: number;
  name: string;
  /** 没传 (IdeBottomPanel 独立 Logs tab 场景) 时 fall back 到 noop, 空状态不挂"新建服务"链接. */
  onOpenNewForm?: () => void;
  /** Tab 模式: 占满父容器, 不渲染顶部 splitter, 不暴露"全屏 / 新建"按钮 (这些已在 tab 外层). */
  fillParent?: boolean;
  /** 空 pid 时显示的提示文案 — 由父组件按 service 状态计算 (无选择 / 启动中 / 未运行 / 已退出). */
  emptyHint?: string;
  /** 启动中 — 显示 spinner 而非静态提示 */
  starting?: boolean;
}> = ({ pid, name, onOpenNewForm, fillParent = false, emptyHint, starting }) => {
  const { isZh } = useI18n();
  const [height, setHeight] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem('neox.services.consoleHeight'));
      return Number.isFinite(stored) && stored >= SHELL_CONSOLE_MIN_H ? stored : SHELL_CONSOLE_DEFAULT_H;
    } catch { return SHELL_CONSOLE_DEFAULT_H; }
  });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showMore, setShowMore] = useState(false);

  /* xterm 实例 + container ref */
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);

  /* —— xterm 主题: 优先从 container 读 (允许 .sfc-services__console-output 局部覆盖),
   *   fallback 到 :root (跟随全局主题). 这样服务日志可以强制 dark terminal 样式不被 light 主题污染. */
  const buildXtermTheme = () => {
    const csRoot = getComputedStyle(document.documentElement);
    const csCt = containerRef.current ? getComputedStyle(containerRef.current) : null;
    const v = (n: string, f: string) => {
      const local = csCt?.getPropertyValue(n).trim();
      if (local) return local;
      const root = csRoot.getPropertyValue(n).trim();
      return root || f;
    };
    /* 透明底的 RGB 也有用: xterm 把选区色跟底色混成不透明色再画, rgba(0,0,0,0) 混出来是一块黑
     * (浅色主题下选中日志像贴了黑胶布)。按前景深浅给透明白 / 透明黑, 混出来跟页面同调。 */
    const fg = v('--xterm-fg', '#d1d5db');
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) ctx.fillStyle = fg;
    const rgb = (ctx?.fillStyle as string | undefined)?.match(/[\da-f]{2}/gi)?.slice(0, 3).map((h) => parseInt(h, 16))
      ?? (ctx?.fillStyle as string | undefined)?.match(/\d+/g)?.slice(0, 3).map(Number) ?? [209, 213, 219];
    const darkText = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 < 128;
    return {
      background: darkText ? 'rgba(255,255,255,0)' : 'rgba(0,0,0,0)',
      foreground: fg,
      cursor: v('--xterm-cursor', '#c19a6b'),
      cursorAccent: v('--xterm-cursor-accent', '#0d0d0f'),
      selectionBackground: v('--xterm-selection', 'rgba(193,154,107,0.28)'),
      /* 失焦后的选区 xterm 默认画成近黑块 (浅色主题下像一块黑胶布), 跟聚焦时同色 */
      selectionInactiveBackground: v('--xterm-selection', 'rgba(193,154,107,0.28)'),
      black: v('--xterm-black', '#1e1f22'),
      red: v('--xterm-red', '#f44747'),
      green: v('--xterm-green', '#4ec9b0'),
      yellow: v('--xterm-yellow', '#dcdcaa'),
      blue: v('--xterm-blue', '#569cd6'),
      magenta: v('--xterm-magenta', '#c586c0'),
      cyan: v('--xterm-cyan', '#4dc9b0'),
      white: v('--xterm-white', '#d4d4d4'),
      brightBlack: v('--xterm-bright-black', '#808080'),
      brightRed: v('--xterm-bright-red', '#f14c4c'),
      brightGreen: v('--xterm-bright-green', '#23d18b'),
      brightYellow: v('--xterm-bright-yellow', '#f5f543'),
      brightBlue: v('--xterm-bright-blue', '#3b8eea'),
      brightMagenta: v('--xterm-bright-magenta', '#d670d6'),
      brightCyan: v('--xterm-bright-cyan', '#29b8db'),
      brightWhite: v('--xterm-bright-white', '#ffffff'),
    };
  };

  /* —— mount xterm —— */
  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let resizeObs: ResizeObserver | null = null;
    let themeObs: MutationObserver | null = null;

    void (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
      ]);
      if (disposed || !containerRef.current) return;

      const cs = getComputedStyle(document.documentElement);
      const fontFamily = cs.getPropertyValue('--xterm-font-family').trim()
        || '"JetBrains Mono", "SF Mono", Menlo, monospace';
      const fontSize = parseInt(cs.getPropertyValue('--xterm-font-size').trim(), 10) || 12;

      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: 'block',
        fontFamily,
        fontSize,
        theme: buildXtermTheme(),
        scrollback: 10_000,
        convertEol: true,
        allowProposedApi: true,
        /* 底色透明, 直接透出页面 —— 见 buildXtermTheme 里的说明 */
        allowTransparency: true,
        lineHeight: 1.25,
        macOptionIsMeta: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);

      /* URL 可点击: 左键 → 内置浏览器 (右侧 Surface 开 BrowserView),
       * ⌘/Ctrl/Shift/中键 → 系统默认浏览器 (Electron shell.openExternal).
       * 跟 agent message 里 URL 行为一致 (TimelineTextRenderer + remark-gfm 现接管 URL 解析,
       *  历史 MessageRow ClickableUrl 自实现 markdown parser 已废除). */
      const links = new WebLinksAddon((event, url) => {
        const isModified = event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1;
        if (isModified) {
          const neox = (window as any).neox;
          if (typeof neox?.openExternal === 'function') {
            neox.openExternal(url).catch(() => window.open(url, '_blank', 'noopener,noreferrer'));
          } else {
            window.open(url, '_blank', 'noopener,noreferrer');
          }
        } else {
          window.dispatchEvent(new CustomEvent('neox:open-surface', {
            detail: { kind: 'web', source: { type: 'url', url }, title: 'web', byUser: true },
          }));
        }
      });
      term.loadAddon(links);

      term.open(containerRef.current);
      xtermRef.current = term;
      fitAddonRef.current = fit;
      try { fit.fit(); } catch { /* ignore */ }
      /* mount 完立刻 focus — 关键: xterm v5 内部有个隐藏的 .xterm-helper-textarea,
       * 它才是真正接收键盘的 element. term.focus() 在某些 layout 时序下不一定能让
       * 这个 textarea 真拿到 document.activeElement, 显式 DOM focus 才稳.
       *
       * 不显式 focus 会导致: 用户切到 services surface 看到 zsh 提示符但敲键没反应,
       * 必须先用鼠标点 xterm 区域才能开始输. 这是用户明确抱怨过的体验问题. */
      const helperTextarea = (containerRef.current?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null);
      try { helperTextarea?.focus(); } catch { /* ignore */ }
      /* 下一帧再 focus 一次兜底 — xterm.open 后 DOM 可能还没完全 paint, 此时 focus
       * 会被忽略. requestAnimationFrame 后 layout 已完成, focus 必生效. */
      requestAnimationFrame(() => {
        const ta = (containerRef.current?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null);
        try { ta?.focus(); } catch { /* ignore */ }
      });

      /* readonly: 不接 stdin. selected service 的 PTY 是 LLM 拉起的服务进程,
       * 用户不应该往里写字节. xterm 内部 disableStdin 标志在 v5 default 是 false,
       * 我们只是不调用 onData 也不 forward keystrokes. */

      /* container 尺寸变 → fit 即可 (不再 sync PTY cols/rows: 那是 stdin 路径的副带,
       * readonly 模式下 PTY 那边的尺寸由原始 LLM tool call 决定). */
      resizeObs = new ResizeObserver(() => {
        try { fitAddonRef.current?.fit(); } catch { /* ignore */ }
      });
      resizeObs.observe(containerRef.current);

      /* 主题切换跟随 */
      themeObs = new MutationObserver(() => {
        try { (term.options as any).theme = buildXtermTheme(); } catch { /* ignore */ }
      });
      themeObs.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-theme-preset', 'class'],
      });
    })();

    return () => {
      disposed = true;
      try { resizeObs?.disconnect(); } catch {}
      try { themeObs?.disconnect(); } catch {}
      try { xtermRef.current?.dispose(); } catch {}
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  /* —— pid 变化时: clear xterm + 订阅新 pid 的 chunk bus + 兜底拉一次 outputBuffer ——
   * 镜像 selected service 的核心逻辑. 用户切左栏选中 service, pid 变, 这个 effect 跑:
   *   1. clear 旧内容 (xterm 干净换上下文)
   *   2. mount 时同步拉一次 processGetOutput(pid) — 拿历史 stdout buffer 写到 xterm,
   *      这样 chunk bus 启动前的 / app 重启后的历史都能看到 (chunk bus ring buffer
   *      跟 renderer 进程生命周期绑, 重启后空, 但 server 端 outputBuffer 还在 5min 保留期).
   *   3. 订阅 subscribeTerminalChunkByPid — 后续 live chunks 自动 write. */
  useEffect(() => {
    if (!pid) return;
    let unsub: (() => void) | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    try { xtermRef.current?.clear?.(); } catch {}
    void (async () => {
      /* Step 1: 拉历史 buffer 兜底. chunk bus replay 也会拉一次 (订阅时 sync 回放),
       * 但如果命令早就退出、chunk bus 没记录过这个 pid (renderer 重启场景),
       * 必须靠 outputBuffer 这条 server-side polling 路径补齐. */
      let hasContent = false;
      /* 已经写进 xterm 的快照文本 —— 轮询时只追加它后面新长出来的部分 */
      let shown = '';
      let liveChunks = false;
      const toXterm = (s: string) => s.replace(/\r?\n/g, '\r\n');
      for (let i = 0; i < 100 && !xtermRef.current && !cancelled; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (cancelled) return;
      try {
        const r = await (window as any).neox?.processGetOutput?.(pid);
        if (cancelled) return;
        const historical = String(r?.output ?? '');
        if (historical) {
          hasContent = true;
          shown = historical;
          try { xtermRef.current?.write(toXterm(historical)); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }

      if (cancelled) return;
      const { subscribeTerminalChunkByPid } = await import('../../agent-timeline/terminalChunkBus');
      unsub = subscribeTerminalChunkByPid(pid, (chunk) => {
        hasContent = true;
        liveChunks = true;
        try { xtermRef.current?.write(chunk); } catch { /* xterm 已 dispose */ }
      });

      pollTimer = setInterval(async () => {
        if (cancelled || liveChunks || document.hidden) return;
        try {
          const r = await (window as any).neox?.processGetOutput?.(pid);
          if (cancelled || liveChunks) return;
          const next = String(r?.output ?? '');
          if (!next || next === shown) return;
          const term = xtermRef.current;
          if (!term) return;
          if (next.startsWith(shown)) {
            term.write(toXterm(next.slice(shown.length)));
          } else {
            term.clear();
            term.write(toXterm(next));
          }
          shown = next;
          hasContent = true;
        } catch { /* 下一轮再试 */ }
      }, 1500);

      /* 空状态提示: 800ms 后仍然没有任何 output 写入, 给一行 hint 让用户知道不是 UI bug.
       * 800ms = chunk bus replay sync 完成 + 后端 processGetOutput round-trip 的甜点位.
       * 写 dim 灰色文字, 真有 output 来时它会被往下推, 不影响实际日志阅读. */
      setTimeout(() => {
        if (cancelled || hasContent || !xtermRef.current) return;
        const term = xtermRef.current;
        const hint = '\x1b[2;3m// no output buffered for this process — could be running quietly, exited without output, or buffer rotated out\x1b[0m\r\n';
        try { term.write(hint); } catch { /* ignore */ }
      }, 800);
    })();
    return () => {
      cancelled = true;
      unsub?.();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [pid]);

  /* —— splitter 拖拽 —— */
  const onSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    if (isFullscreen) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const onMove = (e2: MouseEvent) => {
      const delta = startY - e2.clientY;
      const next = Math.max(SHELL_CONSOLE_MIN_H, Math.min(SHELL_CONSOLE_MAX_H, startH + delta));
      setHeight(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem('neox.services.consoleHeight', String(height)); } catch {}
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, [height, isFullscreen]);

  /* height 变化时持久化 (避免 mouseup 时 stale closure 拿不到最新) */
  useEffect(() => {
    try { localStorage.setItem('neox.services.consoleHeight', String(height)); } catch {}
  }, [height]);

  /* fullscreen 状态变 → 让 xterm 重新 fit (容器尺寸变了) */
  useEffect(() => {
    const r = requestAnimationFrame(() => {
      try { fitAddonRef.current?.fit(); } catch { /* ignore */ }
    });
    return () => cancelAnimationFrame(r);
  }, [isFullscreen, height]);

  /* fullscreen 时 Esc 退出 */
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen]);

  const copyAll = useCallback(async () => {
    if (!pid) return;
    const r = await (window as any).neox?.processGetOutput?.(pid);
    if (r?.success) {
      void copyToClipboard(r.output || '');
    }
  }, [pid]);

  const clearView = useCallback(() => {
    try { xtermRef.current?.clear(); } catch {}
    /* 注意: chunk bus ring buffer 不动 — 用户切走再切回 surface 应该看到完整历史.
     * 想清得更彻底 (清服务端 outputBuffer + chunk bus) 是另一个语义, 不在这里做. */
  }, []);

  const downloadLog = useCallback(async () => {
    if (!pid) return;
    const r = await (window as any).neox?.processGetOutput?.(pid);
    if (!r?.success) return;
    const blob = new Blob([r.output || ''], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name || 'service'}-${pid}-${Date.now()}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [pid, name]);

  /* Tab 模式: 占满父容器 (flex:1), 没顶部 splitter, 没"全屏 / 新建"按钮.
   * 老的"右栏底部固定高 splitter 可拖"模式仍保留, 给未来场景用. */
  const containerStyle: React.CSSProperties = fillParent
    ? { flex: '1 1 auto', minHeight: 0 }
    : (isFullscreen ? {} : { flex: `0 0 ${height}px` });

  return (
    <div
      className={`sfc-services__console${isFullscreen ? ' is-fullscreen' : ''}${fillParent ? ' is-fill' : ''}`}
      style={containerStyle}
    >
      {/* splitter (顶部 4px 高 row-resize); fillParent / 全屏时隐藏 */}
      {!isFullscreen && !fillParent && (
        <div
          className="sfc-services__console-splitter"
          role="separator"
          aria-orientation="horizontal"
          aria-label={isZh ? '拖动调整控制台高度' : 'Drag to resize the console'}
          onMouseDown={onSplitterMouseDown}
        />
      )}
      <div className="sfc-services__console-bar sfc-services__console-bar--slim">
        <div className="sfc-services__console-bar-spacer" />
        {!fillParent && onOpenNewForm && (
          <button
            className="sfc-services__console-iconbtn"
            onClick={onOpenNewForm}
            title={isZh ? '新建服务' : 'New service'}
          >+ {isZh ? '新建' : 'New'}</button>
        )}
        <button
          className="sfc-services__console-iconbtn"
          onClick={clearView}
          title={isZh ? '清空视图 (不影响进程实际 buffer)' : 'Clear the view (the process buffer is untouched)'}
        >{isZh ? '清屏' : 'Clear'}</button>
        {!fillParent && (
          <button
            className="sfc-services__console-iconbtn"
            onClick={() => setIsFullscreen(v => !v)}
            title={isFullscreen ? '退出全屏 (Esc)' : '全屏'}
          >{isFullscreen ? '退出全屏' : '全屏'}</button>
        )}
        <div className="sfc-services__console-more">
          <button
            className="sfc-services__console-iconbtn"
            onClick={() => setShowMore(v => !v)}
            title={isZh ? '更多' : 'More'}
            aria-haspopup="menu"
            aria-expanded={showMore}
          >⋯</button>
          {showMore && (
            <div className="sfc-services__console-menu" onMouseLeave={() => setShowMore(false)}>
              <button onClick={() => { void copyAll(); setShowMore(false); }} disabled={!pid}>{isZh ? '复制全部日志' : 'Copy all logs'}</button>
              <button onClick={() => { void downloadLog(); setShowMore(false); }} disabled={!pid}>{isZh ? '导出日志为文件' : 'Save logs to a file'}</button>
              <button onClick={() => { clearView(); setShowMore(false); }}>{isZh ? '清空视图' : 'Clear the view'}</button>
            </div>
          )}
        </div>
      </div>
      {!pid && (
        <div className="sfc-services__console-empty">
          {starting ? (
            <>
              <span className="sfc-services__console-empty-spinner" aria-hidden="true" />
              <span>{isZh ? '等待服务进程启动…' : 'Waiting for the service to start…'}</span>
              <span className="sfc-services__console-empty-sub">
                spring-boot / mvn 编译启动通常需要 5-15 秒, pid 出现后日志会自动流到这里
              </span>
            </>
          ) : (
            <span>{emptyHint || '在左侧选中一个服务以查看实时日志'}</span>
          )}
        </div>
      )}
      {/* readonly 镜像: 不接 stdin 不需要 helper textarea 抢 focus.
       *   xterm 自己的 mouse selection 仍工作, 用户可框选复制. */}
      <div
        className="sfc-services__console-output"
        ref={containerRef}
        style={!pid ? { display: 'none' } : undefined}
      />
    </div>
  );
};

/** friendly_name → 可读 RunConfig id. "pnpm: dev:antd" → "pnpm-dev-antd".
 *  撞到 existing id 自动追 -2/-3 后缀. 兜底 "service-<ts>" 防全部被特殊字符吃掉返回空串. */
function slugifyConfigId(input: string, existing: ServiceConfig[]): string {
  let base = (input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!base) base = `service-${Date.now().toString(36).slice(-5)}`;
  const taken = new Set(existing.map(c => c.id));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}
