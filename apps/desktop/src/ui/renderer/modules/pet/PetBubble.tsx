/**
 * PetBubble — 桌宠头顶的说话气泡
 *
 * 一段 agent 文本 (max 80 字), 显示 N 秒后 fade 消失. 文本变化会重置计时.
 * pointer-events:none — 气泡不接受鼠标 (不挡拖拽).
 */

import React, { useEffect, useState } from 'react';

interface PetBubbleProps {
  text: string | null;
  /** 文本持续显示时长 (ms), 之后 fade out. 默认 6000. */
  duration?: number;
  /** 显示模式 — 'error' 用红色调, 'speech' 默认深底白字 */
  kind?: 'speech' | 'error' | 'success' | 'thinking';
}

export const PetBubble: React.FC<PetBubbleProps> = ({ text, duration = 6000, kind = 'speech' }) => {
  const [visible, setVisible] = useState(false);
  const [currentText, setCurrentText] = useState<string | null>(null);

  useEffect(() => {
    if (!text) {
      setVisible(false);
      return;
    }
    setCurrentText(text);
    setVisible(true);
    const t = window.setTimeout(() => setVisible(false), duration);
    return () => window.clearTimeout(t);
  }, [text, duration]);

  if (!currentText) return null;

  const palette = (() => {
    switch (kind) {
      case 'error':   return { bg: 'rgba(180, 40, 40, 0.94)',  fg: '#fff' };
      case 'success': return { bg: 'rgba(40, 140, 80, 0.94)',  fg: '#fff' };
      case 'thinking':return { bg: 'rgba(80, 80, 110, 0.94)',  fg: '#f0f0f8' };
      default:        return { bg: 'rgba(20, 20, 24, 0.92)',   fg: '#fff' };
    }
  })();

  return (
    <div
      style={{
        position: 'absolute',
        right: 8,
        top: 0,
        transform: visible ? 'translateY(-8px)' : 'translateY(0)',
        maxWidth: 220,
        padding: '8px 12px',
        background: palette.bg,
        color: palette.fg,
        fontSize: 12,
        lineHeight: 1.4,
        borderRadius: 10,
        boxShadow: '0 6px 18px rgba(0, 0, 0, 0.35)',
        opacity: visible ? 1 : 0,
        transition: 'opacity 300ms ease-out, transform 300ms ease-out',
        pointerEvents: 'none',
        userSelect: 'none',
        backdropFilter: 'blur(6px)',
        wordBreak: 'break-word',
      }}
    >
      {currentText}
    </div>
  );
};

export default PetBubble;
