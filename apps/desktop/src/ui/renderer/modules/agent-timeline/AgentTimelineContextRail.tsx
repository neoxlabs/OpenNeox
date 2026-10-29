/**
 * AgentTimelineContextRail — Cursor 式 timeline 内右侧上下文栏
 *
 * 独立于 Surface：仅在壳层 Surface 收起时由 AgentTimelineView 挂载。
 * 点行再通过现有 neox:open-surface / openKindHome 打开 Surface 看内容。
 *
 * 「产物」那一节需要当前会话的 timeline entries 才能算 (membership 见
 * hooks/useRecentArtifacts.ts) —— 由 AgentTimelineView 传进来, 它已经挡掉了
 * "feed 还压着上一个会话" 的残影。本组件不去读 feed store 是为了不重复那份判断。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNeoxRuntime } from '../../app/NeoxRuntimeContext';
import { FileTypeIcon } from '../../components/FileTypeIcon';
import { useGitState } from '../../hooks/useGitState';
import { useEnterTransition } from '../../hooks/useEnterTransition';
import { useI18n } from '../../hooks/useI18n';
import { useAgentModeVariant } from '../../hooks/useAgentModeVariant';
import { openKindHome } from '../../state/openKindHome';
import {
  isSurfaceLive,
  setActiveSurface,
  useActiveSurfaceId,
  useSurfaces,
  type Surface,
  type SurfaceKind,
} from '../../state/surfaceStore';
import {
  AgentTimelineContextRailPreview,
  type RailPreviewAnchor,
  type RailPreviewTarget,
} from './AgentTimelineContextRailPreview';
import { useRecentArtifacts } from './hooks/useRecentArtifacts';
import type { TimelineEntry } from '../../utils/workspaceUtils';
import { displayWorkspaceName } from '../../utils/modeHomeName';
import { useContextRailHidden } from './timelinePreferences';
import { openSurfaceFromPath } from '../../state/openSurfaceFromPath';
import { railSeenFor, useRailFirstTimeHint, RailHintBubble } from './railFreshHint';
import { usePluginViews } from '../pluginViews/usePluginViews';
import { PluginLogo } from '../pluginViews/PluginViewIcon';
import { usePluginViewIcon } from '../pluginViews/usePluginViewIcon';
import { openPluginView } from '../pluginViews/openPluginView';
import './agent-timeline-context-rail.css';

const ICON = 14;

/* 悬停多久才弹卡: 太短会在划过一列时连闪好几张。离开留一点宽限期, 让鼠标能走进卡片里。 */
const PREVIEW_OPEN_DELAY_MS = 320;
const PREVIEW_CLOSE_DELAY_MS = 140;

