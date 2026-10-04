/**
 * TeamBlackboard — 共享黑板简版 (Team P2, TEAM_MODE_DESIGN §3.3)
 *
 * 原则: 传引用不传全文 — 条目只带 ref (worktree 分支 / 文件路径 / diff 引用) + ≤500 字摘要,
 * 下游按需自己读文件, 不在消息里搬运全文 (省 token, 防上下文爆炸)。
 *
 * 写协调: Conductor (team_run 工具本体) 是唯一写入方 — lane 完成时由工具代为落板
 * (kind:'result'), 成员自己经 report_to_conductor 上报的内容由 Conductor 决定是否落板,
 * 避免并发写冲突。
 *
 * 生命周期: 内存 Map<teamId, entries[]> 支撑运行中的追加/查询;
 * 团队结束时整体序列化落 team_sessions.blackboard (platform/database)。
 */

/** 黑板条目 — 与 team_blackboard_post 事件的 entry 字段严格一致 */
export interface TeamBlackboardEntry {
  key: string;
  kind: 'result' | 'note' | 'blocker';
  /** 引用: worktree 分支名 / 文件路径 / 改动摘要定位符 — 不放全文 */
  ref?: string;
  /** ≤500 字摘要 (超长自动截断) */
  summary: string;
  /** 作者: laneId (=agentId) 或 'conductor' */
  author: string;
  ts: number;
}

const SUMMARY_MAX_CHARS = 500;
/** 单团条目上限 — 防跑飞 lane 刷爆内存 (正常团队 ≤4 lane × 数条) */
const ENTRIES_CAP = 200;

export class TeamBlackboard {
  private boards = new Map<string, TeamBlackboardEntry[]>();

  /**
   * 追加一条黑板条目 (summary 超长自动截到 500 字)。
   * 返回归一化后的条目 — 调用方直接拿它发 team_blackboard_post 事件, 保证事件与板上内容一致。
   */
  post(teamId: string, entry: Omit<TeamBlackboardEntry, 'ts'> & { ts?: number }): TeamBlackboardEntry {
    const normalized: TeamBlackboardEntry = {
      key: entry.key,
      kind: entry.kind,
      ref: entry.ref,
      summary: truncateSummary(entry.summary),
      author: entry.author,
      ts: entry.ts ?? Date.now(),
    };
    let entries = this.boards.get(teamId);
    if (!entries) {
      entries = [];
      this.boards.set(teamId, entries);
    }
    if (entries.length < ENTRIES_CAP) {
      entries.push(normalized);
    }
    return normalized;
  }

  /** 当前板上全部条目 (快照拷贝) */
  list(teamId: string): TeamBlackboardEntry[] {
    return [...(this.boards.get(teamId) ?? [])];
  }

  /** 整板序列化 — 落 team_sessions.blackboard 用 */
  serialize(teamId: string): string {
    return JSON.stringify(this.list(teamId));
  }

  /** 团队结束后释放内存 (落盘后调用) */
  dispose(teamId: string): void {
    this.boards.delete(teamId);
  }
}

function truncateSummary(s: string): string {
  const text = String(s ?? '').trim();
  if (text.length <= SUMMARY_MAX_CHARS) return text;
  const chars = Array.from(text);
  if (chars.length <= SUMMARY_MAX_CHARS) return text;
  return chars.slice(0, SUMMARY_MAX_CHARS - 1).join('') + '…';
}

/** blackboard JSON (team_sessions.blackboard 列) → 条目数组; 损坏/空返回 [] */
export function parseBlackboardJson(json: string | null | undefined): TeamBlackboardEntry[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
