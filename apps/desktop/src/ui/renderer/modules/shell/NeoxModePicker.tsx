
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useExclusivePopover } from '../../hooks/useExclusivePopover';
import { createPortal } from 'react-dom';
import { useI18n } from '../../hooks/useI18n';
import { useAppStore } from '../../../state/appStore';
import { rememberCodeWorkspace, takeCodeWorkspace, fallbackCodeWorkspace, normalizeAgentMode } from '../../app/modeWorkspaceBinding';
import { ModeSwitchNotice, nextNoticeKind, type NoticeKind } from './ModeSwitchNotice';

import brandWorkImg from '../../assets/icons/neox-work-coordinated-art-fixed-canvas-RGBA-60.webp?inline';
import brandCodeImg from '../../assets/icons/neox-code-coordinated-art-fixed-canvas-RGBA-60.webp?inline';
import brandWorkWhiteImg from '../../assets/icons/neox-work-wordmark-white-RGBA-60.webp?inline';
import brandCodeWhiteImg from '../../assets/icons/neox-code-wordmark-white-RGBA-60.webp?inline';
import brandPilotImg from '../../assets/icons/neox-pilot-coordinated-art-fixed-canvas-RGBA-60.webp?inline';
import brandPilotWhiteImg from '../../assets/icons/neox-pilot-wordmark-white-RGBA-60.webp?inline';
import brandMarkImg from '../../assets/brand/mark-ring-96.webp?inline';
import { beginShellSwitch, endShellSwitch } from './shellSwitchFade';

type AgentModeValue = 'work' | 'code' | 'pilot';

interface ModeOption {
  id: AgentModeValue;
  brandImg: string;
  altText: string;   // 无障碍
  hint: string;      // 描述
}

function getOptions(zh: boolean, dark: boolean): ModeOption[] {
  return [
    {
      id: 'work',
      brandImg: dark ? brandWorkWhiteImg : brandWorkImg,
      altText: 'Neox Work',
      hint: zh ? '工作 · 改稿 · 文档 · 调研' : 'Work · revise · docs · research',
    },
    {
      id: 'code',
      brandImg: dark ? brandCodeWhiteImg : brandCodeImg,
      altText: 'Neox Code',
      hint: zh ? '编码 · 完整工程能力' : 'Code · full engineering',
    },
    {
      id: 'pilot',
      brandImg: dark ? brandPilotWhiteImg : brandPilotImg,
      altText: 'Neox Pilot',
      hint: zh ? '领航 · 会打电话的私人助理' : 'Pilot · an assistant that calls you',
    },
  ];
}

