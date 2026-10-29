/**
 * SurfacePanel — 右栏 Surface 容器
 *
 * 结构 (有 active surface 时):
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ SurfaceChromeBar (32px, 永远固定位置 / 永远渲染)              │
 *   │   [file tabs]   ...spacer...   [toolbar]  [module switcher]  │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ body — active viewer (纯内容, 不再画自己的 tabbar/toolbar)    │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * 三个 chrome 子区域永远在同一行同一中线; viewer 切换/file tab 切换 chrome 位置纹丝不动.
 *
 * file tabs 数据源 (按 kind 派发):
 *   · 容器型 (code/sheet/docx/pdf): surface.metadata.tabs (host 内多文件)
 *   · 单实例型 (doc/image/plan/...): 同 kind 多 surfaces 列表
 *   · web/services: chrome 不画 tabs (web 自带 url+tabs chrome; services 是 singleton)
 *
 * toolbar (按 kind 派发):
 *   · sheet/docx/pdf: 导出 + 在外部 app 打开
 *   · 其它: null
 *
 * viewer registry 按 kind 路由 — doc/diagram/image/html/web/diff/code/plan/todo/services/sheet/pdf/docx.
 */

import React from 'react';
import { disambiguateTabTitles } from './tabTitles';
import { createPortal } from 'react-dom';
import './surface.css';
import './surface-v3.css';
import { useNeoxRuntime } from '../../app/NeoxRuntimeContext';
import { TopBarHoist } from '../shell/TopBarSlot';
import { usePanelLayout, useActivePanelTab } from '../../state/panelLayoutStore';
import SurfaceLayoutButtons from './SurfaceLayoutButtons';
import { floatSurface, useAllFloatingSurfaces, type FloatingSurface } from '../../state/floatingSurfacesStore';
import { FloatingSurfaces, floatView, type PopoutEntry } from './FloatingSurfaces';
import { ViewSlot, ViewerPortals, type ViewerPortalItem } from './viewHosts';
import { Folder, looksLikeFileName } from '../../components/FileTypeIcons';
import { FileTypeIcon } from '../../components/FileTypeIcon';
import { TerminalSurfaceViewer } from './viewers/TerminalSurfaceViewer';
import {
  useSurfaces,
  useSurfacesFor,
  useActiveSurfaceId,
  setActiveSurface,
  closeSurface,
  setActiveBrowserTab,
  closeBrowserTab,
  addBrowserTab,
  isPersistentSurfaceKind,
  surfaceHasInternalTabs,
  type Surface,
  type SurfaceKind,
} from '../../state/surfaceStore';
import { useBrowserMode } from './viewers/useBrowserMode';

const TAB_ICON_SIZE = 14;

function renderChromeTabIcon(kind: SurfaceKind, title: string): React.ReactNode {
  switch (kind) {
    case 'files':
      return <Folder size={TAB_ICON_SIZE} />;
    case 'review':
      return <FileTypeIcon path="review.diff" size={TAB_ICON_SIZE} />;
    case 'git':
      return <FileTypeIcon path=".gitignore" size={TAB_ICON_SIZE} />;
    case 'docx':
      return <FileTypeIcon path="document.docx" size={TAB_ICON_SIZE} />;
    case 'sheet':
      return <FileTypeIcon path="sheet.xlsx" size={TAB_ICON_SIZE} />;
    case 'pdf':
      return <FileTypeIcon path="document.pdf" size={TAB_ICON_SIZE} />;
    case 'pptx':
      return <FileTypeIcon path="deck.pptx" size={TAB_ICON_SIZE} />;
    case 'code':
    case 'svg':
    case 'diff':
      return <FileTypeIcon path={title} size={TAB_ICON_SIZE} />;
    default:
      if (looksLikeFileName(title)) {
        return <FileTypeIcon path={title} size={TAB_ICON_SIZE} />;
      }
      return KIND_ICON[kind];
  }
}

/* viewer 全部懒加载 — SurfacePanel 本体随首屏挂载, 静态 import 会把各 viewer 的重依赖
 * (ServicesSurfaceViewer 的 xterm、SheetSurfaceViewer 的 univer CSS、PptxSurfaceViewer 的
 * pptx-renderer 等) 全数拖进首屏 main chunk。改 React.lazy 后按 kind 首次打开时才拉取,
 * 分派逻辑/props 不变。 */
const DocSurfaceViewer = React.lazy(() => import('./viewers/DocSurfaceViewer').then(m => ({ default: m.DocSurfaceViewer })));
const DiagramSurfaceViewer = React.lazy(() => import('./viewers/DiagramSurfaceViewer').then(m => ({ default: m.DiagramSurfaceViewer })));
const SheetSurfaceViewer = React.lazy(() => import('./viewers/SheetSurfaceViewer').then(m => ({ default: m.SheetSurfaceViewer })));
const ImageSurfaceViewer = React.lazy(() => import('./viewers/ImageSurfaceViewer').then(m => ({ default: m.ImageSurfaceViewer })));
const VideoSurfaceViewer = React.lazy(() => import('./viewers/VideoSurfaceViewer').then(m => ({ default: m.VideoSurfaceViewer })));
/* 跟 VideoSurfaceViewer.VIDEO_EXT 同一条 —— 那边是 lazy 模块, 这里判分支不能为了一个正则把它拉进主包 */
const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;
const HtmlSurfaceViewer = React.lazy(() => import('./viewers/HtmlSurfaceViewer').then(m => ({ default: m.HtmlSurfaceViewer })));
const WebSurfaceViewer = React.lazy(() => import('./viewers/WebSurfaceViewer').then(m => ({ default: m.WebSurfaceViewer })));
const DiffSurfaceViewer = React.lazy(() => import('./viewers/DiffSurfaceViewer').then(m => ({ default: m.DiffSurfaceViewer })));
const CodeSurfaceViewer = React.lazy(() => import('./viewers/CodeSurfaceViewer').then(m => ({ default: m.CodeSurfaceViewer })));
const PdfSurfaceViewer = React.lazy(() => import('./viewers/PdfSurfaceViewer').then(m => ({ default: m.PdfSurfaceViewer })));
const DocxSurfaceViewer = React.lazy(() => import('./viewers/DocxSurfaceViewer').then(m => ({ default: m.DocxSurfaceViewer })));
const PptxSurfaceViewer = React.lazy(() => import('./viewers/PptxSurfaceViewer').then(m => ({ default: m.PptxSurfaceViewer })));
const PlanSurfaceViewer = React.lazy(() => import('./viewers/PlanSurfaceViewer').then(m => ({ default: m.PlanSurfaceViewer })));
const TodoSurfaceViewer = React.lazy(() => import('./viewers/TodoSurfaceViewer').then(m => ({ default: m.TodoSurfaceViewer })));
const ServicesSurfaceViewer = React.lazy(() => import('./viewers/ServicesSurfaceViewer').then(m => ({ default: m.ServicesSurfaceViewer })));
const TeamSurfaceViewer = React.lazy(() => import('./viewers/TeamSurfaceViewer').then(m => ({ default: m.TeamSurfaceViewer })));
const PluginSurfaceViewer = React.lazy(() => import('./viewers/PluginSurfaceViewer').then(m => ({ default: m.PluginSurfaceViewer })));
import { ExportMenuButton, type ExportItem } from './viewers/ExportMenuButton';
import { OpenInExternalAppButton } from './viewers/OpenInExternalAppButton';
import {
  exportSheetToPdf, exportSheetToCsv,
  exportDocxToPdf, exportDocxToMarkdown,
  exportPdfToMarkdown,
} from '../../state/exportActions';
import { useSuppressBrowserView } from './viewers/useSuppressBrowserView';
import { usePopoverDismiss } from '../../hooks/usePopoverDismiss';
import { useI18n, defaultIsZh } from '../../hooks/useI18n';
import { NeoxIllus } from '../../media/illus';
import { useAgentModeVariant } from '../../hooks/useAgentModeVariant';
import { openSheetHome } from '../../state/sheetActions';
import { openPdfHome } from '../../state/pdfActions';
import { openDocxHome } from '../../state/docxActions';
import { openKindHome } from '../../state/openKindHome';
import { usePluginViews } from '../pluginViews/usePluginViews';
import { openPluginView, pluginViewUrl } from '../pluginViews/openPluginView';
import { PluginLogo, PluginViewIcon } from '../pluginViews/PluginViewIcon';
import FilesSurfaceViewer from './viewers/FilesSurfaceViewer';
import GitSurfaceViewer from './viewers/GitSurfaceViewer';
import ReviewSurfaceViewer from './viewers/ReviewSurfaceViewer';
import artFiles from '../../media/clay/sfc-files.webp';
import artGit from '../../media/clay/sfc-git.webp';
import artSheet from '../../media/clay/sfc-sheet.webp';
import artDocx from '../../media/clay/sfc-docx.webp';
import artPdf from '../../media/clay/sfc-pdf.webp';
import artWeb from '../../media/clay/sfc-web.webp';
import artPlan from '../../media/clay/sfc-plan.webp';
import artTodo from '../../media/clay/sfc-todo.webp';
import artTeam from '../../media/clay/sfc-team.webp';
import artTerminal from '../../media/clay/sfc-terminal.webp';
import artServices from '../../media/clay/sfc-services.webp';
import { sessionCwd } from '../../utils/pathUtils';

