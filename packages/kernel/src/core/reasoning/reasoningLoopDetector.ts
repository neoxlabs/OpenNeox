/**
 * ReasoningLoopDetector — 检测纯文本 reasoning 死循环
 *
 * ToolCallDeduplicator 抓"同 (toolName, args) 反复调"; 本模块抓另一类死循环:
 * 模型**连续多轮输出文本但不调 tool** — 比如反复说 "我需要先理解任务..." /
 * "让我想想该怎么做..." / "嗯, 这个问题..." 然后没有任何工具行动. 这是国内
 * 模型 (尤其 reasoning 类) 高频死法之一: 想得太多但不动手, 烧光 turn.
 *
 * 跟 ToolCallDeduplicator 同模式:
 *   - 跨 step 检测同 reasoning content 连续 streak
 *   - 4 级 reminder 升级 (r1 streak>=3 / r2 >=5 / r3 >=8 / stop >=12)
 *   - 调用 recordToolCall() = 破环 (本轮有工具行动 = 有进展, streak 重置)
 *
 * 相似度判定:
 *   prefix hash — normalize 前 100 字符后 djb2 hash.
 *   模型死循环通常前几句一样 ("我需要先...", "好的, 让我..."), 用 prefix
 *   比 full text 更鲁棒 (措辞末尾轻微变化不绕过检测).
 *
 * 集成 (后续 wire 到 runner):
 *   - LLM step 结束后, 看 assistant message 是否有 tool_call:
 *     · 有 tool_call → detector.recordToolCall() — 破环
 *     · 无 tool_call (纯文本回复) → detector.checkAndRecord(text)
 *   - 拿 reminder → append 到模型下次能看到的位置 (sectionRegistry / system-reminder)
 *   - forceStop=true → runner 设 stop reason 'reasoning_loop_force_stop'
 */

// ============================================================================
// 阈值 (跟 ToolCallDeduplicator 同步, 保持心智一致)
// ============================================================================

export const REASONING_REMINDER_1_START = 3;
export const REASONING_REMINDER_2_START = 5;
export const REASONING_REMINDER_3_START = 8;
export const REASONING_FORCE_STOP_STREAK = 12;

// ============================================================================
// Reminder 文本 (zh)
// ============================================================================

const REMINDER_R1 = `

<system-reminder>
你连续几轮只在思考 / 回答文本, 没调用任何工具. 如果任务需要动手 (改文件 / 跑命令 / 查信息), 立刻调工具. 如果任务已完成 / 不需要工具, 直接给最终答案就好, 别再绕.
</system-reminder>`;

function buildReminderR2(streak: number): string {
  return `

<system-reminder>
检测到 reasoning 死循环:
- 连续 ${streak} 轮纯思考无任何工具行动
- 文本内容高度重复 — 你在原地打转

要么立即调工具推进任务, 要么直接给用户最终答案 (text-only 结束本轮). 不要再说 "我需要想想 / 让我先理解" 之类的话, 它们没产生进展.
</system-reminder>`;
}

const REMINDER_R3 = `

<system-reminder>
你陷入了 reasoning 死循环, 已经连续多轮空思考无任何动作.
立即停止: 你**这一轮回复必须**要么调用至少一个工具推进, 要么给用户一段**纯文本总结** (复盘当前问题 / 已尝试 / 卡在哪 / 需要什么决策). 不允许再用任何"让我思考"的开场.
</system-reminder>`;

// ============================================================================
// 类型
// ============================================================================

export interface ReasoningCheckResult {
  /** 当前 streak (相同 reasoning prefix 连续轮数, 含本轮). 1 = 首次, 不重复. */
  streak: number;
  /** 应该 append 的 reminder 文本. null = streak 太低不需要. */
  reminder: string | null;
  /** 触发级别 */
  level: 'none' | 'r1' | 'r2' | 'r3' | 'stop';
  /** 是否强停 turn (streak >= REASONING_FORCE_STOP_STREAK) */
  forceStop: boolean;
}

// ============================================================================
// 主类
// ============================================================================

export class ReasoningLoopDetector {
  private lastHash: string | null = null;
  private streak = 0;
  private stats = { r1: 0, r2: 0, r3: 0, stop: 0 };

