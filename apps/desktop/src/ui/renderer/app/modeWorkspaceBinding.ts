
import { workspaceKey } from '../utils/pathUtils';

export type AgentModeValue = 'work' | 'code' | 'pilot';

/** 有独立 mode home 的模式 (~/Documents/Neox/工作 · 领航); code 用用户自己的项目根. */
export type HomedAgentMode = 'work' | 'pilot';

export function normalizeAgentMode(value: unknown): AgentModeValue {
  if (value === 'pilot') return 'pilot';
  return value === 'work' || value === 'assistant' ? 'work' : 'code';
}

/** 时间线呈现口径: Pilot 跟 Work 一样说人话 (mapTimeline 只认 work / code)。 */
export function presentationMode(mode: AgentModeValue): 'work' | 'code' {
  return mode === 'code' ? 'code' : 'work';
}

/** 该模式是否有自己的 mode home 目录 (决定要不要改绑工作区). */
export function hasModeHome(mode: AgentModeValue): mode is HomedAgentMode {
  return mode === 'work' || mode === 'pilot';
}

export interface EffectiveAgentModeInput {
  /** 当前 activeSession 的 agentMode (null/undefined = 老会话, 视为 code). */
  sessionAgentMode?: string | null;
  /** activeSession.kind —— 图片会话跟模式正交, 不参与判定 (与侧栏过滤口径一致). */
  sessionKind?: string | null;
  /** window.__neoxDefaultAgentMode —— 全局默认, 只在没有活跃会话时兜底. */
  ambientDefault?: string | null;
}

export function resolveEffectiveAgentMode(input: EffectiveAgentModeInput): AgentModeValue {
  const { sessionAgentMode, sessionKind, ambientDefault } = input;
  /* 图片会话跨模式, 不代表用户当前处在哪个模式 → 退回全局默认. */
  if (sessionKind !== 'image' && (sessionAgentMode === 'assistant' || sessionAgentMode === 'work' || sessionAgentMode === 'code' || sessionAgentMode === 'pilot')) {
    return normalizeAgentMode(sessionAgentMode);
  }
  return normalizeAgentMode(ambientDefault);
}

export interface NewSessionWorkspaceInput {
  /** resolveEffectiveAgentMode 的结果. */
  effectiveMode: AgentModeValue;
  /** 新会话的 kind —— 图片会话沿用当前工作区, 不进 mode home. */
  kind?: string;
  /** host shell 当前打开的工作区. */
  currentWorkspacePath: string;
  /** effectiveMode 对应的 mode home (调用方 ensureHome 后传入); code / 解析失败传 null. */
  modeHomePath: string | null;
}

/**
 * 新会话该 bake 哪个 workspacePath.
 *
 * Life/Work → 各自 mode home, 不跟当前打开的 code 项目混 (产物不写进代码库).
 * Code / image → 沿用当前工作区.
 */
export function resolveNewSessionWorkspace(input: NewSessionWorkspaceInput): string {
  const { effectiveMode, kind, currentWorkspacePath, modeHomePath } = input;
  if (kind === 'image') return currentWorkspacePath;
  if (!hasModeHome(effectiveMode)) return currentWorkspacePath;
  return modeHomePath || currentWorkspacePath;
}

export interface KeepActiveSessionInput {
  /** 当前 activeSession id, 无则 null. */
  activeSessionId: string | null;
  /** activeSession 已 bake 的 workspacePath (可能是切模式前的旧路径). */
  activeSessionWorkspacePath: string | null;
  /** 副作用 effect 看到的新 workspace.path. */
  nextWorkspacePath: string;
}

export function shouldKeepActiveSessionOnWorkspaceChange(input: KeepActiveSessionInput): boolean {
  const { activeSessionId, activeSessionWorkspacePath, nextWorkspacePath } = input;
  if (!activeSessionId) return false;
  if (!activeSessionWorkspacePath) return true;
  return workspaceKey(activeSessionWorkspacePath) === workspaceKey(nextWorkspacePath);
}

export function shouldApplyWorkspaceSideEffect(
  lastWorkspaceRef: { current: string | null },
  workspacePath: string,
  activeSessionId: string | null,
): boolean {
  /* 按 workspaceKey 比: `C:\Work\project` 和 `c:/work/project/` 是同一个工作区,
   * 原样比较会当成"切了工作区"把刚点中的会话清掉 */
  const workspaceChanged = lastWorkspaceRef.current === null
    || workspaceKey(lastWorkspaceRef.current) !== workspaceKey(workspacePath);
  lastWorkspaceRef.current = workspacePath;
  return workspaceChanged || !activeSessionId;
}