/* Surface「新建」菜单的陶土小图标 (设计稿 v5) —— 没列的 kind 退回线稿 KIND_ICON */
const KIND_ART: Partial<Record<string, string>> = {
  files: artFiles, git: artGit, sheet: artSheet, docx: artDocx, pdf: artPdf, web: artWeb,
  plan: artPlan, todo: artTodo, team: artTeam, terminal: artTerminal, services: artServices,
};

/* monoline SVG icons — 跟 timeline / sidebar 同风格. */
const mkIcon = (path: React.ReactNode) => (
  <svg viewBox="0 0 14 14" width={TAB_ICON_SIZE} height={TAB_ICON_SIZE} fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);
const KIND_ICON: Record<SurfaceKind, React.ReactNode> = {
  doc: mkIcon(<><path d="M3 2 H8.5 L11 4.5 V12 H3 Z" /><path d="M8.5 2 V4.5 H11" /><path d="M5 7 H9" /><path d="M5 9.5 H8" /></>),
  diagram: mkIcon(<><rect x="2" y="2.5" width="3.5" height="3" rx=".4" /><rect x="8.5" y="2.5" width="3.5" height="3" rx=".4" /><rect x="5.25" y="8.5" width="3.5" height="3" rx=".4" /><path d="M3.75 5.5 V7.5 H10.25 V5.5" /><path d="M7 7.5 V8.5" /></>),
  image: mkIcon(<><rect x="2" y="2.5" width="10" height="9" rx="1" /><circle cx="5" cy="5.5" r="1" /><path d="M2.5 10 L5.5 7.5 L8 9.5 L11 6.5" /></>),
  html: mkIcon(<><path d="M2 3 L2.8 11 L7 12 L11.2 11 L12 3 Z" /><path d="M4.5 5.5 H9.5" /><path d="M5 8 H9" /></>),
  svg: mkIcon(<><polygon points="7,2 11.5,5 10,11 4,11 2.5,5" /></>),
  web: mkIcon(<><circle cx="7" cy="7" r="5" /><ellipse cx="7" cy="7" rx="2.5" ry="5" /><path d="M2 7 H12" /></>),
  pdf: mkIcon(<><path d="M3 2 H8.5 L11 4.5 V12 H3 Z" /><path d="M8.5 2 V4.5 H11" /><path d="M5 9 H9" /></>),
  diff: mkIcon(<><path d="M4 3 V11" /><path d="M2 5 H6" /><path d="M8 3 V11" /><path d="M8 9 H12" /></>),
  code: mkIcon(<><path d="M5 4 L2 7 L5 10" /><path d="M9 4 L12 7 L9 10" /><path d="M6.5 11.5 L7.5 2.5" /></>),
  plan: mkIcon(<><rect x="2" y="3.5" width="10" height="7.5" rx=".5" /><path d="M2 5.5 H12" /><path d="M4 8 H7" /><path d="M4 9.5 H6" /></>),
  todo: mkIcon(<><rect x="2" y="2.5" width="3" height="3" rx=".4" /><path d="M2.7 4 L3.3 4.6 L4.5 3.2" /><path d="M6.5 4 H12" /><rect x="2" y="7.5" width="3" height="3" rx=".4" /><path d="M6.5 9 H10.5" /></>),
  terminal: mkIcon(<><rect x="1.5" y="2.5" width="11" height="9" rx="1.2" /><path d="M4 6l1.8 1.6L4 9.2" /><path d="M7.6 9.4h2.6" /></>),
  review: mkIcon(<><rect x="2" y="2.5" width="10" height="9" rx="1" /><path d="M4.5 6 H9.5" /><path d="M4.5 8.5 H8" /><path d="M9 9.5 l1 1 l2-2" /></>),
  services: mkIcon(<><rect x="2" y="3" width="4.5" height="3" rx=".4" /><rect x="7.5" y="3" width="4.5" height="3" rx=".4" /><rect x="2" y="8" width="4.5" height="3" rx=".4" /><rect x="7.5" y="8" width="4.5" height="3" rx=".4" /><circle cx="3" cy="4.5" r=".5" fill="currentColor" stroke="none" /></>),
  sheet: mkIcon(<><rect x="2" y="2.5" width="10" height="9" rx=".4" /><path d="M2 5 H12" /><path d="M2 8 H12" /><path d="M5 2.5 V11.5" /><path d="M8.5 2.5 V11.5" /></>),
  docx: mkIcon(<><path d="M3 2 H8.5 L11 4.5 V12 H3 Z" /><path d="M8.5 2 V4.5 H11" /><path d="M5 6.5 H9" /><path d="M5 8.5 H9" /><path d="M5 10.5 H7.5" /></>),
  pptx: mkIcon(<><rect x="2" y="3" width="10" height="7" rx=".4" /><path d="M2 8 H12" /><path d="M5 11.5 H9" /><path d="M6 10 V11.5" /><path d="M8 10 V11.5" /></>),
  /* files: Lucide folder-open 心智, 比「开口方框」更像资源管理器 */
  files: mkIcon(<><path d="M2.2 5.2 V11.2 A.8.8 0 0 0 3 12 H11.2 A.8.8 0 0 0 12 11.2 V6.2 A.8.8 0 0 0 11.2 5.4 H7.1 L5.7 4 H3 A.8.8 0 0 0 2.2 4.8 Z" strokeWidth="1.35" /><path d="M2.2 5.8 H12" strokeWidth="1.2" /></>),
  /* git: Lucide git-branch — 主干+分叉节点, 一眼认得 */
  git: mkIcon(<><circle cx="5" cy="3.2" r="1.35" /><circle cx="5" cy="10.8" r="1.35" /><circle cx="10.5" cy="7" r="1.35" /><path d="M5 4.55 V9.45" strokeWidth="1.4" /><path d="M5 4.55 C5 6.2 6.5 7 9.1 7" strokeWidth="1.4" /></>),
  /* plugin: 拼图块 —— 跟侧栏「插件」入口同一个意思 */
  plugin: mkIcon(<><path d="M2.5 4.5 H5 A1.2 1.2 0 1 1 7.4 4.5 H10 V7 A1.2 1.2 0 1 1 10 9.4 V11.5 H2.5 Z" /></>),
  team: mkIcon(<><circle cx="7" cy="4.6" r="1.9" /><path d="M3.4 11.6 C3.4 9.5 5 8.3 7 8.3 C9 8.3 10.6 9.5 10.6 11.6" /><circle cx="2.6" cy="6.2" r="1.35" /><path d="M1 11.6 C1 10.1 1.6 9.2 2.9 8.9" /><circle cx="11.4" cy="6.2" r="1.35" /><path d="M13 11.6 C13 10.1 12.4 9.2 11.1 8.9" /></>),
};

function getKindLabel(isZh: boolean): Record<SurfaceKind, string> {
  return isZh
    ? {
        doc: '文档', diagram: '图', image: '图片', html: 'HTML', svg: 'SVG',
        web: '浏览器', pdf: 'PDF', diff: 'Diff', code: '源码',
        plan: '方案', todo: '清单',
        services: '服务', sheet: '表格', docx: 'Word', pptx: 'PPT', team: '团队',
        files: '文件', git: 'Git', terminal: '终端', review: '审阅', plugin: '插件',
      }
    : {
        doc: 'Doc', diagram: 'Diagram', image: 'Image', html: 'HTML', svg: 'SVG',
        web: 'Browser', pdf: 'PDF', diff: 'Diff', code: 'Code',
        plan: 'Plan', todo: 'Todo',
        services: 'Services', sheet: 'Sheet', docx: 'Word', pptx: 'PPT', team: 'Team',
        files: 'Files', git: 'Git', terminal: 'Terminal', review: 'Review', plugin: 'Plugin',
      };
}

