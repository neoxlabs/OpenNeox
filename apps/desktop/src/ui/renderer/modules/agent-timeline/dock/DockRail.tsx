import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { sortDockPills, type DockPill } from './dockTypes';

/** attention 药丸展开成"宽形态"停留多久, 然后缩回普通药丸 (颜色保留) */
const ATTENTION_EXPAND_MS = 6_000;
/** ⋯ 按钮预留宽度 (含 gap) —— 量不准也没关系, 宁可保守多留 */
const MORE_BTN_W = 80; /* 「还有 N 项 ⌄」 */
/** 项之间的 gap, 跟 dock.css 末尾「安静的一行」里 .nx-dock__rail 的 gap 保持一致 */
const RAIL_GAP = 14;

const ChevronIcon: React.FC<{ open?: boolean }> = ({ open }) => (
  <svg viewBox="0 0 14 14" width="10" height="10" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .16s ease' }}>
    <path d="M3.5 5.5 L7 9 L10.5 5.5" />
  </svg>
);

/* ── 单颗药丸 ───────────────────────────────────────────── */

const Pill: React.FC<{
  pill: DockPill;
  expanded: boolean;   /* attention 形变: 显示 detail */
  panelOpen: boolean;
  onToggle: () => void;
  measuring?: boolean;
}> = ({ pill, expanded, panelOpen, onToggle, measuring }) => {
  const cls = [
    'nx-dock__pill',
    `is-${pill.tone}`,
    expanded ? 'is-attn' : '',
    panelOpen ? 'is-open' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cls} data-pill-id={pill.id}>
      <button
        type="button"
        className="nx-dock__pill-main"
        onClick={measuring ? undefined : onToggle}
        aria-label={pill.ariaLabel ?? pill.label}
        aria-expanded={pill.panel ? panelOpen : undefined}
        title={pill.detail ? `${pill.label} · ${pill.detail}` : pill.label}
        tabIndex={measuring ? -1 : 0}
      >
        <span className="nx-dock__pill-icon" aria-hidden="true">{pill.icon}</span>
        <span className="nx-dock__pill-label">{pill.label}</span>
        {pill.meta && <span className="nx-dock__pill-meta">{pill.meta}</span>}
        {/* detail 只在 attention 形变期出现 —— 药丸"突然变长"本身就是提醒信号 */}
        {expanded && pill.detail && <span className="nx-dock__pill-detail">{pill.detail}</span>}
      </button>
      {pill.actions?.map((a) => (
        <button
          key={a.id}
          type="button"
          className={[
            'nx-dock__pill-act',
            a.label ? 'is-text' : '',
            a.primary ? 'is-primary' : '',
            a.danger ? 'is-danger' : '',
          ].filter(Boolean).join(' ')}
          title={a.title}
          aria-label={a.title}
          onClick={measuring ? undefined : (e) => { e.stopPropagation(); a.onClick(); }}
          tabIndex={measuring ? -1 : 0}
        >
          {a.label ?? a.icon}
        </button>
      ))}
      {pill.panel && (
        <span className="nx-dock__pill-chev" aria-hidden="true"><ChevronIcon open={panelOpen} /></span>
      )}
    </div>
  );
};

/* ── 主组件 ─────────────────────────────────────────────── */

