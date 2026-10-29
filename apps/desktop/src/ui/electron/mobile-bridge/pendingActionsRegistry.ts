/**
 * pendingActionsRegistry.ts — Mobile bridge transient pending-action truth.
 *
 * approval_needed / ask_user_needed are live blocking states, not drift messages.
 * If the phone leaves the timeline, reconnects, or re-subscribes after missing the
 * original stream event, session.subscribe needs a recoverable snapshot.
 */

export interface PendingApprovalAction {
  request_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  reason: string;
  allow_remember: boolean;
  scope_key?: string | null;
  risk?: unknown;
  turn_id?: string | null;
  created_at: number;
}

export interface PendingAskUserAction {
  request_id: string;
  questions: unknown[];
  turn_id?: string | null;
  created_at: number;
}

export interface PendingActionsSnapshot {
  approvals: PendingApprovalAction[];
  ask_user: PendingAskUserAction[];
}

const approvalsBySession = new Map<string, Map<string, PendingApprovalAction>>();
const askUsersBySession = new Map<string, Map<string, PendingAskUserAction>>();

function cloneApproval(a: PendingApprovalAction): PendingApprovalAction {
  return {
    ...a,
    args: { ...(a.args ?? {}) },
  };
}

function cloneAskUser(a: PendingAskUserAction): PendingAskUserAction {
  return {
    ...a,
    questions: Array.isArray(a.questions) ? [...a.questions] : [],
  };
}

function sessionMap<T>(
  root: Map<string, Map<string, T>>,
  sessionId: string,
): Map<string, T> {
  let m = root.get(sessionId);
  if (!m) {
    m = new Map<string, T>();
    root.set(sessionId, m);
  }
  return m;
}

export function recordApprovalNeeded(
  sessionId: string,
  action: Omit<PendingApprovalAction, 'created_at'> & { created_at?: number },
): void {
  if (!sessionId || !action.request_id) return;
  sessionMap(approvalsBySession, sessionId).set(action.request_id, {
    ...action,
    args: { ...(action.args ?? {}) },
    created_at: action.created_at ?? Date.now(),
  });
}

export function removeApproval(sessionId: string, requestId: string): void {
  const m = approvalsBySession.get(sessionId);
  if (!m) return;
  m.delete(requestId);
  if (m.size === 0) approvalsBySession.delete(sessionId);
}

export function recordAskUserNeeded(
  sessionId: string,
  action: Omit<PendingAskUserAction, 'created_at'> & { created_at?: number },
): void {
  if (!sessionId || !action.request_id) return;
  sessionMap(askUsersBySession, sessionId).set(action.request_id, {
    ...action,
    questions: Array.isArray(action.questions) ? [...action.questions] : [],
    created_at: action.created_at ?? Date.now(),
  });
}

export function removeAskUser(sessionId: string, requestId: string): void {
  const m = askUsersBySession.get(sessionId);
  if (!m) return;
  m.delete(requestId);
  if (m.size === 0) askUsersBySession.delete(sessionId);
}

/**
 * 按 requestId 撤掉某条 ask —— 调用方手里只有 requestId 时用。
 *
 * 桌面界面上回答 ask_user 只会带 requestId (sessionId 在 renderer 那侧),
 * 不该为了删一条快照再把它传上来。手机回答那条路径有 sessionId, 走 removeAskUser。
 */
export function removeAskUserByRequestId(requestId: string): void {
  if (!requestId) return;
  for (const [sessionId, m] of askUsersBySession) {
    if (!m.delete(requestId)) continue;
    if (m.size === 0) askUsersBySession.delete(sessionId);
    return;
  }
}

export function clearPendingActions(sessionId: string): void {
  approvalsBySession.delete(sessionId);
  askUsersBySession.delete(sessionId);
}

export function getPendingActions(sessionId: string): PendingActionsSnapshot {
  return {
    approvals: [...(approvalsBySession.get(sessionId)?.values() ?? [])].map(cloneApproval),
    ask_user: [...(askUsersBySession.get(sessionId)?.values() ?? [])].map(cloneAskUser),
  };
}

export function _clearAllPendingActionsForTest(): void {
  approvalsBySession.clear();
  askUsersBySession.clear();
}