  /**
   * 检查并记录一次"纯文本" LLM 回复 (无 tool_call).
   * 调用方应在 assistant message 没有 tool_call 时才调本方法.
   *
   * @returns 当前 streak + 建议的 reminder
   */
  checkAndRecord(textContent: string): ReasoningCheckResult {
    const hash = normalizeAndHashPrefix(textContent);

    if (hash === this.lastHash) {
      this.streak += 1;
    } else {
      this.lastHash = hash;
      this.streak = 1;
    }

    return this.buildResult(this.streak);
  }

  /**
   * 记录"本轮有 tool_call" → 破环, streak 重置.
   * 调用方在 assistant message 含 tool_call 时调.
   */
  recordToolCall(): void {
    this.lastHash = null;
    this.streak = 0;
  }

  /**
   * Peek 不修改 state.
   */
  peek(): { lastHash: string | null; streak: number } {
    return { lastHash: this.lastHash, streak: this.streak };
  }

  /** 重置 (新 task / /clear / /compact) */
  reset(): void {
    this.lastHash = null;
    this.streak = 0;
    this.stats = { r1: 0, r2: 0, r3: 0, stop: 0 };
  }

  /** 触发次数统计 */
  getStats(): Readonly<{ r1: number; r2: number; r3: number; stop: number }> {
    return { ...this.stats };
  }

  // --------------------------------------------------------------------------
  // 内部
  // --------------------------------------------------------------------------

  private buildResult(streak: number): ReasoningCheckResult {
    if (streak >= REASONING_FORCE_STOP_STREAK) {
      this.stats.stop += 1;
      return { streak, reminder: REMINDER_R3, level: 'stop', forceStop: true };
    }
    if (streak >= REASONING_REMINDER_3_START) {
      this.stats.r3 += 1;
      return { streak, reminder: REMINDER_R3, level: 'r3', forceStop: false };
    }
    if (streak >= REASONING_REMINDER_2_START) {
      this.stats.r2 += 1;
      return { streak, reminder: buildReminderR2(streak), level: 'r2', forceStop: false };
    }
    if (streak >= REASONING_REMINDER_1_START) {
      this.stats.r1 += 1;
      return { streak, reminder: REMINDER_R1, level: 'r1', forceStop: false };
    }
    return { streak, reminder: null, level: 'none', forceStop: false };
  }
}

// ============================================================================
// 内部 helpers
// ============================================================================

/**
 * Normalize text 后取**前 100 字符** djb2 hash.
 *
 * 设计:
 *   - 模型死循环时, **前几句通常完全一样** ("我需要先理解任务..." / "让我想想..."),
 *     用 prefix 比 full text hash 更鲁棒 (措辞末尾轻微变化不绕过)
 *   - normalize: trim + 合并所有连续空白成单空格 + lowercase + 去常见 markdown
 *     符号 (* # _ ` -). 这样 "**我** 需要思考" 跟 "我需要思考" 等价.
 *   - 100 字符约= 30-50 个英文词 / 50-100 个中文字, 足够辨识 reasoning 开头特征
 *
 * 注意空文本 / 超短文本:
 *   - 空 / <10 字 → hash 都很容易 collide. 调用方应在 reasoning 内容过短时
 *     跳过 detector (没意义的死循环检测 — 模型短回复可能是有效"明白了")
 *   - 我们 hash 仍正确返, 调用方 layer 决定是否调.
 */
function normalizeAndHashPrefix(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[*#_`~\-+>|]/g, '')   // 去 markdown 符号
    .replace(/\s+/g, '')             // 去掉所有空白 (空格/换行/tab) — 中文场景更鲁棒,
                                     // 英文场景可能误判 (Iamfine === I am fine) 但
                                     // reasoning 模式下英文短句死循环本就少见.
    .slice(0, 100);                   // 取前 100 字符
  return djb2Hash(normalized);
}

/** djb2 hash — 跟 toolCallDeduplicator 用同算法但本模块独立实现避免循环依赖 */
function djb2Hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h | 0;
  }
  return (h >>> 0).toString(36);
}

// ============================================================================
// 测试 export
// ============================================================================

export const __testing = {
  normalizeAndHashPrefix,
  djb2Hash,
  REMINDER_R1,
  REMINDER_R3,
  buildReminderR2,
};
