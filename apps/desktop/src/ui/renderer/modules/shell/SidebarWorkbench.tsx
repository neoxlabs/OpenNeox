import React, { useMemo, useState } from 'react';
import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu';
import { useSessionGlance, type SessionGlance } from './useSessionGlance';
import { zhRuntimeTitle } from './runtimeTitleZh';
import { isMac } from '../../utils/keymap';
import { Icon } from '@iconify/react';
import thumbSlides from '../../media/clay/thumb-slides.webp';
import thumbSheet from '../../media/clay/thumb-sheet.webp';
import thumbDoc from '../../media/clay/thumb-doc.webp';
import thumbImage from '../../media/clay/thumb-image.webp';
import sfcGit from '../../media/clay/sfc-git.webp';
import sfcTerminal from '../../media/clay/sfc-terminal.webp';
import sfcWeb from '../../media/clay/sfc-web.webp';
import sfcServices from '../../media/clay/sfc-services.webp';
import sfcPlan from '../../media/clay/sfc-plan.webp';
import sfcTodo from '../../media/clay/sfc-todo.webp';
import sfcTeam from '../../media/clay/sfc-team.webp';
import sfcDocx from '../../media/clay/sfc-docx.webp';
import sfcPdf from '../../media/clay/sfc-pdf.webp';
import sfcSheet from '../../media/clay/sfc-sheet.webp';
import sfcFiles from '../../media/clay/sfc-files.webp';
import setChat from '../../media/clay/set-chat.webp';
import setShield from '../../media/clay/set-shield.webp';
/* side-effect: 注册 vscode-icons 离线集 (Icon 用 vscode-icons:* 前必须加载过) */
import '../../components/FileTypeIcons';
import './sidebar-workbench.css';
import { WorkProjectPicker, CodeProjectMenu } from './WorkProjectPicker';
import { projectArt, type WorkProject } from './workProjects';
import { sameWorkspace } from '../../utils/pathUtils';
import { stableCardOrder } from './stableCardOrder';
import { CodeWorkspaceCard, openFolderIcon } from './CodeWorkspaceCard';
import type { CodeWorkspace } from './codeWorkspaces';
import { absoluteToAssetUrl } from '../../../shared/assetUrlPath';

export interface WorkbenchSession {
  id: string;
  title: string;
  ts?: number;
  timeText?: string;
  groupName?: string;
}

export type ListMode = 'workbench' | 'folders';

/* 「最近」行的时间 (设计稿 UI 3.0): 今天写「19:53」, 别的日子写「10-14」, 跨年带年份 —— 一列等宽, 不跳单位 */
function dayStamp(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

export const overviewKey = isMac ? '⌘E' : 'Ctrl+E';

/* ── 两段切换: 工作台 | 列表 ── */
export const ListModeSwitch: React.FC<{ mode: ListMode; onChange: (m: ListMode) => void; zh: boolean; compact?: boolean }> = ({ mode, onChange, zh, compact }) => (
  <div className={`neox-wb-switch is-${mode}${compact ? ' is-compact' : ''}`} role="tablist" aria-label={zh ? '会话怎么摆' : 'Chat layout'}>
    <span className="neox-wb-switch__thumb" aria-hidden="true" />
    <button type="button" role="tab" aria-selected={mode === 'workbench'} title={zh ? '工作台 — 只摆手上的活' : 'Workbench — just what is in flight'} onClick={() => onChange('workbench')}>
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="4.5" rx="1.3" /><rect x="2" y="9" width="12" height="4.5" rx="1.3" /></svg>
      <span>{zh ? '工作台' : 'Desk'}</span>
    </button>
    <button type="button" role="tab" aria-selected={mode === 'folders'} title={zh ? '列表 — 按项目文件夹' : 'List — by project folder'} onClick={() => onChange('folders')}>
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h7" /></svg>
      <span>{zh ? '列表' : 'List'}</span>
    </button>
  </div>
);

export const ImageModeHead: React.FC<{ count: number; onBack: () => void; onNew?: () => void; zh: boolean }> = ({ count, onBack, onNew, zh }) => (
  <>
    <div className="neox-img-head">
      <button type="button" className="neox-img-head__back" onClick={onBack} title={zh ? '回到会话' : 'Back to chats'}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
        <span>{zh ? '会话' : 'Chats'}</span>
      </button>
      <span className="neox-img-head__title">{zh ? '图片' : 'Images'}<em>{count}</em></span>
    </div>
    {onNew && (
      <div className="neox-sidebar__section-head__tools">
        <button type="button" className="neox-sidebar__icobtn" onClick={onNew} title={zh ? '新建图片' : 'New image'} aria-label={zh ? '新建图片' : 'New image'}>
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3.3v9.4M3.3 8h9.4" /></svg>
        </button>
      </div>
    )}
  </>
);

/* ── 侧栏搜索横条: 输入即过滤 (过滤本身在 Sidebar 的 filtered 里), Esc 清空并收起 ── */
export const SidebarSearchBar: React.FC<{ value: string; onChange: (v: string) => void; onClose: () => void; onFullText?: () => void; count: number; zh: boolean }> = ({ value, onChange, onClose, onFullText, count, zh }) => (
  <div className="neox-sb-search">
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="7.2" cy="7.2" r="4.6" /><path d="m10.6 10.6 3.4 3.4" /></svg>
    <input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}
      placeholder={zh ? '过滤会话 — 标题或项目名' : 'Filter chats — title or project'}
      spellCheck={false}
    />
    {value && <span className="neox-sb-search__count">{count}</span>}
    {value && onFullText && (
      <button type="button" className="neox-sb-search__full" onClick={onFullText} title={zh ? '在所有消息内容里搜' : 'Search inside messages'}>
        {zh ? '搜内容' : 'Messages'}
      </button>
    )}
    <button type="button" className="neox-sb-search__x" onClick={onClose} aria-label={zh ? '关闭搜索' : 'Close search'}>
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
    </button>
  </div>
);

