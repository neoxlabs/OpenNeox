/**
 * FileDialogs - Project View 文件操作对话框集合
 *
 * 包含:
 *   - <NewItemDialog>      新建文件 / 文件夹弹窗
 *   - <RenameDialog>       重命名弹窗 (备用,默认走 inline rename)
 *   - <ConfirmDeleteDialog> 删除确认弹窗 (移到回收站 / 永久删除)
 *   - <ConfirmDialog>      通用确认弹窗 (default / danger 变体，替代 window.confirm)
 *
 * 设计参考: IntelliJ IDEA New File / Rename / Delete 对话框
 *
 * 都通过 React Portal 渲染到 body,centered overlay,Esc 关闭,Enter 确认。
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
/* 对话框开在操作发生的那个窗口 (文件面板可能被拖成了独立窗口) */
import { interactionDoc } from '../utils/ownerDoc';
import { useI18n } from '../hooks/useI18n';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useEscClose } from '../hooks/useEscClose';
import Icons from './Icons';

// ==================== NewItemDialog ====================

export interface NewItemDialogProps {
  visible: boolean;
  isDirectory: boolean;
  parentDir: string;
  onSubmit: (name: string) => void | Promise<void>;
  onClose: () => void;
}

export const NewItemDialog: React.FC<NewItemDialogProps> = ({
  visible,
  isDirectory,
  parentDir,
  onSubmit,
  onClose,
}) => {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  /* Wave 8.5: visible 为 true 时 focus 锁在 dialog; 关闭还原焦点给触发元素 */
  useFocusTrap(dialogRef, visible);

  // 打开时重置状态 + autofocus
  useEffect(() => {
    if (visible) {
      setName('');
      setError(null);
      setSubmitting(false);
      // 下一帧 focus,等 input 渲染完
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [visible]);

  /* Esc 关闭 — capture + LIFO 栈, 从设置页等宿主里弹出时不会把宿主一起关掉 */
  useEscClose(visible, onClose);

  if (!visible) return null;

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t.explorer.errorEmptyName);
      return;
    }
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
      setError(t.explorer.errorInvalidName);
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (e: any) {
      setError(e?.message || t.explorer.errorCreate);
      setSubmitting(false);
    }
  };

  // workspace 短路径(显示用)
  const shortDir = parentDir.length > 50 ? '...' + parentDir.slice(-47) : parentDir;

  return createPortal(
    <div className="neox-file-dialog-backdrop" onClick={onClose}>
      <div ref={dialogRef} className="neox-file-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="neox-file-dialog-title">
          {isDirectory ? t.explorer.newFolderTitle : t.explorer.newFileTitle}
        </div>
        <div className="neox-file-dialog-subtitle">{shortDir}</div>
        <label className="neox-file-dialog-label">
          {isDirectory ? t.explorer.newFolderLabel : t.explorer.newFileLabel}
        </label>
        <input
          ref={inputRef}
          className={`neox-file-dialog-input${error ? ' error' : ''}`}
          type="text"
          value={name}
          placeholder={isDirectory ? t.explorer.newFolderPlaceholder : t.explorer.newFilePlaceholder}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleSubmit();
            }
          }}
          spellCheck={false}
          autoComplete="off"
          disabled={submitting}
        />
        {error && <div className="neox-file-dialog-error">{error}</div>}
        <div className="neox-file-dialog-actions">
          <button
            type="button"
            className="neox-file-dialog-btn"
            onClick={onClose}
            disabled={submitting}
          >
            {t.common.cancel}
          </button>
          <button
            type="button"
            className="neox-file-dialog-btn primary"
            onClick={handleSubmit}
            disabled={submitting || !name.trim()}
          >
            {submitting ? t.common.loading : t.common.confirm}
          </button>
        </div>
      </div>
    </div>,
    interactionDoc().body
  );
};

// ==================== ConfirmDeleteDialog ====================

export interface ConfirmDeleteDialogProps {
  visible: boolean;
  /** 要删除的文件路径们 (多选时多个) */
  paths: string[];
  /** 默认 true (移到回收站); 用户可以点 "永久删除" 按钮 */
  onConfirm: (permanent: boolean) => void | Promise<void>;
  onClose: () => void;
}

