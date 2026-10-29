/**
 * 回执里的「验证」一行 (code:VERIFY-15)。
 *
 * 用户默认以为"它说完成了 = 验过了"。提示词里已经要求改完跑测试、验不了要说明,
 * 但模型漏写时用户仍然分不清。这里按本轮**真实记账**补一行, 措辞尽量短:
 *
 *   验证：已跑（run_tests）
 *   验证：未跑（本轮改了 2 处文件，收尾前没有运行任何验证命令）
 *
 * 只在模型自己没写这一行时补 —— 模型写了就用它的措辞 (总控裁决: 照实写, 不套模板)。
 * 纯问答 / 只读轮次 (没改过文件) 不补, 那是噪音。
 */

export type ReceiptLanguage = 'zh' | 'en';

export interface VerifyReceiptState {
  /** 本 run 内成功的 mutation 工具次数 (runner.runMutationCount) */
  mutationCount: number;
  /** 本 run 内成功跑过的验证类工具名 (run_tests / run_lint), 按执行顺序 */
  verifyTools: readonly string[];
}

/** 模型已经写过验证行 (中英文、带不带"状态"都认) —— 有就别再补一遍。
 *  也认小标题写法 (「**验证**」「### 验证」单独一行, 下一行才是内容): 10-21 模型写了
 *  「验证 / npm test → 3 个全过」, 因为没有冒号没认出来, 又补了一句矛盾的「验证：未跑」。 */
const RECEIPT_LINE_RE = /(^|\n)[ \t]*(#{1,6}[ \t]*|\*\*)?(验证状态|验证|驗證|verification(\s+status)?)(\*\*)?[ \t]*([:：]|\r?\n)/i;

/** 用 shell 跑的常见测试 / 检查命令 */
const SHELL_VERIFY_RE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|type-check)\b|\bnode\s+--test\b|\b(pytest|vitest|jest|mocha)\b|\bgo\s+test\b|\bcargo\s+(test|check|clippy)\b|\bmake\s+(test|check)\b|\btsc\b[^"\n]*--noEmit|\beslint\b|\bruff\s+check\b|\bmvn\s+test\b|\bgradle\w*\s+test\b/i;
const SHELL_TOOLS = new Set(['execute_shell', 'bash', 'shell', 'run_command', 'Bash']);

export function isVerifyToolName(name: string, callText?: string): boolean {
  if (name === 'run_tests' || name === 'run_lint') return true;
  return SHELL_TOOLS.has(name) && !!callText && SHELL_VERIFY_RE.test(callText);
}

export function hasVerifyReceiptLine(text: string): boolean {
  return RECEIPT_LINE_RE.test(text || '');
}

/**
 * 本轮该补的验证行。没改过文件 → null (无验证可言, 不制造噪音)。
 */
export function buildVerifyReceiptLine(
  state: VerifyReceiptState,
  language: ReceiptLanguage = 'zh',
): string | null {
  if (!Number.isFinite(state.mutationCount) || state.mutationCount <= 0) return null;
  const tools = state.verifyTools.filter((t) => typeof t === 'string' && t.trim().length > 0);
  if (tools.length > 0) {
    const list = Array.from(new Set(tools)).join(' / ');
    return language === 'en'
      ? `Verification: ran (${list})`
      : `验证：已跑（${list}）`;
  }
  return language === 'en'
    ? `Verification: not run (${state.mutationCount} file change(s) this turn, no verification command was run before finishing)`
    : `验证：未跑（本轮改了 ${state.mutationCount} 处文件，收尾前没有运行任何验证命令）`;
}

/**
 * 需要补时返回追加后的正文, 否则原样返回 (含"模型已写过"和"没改过文件"两种情况)。
 */
export function ensureVerifyReceiptLine(
  text: string,
  state: VerifyReceiptState,
  language: ReceiptLanguage = 'zh',
): string {
  const body = text || '';
  if (!body.trim()) return body;
  if (hasVerifyReceiptLine(body)) return body;
  const line = buildVerifyReceiptLine(state, language);
  if (!line) return body;
  return `${body.replace(/\s+$/, '')}\n\n${line}`;
}

/** 本 run 的验证工具记账 (runner 只持有一个实例, 三个薄方法)。 */
export function createVerifyToolTracker() {
  const tools: string[] = [];
  return {
    /** 记录一次成功调用; 返回它是不是验证类工具 (给 runner 同步 ranVerifyTool 用) */
    recordTool(name: string, callText?: string): boolean {
      if (!isVerifyToolName(name, callText)) return false;
      /* shell 跑的记成命令本身 (「验证：已跑（npm test）」), 不是工具名 execute_shell */
      const cmd = name === 'run_tests' || name === 'run_lint' ? name : (SHELL_VERIFY_RE.exec(callText ?? '')?.[0] ?? name);
      tools.push(cmd);
      return true;
    },
    reset(): void {
      tools.length = 0;
    },
    get state(): readonly string[] {
      return tools;
    },
  };
}

/**
 * run() 收尾时把「验证」行补进最终正文并作为 text_delta 发出 (界面按流式文本累加)。
 * 不需要补 → 一个事件都不发。
 */
export function* emitVerifyReceiptDelta(
  run: { finalOutput?: string; encounteredError?: boolean },
  state: VerifyReceiptState,
  language: ReceiptLanguage = 'zh',
): Generator<{ type: 'text_delta'; delta: string }> {
  if (run.encounteredError || typeof run.finalOutput !== 'string') return;
  const body = run.finalOutput;
  const withReceipt = ensureVerifyReceiptLine(body, state, language);
  if (withReceipt === body) return;
  run.finalOutput = withReceipt;
  yield { type: 'text_delta', delta: withReceipt.slice(body.replace(/\s+$/, '').length) };
}
