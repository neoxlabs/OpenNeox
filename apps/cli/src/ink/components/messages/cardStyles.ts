/**
 * 统一的消息卡片样式配置
 * 所有消息组件都使用相同的卡片样式，只是颜色不同
 */

export type CardColor =
  | 'cyan'      // Assistant
  | 'green'     // User, Success
  | 'yellow'    // Tool Call, Warning
  | 'blue'      // Tool Result, Info
  | 'red'       // Error
  | 'magenta'   // Plan, Thinking
  | 'gray';     // Reasoning

export interface CardStyle {
  color: CardColor;
  icon: string;
  title: string;
}

/**
 * 消息类型到卡片样式的映射
 */
export const MESSAGE_CARD_STYLES: Record<string, CardStyle> = {
  // 用户和助手消息 — ✻ (U+273B sparkle) 跟 StatusLine 任务指示同款,
  // 整体调性统一. winSymbols 已含 fallback (✻ → *) 给 Windows.
  'user': { color: 'green', icon: '›', title: 'You' },
  'supervisor': { color: 'green', icon: '›', title: 'Supervisor' },
  'assistant': { color: 'cyan', icon: '✻', title: 'Assistant' },

  // Plan 消息
  'plan': { color: 'magenta', icon: '✦', title: 'Plan' },

  // 思考相关
  'thinking': { color: 'cyan', icon: '~', title: 'Thinking' },
  'reasoning': { color: 'magenta', icon: '~', title: 'Reasoning' },

  // 信息消息
  'info': { color: 'blue', icon: '·', title: 'info' },
  'warning': { color: 'yellow', icon: '!', title: 'warn' },
  'error': { color: 'red', icon: 'x', title: 'error' },
  'success': { color: 'green', icon: '✓', title: 'ok' },

  // Tool 相关
  'tool_result': { color: 'blue', icon: '✓', title: 'Result' },
  'tool_error': { color: 'red', icon: 'x', title: 'Error' },
};

/**
 * 卡片布局常量
 */
export const CARD_LAYOUT = {
  // 时间戳宽度 "HH:MM:SS.mmm • " = 15 chars
  TIMESTAMP_WIDTH: 15,
  // 左侧填充（用于对齐内容）
  LEFT_PADDING: '               ', // 15 spaces
  // 底部边框长度
  BORDER_LENGTH: 60,
};

/**
 * 获取卡片样式
 */
export function getCardStyle(type: string, customIcon?: string, customTitle?: string): CardStyle {
  const style = MESSAGE_CARD_STYLES[type] || MESSAGE_CARD_STYLES['info'];
  return {
    ...style,
    icon: customIcon || style.icon,
    title: customTitle || style.title,
  };
}