export const DockRail: React.FC<{ pills: DockPill[] }> = ({ pills }) => {
  const { isZh } = useI18n();
  const sorted = useMemo(() => sortDockPills(pills), [pills]);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  /* 量宽度必须量 rail 不是 wrap —— wrap 带着居中限宽用的左右 padding,
   * clientWidth 把 padding 也算进去, 会让"塞得下几颗"多估近百像素。 */
  const railRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const [visibleCount, setVisibleCount] = useState(sorted.length);
  const [openPanelId, setOpenPanelId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  /* attention 形变: 新出现的 attention 药丸撑开 detail 几秒, 然后缩回去 (颜色保留) */
  const [attnExpanded, setAttnExpanded] = useState<Set<string>>(() => new Set());
  const attnSeenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const live = new Set(sorted.filter(p => p.attention && p.expandDetail !== false).map(p => p.id));
    /* 已经不在了的, 从记忆里摘掉 —— 同 id 再次进入 attention 时应该重新播一次形变 */
    for (const id of Array.from(attnSeenRef.current)) {
      if (!live.has(id)) attnSeenRef.current.delete(id);
    }
    const fresh = Array.from(live).filter(id => !attnSeenRef.current.has(id));
    if (fresh.length === 0) return;
    fresh.forEach(id => attnSeenRef.current.add(id));
    setAttnExpanded(prev => {
      const next = new Set(prev);
      fresh.forEach(id => next.add(id));
      return next;
    });
    const timer = window.setTimeout(() => {
      setAttnExpanded(prev => {
        const next = new Set(prev);
        fresh.forEach(id => next.delete(id));
        return next;
      });
    }, ATTENTION_EXPAND_MS);
    return () => window.clearTimeout(timer);
  }, [sorted]);

  /* 量宽度 —— 镜像里每颗药丸的自然宽度, 按序累加看容器塞得下几颗。
   * 依赖签名带上 label/meta/展开态: 计时数字每秒变宽度也变, 不重量就会出现
   * "明明放得下却收进了 ⋯" 或者反过来溢出被裁。 */
  const signature = sorted
    .map(p => `${p.id}|${p.label}|${p.meta ?? ''}|${attnExpanded.has(p.id) ? 'x' : ''}`)
    .join('~');

  const remeasure = useCallback(() => {
    const rail = railRef.current;
    const mirror = mirrorRef.current;
    if (!rail || !mirror) return;
    const avail = rail.clientWidth;
    if (avail <= 0) return;
    const widths = Array.from(mirror.children).map(c => (c as HTMLElement).offsetWidth);
    if (widths.length === 0) return;

    /* 先试"全放得下" */
    const totalAll = widths.reduce((s, w) => s + w, 0) + RAIL_GAP * (widths.length - 1);
    if (totalAll <= avail) { setVisibleCount(widths.length); return; }

    /* 放不下: 留出 ⋯ 的位置再算 */
    const budget = avail - MORE_BTN_W;
    let used = 0;
    let n = 0;
    for (const w of widths) {
      const next = used + (n > 0 ? RAIL_GAP : 0) + w;
      if (next > budget) break;
      used = next;
      n++;
    }
    setVisibleCount(Math.max(1, n)); /* 至少留一颗 —— 一颗都不显示的 rail 没有意义 */
  }, []);

  useLayoutEffect(() => { remeasure(); }, [signature, remeasure]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => remeasure());
    ro.observe(rail);
    return () => ro.disconnect();
  }, [remeasure]);

  /* 浮层 (胶囊点开的那张) 和 ⋯ 菜单: 点外面 / Esc 关。摊在下面的 inline 面板 (askUser) 不归这里管。 */
  const openIsPopover = !!openPanelId && !sorted.find(p => p.id === openPanelId)?.panelInline;
  useEffect(() => {
    if (!menuOpen && !openIsPopover) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
      if (openIsPopover) setOpenPanelId(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuOpen(false);
      if (openIsPopover) setOpenPanelId(null);
    };
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onEsc);
    return () => { window.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onEsc); };
  }, [menuOpen, openIsPopover]);

  /* 浮层左边对齐它那颗胶囊; 放不下就往左收, 不顶出列 */
  const [popLeft, setPopLeft] = useState(0);
  useLayoutEffect(() => {
    if (!openIsPopover) return;
    const wrap = wrapRef.current;
    const pill = wrap?.querySelector<HTMLElement>(`.nx-dock__rail [data-pill-id="${CSS.escape(openPanelId!)}"]`);
    const pop = wrap?.querySelector<HTMLElement>('.nx-dock__pop');
    if (!wrap || !pill) return;
    const wr = wrap.getBoundingClientRect();
    const pr = pill.getBoundingClientRect();
    const w = pop?.offsetWidth ?? 340;
    setPopLeft(Math.max(0, Math.min(pr.left - wr.left, wr.width - w)));
  }, [openIsPopover, openPanelId, signature]);

  /* 药丸消失了, 它开着的面板也得关 */
  useEffect(() => {
    if (openPanelId && !sorted.some(p => p.id === openPanelId)) setOpenPanelId(null);
  }, [sorted, openPanelId]);

  const autoOpenSeenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const live = new Set(sorted.filter(p => p.autoOpenPanel && p.panel).map(p => p.id));
    for (const id of Array.from(autoOpenSeenRef.current)) {
      if (!live.has(id)) autoOpenSeenRef.current.delete(id);
    }
    const fresh = Array.from(live).filter(id => !autoOpenSeenRef.current.has(id));
    if (fresh.length === 0) return;
    fresh.forEach(id => autoOpenSeenRef.current.add(id));
    setOpenPanelId(cur => cur ?? fresh[0]);
  }, [sorted]);

  if (sorted.length === 0) return null;

  const visible = sorted.slice(0, visibleCount);
  const overflow = sorted.slice(visibleCount);
  const openPill = sorted.find(p => p.id === openPanelId && p.panel);

  const activate = (p: DockPill) => {
    setMenuOpen(false);
    if (p.panel) setOpenPanelId(id => (id === p.id ? null : p.id));
    p.onActivate?.();
  };

  return (
    <div className="nx-dock" ref={wrapRef} role="status" aria-live="polite">
      <div className="nx-dock__rail" ref={railRef}>
        {visible.map(p => (
          <Pill
            key={p.id}
            pill={p}
            expanded={attnExpanded.has(p.id)}
            panelOpen={openPanelId === p.id}
            onToggle={() => activate(p)}
          />
        ))}
        {overflow.length > 0 && (
          <button
            type="button"
            className={`nx-dock__more${menuOpen ? ' is-open' : ''}${overflow.some(p => p.attention) ? ' is-attn' : ''}`}
            onClick={() => setMenuOpen(v => !v)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            title={isZh ? `还有 ${overflow.length} 项进行中` : `${overflow.length} more in progress`}
            aria-label={isZh ? `还有 ${overflow.length} 项进行中` : `${overflow.length} more in progress`}
          >
            <span className="nx-dock__more-count">{isZh ? `还有 ${overflow.length} 项` : `${overflow.length} more`}</span>
            <ChevronIcon open={menuOpen} />
          </button>
        )}
      </div>

      {/* 离屏镜像 —— 只为量宽度, 不参与布局也不可点 */}
      <div className="nx-dock__mirror" aria-hidden="true" ref={mirrorRef}>
        {sorted.map(p => (
          <Pill key={p.id} pill={p} expanded={attnExpanded.has(p.id)} panelOpen={false} onToggle={() => {}} measuring />
        ))}
      </div>

      {menuOpen && overflow.length > 0 && (
        <div className="nx-dock__menu" role="menu">
          {overflow.map(p => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              className={`nx-dock__menu-item is-${p.tone}`}
              onClick={() => activate(p)}
            >
              <span className="nx-dock__menu-icon" aria-hidden="true">{p.icon}</span>
              <span className="nx-dock__menu-body">
                <span className="nx-dock__menu-label">{p.label}</span>
                {p.detail && <span className="nx-dock__menu-detail">{p.detail}</span>}
              </span>
              {p.meta && <span className="nx-dock__menu-meta">{p.meta}</span>}
            </button>
          ))}
        </div>
      )}

      {openPill && openPill.panelInline && <div className="nx-dock__panel">{openPill.panel}</div>}
      {openPill && !openPill.panelInline && (
        <div
          className={`nx-dock__pop is-${openPill.tone}`}
          role="dialog"
          aria-label={openPill.popTitle ?? openPill.label}
          style={{ left: popLeft }}
        >
          <div className="nx-dock__pop-head">
            <span className="nx-dock__pop-icon" aria-hidden="true">{openPill.icon}</span>
            <span className="nx-dock__pop-title">{openPill.popTitle ?? openPill.label}</span>
            {(openPill.popMeta ?? openPill.meta) && <span className="nx-dock__pop-meta">{openPill.popMeta ?? openPill.meta}</span>}
            <button
              type="button"
              className="nx-dock__pop-close"
              aria-label={isZh ? '收起' : 'Close'}
              onClick={() => setOpenPanelId(null)}
            >
              <svg viewBox="0 0 14 14" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" /></svg>
            </button>
          </div>
          <div className="nx-dock__pop-body">{openPill.panel}</div>
        </div>
      )}
    </div>
  );
};

export default DockRail;