/* ──────────────────────────────────────────────────────────────────────
 * lastActiveByKind — 每 session 每 kind 记忆"最近一次激活的 surface".
 *   切到模块 X 再切 Y, 回 X 应该回到他离开时看的那个.
 *   module-scope Map; 这是 UI 决策不是数据本体, 跨刷新可丢.
 * ────────────────────────────────────────────────────────────────────── */
const lastActiveByKind = new Map<string, Map<SurfaceKind, string>>();
function recordKindActive(sessionId: string, kind: SurfaceKind, surfaceId: string): void {
  let m = lastActiveByKind.get(sessionId);
  if (!m) { m = new Map(); lastActiveByKind.set(sessionId, m); }
  m.set(kind, surfaceId);
}
function getKindActive(sessionId: string, kind: SurfaceKind): string | undefined {
  return lastActiveByKind.get(sessionId)?.get(kind);
}

/* ──────────────────────────────────────────────────────────────────────
 * 计算 chrome bar 上要展示的 file tabs + toolbar
 *
 *   chrome bar 永远在 SurfacePanel 顶部固定位置. 数据按 active kind 派发:
 *
 *   容器型 (code/sheet/docx/pdf): 用 surface.metadata.tabs 当 file tabs;
 *     toolbar 显示 "导出 + 外部打开" (sheet/docx/pdf, code 无 toolbar)
 *
 *   单实例型 (doc/image/diagram/html/svg/plan/todo/diff): 用同 kind 的多个 surfaces 当 file tabs;
 *     无 toolbar
 *
 *   web: chrome bar 不画 tabs/toolbar (web viewer 自带 url+tabs+nav 一整套 chrome)
 *   services: singleton, 无 tabs 也无 toolbar
 * ────────────────────────────────────────────────────────────────────── */

interface ChromeTab {
  id: string;
  title: string;
  kind: SurfaceKind;
  isActive: boolean;
  onActivate: () => void;
  /** 关闭 — 单 tab/单实例时通常为空 (用关闭整个 surface 替代). */
  onClose?: () => void;
  /** 'surface' = 另一个已打开的能力 (浏览器/服务/文档…), 'file' = 当前能力内部的文件/标签页.
   *  两类并排显示, 中间一道分隔 —— 用户要的是"不同能力都在 tab 上", 而不是藏进右边的菜单。 */
  group?: 'surface' | 'file';
  /** 工作区级常驻 (服务/浏览器这种跨会话的), UI 上钉在最左, 跟会话临时的分开。 */
  persistent?: boolean;
  /** kind=plugin: 插件名 (从 neox-plugin://<name>/ 地址取), tab 图标用它的 logo */
  pluginName?: string;
  /** 拖出成单独浮窗用: 哪个 surface, 文件类容器里再加哪个文件 (浏览器的标签背后是原生视图, 不给拖) */
  hostId?: string;
  tabId?: string;
}


function sheetExportItems(filePath: string, isZh: boolean): ExportItem[] {
  return [
    { label: isZh ? '导出 PDF' : 'Export PDF', hint: isZh ? '汇报场景: 直接发老板/客户' : 'For reporting — send straight to your boss or client', onPick: () => exportSheetToPdf(filePath) },
    { label: isZh ? '导出 CSV' : 'Export CSV', hint: isZh ? '兼容传统系统, 仅第一个 sheet' : 'Legacy-friendly, first sheet only', onPick: () => exportSheetToCsv(filePath) },
  ];
}
function docxExportItems(filePath: string, isZh: boolean): ExportItem[] {
  return [
    { label: isZh ? '导出 PDF' : 'Export PDF', hint: isZh ? '汇报场景: 排版稳定, 发团队/客户' : 'For reporting — stable layout for team/client', onPick: () => exportDocxToPdf(filePath) },
    { label: isZh ? '导出 Markdown' : 'Export Markdown', hint: isZh ? '转 Notion / 喂 LLM / git diff' : 'Move to Notion, feed an LLM, or git diff', onPick: () => exportDocxToMarkdown(filePath) },
  ];
}
function pdfExportItems(filePath: string, isZh: boolean): ExportItem[] {
  return [
    /* 只留 Markdown 导出: 它已经按 `## Page N` 分章, 同时可当纯文本读, 比 .txt 严格更有用. */
    { label: isZh ? '导出 Markdown' : 'Export Markdown', hint: isZh ? '按页分章, 可当文本读 / 喂 AI' : 'One chapter per page — reads as text, feeds an AI', onPick: () => exportPdfToMarkdown(filePath) },
  ];
}

/** active container surface (code/sheet/docx/pdf) → 当前 active 文件 path (inline-* 时返 undefined). */
function activeContainerFilePath(active: Surface): string | undefined {
  const rawTabs = (active.metadata?.tabs as Array<{ id: string; url: string }> | undefined) ?? [];
  const activeTabId = active.metadata?.activeTabId as string | undefined;
  const url = rawTabs.find(t => t.id === activeTabId)?.url ?? rawTabs[0]?.url;
  if (!url || url.startsWith('inline-')) return undefined;
  return url;
}

/** 单实例型 surface (doc/image/svg/diagram/...) 的文件路径 — file 源才有. */
function activeSingleFilePath(active: Surface): string | undefined {
  return active.source.type === 'file' ? active.source.path : undefined;
}

function renderKindToolbar(active: Surface, isZh: boolean): React.ReactNode {
  switch (active.kind) {
    case 'sheet': {
      const fp = activeContainerFilePath(active);
      if (!fp) return null;
      return (
        <>
          <ExportMenuButton filePath={fp} items={sheetExportItems(fp, isZh)} />
          <OpenInExternalAppButton filePath={fp} label={isZh ? '在 Excel / WPS 打开' : 'Open in Excel / WPS'} text={isZh ? '用 Excel 打开' : 'Open in Excel'} />
        </>
      );
    }
    case 'docx': {
      const fp = activeContainerFilePath(active);
      if (!fp) return null;
      return (
        <>
          <ExportMenuButton filePath={fp} items={docxExportItems(fp, isZh)} />
          <OpenInExternalAppButton filePath={fp} label={isZh ? '在 Word / WPS 打开' : 'Open in Word / WPS'} text={isZh ? '用 Word 打开' : 'Open in Word'} />
        </>
      );
    }
    case 'pptx': {
      const fp = activeContainerFilePath(active);
      if (!fp) return null;
      return (
        <OpenInExternalAppButton filePath={fp} label={isZh ? '在 Keynote / PPT 打开' : 'Open in Keynote / PPT'} text={isZh ? '用 PPT 打开' : 'Open in PowerPoint'} />
      );
    }
    case 'pdf': {
      const fp = activeContainerFilePath(active);
      if (!fp) return null;
      return (
        <>
          <ExportMenuButton filePath={fp} items={pdfExportItems(fp, isZh)} />
          <OpenInExternalAppButton filePath={fp} label={isZh ? '在 Acrobat / 预览 打开' : 'Open in Acrobat / Preview'} text={isZh ? '用预览打开' : 'Open in Preview'} />
        </>
      );
    }
    /* code: 容器型但历史上无 toolbar — 补"在外部编辑器/应用打开"(file tab 才有). */
    case 'code': {
      const fp = activeContainerFilePath(active);
      if (!fp) return null;
      return (
        <OpenInExternalAppButton filePath={fp} label={isZh ? '在外部应用打开' : 'Open in external app'} />
      );
    }
    /* 单实例型 (doc/image/svg): file 源补"在系统默认应用打开"; inline 源无路径不显.
     * 复制/另存为等需要 viewer 内容 state 的操作放各 viewer 自己的工具条. */
    case 'doc': {
      const fp = activeSingleFilePath(active);
      if (!fp) return null;
      return (
        <OpenInExternalAppButton filePath={fp} label={isZh ? '在外部应用打开' : 'Open in external app'} />
      );
    }
    case 'image':
    case 'svg': {
      const fp = activeSingleFilePath(active);
      if (!fp) return null;
      return (
        <OpenInExternalAppButton filePath={fp} label={isZh ? '在外部应用打开' : 'Open in external app'} />
      );
    }
    default:
      return null;
  }
}

