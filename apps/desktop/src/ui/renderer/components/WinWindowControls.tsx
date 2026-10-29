import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

type NeoxWindowApi = {
  windowMinimize?: () => Promise<unknown> | unknown;
  windowMaximizeToggle?: () => Promise<unknown> | unknown;
  windowClose?: () => Promise<unknown> | unknown;
  windowIsMaximized?: () => Promise<boolean>;
  onWindowMaximizedChanged?: (cb: (maximized: boolean) => void) => () => void;
};

function getApi(): NeoxWindowApi | undefined {
  return (window as unknown as { neox?: NeoxWindowApi }).neox;
}

function useWin32Enabled(): boolean {
  const [enabled, setEnabled] = useState(
    () => typeof document !== 'undefined'
      && document.documentElement.getAttribute('data-platform') === 'win32',
  );

  useEffect(() => {
    if (enabled) return;
    const obs = new MutationObserver(() => {
      if (document.documentElement.getAttribute('data-platform') === 'win32') {
        setEnabled(true);
        obs.disconnect();
      }
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-platform'] });
    return () => obs.disconnect();
  }, [enabled]);

  return enabled;
}

function useMaximized(enabled: boolean): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const api = getApi();
    let cancelled = false;
    void api?.windowIsMaximized?.().then((v) => {
      if (!cancelled && typeof v === 'boolean') setMaximized(v);
    });
    const off = api?.onWindowMaximizedChanged?.((v) => setMaximized(!!v));
    return () => {
      cancelled = true;
      off?.();
    };
  }, [enabled]);
  return maximized;
}

function ControlsButtons({ maximized }: { maximized: boolean }) {
  const api = getApi();
  return (
    <>
      <button
        type="button"
        className="neox-win-controls__btn neox-win-controls__btn--min"
        title="Minimize"
        aria-label="Minimize"
        onClick={() => { void api?.windowMinimize?.(); }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M1 5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        className="neox-win-controls__btn neox-win-controls__btn--max"
        title={maximized ? 'Restore' : 'Maximize'}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        onClick={() => { void api?.windowMaximizeToggle?.(); }}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M2.5 3.5h5v5h-5z" fill="none" stroke="currentColor" strokeWidth="1.1" />
            <path d="M3.5 2.5h5v5" fill="none" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="neox-win-controls__btn neox-win-controls__btn--close"
        title="Close"
        aria-label="Close"
        onClick={() => { void api?.windowClose?.(); }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
    </>
  );
}

/**
 * Windows 自绘窗控。
 * - inline: 嵌在 `.neox-topbar__right` 末尾，跟登录/头像同一行节奏
 * - fixed: 无顶栏页（欢迎/引导/登录/设置）用右上角固定条；有顶栏时自动隐藏避免双份
 */
export const WinWindowControls: React.FC<{ placement?: 'fixed' | 'inline' }> = ({
  placement = 'fixed',
}) => {
  const enabled = useWin32Enabled();
  const maximized = useMaximized(enabled);

  if (!enabled) return null;

  const node = (
    <div
      className={`neox-win-controls${placement === 'inline' ? ' neox-win-controls--inline' : ' neox-win-controls--fixed'}`}
      role="group"
      aria-label="Window controls"
    >
      <ControlsButtons maximized={maximized} />
    </div>
  );

  if (placement === 'inline') return node;
  return createPortal(node, document.body);
};
