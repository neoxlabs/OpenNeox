/**
 * confirmEvents — 全局"确认弹窗"事件总线 + Host.
 *
 *   背景
 *   ----
 *   原代码在 settings / sidebar / 文件操作等多处用原生 window.confirm —— Electron 渲染成
 *   macOS 系统弹窗 (灰底圆角 + 蓝色 OK 按钮 + Electron 默认图标), 跟 Neox 整体设计语言完全脱节.
 *   FileDialogs.tsx 的 <ConfirmDialog> 是组件式 API, 调用方需自己持有 visible 状态 + onConfirm
 *   回调, 重构 sync flow 成本高. 这里再加一条 Promise 风格的旁路:
 *
 *     const ok = await confirmAsync({ title, message, variant: 'danger' });
 *     if (!ok) return;
 *
 *   完全跟 window.confirm 同形, 只是异步, 改造老代码改一个字符串就完事.
 *
 *   实现
 *   ----
 *   · confirmAsync 派发 'neox:confirm-request' 事件 + Promise resolver
 *   · ConfirmDialogHost 顶层挂一份, 监听事件 → 渲染 <ConfirmDialog>, 用户点击后 resolve Promise
 *   · 同时只能有一个 confirm 在飞 (Map<id, resolver>), 二次请求排队
 *
 *   不去重
 *   ----
 *   confirm 跟 toast 不同, 必须每次都问 — 用户每次点 "删除" 都期望弹一次.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useEnterTransition } from '../hooks/useEnterTransition';
import { ConfirmDialog } from './FileDialogs';
import { getGlobalLanguage } from '../hooks/useI18n';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useEscClose } from '../hooks/useEscClose';

export interface ConfirmRequest {
  title: string;
  message: React.ReactNode;
  description?: React.ReactNode;
  variant?: 'default' | 'danger';
  /** default 变体的头部图标 (danger 固定用 warning 图标) */
  icon?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
}

const EVENT_NAME = 'neox:confirm-request';

interface ConfirmEventDetail {
  id: number;
  request: ConfirmRequest;
}

let nextId = 1;
const pendingResolvers = new Map<number, (ok: boolean) => void>();

/** 任何模块调用: 弹全局确认对话框, 返回 Promise<boolean>. */
export function confirmAsync(request: ConfirmRequest): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  const id = nextId++;
  return new Promise<boolean>((resolve) => {
    pendingResolvers.set(id, resolve);
    window.dispatchEvent(new CustomEvent<ConfirmEventDetail>(EVENT_NAME, { detail: { id, request } }));
  });
}

/** ConfirmDialogHost 内部: 拿到事件后调用, 关闭弹窗并 resolve. */
function resolvePending(id: number, ok: boolean): void {
  const resolver = pendingResolvers.get(id);
  if (resolver) {
    pendingResolvers.delete(id);
    resolver(ok);
  }
}

/* ==================== promptAsync — 输入弹窗 (替换原生 window.prompt) ==================== */

export interface PromptRequest {
  title: string;
  message?: React.ReactNode;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

const PROMPT_EVENT = 'neox:prompt-request';
let nextPromptId = 1;
const pendingPromptResolvers = new Map<number, (val: string | null) => void>();

interface PromptEventDetail { id: number; request: PromptRequest; }

/** 弹全局输入对话框, 返回 Promise<string | null> (取消=null)。同形替换 window.prompt。 */
export function promptAsync(request: PromptRequest): Promise<string | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  const id = nextPromptId++;
  return new Promise<string | null>((resolve) => {
    pendingPromptResolvers.set(id, resolve);
    window.dispatchEvent(new CustomEvent<PromptEventDetail>(PROMPT_EVENT, { detail: { id, request } }));
  });
}

function resolvePrompt(id: number, val: string | null): void {
  const r = pendingPromptResolvers.get(id);
  if (r) { pendingPromptResolvers.delete(id); r(val); }
}

/** 挂在 AppShell 顶层 — 监听 prompt-request, 渲染主题输入对话框。 */
export const PromptDialogHost: React.FC = () => {
  const [active, setActive] = useState<{ id: number; request: PromptRequest } | null>(null);
  const [value, setValue] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  /* focus trap + Esc — 跟 ConfirmDialog 对齐: Tab 不跑出弹窗, Esc 不依赖焦点在 input 上 */
  useFocusTrap(dialogRef, !!active);
  useEscClose(!!active, () => {
    if (active) resolvePrompt(active.id, null);
    setActive(null);
  });

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<PromptEventDetail>).detail;
      if (!detail) return;
      setActive((prev) => {
        if (prev) { resolvePrompt(detail.id, null); return prev; }
        setValue(detail.request.defaultValue ?? '');
        return detail;
      });
    };
    window.addEventListener(PROMPT_EVENT, handler as EventListener);
    return () => window.removeEventListener(PROMPT_EVENT, handler as EventListener);
  }, []);

  /* 同 TourOverlay: hook 不能放在 `if (!active) return null` 后面, 否则弹窗第一次
   * 出现时 React #310。enabled 绑 active, 打开那帧才播入场。 */
  const entered = useEnterTransition(!!active);

  if (!active) return null;

  const close = (val: string | null) => { resolvePrompt(active.id, val); setActive(null); };


  return (
    <div className="neox-prompt-overlay" onMouseDown={() => close(null)} role="presentation">
      <div ref={dialogRef} className={`neox-prompt-dialog nx-in nx-in--modal ${entered ? 'is-in' : ''}`} role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="neox-prompt-title">{active.request.title}</div>
        {active.request.message && <div className="neox-prompt-msg">{active.request.message}</div>}
        <input
          className="neox-prompt-input"
          autoFocus
          value={value}
          placeholder={active.request.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') close(value);
          }}
        />
        <div className="neox-prompt-foot">
          <button type="button" className="neox-prompt-btn neox-prompt-btn--ghost" onClick={() => close(null)}>
            {active.request.cancelLabel ?? (getGlobalLanguage() === 'zh' ? '取消' : 'Cancel')}
          </button>
          <button type="button" className="neox-prompt-btn neox-prompt-btn--primary" onClick={() => close(value)}>
            {active.request.confirmLabel ?? (getGlobalLanguage() === 'zh' ? '确定' : 'OK')}
          </button>
        </div>
      </div>
    </div>
  );
};

/** 挂在 AppShell 顶层 — 监听 confirm-request 事件, 渲染 ConfirmDialog. */
export const ConfirmDialogHost: React.FC = () => {
  const [active, setActive] = useState<{ id: number; request: ConfirmRequest } | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ConfirmEventDetail>).detail;
      if (!detail) return;
      /* 已经有一个在显示 — 直接 resolve false 让排队请求快速失败, 避免叠在一起.
       * 实际场景里同一时刻不应有两个 confirm 同飞 (用户也只能点一个). */
      setActive((prev) => {
        if (prev) {
          resolvePending(detail.id, false);
          return prev;
        }
        return detail;
      });
    };
    window.addEventListener(EVENT_NAME, handler as EventListener);
    return () => window.removeEventListener(EVENT_NAME, handler as EventListener);
  }, []);

  if (!active) return null;

  const close = (ok: boolean) => {
    resolvePending(active.id, ok);
    setActive(null);
  };

  return (
    <ConfirmDialog
      visible
      title={active.request.title}
      message={active.request.message}
      description={active.request.description}
      variant={active.request.variant ?? 'default'}
      icon={active.request.icon}
      confirmLabel={active.request.confirmLabel}
      cancelLabel={active.request.cancelLabel}
      onConfirm={() => close(true)}
      onClose={() => close(false)}
    />
  );
};
