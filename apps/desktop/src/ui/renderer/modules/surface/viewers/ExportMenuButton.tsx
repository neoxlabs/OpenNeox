/**
 * ExportMenuButton — sheet/docx/pdf viewer 右上角"导出 ▼"下拉.
 *   跟 OpenInExternalAppButton 并排; 玻璃拟态; 下拉跟 "+ 打开" 菜单同款.
 *
 *   每个 viewer 传一组 ExportItem (label/icon/onPick) — 不假设格式集合, viewer 自决.
 *   汇报场景关键路径: PDF / Markdown / CSV / JSON / HTML / TXT.
 */

import React, { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePopoverDismiss } from '../../../hooks/usePopoverDismiss';
import { useI18n } from '../../../hooks/useI18n';
import { bodyOf, winOf } from '../../../utils/ownerDoc';

export interface ExportItem {
  /** 显示名, 如 "导出 PDF" */
  label: string;
  /** 副标题 hint, 显示在 label 下方 */
  hint?: string;
  /** 触发: 自己负责 pickSavePath + 导出 + toast, 返回 ok/error */
  onPick: () => Promise<{ ok: boolean; error?: string; file_path?: string }>;
}

interface Props {
  /** 文件源路径 (inline source 不渲染) */
  filePath?: string;
  /** 导出项列表 — viewer 按 kind 决定 */
  items: ExportItem[];
}

export const ExportMenuButton: React.FC<Props> = ({ filePath, items }) => {
  const { isZh } = useI18n();
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /* 统一 popover 关闭逻辑 — click outside / Esc / 防自身点击瞬关 */
  usePopoverDismiss({
    open,
    refs: [btnRef, menuRef],
    onDismiss: () => setOpen(false),
  });

  const toggleOpen = useCallback(() => {
    if (open) { setOpen(false); return; }
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      setMenuPos({
        top: rect.bottom + 4,
        right: Math.max(8, winOf(btnRef.current).innerWidth - rect.right),
      });
    }
    setOpen(true);
  }, [open]);

  const onPick = useCallback(async (item: ExportItem) => {
    setOpen(false);
    setBusy(true);
    setLastResult(null);
    try {
      const r = await item.onPick();
      if (r.ok) {
        setLastResult({ ok: true, msg: isZh ? `已导出: ${item.label}` : `Exported: ${item.label}` });
      } else if (r.error && r.error !== 'cancelled') {
        setLastResult({ ok: false, msg: r.error });
      }
    } catch (e: any) {
      setLastResult({ ok: false, msg: e?.message || String(e) });
    } finally {
      setBusy(false);
      /* 3s 后清状态提示 */
      setTimeout(() => setLastResult(null), 3000);
    }
  }, [isZh]);

  if (!filePath || items.length === 0) return null;

  const title = lastResult
    ? lastResult.msg
    : busy
      ? (isZh ? '导出中…' : 'Exporting…')
      : (isZh ? '导出为其他格式 (PDF / Markdown / CSV / ...)' : 'Export to another format (PDF / Markdown / CSV / ...)');

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`sfc-export-btn${busy ? ' is-busy' : ''}${lastResult?.ok === false ? ' is-error' : ''}${lastResult?.ok ? ' is-ok' : ''}`}
        onClick={toggleOpen}
        title={title}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={busy}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
             strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {/* lucide download */}
          <path d="M21 15 V19 a2 2 0 0 1 -2 2 H5 a2 2 0 0 1 -2 -2 V15" />
          <path d="M7 10 L12 15 L17 10" />
          <path d="M12 15 V3" />
        </svg>
        <span className="sfc-export-btn__label">{isZh ? '导出' : 'Export'}</span>
        <svg viewBox="0 0 14 14" width="9" height="9" fill="none" stroke="currentColor"
             strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3.5 5.5 L7 9 L10.5 5.5" />
        </svg>
      </button>
      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          className="sfc-export-menu"
          role="menu"
          style={{ top: menuPos.top, right: menuPos.right }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {items.map((item, i) => (
            <button
              key={i}
              type="button"
              className="sfc-export-menu__item"
              onClick={() => void onPick(item)}
              role="menuitem"
              title={item.hint}
            >
              <span className="sfc-export-menu__item-label">{item.label}</span>
              {item.hint && (
                <span className="sfc-export-menu__item-hint">{item.hint}</span>
              )}
            </button>
          ))}
        </div>,
        /* 按钮在哪个窗口就挂哪个窗口 (Surface 独立窗口里点导出, 菜单不能弹回主窗口) */
        bodyOf(btnRef.current),
      )}
    </>
  );
};

export default ExportMenuButton;
