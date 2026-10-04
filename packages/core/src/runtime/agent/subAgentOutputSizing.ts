/**
 * Sub-agent output sizing — 防 K 个 explore 子 agent 同时返大 output 瞬间炸主 memory.
 *
 *  R4 创建. audit 报告: 6 个 explore 子 agent 同时返 8k chars 输出
 * → 主 agent memory 一次涨 ~48k chars (~12k tokens), 立即触发 prompt_too_long
 * → recovery compression 启动 → 丢失上下文。
 *
 * 设计:
 *   - 阈值默认 8000 chars (~2000 tokens), 通过 NEOX_AGENT_TOOL_MAX_OUTPUT_CHARS 覆盖
 *   - 超阈值时按 head/tail 截取, 中间用 "..." marker 替代
 *   - 在 output 末尾追加说明: "[output truncated, total X chars, showing N head + M tail]"
 *     让 LLM 知道有 truncate 发生, 可以 re-spawn 一个更聚焦的 explore 拿 detail
 *
 * 不用 LLM summary (那需要 extra call, 增加延迟 + cost; truncate + 提示 LLM 自决策更便宜)。
 */

const DEFAULT_MAX_OUTPUT_CHARS = 8000;
const HEAD_RATIO = 0.6;  // head 占 60%, tail 占 40% (前面更重要)
/* 环境变量覆盖也受硬上限约束，避免多 agent 并发时通过异常配置绕过输出裁剪并放大内存占用。 */
const MAX_OUTPUT_CHARS_CAP = 100_000;

function getLimit(): number {
  const env = Number(process.env.NEOX_AGENT_TOOL_MAX_OUTPUT_CHARS);
  if (Number.isFinite(env) && env >= 1000) return Math.min(MAX_OUTPUT_CHARS_CAP, Math.floor(env));
  return DEFAULT_MAX_OUTPUT_CHARS;
}

export interface SizingResult {
  output: string;
  truncated: boolean;
  originalLength: number;
}

/**
 * 输入是子 agent 完整 output, 输出是可能被 head/tail 裁过的 output + 元数据.
 * 不截 < limit 的输出; 截过的会自动加 "[output truncated]" 尾标注。
 */
export function sizeSubAgentOutput(
  output: string,
  opts?: { limit?: number; agentRole?: string },
): SizingResult {
  const text = output ?? '';
  const len = text.length;
  const limit = opts?.limit ?? getLimit();

  if (len <= limit) {
    return { output: text, truncated: false, originalLength: len };
  }

  const headBudget = Math.floor(limit * HEAD_RATIO);
  const tailBudget = limit - headBudget;
  /* audit P2: 用 Array.from 走字符迭代器 — String.slice 在 UTF-16 code unit 切割,
     会把中文/emoji 的代理对 (high surrogate + low surrogate) 切成两半, 显示乱码。
     Array.from 的迭代器尊重 USV (Unicode Scalar Value), 切口永远在合法字符之间。 */
  const chars = Array.from(text);
  const head = chars.slice(0, headBudget).join('');
  const tail = chars.slice(-tailBudget).join('');

  /* 拼接时尽量在自然分界 (换行) 处切, 避免在 token 中间断 */
  const headTrimmed = head.replace(/[^\n]*$/, ''); // 退到最近的 \n
  const tailTrimmed = tail.replace(/^[^\n]*/, ''); // 跳到下一个 \n
  const effectiveHead = headTrimmed.length > headBudget * 0.5 ? headTrimmed : head;
  const effectiveTail = tailTrimmed.length > tailBudget * 0.5 ? tailTrimmed : tail;

  const skippedChars = len - effectiveHead.length - effectiveTail.length;
  /* audit P2: agentRole 可能是 undefined / 空字符串 — 兜底 "sub-agent" 避免
     输出含 "undefined sub-agent" 让 LLM 困惑。 */
  const safeRole = opts?.agentRole?.trim() || 'sub-agent';
  const note = `\n\n[...output truncated for ${safeRole} — skipped ${skippedChars} chars from middle. Total ${len} chars. If you need the missing region, re-spawn a focused sub-agent with a narrower question.]\n\n`;

  return {
    output: effectiveHead + note + effectiveTail,
    truncated: true,
    originalLength: len,
  };
}
