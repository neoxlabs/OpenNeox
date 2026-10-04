/**
 * ToolCallDeduplicator — 检测与处理 tool call 重复调用 (anti-死循环)
 *
 * 行为: 只做 cross-step 检测 — 连续两次 LLM step 调同 (toolName, args) 累计 streak.
 * (same-step 同 (name, args) 由 parallelExecutor 处理, 不在本模块管.)
 * reminder 文本直接 append 到 tool result, 模型下一轮看到 (跟 ErrorPatternMemory.hint 同路径).
 * 与 runtime/systemReminder.ts 解耦 — dedup reminder 是 tool-result 局部, 不走全局 reminder 通道.
 *
 * 集成时机:
 *   - 每个 tool call 执行前, 调 checkAndRecord(toolName, args)
 *   - 拿返回的 reminder 文本, append 到 tool result output
 *   - forceStop=true 时, runner 设 stop reason 不再继续下一 step
 *
 * 触发阈值:
 *   - streak >= 3:  r1 温和提示
 *   - streak >= 5:  r2 具体重复报告 (含 tool name / count / args)
 *   - streak >= 8:  r3 强制 dead-end 指令 (要求 agent text-only summary 报告用户)
 *   - streak >= 12: forceStop=true, runner 应停 turn
 */

// ============================================================================
// 阈值常量
// ============================================================================

export const REPEAT_REMINDER_1_START = 3;
export const REPEAT_REMINDER_2_START = 5;
export const REPEAT_REMINDER_3_START = 8;
export const REPEAT_FORCE_STOP_STREAK = 12;

// ============================================================================
// Reminder 文本 (zh — Neox 默认中文; en 留 TODO 后续 i18n)
// ============================================================================

const REMINDER_R1 = `

<system-reminder>
你正在用完全相同的参数重复同一个 tool call. 请仔细分析上一次结果. 如果任务还没完成,
换一种方法或参数, 不要重复同一调用.
</system-reminder>`;

function buildReminderR2(toolName: string, repeatCount: number, args: unknown): string {
  const argsStr = canonicalArgs(args);
  return `

<system-reminder>
检测到 tool call 多次重复:
- tool: ${toolName}
- 重复次数: ${repeatCount}
- arguments: ${argsStr}

前几次重复调用没有取得任何进展. 不要再用完全相同的参数调用这个工具.
仔细看最新的 tool result, 选择一个不同的下一步动作 / 不同的参数 / 或者证据足够时直接结束任务.
</system-reminder>`;
}

const REMINDER_R3 = `

<system-reminder>
你陷入了死循环, 反复发同一个 function call 但毫无进展.
立即停止所有 function call. 你下一轮回复不要调用任何工具.
在思考时复盘当前执行状态, 找出进展为何受阻.
然后给用户一段**纯文本总结**: 当前遇到什么问题, 已经试了什么, 现在需要什么信息或决策.
</system-reminder>`;

// ============================================================================
// API
// ============================================================================

export interface DedupCheckResult {
  /** Current consecutive count for the same tool-and-arguments key. */
  streak: number;
  /** 应该 append 到 tool result 的 reminder 文本. null = streak 太低不需要 reminder. */
  reminder: string | null;
  /** 触发级别. 'none' = 无重复 / streak<3; 'r1' / 'r2' / 'r3' = 升级 reminder; 'stop' = 应强停 turn. */
  level: 'none' | 'r1' | 'r2' | 'r3' | 'stop';
  /** 是否建议 runner 强制停 turn (streak >= REPEAT_FORCE_STOP_STREAK). */
  forceStop: boolean;
}

export class ToolCallDeduplicator {
  private lastKey: string | null = null;
  private streak = 0;
  /** dedup 触发次数统计 (调试 / 监控用) */
  private stats = { r1: 0, r2: 0, r3: 0, stop: 0 };

  /**
   * 检查并记录一次 tool call. **在 tool 即将执行前调用一次.**
   *
   * 内部更新 streak:
   *   - 相同 (toolName, args) 连续调用 → streak +1
   *   - 不同 → streak 重置为 1
   *
   * 返回当前状态 + 建议的 reminder (调用方 append 到 tool result output 即可).
   */
  checkAndRecord(toolName: string, args: unknown): DedupCheckResult {
    const key = makeKey(toolName, args);

    if (key === this.lastKey) {
      this.streak += 1;
    } else {
      this.lastKey = key;
      this.streak = 1;
    }

    return this.buildResult(toolName, args, this.streak);
  }

  /**
   * Peek 当前 streak, 不更新 state. 调试用.
   */
  peek(): { lastKey: string | null; streak: number } {
    return { lastKey: this.lastKey, streak: this.streak };
  }

  /**
   * 重置 (新 task / /clear / /compact 时调).
   */
  reset(): void {
    this.lastKey = null;
    this.streak = 0;
    this.stats = { r1: 0, r2: 0, r3: 0, stop: 0 };
  }

  /**
   * 触发次数统计 (监控用).
   */
  getStats(): Readonly<{ r1: number; r2: number; r3: number; stop: number }> {
    return { ...this.stats };
  }

  // --------------------------------------------------------------------------
  // 内部
  // --------------------------------------------------------------------------

  private buildResult(toolName: string, args: unknown, streak: number): DedupCheckResult {
    if (streak >= REPEAT_FORCE_STOP_STREAK) {
      this.stats.stop += 1;
      return { streak, reminder: REMINDER_R3, level: 'stop', forceStop: true };
    }
    if (streak >= REPEAT_REMINDER_3_START) {
      this.stats.r3 += 1;
      return { streak, reminder: REMINDER_R3, level: 'r3', forceStop: false };
    }
    if (streak >= REPEAT_REMINDER_2_START) {
      this.stats.r2 += 1;
      return { streak, reminder: buildReminderR2(toolName, streak, args), level: 'r2', forceStop: false };
    }
    if (streak >= REPEAT_REMINDER_1_START) {
      this.stats.r1 += 1;
      return { streak, reminder: REMINDER_R1, level: 'r1', forceStop: false };
    }
    return { streak, reminder: null, level: 'none', forceStop: false };
  }
}

// ============================================================================
// 辅助
// ============================================================================

/**
 * 生成 dedup key. toolName 和 canonical 化后的 args 字符串拼接.
 *
 * 注: 不做严格 canonical (key 顺序 / 数值精度等). 因为 LLM 同 prompt 同步生成的 args
 * 通常字面相同, 偶尔 key 顺序不一致只是错过一次 dedup, 不会误判. 如果未来需要更严格
 * 检测, 可以在此函数升级 (例: 递归 sort object keys 后 JSON.stringify).
 */
function makeKey(toolName: string, args: unknown): string {
  return `${toolName}::${canonicalArgs(args)}`;
}

/**
 * 把 args 转成一个稳定的字符串表示. 已经是 string 时直接返回; object 用 JSON.stringify.
 * 失败时 fallback 到 String(args).
 */
function canonicalArgs(args: unknown): string {
  if (typeof args === 'string') return args;
  if (args === null || args === undefined) return '';
  try {
    return JSON.stringify(args);
  } catch {
    /* circular ref / non-serializable — fallback */
    return String(args);
  }
}

// ============================================================================
// 测试 export (testing only, 不进 production API surface)
// ============================================================================

export const __testing = {
  makeKey,
  canonicalArgs,
  REMINDER_R1,
  REMINDER_R3,
  buildReminderR2,
};
