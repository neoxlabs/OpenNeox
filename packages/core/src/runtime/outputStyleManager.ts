/**
 * Output Style Manager — 输出风格管理器
 *
 * 4 种输出风格，通过 system prompt append 实现：
 * - Concise: 极简回答，不解释
 * - Standard: 适度解释 + 代码（默认）
 * - Detailed: 完整解释 + 原理 + 替代方案
 * - CodeOnly: 纯代码输出
 *
 * 多 Provider 通用：通过 PromptProfile.appendInstructions 注入，
 * 不依赖任何 provider-specific API。
 */

// ==================== Types ====================

export type OutputStyle = 'concise' | 'standard' | 'detailed' | 'code_only';

export interface OutputStyleConfig {
  label: string;
  icon: string;
  description: string;
  /** Instructions appended to the system prompt */
  promptAppend: string;
}

// ==================== Style Definitions ====================

const OUTPUT_STYLES: Record<OutputStyle, OutputStyleConfig> = {
  concise: {
    label: 'Concise',
    icon: '📌',
    description: '极简回答，直接给代码/命令',
    promptAppend: `Output style: CONCISE.
- Answer in minimum words. No preamble, no summary, no trailing explanation.
- Lead with the answer or action. Skip filler words and transitions.
- For code tasks: output only the diff or code block needed. No surrounding prose.
- If you can say it in one sentence, don't use three.`,
  },
  standard: {
    label: 'Standard',
    icon: '📋',
    description: '适度解释 + 代码（默认）',
    promptAppend: '', // No override needed, this is the default behavior
  },
  detailed: {
    label: 'Detailed',
    icon: '📖',
    description: '完整解释 + 原理 + 替代方案',
    promptAppend: `Output style: DETAILED.
- Explain your reasoning step by step before giving the solution.
- Show alternatives when they exist, with trade-off analysis.
- For code changes: explain WHY each change is needed, not just WHAT changed.
- Include relevant background concepts that help understanding.
- Teach the user — assume they want to learn, not just get a result.`,
  },
  code_only: {
    label: 'Code Only',
    icon: '💻',
    description: '纯代码输出，零解释',
    promptAppend: `Output style: CODE ONLY.
- Output only code blocks and file paths. Zero prose or explanation.
- If multiple files need changes, output each as a separate code block with the file path header.
- Do not add comments explaining the changes unless the logic is non-obvious.
- For tool calls: proceed normally — this style only affects your text output.`,
  },
};

// ==================== State ====================

let currentStyle: OutputStyle = 'standard';
let onStyleChange: ((style: OutputStyle) => void) | null = null;

// ==================== Public API ====================

export function setOutputStyle(style: OutputStyle): void {
  currentStyle = style;
  onStyleChange?.(style);
}

export function getOutputStyle(): OutputStyle {
  return currentStyle;
}

export function setOutputStyleChangeCallback(callback: ((style: OutputStyle) => void) | null): void {
  onStyleChange = callback;
}

/**
 * Get the prompt append text for the current output style.
 * Returns empty string for 'standard' (no override needed).
 */
export function getStylePromptAppend(style?: OutputStyle): string {
  return OUTPUT_STYLES[style || currentStyle].promptAppend;
}

/**
 * Get style config for display.
 */
export function getStyleConfig(style?: OutputStyle): OutputStyleConfig {
  return OUTPUT_STYLES[style || currentStyle];
}

/**
 * Get all available output styles.
 */
export function getAllStyles(): Array<OutputStyle & string> {
  return Object.keys(OUTPUT_STYLES) as OutputStyle[];
}

/**
 * Get style info for display.
 */
export function getStyleInfo(style?: OutputStyle): { icon: string; label: string; color: string } {
  const s = style || currentStyle;
  switch (s) {
    case 'concise': return { icon: '📌', label: 'Concise', color: 'yellow' };
    case 'standard': return { icon: '📋', label: 'Standard', color: 'cyan' };
    case 'detailed': return { icon: '📖', label: 'Detailed', color: 'green' };
    case 'code_only': return { icon: '💻', label: 'Code Only', color: 'magenta' };
  }
}

/** All output styles as array */
export const OUTPUT_STYLE_LIST: OutputStyle[] = ['concise', 'standard', 'detailed', 'code_only'];
