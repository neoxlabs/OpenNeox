
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { Session, WorkspaceState } from '@neoxlabs/platform/shared/ipc.js';
import { sameWorkspace, workspaceKey, dedupeByWorkspacePath, dedupeWorkspacePaths, rekeyByWorkspacePath } from '../ui/shared/workspacePath.node.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';

const execAsync = promisify(exec);

// ==================== 类型定义 ====================
type DarkModePreference = 'dark' | 'light' | 'auto' | 'midnight' | 'high-contrast';
type ColorTheme = 'violet' | 'gold' | 'pink' | 'blue' | 'green' | 'purple' | 'orange' | 'red' | 'cyan' | 'indigo' | 'teal';

interface UIState {
  version: string;
  theme: 'dark' | 'light'; // 保留旧字段兼容
  darkModePreference?: DarkModePreference;
  colorTheme?: ColorTheme;
  /** v2: 一键风格预设 (default / nuanyang / moye / ...). 仅做兼容兜底, main 进程优先读 themePackId 决定
   *  BrowserWindow.backgroundColor — 否则首屏 200-500ms 会闪到默认色, 切了
   *  暖阳的用户重启时会先看到一帧暗色. */
  themePreset?: string;
  /** v3: 统一主题包 id. 运行时视觉以 themePack 为准, preset 只做兼容. */
  themePackId?: string;
  onboardingCompleted?: boolean;
  lastWorkspace?: string;
  lastModelId?: string;
  workspaces: Array<{
    path: string;
    name: string;
    lastOpened: number;
    lastSessionId?: string;
  }>;
  preferences: {
    autoSave: boolean;
    maxSessions: number;
  };
  // ===== 编辑器布局持久化（IDEA 行为对齐）=====
  /** 打开的文件路径列表（按 tab 顺序） */
  editorOpenFiles?: string[];
  /** 当前活跃的文件路径 */
  editorActiveFile?: string;
  /** 视图模式 */
  editorViewMode?: 'agent' | 'editor';
  /** 侧边栏是否展开 */
  sidebarVisible?: boolean;
  /** 终端是否展开 */
  terminalVisible?: boolean;
}

// ==================== 配置目录 ====================
function getConfigDir(): string {
  const platform = process.platform;
  const profile = (process.env.NEOX_PROFILE || '').toLowerCase();
  const isElectronDev = process.env.NODE_ENV === 'development' && profile !== 'prod';
  const appName = isElectronDev ? `${DISTRIBUTION.appName} Dev` : DISTRIBUTION.appName;

  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  } else if (platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(xdgConfig, isElectronDev ? 'neox-dev' : 'neox');
  }
}

const CONFIG_DIR = getConfigDir();
const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');
const WORKSPACES_DIR = path.join(CONFIG_DIR, 'workspaces');

const NEOX_HOME_DIR = path.join(os.homedir(), NEOX_HOME_DIRNAME);

