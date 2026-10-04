import type { RendererAPIOptionalFeatures } from './rendererApi/optionalFeatures.js';
import type { RendererAPICheckpoint } from './rendererApi/checkpoint.js';
import type { RendererAPIBrowser } from './rendererApi/browser.js';
import type { RendererAPIContext } from './rendererApi/context.js';
import type { RendererAPIDebug } from './rendererApi/debug.js';
import type { RendererAPIIndexing } from './rendererApi/indexing.js';
import type { RendererAPIMcp } from './rendererApi/mcp.js';
import type { RendererAPIMemory } from './rendererApi/memory.js';
import type { RendererAPIKnowledge } from './rendererApi/knowledge.js';
import type { RendererAPIProvider } from './rendererApi/provider.js';
import type { RendererAPIMigrate } from './rendererApi/migrate.js';
import type { RendererAPISkills } from './rendererApi/skills.js';
import type { RendererAPIStorage } from './rendererApi/storage.js';
import type { RendererAPITerminal } from './rendererApi/terminal.js';

// Type aliases avoid heavy import lists and keep the interface readable.
type AppInfo = import('../ipc.js').AppInfo;
type ChatRequestPayload = import('../ipc.js').ChatRequestPayload;
type ChatResponsePayload = import('../ipc.js').ChatResponsePayload;
type ColorTheme = import('../ipc.js').ColorTheme;
type DarkModePreference = import('../ipc.js').DarkModePreference;
type MenuAction = import('../ipc.js').MenuAction;
type SavedTimelineEntry = import('../ipc.js').SavedTimelineEntry;
type Session = import('../ipc.js').Session;
type SessionCheckpointMeta = import('../ipc.js').SessionCheckpointMeta;
type StreamEvent = import('../ipc.js').StreamEvent;
type UILastState = import('../ipc.js').UILastState;
type WorkspaceState = import('../ipc.js').WorkspaceState;

export interface RendererAPIAuthUser {
  id: string;
  email: string;
  phone?: string | null;
  displayName?: string;
  avatarUrl?: string;
  emailVerifiedAt?: string | null;
  phoneVerifiedAt?: string | null;
  suspendedAt?: string | null;
  createdAt?: string;
  lastLoginAt?: string | null;
}

export interface RendererAPIPersistedAuth {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  user: RendererAPIAuthUser;
  scopes?: string[];
}

export interface RendererAPIAuthSessionStatus {
  loggedIn: boolean;
  user: RendererAPIAuthUser | null;
  accessExpiresAt: number | null;
  scopes?: string[];
}

export interface RendererAPIAuthProxyResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  bodyBase64: string;
}

export type RendererAPIAuthProxyBody =
  | { kind: 'text'; text: string }
  | { kind: 'base64'; dataBase64: string; contentType?: string }
  | {
      kind: 'formData';
      entries: Array<
        | { kind: 'field'; name: string; value: string }
        | { kind: 'file'; name: string; fileName: string; contentType?: string; dataBase64: string }
      >;
    };

export interface RendererAPIAuthProxyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: RendererAPIAuthProxyBody;
  timeoutMs?: number;
}

export type RendererAPIAuthProxyResult =
  | { ok: true; response: RendererAPIAuthProxyResponse }
  | { ok: false; code: string; message: string; status?: number };

export type RendererAPIAuthCompleteLoginResult =
  | { ok: true; session: RendererAPIAuthSessionStatus }
  | { ok: false; response: RendererAPIAuthProxyResponse };

export interface RendererAPI extends RendererAPIOptionalFeatures, RendererAPIBrowser, RendererAPICheckpoint, RendererAPIContext, RendererAPIDebug, RendererAPIIndexing, RendererAPIMcp, RendererAPIMemory, RendererAPIKnowledge, RendererAPIProvider, RendererAPIMigrate, RendererAPISkills, RendererAPIStorage, RendererAPITerminal {
  // App
  getAppInfo: () => Promise<AppInfo>;