/* ── 工作台模式下的头: 左边两段切换, 右边「全景」 ── */
export const searchKey = isMac ? '⌘K' : 'Ctrl+K';

export interface HeadMoreProps {
  segments: Array<{ id: string; zh: string; en: string; icon: React.ReactNode }>;
  activeSeg: string;
  onSeg: (id: string) => void;
  onLocate?: () => void;
  onOpenProject?: () => void;
  onManageProjects?: () => void;
  onFileExplorer?: () => void;
  view: string;
  views: Array<{ id: string; label: string }>;
  onView: (v: string) => void;
}

/* 菜单图标: 同一套 16 视框 1.5 线宽 */
const mi = (d: React.ReactNode) => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const MENU_ICONS: Record<string, React.ReactNode> = {
  recent: mi(<><circle cx="8" cy="8" r="5.8" /><path d="M8 4.8V8l2.2 1.4" /></>),
  pinned: mi(<path d="M8 2.2l1.7 3.6 3.9.5-2.9 2.7.7 3.9L8 11l-3.4 1.9.7-3.9-2.9-2.7 3.9-.5z" />),
  archived: mi(<><rect x="2" y="3" width="12" height="3.2" rx="1" /><path d="M3 6.2V12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6.2M6.5 9h3" /></>),
  locate: mi(<><circle cx="8" cy="8" r="5.6" /><circle cx="8" cy="8" r="2.4" /><circle cx="8" cy="8" r="0.6" fill="currentColor" /></>),
  files: mi(<><rect x="2" y="2.2" width="4.2" height="3.4" rx="1" /><rect x="9" y="6.3" width="4.6" height="3.4" rx="1" /><rect x="9" y="10.6" width="4.6" height="3.4" rx="1" /><path d="M4.1 5.6v6.7h4.9M4.1 8h4.9" /></>),
  open: mi(<><path d="M2 4.2A1.2 1.2 0 0 1 3.2 3h2.6l1.4 1.5h5.6A1.2 1.2 0 0 1 14 5.7V12a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 12z" /><path d="M8 7v4M6 9h4" /></>),
  manage: mi(<><path d="M5.5 4h8M5.5 8h8M5.5 12h8" /><circle cx="2.8" cy="4" r="0.7" fill="currentColor" /><circle cx="2.8" cy="8" r="0.7" fill="currentColor" /><circle cx="2.8" cy="12" r="0.7" fill="currentColor" /></>),
};

const HeadMore: React.FC<{ more: HeadMoreProps; zh: boolean }> = ({ more, zh }) => {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const items: ContextMenuItem[] = [
    { id: 'h-filter', header: true, label: zh ? '显示' : 'Show' },
    ...more.views.map((v) => ({ id: `view-${v.id}`, label: v.label, icon: MENU_ICONS[v.id], shortcut: more.view === v.id ? '✓' : undefined, onClick: () => more.onView(v.id) })),
    { separator: true },
    ...(more.onLocate ? [{ id: 'locate', label: zh ? '定位当前会话' : 'Locate current chat', icon: MENU_ICONS.locate, onClick: more.onLocate }] : []),
    ...(more.onFileExplorer ? [{ id: 'files', label: zh ? '文件管理器' : 'File explorer', icon: MENU_ICONS.files, onClick: more.onFileExplorer }] : []),
    ...(more.onOpenProject ? [{ id: 'open', label: zh ? '打开项目…' : 'Open project…', icon: MENU_ICONS.open, onClick: more.onOpenProject }] : []),
    ...(more.onManageProjects ? [{ id: 'manage', label: zh ? '管理项目列表' : 'Manage project list', icon: MENU_ICONS.manage, onClick: more.onManageProjects }] : []),
  ];
  return (
    <>
      <button
        type="button"
        className={`neox-sidebar__icobtn${pos ? ' is-active' : ''}`}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPos({ x: r.left, y: r.bottom + 4 }); }}
        title={zh ? '更多: 视图 / 筛选 / 项目' : 'More: view / filter / projects'}
        aria-label={zh ? '更多' : 'More'}
        aria-haspopup="menu"
      >
        <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.5" cy="8" r="1.25" /></svg>
      </button>
      {pos && <ContextMenu position={pos} items={items} onClose={() => setPos(null)} />}
    </>
  );
};

export const WorkbenchHead: React.FC<{ mode: ListMode; onMode: (m: ListMode) => void; onOverview: () => void; onSearch?: () => void; more?: HeadMoreProps; zh: boolean }> = ({ mode, onMode, onOverview, onSearch, more, zh }) => (
  <>
    <ListModeSwitch mode={mode} onChange={onMode} zh={zh} />
    <div className="neox-sidebar__section-head__tools">
      {/* 搜会话: 打开侧栏里的过滤横条 (⌘K) */}
      {onSearch && (
        <button type="button" className="neox-sidebar__icobtn" onClick={onSearch} title={`${zh ? '搜索会话' : 'Search chats'}  ${searchKey}`} aria-label={zh ? '搜索会话' : 'Search chats'}>
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="7.2" cy="7.2" r="4.6" /><path d="m10.6 10.6 3.4 3.4" /></svg>
        </button>
      )}
      <button type="button" className="neox-sidebar__icobtn" onClick={onOverview} title={`${zh ? '全景 — 所有会话' : 'Overview — all chats'}  ${overviewKey}`} aria-label={zh ? '全景' : 'Overview'}>
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="1.8" y="1.8" width="5.4" height="5.4" rx="1.2" /><rect x="8.8" y="1.8" width="5.4" height="5.4" rx="1.2" /><rect x="1.8" y="8.8" width="5.4" height="5.4" rx="1.2" /><rect x="8.8" y="8.8" width="5.4" height="5.4" rx="1.2" /></svg>
      </button>
      {more && <HeadMore more={more} zh={zh} />}
    </div>
  </>
);