function isInsideConfigDir(target: string): boolean {
  try {
    const resolvedTarget = path.resolve(target);
    const resolvedBase = path.resolve(CONFIG_DIR);
    const rel = path.relative(resolvedBase, resolvedTarget);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch { return false; }
}

/* renderer XSS 场景下, 就算能读 CONFIG_DIR 内文件, 也拒绝这类明确密文 —
 * .enc/.key/.pem 等永远不该给 renderer 看. */
function isSensitiveConfigPath(target: string): boolean {
  const lower = target.toLowerCase();
  return lower.endsWith('.enc')
    || lower.endsWith('.key')
    || lower.endsWith('.pem')
    || lower.endsWith('.p12')
    || lower.endsWith('/machine-id')
    || lower.endsWith('\\machine-id');
}

// ==================== 默认值 ====================
const DEFAULT_UI_STATE: UIState = {
  version: '1.0.0',
  theme: 'dark',
  darkModePreference: 'dark',
  colorTheme: 'violet',
  themePreset: 'moye',
  themePackId: 'anye',
  workspaces: [],
  preferences: {
    autoSave: true,
    maxSessions: 50,
  },
};

// ==================== StorageService ====================
export class StorageService {
  private uiState: UIState | null = null as UIState | null;
  /* 启动期 appLifecycle 与 mainWindowFactory 并发各调一次 loadUIState —
   * 结果缓存 (this.uiState) 拦不住并发首读, 用 in-flight promise 去重, 只读一遍 SQLite。 */
  private uiStateInflight: Promise<UIState> | null = null;

  /** 同步读已加载的 UI state 缓存 — 给不能 await 的同步调用点用 (启动完成后必有值)。 */
  getCachedUIState(): UIState | null {
    return this.uiState;
  }

  // ==================== UI State (SQLite app_state) ====================
  async loadUIState(): Promise<UIState> {
    if (this.uiState) return this.uiState;
    if (this.uiStateInflight) return this.uiStateInflight;
    this.uiStateInflight = this.doLoadUIState().finally(() => { this.uiStateInflight = null; });
    return this.uiStateInflight;
  }

  private static dedupeWorkspaces(list: UIState['workspaces']): UIState['workspaces'] {
    return dedupeByWorkspacePath(
      list,
      (w) => w?.path,
      (a, b) => ((b.lastOpened ?? 0) > (a.lastOpened ?? 0) ? b : a),
    );
  }

  private async doLoadUIState(): Promise<UIState> {
    try {
      const db = getDatabase();
      // 从 app_state 表读取各个字段
      const version = db.getAppState<string>('ui:version', DEFAULT_UI_STATE.version);
      const theme = db.getAppState<'dark' | 'light'>('ui:theme', DEFAULT_UI_STATE.theme);
      const darkModePreference = db.getAppState<DarkModePreference>('ui:darkModePreference', DEFAULT_UI_STATE.darkModePreference);
      const colorTheme = db.getAppState<ColorTheme>('ui:colorTheme', DEFAULT_UI_STATE.colorTheme);
      const themePreset = db.getAppState<string>('ui:themePreset', DEFAULT_UI_STATE.themePreset);
      const themePackId = db.getAppState<string>('ui:themePack', DEFAULT_UI_STATE.themePackId);
      const onboardingCompleted = db.getAppState<boolean>('ui:onboardingCompleted', false);
      const lastWorkspace = db.getAppState<string>('ui:lastWorkspace');
      const lastModelId = db.getAppState<string>('ui:lastModelId');
      const workspaces = db.getAppState<UIState['workspaces']>('ui:workspaces', []);
      const preferences = db.getAppState<UIState['preferences']>('ui:preferences', DEFAULT_UI_STATE.preferences);

      const editorOpenFiles = db.getAppState<string[]>('ui:editorOpenFiles');
      const editorActiveFile = db.getAppState<string>('ui:editorActiveFile');
      const editorViewMode = db.getAppState<'agent' | 'editor'>('ui:editorViewMode');
      const sidebarVisible = db.getAppState<boolean>('ui:sidebarVisible');
      const terminalVisibleState = db.getAppState<boolean>('ui:terminalVisible');

      const loaded: UIState = {
        version: version!,
        theme: theme!,
        darkModePreference,
        colorTheme,
        themePreset: themePreset ?? undefined,
        themePackId: themePackId ?? undefined,
        onboardingCompleted,
        lastWorkspace,
        lastModelId,
        workspaces: StorageService.dedupeWorkspaces(workspaces!),
        preferences: preferences!,
        editorOpenFiles: editorOpenFiles ?? undefined,
        editorActiveFile: editorActiveFile ?? undefined,
        editorViewMode: editorViewMode ?? undefined,
        sidebarVisible: sidebarVisible ?? undefined,
        terminalVisible: terminalVisibleState ?? undefined,
      };

      this.uiState = loaded;
      console.log('[Storage] Loaded UI state from SQLite');
      return loaded;
    } catch {
      console.log('[Storage] No existing UI state, using defaults');
      const defaults = { ...DEFAULT_UI_STATE };
      this.uiState = defaults;
      return defaults;
    }
  }

  async saveUIState(updates: Partial<UIState>): Promise<void> {
    const state = await this.loadUIState();
    this.uiState = { ...state, ...updates };

    try {
      const db = getDatabase();
      if (updates.version !== undefined) db.setAppState('ui:version', updates.version);
      if (updates.theme !== undefined) db.setAppState('ui:theme', updates.theme);
      if (updates.darkModePreference !== undefined) db.setAppState('ui:darkModePreference', updates.darkModePreference);
      if (updates.colorTheme !== undefined) db.setAppState('ui:colorTheme', updates.colorTheme);
      if (updates.themePreset !== undefined) db.setAppState('ui:themePreset', updates.themePreset);
      if (updates.themePackId !== undefined) db.setAppState('ui:themePack', updates.themePackId);
      if (updates.onboardingCompleted !== undefined) db.setAppState('ui:onboardingCompleted', updates.onboardingCompleted);
      if (updates.lastWorkspace !== undefined) db.setAppState('ui:lastWorkspace', updates.lastWorkspace);
      if (updates.lastModelId !== undefined) db.setAppState('ui:lastModelId', updates.lastModelId);
      if (updates.workspaces !== undefined) db.setAppState('ui:workspaces', updates.workspaces);
      if (updates.preferences !== undefined) db.setAppState('ui:preferences', updates.preferences);
      if (updates.editorOpenFiles !== undefined) db.setAppState('ui:editorOpenFiles', updates.editorOpenFiles);
      if (updates.editorActiveFile !== undefined) db.setAppState('ui:editorActiveFile', updates.editorActiveFile);
      if (updates.editorViewMode !== undefined) db.setAppState('ui:editorViewMode', updates.editorViewMode);
      if (updates.sidebarVisible !== undefined) db.setAppState('ui:sidebarVisible', updates.sidebarVisible);
      if (updates.terminalVisible !== undefined) db.setAppState('ui:terminalVisible', updates.terminalVisible);

      // 如果有嵌套更新（比如 workspaces 数组被直接修改），确保同步
      if (this.uiState.workspaces && !updates.workspaces) {
        db.setAppState('ui:workspaces', this.uiState.workspaces);
      }
    } catch (error: any) {
      console.error('[Storage] Failed to save UI state:', error.message);
    }
  }

  // ==================== Session Management (SQLite sessions 表) ====================
  async loadSession(id: string): Promise<Session | null> {
    try {
      const db = getDatabase();
      const dbSession = db.getSession(id);
      if (!dbSession) return null;

      const savedTimeline = db.getTimeline(id);
      /* contextUsed 是当前上下文窗口用量, totalTokens 可能是历史累计/旧请求值。
       * 手动压缩后 contextUsed 必须允许下降。 */
      const effectiveContextUsed = dbSession.contextUsed || dbSession.latestRequestUsage?.totalTokens || dbSession.totalTokens || 0;
      return {
        id: dbSession.id,
        name: dbSession.name,
        modelId: dbSession.modelId,
        workspacePath: dbSession.workspacePath,
        messages: [],  // messages loaded separately via sessionStore
        createdAt: dbSession.createdAt,
        updatedAt: dbSession.updatedAt,
        totalTokens: dbSession.totalTokens,
        contextUsed: effectiveContextUsed,
        contextWindow: dbSession.contextWindow,
        timeline: savedTimeline.length > 0 ? savedTimeline : undefined,
        contextBreakdown: dbSession.contextBreakdown,
        latestRequestUsage: dbSession.latestRequestUsage,
        sessionUsage: dbSession.sessionUsage ?? null,
        fileRollbackCheckpointId: dbSession.fileRollbackCheckpointId,
        fileReapplyCheckpointId: dbSession.fileReapplyCheckpointId,
        fileRevertedMap: dbSession.fileRevertedMap ?? {},
        fileConfirmedMap: dbSession.fileConfirmedMap ?? {},
      };
    } catch (error: any) {
      console.error('[Storage] Failed to load session:', id, error.message);
      return null;
    }
  }

  async saveSession(session: Session): Promise<void> {
    try {
      const db = getDatabase();
      db.upsertSession({
        id: session.id,
        name: session.name,
        modelId: session.modelId,
        workspacePath: session.workspacePath,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        totalTokens: session.totalTokens,
        contextUsed: session.contextUsed,
        contextWindow: session.contextWindow,
        fileRollbackCheckpointId: session.fileRollbackCheckpointId,
        fileReapplyCheckpointId: session.fileReapplyCheckpointId,
        fileRevertedMap: session.fileRevertedMap ?? {},
        fileConfirmedMap: session.fileConfirmedMap ?? {},
        contextBreakdown: session.contextBreakdown ?? null,
        latestRequestUsage: session.latestRequestUsage ?? null,
      });

      // 更新 workspace 的 lastSessionId
      if (session.workspacePath) {
        await this.updateWorkspaceLastSession(session.workspacePath, session.id);
      }
    } catch (error: any) {
      console.error('[Storage] Failed to save session:', session.id, error.message);
    }
  }

  async deleteSession(id: string): Promise<void> {
    try {
      getDatabase().deleteSession(id);
    } catch (error: any) {
      console.error('[Storage] Failed to delete session:', id, error.message);
    }
  }

  async listSessions(workspacePath?: string): Promise<Session[]> {
    try {
      const db = getDatabase();
      const dbSessions = db.listSessions(workspacePath);
      return dbSessions.map((s: any) => ({
        id: s.id,
        name: s.name,
        modelId: s.modelId,
        workspacePath: s.workspacePath,
        messages: [],
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        totalTokens: s.totalTokens,
        contextUsed: s.contextUsed,
        contextWindow: s.contextWindow,
        contextBreakdown: s.contextBreakdown ?? null,
        latestRequestUsage: s.latestRequestUsage ?? null,
        sessionUsage: s.sessionUsage ?? null,
        fileRollbackCheckpointId: s.fileRollbackCheckpointId,
        fileReapplyCheckpointId: s.fileReapplyCheckpointId,
        fileRevertedMap: s.fileRevertedMap ?? {},
        fileConfirmedMap: s.fileConfirmedMap ?? {},
      }));
    } catch (error: any) {
      console.error('[Storage] Failed to list sessions:', error.message);
      return [];
    }
  }

  // ==================== Workspace Management ====================
  async updateWorkspaceLastSession(workspacePath: string, sessionId: string): Promise<void> {
    const state = await this.loadUIState();
    const workspace = state.workspaces.find(w => sameWorkspace(w.path, workspacePath));

    if (workspace) {
      workspace.lastSessionId = sessionId;
      workspace.lastOpened = Date.now();
    } else {
      state.workspaces.push({
        path: workspacePath,
        name: path.basename(workspacePath),
        lastOpened: Date.now(),
        lastSessionId: sessionId,
      });
    }

    await this.saveUIState({ workspaces: state.workspaces });
  }

  async setLastWorkspace(workspacePath: string): Promise<void> {
    const state = await this.loadUIState();
    state.lastWorkspace = workspacePath;

    // 更新或添加 workspace 记录
    const existing = state.workspaces.find(w => sameWorkspace(w.path, workspacePath));
    if (existing) {
      existing.lastOpened = Date.now();
      existing.name = this.getWorkspaceName(workspacePath); // 跟随自定义名
    } else {
      state.workspaces.push({
        path: workspacePath,
        name: this.getWorkspaceName(workspacePath),
        lastOpened: Date.now(),
      });
    }

    // 只保留最近的 10 个 workspace
    state.workspaces.sort((a, b) => b.lastOpened - a.lastOpened);
    state.workspaces = state.workspaces.slice(0, 10);

    await this.saveUIState({ lastWorkspace: workspacePath, workspaces: state.workspaces });
  }

  async clearLastWorkspace(): Promise<void> {
    console.log('[Storage] Clearing last workspace');
    await this.saveUIState({ lastWorkspace: undefined });
  }

  // ==================== 工作区实体: 名称 / 删除 / 设主 / 列举 ====================
  // 工作区 = 命名的一组项目根。身份键 = primary path。元数据(自定义名)存 ui:workspaceMeta。
  // "真正的工作区"(saved) = 有自定义名 或 roots>1; 否则只是"最近打开的单个项目文件夹"。

  /* ── 以工作区路径为键的三张表 ────────────────────────────────────────────
   *
   *   ui:workspaceMeta (自定义名) / ui:workspaceRoots (多根) / ui:recentFiles (最近文件)
   *   原本都拿"写入时手上那个原始路径写法"当键。Windows 上同一个项目换个写法就取不到值:
   *   自定义项目名突然没了、多根工作区退回单根、最近文件列表空掉 —— 旧键还留在库里越攒越多。
   *
   *   现在键一律是 workspaceKey(path)。读取时 rekey 一次治旧数据, 写入时用规范键,
   *   于是库里的脏键在下一次写入被干净版本覆盖, 不需要迁移脚本。
   *   **键只用于判等**; 值里存的路径 (roots / 文件路径) 仍是原始写法, 要拿去打开文件的。
   *
   *   这三张表的 app_state 键名只允许出现在下面这几个 accessor 里 —— 由
   *   ui/shared/workspacePath.guard.test.ts 守着, 绕过 accessor 直接读写会让测试红。
   */
  private getWorkspaceMetaMap(): Record<string, { name?: string }> {
    try {
      const db = getDatabase();
      const raw = db.getAppState<Record<string, { name?: string }>>('ui:workspaceMeta', {}) || {};
      /* 撞键时保留有自定义名的那条 —— 空 meta 覆盖掉真名字是最难查的丢失 */
      return rekeyByWorkspacePath(raw, (a, b) => (b?.name?.trim() ? b : a));
    } catch {
      return {};
    }
  }

  private saveWorkspaceMetaMap(map: Record<string, { name?: string }>): void {
    try { getDatabase().setAppState('ui:workspaceMeta', map); } catch { /* ignore */ }
  }

  /** roots 表: 读 (键已归一)。撞键时保留根更多的那条 —— 多根信息比单根更值钱。 */
  private readRootsMap(): Record<string, string[]> {
    try {
      const raw = getDatabase().getAppState<Record<string, string[]>>('ui:workspaceRoots', {}) || {};
      return rekeyByWorkspacePath(raw, (a, b) => ((b?.length ?? 0) > (a?.length ?? 0) ? b : a));
    } catch {
      return {};
    }
  }

  private writeRootsMap(map: Record<string, string[]>): void {
    try { getDatabase().setAppState('ui:workspaceRoots', map); } catch (err: any) {
      console.warn('[Storage] writeRootsMap failed:', err?.message);
    }
  }

  /** recentFiles 表: 读 (键已归一)。撞键时把两边的列表按文件路径合并, 新的在前。 */
  private readRecentFilesMap(): Record<string, Array<{ path: string; ts: number }>> {
    try {
      const raw = getDatabase().getAppState<Record<string, Array<{ path: string; ts: number }>>>('ui:recentFiles', {}) || {};
      return rekeyByWorkspacePath(raw, (a, b) => {
        const seen = new Set<string>();
        return [...(a || []), ...(b || [])]
          .sort((x, y) => (y?.ts ?? 0) - (x?.ts ?? 0))
          .filter((e) => e?.path && !seen.has(e.path) && (seen.add(e.path), true))
          .slice(0, 30);
      });
    } catch {
      return {};
    }
  }

  private writeRecentFilesMap(map: Record<string, Array<{ path: string; ts: number }>>): void {
    try { getDatabase().setAppState('ui:recentFiles', map); } catch (err: any) {
      console.warn('[Storage] writeRecentFilesMap failed:', err?.message);
    }
  }

  /** 工作区显示名: 自定义名优先, 否则 primary basename。 */
  getWorkspaceName(primaryPath: string): string {
    const meta = this.getWorkspaceMetaMap()[workspaceKey(primaryPath)];
    return (meta?.name && meta.name.trim()) || path.basename(primaryPath) || primaryPath;
  }

  /** 设工作区自定义名 (空 → 清除, 回落 basename)。 */
  async setWorkspaceName(primaryPath: string, name: string): Promise<void> {
    const map = this.getWorkspaceMetaMap();
    const key = workspaceKey(primaryPath);
    const trimmed = (name || '').trim();
    if (!trimmed) {
      if (map[key]) delete map[key].name;
    } else {
      map[key] = { ...(map[key] || {}), name: trimmed };
    }
    this.saveWorkspaceMetaMap(map);
    // 同步刷新最近列表里的展示名
    const state = await this.loadUIState();
    const entry = state.workspaces.find((w) => sameWorkspace(w.path, primaryPath));
    if (entry) {
      entry.name = this.getWorkspaceName(primaryPath);
      await this.saveUIState({ workspaces: state.workspaces });
    }
  }

  /** "真正的工作区" 判定: 有自定义名 或 多根。 */
  isSavedWorkspace(primaryPath: string): boolean {
    const meta = this.getWorkspaceMetaMap()[workspaceKey(primaryPath)];
    if (meta?.name && meta.name.trim()) return true;
    return this.getWorkspaceRootsSync(primaryPath).length > 1;
  }

  /** 删除工作区 (从最近列表移除 + 清 roots/meta; 不碰磁盘文件)。 */
  async deleteWorkspace(primaryPath: string): Promise<void> {
    const state = await this.loadUIState();
    state.workspaces = state.workspaces.filter((w) => !sameWorkspace(w.path, primaryPath));
    // 清 roots
    const rootsMap = this.readRootsMap();
    delete rootsMap[workspaceKey(primaryPath)];
    this.writeRootsMap(rootsMap);
    // 清 meta
    const metaMap = this.getWorkspaceMetaMap();
    delete metaMap[workspaceKey(primaryPath)];
    this.saveWorkspaceMetaMap(metaMap);
    const updates: Partial<UIState> = { workspaces: state.workspaces };
    if (sameWorkspace(state.lastWorkspace, primaryPath)) updates.lastWorkspace = undefined;
    await this.saveUIState(updates);
  }

  /** 把 newPrimary 设为工作区主项目: roots 重排(newPrimary 首位)+ roots/meta 从 oldPrimary 键迁到 newPrimary。 */
  async setPrimaryRoot(oldPrimary: string, newPrimary: string): Promise<string[]> {
    if (sameWorkspace(oldPrimary, newPrimary)) return this.getWorkspaceRootsSync(oldPrimary);
    const roots = this.getWorkspaceRootsSync(oldPrimary);
    if (!roots.some((r) => sameWorkspace(r, newPrimary))) return roots; // newPrimary 不在本工作区, 拒绝
    const reordered = [newPrimary, ...roots.filter((r) => !sameWorkspace(r, newPrimary))];
    // 迁 roots: 删旧键, 写新键
    await this.setWorkspaceRoots(oldPrimary, []); // 删除 oldPrimary 条目
    await this.setWorkspaceRoots(newPrimary, reordered);
    // 迁 meta(自定义名)
    const metaMap = this.getWorkspaceMetaMap();
    const oldKey = workspaceKey(oldPrimary);
    const newKey = workspaceKey(newPrimary);
    if (metaMap[oldKey]) {
      metaMap[newKey] = { ...(metaMap[newKey] || {}), ...metaMap[oldKey] };
      delete metaMap[oldKey];
      this.saveWorkspaceMetaMap(metaMap);
    }
    return this.getWorkspaceRootsSync(newPrimary);
  }

  /** 列举最近工作区, 带 rootCount + saved(是否真工作区) + 显示名 —— 给 hub/welcome 区分用。 */
  async listWorkspacesEnriched(): Promise<Array<{ path: string; name: string; lastOpened: number; rootCount: number; saved: boolean }>> {
    const state = await this.loadUIState();
    return (state.workspaces || []).map((w) => ({
      path: w.path,
      name: this.getWorkspaceName(w.path),
      lastOpened: w.lastOpened,
      rootCount: this.getWorkspaceRootsSync(w.path).length,
      saved: this.isSavedWorkspace(w.path),
    }));
  }

  /**
   * 多根工作区: 读某个 primary root 对应工作区的全部根目录。
   * 存在 app_state 的 `ui:workspaceRoots` map (primaryPath → string[])。
   * 无记录 → 返回 [primaryPath] (单根, 向后兼容)。primary 恒为第一个。
   */
  async getWorkspaceRoots(primaryPath: string): Promise<string[]> {
    try {
      const roots = this.readRootsMap()[workspaceKey(primaryPath)];
      if (Array.isArray(roots) && roots.length > 0) {
        /* primary 在首位 + 按判等去重 (同一个根的两种写法不能算两个根) */
        return dedupeWorkspacePaths([primaryPath, ...roots]);
      }
    } catch (err: any) {
      console.warn('[Storage] getWorkspaceRoots failed:', err?.message);
    }
    return [primaryPath];
  }

  /**
   * 最近打开的文件 —— 按 workspace 分桶, 存 app_state 的 `ui:recentFiles`
   * (workspacePath → [{path, ts}], 最新在前, 去重, 上限 30)。欢迎页"最近打开的文件"用。
   */
  async addRecentFile(workspacePath: string, filePath: string): Promise<void> {
    if (!workspacePath || !filePath) return;
    const map = this.readRecentFilesMap();
    const key = workspaceKey(workspacePath);
    const list = (map[key] || []).filter((e) => e.path !== filePath);
    list.unshift({ path: filePath, ts: Date.now() });
    map[key] = list.slice(0, 30);
    this.writeRecentFilesMap(map);
  }

  getRecentFiles(workspacePath: string, limit = 12): Array<{ path: string; ts: number }> {
    if (!workspacePath) return [];
    try {
      return (this.readRecentFilesMap()[workspaceKey(workspacePath)] || []).slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * 多根工作区: 同步版 getWorkspaceRoots —— 给 main 进程的 fs 路径校验用
   * (getValidatedPath 是同步的, 不能 await)。better-sqlite3 本就是同步, 零代价。
   */
  getWorkspaceRootsSync(primaryPath: string): string[] {
    try {
      const roots = this.readRootsMap()[workspaceKey(primaryPath)];
      if (Array.isArray(roots) && roots.length > 0) {
        return dedupeWorkspacePaths([primaryPath, ...roots]);
      }
    } catch { /* fall through */ }
    return [primaryPath];
  }

  /**
   * 多根工作区: 写某个 primary root 对应工作区的根目录列表。
   * 单根 (只剩 primary) → 删除该条目, 回到"无记录=单根"的干净状态。
   */
  async setWorkspaceRoots(primaryPath: string, roots: string[]): Promise<void> {
    const map = this.readRootsMap();
    /* 归一: primary 首位 + 按判等去重 (保留原始写法, roots 要拿去打开文件) */
    const norm = dedupeWorkspacePaths([primaryPath, ...roots]);
    const key = workspaceKey(primaryPath);
    if (norm.length <= 1) delete map[key];
    else map[key] = norm;
    this.writeRootsMap(map);
  }

  async setLastModel(modelId: string): Promise<void> {
    console.log('[Storage] Setting last model:', modelId);
    await this.saveUIState({ lastModelId: modelId });
  }

  async setTheme(theme: 'dark' | 'light'): Promise<void> {
    console.log('[Storage] Setting theme:', theme);
    await this.saveUIState({ theme });
  }

  async setThemePreference(darkMode: string, colorTheme: string): Promise<void> {
    console.log('[Storage] Setting theme preference:', { darkMode, colorTheme });
    await this.saveUIState({
      darkModePreference: darkMode as DarkModePreference,
      colorTheme: colorTheme as ColorTheme,
      // 同时更新旧的 theme 字段以保持兼容
      theme: darkMode === 'light' ? 'light' : 'dark',
    });
  }

  /** 单独持久化 legacy themePreset (default / nuanyang / moye / ...).
   *  仅供旧版本迁移、老入口和无 themePack 时的启动色兜底. */
  async setThemePreset(themePreset: string): Promise<void> {
    console.log('[Storage] Setting theme preset:', themePreset);
    await this.saveUIState({ themePreset });
  }

  /** 超级调色盘 — themePack id (16 张内置 + 自定义).
   *  写到 ui:themePack key. renderer 启动时读 last-state, 优先用 themePack id.
   *  legacy themePreset 只作为旧版本迁移和启动色兜底. */
  async setThemePack(themePackId: string): Promise<void> {
    console.log('[Storage] Setting theme pack:', themePackId);
    const current = await this.loadUIState();
    this.uiState = { ...current, themePackId };
    try {
      const db = getDatabase();
      db.setAppState('ui:themePack', themePackId);
    } catch (error) {
      console.warn('[Storage] Failed to persist themePack:', (error as Error).message);
    }
  }

  /** renderer 启动从 last-state 拿当前 themePack id (返回 string | null) */
  async getThemePackId(): Promise<string | null> {
    try {
      const db = getDatabase();
      return db.getAppState<string>('ui:themePack') ?? null;
    } catch {
      return null;
    }
  }

  async setOnboardingCompleted(completed: boolean): Promise<void> {
    console.log('[Storage] Setting onboarding completed:', completed);
    await this.saveUIState({ onboardingCompleted: completed });
  }

  // ==================== Per-workspace Layout ====================
  //
  // 多项目并行隔离: 编辑器布局相关字段 (openFiles / activeFile / viewMode /
  // sidebarVisible / terminalVisible) 按 workspace path 分开存储, key 形如
  // `ui:layout:<encoded-path>:editorOpenFiles`. 老的全局 `ui:editorOpenFiles`
  // 仍保留作为 fallback —— 第一次迁移后, 老 global 值用来给"第一个 workspace"
  // 做初始化, 之后各 workspace 独立.
  //
  // 性能: sqlite key-value 读写, per-workspace 一次 save 产出最多 5 次 setAppState,
  // 远低于单次 IPC 延迟.

  private wsLayoutKey(workspacePath: string, field: string): string {
    // btoa 防止路径里的特殊字符 (Windows ':', 空格等) 破坏 key 格式
    const encoded = Buffer.from(workspacePath, 'utf-8').toString('base64');
    return `ui:layout:${encoded}:${field}`;
  }

  /**
   * 加载某个 workspace 的编辑器布局状态.
   * 如果 per-workspace 字段没存过, fallback 到老的全局字段 (给首次迁移的用户无损体验).
   */
  async loadWorkspaceLayout(workspacePath: string): Promise<{
    editorOpenFiles?: string[];
    editorActiveFile?: string;
    editorViewMode?: 'agent' | 'editor';
    sidebarVisible?: boolean;
    terminalVisible?: boolean;
  }> {
    try {
      const db = getDatabase();
      // 优先读 per-workspace key
      const scoped = {
        editorOpenFiles: db.getAppState<string[]>(this.wsLayoutKey(workspacePath, 'editorOpenFiles')),
        editorActiveFile: db.getAppState<string>(this.wsLayoutKey(workspacePath, 'editorActiveFile')),
        editorViewMode: db.getAppState<'agent' | 'editor'>(this.wsLayoutKey(workspacePath, 'editorViewMode')),
        sidebarVisible: db.getAppState<boolean>(this.wsLayoutKey(workspacePath, 'sidebarVisible')),
        terminalVisible: db.getAppState<boolean>(this.wsLayoutKey(workspacePath, 'terminalVisible')),
      };
      // 如果 per-workspace 没存过, 回落到老的 global 值
      const anyScopedSet =
        scoped.editorOpenFiles !== undefined ||
        scoped.editorActiveFile !== undefined ||
        scoped.editorViewMode !== undefined ||
        scoped.sidebarVisible !== undefined ||
        scoped.terminalVisible !== undefined;
      if (anyScopedSet) return scoped;

      // fallback 到 global
      const globalLastWs = db.getAppState<string>('ui:lastWorkspace');
      if (sameWorkspace(globalLastWs, workspacePath)) {
        // 全局 key 的 "上一个 workspace" 匹配当前 workspace → 直接用
        return {
          editorOpenFiles: db.getAppState<string[]>('ui:editorOpenFiles'),
          editorActiveFile: db.getAppState<string>('ui:editorActiveFile'),
          editorViewMode: db.getAppState<'agent' | 'editor'>('ui:editorViewMode'),
          sidebarVisible: db.getAppState<boolean>('ui:sidebarVisible'),
          terminalVisible: db.getAppState<boolean>('ui:terminalVisible'),
        };
      }
      return {};
    } catch (err) {
      console.error('[Storage] loadWorkspaceLayout failed:', err);
      return {};
    }
  }

  async saveWorkspaceLayout(
    workspacePath: string,
    layout: {
      editorOpenFiles?: string[];
      editorActiveFile?: string;
      editorViewMode?: 'agent' | 'editor';
      sidebarVisible?: boolean;
      terminalVisible?: boolean;
    },
  ): Promise<void> {
    try {
      const db = getDatabase();
      if (layout.editorOpenFiles !== undefined) {
        db.setAppState(this.wsLayoutKey(workspacePath, 'editorOpenFiles'), layout.editorOpenFiles);
      }
      if (layout.editorActiveFile !== undefined) {
        db.setAppState(this.wsLayoutKey(workspacePath, 'editorActiveFile'), layout.editorActiveFile);
      }
      if (layout.editorViewMode !== undefined) {
        db.setAppState(this.wsLayoutKey(workspacePath, 'editorViewMode'), layout.editorViewMode);
      }
      if (layout.sidebarVisible !== undefined) {
        db.setAppState(this.wsLayoutKey(workspacePath, 'sidebarVisible'), layout.sidebarVisible);
      }
      if (layout.terminalVisible !== undefined) {
        db.setAppState(this.wsLayoutKey(workspacePath, 'terminalVisible'), layout.terminalVisible);
      }
    } catch (err) {
      console.error('[Storage] saveWorkspaceLayout failed:', err);
    }
  }

  // ==================== 清理旧数据 ====================
  async cleanupOldSessions(_maxSessions: number = 50): Promise<void> {
    // Session history is user data. Never prune it automatically.
    // Keep this no-op method only for compatibility with older call sites.
  }

  // ==================== 调试信息 ====================
  getConfigPath(): string {
    return CONFIG_DIR;
  }
}

// ==================== 存储信息类型 ====================
export interface StorageFileInfo {
  path: string;
  name: string;
  size: number;
  type: 'json' | 'directory' | 'other';
  description: string;
}

// Checkpoint 存储信息
export interface CheckpointStorageInfo {
  workspacePath: string;
  workspaceName: string;
  size: number;
  checkpointCount: number;
}

export interface StorageInfo {
  configDir: string;
  /** ~/.neox — 真正放 config.json / logs / checkpoints 的地方 */
  neoxHomeDir?: string;
  totalSize: number;
  files: StorageFileInfo[];
  // Checkpoint 存储信息
  checkpointTotalSize: number;
  checkpoints: CheckpointStorageInfo[];
}

// ==================== StorageInfoService ====================
/** semantic/ 下的索引文件形态 (含 -wal/-shm) */
const SEMANTIC_DB_FILE = /\.db(-wal|-shm)?$/;

export class StorageInfoService {
  // 目录大小缓存（缓存 30 秒）
  private directorySizeCache: Map<string, { size: number; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 30 * 1000; // 30 秒缓存

  /**
   * 快速获取目录大小（使用系统命令 du）
   * 比递归遍历快 10-100 倍
   */
  private async getDirectorySizeFast(dirPath: string): Promise<number> {
    // 检查缓存
    const cached = this.directorySizeCache.get(dirPath);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.size;
    }

    try {
      // 先检查目录是否存在
      await fs.access(dirPath);

      // 使用 du -sk 获取目录大小（以 KB 为单位，跨平台支持更好）
      //    的目录就认它"大但未知", 给个保守占位即可, 别拿 UI 线程级体验换一个精确字节数.
      const { stdout } = await execAsync(`du -sk "${dirPath}"`, {
        timeout: 4000,
        killSignal: 'SIGKILL',
      });

      const sizeKB = parseInt(stdout.split('\t')[0], 10);
      const sizeBytes = isNaN(sizeKB) ? 0 : sizeKB * 1024;

      // 更新缓存
      this.directorySizeCache.set(dirPath, { size: sizeBytes, timestamp: Date.now() });

      return sizeBytes;
    } catch (error: any) {
      if (error.code === 'ENOENT' || error.message?.includes('ENOENT')) {
        return 0;
      }
      const stale = this.directorySizeCache.get(dirPath);
      const fallback = stale?.size ?? 0;
      this.directorySizeCache.set(dirPath, { size: fallback, timestamp: Date.now() });
      console.warn(`[StorageInfo] du timed out for ${dirPath}, returning ${fallback} (no JS recursion)`);
      return fallback;
    }
  }


  // 获取目录大小（使用快速方法）
  private async getDirectorySize(dirPath: string): Promise<number> {
    return this.getDirectorySizeFast(dirPath);
  }

  // 获取文件大小
  private async getStaleDbBackupSize(): Promise<number> {
    try {
      const entries = await fs.readdir(CONFIG_DIR);
      const STALE = /^neox\.db\.(broken|pre-migrate|pre-v[\d.]+-clean|encrypting)[.-]/;
      const hits = entries.filter(n => STALE.test(n));
      const sizes = await Promise.all(hits.map(n => this.getFileSize(path.join(CONFIG_DIR, n))));
      return sizes.reduce((a, b) => a + b, 0);
    } catch {
      return 0;
    }
  }

  private async getStaleCliBinarySize(): Promise<number> {
    try {
      const binDir = path.join(NEOX_HOME_DIR, 'bin');
      const entries = await fs.readdir(binDir);
      const STALE = /^neox\.(bin-backup|orig)-/;
      const hits = entries.filter(n => STALE.test(n));
      const sizes = await Promise.all(hits.map(n => this.getFileSize(path.join(binDir, n))));
      return sizes.reduce((a, b) => a + b, 0);
    } catch {
      return 0;
    }
  }

  async cleanupStaleDbBackups(keepLatest = 1): Promise<{ removed: number; freedBytes: number; kept: string[] }> {
    const STALE = /^neox(-cli)?\.db\.(broken|pre-migrate|pre-v[\d.]+-clean|encrypting)[.-](\d+)/;
    try {
      const entries = await fs.readdir(CONFIG_DIR);
      /* 按"主文件"分组: neox.db.broken.<ts> 是主, 同名 + -wal/-shm 是它的附属 */
      const groups = new Map<string, { ts: number; files: string[] }>();
      for (const name of entries) {
        const m = STALE.exec(name);
        if (!m) continue;
        const base = name.replace(/-(wal|shm)$/, '');
        const g = groups.get(base) ?? { ts: Number(m[3]) || 0, files: [] };
        g.files.push(name);
        groups.set(base, g);
      }
      const ordered = [...groups.entries()].sort((a, b) => b[1].ts - a[1].ts);
      const doomed = ordered.slice(Math.max(0, keepLatest));
      let freedBytes = 0;
      let removed = 0;
      for (const [, g] of doomed) {
        for (const f of g.files) {
          const full = path.join(CONFIG_DIR, f);
          const size = await this.getFileSize(full);
          try {
            await fs.rm(full, { force: true });
            freedBytes += size;
            removed++;
          } catch { /* 删不掉就跳过 —— 报少不报多 */ }
        }
      }
      return { removed, freedBytes, kept: ordered.slice(0, Math.max(0, keepLatest)).map(([k]) => k) };
    } catch {
      return { removed: 0, freedBytes: 0, kept: [] };
    }
  }

  async cleanupStaleCliBinaries(keepLatest = 1): Promise<{ removed: number; freedBytes: number; kept: string[] }> {
    const STALE = /^neox\.(bin-backup|orig)-/;
    try {
      const binDir = path.join(NEOX_HOME_DIR, 'bin');
      const entries = await fs.readdir(binDir);
      const hits = entries.filter(n => STALE.test(n));
      /* 按 mtime 排序 —— 版本号字符串比较靠不住 (3.1.7 vs 3.10.1) */
      const withTime = await Promise.all(hits.map(async (n) => {
        try { return { n, mtime: (await fs.stat(path.join(binDir, n))).mtimeMs }; }
        catch { return { n, mtime: 0 }; }
      }));
      withTime.sort((a, b) => b.mtime - a.mtime);
      const doomed = withTime.slice(Math.max(0, keepLatest));
      let freedBytes = 0;
      let removed = 0;
      for (const { n } of doomed) {
        const full = path.join(binDir, n);
        const size = await this.getFileSize(full);
        try {
          await fs.rm(full, { force: true });
          freedBytes += size;
          removed++;
        } catch { /* 删不掉就跳过 */ }
      }
      return { removed, freedBytes, kept: withTime.slice(0, Math.max(0, keepLatest)).map(x => x.n) };
    } catch {
      return { removed: 0, freedBytes: 0, kept: [] };
    }
  }

  private async getSemanticIndexSize(): Promise<number> {
    try {
      const dir = path.join(CONFIG_DIR, 'semantic');
      return await this.getDirectorySize(dir);
    } catch {
      return 0;
    }
  }

  private async liveSemanticDbNames(): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      const { createHash } = await import('node:crypto');
      /* 工作区名单在 StorageService 上 (这个类是 StorageInfoService) —— 引单例。
       * 单例声明在文件末尾, 但这里是方法体里按调用时求值, 没有 TDZ 问题。 */
      const ws = storageService;
      const state = ws.getCachedUIState() as any;
      const roots = new Set<string>();
      for (const w of (state?.workspaces || [])) {
        if (!w?.path) continue;
        roots.add(w.path);
        for (const r of (ws.getWorkspaceRootsSync(w.path) || [])) if (r) roots.add(r);
      }
      for (const root of roots) {
        const h = createHash('sha256').update(root).digest('hex').slice(0, 16);
        for (const suffix of ['.db', '.db-wal', '.db-shm']) out.add(`${h}${suffix}`);
      }
    } catch { /* 拿不到名单 → 下面会当作"无法判定", 不删任何东西 */ }
    return out;
  }

  private async listStaleSemanticFiles(): Promise<string[]> {
    const STALE_INDEX_DAYS = 60;
    try {
      const live = await this.liveSemanticDbNames();
      const dir = path.join(CONFIG_DIR, 'semantic');
      const entries = await fs.readdir(dir);
      const cutoff = Date.now() - STALE_INDEX_DAYS * 24 * 3600 * 1000;
      const out: string[] = [];
      for (const n of entries) {
        if (!SEMANTIC_DB_FILE.test(n)) continue;
        if (live.has(n)) continue;                       /* 在名单里 → 保护 */
        try {
          const st = await fs.stat(path.join(dir, n));
          if (st.mtimeMs < cutoff) out.push(n);
        } catch { /* 读不到就跳过 */ }
      }
      return out;
    } catch {
      return [];
    }
  }

  private async getOrphanSemanticIndexSize(): Promise<number> {
    try {
      const dir = path.join(CONFIG_DIR, 'semantic');
      const stale = await this.listStaleSemanticFiles();
      const sizes = await Promise.all(stale.map(n => this.getFileSize(path.join(dir, n))));
      return sizes.reduce((a, b) => a + b, 0);
    } catch {
      return 0;
    }
  }

  async cleanupOrphanSemanticIndexes(): Promise<{ removed: number; freedBytes: number }> {
    try {
      const dir = path.join(CONFIG_DIR, 'semantic');
      const stale = await this.listStaleSemanticFiles();
      let removed = 0;
      let freedBytes = 0;
      for (const n of stale) {
        const full = path.join(dir, n);
        const size = await this.getFileSize(full);
        try {
          await fs.rm(full, { force: true });
          freedBytes += size;
          removed++;
        } catch { /* 删不掉就跳过 */ }
      }
      return { removed, freedBytes };
    } catch {
      return { removed: 0, freedBytes: 0 };
    }
  }

  private async getFileSize(filePath: string): Promise<number> {
    try {
      const stat = await fs.stat(filePath);
      return stat.size;
    } catch {
      return 0;
    }
  }

  // 获取存储信息
  //    五段串行 await, 每个 du 各等 5s timeout, 目录大时叠加成几十秒"加载中"). 现在 Promise.all
  //    一把抓, 墙钟 = 最慢的单个 du, 不再是求和.
  async getStorageInfo(): Promise<StorageInfo> {
    /* config.json 在 ~/.neox, 不在 userData —— 见 NEOX_HOME_DIR 注释 */
    const configJsonPath = path.join(NEOX_HOME_DIR, 'config.json');
    const dbPath = path.join(CONFIG_DIR, 'neox.db');
    const logsDir = path.join(NEOX_HOME_DIR, 'logs');
    const neoxCheckpointsDir = path.join(NEOX_HOME_DIR, 'checkpoints');
    const chromeProfilesDir = path.join(NEOX_HOME_DIR, 'chrome-profiles');
    const modelsDir = path.join(NEOX_HOME_DIR, 'models');
    const binDir = path.join(NEOX_HOME_DIR, 'bin');

    const semanticDir = path.join(CONFIG_DIR, 'semantic');

    const [configJsonSize, dbSize, staleDbSize, staleCliSize, sessionsSize, workspacesSize, checkpointInfo,
           logsSize, neoxCheckpointsSize, chromeProfilesSize, modelsSize, binSize,
           semanticSize, orphanSemanticSize] = await Promise.all([
      this.getFileSize(configJsonPath),
      this.getFileSize(dbPath),
      this.getStaleDbBackupSize(),
      this.getStaleCliBinarySize(),
      this.getDirectorySize(SESSIONS_DIR),
      this.getDirectorySize(WORKSPACES_DIR),
      this.getCheckpointStorageInfo(),
      this.getDirectorySize(logsDir),
      this.getDirectorySize(neoxCheckpointsDir),
      this.getDirectorySize(chromeProfilesDir),
      this.getDirectorySize(modelsDir),
      this.getDirectorySize(binDir),
      this.getSemanticIndexSize(),
      this.getOrphanSemanticIndexSize(),
    ]);

    const files: StorageFileInfo[] = [];

    // 主配置文件 config.json
    files.push({
      path: configJsonPath,
      name: 'config.json',
      size: configJsonSize,
      type: 'json',
      description: '主配置文件（Provider、API Key 等）',
    });

    files.push({
      path: dbPath,
      name: 'neox.db',
      size: dbSize,
      type: 'other',
      description: 'SQLite 数据库（会话、Token 统计、UI 状态）',
    });

    /* 废弃的数据库副本 —— 单独一栏, 不并进「数据库」。
     * 并进去会让用户以为"我的数据有 150M", 而其中 98M 是死掉的旧副本、删了没有任何影响。
     * 分开列, 那一栏才读得出"这是可以清的"。 */
    if (staleDbSize > 0) {
      files.push({
        path: CONFIG_DIR,
        name: 'neox.db.backups',
        size: staleDbSize,
        type: 'other',
        description: '历次迁移/修复留下的旧数据库副本（.broken / .pre-migrate 等，可安全删除）',
      });
    }

    // Sessions 目录 (legacy, may still exist)
    if (sessionsSize > 0) {
      files.push({
        path: SESSIONS_DIR,
        name: 'sessions/ (legacy)',
        size: sessionsSize,
        type: 'directory',
        description: '旧版会话元数据（已迁移到 SQLite）',
      });
    }

    // Workspaces 目录
    if (workspacesSize > 0) {
      files.push({
        path: WORKSPACES_DIR,
        name: 'workspaces/',
        size: workspacesSize,
        type: 'directory',
        description: '工作区状态',
      });
    }

    /* ~/.neox 下的大头 — 目录不存在时 getDirectorySize 返 0, 这里就不列 */
    if (logsSize > 0) {
      files.push({
        path: logsDir,
        name: 'logs/',
        size: logsSize,
        type: 'directory',
        description: '运行日志（排障用，可随时删）',
      });
    }
    if (neoxCheckpointsSize > 0) {
      files.push({
        path: neoxCheckpointsDir,
        name: 'checkpoints/',
        size: neoxCheckpointsSize,
        type: 'directory',
        description: '文件快照（用于回滚整轮改动）',
      });
    }
    if (chromeProfilesSize > 0) {
      files.push({
        path: chromeProfilesDir,
        name: 'chrome-profiles/',
        size: chromeProfilesSize,
        type: 'directory',
        description: 'Agent 浏览器的登录状态和缓存',
      });
    }
    if (modelsSize > 0) {
      files.push({
        path: modelsDir,
        name: 'models/',
        size: modelsSize,
        type: 'directory',
        description: '下载到本机的语音模型（删掉可在设置→语音里重新下载）',
      });
    }
    if (binSize > 0) {
      files.push({
        path: binDir,
        name: 'bin/',
        /* 扣掉旧版残留 —— 它单独成栏 (见下)。不扣的话两栏加起来会超过 bin/ 实际大小,
         * 而这一页的条形是按"加起来等于总占用"设计的。 */
        size: Math.max(0, binSize - staleCliSize),
        type: 'directory',
        description: '当前版本的命令行工具',
      });
    }
    if (staleCliSize > 0) {
      files.push({
        path: binDir,
        name: 'bin/.stale',
        size: staleCliSize,
        type: 'directory',
        description: '历次升级留下的旧版命令行工具（可安全删除）',
      });
    }
    if (semanticSize > 0) {
      files.push({
        path: semanticDir,
        name: 'semantic/',
        /* 扣掉孤儿部分 —— 同 bin/ 的处理: 两栏加起来要等于目录实际大小 */
        size: Math.max(0, semanticSize - orphanSemanticSize),
        type: 'directory',
        description: '代码语义索引（删掉会在下次打开项目时重建）',
      });
    }
    if (orphanSemanticSize > 0) {
      files.push({
        path: semanticDir,
        name: 'semantic/.orphan',
        size: orphanSemanticSize,
        type: 'directory',
        description: '已移除工作区的残留索引（可安全删除）',
      });
    }

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);

    return {
      configDir: CONFIG_DIR,
      neoxHomeDir: NEOX_HOME_DIR,
      totalSize,
      files,
      checkpointTotalSize: checkpointInfo.totalSize,
      checkpoints: checkpointInfo.checkpoints,
    };
  }

  // 获取所有 workspace 的 checkpoint 存储信息（并行处理）
  private async getCheckpointStorageInfo(): Promise<{ totalSize: number; checkpoints: CheckpointStorageInfo[] }> {
    try {
      // 从 SQLite 获取最近使用的工作区
      const uiState = await storageService.loadUIState();
      const workspaces = uiState.workspaces || [];

      // 并行处理所有工作区
      const checkpointPromises = workspaces.map(async (workspace) => {
        const cdundoPath = path.join(workspace.path, '.cdundo');
        try {
          const stat = await fs.stat(cdundoPath);
          if (stat.isDirectory()) {
            const [size, checkpointCount] = await Promise.all([
              this.getDirectorySize(cdundoPath),
              this.countCheckpoints(cdundoPath),
            ]);

            if (size > 0) {
              return {
                workspacePath: workspace.path,
                workspaceName: workspace.name || path.basename(workspace.path),
                size,
                checkpointCount,
              } as CheckpointStorageInfo;
            }
          }
        } catch {
          // .cdundo 目录不存在，跳过
        }
        return null;
      });

      const results = await Promise.all(checkpointPromises);
      const checkpoints = results.filter((r): r is CheckpointStorageInfo => r !== null);

      const repos = await this.listCheckpointRepos();
      checkpoints.push(...repos);

      const totalSize = checkpoints.reduce((sum, cp) => sum + cp.size, 0);
      checkpoints.sort((a, b) => b.size - a.size);

      return { totalSize, checkpoints };
    } catch (error) {
      console.error('[StorageInfo] Failed to get checkpoint storage info:', error);
      return { totalSize: 0, checkpoints: [] };
    }
  }

  /** ~/.neox/checkpoints 下的快照仓库 —— 当前布局, 一个项目一个 <slug>-<hash>.git。
   *  workspacePath 直接用仓库目录本身, clearCheckpointStorage 按这个路径删。 */
  private async listCheckpointRepos(): Promise<CheckpointStorageInfo[]> {
    const dir = path.join(NEOX_HOME_DIR, 'checkpoints');
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return []; /* 没建过快照 */
    }
    const repos = entries.filter(e => e.isDirectory() && e.name.endsWith('.git'));
    const infos = await Promise.all(repos.map(async (e) => {
      const full = path.join(dir, e.name);
      const size = await this.getDirectorySize(full);
      if (size <= 0) return null;
      return {
        workspacePath: full,
        /* 目录名是 `<项目名>-<8位哈希>.git`, 去掉尾巴才是用户认得的项目名 */
        workspaceName: e.name.replace(/-[0-9a-f]{6,}\.git$/i, '').replace(/\.git$/i, ''),
        size,
        checkpointCount: 0,
      } as CheckpointStorageInfo;
    }));
    return infos.filter((x): x is CheckpointStorageInfo => x !== null);
  }

  // 统计 checkpoint 数量
  private async countCheckpoints(cdundoPath: string): Promise<number> {
    try {
      const gitDir = path.join(cdundoPath, '.git');
      const stat = await fs.stat(gitDir);
      if (stat.isDirectory()) {
        const objectsPath = path.join(gitDir, 'objects');
        const entries = await fs.readdir(objectsPath, { withFileTypes: true });
        const dirCount = entries.filter(e => e.isDirectory() && e.name !== 'info' && e.name !== 'pack').length;
        return Math.max(1, Math.floor(dirCount / 2));
      }
    } catch {
      // 忽略错误
    }
    return 0;
  }

  // 清理指定工作区的 checkpoint 数据
  async clearCheckpointStorage(workspacePath: string): Promise<{ success: boolean; freedSize: number; error?: string }> {
    /* 现行布局: 传进来的就是 ~/.neox/checkpoints/<slug>.git 本身, 直接删这个目录。
     * 严格判"就在 checkpoints 下的一级 .git 目录", 不接受任何越界路径。 */
    const repoRoot = path.join(NEOX_HOME_DIR, 'checkpoints');
    const resolved = path.resolve(workspacePath);
    if (path.dirname(resolved) === repoRoot && resolved.endsWith('.git')) {
      try {
        const size = await this.getDirectorySize(resolved);
        await fs.rm(resolved, { recursive: true, force: true });
        console.log(`[StorageInfo] Cleared checkpoint repo ${resolved}: ${size} bytes freed`);
        return { success: true, freedSize: size };
      } catch (error: any) {
        console.error(`[StorageInfo] Failed to clear checkpoint repo ${resolved}:`, error);
        return { success: false, freedSize: 0, error: error.message };
      }
    }
    const cdundoPath = path.join(workspacePath, '.cdundo');
    try {
      const size = await this.getDirectorySize(cdundoPath);
      await fs.rm(cdundoPath, { recursive: true, force: true });
      console.log(`[StorageInfo] Cleared checkpoint storage for ${workspacePath}: ${size} bytes freed`);
      return { success: true, freedSize: size };
    } catch (error: any) {
      console.error(`[StorageInfo] Failed to clear checkpoint storage for ${workspacePath}:`, error);
      return { success: false, freedSize: 0, error: error.message };
    }
  }

  // 清理所有工作区的 checkpoint 数据
  async clearAllCheckpointStorage(): Promise<{ success: boolean; freedSize: number; clearedCount: number; error?: string }> {
    let totalFreed = 0;
    let clearedCount = 0;
    const errors: string[] = [];

    try {
      const uiState = await storageService.loadUIState();
      const workspaces = uiState.workspaces || [];
      /* 老布局(.cdundo) + 现行布局(~/.neox/checkpoints/*.git) 一起清 —— 只清前者的话,
       * 「全部清理」在今天的机器上必然一个字节都不会少。 */
      const repos = await this.listCheckpointRepos();
      const targets = [...workspaces.map(w => w.path), ...repos.map(r => r.workspacePath)];

      for (const target of targets) {
        const result = await this.clearCheckpointStorage(target);
        if (result.success) {
          totalFreed += result.freedSize;
          if (result.freedSize > 0) {
            clearedCount++;
          }
        } else if (result.error) {
          errors.push(`${path.basename(target)}: ${result.error}`);
        }
      }

      if (errors.length > 0) {
        return { success: false, freedSize: totalFreed, clearedCount, error: errors.join('; ') };
      }
      return { success: true, freedSize: totalFreed, clearedCount };
    } catch (error: any) {
      return { success: false, freedSize: totalFreed, clearedCount, error: error.message };
    }
  }

  // 读取配置文件内容
  async readConfigFile(filePath: string): Promise<{ content: string; error?: string }> {
    try {
      if (!isInsideConfigDir(filePath)) {
        return { content: '', error: '不允许访问配置目录外的文件' };
      }
      /* renderer 不该看密文 — auth.enc / gateway-key.enc / *.key / *.pem 等一律拒.
       * 免得 renderer XSS 后把加密 blob 打出去做离线破解. */
      if (isSensitiveConfigPath(filePath)) {
        return { content: '', error: '拒绝读取加密凭据文件' };
      }

      const content = await fs.readFile(filePath, 'utf-8');
      return { content };
    } catch (error: any) {
      return { content: '', error: error.message };
    }
  }

  // 列出目录中的文件
  async listConfigDir(dirPath: string): Promise<StorageFileInfo[]> {
    const files: StorageFileInfo[] = [];
    try {
      if (!isInsideConfigDir(dirPath)) {
        return files;
      }

      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        let size = 0;
        let type: 'json' | 'directory' | 'other' = 'other';

        if (entry.isDirectory()) {
          size = await this.getDirectorySize(entryPath);
          type = 'directory';
        } else {
          size = await this.getFileSize(entryPath);
          type = entry.name.endsWith('.json') ? 'json' : 'other';
        }

        files.push({
          path: entryPath,
          name: entry.name,
          size,
          type,
          description: '',
        });
      }
    } catch {
      // 目录不存在
    }
    return files;
  }
}

export const storageInfoService = new StorageInfoService();

// 单例
export const storageService = new StorageService();