  // Auth
  auth?: {
    /** @deprecated Raw tokens no longer leave the main process; this resolves to null. */
    getTokens: () => Promise<RendererAPIPersistedAuth | null>;
    getSessionStatus?: () => Promise<RendererAPIAuthSessionStatus>;
    fetch?: (request: RendererAPIAuthProxyRequest) => Promise<RendererAPIAuthProxyResult>;
    completeLogin?: (request: RendererAPIAuthProxyRequest) => Promise<RendererAPIAuthCompleteLoginResult>;
    /** @deprecated Renderer token writes are disabled; use completeLogin/launchOAuth. */
    setTokens: (tokens: RendererAPIPersistedAuth) => Promise<void>;
    logout?: () => Promise<void>;
    clearTokens: () => Promise<void>;
    launchOAuth?: (params?: { controlPlaneBaseUrl?: string; webBaseUrl?: string; scope?: string; deviceName?: string }) => Promise<RendererAPIAuthUser>;
    cancelOAuth?: () => Promise<void>;
    getDeviceFingerprint?: () => Promise<{ fpHash: string; fpBlob: Record<string, string> }>;
    /** @deprecated HMAC signing is now main-only through auth.fetch. */
    signRequest?: (path: string, bodySha256Hex: string) => Promise<{ ts: string; nonce: string; sig: string; version: string } | null>;
    onChanged?: (handler: (payload: unknown) => void) => () => void;
    /** @deprecated sessions are global; login no longer migrates anonymous DB buckets. */
    onAnonymousMigrated?: (handler: (payload: unknown) => void) => () => void;
  };

  // Diagnostics Recorder (renderer → main JSONL). Optional in old preload builds.
  diagnosticsAppend?: (payload: { sessionId: string; lines: string[] }) => Promise<{ ok: boolean; path?: string; error?: string }>;
  diagnosticsOpenFolder?: () => Promise<string | null>;

