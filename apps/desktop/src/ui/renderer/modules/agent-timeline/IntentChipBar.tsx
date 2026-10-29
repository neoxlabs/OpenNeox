/* ============================================================
 * IntentChipBar — composer 上方的意图 chip 条.
 *
 * 用户主动挂 chip 声明本轮意图 (创建图片 / 深度研究 / 简短回复 等), 提交时:
 *   1. system-prompt 追加 chip.instruction (biasing LLM 行为)
 *   2. UI 显示 chip 让用户视觉确认
 *   3. X 可以关掉
 *
 * 图片模式 chip: 让 LLM 优先调 generate_image 工具, 不废话.
 * 其他 chip 是未来扩展点 (research / code / concise / voice-in).
 *
 * 跟 direct-mode 图片通道的区别:
 *   · IntentChip = 走 chat completions 但注入偏好 (agent 通道)
 *   · 图片 surface 才是真正 bypass LLM 的直连路径 (task 4)
 * ============================================================ */

import React from 'react';
import { defaultIsZh } from '../../hooks/useI18n';

export interface IntentChip {
  id: string;
  icon: string;         // emoji or single glyph
  label: string;
  /** LLM system-prompt 追加片段, 提交时拼接. */
  instruction: string;
  /** 品牌色, 高亮 chip 用. */
  color?: string;
}

/** 内置 chip 目录. 想加更多 (research / voice) 只需 append. */
export const INTENT_CHIPS: IntentChip[] = [
  {
    id: 'create-image',
    icon: '🖼',
    label: '创建图片',
    color: '#3b82f6',
    instruction: '用户当前是图像创作意图。你的任务:把用户描述提炼成结构化图像 prompt (主体+风格+构图+光影+质感, 英文更佳), 然后直接调 generate_image 工具出图。不用先问澄清问题, 除非描述实在无法解析。默认 n=1, size=1024x1024, quality=high。出图后简短说明并给用户"再改一下"的入口 (edit_image 工具)。',
  },
];

/** chip 图标 — 已知 intent 用干净的 line SVG (不用花花绿绿的 emoji), 未知 fallback 到 chip.icon 字形. */
const ChipGlyph: React.FC<{ chip: IntentChip }> = ({ chip }) => {
  if (chip.id === 'create-image') {
    return (
      <svg
        width="13" height="13" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
        aria-hidden
      >
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="8.5" cy="8.5" r="1.6" />
        <path d="M21 15.5 16 10.5 5 21" />
      </svg>
    );
  }
  return <span aria-hidden style={{ fontSize: 13 }}>{chip.icon}</span>;
};

interface Props {
  activeIntentIds: string[];
  onRemove: (id: string) => void;
  zh?: boolean;
}

export const IntentChipBar: React.FC<Props> = ({ activeIntentIds, onRemove, zh = defaultIsZh() }) => {
  if (activeIntentIds.length === 0) return null;
  const active = INTENT_CHIPS.filter(c => activeIntentIds.includes(c.id));
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        padding: '6px 0 8px 0',
      }}
    >
      {active.map(chip => (
        <div
          key={chip.id}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 999,
            background: `${chip.color ?? '#3b82f6'}18`,
            border: `1px solid ${chip.color ?? '#3b82f6'}40`,
            color: chip.color ?? '#3b82f6',
            fontSize: 12,
            fontWeight: 500,
            userSelect: 'none',
          }}
          title={zh ? '点击 × 关闭本意图' : 'Click × to remove intent'}
        >
          <ChipGlyph chip={chip} />
          <span>{chip.label}</span>
          <button
            type="button"
            onClick={() => onRemove(chip.id)}
            aria-label={zh ? '关闭意图' : 'Remove intent'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 14,
              height: 14,
              padding: 0,
              marginLeft: 2,
              background: 'transparent',
              border: 'none',
              color: 'currentColor',
              opacity: 0.6,
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.6'; }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
};

/** 拼接 chip.instruction 到用户消息前 (最简策略). 后续可以改成走 tool_choice or system prompt. */
export function decorateMessageWithIntents(text: string, activeIntentIds: string[]): string {
  if (activeIntentIds.length === 0) return text;
  const active = INTENT_CHIPS.filter(c => activeIntentIds.includes(c.id));
  const preamble = active.map(c => `[意图·${c.label}] ${c.instruction}`).join('\n');
  return `${preamble}\n\n用户消息:\n${text}`;
}
