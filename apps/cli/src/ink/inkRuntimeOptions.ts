// Split out of InkRuntime.tsx for the 文件大小约束 ; re-exported from InkRuntime.

//  Timeline 渲染密度
// - full: 原始行为,每 tool_call 独占一行
// - medium: 连续 tool_call 合并成一个 tool_group entry,同 verb 一行,同 target × N 合并
// - compact: 整轮 tool_call 压成一行徽章式
export type TimelineDensity = 'full' | 'medium' | 'compact';
export const DENSITY_ORDER: TimelineDensity[] = ['full', 'medium', 'compact'];

export interface SelectMenuOptions {
  message: string;
  choices: Array<{ label: string; value: string; description?: string; isCurrent?: boolean }>;
  initialIndex?: number;
  hint?: string;
  header?: string;
  allowTextInput?: boolean;
  /** Accent color (default: magenta) */
  accentColor?: string;
  /** Enable multi-select with space bar */
  multiSelect?: boolean;
  onSelect: (value: string) => void;
  onCancel?: () => void;
}

export interface TextPromptOptions {
  message: string;
  defaultValue?: string;
  hint?: string;
  allowEmpty?: boolean;
  password?: boolean; //  mask typed value (API keys / secrets)
  onSubmit: (value: string) => void;
  onCancel?: () => void;
}
