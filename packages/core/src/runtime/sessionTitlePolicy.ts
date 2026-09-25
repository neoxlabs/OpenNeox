/** Session title reaggregation uses milestones at 6, 20, 60, then every 60 messages. */

/** 前段里程碑 (条数 = 会话里累计的 user 消息数) */
const EARLY_MILESTONES = [6, 20, 60] as const;

/** 60 条之后的固定步长 */
const LATE_STEP = 60;

/**
 * Returns the latest crossed milestone; the first-message title is handled separately.
 */
export function latestTitleMilestone(userMessageCount: number): number {
  if (!Number.isFinite(userMessageCount) || userMessageCount < EARLY_MILESTONES[0]) return 0;
  const count = Math.floor(userMessageCount);
  let latest = 0;
  for (const m of EARLY_MILESTONES) {
    if (count >= m) latest = m;
  }
  if (count >= LATE_STEP) {
    latest = Math.max(latest, Math.floor(count / LATE_STEP) * LATE_STEP);
  }
  return latest;
}

/**
 * 现在该不该重聚合标题?
 *
 * @param userMessageCount        会话里累计的 user 消息数 (含刚进来这条)
 * @param aggregatedFromCount     上一次标题是按多少条消息聚合出来的 (没聚合过给 0)
 *
 * Reaggregation occurs only when the persisted aggregate boundary advances.
 */
export function shouldReaggregateTitle(userMessageCount: number, aggregatedFromCount: number): boolean {
  const milestone = latestTitleMilestone(userMessageCount);
  if (milestone === 0) return false;
  return milestone > latestTitleMilestone(Math.max(0, aggregatedFromCount));
}

/**
 * 标题写回前的判定 (纯函数, 落库那侧调).
 * A changed expected title means the user owns the current name.
 */
export type TitleWriteDecision = 'write' | 'unchanged' | 'user_renamed';

export function decideTitleWrite(input: {
  /** Current persisted title. */
  currentName: string;
  /** Candidate title. */
  nextTitle: string;
  /** Previously persisted title used for optimistic locking. */
  expectedCurrentTitle?: string;
}): TitleWriteDecision {
  if (input.expectedCurrentTitle && input.currentName !== input.expectedCurrentTitle) {
    return 'user_renamed';
  }
  if (input.currentName === input.nextTitle) return 'unchanged';
  return 'write';
}

/** 重聚合送给模型的素材条数上限 —— 首条 + 最近这些条 */
export const TITLE_MATERIAL_RECENT_MESSAGES = 8;

/** 每条素材截断长度 —— 标题模型是小模型, 给整段贴进去只会让它抄一句原文 */
export const TITLE_MATERIAL_CHARS_PER_MESSAGE = 240;
