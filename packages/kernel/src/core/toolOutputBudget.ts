
export const READ_LIKE_BUDGET_MIN_CHARS = 12_000;
export const READ_LIKE_BUDGET_MAX_CHARS = 60_000;

/** 单条工具结果不超过窗口的这个比例 (tokens)。 */
const WINDOW_FRACTION = 0.025;
/** 代码 / JSON 的字符 → token 换算口径。 */
const CHARS_PER_TOKEN = 3;
/** 内核兜底上限 = 预算 × 这个系数 (工具自身已按预算排布, 这里只防失控)。 */
export const READ_LIKE_OVERSIZE_FACTOR = 1.2;

/**
 * 按模型 input context window 算 search / show_tree 的输出预算 (字符)。
 * 窗口未知 / 非法时返回保底的 12,000 —— 与改动前一致。
 */
export function readLikeBudgetChars(modelMaxInputTokens?: number): number {
  if (!modelMaxInputTokens || !Number.isFinite(modelMaxInputTokens) || modelMaxInputTokens <= 0) {
    return READ_LIKE_BUDGET_MIN_CHARS;
  }
  const chars = Math.floor(modelMaxInputTokens * WINDOW_FRACTION * CHARS_PER_TOKEN);
  return Math.max(READ_LIKE_BUDGET_MIN_CHARS, Math.min(READ_LIKE_BUDGET_MAX_CHARS, chars));
}