export function shouldSkipLastSessionRestore(input: {
  activeSessionId: string | null;
  /** 从 sessions 列表现查的活跃会话 workspacePath (不是 ref 里 baked 的那份) */
  activeSessionWorkspacePathFromList: string | null | undefined;
  nextWorkspacePath: string;
  /** 打算恢复成哪个会话 */
  restoreSessionId: string | null;
}): boolean {
  const { activeSessionId, activeSessionWorkspacePathFromList, nextWorkspacePath, restoreSessionId } = input;
  if (!activeSessionId) return false;
  if (restoreSessionId && restoreSessionId === activeSessionId) return true;
  if (!activeSessionWorkspacePathFromList) return false;
  return workspaceKey(activeSessionWorkspacePathFromList) === workspaceKey(nextWorkspacePath);
}

export function shouldKeepActiveSession(
  activeSessionId: string | null,
  sessions: ReadonlyArray<{ id: string; workspacePath?: string | null }>,
  nextWorkspacePath: string,
): boolean {
  try {
    if (window.localStorage.getItem('neox-pending-new-session') === '1') return true;
    if (window.localStorage.getItem('neox-pending-select-session')) return true;
  } catch { /* localStorage 不可用: 只看归属 */ }
  const live = activeSessionId ? sessions.find((s) => s.id === activeSessionId) : undefined;
  return shouldSkipLastSessionRestore({
    activeSessionId,
    activeSessionWorkspacePathFromList: live?.workspacePath,
    nextWorkspacePath,
    restoreSessionId: null,
  });
}

const CODE_WORKSPACE_KEY = 'ui:mode:code-workspace';

interface UiStateApi {
  uiStateGet?: (key: string) => Promise<unknown>;
  uiStateSet?: (key: string, value: unknown) => Promise<unknown>;
}

const uiState = (): UiStateApi => ((typeof window === 'undefined' ? {} : (window as unknown as { neox?: UiStateApi }).neox) ?? {});

/** 当前工作区是不是某个 mode home (那就不是"用户的项目", 不该被记成 code 工作区). */
export function isModeHomePath(path: string | null | undefined, modeHomes: (string | null | undefined)[]): boolean {
  if (!path) return false;
  const key = workspaceKey(path);
  return modeHomes.some((h) => h && workspaceKey(h) === key);
}

/** 离开 code 前记下当时的项目路径 (是 mode home 就不记). */
export async function rememberCodeWorkspace(path: string | null | undefined, modeHomes: (string | null | undefined)[]): Promise<void> {
  if (!path || isModeHomePath(path, modeHomes)) return;
  try { await uiState().uiStateSet?.(CODE_WORKSPACE_KEY, path); } catch { /* 记不住不阻塞切模式 */ }
}

/** 切回 code 时该还原到哪 —— 没记过 / 就是当前工作区 → null (什么都不做). */
export async function takeCodeWorkspace(
  currentPath: string | null | undefined,
  modeHomes: (string | null | undefined)[] = [],
): Promise<string | null> {
  let saved: unknown = null;
  try { saved = await uiState().uiStateGet?.(CODE_WORKSPACE_KEY); } catch { return null; }
  const path = typeof saved === 'string' ? saved : (saved as { value?: string } | null)?.value;
  if (!path || typeof path !== 'string') return null;
  if (isModeHomePath(path, modeHomes)) return null;
  if (currentPath && workspaceKey(currentPath) === workspaceKey(path)) return null;
  return path;
}

export async function fallbackCodeWorkspace(
  currentPath: string | null | undefined,
  modeHomes: (string | null | undefined)[],
): Promise<string | null> {
  if (!isModeHomePath(currentPath, modeHomes)) return null;
  const api = (typeof window === 'undefined'
    ? null
    : (window as unknown as { neox?: { getLastState?: (p?: string) => Promise<{ workspaces?: Array<{ path?: string }> }> } }).neox);
  if (!api?.getLastState) return null;
  try {
    const st = await api.getLastState();
    for (const ws of st?.workspaces ?? []) {
      const p = ws?.path;
      if (!p || typeof p !== 'string') continue;
      if (p.startsWith('__time__')) continue;          /* 旧侧栏时间桶伪键, 不是工作区 */
      if (isModeHomePath(p, modeHomes)) continue;      /* mode home 不是"项目" */
      return p;
    }
  } catch { /* 拿不到最近列表就停在原地 */ }
  return null;
}
