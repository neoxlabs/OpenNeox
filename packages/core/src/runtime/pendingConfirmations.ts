/*
 * pendingConfirmations —— 正在等用户点头的事 (pilot:H-08 的「等待确认」那一半)。
 *
 * 审批 / ask_user 的等待态原本只存在于各宿主的局部变量里 (本地 server 的
 * SessionWaitingRegistry、云端 bridge 的 pendingApprovals)。这一层把它们按 session
 * 登记成进程级的小账本, 让每轮拼提示词时能说一句「还有一件事在等你确认」——
 * 用户隔了一阵回来说「继续」时, 模型不会忘记那件卡住的事。
 *
 * 只活在内存里: 等待项本来就绑着一次 in-flight turn, 进程没了它也无效了。
 */

export type PendingConfirmationKind = 'approval' | 'user';

export interface PendingConfirmationInput {
  id: string;
  kind: PendingConfirmationKind;
  /** 工具名 (approval) / 不填 (user 追问) */
  toolName?: string;
  /** 直接给一句人话标题; 给了就不再按工具名拼 */
  title?: string;
  since?: number;
}

export interface PendingConfirmation {
  id: string;
  kind: PendingConfirmationKind;
  toolName?: string;
  title?: string;
  since: number;
}

/** 同一会话最多记这么多条 —— 正常不会超过两三条, 多余的是泄漏。 */
const MAX_PER_SESSION = 5;
/** 超过这么久还在的等待项已无意义 (审批 TTL 最多 30 分钟)。 */
const MAX_AGE_MS = 60 * 60_000;
const MAX_SESSIONS = 500;

const bySession = new Map<string, Map<string, PendingConfirmation>>();

/** 登记一个等待项。同 id 重复登记是幂等的。 */
export function registerPendingConfirmation(
  sessionId: string,
  input: PendingConfirmationInput,
): void {
  if (!sessionId || !input?.id) return;
  if (input.kind !== 'approval' && input.kind !== 'user') return;
  let items = bySession.get(sessionId);
  if (!items) {
    items = new Map();
    bySession.set(sessionId, items);
  }
  items.set(input.id, {
    id: input.id,
    kind: input.kind,
    toolName: input.toolName,
    title: input.title,
    since: typeof input.since === 'number' && input.since > 0 ? input.since : Date.now(),
  });
  while (items.size > MAX_PER_SESSION) {
    const oldest = items.keys().next();
    if (oldest.done) break;
    items.delete(oldest.value);
  }
  trimSessions();
}

/** 用户点了 / 超时 / 会话收尾 — 注销。不存在时安静返回。 */
export function resolvePendingConfirmation(sessionId: string, id: string): void {
  const items = bySession.get(sessionId);
  if (!items) return;
  items.delete(id);
  if (items.size === 0) bySession.delete(sessionId);
}

/** 整条会话清账 (轮结束时宿主已经清过等待态)。 */
export function clearPendingConfirmations(sessionId: string): void {
  if (sessionId) bySession.delete(sessionId);
}

/** 读当前等待项; 过期的不再返回 (顺手清掉)。按登记顺序。 */
export function listPendingConfirmations(
  sessionId: string,
  now: number = Date.now(),
): PendingConfirmation[] {
  const items = bySession.get(sessionId);
  if (!items) return [];
  const fresh: PendingConfirmation[] = [];
  for (const [id, item] of items) {
    if (now - item.since > MAX_AGE_MS) {
      items.delete(id);
      continue;
    }
    fresh.push(item);
  }
  if (items.size === 0) bySession.delete(sessionId);
  return fresh;
}

/** 仅测试用。 */
export function __resetPendingConfirmationsForTesting(): void {
  bySession.clear();
}

function trimSessions(): void {
  while (bySession.size > MAX_SESSIONS) {
    const oldest = bySession.keys().next();
    if (oldest.done) break;
    bySession.delete(oldest.value);
  }
}
