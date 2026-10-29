import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../hooks/useI18n';
import { dispatchHint } from './notifyEvents';

export const CopyIconButton: React.FC<{
  getText: () => string;
  getHtml?: () => string;
  label?: string;
  className?: string;
}> = ({ getText, getHtml, label, className }) => {
  const { isZh } = useI18n();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = getText();
    if (!text) return;
    try {
      const html = getHtml?.();
      if (html && typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        })]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      setDone(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1200);
    } catch {
      dispatchHint(isZh ? '复制失败 —— 窗口没有焦点或剪贴板被拒' : 'Copy failed — window not focused or clipboard denied', 'warning');
    }
  }, [getText, getHtml, isZh]);

  const title = done ? (isZh ? '已复制' : 'Copied') : (label ?? (isZh ? '复制' : 'Copy'));
  return (
    <button
      type="button"
      className={`nx-copy-btn${done ? ' is-done' : ''}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      title={title}
      aria-label={title}
    >
      {done ? (
        <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 7.4l2.6 2.6L11 4.6" />
        </svg>
      ) : (
        <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />
          <path d="M2.5 9.5V3a1 1 0 0 1 1-1H9" />
        </svg>
      )}
      {label && <span className="nx-copy-btn__label">{done ? (isZh ? '已复制' : 'Copied') : label}</span>}
    </button>
  );
};

/** 终端输出里的 ANSI 控制序列 (颜色 / 光标移动) —— 复制出去不能带着 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\r(?!\n)/g, '');
}

/** 把渲染好的 <table> 转成 TSV (Excel 直接分列) + 干净的 HTML (不带主题内联样式和 class) */
export function tableToClipboard(table: HTMLTableElement): { text: string; html: string } {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = Array.from(table.rows).map((tr) =>
    Array.from(tr.cells).map((c) => ({ tag: c.tagName.toLowerCase(), text: (c.innerText || '').replace(/\s*\n\s*/g, ' ').trim() })),
  );
  const text = rows.map((r) => r.map((c) => c.text.replace(/\t/g, ' ')).join('\t')).join('\n');
  const html = `<table>${rows.map((r) => `<tr>${r.map((c) => `<${c.tag}>${esc(c.text)}</${c.tag}>`).join('')}</tr>`).join('')}</table>`;
  return { text, html };
}