const mk = (path: React.ReactNode) => (
  <svg viewBox="0 0 24 24" width={ICON} height={ICON} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

const IconGlobe = mk(<><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></>);
const IconTerminal = mk(<><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></>);
const IconFiles = mk(<><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></>);
const IconChanges = mk(<><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 9v12" /><path d="M18 6v5" /><path d="M6 6h6a4 4 0 0 1 4 4" /></>);

function kindLabel(kind: SurfaceKind, isZh: boolean): string {
  const zh: Partial<Record<SurfaceKind, string>> = {
    web: '浏览器', files: '文件', git: '改动', services: '服务', code: '源码',
    diff: 'Diff', doc: '文档', plan: '方案', todo: '清单', sheet: '表格',
    pdf: 'PDF', docx: 'Word', pptx: 'PPT', team: '团队', image: '图片',
  };
  const en: Partial<Record<SurfaceKind, string>> = {
    web: 'Browser', files: 'Files', git: 'Changes', services: 'Services',
  };
  return (isZh ? zh[kind] : en[kind]) || kind;
}

function tabTitle(s: Surface, isZh: boolean): string {
  const meta = (s.metadata ?? {}) as { tabs?: Array<{ id?: string; url?: string; title?: string }>; activeTabId?: string };
  if (Array.isArray(meta.tabs) && meta.tabs.length > 0) {
    const tab = meta.tabs.find((x) => x?.id === meta.activeTabId) ?? meta.tabs[0];
    const name = (tab?.title || '').trim() || (tab?.url || '').split(/[/\\?#]/).filter(Boolean).pop() || '';
    if (name) return decodeURIComponentSafe(name);
  }
  const t = (s.title || '').trim();
  if (t) return t;
  if (s.source.type === 'file') {
    const base = s.source.path.split(/[/\\]/).pop();
    if (base) return base;
  }
  return kindLabel(s.kind, isZh);
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function RailLiveDot({ live, label }: { live: boolean; label: string }): React.ReactNode {
  if (!live) return null;
  return <span className="atl-ctx-rail__live" title={label} aria-label={label} />;
}

function RailRowBadge({ surface, isZh }: { surface: Surface; isZh: boolean }): React.ReactNode {
  const meta = (surface.metadata ?? {}) as Record<string, unknown>;
  if (meta.__streaming === true) {
    return (
      <span className="atl-ctx-rail__badge is-streaming">{isZh ? '渲染中' : 'Rendering'}</span>
    );
  }
  if (surface.kind === 'todo') {
    const items = (meta.todo as { items?: Array<{ status?: string }> } | undefined)?.items
      ?? (meta.items as Array<{ status?: string }> | undefined);
    if (Array.isArray(items) && items.length > 0) {
      const done = items.filter((x) => x?.status === 'done').length;
      return <span className="atl-ctx-rail__badge">{done}/{items.length}</span>;
    }
    return null;
  }
  const tabs = meta.tabs as unknown[] | undefined;
  if (Array.isArray(tabs) && tabs.length > 1) {
    return <span className="atl-ctx-rail__badge">{tabs.length}</span>;
  }
  return null;
}

const KIND_SPECIMEN: Partial<Record<SurfaceKind, string>> = {
  doc: 'document.md',
  plan: 'plan.md',
  todo: 'todo.md',
  diagram: 'diagram.md',
  sheet: 'sheet.xlsx',
  pdf: 'document.pdf',
  docx: 'document.docx',
  pptx: 'deck.pptx',
  html: 'page.html',
  svg: 'image.svg',
  image: 'image.png',
  code: 'source.ts',
  diff: 'change.diff',
};

const IconPlugin = mk(<><path d="M4 7h4a2 2 0 1 1 4 0h4v4a2 2 0 1 1 0 4v4H4z" /></>);

/** 插件面板的图标: 插件品牌 logo > 清单里的 emoji > 通用拼图 */
function pluginViewIcon(pluginName: string | undefined, emoji?: string): React.ReactNode {
  return <PluginLogo pluginName={pluginName} emoji={emoji} fallback={IconPlugin} imgClassName="atl-ctx-rail__appicon" />;
}

/**
 * 插件图标槽: 有 logo 时外圈不再发灰。
 *
 * 原来这条靠 `.atl-ctx-rail__icon:has(> .atl-ctx-rail__appicon)` 判子元素; `:has()`
 * 会让祖先在子节点变化时参与失效重算 (code:TIMELINE-07), 而 logo 是异步取的 ——
 * 改成渲染期 class: 本组件自己用 hook 取 logo, 取到就重渲染并挂 is-app-icon。
 */
function RailIcon({ pluginName, emoji, children }: {
  pluginName?: string;
  emoji?: string;
  children?: React.ReactNode;
}) {
  const logo = usePluginViewIcon(pluginName);
  return (
    <span className={`atl-ctx-rail__icon${logo ? ' is-app-icon' : ''}`}>
      <PluginLogo pluginName={pluginName} emoji={emoji} fallback={IconPlugin} imgClassName="atl-ctx-rail__appicon" />
      {children}
    </span>
  );
}

/** 插件名以地址为准 (neox-plugin://<name>/...) —— 地址就是这个 tab 的身份, metadata 过一遍持久化不一定还在 */
function tabPluginName(s: Surface): string | undefined {
  if (s.kind !== 'plugin') return undefined;
  const fromUrl = s.source.type === 'url' ? /^neox-plugin:\/\/([^/]+)/.exec(s.source.url)?.[1] : undefined;
  return fromUrl ?? (s.metadata as { pluginName?: string } | undefined)?.pluginName;
}

function tabIcon(s: Surface): React.ReactNode {
  if (s.kind === 'plugin') return pluginViewIcon(tabPluginName(s));
  if (s.kind === 'web') return IconGlobe;
  if (s.kind === 'services' || s.kind === 'terminal') return IconTerminal;
  if (s.kind === 'files') return IconFiles;
  if (s.kind === 'git') return IconChanges;
  const name = s.source.type === 'file'
    ? s.source.path
    : (KIND_SPECIMEN[s.kind] ?? 'file.txt');
  return <FileTypeIcon path={name} size={ICON} />;
}

function openSurfaceKind(kind: SurfaceKind, title: string, singleton = true): void {
  window.dispatchEvent(new CustomEvent('neox:open-surface', {
    detail: {
      kind,
      title,
      source: { type: 'inline', content: '', mime: 'text/plain' },
      metadata: singleton ? { singleton: true } : undefined,
      /* 上下文栏是"胶囊"这一侧: 点它就是"我现在要看右边那个" —— 照展。
       * 不点的时候这些 kind 只在这条栏上留一枚胶囊, 不抢右栏 (见 SURFACE_MERGE_POLICY.autoReveal)。 */
      byUser: true,
    },
  }));
}

function requestExpandSurface(sessionId: string, surfaceId?: string): void {
  window.dispatchEvent(new CustomEvent('neox:surface-panel-open-requested', {
    detail: { sessionId, surfaceId },
  }));
}

type DiffStat = { add: number; del: number };

function useWorkspaceDiffStat(cwd: string | undefined): DiffStat {
  const [stat, setStat] = useState<DiffStat>({ add: 0, del: 0 });
  useEffect(() => {
    if (!cwd) {
      setStat({ add: 0, del: 0 });
      return;
    }
    let cancelled = false;
    const pull = async () => {
      try {
        const status = await (window as any).neox?.gitStatus?.(cwd);
        if (cancelled || !status) return;
        let add = 0;
        let del = 0;
        for (const f of status.files || []) {
          if (typeof f.add === 'number') add += f.add;
          if (typeof f.del === 'number') del += f.del;
        }
        setStat({ add, del });
      } catch {
        if (!cancelled) setStat({ add: 0, del: 0 });
      }
    };
    void pull();
    const id = window.setInterval(() => { void pull(); }, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [cwd]);
  return stat;
}

export interface AgentTimelineContextRailProps {
  /**
   * 当前会话的 timeline entries —— 「产物」节的 membership 来源
   * (声明回放, 见 hooks/useRecentArtifacts.ts)。
   * 省略时产物区为空, 其余分节照常。
   */
  entries?: TimelineEntry[];
}

/* 稳定引用 —— 每次新建 [] 会让下游 useMemo 全部失效 */
const EMPTY_ENTRIES: TimelineEntry[] = [];

export const AgentTimelineContextRail: React.FC<AgentTimelineContextRailProps> = ({ entries = EMPTY_ENTRIES }) => {
  const entered = useEnterTransition();
  const runtime = useNeoxRuntime();
  const { isZh } = useI18n();
  /* Work: 「改动」(git) 和「服务」(dev server) 是写代码的概念, 不给不写代码的人看 */
  const { isWork } = useAgentModeVariant();
  const sessionId = runtime.activeSession?.id ?? null;
  const workspacePath = runtime.workspacePath
    || runtime.activeSession?.workspacePath
    || '';
  const surfaces = useSurfaces(sessionId);
  const activeId = useActiveSurfaceId(sessionId);
  const git = useGitState(workspacePath || undefined);
  const diffStat = useWorkspaceDiffStat(workspacePath || undefined);
  const artifacts = useRecentArtifacts({ sessionId, entries, workspacePath: workspacePath || undefined });
  const [, setRailHidden] = useContextRailHidden();

  const projectName = useMemo(() => {
    if (!workspacePath) return isZh ? '工作区' : 'Workspace';
    return displayWorkspaceName(workspacePath, null, isZh);
  }, [workspacePath, isZh]);

  const [now, setNow] = useState(() => Date.now());
  const hasLiveSurface = useMemo(() => surfaces.some((s) => isSurfaceLive(s, now)), [surfaces, now]);
  useEffect(() => {
    if (!hasLiveSurface) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasLiveSurface]);

  const SHELF_KINDS = new Set<SurfaceKind>(['git', 'web', 'services', 'files']);
  const openTabs = useMemo(() => {
    return [...surfaces]
      .filter((s) => !SHELF_KINDS.has(s.kind))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [surfaces]);


  const liveWebSurfaces = useMemo(
    () => surfaces.filter((s) => s.kind === 'web' && isSurfaceLive(s, now)),
    [surfaces, now],
  );

  const kindLive = useMemo(() => ({
    web: liveWebSurfaces.length > 0,
    services: surfaces.some((s) => s.kind === 'services' && isSurfaceLive(s, now)),
    files: surfaces.some((s) => (s.kind === 'files' || s.kind === 'code') && isSurfaceLive(s, now)),
  }), [surfaces, now]);

  const liveLabel = isZh ? '运行中' : 'Running';

  const seen = useMemo(() => railSeenFor(sessionId), [sessionId]);
  const [seenTick, setSeenTick] = useState(0);
  const freshIds = useMemo(() => {
    void seenTick;
    const out = new Set<string>();
    for (const s of openTabs) {
      const t = s.updatedAt || 0;
      if (t > seen.since && t > (seen.at.get(s.id) ?? 0)) out.add(s.id);
    }
    return out;
  }, [openTabs, seen, seenTick]);
  /* 这条栏只在右侧面板收起时才挂着 —— 卸载 = 面板展开了, 里面的东西都看到了 */
  useEffect(() => () => {
    for (const s of surfaces) seen.at.set(s.id, s.updatedAt || Date.now());
  }, [seen, surfaces]);
  const hintId = useRailFirstTimeHint(freshIds);

  const onActivateTab = useCallback((s: Surface) => {
    if (!sessionId) return;
    seen.at.set(s.id, s.updatedAt || Date.now());
    setSeenTick((n) => n + 1);
    setActiveSurface(sessionId, s.id);
    requestExpandSurface(sessionId, s.id);
  }, [sessionId, seen]);

  const onOpenChanges = useCallback(() => {
    openSurfaceKind('git', isZh ? '改动' : 'Changes');
  }, [isZh]);

  const onOpenBrowser = useCallback(async () => {
    let sid = sessionId;
    if (!sid) {
      const s = await runtime.createNewSession?.();
      sid = s?.id ?? null;
    }
    if (!sid) return;
    openKindHome({ sessionId: sid, kind: 'web', title: isZh ? '浏览器' : 'Browser' });
  }, [sessionId, runtime, isZh]);

  const onOpenServices = useCallback(() => {
    openSurfaceKind('services', isZh ? '服务' : 'Services');
  }, [isZh]);

  const onOpenArtifact = useCallback((path: string) => {
    if (!sessionId || !path) return;
    openSurfaceFromPath({ sessionId, path, workspacePath: workspacePath || undefined });
  }, [sessionId, workspacePath]);

  const onOpenFiles = useCallback(() => {
    openSurfaceKind('files', isZh ? '文件' : 'Files');
  }, [isZh]);

  /* 已启用插件贡献的面板 —— 装了带面板的插件, 入口就在这里 */
  const pluginViews = usePluginViews();

  /* ── 悬浮预览 ─────────────────────────────────────────────────────── */
  const [preview, setPreview] = useState<RailPreviewAnchor | null>(null);
  const [railLeft, setRailLeft] = useState(0);
  const railElRef = useRef<HTMLElement | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) { window.clearTimeout(openTimerRef.current); openTimerRef.current = null; }
    if (closeTimerRef.current !== null) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const openPreview = useCallback((el: HTMLElement, target: RailPreviewTarget) => {
    clearTimers();
    openTimerRef.current = window.setTimeout(() => {
      setRailLeft(railElRef.current?.getBoundingClientRect().left ?? 0);
      setPreview({ rect: el.getBoundingClientRect(), target });
    }, PREVIEW_OPEN_DELAY_MS);
  }, [clearTimers]);

  const scheduleClose = useCallback(() => {
    clearTimers();
    closeTimerRef.current = window.setTimeout(() => setPreview(null), PREVIEW_CLOSE_DELAY_MS);
  }, [clearTimers]);

  const hoverProps = useCallback((target: RailPreviewTarget) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => openPreview(e.currentTarget, target),
    onMouseLeave: scheduleClose,
    /* 键盘走查也给预览 —— 不然这块信息对只用键盘的人不存在 */
    onFocus: (e: React.FocusEvent<HTMLElement>) => openPreview(e.currentTarget, target),
    onBlur: scheduleClose,
  }), [openPreview, scheduleClose]);

  const changeBadge = useMemo(() => {
    if (diffStat.add > 0 || diffStat.del > 0) {
      return (
        <span className="atl-ctx-rail__diff">
          {diffStat.add > 0 && <span className="atl-ctx-rail__diff-add">+{diffStat.add}</span>}
          {diffStat.del > 0 && <span className="atl-ctx-rail__diff-del">-{diffStat.del}</span>}
        </span>
      );
    }
    if (git.dirty && git.files.length > 0) {
      return <span className="atl-ctx-rail__count">{git.files.length}</span>;
    }
    return null;
  }, [diffStat, git.dirty, git.files.length]);

  return (
    <aside
      ref={railElRef}
      className={`atl-ctx-rail nx-in nx-in--sheet-right${entered ? ' is-in' : ''}`}
      aria-label={isZh ? '工作区上下文' : 'Workspace context'}
      onMouseLeave={scheduleClose}
    >
      <div className="atl-ctx-rail__scroll">
        <div className="atl-ctx-rail__section">
          <div className="atl-ctx-rail__head">
            <span className="atl-ctx-rail__head-label">{isZh ? '打开的标签' : 'Open Tabs'}</span>
            <button
              type="button"
              className="atl-ctx-rail__collapse"
              onClick={() => setRailHidden(true)}
              title={isZh ? '收起上下文栏' : 'Hide context rail'}
              aria-label={isZh ? '收起上下文栏' : 'Hide context rail'}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
                strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="4 3.5 8.5 8 4 12.5" />
                <polyline points="9 3.5 13.5 8 9 12.5" />
              </svg>
            </button>
          </div>
          {openTabs.length === 0 ? null : (
            <ul className="atl-ctx-rail__list">
              {openTabs.map((s) => (
                <li key={s.id} className="atl-ctx-rail__item">
                  {hintId === s.id && (
                    <RailHintBubble text={isZh ? '做好的东西在这里，点一下就能打开' : 'Your result is here — click to open'} />
                  )}
                  <button
                    type="button"
                    className={`atl-ctx-rail__row${s.id === activeId ? ' is-active' : ''}${freshIds.has(s.id) ? ' is-fresh' : ''}`}
                    onClick={() => onActivateTab(s)}
                    {...hoverProps({ type: 'surface', surface: s })}
                  >
                    {s.kind === 'plugin' ? (
                      <RailIcon pluginName={tabPluginName(s)}>
                        <RailLiveDot live={isSurfaceLive(s, now)} label={liveLabel} />
                      </RailIcon>
                    ) : (
                      <span className="atl-ctx-rail__icon">
                        {tabIcon(s)}
                        <RailLiveDot live={isSurfaceLive(s, now)} label={liveLabel} />
                      </span>
                    )}
                    <span className="atl-ctx-rail__label">{tabTitle(s, isZh)}</span>
                    <RailRowBadge surface={s} isZh={isZh} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {artifacts.length > 0 && (
          <div className="atl-ctx-rail__section">
            <div className="atl-ctx-rail__head">
              <span className="atl-ctx-rail__head-label">{isZh ? '产物' : 'Artifacts'}</span>
            </div>
            <ul className="atl-ctx-rail__list">
              {artifacts.map((a) => (
                <li key={a.path}>
                  <button
                    type="button"
                    className={`atl-ctx-rail__row${a.deleted ? ' is-gone' : ''}`}
                    onClick={() => { if (!a.deleted) onOpenArtifact(a.path); }}
                    disabled={a.deleted}
                    title={a.path}
                  >
                    <span className="atl-ctx-rail__icon"><FileTypeIcon path={a.path} size={ICON} /></span>
                    <span className="atl-ctx-rail__label">
                      {a.path.split(/[/\\]/).pop() || a.path}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="atl-ctx-rail__section">
          <div className="atl-ctx-rail__head">
            <span className="atl-ctx-rail__head-label">
              {isWork ? (isZh ? '工具' : 'Tools') : isZh ? `在 ${projectName}` : `On ${projectName}`}
            </span>
          </div>
          <ul className="atl-ctx-rail__list">
            {!isWork && (
              <li>
                <button type="button" className="atl-ctx-rail__row" onClick={onOpenChanges} {...hoverProps({ type: 'action', kind: 'git' })}>
                  <span className="atl-ctx-rail__icon">{IconChanges}</span>
                  <span className="atl-ctx-rail__label">{isZh ? '改动' : 'Changes'}</span>
                  {changeBadge}
                </button>
              </li>
            )}
            <li>
              <button type="button" className="atl-ctx-rail__row" onClick={() => void onOpenBrowser()} {...hoverProps({ type: 'action', kind: 'web' })}>
                <span className="atl-ctx-rail__icon">
                  {IconGlobe}
                  <RailLiveDot live={kindLive.web} label={liveLabel} />
                </span>
                <span className="atl-ctx-rail__label">{isZh ? '浏览器' : 'Browser'}</span>
              </button>
            </li>
            {!isWork && (
              <li>
                <button type="button" className="atl-ctx-rail__row" onClick={onOpenServices} {...hoverProps({ type: 'action', kind: 'services' })}>
                  <span className="atl-ctx-rail__icon">
                    {IconTerminal}
                    <RailLiveDot live={kindLive.services} label={liveLabel} />
                  </span>
                  <span className="atl-ctx-rail__label">{isZh ? '服务' : 'Services'}</span>
                </button>
              </li>
            )}
            <li>
              <button type="button" className="atl-ctx-rail__row" onClick={onOpenFiles} {...hoverProps({ type: 'action', kind: 'files' })}>
                <span className="atl-ctx-rail__icon">
                  {IconFiles}
                  <RailLiveDot live={kindLive.files} label={liveLabel} />
                </span>
                <span className="atl-ctx-rail__label">{isZh ? '文件' : 'Files'}</span>
              </button>
            </li>
          </ul>
        </div>

        {pluginViews.length > 0 && (
          <div className="atl-ctx-rail__section">
            <div className="atl-ctx-rail__head">
              <span className="atl-ctx-rail__head-label">{isZh ? '插件' : 'Plugins'}</span>
            </div>
            <ul className="atl-ctx-rail__list">
              {pluginViews.map((v) => (
                <li key={`${v.pluginName}:${v.id}`}>
                  <button type="button" className="atl-ctx-rail__row" onClick={() => openPluginView(v)} title={v.pluginName}>
                    <RailIcon pluginName={v.pluginName} emoji={v.iconIsEmoji ? v.icon : undefined} />
                    <span className="atl-ctx-rail__label">{v.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <AgentTimelineContextRailPreview
        anchor={preview}
        workspacePath={workspacePath}
        railLeft={railLeft}
        sessionId={sessionId}
        liveWebSurfaces={liveWebSurfaces}
        onEnter={clearTimers}
        onLeave={scheduleClose}
      />
    </aside>
  );
};

export default AgentTimelineContextRail;