interface Props {
  sessions: WorkbenchSession[];
  pinnedIds: ReadonlySet<string>;
  activeSessionId?: string | null;
  isRunning: (id: string) => boolean;
  onSelect: (id: string) => void;
  onContextMenu?: (e: React.MouseEvent, id: string) => void;
  onOverview: () => void;
  /** 切到按项目文件夹的列表 (UI 3.0 起入口在底部, 不再在顶上两段切换) */
  onFolders?: () => void;
  /** 侧栏搜索中: 不分组, 直接列出命中的 (sessions 已经是过滤后的) */
  query?: string;
  zh: boolean;
  /** Work 稿: 「进行中」也摆一周内最近的任务 (已做完 · N 个成品), 凑满 3 张, 行尾一摞大缩略图 */
  work?: boolean;
  projects?: WorkbenchProject[];
  onNewInProject?: (key: string) => void;
  onOpenProject?: () => void;
  /** Code 新建项目: 编码目录下建空文件夹 (git init) 并打开 */
  onCreateProject?: (name: string) => void;
  /** Code 工作区 (同色的一组项目): 列表 + 保存后的回调 (同步当前工作区的根) */
  codeWs?: { list: readonly CodeWorkspace[]; onSaved: (changed: Array<{ primary: string; roots: string[]; name?: string }>) => void };
  /** 组头「⋯」: 重命名 / 移除 / 在访达中显示 (原列表模式那份菜单) */
  onProjectMenu?: (key: string, rect: DOMRect) => void;
  workProjects?: WorkProjectsProps;
}

export interface WorkProjectsProps {
  projects: readonly WorkProject[];
  /** 当前在看的项目文件夹, null = 全部任务 */
  filter: string | null;
  /** 会话 id → 所属项目 */
  projectOf: ReadonlyMap<string, WorkProject>;
  onPick: (dir: string | null) => void;
  onCreate: (name: string) => void;
  onAllProjects?: () => void;
  onProjectHome?: (dir: string) => void;
}

export interface WorkbenchProject {
  key: string;
  name: string;
  branch?: string;
  isActive: boolean;
  sessionIds: string[];
  /** 最近一条会话的时间 —— 当前项目之外按它排 */
  lastTs?: number;
  /** 所在工作区的颜色 (不在工作区里 = 没有) */
  color?: string;
}

/** 展开的项目一次最多摆几条, 其余「还有 N 个 ›」 */
const PROJECT_ROWS = 6;

const folderIcon = (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" /></svg>
);
const plusIcon = (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
);
const chevIcon = (open: boolean) => (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={open ? 'm4.5 6.5 3.5 3.5 3.5-3.5' : 'm6.5 4.5 3.5 3.5-3.5 3.5'} />
  </svg>
);

const WEEK = 7 * 86_400_000;

const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);
const OUT_ICON: Record<string, string> = {
  pptx: 'vscode-icons:file-type-powerpoint', ppt: 'vscode-icons:file-type-powerpoint', key: 'vscode-icons:file-type-powerpoint',
  xlsx: 'vscode-icons:file-type-excel', xls: 'vscode-icons:file-type-excel', csv: 'vscode-icons:file-type-excel',
  docx: 'vscode-icons:file-type-word', doc: 'vscode-icons:file-type-word', pdf: 'vscode-icons:file-type-pdf2',
  md: 'vscode-icons:file-type-markdown', html: 'vscode-icons:file-type-html', htm: 'vscode-icons:file-type-html',
  mp4: 'vscode-icons:file-type-video', mov: 'vscode-icons:file-type-video', webm: 'vscode-icons:file-type-video',
  mp3: 'vscode-icons:file-type-audio', wav: 'vscode-icons:file-type-audio',
};
const assetUrl = absoluteToAssetUrl;

/** 会话做出来的成品, 叠成一小摞缩略图 (设计稿侧栏行右侧): 图片显示本图, 其它显示文件类型图标 */
const OutputStack: React.FC<{ outputs?: Array<{ path: string; ext: string }> }> = ({ outputs }) => {
  if (!outputs || outputs.length === 0) return null;
  return (
    <span className="neox-wb-out" title={outputs.map((o) => o.path.split(/[\\/]/).pop()).join('\n')} aria-hidden="true">
      {outputs.map((o) => (
        <span key={o.path} className="neox-wb-out__tile">
          {IMG_EXT.has(o.ext)
            ? <img src={assetUrl(o.path)} alt="" draggable={false} loading="lazy" />
            : <Icon icon={OUT_ICON[o.ext] ?? 'vscode-icons:default-file'} width={14} height={14} />}
        </span>
      ))}
    </span>
  );
};