  // Dialog
  openFolderDialog: () => Promise<string | null>;
  /** OS 文件选择器 — 单选, 返回绝对路径. defaultPath 给 workspace 当起点更直观.
   *  filters: macOS/Linux 显示在 "Format" 下拉, Windows 显示在 "类型" 框. */
  openFileDialog: (opts?: {
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => Promise<string | null>;

  // Workspace
  setWorkspace: (path: string) => Promise<WorkspaceState>;
  clearLastWorkspace: () => Promise<void>;
  /** 多根工作区: 读 primary root 对应工作区的全部根目录 (含 primary, 有序)。 */
  getWorkspaceRoots: (primaryPath: string) => Promise<string[]>;
  /** 多根工作区: 写工作区根目录列表 (增/删根)。返回归一化后的最终列表 (primary 首位)。 */
  setWorkspaceRoots: (primaryPath: string, roots: string[]) => Promise<string[]>;
  /** 拖入的 OS File → 绝对路径 (Electron webUtils.getPathForFile)。拿不到返回 null。 */
  getPathForFile: (file: File) => string | null;
  /** 最近打开的文件 (欢迎页): 记录一次打开 / 读取列表 (按 workspace 分桶)。 */
  addRecentFile: (workspacePath: string, filePath: string) => Promise<void>;
  getRecentFiles: (workspacePath: string, limit?: number) => Promise<Array<{ path: string; ts: number }>>;
  /** 工作区实体: 重命名 / 删除 / 设主项目 / 列举(带 saved 标记)。 */
  setWorkspaceName: (primaryPath: string, name: string) => Promise<string>;
  deleteWorkspace: (primaryPath: string) => Promise<void>;
  setPrimaryRoot: (oldPrimary: string, newPrimary: string) => Promise<string[]>;
  listWorkspaces: () => Promise<Array<{ path: string; name: string; lastOpened: number; rootCount: number; saved: boolean }>>;

  // UI State
  getLastState: () => Promise<UILastState>;
  setThemePreference: (darkMode: DarkModePreference, colorTheme: ColorTheme) => Promise<void>;
  /** main 进程持久化 legacy theme preset, 仅供老入口和老版本兜底. */
  setThemePreset: (preset: string) => Promise<void>;
  /** main 进程持久化统一主题包 id. 这是当前主题真相源. */
  setThemePack: (packId: string) => Promise<void>;
  /**
   * Windows: 同步系统标题栏控件 (min/max/close) 叠加层颜色。
   * 传入 topbar 颜色，避免硬编码颜色与主题色板不一致。
   * 兼容旧签名 `(isDark: boolean)`。
   */
  syncTitleBar: (payload: boolean | {
    isDark?: boolean;
    color?: string;
    symbolColor?: string;
    height?: number;
    backdrop?: 'acrylic' | 'none';
  }) => Promise<{ ok: boolean; color?: string; symbolColor?: string; backdrop?: string; reason?: string } | void>;
  setOnboardingCompleted: (completed: boolean) => Promise<void>;

  // Chat
  sendMessage: (payload: ChatRequestPayload) => Promise<ChatResponsePayload>;
  onStream: (callback: (event: StreamEvent) => void) => () => void;
  setSessionTimeline: (sessionId: string, timeline: SavedTimelineEntry[]) => Promise<void>;
  clearSessionTimeline: (sessionId: string) => Promise<void>;

  /* ── SQLite 单真源 timeline (, docs/design/SQLITE_TIMELINE_MIGRATION.md) ──
   * timeline:upsert-batch / timeline:page / timeline:delete-entry / timeline:count。
   * 行级 upsert 按 (session_id, entry_id) 幂等; 分页锚点用 SQLite rowid。 */
  timelineUpsertBatch: (sessionId: string, entries: SavedTimelineEntry[]) => Promise<{ ok: boolean; error?: string }>;
  timelinePage: (sessionId: string, opts?: { limit?: number; beforeRowId?: number }) => Promise<{
    ok: boolean;
    entries: SavedTimelineEntry[];
    /** 本页最旧一行的 rowid — 滚顶回捞的锚点; 无更多历史时为 null */
    oldestRowId: number | null;
    total: number;
    error?: string;
  }>;
  timelineDeleteEntry: (sessionId: string, entryId: string) => Promise<{ ok: boolean; error?: string }>;
  timelineCount: (sessionId: string) => Promise<{ ok: boolean; count: number; error?: string }>;
  /** 直打 DB 的清空 (不依赖内存 session.timeline 判空) */
  timelineClear: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  /** 迁移水位读写 (per-session + 总标记, 存 app_state) */
  timelineMigrationState: (op: 'get' | 'set', key: string) => Promise<{ ok: boolean; value?: string | null }>;
  /** 其它窗口写入同 session 时的失效通知 (多窗缓存一致性) */
  onTimelineChanged: (callback: (payload: { sessionId: string }) => void) => () => void;
  setSessionFileCheckpoints: (sessionId: string, rollbackId: string | null, reapplyId: string | null, fileRevertedMap?: Record<string, boolean>, fileConfirmedMap?: Record<string, boolean>) => Promise<void>;
  interruptSession: (sessionId: string) => Promise<void>;
  /** 暂停 session（安全点挂起） */
  pauseSession: (sessionId: string) => Promise<{ mainPaused: boolean; workersPaused: number }>;
  /** 恢复 session（从暂停点继续） */
  resumeSession: (sessionId: string) => Promise<{ mainResumed: boolean; workersResumed: number }>;
  /** 暂停单个 Worker 进程 */
  pauseProcess: (pid: string) => Promise<{ paused: boolean }>;
  /** 恢复单个 Worker 进程 */
  resumeProcess: (pid: string) => Promise<{ resumed: boolean }>;

  // Sessions
  getSessions: (workspacePath?: string) => Promise<Session[]>;
  /** 侧栏刷新专用：返回比 getSessions 更轻量的会话数据。
   *  可选；调用方在 preload 不提供此方法时回落到 getSessions。 */
  getSessionsLite?: (workspacePath?: string) => Promise<Session[]>;
  getSession: (sessionId: string) => Promise<Session | null>;
  createSession: (workspacePath: string, modelId: string, opts?: { kind?: 'chat' | 'image'; name?: string }) => Promise<Session>;
  deleteSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, name: string) => Promise<Session>;
  undoSession: (sessionId: string, count?: number) => Promise<Session>;
  checkpointSession: (sessionId: string, name?: string) => Promise<Session>;
  getSessionCheckpoints: (sessionId: string) => Promise<SessionCheckpointMeta[]>;
  rollbackSession: (sessionId: string, checkpointId: string) => Promise<Session>;
  clearSession: (sessionId: string) => Promise<Session>;
  compactSession: (sessionId: string) => Promise<Session>;

  // Menu events
  onMenuAction: (callback: (action: MenuAction) => void) => () => void;

  // Export
  exportSession: (sessionId: string, format: 'json' | 'md') => Promise<string | null>;

  // Assistant team control (scaffolded, optional until IPC is wired)
  createLeaderTeam?: (goal: string) => Promise<any>;
  leaderRecruitMember?: (teamId: string, payload: { role: string; task: string; providerId?: string; model?: string }) => Promise<any>;
  leaderRequestCapability?: (teamId: string, capability: string, reason: string) => Promise<any>;
  getStewardRuntimeSnapshot?: () => Promise<any>;

}