export const NeoxModePicker: React.FC<{
  currentMode?: AgentModeValue | null;
  disabled?: boolean;
}> = ({ currentMode, disabled }) => {
  const { isZh } = useI18n();
  const { darkMode, workspace } = useAppStore();
  const workspacePath = workspace?.path ?? null;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  /* Pilot 住在云端, 只有开通了的账号能用 —— 没开通的菜单里不出现 (每次打开菜单问一次, 登录 / 开通后不用重启) */
  const [pilotOk, setPilotOk] = useState(false);
  /* UI 3.0: 分段常驻, 不再有「打开菜单」这个时机 —— 挂载时问一次, 窗口回到前台再问 (登录 / 开通后不用重启) */
  useEffect(() => {
    const api = (window as { neox?: { pilotAvailable?: () => Promise<boolean> } }).neox;
    const check = () => { void api?.pilotAvailable?.().then((v) => setPilotOk(v === true)).catch(() => setPilotOk(false)); };
    check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, []);
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const rows = menuRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
      if (!rows || rows.length === 0) return;
      const checked = [...rows].find(el => el.getAttribute('aria-checked') === 'true');
      (checked ?? rows[0]).focus();
    }, 0);
    return () => {
      window.clearTimeout(t);
      if (!document.activeElement || document.activeElement === document.body) {
        btnRef.current?.focus();
      }
    };
  }, [open]);
  useExclusivePopover('mode-picker', open, () => setOpen(false));

  /* 本地"最近手动切换"状态: 用于无 activeSession 场景 (workspace 视图),
   * 点击后 currentMode 不会变 (session 缺席), 用 manualMode 立刻刷新品牌图。
   * 只有当 currentMode 命中 manualMode 时才让位; 否则视为 workspace-switch 的 stale
   * lastSession 恢复 (agentMode ≠ 用户刚选的 mode), 保持 manualMode 防"首次切 auto-revert"。 */
  const [manualMode, setManualMode] = useState<AgentModeValue | null>(null);
  useEffect(() => {
    if (manualMode && currentMode && currentMode === manualMode) setManualMode(null);
  }, [currentMode, manualMode]);

  const options = getOptions(isZh, darkMode === 'dark');
  /* 回落链补 window.__neoxDefaultAgentMode (main.tsx 挂载前已 seed) — 无 active
   * session 时 brand 图才能跟 defaultAgentMode 一致, 不再"侧栏 Work 牌子 Code". */
  const windowDefault = ((): AgentModeValue | null => {
    const m = typeof window !== 'undefined'
      ? (window as { __neoxDefaultAgentMode?: string }).__neoxDefaultAgentMode : null;
    return m ? normalizeAgentMode(m) : null;
  })();
  const displayMode: AgentModeValue = manualMode ?? currentMode ?? windowDefault ?? 'code';
  const active = options.find((o) => o.id === displayMode) ?? options[options.length - 1];
  const isWin32 = typeof document !== 'undefined'
    && document.documentElement.getAttribute('data-platform') === 'win32';

  /* 定位 popover */
  useEffect(() => {
    if (!open || !btnRef.current) { setPos(null); return; }
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: r.left });
  }, [open]);

  /* 外点 / Esc 关闭 */
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /* 切模式提示 (ModeSwitchNotice) + 选中段亮一下 */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [notice, setNotice] = useState<{
    kind: Exclude<NoticeKind, 'none'>; from: AgentModeValue; to: AgentModeValue;
    anchor: { top: number; left: number } | null;
  } | null>(null);
  const [flash, setFlash] = useState<AgentModeValue | null>(null);
  const flashTimer = useRef<number | null>(null);
  const flashSeg = useCallback((m: AgentModeValue) => {
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    setFlash(m);
    flashTimer.current = window.setTimeout(() => setFlash(null), 950);
  }, []);
  useEffect(() => () => { if (flashTimer.current) window.clearTimeout(flashTimer.current); }, []);

  const switchTo = useCallback(async (mode: AgentModeValue, opts?: { quiet?: boolean }) => {
    setOpen(false);
    if (busy || disabled || mode === active.id) return;
    const prev = active.id;
    setNotice(null);
    const api = (window as any).neox;
    setBusy(true);
    beginShellSwitch();
    try {
      setManualMode(mode);
      try { window.localStorage.removeItem('neox-mode-switch-in-progress'); } catch { /* ignore */ }
      if (typeof api?.agentModeSetDefault === 'function') {
        await api.agentModeSetDefault(mode).catch(() => {});
      }
      /* 把 window 侧全局也更新, useAgentModeVariant 无 activeSession 时读它 */
      try { (window as { __neoxDefaultAgentMode?: string }).__neoxDefaultAgentMode = mode; } catch { /* ignore */ }
      window.dispatchEvent(new CustomEvent('neox:agent-mode-default-changed', { detail: { defaultAgentMode: mode } }));
      window.dispatchEvent(new CustomEvent('neox:clear-active-session'));
      if (mode === 'code') {
        try {
          /* 没记过项目 (存量用户从没被记过) 而当前困在 mode home → 拿最近的真项目兜底 */
          const homes = [
            await api?.agentModeEnsureHome?.('work').then((h: any) => h?.path ?? null).catch(() => null),
            await api?.agentModeEnsureHome?.('pilot').then((h: any) => h?.path ?? null).catch(() => null),
          ];
          const restore = (await takeCodeWorkspace(workspacePath, homes))
            ?? (await fallbackCodeWorkspace(workspacePath, homes));
          if (restore) {
            window.dispatchEvent(new CustomEvent('neox:open-workspace', { detail: { path: restore, silent: true } }));
          }
        } catch { /* 还原失败就停在当前工作区, 不阻塞切模式 */ }
      }
      if ((mode === 'work' || mode === 'pilot') && typeof api?.agentModeEnsureHome === 'function') {
        try {
          const home = await api.agentModeEnsureHome(mode);
          const otherMode = mode === 'work' ? 'pilot' : 'work';
          const otherHome = await api.agentModeEnsureHome(otherMode).then((h: any) => h?.path ?? null).catch(() => null);
          await rememberCodeWorkspace(workspacePath, [home?.path, otherHome]);
          if (home?.success && home.path) {
            try { window.localStorage.setItem('neox-mode-switch-in-progress', mode); } catch { /* ignore */ }
            /* preload 没有 getWorkspace — 不去猜当前 workspace, 直接 dispatch;
             * AppShell.handleOpenProject 对同路径是幂等的 (最多一次空刷)。 */
            window.dispatchEvent(new CustomEvent('neox:open-workspace', { detail: { path: home.path, silent: true } }));
          }
        } catch { /* home 建不出来不阻塞切模式 */ }
      }

      if (!opts?.quiet) {
        const kind = nextNoticeKind();
        flashSeg(mode);
        if (kind !== 'none') {
          const r = rootRef.current?.getBoundingClientRect();
          setNotice({ kind, from: prev, to: mode, anchor: r ? { top: r.bottom + 8, left: r.left } : null });
        }
      } else {
        flashSeg(mode);
      }
    } catch (e) {
      console.error('[NeoxModePicker] switch failed:', e);
    } finally {
      setBusy(false);
      endShellSwitch();
    }
  }, [active.id, busy, disabled, workspacePath, flashSeg]);

  /* 别处要切模式 (团队只在 Code 用: Work 里点团队先切 Code) 走同一个 switchTo, 不另起一套 */
  const switchRef = useRef(switchTo);
  switchRef.current = switchTo;
  useEffect(() => {
    const onSwitch = (e: Event) => {
      const d = (e as CustomEvent<{ mode?: AgentModeValue; quiet?: boolean }>).detail;
      if (d?.mode) void switchRef.current(d.mode, { quiet: d.quiet });
    };
    window.addEventListener('neox:switch-mode', onSwitch);
    return () => window.removeEventListener('neox:switch-mode', onSwitch);
  }, []);

  const closeNotice = useCallback(() => setNotice(null), []);
  const segs = options.filter((o) => o.id !== 'pilot' || pilotOk || o.id === displayMode);
  return (
    <div ref={rootRef} className={`neox-mode-seg${busy ? ' is-busy' : ''}`} role="radiogroup" aria-label={isZh ? '模式' : 'Mode'}>
      {segs.map((o) => {
        const isActive = o.id === active.id;
        const name = o.id === 'work' ? 'Work' : o.id === 'code' ? 'Code' : 'Pilot';
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            className={`neox-mode-seg__btn${isActive ? ' is-on' : ''}${flash === o.id ? ' is-flash' : ''}`}
            disabled={disabled}
            title={o.hint}
            onClick={() => { if (!isActive) void switchTo(o.id); }}
          >
            {name}
          </button>
        );
      })}
      {notice && (
        <ModeSwitchNotice
          kind={notice.kind}
          from={notice.from}
          to={notice.to}
          zh={isZh}
          anchor={notice.anchor}
          onUndo={() => { const back = notice.from; setNotice(null); void switchTo(back, { quiet: true }); }}
          onClose={closeNotice}
        />
      )}
    </div>
  );
};

export default NeoxModePicker;
