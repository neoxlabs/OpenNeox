import { useSyncExternalStore } from 'react';


export type ApprovalMode = 'auto' | 'manual' | 'dangerous';

/* fetch 期间的 render fallback — 与服务端 ApprovalModeResolver 默认值对齐. */
const FETCH_PENDING_DEFAULT: ApprovalMode = 'auto';
const GLOBAL_APPROVAL_SESSION_ID = '__neox_global_approval__';
const DANGEROUS_CONFIRMATION = {
  acknowledgeNoApproval: true,
  acknowledgeHighRiskExecution: true,
} as const;

/* 导出仅为可测 (见 __tests__/approvalMode.guard.test.ts) —— 这是挡住非法审批模式值
 * 落进 store / 落库的唯一闸门。漏一个脏值进来, 后续 mode 分支行为不可预期,
 * 而 'dangerous' 是**跳过全部审批**的模式, 判错方向直接是安全问题。 */
export const isApprovalMode = (v: unknown): v is ApprovalMode =>
  v === 'auto' || v === 'manual' || v === 'dangerous';

const modeBySession = new Map<string, ApprovalMode>();
const inflightFetch = new Set<string>();
const listeners = new Set<() => void>();
let globalDefaultMode: ApprovalMode = FETCH_PENDING_DEFAULT;
let globalModeLoaded = false;
let globalModeInflight: Promise<void> | null = null;

function emit(): void {
  for (const fn of listeners) {
    try { fn(); } catch (err) { console.error('[approvalModeStore] listener:', err); }
  }
}

function runtimeBridge(): {
  getApprovalMode?: (sessionId: string) => Promise<{ mode?: ApprovalMode }>;
  setApprovalMode?: (
    sessionId: string,
    mode: ApprovalMode,
    modelId?: string,
    options?: {
      scope?: 'global' | 'agent';
      scopeKey?: string;
      inherit?: boolean;
      dangerousConfirmation?: {
        acknowledgeNoApproval: true;
        acknowledgeHighRiskExecution: true;
      };
    },
  ) => Promise<void>;
  uiStateGet?: (key: string) => Promise<{ success?: boolean; value?: string | null }>;
  uiStateSet?: (key: string, value: string | null) => Promise<{ success?: boolean; error?: string }>;
} | null {
  if (typeof window === 'undefined') return null;
  return ((window as unknown as { neox?: any }).neox) ?? null;
}

export function dangerousOptions(
  extra?: { dangerousConfirmation?: { acknowledgeNoApproval: true; acknowledgeHighRiskExecution: true } },
): { dangerousConfirmation?: { acknowledgeNoApproval: true; acknowledgeHighRiskExecution: true } } {
  return extra?.dangerousConfirmation ? { dangerousConfirmation: extra.dangerousConfirmation } : {};
}

async function applyBackendGlobalMode(
  mode: ApprovalMode,
  extra?: { dangerousConfirmation?: { acknowledgeNoApproval: true; acknowledgeHighRiskExecution: true } },
): Promise<void> {
  const bridge = runtimeBridge();
  if (!bridge?.setApprovalMode) return;
  await bridge.setApprovalMode(GLOBAL_APPROVAL_SESSION_ID, mode, undefined, {
    scope: 'global',
    ...(mode === 'dangerous'
      ? { dangerousConfirmation: extra?.dangerousConfirmation ?? DANGEROUS_CONFIRMATION }
      : {}),
  });
}

async function ensureGlobalModeLoaded(): Promise<void> {
  if (globalModeLoaded) return;
  if (globalModeInflight) return globalModeInflight;
  globalModeInflight = (async () => {
    const bridge = runtimeBridge();
    try {
      const res = await bridge?.getApprovalMode?.(GLOBAL_APPROVAL_SESSION_ID);
      if (isApprovalMode(res?.mode) && globalDefaultMode !== res.mode) {
        globalDefaultMode = res.mode;
        emit();
      }
    } catch (err) {
      console.warn('[approvalModeStore] fetch backend global mode failed:', (err as { message?: string })?.message);
    }
    globalModeLoaded = true;
  })().finally(() => {
    globalModeInflight = null;
  });
  return globalModeInflight;
}