const VIEWER_HEAD_KINDS = new Set(['sheet', 'docx', 'pptx', 'pdf', 'doc', 'image', 'svg', 'code']);
const VIEWER_TYPE: Record<string, { tag: string; bg: string; fg: string; zh: string; en: string }> = {
  docx: { tag: 'W', bg: '#e8efff', fg: '#2b5ccc', zh: 'Word 文档', en: 'Word document' },
  doc: { tag: 'W', bg: '#e8efff', fg: '#2b5ccc', zh: 'Word 文档', en: 'Word document' },
  xlsx: { tag: 'X', bg: '#e5f5ea', fg: '#1f8a4c', zh: '表格', en: 'Spreadsheet' },
  xls: { tag: 'X', bg: '#e5f5ea', fg: '#1f8a4c', zh: '表格', en: 'Spreadsheet' },
  csv: { tag: 'CSV', bg: '#e5f5ea', fg: '#1f8a4c', zh: '表格', en: 'Spreadsheet' },
  pptx: { tag: 'P', bg: '#fdeee4', fg: '#c45a1c', zh: '演示文稿', en: 'Presentation' },
  ppt: { tag: 'P', bg: '#fdeee4', fg: '#c45a1c', zh: '演示文稿', en: 'Presentation' },
  pdf: { tag: 'PDF', bg: '#fbe9e7', fg: '#c0392b', zh: 'PDF', en: 'PDF' },
  md: { tag: 'MD', bg: '#eef0ec', fg: '#55604e', zh: '文档', en: 'Document' },
  png: { tag: 'IMG', bg: '#eaf4f7', fg: '#1d7fa0', zh: '图片', en: 'Image' },
  jpg: { tag: 'IMG', bg: '#eaf4f7', fg: '#1d7fa0', zh: '图片', en: 'Image' },
  jpeg: { tag: 'IMG', bg: '#eaf4f7', fg: '#1d7fa0', zh: '图片', en: 'Image' },
  webp: { tag: 'IMG', bg: '#eaf4f7', fg: '#1d7fa0', zh: '图片', en: 'Image' },
  svg: { tag: 'SVG', bg: '#f1ebff', fg: '#7b5ad8', zh: '矢量图', en: 'Vector' },
};
function ViewerHead({ active, isZh }: { active: Surface; isZh: boolean }): React.ReactElement | null {
  if (!VIEWER_HEAD_KINDS.has(active.kind)) return null;
  const fp = (['sheet', 'docx', 'pptx', 'pdf', 'code'].includes(active.kind) ? activeContainerFilePath(active) : activeSingleFilePath(active));
  if (!fp) return null;
  const parts = fp.split(/[\\/]/);
  const name = parts.pop() || fp;
  const folder = parts.pop() || '';
  const ext = (name.split('.').pop() || '').toLowerCase();
  const t = VIEWER_TYPE[ext] ?? { tag: ext.slice(0, 3).toUpperCase() || 'FILE', bg: '#f1eee9', fg: '#8a8277', zh: '文件', en: 'File' };
  const toolbar = renderKindToolbar(active, isZh);
  return (
    <div className="sfc-vhead">
      <span className="sfc-vhead__tag" style={{ background: t.bg, color: t.fg }}>{t.tag}</span>
      <span className="sfc-vhead__text">
        <span className="sfc-vhead__name" title={fp}>{name}</span>
        <span className="sfc-vhead__sub">{isZh ? t.zh : t.en}{folder ? ` · ${folder}` : ''}</span>
      </span>
      {toolbar && <span className="sfc-vhead__actions">{toolbar}</span>}
    </div>
  );
}

function computeChromeTabs(
  active: Surface,
  surfaces: Surface[],
  sessionId: string,
  isZh: boolean,
  isExternalBrowser: boolean,
): ChromeTab[] {
  const KIND_LABEL = getKindLabel(isZh);
  const out: ChromeTab[] = [];

  const sorted = [...surfaces].sort((a, b) => {
    const pa = isPersistentSurfaceKind(a.kind) ? 0 : 1;
    const pb = isPersistentSurfaceKind(b.kind) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });

  for (const s of sorted) {
    /* 外置浏览器: 真 tab 在独立 Chrome 里, 这里只留一个 host 入口 */
    if (s.kind === 'web' && isExternalBrowser) {
      out.push({
        id: `__host__:${s.id}`,
        kind: 'web',
        title: s.title || KIND_LABEL.web,
        isActive: active.id === s.id,
        group: 'file',
        persistent: true,
        onActivate: () => setActiveSurface(sessionId, s.id),
        onClose: () => closeSurface(sessionId, s.id),
      });
      continue;
    }

    if (surfaceHasInternalTabs(s.kind)) {
      const allTabs = (s.metadata?.tabs as Array<{ id: string; url: string; title?: string }> | undefined) ?? [];
      const rawTabs = allTabs.filter((t) => !String(t.url ?? '').startsWith('inline-'));
      if (rawTabs.length === 0) {
        out.push({
          id: `__home__:${s.id}`,
          kind: s.kind,
          title: KIND_LABEL[s.kind],
          isActive: active.id === s.id,
          group: 'file',
          persistent: isPersistentSurfaceKind(s.kind),
          hostId: s.kind === 'web' ? undefined : s.id,
          onActivate: () => setActiveSurface(sessionId, s.id),
          onClose: () => closeSurface(sessionId, s.id),
        });
        continue;
      }
      const activeTabId = s.metadata?.activeTabId as string | undefined;
      const titles = disambiguateTabTitles(
        rawTabs.map((t) => ({ title: t.title || t.url.split(/[/\\]/).pop() || 'untitled', path: t.url })),
      );
      rawTabs.forEach((t, i) => {
        const hostId = s.id;
        const tabId = t.id;
        out.push({
          /* 跨 host 拼唯一 id, 避免两个容器碰巧同 tabId 时 React key 撞车 */
          id: `${hostId}::${tabId}`,
          kind: s.kind,
          title: titles[i]!,
          isActive: active.id === hostId && (activeTabId ? activeTabId === tabId : i === 0),
          group: 'file',
          hostId: s.kind === 'web' ? undefined : hostId,
          tabId,
          onActivate: () => {
            if (active.id !== hostId) setActiveSurface(sessionId, hostId);
            setActiveBrowserTab(sessionId, hostId, tabId);
          },
          onClose: () => closeBrowserTab(sessionId, hostId, tabId),
        });
      });
      continue;
    }

    /* singleton / per-source / always-new —— 每个 surface 一格, 样式跟文件 tab 同一套
     * (不再标 is-other 发灰, 「文件」跟 env.mjs 必须长得一样) */
    if (s.kind === 'services' || s.kind === 'files' || s.kind === 'git' || s.kind === 'team' || s.kind === 'todo' || s.kind === 'plugin') {
      out.push({
        id: `__host__:${s.id}`,
        kind: s.kind,
        title: s.title || KIND_LABEL[s.kind],
        isActive: active.id === s.id,
        group: 'file',
        persistent: isPersistentSurfaceKind(s.kind),
        pluginName: s.kind === 'plugin' && s.source.type === 'url'
          ? /^neox-plugin:\/\/([^/]+)/.exec(s.source.url)?.[1]
          : undefined,
        hostId: s.id,
        onActivate: () => setActiveSurface(sessionId, s.id),
        onClose: () => closeSurface(sessionId, s.id),
      });
      continue;
    }

    /* per-source / always-new: 同 kind 每个 surface 一个 tab */
    out.push({
      id: s.id,
      kind: s.kind,
      title: s.title || KIND_LABEL[s.kind],
      isActive: active.id === s.id,
      group: 'file',
      hostId: s.id,
      onActivate: () => setActiveSurface(sessionId, s.id),
      onClose: () => closeSurface(sessionId, s.id),
    });
  }

  /* 不同类型撞了名 (PPT 和它的网页预览都叫「豆角咖啡」, 10-15 QA): 名字后面带上类型, 一眼分得清 */
  const byTitle = new Map<string, ChromeTab[]>();
  for (const t of out) byTitle.set(t.title, [...(byTitle.get(t.title) ?? []), t]);
  for (const same of byTitle.values()) {
    if (same.length < 2 || new Set(same.map((t) => t.kind)).size < 2) continue;
    for (const t of same) t.title = `${t.title} · ${KIND_LABEL[t.kind] ?? t.kind}`;
  }

  return out;
}

/* ──────────────────────────────────────────────────────────────────────
 * OpenSurfaceMenu — 模块切换器按钮 + popover (右侧固定位置, chrome bar 一员)
 *
 *   按钮 [⊞ 当前 kind 名 N ▾]
 *   popover:
 *     · "已打开 (N 个模块)" — 列已存在的 kind, 点击切到该 kind 的 lastActive surface
 *     · "新建..." — 列可主动创建的 kind, 已开过的右侧标 "已打开"
 * ────────────────────────────────────────────────────────────────────── */