/* Work 稿「进行中」行尾那块陶土缩略图: 有图片成品就放本图, 否则按成品类型 (没有成品按标题猜) 选一张陶土插画 */
const ART_BY_EXT: Record<string, string> = {
  pptx: thumbSlides, ppt: thumbSlides, key: thumbSlides,
  xlsx: thumbSheet, xls: thumbSheet, csv: thumbSheet, tsv: thumbSheet,
};
const WorkThumb: React.FC<{ title: string; outputs?: Array<{ path: string; ext: string }> }> = ({ title, outputs }) => {
  const img = outputs?.find((o) => IMG_EXT.has(o.ext));
  const first = outputs?.[0];
  const art = first
    ? (ART_BY_EXT[first.ext] ?? (IMG_EXT.has(first.ext) ? thumbImage : thumbDoc))
    : /ppt|幻灯|课件|演示|slides?/i.test(title) ? thumbSlides
    : /表|excel|数据|统计|报表|sheet/i.test(title) ? thumbSheet
    : /图|海报|画|设计|logo|image|photo/i.test(title) ? thumbImage
    : thumbDoc;
  return (
    <span className={`neox-wb-art${img ? ' is-photo' : ''}`} aria-hidden="true">
      {img
        ? <img src={assetUrl(img.path)} alt="" draggable={false} loading="lazy" />
        : <img src={art} alt="" draggable={false} />}
    </span>
  );
};

const CODE_ART_RULES: Array<[RegExp, string]> = [
  [/\bgit\b|commit|push|pull request|\bpr\b|merge|rebase|branch|diff|提交|分支|合并|推送/i, sfcGit],
  [/test|测试|jest|vitest|pytest|build|编译|构建|npm|pnpm|yarn|\bbun\b|cargo|make\b|shell|命令|终端|terminal|跑一下|运行/i, sfcTerminal],
  [/浏览|网页|网站|browser|playwright|截图|http|url|页面/i, sfcWeb],
  [/服务|server|启动|部署|deploy|docker|端口|上线|nginx/i, sfcServices],
  [/计划|plan|方案|设计|架构|重构|拆分|规划/i, sfcPlan],
  [/待办|todo|清单|步骤|列表/i, sfcTodo],
  [/团队|agent|并行|子任务|分工/i, sfcTeam],
  [/文档|readme|docx|word|说明书|手册/i, sfcDocx],
  [/pdf/i, sfcPdf],
  [/表格|excel|csv|xlsx|统计|数据/i, sfcSheet],
  [/读|文件|搜索|查找|grep|search|read|分析|调研|review|审查|看看|了解/i, sfcFiles],
];
const CODE_ART_BY_EXT: Record<string, string> = {
  pptx: thumbSlides, ppt: thumbSlides, xlsx: sfcSheet, xls: sfcSheet, csv: sfcSheet,
  docx: sfcDocx, doc: sfcDocx, md: sfcDocx, pdf: sfcPdf, html: sfcWeb, htm: sfcWeb,
};
export function codeArt(title: string, g: SessionGlance | undefined): { src: string; photo: boolean } {
  const out = g?.outputs?.[0];
  if (out && IMG_EXT.has(out.ext)) return { src: assetUrl(out.path), photo: true };
  if (out && CODE_ART_BY_EXT[out.ext]) return { src: CODE_ART_BY_EXT[out.ext]!, photo: false };
  const w = g?.waiting?.kind;
  if (w === 'approval') return { src: setShield, photo: false };
  if (w) return { src: setChat, photo: false };
  const text = `${g?.activity ?? ''} ${title}`;
  for (const [re, src] of CODE_ART_RULES) if (re.test(text)) return { src, photo: false };
  return { src: sfcFiles, photo: false };
}
/** 「跑测试 4/7」这种带步数的, 画一条进度线; 没步数不假装有百分比 */
export function stepRatio(activity?: string): number | null {
  const m = activity?.match(/(\d+)\s*\/\s*(\d+)/);
  if (!m) return null;
  const a = Number(m[1]); const b = Number(m[2]);
  return b > 0 && a <= b ? a / b : null;
}

const WAIT_LABEL: Record<NonNullable<SessionGlance['waiting']>['kind'], [string, string]> = {
  ask: ['等你选', 'Asks you'],
  approval: ['等你审批', 'Needs approval'],
  question: ['等你回复', 'Your turn'],
};

/** 列表滚到底续载: 末尾放一个 1px 的哨兵, 露出来 (提前 200px) 就调 onMore */
function useLoadMoreSentinel(onMore: () => void) {
  const obs = React.useRef<IntersectionObserver | null>(null);
  const cb = React.useRef(onMore);
  cb.current = onMore;
  return React.useCallback((el: HTMLDivElement | null) => {
    obs.current?.disconnect();
    obs.current = null;
    if (!el) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) cb.current();
    }, { rootMargin: '200px 0px' });
    io.observe(el);
    obs.current = io;
  }, []);
}