async function fetchModeFromBackend(sessionId: string): Promise<void> {
  if (inflightFetch.has(sessionId)) return;
  inflightFetch.add(sessionId);
  try {
    const bridge = runtimeBridge();
    if (!bridge?.getApprovalMode) return;
    const res = await bridge.getApprovalMode(sessionId);
    const mode = res?.mode;
    if (isApprovalMode(mode)) {
      const cur = modeBySession.get(sessionId);
      if (cur !== mode) {
        modeBySession.set(sessionId, mode);
        emit();
      }
    }
  } catch (err) {
    /* 拉值失败保留 in-memory 兜底 — 后端可能还没起或 session 还没注册.
     *   不重试, 用户切别的 session 再切回来会再 fetch 一次. */
    console.warn('[approvalModeStore] fetch mode failed:', (err as { message?: string })?.message);
  } finally {
    inflightFetch.delete(sessionId);
  }
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
};

/** React hook — 拿当前 sessionId 的审批模式.
 *  sessionId 为空时返回全局默认值; 有 session 时优先返回该 session 的服务端真值,
 *  没拉到前先用全局默认值兜底。 */
export function useApprovalMode(sessionId: string | null | undefined): ApprovalMode {
  const sid = sessionId ?? '';
  const getSnapshot = (): ApprovalMode => {
    if (!globalModeLoaded && !globalModeInflight) {
      void ensureGlobalModeLoaded();
    }
    if (!sid) return globalDefaultMode;
    if (!modeBySession.has(sid) && !inflightFetch.has(sid)) {
      /* 懒拉. useSyncExternalStore 不允许 getSnapshot 触发 emit (会死循环),
       *   这里 fetch 是异步的, 完成后才 emit, 所以安全. */
      void fetchModeFromBackend(sid);
    }
    return modeBySession.get(sid) ?? globalDefaultMode;
  };
  return useSyncExternalStore(subscribe, getSnapshot, () => globalDefaultMode);
}

/**
 * 切换审批模式: 永远先更新全局默认; 如果传了 sessionId, 再同步该 session 的 scoped mode。
 * 失败时不静默 — throw 给 ApprovalModeMenu, 上层弹 toast 让用户知道没设上。
 */
export async function setApprovalMode(
  sessionId: string | null | undefined,
  mode: ApprovalMode,
  modelId?: string,
  extra?: { dangerousConfirmation?: { acknowledgeNoApproval: true; acknowledgeHighRiskExecution: true } },
): Promise<void> {
  if (!isApprovalMode(mode)) {
    throw new Error(`Invalid approval mode: ${String(mode)}. Expected auto | manual | dangerous.`);
  }
  const bridge = runtimeBridge();
  if (!bridge) throw new Error('setApprovalMode: runtime bridge unavailable');

  /* 后端 global 路径会落 config —— 不再另存 ui_state 副本 */
  if (bridge.setApprovalMode) {
    await applyBackendGlobalMode(mode, extra);
  }

  const sid = sessionId ?? '';
  if (sid && bridge.setApprovalMode) {
    /* per-session: scope='agent' + scopeKey=sessionId; 服务端 setApprovalModeHandler 会
     * setScopedMode + 落盘 sessions.approval_mode. */
    await bridge.setApprovalMode(sid, mode, modelId, {
      scope: 'agent',
      scopeKey: sid,
      ...dangerousOptions(extra),
    });
  }

  const globalChanged = globalDefaultMode !== mode;
  globalDefaultMode = mode;
  globalModeLoaded = true;
  /* 后端改全局档时把所有会话的 per-session 值一起擦了 (approvalModeSetter), 这边缓存跟着清 */
  const sessionChanged = [...modeBySession.values()].some((m) => m !== mode);
  modeBySession.clear();
  if (sid) modeBySession.set(sid, mode);
  if (globalChanged || sessionChanged) emit();
}

export async function preloadApprovalModeDefault(): Promise<ApprovalMode> {
  await ensureGlobalModeLoaded();
  return globalDefaultMode;
}

export function getApprovalModeDefaultSnapshot(): ApprovalMode {
  if (!globalModeLoaded && !globalModeInflight) void ensureGlobalModeLoaded();
  return globalDefaultMode;
}

export async function resetDangerousApprovalDefaultOnLogout(): Promise<boolean> {
  const mode = await preloadApprovalModeDefault();
  if (mode !== 'dangerous') return false;
  await setApprovalMode(null, 'auto');
  return true;
}

export async function applyApprovalModeDefaultToSession(sessionId: string): Promise<void> {
  if (!sessionId) return;
  const mode = await preloadApprovalModeDefault();
  await setApprovalMode(sessionId, mode, undefined, mode === 'dangerous'
    ? { dangerousConfirmation: DANGEROUS_CONFIRMATION }
    : undefined);
}