export const ConfirmDeleteDialog: React.FC<ConfirmDeleteDialogProps> = ({
  visible,
  paths,
  onConfirm,
  onClose,
}) => {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, visible);

  useEffect(() => {
    if (visible) setSubmitting(false);
  }, [visible]);

  /* Esc 关闭 — capture + LIFO 栈 (useEscClose), 不会把宿主页面一起关掉 */
  useEscClose(visible, onClose);

  // Enter 确认 (移到回收站) — 焦点在按钮上时让原生激活走 (焦点在"取消"上按 Enter 应触发取消)
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      if (document.activeElement instanceof HTMLButtonElement) return;
      e.preventDefault();
      handleConfirm(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!visible || paths.length === 0) return null;

  const handleConfirm = async (permanent: boolean) => {
    setSubmitting(true);
    try {
      await onConfirm(permanent);
      onClose();
    } catch {
      setSubmitting(false);
    }
  };

  const message = paths.length === 1
    ? t.explorer.deleteConfirmMessage.replace('{name}', paths[0].split('/').pop() || '')
    : t.explorer.deleteConfirmMessagePlural.replace('{count}', String(paths.length));

  return createPortal(
    <div className="neox-file-dialog-backdrop" onClick={onClose}>
      <div ref={dialogRef} className="neox-file-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="neox-file-dialog-title">{t.explorer.deleteConfirmTitle}</div>
        <div className="neox-file-dialog-message">{message}</div>
        <div className="neox-file-dialog-actions">
          <button
            type="button"
            className="neox-file-dialog-btn"
            onClick={onClose}
            disabled={submitting}
          >
            {t.common.cancel}
          </button>
          <button
            type="button"
            className="neox-file-dialog-btn primary"
            onClick={() => handleConfirm(false)}
            disabled={submitting}
            /* 默认焦点在主操作 — Enter 直接"移到回收站" (可恢复操作, 保留回车快捷) */
            autoFocus
          >
            {submitting ? t.common.loading : t.explorer.moveToTrash}
          </button>
        </div>
      </div>
    </div>,
    interactionDoc().body
  );
};

// ==================== ConfirmDialog (generic) ====================

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  /** 主信息。支持 string 或 ReactNode（想放 <strong> / 换行等） */
  message: React.ReactNode;
  /** 次要说明（可选）。灰色小字，补充解释后果 */
  description?: React.ReactNode;
  /** 'default' | 'danger'（danger 时头部显示金色 warning 图标，确认按钮变红） */
  variant?: 'default' | 'danger';
  /** default 变体的头部图标（danger 变体固定用 warning 图标，此项忽略） */
  icon?: React.ReactNode;
  /** 确认按钮文案，默认 "确认" */
  confirmLabel?: string;
  /** 取消按钮文案，默认 "取消" */
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  visible,
  title,
  message,
  description,
  variant = 'default',
  icon,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onClose,
}) => {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, visible);

  useEffect(() => {
    if (visible) setSubmitting(false);
  }, [visible]);

  /* Esc 关闭 — capture + LIFO 栈 (useEscClose), 从设置页里弹出时 Esc 不再穿透关掉整个设置页 */
  useEscClose(visible, onClose);

  /* Enter 确认 — 焦点在按钮上时不拦截 (危险弹窗里焦点在"取消"上按 Enter 必须触发取消而不是确认) */
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      if (document.activeElement instanceof HTMLButtonElement) return;
      e.preventDefault();
      handleConfirm();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!visible) return null;

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      await onConfirm();
    } catch {
      setSubmitting(false);
    }
  };

  const confirmText = confirmLabel || t.common.confirm || '确认';
  const cancelText = cancelLabel || t.common.cancel || '取消';

  return createPortal(
    <div className="neox-file-dialog-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className={`neox-file-dialog neox-confirm-dialog ${variant === 'danger' ? 'danger' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="neox-confirm-dialog-header">
          {variant === 'danger' ? (
            <div className="neox-confirm-dialog-icon danger">
              <Icons.AlertCircle />
            </div>
          ) : icon ? (
            /* default 变体的可选图标 — 例如更新提示的下载徽标 */
            <div className="neox-confirm-dialog-icon accent">{icon}</div>
          ) : null}
          <div className="neox-file-dialog-title">{title}</div>
        </div>
        <div className="neox-file-dialog-message">{message}</div>
        {description && (
          <div className="neox-confirm-dialog-description">{description}</div>
        )}
        <div className="neox-file-dialog-actions">
          <button
            type="button"
            className="neox-file-dialog-btn"
            onClick={onClose}
            disabled={submitting}
          >
            {cancelText}
          </button>
          <button
            type="button"
            className={`neox-file-dialog-btn ${variant === 'danger' ? 'danger' : 'primary'}`}
            onClick={handleConfirm}
            disabled={submitting}
            /* default 变体初始焦点在确认 (Enter 直接确认, 符合习惯);
             * danger 变体让 focus trap 落在第一个 focusable = 取消 (Enter 不误删, 更安全) */
            autoFocus={variant !== 'danger'}
          >
            {submitting ? (t.common.loading || '处理中...') : confirmText}
          </button>
        </div>
      </div>
    </div>,
    interactionDoc().body
  );
};