interface OpenableSurfaceItem {
  kind: SurfaceKind;
  /** 'home' = 创建 isHome placeholder, viewer 显引导页. 'direct' = 直接 ingest 真 surface. */
  trigger: 'direct' | 'home';
  hint?: string;
}
function getOpenableItems(isZh: boolean, mode?: 'work' | 'code'): OpenableSurfaceItem[] {
  const plain = mode === 'work';
  const all: OpenableSurfaceItem[] = isZh
    ? [
        /* 文件 / Git 排最前 —— 日常开发最先要的两样。
         *
         * 「源码」不再单列: 它本来就只是"恰好是代码的文件", 从文件管理器双击进去,
         * openSurfaceFromPath 会按扩展名路由到 Monaco / 表格 / PDF / Word。多摆一项
         * 只会让人 (和 agent) 在"该开源码还是开文件"之间犹豫。
         *
         * 「Diff」同理不再单列: 它是 Git 面板点一个改动文件的结果, 是产物不是入口。 */
        { kind: 'files',    trigger: 'direct',  hint: '浏览、搜索项目里的文件' },
        { kind: 'git',      trigger: 'direct',  hint: '看改动、提交、推送' },
        { kind: 'sheet',    trigger: 'home',    hint: '新建或打开 .xlsx / .csv' },
        { kind: 'docx',     trigger: 'home',    hint: '打开 .docx' },
        { kind: 'pdf',      trigger: 'home',    hint: '打开 .pdf' },
        { kind: 'web',      trigger: 'home',    hint: '打开一个网址' },
        { kind: 'plan',     trigger: 'home',    hint: plain ? '这件事分几步做' : 'Agent 写的计划, 分节带状态' },
        { kind: 'todo',     trigger: 'home',    hint: '这条任务的待办' },
        { kind: 'team',     trigger: 'direct',  hint: '需求、人员、分工看板' },
        { kind: 'terminal', trigger: 'direct',  hint: '自己敲命令' },
        { kind: 'services', trigger: 'direct',  hint: '跑着的进程和日志' },
      ]
    : [
        { kind: 'files',    trigger: 'direct',  hint: 'Browse and search the project' },
        { kind: 'git',      trigger: 'direct',  hint: 'Changes, commit, push' },
        { kind: 'sheet',    trigger: 'home',    hint: 'New or open .xlsx / .csv' },
        { kind: 'docx',     trigger: 'home',    hint: 'Open a .docx' },
        { kind: 'pdf',      trigger: 'home',    hint: 'Open a .pdf' },
        { kind: 'web',      trigger: 'home',    hint: 'Open a URL' },
        { kind: 'plan',     trigger: 'home',    hint: 'The agent’s plan, by section' },
        { kind: 'todo',     trigger: 'home',    hint: 'This task’s to-dos' },
        { kind: 'team',     trigger: 'direct',  hint: 'Requirements, people, assignments' },
        { kind: 'terminal', trigger: 'direct',  hint: 'Type commands yourself' },
        { kind: 'services', trigger: 'direct',  hint: 'Running processes and logs' },
      ];
  if (plain) {
    const WORK_HIDDEN: SurfaceKind[] = ['git', 'services', 'team', 'terminal'];
    return all.filter((i) => !WORK_HIDDEN.includes(i.kind));
  }
  return all;
}

