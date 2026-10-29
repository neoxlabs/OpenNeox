import { createHash } from 'node:crypto';

/** 触发阈值: 同一签名第 3 次出现就停下问用户 */
export const REPEATED_TEST_FAILURE_THRESHOLD = 3;

/** 只看这些工具 —— 别的工具失败有各自的机制 (edit 走 ErrorPatternMemory) */
const TEST_TOOL_NAMES = new Set(['run_tests', 'execute_shell', 'bash', 'shell', 'run_command']);

/** 看起来像"跑了测试"的命令 —— execute_shell 也常被用来跑测试 */
const TEST_COMMAND_RE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|t)\b|\b(pytest|vitest|jest|go\s+test|cargo\s+test|mvn\s+test|gradle(w)?\s+test|flutter\s+test|dart\s+test|phpunit)\b/i;

export interface RepeatedTestFailureResult {
  /** 该签名累计出现过几次 (含本次) */
  streak: number;
  /** 归一化后的签名 (诊断/日志用, 不含原文) */
  signature: string;
  /** 是否应当停下问用户 */
  shouldAskUser: boolean;
  /** 要 append 到 tool result 的提醒; 没到阈值 = null */
  reminder: string | null;
}

/** 一次失败的测试运行是否值得计入签名 */
export function isTestFailure(toolName: string, command: string | undefined, success: boolean, output: string): boolean {
  if (success) return false;
  const name = (toolName || '').toLowerCase();
  if (!TEST_TOOL_NAMES.has(name)) return false;
  if (name === 'run_tests') return true;
  /* execute_shell 之类: 命令得真的是跑测试, 否则普通命令失败也会被当成"同一测试失败" */
  if (command && TEST_COMMAND_RE.test(command)) return true;
  return /FAIL\b|failed|assert|Error:/i.test(output) && /test/i.test(output);
}

/** 逐行抽取失败标识 (未归一化) */
function failureLines(output: string): string[] {
  const lines = output.split('\n');
  const picked: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (
      /^FAIL\b/.test(line) ||
      /^×\s/.test(line) ||
      /^●\s/.test(line) ||
      /^FAILED\s/.test(line) ||
      /^---\s*FAIL:/.test(line) ||
      /^----\s.+stdout\s----/.test(line) ||
      /\berror TS\d+/.test(line) ||
      /\berror\b.*\b(expected|assert)/i.test(line) ||
      /^AssertionError\b/.test(line)
    ) {
      picked.push(line);
      if (picked.length >= 8) break;   // 失败很多时只看前 8 条, 防止签名随数量漂移
    }
  }
  if (picked.length > 0) return picked;
  /* 抽不到 → 退回最后一条非空行 (堆栈尾/超时信息都在那) */
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  return nonEmpty.length > 0 ? [nonEmpty[nonEmpty.length - 1]] : ['<empty>'];
}

/**
 * 归一化: 抹掉每次都会变的部分。
 * 顺序有讲究 —— 先去路径前缀再抹数字, 否则 `/a/b/c.ts:12:3` 会被抹成 `/a/b/c.ts::`。
 */
export function normalizeFailureLine(line: string): string {
  let s = line;
  s = s.replace(/\([0-9]+(?:\.\d+)?\s*m?s\)/g, '');            // (0.00s) / (123ms)
  s = s.replace(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/g, '');          // 12ms / 3.4s
  s = s.replace(/\b0x[0-9a-f]+\b/gi, '<addr>');                // 内存地址
  s = s.replace(/[A-Za-z]:\\[^\s:]+/g, '<path>');              // Windows 绝对路径
  s = s.replace(/(?:\/[\w.@-]+){2,}\/[\w.@-]+/g, '<path>');    // POSIX 绝对路径
  s = s.replace(/:\d+:\d+\b/g, '');                            // :12:3
  s = s.replace(/:\d+\b/g, '');                                // :12
  s = s.replace(/line \d+/gi, 'line <n>');
  s = s.replace(/\b\d+\b/g, '<n>');                            // 其它数字 (期望值/数量)
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** 由输出算签名 (测试可直接调) */
export function computeFailureSignature(output: string): string {
  const normalized = failureLines(output)
    .map(normalizeFailureLine)
    .filter(Boolean)
    .sort();                                                    // 顺序不该影响"是不是同一个错"
  return createHash('sha1').update(normalized.join('\n')).digest('hex').slice(0, 16);
}

function buildReminder(streak: number, signature: string): string {
  return `

<system-reminder>
同一个测试失败已经第 ${streak} 次出现了 (签名 ${signature})。前几次修改都没有解决它 —— 继续用同样的思路重试只会继续烧时间。

现在停下来, 用 ask_user 工具问用户, 不要再改代码、不要再重跑测试:
- 一句话说明是哪个测试 / 哪条断言在失败 (贴上最关键的那行错误原文)
- 说明你已经试过哪几种改法, 为什么它们都不成立
- 给出你判断需要用户拍板的具体问题 (比如: 是实现有问题, 还是这条测试的期望本身过时了?)

用户答复之后再继续。
</system-reminder>`;
}

/**
 * 计数器。作用域 = 一次 run (runner 每轮 reset), 不跨会话 —— 跨会话的"同一个错"
 * 没有意义 (中间可能已经换了代码)。
 */
export class RepeatedTestFailureDetector {
  private counts = new Map<string, { n: number; lastAt: number }>();

  reset(): void {
    this.counts.clear();
  }

  /**
   * 记录一次测试类工具的结果。
   * @returns 非测试类工具 / 成功 → null
   */
  record(params: {
    toolName: string;
    success: boolean;
    output: string;
    /** 模型传的命令 (execute_shell 的 command / run_tests 的 command) */
    command?: string;
    now?: number;
  }): RepeatedTestFailureResult | null {
    if (!isTestFailure(params.toolName, params.command, params.success, params.output)) return null;

    const now = params.now ?? Date.now();
    const signature = computeFailureSignature(params.output);
    const prev = this.counts.get(signature);
    /* 超出窗口的旧记录不算 —— 两小时前同一个错不该让今天的第一次失败直接停下问 */
    const n = prev && now - prev.lastAt <= STALE_WINDOW_MS ? prev.n + 1 : 1;
    this.counts.set(signature, { n, lastAt: now });

    const shouldAskUser = n >= REPEATED_TEST_FAILURE_THRESHOLD;
    return {
      streak: n,
      signature,
      shouldAskUser,
      reminder: shouldAskUser ? buildReminder(n, signature) : null,
    };
  }
}

/** 计数保留窗口 —— 超过这个时间的同签名记录不再累计 */
const STALE_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * 进程级单例 —— 让接线方 (prepareToolResultForMemory) 不必自己持有实例。
 * 跨 run 累计是对的: 用户重开一轮后还是同一个错, 同样该停下问。窗口只防陈旧误报。
 */
export const globalTestFailureDetector = new RepeatedTestFailureDetector();
