
export interface RecentFileEntry {
  name: string;
  path: string;
  /** 归属域: 本地 = workspacePath, 云会话 = `cloud:<sessionId>`。修复前存的条目没有这个字段 */
  ws?: string;
}

/**
 * 计算归属域。本地按工作区, 云会话按 pod —— 两边路径空间不同 (本机绝对路径 vs pod 内
 * 相对路径), 混在一起连去重都是错的。
 * @returns 空串表示**无法归属** (没有工作区 / 云会话缺 sessionId), 调用方应当一条都不给。
 */
export function recentScopeOf(opts: {
  isCloud: boolean;
  sessionId?: string | null;
  workspacePath?: string | null;
}): string {
  if (opts.isCloud) return opts.sessionId ? `cloud:${opts.sessionId}` : '';
  return opts.workspacePath || '';
}

/** 只保留属于当前域的条目 */
export function filterRecentByScope(entries: RecentFileEntry[], scope: string): RecentFileEntry[] {
  if (!scope) return [];
  return (entries || []).filter((r) => (
    r?.ws
      ? r.ws === scope
      /* 老条目没有 ws —— 只在路径确实落在本域里时才认。不做迁移: 它们本来就可能来自
       * 别的项目, 猜错的代价比少给几条大得多。 */
      : (!!r?.path && r.path.startsWith(`${scope}/`))
  ));
}
