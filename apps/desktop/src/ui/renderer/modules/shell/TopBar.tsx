import React, { useEffect, useLayoutEffect, useRef as useRefR, useState } from 'react';
import ReactDOM from 'react-dom';
import { IconSearch, IconPanelRight, IconPanelLeft, IconCheck, IconSun } from './shellIcons';
import { usePanelLayout, setPanelLayout, useActivePanelTab, setActiveTab, type PanelLayoutMode, type PanelTab } from '../../state/panelLayoutStore';
import { TopBarSlotHost, useTopBarSlotOccupant } from './TopBarSlot';
import HelpMenu from './HelpMenu';
import { UiSlot } from './uiSlots';
import RunningSessionsPeek from './RunningSessionsPeek';
import ClayIsland from './ClayIsland';
import { NeoxModePicker } from './NeoxModePicker';
import { useAgentModeVariant } from '../../hooks/useAgentModeVariant';
import { useExclusivePopover } from '../../hooks/useExclusivePopover';
import { useAppStore } from '../../../state/appStore';
import { THEME_PACKS, packsByCategory, CATEGORY_INFO } from '../../../state/themePacks';
import { useI18n } from '../../hooks/useI18n';

/** 主题选择 — 调色盘 */
const IconPalette: React.FC<{ size?: number }> = ({ size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3a9 9 0 1 0 0 18 2 2 0 0 0 1.6-3.2 2 2 0 0 1 1.6-3.2H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3Z" />
    <circle cx="8" cy="10" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="16" cy="10" r="1" fill="currentColor" stroke="none" />
  </svg>
);

/* ThemeMenuRow — 主题面板唯一的行原语。
 *   刻意直接复用 ContextMenu 的 class (.neox-context-menu-item / -icon / -label),
 *   而不是再写一套 .neox-topbar__theme-opt: 面板的圆角/行高/hover/图标槽宽度
 *   由 components/context-menu.css 一处定义, 改一次全部菜单一起动。
 *   选中态用右侧对勾 (macOS 菜单惯例), 不再用单选圆圈 + 整块底色。 */

const ThemeMenuRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  checked?: boolean;
  title?: string;
  onClick: () => void;
}> = ({ icon, label, checked, title, onClick }) => (
  <div
    className={`neox-context-menu-item${checked ? ' is-checked' : ''}`}
    role="menuitemradio"
    aria-checked={!!checked}
    title={title}
    tabIndex={-1}
    onClick={onClick}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
    }}
  >
    <span className="neox-context-menu-icon">{icon}</span>
    <span className="neox-context-menu-label">{label}</span>
    {checked && (
      <span className="neox-context-menu-check" aria-hidden="true"><IconCheck size={14} /></span>
    )}
  </div>
);

/* ?v= 用来强制 Electron 重新拉 PNG (改图后 bump 版本号即可绕过缓存) */
const NEOX_LOGO_URL_DEFAULT = `${import.meta.env.BASE_URL}brand/lockup-dark.png?v=20261022a`;
/* 暗色主题 (muyunqing/songyanmo/haiyue/wumoyan/neonlight/...) 用白字版,
 * 不然品牌紫在深色 wallpaper 上糊掉看不清. */
const NEOX_LOGO_URL_WHITE   = `${import.meta.env.BASE_URL}illustrations/neox-logo-white.png?v=20261022a`;
/* 浅白(liuli legacy preset)暂用默认品牌紫 lockup. */

interface TopBarProps {
  title?: string;
  workTitle?: string;
  agentMode?: 'work' | 'code' | 'pilot' | null;
  onSearch?: () => void;
  /** @deprecated 账户入口已挪到侧栏底部 (SidebarAccountFooter)。留 prop 以免调用方类型报错。 */
  onOpenAccount?: () => void;
  onOpenSettings?: () => void;
  onShowWorkspacePanel?: () => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  rightPanelCollapsed?: boolean;
  onToggleRightPanel?: () => void;
  onGoHome?: () => void;
  /** @deprecated 顶栏入口已去掉; 新建会话走侧栏 / ⌘N。保留 prop 以免调用方类型报错。 */
  onNewSession?: () => void;
}