export const SidebarWorkbench: React.FC<Props> = ({ sessions, pinnedIds, activeSessionId, isRunning, onSelect, onContextMenu, onOverview, onFolders, query, zh, work, projects, onNewInProject, onOpenProject, onCreateProject, codeWs, onProjectMenu, workProjects: wp }) => {
  /* 项目分组: 谁展开 (默认只有当前项目) / 谁点过「还有 N 个」 */
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [fullProjects, setFullProjects] = useState<Record<string, boolean>>({});
  /* Code「项目」标题右边的浮层 (新建 / 打开), newProj = 浮层里正在输的新项目名, null = 没在输入 */
  const [projMenu, setProjMenu] = useState<DOMRect | null>(null);
  /* 工作区管理 / 新建工作区卡片 (从「＋ 项目 ▾」进来, 锚点沿用那颗按钮) */
  const [wsCard, setWsCard] = useState<{ anchor: DOMRect; start: 'list' | 'new' } | null>(null);
  const [newProj, setNewProj] = useState<string | null>(null);
  /* Work 项目浮层: 锚点 = 「全部 ▾」的位置 */
  const [wpAnchor, setWpAnchor] = useState<DOMRect | null>(null);
  const wpCurrent = wp?.filter ? wp.projects.find((p) => sameWorkspace(p.dir, wp.filter)) : undefined;
  /* 每个项目的任务数 / 最近用过时间 (浮层排序与右侧数字) */
  const wpStats = useMemo(() => {
    const counts = new Map<string, number>();
    const lastUsed = new Map<string, number>();
    if (wp) for (const s of sessions) {
      const p = wp.projectOf.get(s.id);
      if (!p) continue;
      counts.set(p.dir, (counts.get(p.dir) ?? 0) + 1);
      lastUsed.set(p.dir, Math.max(lastUsed.get(p.dir) ?? 0, s.ts ?? 0));
    }
    return { counts, lastUsed };
  }, [sessions, wp]);
  const sorted = useMemo(() => [...sessions].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)), [sessions]);
  const projOrderRef = React.useRef<string[]>([]);
  const projectGroups = useMemo(() => {
    if (!projects) return [];
    const keysOf = new Map<string, Set<string>>();
    for (const p of projects) for (const id of p.sessionIds) {
      let ks = keysOf.get(id);
      if (!ks) { ks = new Set(); keysOf.set(id, ks); }
      ks.add(p.key);
    }
    const lists = new Map<string, WorkbenchSession[]>();
    for (const s of sorted) {
      const ks = keysOf.get(s.id);
      if (!ks) continue;
      for (const k of ks) {
        let l = lists.get(k);
        if (!l) { l = []; lists.set(k, l); }
        l.push(s);
      }
    }
    const byKey = new Map(projects.map((p) => [p.key, p]));
    const fresh = [...projects]
      .sort((a, b) => Number(b.isActive) - Number(a.isActive) || (b.lastTs ?? 0) - (a.lastTs ?? 0))
      .map((p) => p.key);
    projOrderRef.current = stableCardOrder(projOrderRef.current, fresh, true);
    return projOrderRef.current.map((k) => ({ p: byKey.get(k)!, list: lists.get(k) ?? [] }));
  }, [projects, sorted]);
  /* 只看最近一周的 + 钉住的 + 正在跑的, 「等你」不翻老账 */
  const now = Date.now();
  const watchIds = useMemo(
    () => sorted.filter((s) => isRunning(s.id) || pinnedIds.has(s.id) || now - (s.ts ?? 0) < WEEK).slice(0, 80).map((s) => s.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sorted, pinnedIds],
  );
  const glanceAll = useSessionGlance(watchIds);
  /* 正在跑的那几条第二行写「现在在干嘛」, 20 秒一刷会停在早做完的那步 —— 单独 4 秒一刷 */
  const runningIds = useMemo(() => watchIds.filter((id) => isRunning(id)), [watchIds, isRunning]);
  const glanceRunning = useSessionGlance(runningIds, runningIds.length > 0, 4_000);
  const glance = useMemo(() => {
    const out = { ...glanceAll };
    /* 只盖还在跑的: 跑完的那条快刷缓存会留着旧值 */
    for (const id of runningIds) if (glanceRunning[id]) out[id] = glanceRunning[id];
    return out;
  }, [glanceAll, glanceRunning, runningIds]);

  /* 「最近」滚到底续载: 末尾放一个 1px 的哨兵, 露出来就 +30 */
  const topOrderRef = React.useRef<string[]>([]);
  const [recentLimit, setRecentLimit] = useState(30);
  const moreRef = useLoadMoreSentinel(() => setRecentLimit((n) => n + 30));
  /* 「项目」同理: 先画 24 个项目头 (76 个一次画完, 切到 Code 那一帧白画屏幕外的五十多个) */
  const [projLimit, setProjLimit] = useState(24);
  const projMoreRef = useLoadMoreSentinel(() => setProjLimit((n) => n + 24));

  const running = sorted.filter((s) => isRunning(s.id));
  const used = new Set(running.map((s) => s.id));
  const rank = (k?: string) => (k === 'ask' || k === 'approval' ? 0 : 1);
  const waiting = sorted
    .filter((s) => !used.has(s.id) && glance[s.id]?.waiting && now - (s.ts ?? 0) < WEEK)
    .sort((a, b) => rank(glance[a.id]?.waiting?.kind) - rank(glance[b.id]?.waiting?.kind))
    .slice(0, 5);
  waiting.forEach((s) => used.add(s.id));
  /* Code 按项目分组时「进行中」也换成大卡片 (设计稿 E8jf「Code 侧栏 · 方案 A」), 跟 Work 一样补最近做完的凑满 3 张 */
  const codeCards = !work && !!projects;
  const done = work || codeCards
    /* 「已做完」只算真跑过的 (有一句回复或有成品): 刚点新建的空任务不该挂成「已做完」 */
    ? sorted.filter((s) => !used.has(s.id) && now - (s.ts ?? 0) < WEEK && !!(glance[s.id]?.lastLine || glance[s.id]?.outputs?.length))
      .slice(0, Math.max(0, 3 - running.length - waiting.length))
    : [];
  done.forEach((s) => used.add(s.id));
  /* 「进行中」卡片位置稳定: 还在的卡不挪, 只换状态 (见 stableCardOrder) */
  type TopKind = 'running' | 'waiting' | 'done';
  const topKinds = new Map<string, [WorkbenchSession, TopKind]>();
  for (const [list, kind] of [[running, 'running'], [waiting, 'waiting'], [done, 'done']] as const) {
    for (const s of list) topKinds.set(s.id, [s, kind]);
  }
  topOrderRef.current = stableCardOrder(topOrderRef.current, [...topKinds.keys()]);
  const topCards = topOrderRef.current.map((id) => topKinds.get(id)!);
  const pinned = sorted.filter((s) => !used.has(s.id) && pinnedIds.has(s.id));
  pinned.forEach((s) => used.add(s.id));
  /* 选着 Work 项目: 「最近」列出这个项目的全部任务 —— 「进行中」照旧跨项目, 同一条在上面出现过也照列,
   * 不然刚做完的任务在「进行中」里, 项目列表反而空着写「还没有任务」 */
  const recentAll = wpCurrent
    ? sorted.filter((s) => wp?.projectOf.get(s.id)?.dir === wpCurrent.dir)
    : sorted.filter((s) => !used.has(s.id));
  /* 当前打开的会话不在上面几组里, 就排最近第一个, 保证随时看得到自己在哪 */
  /* UI 3.0: 行尾改成日期 (10-14) 后, 老会话插在最前面读着像排序错了 —— 只有它不在已渲染的那一截里才提上来 */
  const activeIdx = recentAll.findIndex((s) => s.id === activeSessionId);
  const recentOrdered = activeIdx < recentLimit ? recentAll : [
    recentAll[activeIdx]!,
    ...recentAll.filter((s) => s.id !== activeSessionId),
  ];
  const recent = recentOrdered.slice(0, recentLimit);
  const hasMoreRecent = recentOrdered.length > recent.length;

  const card = (s: WorkbenchSession, kind: 'running' | 'waiting' | 'pinned' | 'done', i: number) => {
    const g = glance[s.id];
    const w = g?.waiting;
    const n = g?.outputs?.length ?? 0;
    /* 设计稿: 第二行只写一句灰色状态 (「跑测试 4/7」「等你审批」「已做完 · 2 个成品」), 不放预览原文 */
    const base = kind === 'running'
      ? (g?.activity ? (zh ? zhRuntimeTitle(g.activity) : g.activity) : (zh ? '正在处理…' : 'Working…'))
      : kind === 'waiting' && w ? (zh ? WAIT_LABEL[w.kind][0] : WAIT_LABEL[w.kind][1])
      : kind === 'done' ? (n > 0 ? (zh ? `已做完 · ${n} 个成品` : `Done · ${n} file${n === 1 ? '' : 's'}`) : (zh ? '已做完' : 'Done'))
      : (g?.lastLine || '');
    /* 按项目分组时「进行中」跨项目 —— 每条带上是哪个项目的 */
    const line = projects && s.groupName && base ? `${base} · ${s.groupName}` : base;
    /* Code 大卡片: 状态点挪到第二行行首, 行尾陶土图, 带步数的画进度线 */
    if (codeCards) {
      const art = codeArt(s.title, g);
      const ratio = kind === 'running' ? stepRatio(g?.activity) : null;
      return (
        <div
          key={s.id}
          role="button"
          tabIndex={0}
          data-session-id={s.id}
          style={{ ['--i' as string]: i }}
          className={`neox-wb-card is-code is-${kind}${s.id === activeSessionId ? ' is-active' : ''}`}
          onClick={() => onSelect(s.id)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSelect(s.id); }}
          onContextMenu={onContextMenu ? (e) => onContextMenu(e, s.id) : undefined}
          title={s.title}
        >
          <div className="neox-wb-card__head"><span className="neox-wb-card__title">{s.title}</span></div>
          <div className="neox-wb-card__line" title={kind === 'waiting' && w ? w.text : undefined}>
            {kind !== 'done' && kind !== 'pinned' && <span className={`neox-wb-card__dot is-${kind}`} aria-hidden="true" />}
            <span>{base}</span>
            {s.groupName && <span className="neox-wb-card__proj"> · {s.groupName}</span>}
          </div>
          {ratio !== null && <div className="neox-wb-card__bar" aria-hidden="true"><i style={{ width: `${Math.round(ratio * 100)}%` }} /></div>}
          <span className={`neox-wb-art${art.photo ? ' is-photo' : ''}`} aria-hidden="true"><img src={art.src} alt="" draggable={false} loading="lazy" /></span>
        </div>
      );
    }
    return (
      <div
        key={s.id}
        role="button"
        tabIndex={0}
        data-session-id={s.id}
        style={{ ['--i' as string]: i }}
        className={`neox-wb-card is-${kind}${s.id === activeSessionId ? ' is-active' : ''}`}
        onClick={() => onSelect(s.id)}
        onKeyDown={(e) => { if (e.key === 'Enter') onSelect(s.id); }}
        onContextMenu={onContextMenu ? (e) => onContextMenu(e, s.id) : undefined}
        title={s.title}
      >
        <div className="neox-wb-card__head">
          <span className={`neox-wb-card__dot is-${kind}`} aria-hidden="true" />
          <span className="neox-wb-card__title">{s.title}</span>
          {work ? <WorkThumb title={s.title} outputs={g?.outputs} /> : <OutputStack outputs={g?.outputs} />}
        </div>
        {line && <div className="neox-wb-card__line" title={kind === 'waiting' && w ? w.text : undefined}><span>{line}</span></div>}
      </div>
    );
  };

  const section = (label: string, count: number, children: React.ReactNode, right?: React.ReactNode) => (
    <section className="neox-wb__section">
      {right
        ? <div className="neox-wb__label has-wp"><span>{label}</span>{right}</div>
        : <div className="neox-wb__label">{label}<em>{count}</em></div>}
      {children}
    </section>
  );


  const row = (s: WorkbenchSession, i: number) => (
    <div
      key={s.id}
      role="button"
      tabIndex={0}
      data-session-id={s.id}
      style={{ ['--i' as string]: Math.min(i, 12) }}
      className={`neox-wb-row${s.id === activeSessionId ? ' is-active' : ''}`}
      onClick={() => onSelect(s.id)}
      onKeyDown={(e) => { if (e.key === 'Enter') onSelect(s.id); }}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, s.id) : undefined}
      title={s.title}
    >
      {isRunning(s.id) && <span className="neox-wb-card__dot is-running" aria-hidden="true" />}
      <span className="neox-wb-row__title">
        {s.title}
        {/* 看全部任务时, 属于项目的任务后面带灰色项目名 */}
        {wp && !wpCurrent && wp.projectOf.get(s.id) && <span className="neox-wb-row__proj"> · {wp.projectOf.get(s.id)!.name}</span>}
      </span>
      <OutputStack outputs={glance[s.id]?.outputs} />
      <span className="neox-wb-row__time">{dayStamp(s.ts) || s.timeText}</span>
    </div>
  );

  if (query && query.trim()) {
    return (
      <div className="neox-wb">
        {sorted.length === 0
          ? <div className="neox-wb__calm">{zh ? '没有标题或项目名对得上的会话' : 'No chat title or project matches'}</div>
          : section(zh ? '找到' : 'Matches', sorted.length, <div className="neox-wb__recent">{sorted.slice(0, 80).map(row)}</div>)}
      </div>
    );
  }

  return (
    <div className="neox-wb">
      {/* 设计稿只有一组「进行中」: 在跑的蓝点, 等你的琥珀点, 同一组里 */}
      {/* 凑满 3 张的「刚做完」卡片也在这一组 —— 没有在跑 / 等你的时候标题就别写「进行中」(QA: 进行中下面全是已做完), 计数只数在跑和等你的 */}
      {running.length + waiting.length + done.length > 0 && section(
        running.length + waiting.length > 0 ? (zh ? '进行中' : 'In progress') : (zh ? '刚做完' : 'Just finished'),
        running.length + waiting.length > 0 ? running.length + waiting.length : done.length,
        topCards.map(([s, kind], i) => card(s, kind, i)))}
      {pinned.length > 0 && section(zh ? '钉住' : 'Pinned', pinned.length, pinned.map((s, i) => card(s, 'pinned', i)))}
      {projects && section(zh ? '项目' : 'Projects', projects.length, (
        <div className="neox-wb__recent neox-wb-projects">
          {/* 项目组里列这个项目的全部会话 —— 刚做完挂在「进行中」卡片上的, 组里也照列, 不然找不到 */}
          {projectGroups.slice(0, projLimit).map(({ p, list }) => {
            /* 默认展开: 当前工作区, 以及当前打开的会话所在的项目 —— 只跟工作区走时, 工作区一慢半拍
             * (或跟会话对不上), 侧栏展开的就成了别的项目, 眼前这条会话所在的组反而收起来了 */
            const open = openProjects[p.key] ?? (p.isActive || (!!activeSessionId && list.some((s) => s.id === activeSessionId)));
            const shown = fullProjects[p.key] ? list : list.slice(0, PROJECT_ROWS);
            return (
              <div key={p.key} className={`neox-wb-proj${open ? ' is-open' : ''}`}>
                <div
                  role="button"
                  tabIndex={0}
                  className={`neox-wb-proj__head${p.isActive ? ' is-current' : ''}`}
                  onClick={() => setOpenProjects((m) => ({ ...m, [p.key]: !open }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') setOpenProjects((m) => ({ ...m, [p.key]: !open })); }}
                  title={p.key}
                >
                  {/* 打开的文件夹图标; 在工作区里的项目上工作区的颜色 (同一个工作区一个色) */}
                  <span className="neox-wb-proj__icon" style={p.color ? { color: p.color } : undefined}>{openFolderIcon(p.color, 16)}</span>
                  <span className="neox-wb-proj__name">{p.name}</span>
                  {p.branch && <span className="neox-wb-proj__branch">· {p.branch}</span>}
                  <span className="neox-wb-proj__tail">
                    {onProjectMenu && (
                      <button
                        type="button"
                        className="neox-wb-proj__new"
                        title={zh ? '更多 — 重命名 / 移除 / 在访达中显示' : 'More'}
                        aria-label={zh ? '更多' : 'More'}
                        onClick={(e) => { e.stopPropagation(); onProjectMenu(p.key, e.currentTarget.getBoundingClientRect()); }}
                      ><svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" /></svg></button>
                    )}
                    {onNewInProject && (
                      <button
                        type="button"
                        className="neox-wb-proj__new"
                        title={zh ? '在这个项目里新建' : 'New task in this project'}
                        aria-label={zh ? '在这个项目里新建' : 'New task in this project'}
                        onClick={(e) => { e.stopPropagation(); onNewInProject(p.key); }}
                      >{plusIcon}</button>
                    )}
                    {!open && list.length > 0 && <span className="neox-wb-proj__count">{list.length}</span>}
                    {chevIcon(open)}
                  </span>
                </div>
                {open && shown.map(row)}
                {open && list.length > shown.length && (
                  <button type="button" className="neox-wb-proj__more" onClick={() => setFullProjects((m) => ({ ...m, [p.key]: true }))}>
                    {zh ? `还有 ${list.length - shown.length} 个 ›` : `${list.length - shown.length} more ›`}
                  </button>
                )}
                {open && list.length === 0 && <div className="neox-wb-proj__empty">{zh ? '还没有会话' : 'No chats yet'}</div>}
              </div>
            );
          })}
          {projectGroups.length > projLimit && <div ref={projMoreRef} className="neox-wb__more" aria-hidden="true" style={{ height: 1 }} />}
        </div>
      ), (onCreateProject || onOpenProject) ? (
        <button
          type="button"
          className={`wp-trigger${projMenu ? ' is-open' : ''}`}
          aria-haspopup="menu"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setProjMenu((a) => (a ? null : r)); setNewProj(null); }}
          title={zh ? '新建或打开项目' : 'New or open project'}
        >
          {plusIcon}<span>{zh ? '项目' : 'Project'}</span>
          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" /></svg>
        </button>
      ) : undefined)}
      {projMenu && (
        <CodeProjectMenu
          anchor={projMenu}
          newName={newProj}
          setNewName={setNewProj}
          onCreate={onCreateProject ? (n) => { setProjMenu(null); setNewProj(null); onCreateProject(n); } : undefined}
          onOpen={onOpenProject ? () => { setProjMenu(null); onOpenProject(); } : undefined}
          onNewWorkspace={codeWs ? () => { setWsCard({ anchor: projMenu, start: 'new' }); setProjMenu(null); } : undefined}
          onManageWorkspaces={codeWs ? () => { setWsCard({ anchor: projMenu, start: 'list' }); setProjMenu(null); } : undefined}
          workspaceCount={codeWs?.list.length}
          onClose={() => { setProjMenu(null); setNewProj(null); }}
          zh={zh}
        />
      )}
      {wsCard && codeWs && projects && (
        <CodeWorkspaceCard
          anchor={wsCard.anchor}
          start={wsCard.start}
          projects={projects.map((p) => ({ key: p.key, name: p.name }))}
          workspaces={codeWs.list}
          onSaved={codeWs.onSaved}
          onClose={() => setWsCard(null)}
          onBack={() => { const a = wsCard.anchor; setWsCard(null); setProjMenu(a); }}
          zh={zh}
        />
      )}
      {!projects && !wp && recent.length > 0 && section(zh ? '最近' : 'Recent', recentOrdered.length, (
        <div className="neox-wb__recent">
          {recent.map(row)}
          {hasMoreRecent && <div ref={moreRef} className="neox-wb__more" aria-hidden="true" style={{ height: 1 }} />}
        </div>
      ))}
      {wp && (
        <section className="neox-wb__section">
          <div className="neox-wb__label has-wp">
            <span>{zh ? '最近' : 'Recent'}</span>
            <button
              type="button"
              className={`wp-trigger${wpCurrent ? ' is-set' : ''}${wpAnchor ? ' is-open' : ''}`}
              aria-haspopup="listbox"
              aria-expanded={!!wpAnchor}
              onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setWpAnchor((a) => (a ? null : r)); }}
              title={zh ? '按项目看' : 'Filter by project'}
            >
              {wpCurrent && <img src={projectArt(wpCurrent.icon)} alt="" draggable={false} />}
              <span>{wpCurrent ? wpCurrent.name : (zh ? '全部' : 'All')}</span>
              <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" /></svg>
            </button>
          </div>
          {wpCurrent && (
            <div className="wp-head">
              <img src={projectArt(wpCurrent.icon)} alt="" draggable={false} />
              <span className="wp-head__name">{wpCurrent.name}</span>
              <span className="wp-head__count">{zh ? `${wpStats.counts.get(wpCurrent.dir) ?? 0} 个任务` : `${wpStats.counts.get(wpCurrent.dir) ?? 0} tasks`}</span>
              {wp.onProjectHome && (
                <button type="button" className="wp-head__home" onClick={() => wp.onProjectHome!(wpCurrent.dir)}>
                  {zh ? '项目主页' : 'Project'}
                  <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 3 7.5 6 4.5 9" /></svg>
                </button>
              )}
            </div>
          )}
          <div className="neox-wb__recent">
            {recent.map(row)}
            {hasMoreRecent && <div ref={moreRef} className="neox-wb__more" aria-hidden="true" style={{ height: 1 }} />}
            {recent.length === 0 && wpCurrent && <div className="wp-empty">{zh ? '这个项目还没有任务，点上面「新建任务」开始' : 'No tasks here yet'}</div>}
          </div>
          {wpAnchor && (
            <WorkProjectPicker
              anchor={wpAnchor}
              projects={wp.projects}
              counts={wpStats.counts}
              lastUsed={wpStats.lastUsed}
              current={wpCurrent?.dir ?? null}
              onPick={(d) => { setWpAnchor(null); wp.onPick(d); }}
              onCreate={(n) => { setWpAnchor(null); wp.onCreate(n); }}
              onAllProjects={wp.onAllProjects ? () => { setWpAnchor(null); wp.onAllProjects!(); } : undefined}
              onClose={() => setWpAnchor(null)}
              zh={zh}
            />
          )}
        </section>
      )}
      <div className="neox-wb__foot">
        <button type="button" className="neox-wb__all" onClick={onOverview}>
          <span>{zh ? `全部 ${sessions.length} 个会话` : `All ${sessions.length} chats`}</span>
          <kbd>{overviewKey}</kbd>
        </button>
        {onFolders && (
          <button type="button" className="neox-wb__folders" onClick={onFolders} title={zh ? '按项目文件夹列出' : 'List by project folder'}>
            {zh ? '按项目' : 'By project'}
          </button>
        )}
      </div>
    </div>
  );
};

export default SidebarWorkbench;
