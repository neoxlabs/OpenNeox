
import { sameWorkspace } from '../utils/pathUtils';

export interface BlankSessionCandidate {
  id: string;
  kind?: string | null;
  workspacePath?: string | null;
  /** 服务端给的消息数 —— 注意它会**陈旧** (见 isBlankSession) */
  messageCount?: number | null;
  messages?: unknown[] | null;
  timeline?: unknown[] | null;
}

export function isBlankSession(s: BlankSessionCandidate | null | undefined): boolean {
  if (!s) return false;
  return messageSignalCount(s) === 0;
}

export function messageSignalCount(s: BlankSessionCandidate | null | undefined): number {
  if (!s) return 0;
  return Math.max(s.messageCount ?? 0, s.messages?.length ?? 0, s.timeline?.length ?? 0);
}

export function shouldReuseBlankSession(input: {
  active: BlankSessionCandidate | null | undefined;
  /** 会话列表里的**权威**副本 —— 内存里那份 active 的计数会陈旧, 见下面的说明 */
  authoritative?: BlankSessionCandidate | null | undefined;
  /** createNewSession 的 opts.kind, 缺省即 chat */
  requestedKind?: string | null;
  /** 调用方指定了名字 = 想要一条特定的会话, 不复用 */
  requestedName?: string | null;
  /** 新会话将要落到的工作区 (已含模式解析结果) */
  targetWorkspace?: string | null;
}): boolean {
  const { active, authoritative, requestedKind, requestedName, targetWorkspace } = input;
  if (!active) return false;
  if (requestedName) return false;
  if (!isBlankSession(active)) return false;
  if (authoritative && !isBlankSession(authoritative)) return false;
  const kindOf = (k?: string | null) => k || 'chat';
  if (kindOf(active.kind) !== kindOf(requestedKind)) return false;
  /* 工作区未知时不复用 —— 宁可多开一条, 也不要把会话落错地方 */
  if (!targetWorkspace || !active.workspacePath) return false;
  return sameWorkspace(active.workspacePath, targetWorkspace);
}