const ThemeQuickSwitch: React.FC = () => {
  const { themePackId, setThemePack, themeAppearanceMode, setThemeAppearanceMode } = useAppStore();
  const { language } = useI18n();
  const zh = language === 'zh';
  const [open, setOpen] = useState(false);
  const btnRef = useRefR<HTMLButtonElement>(null);
  const menuRef = useRefR<HTMLDivElement>(null);

  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) { setPos(null); return; }
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    /* 打开菜单要把焦点送进去, 否则键盘用户"打开了"但焦点还在触发按钮上,
     * 上下键落不到菜单里。优先落在当前选中项, 跟 macOS 菜单一致。 */
    const focusTimer = window.setTimeout(() => {
      const rows = menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]');
      if (!rows || rows.length === 0) return;
      const checked = [...rows].find(el => el.getAttribute('aria-checked') === 'true');
      (checked ?? rows[0]).focus();
    }, 0);
    window.addEventListener('mousedown', handler);
    window.addEventListener('keydown', esc);
    return () => {
      window.clearTimeout(focusTimer);
      /* 关菜单把焦点还给触发按钮。判据是"焦点掉在 body 上" —— cleanup 跑时 portal
       * 通常已卸载, 判 menuRef.contains(activeElement) 永远不成立。 */
      if (!document.activeElement || document.activeElement === document.body) {
        btnRef.current?.focus();
      }
      window.removeEventListener('mousedown', handler);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  const grouped = packsByCategory(THEME_PACKS);
  const categoryOrder: (keyof typeof grouped)[] = ['basic', 'classic', 'ink', 'aurora', 'cyber'];

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`neox-topbar__iconbtn${open ? ' is-active' : ''}`}
        title={zh ? '切换主题' : 'Switch theme'}
        aria-label={zh ? '切换主题' : 'Switch theme'}
        onClick={() => setOpen(v => !v)}
      >
        <IconSun size={16} />
      </button>
      {open && pos && ReactDOM.createPortal(
        <div
          ref={menuRef}
          className="neox-context-menu neox-theme-menu"
          role="menu"
          aria-label={zh ? '主题' : 'Theme'}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
            e.preventDefault();
            const rows = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
            if (rows.length === 0) return;
            const cur = rows.indexOf(document.activeElement as HTMLElement);
            const next = e.key === 'Home' ? 0
              : e.key === 'End' ? rows.length - 1
              : cur < 0 ? (e.key === 'ArrowDown' ? 0 : rows.length - 1)
              : (cur + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
            rows[next]?.focus();
          }}
          style={{ position: 'fixed', top: pos.top, right: pos.right, maxHeight: 'min(70vh, 560px)', overflowY: 'auto', zIndex: 10000 }}
        >
          <ThemeMenuRow
            icon={<IconSun size={15} />}
            label={zh ? '自动' : 'Auto'}
            checked={themeAppearanceMode === 'auto'}
            title={zh ? '按本地时间在浅白 / 暗夜间切换' : 'Soft White / Midnight by local time'}
            onClick={() => setThemeAppearanceMode('auto')}
          />
          <ThemeMenuRow
            icon={<IconPalette />}
            label={zh ? '手动' : 'Manual'}
            checked={themeAppearanceMode === 'manual'}
            title={zh ? '固定用下面选中的主题' : 'Stay on the theme picked below'}
            onClick={() => setThemeAppearanceMode('manual')}
          />
          <div className="neox-context-menu-separator" />
          {categoryOrder.map((cat) => {
            const packs = grouped[cat];
            if (!packs?.length) return null;
            const meta = CATEGORY_INFO[cat];
            return (
              <React.Fragment key={cat}>
                <div className="neox-context-menu-grouphead">{zh ? meta.zh : meta.en}</div>
                {packs.map((p) => (
                  <ThemeMenuRow
                    key={p.id}
                    icon={(
                      <span
                        className="neox-theme-menu__swatch"
                        style={{ background: `linear-gradient(135deg, ${p.swatch[0]} 0%, ${p.swatch[1]} 50%, ${p.swatch[2]} 100%)` }}
                      />
                    )}
                    label={zh ? p.name.zh : p.name.en}
                    checked={themePackId === p.id}
                    onClick={() => { setThemePack(p.id); setOpen(false); }}
                  />
                ))}
              </React.Fragment>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
};

/* ============================================================
 * TopBar — 顶部 52px
 *   左: 模式切换器 + 侧栏开关
 *   中: 当前会话/页面标题
 *   右: 运行中会话 · 搜索 · 通知 · 主题 · 版面
 * ============================================================ */
const TopBarImpl: React.FC<TopBarProps> = ({
  title = 'Neox Agent',
  workTitle,
  agentMode,
  onSearch,
  onOpenSettings,
  onShowWorkspacePanel,
  sidebarCollapsed = false,
  onToggleSidebar,
  rightPanelCollapsed = false,
  onToggleRightPanel,
  onGoHome,
}) => {
  const modeVariant = useAgentModeVariant();
  const showBrandPicker = true;
  const { themePreset, darkMode } = useAppStore();
  const { language } = useI18n();
  const zh = language === 'zh';
  const isDark = darkMode === 'dark';
  /* 顶栏坐在画布上, 浅色一律深色 logo、深色一律白字标。 */
  const logoUrl = isDark ? NEOX_LOGO_URL_WHITE : NEOX_LOGO_URL_DEFAULT;

  const sidebarToggleTitle = zh
    ? (sidebarCollapsed ? '展开侧栏' : '收起侧栏')
    : (sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar');
  const sidebarToggleAria = zh ? '切换侧栏' : 'Toggle sidebar';

  const slotOccupant = useTopBarSlotOccupant();
  const hasHoistedTabs = slotOccupant !== null;
  const pilot = agentMode === 'pilot';

  return (
    <div
      className={`neox-topbar neox-shell__topbar${hasHoistedTabs ? ' has-hoisted-tabs' : ''}`}
      role="banner"
    >
      {/* 岛: Agent 状态只看这一处 (UI 3.0)。Surface 标签提到顶栏时让位, Pilot 有自己的舞台 */}
      {!hasHoistedTabs && !pilot && <ClayIsland />}
      <div className="neox-topbar__left">
        {showBrandPicker ? (
          <NeoxModePicker currentMode={agentMode ?? null} />
        ) : onGoHome ? (
          <button
            type="button"
            className="neox-topbar__brand neox-topbar__brand--home"
            onClick={onGoHome}
            title={zh ? '回主界面' : 'Go to home'}
            aria-label={zh ? '回主界面' : 'Go to home'}
          >
            <img
              className="neox-topbar__logo neox-topbar__logo--lockup"
              src={logoUrl}
              alt={title}
            />
          </button>
        ) : (
          <div className="neox-topbar__brand">
            <img
              className="neox-topbar__logo neox-topbar__logo--lockup"
              src={logoUrl}
              alt={title}
            />
          </div>
        )}
        {onToggleSidebar && !pilot && (
          <button
            type="button"
            className={`neox-topbar__iconbtn neox-topbar__sidebar-toggle${sidebarCollapsed ? '' : ' is-active'}`}
            title={sidebarToggleTitle}
            aria-label={sidebarToggleAria}
            onClick={onToggleSidebar}
          >
            <IconPanelLeft />
          </button>
        )}
      </div>

      <div className="neox-topbar__center">
        {/* 会话标题不再放顶栏 (UI 3.0 设计稿: 顶栏只有 模式 · 岛 · 搜索 · 通知; 标题在侧栏选中行上已经有了) */}
        {/* 内容区那条 tab 行 (编辑器 tab / Surface tab) 的落点 —— 见 TopBarSlot.tsx。
            合并成一行以后, 顶栏左半 = 当前这一块是什么, 右半 = 按钮。 */}
        <TopBarSlotHost />
      </div>

      <div className="neox-topbar__right">
        {/* 运行配置控件已挪到 Services Surface — 这里的下拉跟服务面板功能重复, 且服务面板信息密度
         * 高得多 (列表 + 详情 + 日志 + 编辑表单). 顶栏只留快捷搜索 / 通知 / 帮助 / 右栏开关. */}
        <RunningSessionsPeek />
        {/* Surface 开关: 搜索左边, 常驻 (见 RightPanelToggleButton) */}
        {!pilot && (
          <RightPanelToggleButton
            plain={modeVariant.isWork}
            rightPanelCollapsed={rightPanelCollapsed}
            onToggleRightPanel={onToggleRightPanel}
            zh={zh}
          />
        )}
        <button
          type="button"
          className="neox-topbar__iconbtn"
          title={zh ? '搜索' : 'Search'}
          aria-label={zh ? '搜索' : 'Search'}
          onClick={onSearch}
        >
          <IconSearch />
        </button>
        <UiSlot name="topbar.notifications" props={{}} />

      </div>
    </div>
  );
};

const TaskDetailFlatEntry: React.FC<{ zh: boolean }> = ({ zh }) => {
  const { surfaceStyle } = useAppStore();
  if (surfaceStyle !== 'flat') return null;
  return (
    <button
      type="button"
      className="neox-topbar__iconbtn"
      data-task-detail-trigger="1"
      title={zh ? '任务详情 — token / checkpoints / 最近工具' : 'Task details — tokens / checkpoints / recent tools'}
      aria-label={zh ? '任务详情' : 'Task details'}
      onClick={(e) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        window.dispatchEvent(new CustomEvent('neox:toggle-task-detail', {
          detail: { anchor: { top: rect.bottom, right: window.innerWidth - rect.right } },
        }));
      }}
    >
      <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.26" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="7" cy="7" r="5.5" />
        <path d="M7 6.2 V10" />
        <circle cx="7" cy="4.2" r=".7" fill="currentColor" stroke="none" />
      </svg>
    </button>
  );
};

interface RightPanelToggleButtonProps {
  plain: boolean;
  rightPanelCollapsed: boolean;
  onToggleRightPanel?: () => void;
  zh: boolean;
}

const layoutPopWidth = (cells: number) => cells * 64 + (cells - 1) * 4 + 18;

const RightPanelToggleButton: React.FC<RightPanelToggleButtonProps> = ({
  plain, rightPanelCollapsed, onToggleRightPanel, zh,
}) => {
  /* 右栏叫什么, 按模式分档 (Work=右侧画布 / Code=Surface 画布) */
  const rightPanelName = plain
    ? (zh ? '右侧画布' : 'Right Canvas')
    : (zh ? 'Surface 画布' : 'Surface Canvas');

  /* ⬆️ 上面那颗切换器 (PanelTabSwitch) 定义在文件末尾, 见它自己的说明。 */
  const layout = usePanelLayout();
  const panelTab = useActivePanelTab();
  const [pop, setPop] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRefR<HTMLButtonElement>(null);
  const popRef = useRefR<HTMLDivElement>(null);

  useEffect(() => {
    if (!pop) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setPop(null);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPop(null); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onEsc);
    };
  }, [pop]);

  const OPTIONS: { id: PanelLayoutMode; tab?: PanelTab; title: string; label: string }[] = [
    { id: 'split', title: zh ? `对话在左 · ${rightPanelName}在右` : `Chat left · ${rightPanelName} right`, label: zh ? '对话在左' : 'Chat left' },
    { id: 'swap',  title: zh ? `${rightPanelName}在左 · 对话在右` : `${rightPanelName} left · Chat right`, label: zh ? '对话在右' : 'Chat right' },
    { id: 'float', title: zh ? `${rightPanelName}悬浮 · 可拖动、可拉伸` : `${rightPanelName} floating · drag to move`, label: zh ? '悬浮' : 'Floating' },
  ];

  /* 收起只在左右并排的两种版面下有意义 —— 叠放本来就是"只看其中一块"。 */
  /* 悬浮也能收起 (收起 = 把浮层藏掉) */
  const showCollapseCell = layout !== 'tabs' && !!onToggleRightPanel;
  const collapsedActive = showCollapseCell && rightPanelCollapsed;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`neox-topbar__iconbtn neox-topbar__layoutbtn${pop ? ' is-active' : ''}${!rightPanelCollapsed ? ' is-on' : ''}`}
        title={rightPanelCollapsed
          ? (zh ? `打开${rightPanelName}` : `Open ${rightPanelName}`)
          : (zh ? `收起${rightPanelName}` : `Hide ${rightPanelName}`)}
        aria-label={zh ? `开关${rightPanelName}` : `Toggle ${rightPanelName}`}
        aria-pressed={!rightPanelCollapsed}
        onClick={() => {
          setPop(null);
          /* Surface 正「展开铺满」(借用 tabs) 时点它 = 回到并排, 对话跟 Surface 都看得见 */
          if (layout === 'tabs') { setPanelLayout('split'); return; }
          onToggleRightPanel?.();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (pop) { setPop(null); return; }
          const r = btnRef.current?.getBoundingClientRect();
          if (!r) return;
          const half = layoutPopWidth(OPTIONS.length + (showCollapseCell ? 1 : 0)) / 2;
          const cx = r.left + r.width / 2;
          const x = Math.round(Math.min(Math.max(cx, half + 8), window.innerWidth - half - 8));
          setPop({ x, y: Math.round(r.bottom + 8) });
        }}
      >
        <IconPanelRight />
      </button>
      {pop && ReactDOM.createPortal(
        <div
          ref={popRef}
          className="neox-layout-pop"
          style={{ position: 'fixed', top: pop.y, left: pop.x, transform: 'translateX(-50%)' }}
          role="group"
          aria-label={zh ? '版面' : 'Layout'}
        >
          {OPTIONS.map((o) => {
            /* 收起态下四个版面格子都不该点亮 —— 版面偏好还留着, 但用户现在看到的
             * 就是"只有对话", 高亮某个分屏摆法会跟眼前的画面对不上。 */
            const on = !collapsedActive && layout === o.id && (!o.tab || panelTab === o.tab);
            return (
              <button
                key={`${o.id}:${o.tab ?? ''}`}
                type="button"
                className={`neox-layout-pop__opt${on ? ' is-on' : ''}`}
                title={o.title}
                aria-label={o.title}
                aria-pressed={on}
                onClick={() => {
                  setPanelLayout(o.id);
                  if (o.tab) setActiveTab(o.tab);
                  /* 右栏收起时选了要用它的版面, 顺手展开 —— 否则选了像没反应 */
                  if (rightPanelCollapsed) onToggleRightPanel?.();
                  setPop(null);
                }}
              >
                <PanelLayoutGlyph mode={o.id} tab={o.tab} />
                <span className="neox-layout-pop__label">{o.label}</span>
              </button>
            );
          })}
          {showCollapseCell && (
            <button
              type="button"
              className={`neox-layout-pop__opt${collapsedActive ? ' is-on' : ''}`}
              title={zh ? `收起${rightPanelName} · 只看对话` : `Collapse ${rightPanelName} · chat only`}
              aria-label={zh ? `收起${rightPanelName}` : `Collapse ${rightPanelName}`}
              aria-pressed={collapsedActive}
              onClick={() => {
                /* 已经收起了就不再切 —— 这一格表达的是"状态", 不是开关。
                 * 想展开就去点某个分屏版面, 那条路已经带自动展开了。 */
                if (!collapsedActive) onToggleRightPanel();
                setPop(null);
              }}
            >
              <PanelLayoutGlyph mode={layout} collapsed />
              <span className="neox-layout-pop__label">{zh ? '收起画布' : 'Hide canvas'}</span>
            </button>
          )}
        </div>,
        document.body,
      )}
    </>
  );
};

