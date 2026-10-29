import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu';
import { TOOL_ICONS } from './sidebarToolIcons';
import { acceptsDrop, dropHint, handleDrop, loadMcp, loadSkills, mcpBadge, type DockBadge } from './sidebarDockActions';
import { SidebarToolPeek, PEEK_TOOLS } from './SidebarToolPeek';
import { isMac } from '../../utils/keymap';

export interface DockTool {
  id: string;
  label: string;
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  unavailable?: boolean;
}

const KEY = 'neox.sidebar.dock.v1';
const PEEK_DELAY = 450;

interface DockPrefs { order: string[]; hidden: string[] }

function loadPrefs(): DockPrefs {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { order: Array.isArray(j.order) ? j.order : [], hidden: Array.isArray(j.hidden) ? j.hidden : [] };
  } catch {
    return { order: [], hidden: [] };
  }
}

function savePrefs(p: DockPrefs) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* 隐私模式等: 只是不记住 */ }
}

const IconCheck: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
);

interface Props {
  tools: DockTool[];
  active?: string | null;
  zh: boolean;
  /** 会话拖到知识库时先切过去 */
  onSelectSession?: (id: string) => void;
  /** 图片拖到图片工具时开工作台 */
  onOpenImageStudio?: () => void;
}

export const SidebarToolDock: React.FC<Props> = ({ tools, active, zh, onSelectSession, onOpenImageStudio }) => {
  const [prefs, setPrefs] = useState<DockPrefs>(loadPrefs);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  /* 外面拖进来的东西 (会话 / 文件) 正悬在哪个图标上, 以及它的 types */
  const [extOver, setExtOver] = useState<{ id: string; types: string[] } | null>(null);
  const [badges, setBadges] = useState<Record<string, DockBadge | undefined>>({});
  const [peek, setPeek] = useState<{ id: string; rect: DOMRect } | null>(null);
  const peekTimer = useRef<number | null>(null);
  const [tip, setTip] = useState<{ id: string; rect: DOMRect } | null>(null);
  const tipTimer = useRef<number | null>(null);
  const showTip = (id: string, el: HTMLElement) => {
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => setTip({ id, rect: el.getBoundingClientRect() }), tip ? 0 : 120);
  };
  const hideTip = () => { if (tipTimer.current) window.clearTimeout(tipTimer.current); tipTimer.current = null; setTip(null); };

  /* 已知的按记住的顺序排, 新出现的 (比如切到 Work 多了文件库) 接在后面 */
  const ordered = useMemo(() => {
    const rank = (id: string) => { const i = prefs.order.indexOf(id); return i < 0 ? 1000 + tools.findIndex((t) => t.id === id) : i; };
    return [...tools].sort((a, b) => rank(a.id) - rank(b.id));
  }, [tools, prefs.order]);
  const shown = ordered.filter((t) => !prefs.hidden.includes(t.id));

  const update = (next: DockPrefs) => { setPrefs(next); savePrefs(next); };

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = ordered.map((t) => t.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    update({ ...prefs, order: ids });
  };

  /* ── 状态角标: 进来读一次, 窗口回到前台再读, 平时每分钟一次 ── */
  const refreshBadges = useCallback(async () => {
    const [m, s] = await Promise.all([loadMcp().catch(() => null), loadSkills().catch(() => null)]);
    setBadges({
      mcp: m ? mcpBadge(m.on, m.rows, zh) : undefined,
      skills: s && s.length > 0 ? { count: s.length, title: zh ? `${s.length} 个技能可用` : `${s.length} skills` } : undefined,
    });
  }, [zh]);
  useEffect(() => {
    void refreshBadges();
    const t = window.setInterval(() => { void refreshBadges(); }, 60_000);
    const onFocus = () => { void refreshBadges(); };
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [refreshBadges]);

  /* ── ⌘1 ~ ⌘9: 按托盘里的顺序打开 (快捷键写在悬停提示里; 不再按住 ⌘ 就把名字换成数字 —— 截图时整排变样) ── */
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey) return;
      const n = /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
      const t = n ? shownRef.current[n - 1] : undefined;
      if (!t || t.disabled) return;
      e.preventDefault();
      t.onClick?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const keyLabel = (i: number) => (isMac ? `⌘${i + 1}` : `Ctrl+${i + 1}`);

  /* ── 放大镜: 离指针越近的图标越大; 直接写 CSS 变量, 不走 state (每帧重渲染整排不值) ── */
  const dockRef = useRef<HTMLDivElement>(null);
  const magnify = (x: number | null) => {
    dockRef.current?.querySelectorAll<HTMLElement>('.neox-sidebar__tool').forEach((b) => {
      if (x == null) { b.style.removeProperty('--mag'); return; }
      const r = b.getBoundingClientRect();
      const d = Math.abs(x - (r.left + r.width / 2)) / r.width;
      b.style.setProperty('--mag', String(1 + 0.2 * Math.max(0, 1 - d / 1.6)));
    });
  };

  /* ── 小面板: 停 450ms 才出, 移到面板上不关, 离开 250ms 后关 ── */
  const clearPeekTimer = () => { if (peekTimer.current) { window.clearTimeout(peekTimer.current); peekTimer.current = null; } };
  const armPeek = (id: string, el: HTMLElement) => {
    clearPeekTimer();
    if (!PEEK_TOOLS.has(id)) { peekTimer.current = window.setTimeout(() => setPeek(null), 120); return; }
    peekTimer.current = window.setTimeout(() => { hideTip(); setPeek({ id, rect: el.getBoundingClientRect() }); }, peek ? 80 : PEEK_DELAY);
  };
  const disarmPeek = () => { clearPeekTimer(); peekTimer.current = window.setTimeout(() => setPeek(null), 250); };
  useEffect(() => () => { clearPeekTimer(); if (tipTimer.current) window.clearTimeout(tipTimer.current); }, []);

  const menuItems: ContextMenuItem[] = [
    { id: 'head', header: true, label: zh ? '工具架' : 'Tool shelf', subtitle: zh ? '勾选要摆上的; 图标可以拖着换位置' : 'Pick what sits on the shelf; drag icons to reorder' },
    { separator: true },
    ...ordered.map((t) => {
      const on = !prefs.hidden.includes(t.id);
      return {
        id: `t-${t.id}`,
        label: t.label,
        icon: on ? <IconCheck /> : <span style={{ display: 'inline-block', width: 14 }} />,
        /* 至少留一个, 不然台面空了右键都没地方点 */
        disabled: on && shown.length <= 1,
        onClick: () => update({ ...prefs, hidden: on ? [...prefs.hidden, t.id] : prefs.hidden.filter((h) => h !== t.id) }),
      };
    }),
    { separator: true },
    { id: 'reset', label: zh ? '恢复默认' : 'Reset to default', onClick: () => update({ order: [], hidden: [] }) },
  ];

  const peekTool = peek ? shown.find((t) => t.id === peek.id) : undefined;

  return (
    <>
      <div
        ref={dockRef}
        className="neox-sidebar__dock"
        role="toolbar"
        aria-label={zh ? '工具架' : 'Tool shelf'}
        onMouseMove={(e) => { if (!dragId) magnify(e.clientX); }}
        onMouseLeave={() => { magnify(null); disarmPeek(); hideTip(); }}
        onContextMenu={(e) => { e.preventDefault(); setPeek(null); hideTip(); setMenu({ x: e.clientX, y: e.clientY }); }}
      >
        {shown.map((t, i) => {
          const badge = badges[t.id];
          const ext = extOver?.id === t.id ? extOver : null;
          const cls = [
            'neox-sidebar__tool',
            active === t.id && 'is-active',
            t.unavailable && 'is-unavailable',
            overId === t.id && dragId && dragId !== t.id && 'is-drop',
            dragId === t.id && 'is-dragging',
            ext && 'is-catching',
            peek?.id === t.id && 'is-peek',
          ].filter(Boolean).join(' ');
          return (
            <button
              key={t.id}
              type="button"
              className={cls}
              onClick={() => { setPeek(null); hideTip(); t.onClick?.(); }}
              disabled={t.disabled}
              aria-label={t.label}
              draggable
              onMouseEnter={(e) => { if (!peek) showTip(t.id, e.currentTarget); armPeek(t.id, e.currentTarget); }}
              onDragStart={(e) => { magnify(null); setPeek(null); hideTip(); setDragId(t.id); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => {
                if (dragId) { e.preventDefault(); setOverId(t.id); return; }
                const types = Array.from(e.dataTransfer.types);
                if (!acceptsDrop(t.id, types)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                if (extOver?.id !== t.id) setExtOver({ id: t.id, types });
              }}
              onDragLeave={() => { setOverId((cur) => (cur === t.id ? null : cur)); setExtOver((cur) => (cur?.id === t.id ? null : cur)); }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId) { drop(t.id); setDragId(null); setOverId(null); return; }
                setExtOver(null);
                void handleDrop(t.id, e.dataTransfer, { zh, selectSession: onSelectSession, openImageStudio: onOpenImageStudio });
              }}
              onDragEnd={() => { setDragId(null); setOverId(null); }}
            >
              <span className="neox-sidebar__tool-icon">
                <img src={TOOL_ICONS[t.id]} alt="" draggable={false} />
                {badge?.count != null && <span className="neox-sidebar__tool-badge">{badge.count > 99 ? '99+' : badge.count}</span>}
                {badge?.alert && <span className="neox-sidebar__tool-alert" aria-label={badge.title} />}
              </span>
              <span className="neox-sidebar__tool-label">
                {ext ? dropHint(t.id, ext.types, zh) : t.label}
              </span>
            </button>
          );
        })}
      </div>
      {tip && !peek && !menu && (() => {
        const i = shown.findIndex((t) => t.id === tip.id);
        const t = shown[i];
        if (!t) return null;
        /* 副标题取 title 里的说明部分: 「知识库 — 长期记忆」取破折号后, 「团队 · Team 集群」取点后,
         * 「图片工作台 (直连出图, 不占对话)」取括号里; 都没有就只显示名字 */
        const m = t.title.match(/ — (.+)$/) ?? t.title.match(/ · (.+)$/) ?? t.title.match(/[(（]([^)）]+)[)）]\s*$/);
        const sub = m ? m[1] : '';
        const badge = badges[t.id];
        return createPortal(
          <div className="neox-tooltip" role="tooltip" style={{ left: tip.rect.left + tip.rect.width / 2, bottom: window.innerHeight - tip.rect.top + 8 }}>
            <span>{t.label}</span>
            {sub && <span className="neox-tooltip__sub">{sub}</span>}
            {badge?.alert && <span className="neox-tooltip__alert">{badge.title}</span>}
            {i < 9 && <kbd className="neox-tooltip__kbd">{keyLabel(i)}</kbd>}
          </div>,
          document.body,
        );
      })()}
      {peek && peekTool && (
        <SidebarToolPeek
          toolId={peek.id}
          title={peekTool.label}
          anchor={peek.rect}
          zh={zh}
          /* 页面已经开着就别再点 —— 托盘按钮是开关, 再点一次会把它关掉 */
          onManage={() => { if (active !== peekTool.id) peekTool.onClick?.(); }}
          onClose={() => setPeek(null)}
          onEnter={clearPeekTimer}
          onLeave={disarmPeek}
          onChanged={() => { void refreshBadges(); }}
        />
      )}
      {menu && <ContextMenu position={menu} items={menuItems} onClose={() => setMenu(null)} />}
    </>
  );
};

export default SidebarToolDock;