const OpenSurfaceMenu: React.FC<{
  surfaces: Surface[];
  activeId?: string;
  sessionId: string;
}> = ({ surfaces, activeId, sessionId }) => {
  const { createNewSession } = useNeoxRuntime();
  const { isZh } = useI18n();
  const modeVariant = useAgentModeVariant();
  const KIND_LABEL = getKindLabel(isZh);
  const OPENABLE_ITEMS = getOpenableItems(isZh, modeVariant.isWork ? 'work' : 'code');
  const pluginViews = usePluginViews();
  const [open, setOpen] = React.useState(false);
  const [menuPos, setMenuPos] = React.useState<{ top: number; right: number } | null>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  useSuppressBrowserView(open, menuRef);
  React.useEffect(() => {
    if (!open || !btnRef.current) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => !e.isIntersecting || e.boundingClientRect.width === 0)) setOpen(false);
    });
    io.observe(btnRef.current);
    return () => io.disconnect();
  }, [open]);
  usePopoverDismiss({
    open,
    refs: [btnRef, menuRef],
    onDismiss: () => setOpen(false),
  });

  /* 打开时按按钮真实位置算菜单坐标 — 用 fixed + portal 避开 overflow 截断. */
  const toggleOpen = () => {
    if (open) { setOpen(false); return; }
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      setMenuPos({
        top: rect.bottom + 2,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    }
    setOpen(true);
  };

  const isAlreadyOpen = (kind: SurfaceKind): boolean => surfaces.some(s => s.kind === kind);

  const openOne = async (item: OpenableSurfaceItem) => {
    setOpen(false);
    /* 没活动会话时惰性建一个 — 手动开本地工具(代码/表格/Word/PDF/浏览器)不该要求先有聊天会话,
     * 否则刚进 app 没聊天就点啥都没反应。跟聊天发第一条消息时一样按需建会话。 */
    let sid = sessionId;
    if (!sid) {
      const s = await createNewSession();
      if (!s) return;   /* 建会话失败 (无 model / 无 workspace) → 放弃, 不静默卡死 */
      sid = s.id;
    }
    if (item.kind === 'sheet') { openSheetHome({ sessionId: sid }); return; }
    if (item.kind === 'docx')  { openDocxHome({ sessionId: sid }); return; }
    if (item.kind === 'pdf')   { openPdfHome({ sessionId: sid }); return; }
    if (item.trigger === 'direct') {
      window.dispatchEvent(new CustomEvent('neox:open-surface', {
        detail: {
          kind: item.kind,
          title: KIND_LABEL[item.kind],
          source: { type: 'inline', content: '', mime: 'text/plain' },
          metadata: { singleton: true },
          /* 用户手动开 —— terminal 这类只认这条路, agent 推的会被拒 (见 surfaceStore) */
          byUser: true,
        },
      }));
      return;
    }
    /* 其它 kind (code/web/plan/todo) — 创建 isHome placeholder, viewer 自渲染 KindHomeView. */
    openKindHome({ sessionId: sid, kind: item.kind });
  };

  const active = surfaces.find(s => s.id === activeId) ?? pickDefaultSurface(surfaces) ?? null;
  const totalCount = surfaces.length;
  const openModuleCount = new Set(surfaces.map(s => s.kind)).size;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`sfc-chrome__switch-btn${open ? ' is-open' : ''}`}
        onClick={toggleOpen}
        title={active
          ? (isZh
              ? `当前 ${KIND_LABEL[active.kind]} · 共 ${totalCount} 个 surface`
              : `Current: ${KIND_LABEL[active.kind]} · ${totalCount} surface${totalCount === 1 ? '' : 's'}`)
          : (isZh ? '打开 surface' : 'Open a surface')}
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
          <rect x="2.5" y="2.5" width="8.6" height="8.6" rx="2.8" />
          <rect x="12.9" y="2.5" width="8.6" height="8.6" rx="2.8" />
          <rect x="2.5" y="12.9" width="8.6" height="8.6" rx="2.8" />
          <rect x="12.9" y="12.9" width="8.6" height="8.6" rx="2.8" opacity=".5" />
        </svg>
        {/* 设计稿 v5: 四宫格后面跟一个「新建」字 —— 这颗按钮打开的就是「新建 / 打开哪种页面」的清单 */}
      </button>
      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          className="sfc-chrome__switch-menu"
          role="menu"
          style={{ top: menuPos.top, right: menuPos.right }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* 这里原本还有一段「已打开 (N 个模块)」的列表 —— 已经删掉。
              那份信息现在完整地摆在左边 tab 条上 (每个能力一个 tab, 点一下就切),
              菜单里再列一遍纯属重复, 还把"新建"挤到了下面要多滚一下。
              菜单现在只干一件事: 新建。 */}
          <div className="sfc-chrome__switch-menu-section">{isZh ? '新建' : 'New'}</div>
          {OPENABLE_ITEMS.map(item => {
            const opened = isAlreadyOpen(item.kind);
            return (
              <button
                key={item.kind}
                type="button"
                className="sfc-chrome__switch-menu-item"
                onClick={() => openOne(item)}
                role="menuitem"
                title={item.hint}
              >
                <span className={`sfc-chrome__switch-menu-icon${opened ? ' is-open' : ''}${KIND_ART[item.kind] ? ' is-clay' : ''}`} aria-hidden="true">
                  {/* UI 3.0 (设计稿 v5 Surface 新建菜单): 有陶土小图标的用陶土, 没有的退回线稿 */}
                  {KIND_ART[item.kind]
                    ? <img src={KIND_ART[item.kind]} alt="" width={22} height={22} draggable={false} />
                    : KIND_ICON[item.kind]}
                  {opened && <span className="sfc-chrome__switch-menu-dot" />}
                </span>
                {/* 两行: 名字 + 什么时候用 (Surface 稿 · ＋ 菜单) */}
                <span className="sfc-chrome__switch-menu-text">
                  <span className="sfc-chrome__switch-menu-label">{KIND_LABEL[item.kind]}</span>
                  {item.hint && <span className="sfc-chrome__switch-menu-hint">{item.hint}</span>}
                </span>
              </button>
            );
          })}
          {pluginViews.length > 0 && (
            <>
              <div className="sfc-chrome__switch-menu-section">{isZh ? '插件' : 'Plugins'}</div>
              {pluginViews.map(v => {
                const url = pluginViewUrl(v);
                const opened = surfaces.some(s => s.kind === 'plugin' && s.source.type === 'url' && s.source.url === url);
                return (
                  <button
                    key={`${v.pluginName}/${v.id}`}
                    type="button"
                    className="sfc-chrome__switch-menu-item"
                    onClick={() => { setOpen(false); openPluginView(v); }}
                    role="menuitem"
                    title={v.pluginName}
                  >
                    <PluginViewIcon
                      pluginName={v.pluginName}
                      emoji={v.iconIsEmoji ? v.icon : undefined}
                      fallback={KIND_ICON.plugin}
                      className="sfc-chrome__switch-menu-icon"
                    >
                      {opened && <span className="sfc-chrome__switch-menu-dot" />}
                    </PluginViewIcon>
                    <span className="sfc-chrome__switch-menu-label">{v.title}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
};

/* ──────────────────────────────────────────────────────────────────────
 * SurfaceChromeBar — 永远固定在 SurfacePanel 顶部, 三区位置永不抖
 *
 *   [file tabs (flex:1, overflow-x: auto)]   [toolbar]   [module switcher]
 *
 *   web/services 时 tabs/toolbar 都空, 也不让 chrome bar 自己收缩 — 保持 32px 一行,
 *   只留 module switcher; viewer body 内部 (web) 自己再叠一层 url+tabs chrome.
 * ────────────────────────────────────────────────────────────────────── */
const SurfaceChromeBar: React.FC<{
  active: Surface;
  surfaces: Surface[];
  activeId?: string;
  sessionId: string;
}> = ({ active, surfaces, activeId, sessionId }) => {
  const { isZh } = useI18n();
  const { activeSession, workspacePath } = useNeoxRuntime();
  const sessionWs = sessionCwd(activeSession) || workspacePath;
  const browserMode = useBrowserMode();
  /* external + loading 都视作外置 — loading 期间也别短暂闪一排内嵌 tab.
   * useBrowserMode 自己的 fallback 就是 external, 这里跟着保守. */
  const isExternalBrowser = browserMode !== 'embedded';
  const fileTabs = computeChromeTabs(active, surfaces, sessionId, isZh, isExternalBrowser);
  /* 查看器类的「导出 / 用 xx 打开」挪到下面的 ViewerHead, 标签栏只放标签 */
  const toolbar = VIEWER_HEAD_KINDS.has(active.kind) ? null : renderKindToolbar(active, isZh);
  /* web 多 tab 时 chrome 末尾给一个 "+" 入口, 替代过去 web 内部 tab bar 的 + 按钮.
   * home 状态 (fileTabs 是单 home tab) 不显 + — 用户应该先在 home view 里点"新建标签页".
   * 外置模式下 tab 全在独立 Chrome 里管, 这个 + 也不出. */
  const showAddTabBtn = active.kind === 'web'
    && !isExternalBrowser
    && fileTabs.length > 0
    && fileTabs[0]!.id !== `__home__:${active.id}`;
  const newTabTitle = isZh ? '新标签页' : 'New tab';

  /* tab 一多就横向滚, 但激活的那个可能正好滚在视野外 —— 切过去以后一眼看不到自己在哪。
   * 每次激活项变了就把它带回视野 (nearest: 已经看得见就不动, 不无谓地跳)。 */
  const tabsRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = tabsRef.current?.querySelector('.sfc-chrome__tab.is-active');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, fileTabs.length]);

  /* 标签栏溢出时给个"这边还有"的边缘渐隐。没有它, 滚动条只有 3px 高,
   * 标签被齐刷刷切在边界上, 看起来像渲染坏了而不是"还能往右滚"。 */
  const [edges, setEdges] = React.useState({ left: false, right: false });
  React.useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 2;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setEdges(prev => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => { el.removeEventListener('scroll', update); ro?.disconnect(); };
  }, [fileTabs.length]);

  React.useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth + 1) return;
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (dx === 0) return;
      const next = el.scrollLeft + dx;
      const max = el.scrollWidth - el.clientWidth;
      const clamped = Math.max(0, Math.min(max, next));
      if (clamped === el.scrollLeft) return;
      e.preventDefault();
      el.scrollLeft = clamped;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [fileTabs.length]);

  const dragSuppressClick = React.useRef(false);
  const startTabDrag = React.useCallback((e: React.PointerEvent<HTMLDivElement>, t: ChromeTab) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.sfc-chrome__tab-close')) return;
    /* 浏览器标签背后是原生网页视图, 暂不支持单独拖出: 照样能拖, 拖出去时影子上直接说明, 松手不开窗 */
    const blocked = !t.hostId;
    const hostId = t.hostId ?? '';
    const tabEl = e.currentTarget;
    const bar = tabEl.closest('.sfc-chrome') as HTMLElement | null;
    if (!bar) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const tabRect = tabEl.getBoundingClientRect();
    let started = false;
    let ghost: HTMLDivElement | null = null;
    let tear = false;
    /* 捕获指针: 拖出 Neox 窗口外也继续收到 move / up, 松手的屏幕坐标就是新窗口的位置 */
    try { tabEl.setPointerCapture(e.pointerId); } catch { /* 不支持就只在窗口内生效 */ }
    const onMove = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        started = true;
        document.documentElement.classList.add('is-sfc-tab-dragging');
        ghost = document.createElement('div');
        ghost.className = 'sfc-tab-ghost';
        const label = document.createElement('span');
        label.className = 'sfc-tab-ghost__label';
        label.textContent = t.title;
        const hint = document.createElement('span');
        hint.className = 'sfc-tab-ghost__hint';
        ghost.append(label, hint);
        document.body.appendChild(ghost);
      }
      if (!ghost) return;
      ghost.style.transform = `translate(${ev.clientX - (sx - tabRect.left)}px, ${ev.clientY - (sy - tabRect.top)}px)`;
      const r = bar.getBoundingClientRect();
      const out = ev.clientY > r.bottom + 40 || ev.clientY < r.top - 40 || ev.clientX < r.left - 40 || ev.clientX > r.right + 40;
      if (out !== tear) {
        tear = out;
        ghost.dataset.mode = out ? (blocked ? 'blocked' : 'tear') : '';
        ghost.querySelector('.sfc-tab-ghost__hint')!.textContent = !out ? ''
          : blocked ? (isZh ? '浏览器标签暂不支持单独拖出' : "Browser tabs can't pop out yet")
          : (isZh ? '松手变成独立窗口' : 'Release to pop out');
      }
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.documentElement.classList.remove('is-sfc-tab-dragging');
      ghost?.remove();
      if (!started) return;
      dragSuppressClick.current = true;
      window.setTimeout(() => { dragSuppressClick.current = false; }, 0);
      if (!tear || blocked) return;
      /* 搬哪个实例过去 (viewHosts): 能搬就搬右栏现成的那个, 不重开
       *   整格 (终端/文件/Git/方案…) 或容器里只剩这一个文件 → 整格搬走, 实例就是右栏那个;
       *   容器里有多个文件、拖的正是右栏正在显示的那个 → 右栏这个实例跟着走, 右栏剩下的文件另起一个;
       *   拖的是没在显示的文件 → 它本来就没挂着, 新起一个。 */
      const host = surfaces.find((s) => s.id === hostId);
      const tabs = (host?.metadata?.tabs as Array<{ id: string }> | undefined) ?? [];
      let tabId = t.tabId;
      let viewKey: string;
      if (!tabId || tabs.length <= 1) { tabId = undefined; viewKey = hostId; }
      else if (active.id === hostId && ((host?.metadata?.activeTabId as string | undefined) ?? tabs[0]?.id) === tabId) viewKey = hostId;
      else viewKey = `${hostId}::${tabId}`;
      /* 独立窗口左上角对准松手处的屏幕坐标 (往左上让一点, 手正好落在新窗口标题栏上); 可以是别的屏 */
      floatSurface(sessionId, hostId, tabId, { x: ev.screenX - 120, y: ev.screenY - 20, w: 620, h: 520 }, viewKey, sessionWs);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [isZh, sessionId, surfaces, active.id, sessionWs]);

  return (
    <div className="sfc-chrome" role="toolbar" aria-label="Surface chrome">
      <div
        className={`sfc-chrome__tabs${edges.left ? ' has-more-left' : ''}${edges.right ? ' has-more-right' : ''}`}
        role="tablist"
        ref={tabsRef}
      >
        {fileTabs.map((t) => {
          return (
          <React.Fragment key={t.id}>
          <div
            role="tab"
            aria-selected={t.isActive}
            className={`sfc-chrome__tab${t.isActive ? ' is-active' : ''}`
              + `${t.persistent ? ' is-persistent' : ''}`}
            onClick={() => { if (!dragSuppressClick.current) t.onActivate(); }}
            onPointerDown={(e) => startTabDrag(e, t)}
            title={t.title}
            aria-label={t.title}
          >
            <span className="sfc-chrome__tab-icon" aria-hidden="true">
              {t.kind === 'plugin'
                ? <PluginLogo pluginName={t.pluginName} fallback={KIND_ICON.plugin} imgClassName="sfc-chrome__tab-applogo" />
                : renderChromeTabIcon(t.kind, t.title)}
            </span>
            <span className="sfc-chrome__tab-title">{t.title}</span>
            {t.onClose && (
              <button
                type="button"
                className="sfc-chrome__tab-close"
                onClick={(e) => { e.stopPropagation(); t.onClose!(); }}
                title={isZh ? '关闭' : 'Close'}
                aria-label={isZh ? '关闭' : 'Close'}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
          </React.Fragment>
          );
        })}
        {showAddTabBtn && (
          <button
            type="button"
            className="sfc-chrome__add-tab"
            onClick={() => {
              const id = `tab-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
              addBrowserTab(sessionId, active.id, { id, url: 'about:blank', title: newTabTitle });
            }}
            title={newTabTitle}
            aria-label={newTabTitle}
          >+</button>
        )}
      </div>
      {toolbar && (
        <div className="sfc-chrome__toolbar">{toolbar}</div>
      )}
      <SurfaceLayoutButtons isZh={isZh} />
      <OpenSurfaceMenu surfaces={surfaces} activeId={activeId} sessionId={sessionId} />
    </div>
  );
};

/* 导出给 FilesSurfaceViewer 复用: 文件面板里的预览走同一套 viewer 分派. */
export function renderSurfaceViewer(surface: Surface, workspacePath?: string, isActive = true, isZh = defaultIsZh(), sessionId = ''): React.ReactNode {
  return renderViewer(surface, workspacePath, isActive, isZh, sessionId);
}

function renderViewer(surface: Surface, workspacePath?: string, isActive = true, isZh = defaultIsZh(), sessionId = ''): React.ReactNode {
  /* lazy viewer 首次加载的一瞬用空 fallback — chunk 在本地, ~ms 级, 不闪 UI. */
  return (
    <React.Suspense fallback={null}>
      {renderViewerInner(surface, workspacePath, isActive, isZh, sessionId)}
    </React.Suspense>
  );
}

const CodeOrPageViewer: React.FC<{ surface: Surface; workspacePath?: string }> = ({ surface, workspacePath }) => {
  const isPage = useAgentModeVariant().isWork && surface.source.type === 'file' && /\.html?$/i.test(surface.source.path);
  return isPage ? <HtmlSurfaceViewer surface={surface} workspacePath={workspacePath} /> : <CodeSurfaceViewer surface={surface} workspacePath={workspacePath} />;
};

function renderViewerInner(surface: Surface, workspacePath?: string, isActive = true, isZh = defaultIsZh(), sessionId = ''): React.ReactNode {
  switch (surface.kind) {
    case 'terminal': return <TerminalSurfaceViewer workspacePath={workspacePath} onClose={() => closeSurface(sessionId, surface.id)} />;
    case 'files':   return <FilesSurfaceViewer surface={surface} workspacePath={workspacePath} sessionId={sessionId} />;
    case 'git':     return <GitSurfaceViewer surface={surface} workspacePath={workspacePath} sessionId={sessionId} />;
    case 'doc':     return <DocSurfaceViewer surface={surface} workspacePath={workspacePath} />;
    case 'diagram': return <DiagramSurfaceViewer surface={surface} />;
    case 'image':   return surface.source.type === 'file' && VIDEO_EXT.test(surface.source.path)
      ? <VideoSurfaceViewer surface={surface} />
      : <ImageSurfaceViewer surface={surface} />;
    /* SVG 走 code surface (Monaco + 渲染/源码切换), 跟 openSurfaceFromPath 的 svg→code 一致.
     * 旧 kind:'svg' 事件 / 已打开 tab 也落到同一编辑器, 不再单独 ImageSurfaceViewer. */
    case 'svg':     return <CodeSurfaceViewer surface={surface} workspacePath={workspacePath} />;
    case 'html':    return <HtmlSurfaceViewer surface={surface} workspacePath={workspacePath} />;
    case 'web':     return <WebSurfaceViewer surface={surface} isActive={isActive} />;
    case 'diff':    return <DiffSurfaceViewer surface={surface} />;
    case 'code':    return <CodeOrPageViewer surface={surface} workspacePath={workspacePath} />;
    case 'review':  return <ReviewSurfaceViewer surface={surface} workspacePath={workspacePath} />;
    case 'plan':    return <PlanSurfaceViewer surface={surface} workspacePath={workspacePath} />;
    case 'todo':    return <TodoSurfaceViewer surface={surface} />;
    case 'services': return <ServicesSurfaceViewer surface={surface} />;
    case 'team':    return <TeamSurfaceViewer surface={surface} />;
    case 'plugin':  return <PluginSurfaceViewer surface={surface} />;
    case 'sheet':   return <SheetSurfaceViewer surface={surface} />;
    case 'pdf':     return <PdfSurfaceViewer surface={surface} />;
    case 'docx':    return <DocxSurfaceViewer surface={surface} />;
    case 'pptx':    return <PptxSurfaceViewer surface={surface} />;
    default: {
      const KIND_LABEL = getKindLabel(isZh);
      const kindKey = String(surface.kind);
      const label = (KIND_LABEL as Record<string, string>)[kindKey] || kindKey;
      const hint = kindKey === 'terminal'
        ? (isZh ? '终端请用时间线 execute_shell / 服务面板，不再提供独立 Terminal Surface。' : 'Use timeline execute_shell / Services panel — no Terminal Surface.')
        : kindKey === 'chart'
          ? (isZh ? '图表请用 diagram（Mermaid）Surface。' : 'Use a diagram (Mermaid) Surface instead.')
          : (isZh ? '此 Surface 类型暂不可用。' : 'This Surface kind is unavailable.');
      return (
        <div className="sfc-empty">
          <div className="sfc-empty__title">{isZh ? `${label} 不可用` : `${label} unavailable`}</div>
          <div className="sfc-empty__msg">{hint}</div>
        </div>
      );
    }
  }
}

function pickDefaultSurface<T extends { kind: string }>(surfaces: T[]): T | undefined {
  return surfaces.find((s) => s.kind !== 'terminal') ?? surfaces[0];
}

/** 右栏要显示的那一份: 拖出去单独浮着的标签不在这里 (文件类容器只摘掉那一个文件, 摘空了整格不显示) */
function dockedSurfaces(surfaces: Surface[], floating: FloatingSurface[]): Surface[] {
  if (floating.length === 0) return surfaces;
  const out: Surface[] = [];
  for (const s of surfaces) {
    const fl = floating.filter((f) => f.hostId === s.id);
    if (fl.length === 0) { out.push(s); continue; }
    if (fl.some((f) => !f.tabId)) continue;
    const gone = new Set(fl.map((f) => f.tabId));
    const tabs = (s.metadata?.tabs as Array<{ id: string }> | undefined) ?? [];
    const left = tabs.filter((t) => !gone.has(t.id));
    if (tabs.length > 0 && left.length === 0) continue;
    const activeTabId = s.metadata?.activeTabId as string | undefined;
    out.push({
      ...s,
      metadata: { ...s.metadata, tabs: left, activeTabId: activeTabId && gone.has(activeTabId) ? left[0]?.id : activeTabId },
    });
  }
  return out;
}

/** 右栏这一格用哪个查看器实例: 它正在显示的文件被拖成独立窗口带走了, 剩下的文件另起一个 */
function dockViewKey(s: Surface, floating: FloatingSurface[]): string {
  return floating.some((f) => f.viewKey === s.id) ? `${s.id}#rest` : s.id;
}

const renderPopoutBody = (s: Surface, viewKey: string, isZh: boolean) => (
  <>
    <ViewerHead active={s} isZh={isZh} />
    <div className="sfc-panel__body"><ViewSlot viewKey={viewKey} /></div>
  </>
);

export const SurfacePanel: React.FC = () => {
  const { activeSession, workspacePath } = useNeoxRuntime();
  const { isZh } = useI18n();
  const sessionId = activeSession?.id ?? '';
  /* 优先会话绑定根 — 回放/侧栏工程可能 ≠ 壳上当前工程, Git/Code 必须跟会话走 */
  const sessionWorkspacePath = sessionCwd(activeSession) || workspacePath;
  const allSurfaces = useSurfaces(sessionId);
  /* 独立窗口按全部会话算 (切会话窗口不关); 文件/Git/终端这类常驻 surface 各会话共用一份,
   * 在哪个会话里拖出去的, 每个会话的右栏都不再显示它 —— 一个实例只能在一个地方 */
  const floating = useAllFloatingSurfaces();
  const surfaces = React.useMemo(() => dockedSurfaces(allSurfaces, floating), [allSurfaces, floating]);
  const floatSessionIds = React.useMemo(() => [...new Set(floating.map((f) => f.sessionId))], [floating]);
  const floatSessionSurfaces = useSurfacesFor(floatSessionIds);
  const activeId = useActiveSurfaceId(sessionId);
  const active = surfaces.find(s => s.id === activeId) ?? pickDefaultSurface(surfaces);

  const [keptTerminalIds, setKeptTerminalIds] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (active?.kind === 'terminal' && !keptTerminalIds.includes(active.id)) {
      setKeptTerminalIds((prev) => [...prev, active.id]);
    }
  }, [active?.id, active?.kind, keptTerminalIds]);
  const keptTerminals = surfaces.filter((s) => s.kind === 'terminal' && (keptTerminalIds.includes(s.id) || s.id === active?.id));

  /* 所有查看器都在这一处 portal 进各自的宿主 (viewHosts): 右栏 / 独立窗口只放空槽,
   * 实例在两边搬来搬去 key 不变, React 不会卸载重挂 —— 终端不重开、滚动和展开状态都在 */
  const portalItems: ViewerPortalItem[] = [];
  const seen = new Set<string>();
  const addItem = (key: string, node: React.ReactNode) => {
    if (seen.has(key)) return;
    seen.add(key);
    portalItems.push({ key, node });
  };
  if (active && active.kind !== 'terminal') {
    addItem(dockViewKey(active, floating), renderViewer(active, sessionWorkspacePath, true, isZh, sessionId));
  }
  for (const s of keptTerminals) addItem(s.id, renderViewer(s, sessionWorkspacePath, s.id === active?.id, isZh, sessionId));
  const popouts: PopoutEntry[] = [];
  for (const f of floating) {
    const list = floatSessionSurfaces[floatSessionIds.indexOf(f.sessionId)] ?? [];
    const host = list.find((s) => s.id === f.hostId);
    const v = host ? floatView(host, f) : null;
    /* 图标跟标签栏同一套 (收在屏幕边上的书签上要用) */
    popouts.push({ f, view: v && { ...v, icon: renderChromeTabIcon(v.surface.kind, v.title) }, lost: !v && list.length > 0 });
    if (v) addItem(f.viewKey, renderViewer(v.surface, f.workspacePath ?? sessionWorkspacePath, true, isZh, f.sessionId));
  }

  /* 独立窗口挂在 SurfacePanel 里: 右栏收起时 SurfacePanel 还在, 窗口不跟着消失 */
  const floats = (
    <>
      <ViewerPortals items={portalItems} />
      <FloatingSurfaces entries={popouts} renderBody={renderPopoutBody} />
    </>
  );

  if (!active) {
    return (
      <div className="sfc-panel sfc-panel--landing">
        {floats}
        {/* landing 也要给一个 chrome 让用户能"打开 ... " — 用 empty surfaces 进 chrome, 只显 module switcher. */}
        <SurfaceChromeBar
          /* 空 active 是 OpenSurfaceMenu 的 fallback path */
          active={{ id: '', kind: 'doc', title: '', source: { type: 'inline', content: '' }, pinned: false, createdAt: 0, updatedAt: 0 } as Surface}
          surfaces={surfaces}
          activeId={activeId}
          sessionId={sessionId}
        />
        <div className="sfc-landing__dots" aria-hidden="true" />
        <svg className="sfc-landing__curve" viewBox="0 0 240 320" preserveAspectRatio="none" aria-hidden="true">
          <path d="M240,40 C150,80 200,180 120,240 C60,280 80,320 0,320" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          <path d="M240,120 C170,160 210,240 130,300" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.5" />
        </svg>
        <div className="sfc-landing">
          <img
            className="sfc-landing__art"
            src={NeoxIllus.agent}
            alt=""
            aria-hidden
            draggable={false}
          />
          <h2 className="sfc-landing__title">{isZh ? 'Surface 工作台' : 'Surface workspace'}</h2>
          <p className="sfc-landing__desc">
            {isZh
              ? 'Agent 产出的文档、图表和图片会显示在这里'
              : "Documents, diagrams and images the agent produces show up here"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <SurfacePanelLoaded
        active={active}
        surfaces={surfaces}
        activeId={activeId}
        sessionId={sessionId}
        activeViewKey={dockViewKey(active, floating)}
        keptTerminals={keptTerminals}
      />
      {floats}
    </>
  );
};

const SurfacePanelLoaded: React.FC<{
  active: Surface;
  surfaces: Surface[];
  activeId?: string;
  sessionId: string;
  activeViewKey: string;
  keptTerminals: Surface[];
}> = ({ active, surfaces, activeId, sessionId, activeViewKey, keptTerminals }) => {
  const { isZh } = useI18n();
  const browserMode = useBrowserMode();
  const isExternalBrowser = browserMode !== 'embedded';
  /* 记录该 kind 当前的 active surface — 切到其它 kind 再切回时回到这里 */
  React.useEffect(() => {
    recordKindActive(sessionId, active.kind, active.id);
  }, [sessionId, active.id, active.kind]);

  /* ⌘W (menu:close-tab): 先关 chrome 内 active tab, 否则关整个 surface — 不关窗口 */
  React.useEffect(() => {
    const onMenuCloseTab = () => {
      const tabs = computeChromeTabs(active, surfaces, sessionId, isZh, isExternalBrowser);
      const activeTab = tabs.find((t) => t.isActive);
      if (activeTab?.onClose) {
        activeTab.onClose();
        return;
      }
      closeSurface(sessionId, active.id);
    };
    window.addEventListener('neox:menu-close-tab', onMenuCloseTab);
    return () => window.removeEventListener('neox:menu-close-tab', onMenuCloseTab);
  }, [active, surfaces, sessionId, isZh, isExternalBrowser]);

  const panelLayout = usePanelLayout();
  const panelTab = useActivePanelTab();
  const ownsTopRow = panelLayout === 'tabs' && panelTab === 'surface';

  return (
    <div className="sfc-panel">
      <TopBarHoist id="surface-chrome" active={ownsTopRow}>
        <SurfaceChromeBar
          active={active}
          surfaces={surfaces}
          activeId={activeId}
          sessionId={sessionId}
        />
      </TopBarHoist>
      <ViewerHead active={active} isZh={isZh} />
      {/* 查看器本身由 SurfacePanel 的 ViewerPortals 挂着, 这里只放槽 (viewHosts) */}
      <div className="sfc-panel__body">
        {active.kind !== 'terminal' && <ViewSlot key={activeViewKey} viewKey={activeViewKey} />}
        {keptTerminals.map((s) => (
          <ViewSlot key={s.id} viewKey={s.id} hidden={s.id !== active.id} />
        ))}
      </div>
    </div>
  );
};

export default SurfacePanel;