/**
 * 版面示意图 —— 照 macOS 绿灯的 Move & Resize 那一套: 一个描边圆角"窗口",
 * 里面用实心块标出哪一半是 Surface。叠放的两个格子画成整块填满 (只看那一块)。
 */
const PanelLayoutGlyph: React.FC<{ mode: PanelLayoutMode; tab?: PanelTab; collapsed?: boolean }> = ({ mode, tab, collapsed }) => (
  <svg width="26" height="20" viewBox="0 0 26 20" fill="none" aria-hidden="true">
    <rect x="1.25" y="1.25" width="23.5" height="17.5" rx="3.2" stroke="currentColor" strokeWidth="1.6" />
    {/* 收起: 空窗口, 一块都不填 —— 画布没了, 整块都是对话 */}
    {collapsed && null}
    {!collapsed && mode === 'split' && <rect x="13.4" y="2.9" width="10.2" height="14.2" rx="2" fill="currentColor" />}
    {!collapsed && mode === 'swap' && <rect x="2.4" y="2.9" width="10.2" height="14.2" rx="2" fill="currentColor" />}
    {!collapsed && mode === 'float' && <rect x="10.4" y="5.4" width="11.6" height="9.6" rx="2" fill="currentColor" />}
    {!collapsed && mode === 'tabs' && tab === 'surface' && <rect x="2.4" y="2.9" width="21.2" height="14.2" rx="2" fill="currentColor" />}
    {!collapsed && mode === 'tabs' && tab === 'timeline' && (
      <rect x="2.4" y="2.9" width="21.2" height="14.2" rx="2" fill="currentColor" opacity=".28" />
    )}
  </svg>
);

export const TopBar = React.memo(TopBarImpl);
TopBar.displayName = 'TopBar';

export default TopBar;
