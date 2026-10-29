
export const PERSIST_PENDING_ACROSS_TURN: ReadonlySet<string> = new Set(['ask_user']);

export function isBackgroundDelegation(entry: {
  type?: string;
  delegationIsBackground?: boolean;
}): boolean {
  return entry?.type === 'agent_delegation' && entry?.delegationIsBackground === true;
}

/**
 * 这条 entry 该不该被轮结束的兜底扫尾收敛掉。
 *
 * 注意语义: 返回 true 只表示"兜底该管它", 不代表前面按 type 定制处理的分支没管过 ——
 * 定制分支自己 `continue` 掉了, 走到兜底的都是没人管的漏网条目。
 */
export function shouldSettlePendingAtTurnEnd(entry: {
  type?: string;
  pending?: boolean;
  delegationIsBackground?: boolean;
}): boolean {
  if (entry?.pending !== true) return false;
  const type = entry.type ?? '';
  if (PERSIST_PENDING_ACROSS_TURN.has(type)) return false;
  if (isBackgroundDelegation(entry)) return false;
  return true;
}
