/**
 * CodeSurfaceViewer — 源代码文件 viewer (Neox Editor Engine read-only, 内部多 tab).
 *
 * 跟 WebSurfaceViewer (Chrome 风浏览器) 同思路: 整个 sessionId 一个 "源码" surface,
 * 内部画自己的 tab bar 管多个文件. 切 tab 0 重载, 只做 editor model swap.
 *
 * 用户在 timeline / 搜索结果点 .ts / .py / .java 等代码文件路径 → surfaceStore.ingestSurfaceEvent
 * 检测 kind='code' 自动合并到现有 surface 加 tab. 单文件场景 metadata.tabs 只 1 项, 退化为单 viewer.
 *
 * file 模式: 250ms polling mtime 实时刷新 (agent 修改文件后自动跟新).
 * inline 模式: agent 偶尔 open_surface kind=code source.content 用 (e.g. 展示生成代码).
 *
 * 主题适配: 监听 documentElement[data-theme] / [data-theme-preset] 自动切 Neox editor theme.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Surface } from '../../../state/surfaceStore';
import { useNeoxRuntime, useNeoxRuntimeOptional } from '../../../app/NeoxRuntimeContext';
import { dispatchHint } from '../../../components/notifyEvents';
import { KindHomeView } from './KindHomeView';
import { useNeoxEditorTheme, defineNeoxEditorTheme } from '../../editor/engine/theme';
import { getNeoxCodeEditorOptions } from '../../editor/engine/options';
import { createNeoxCodeEditor } from '../../editor/engine/factory';
import { loadNeoxEditorEngine } from '../../editor/engine/runtime';
import { useVisibilityInterval } from '../../../hooks/useVisibilityInterval';
import { useI18n } from '../../../hooks/useI18n';
import { CodePreviewPane, getPreviewKind } from './CodePreviewPane';
import { useAgentTurnEditForPath, patchAgentTurnHunkReview } from '../../../state/agentTurnEditsStore';
import FileExplorer, { type FileExplorerHandle } from '../../explorer/components/FileExplorer';
import { openSurfaceFromPath } from '../../../state/openSurfaceFromPath';
import { resolveWorkspacePath, filePathKey } from '../../../utils/pathUtils';
import Icons from '../../../components/Icons';
import { IconRefresh } from '../../shell/shellIcons';
import { revealInFileManagerLabel } from '../../../utils/fileManagerLabels';
import {
  collectCode, collectDiagnosticCode, diagnosticPrompt, intentPrompt, registerAiQuickFix, sendCodeToComposer,
  onFixDiagnostic, type DiagnosticRef, type EditorAiIntent,
} from '../../editor/editorAiBridge';
import { registerGhostTextProvider } from '../../editor/ghostTextProvider';

/** 子目录工作区 + monorepo: 错误地把仓库相对路径拼到 cwd 下 → ENOENT.
 *  先试 git root; 再沿父目录探测 rel 是否存在 (不依赖新 IPC, 旧进程也能自愈). */
async function healSubdirGitPath(
  filePath: string,
  workspacePath: string | undefined,
): Promise<string | null> {
  if (!workspacePath || !filePath) return null;
  const ws = workspacePath.replace(/\/+$/, '');
  const prefix = `${ws}/`;
  if (!filePath.startsWith(prefix)) return null;
  const rel = filePath.slice(prefix.length);
  if (!rel || rel.startsWith('/')) return null;
  const api = (window as any).neox;
  const reader = api?.surfaceReadFile ?? api?.readFile;
  if (!reader) return null;

  const tryRead = async (candidate: string, rootHint: string): Promise<string | null> => {
    if (!candidate || candidate === filePath) return null;
    try {
      const probe = await reader(candidate, { workspacePath: rootHint });
      if (probe?.success === false) return null;
      return candidate;
    } catch { return null; }
  };

  let root = '';
  try {
    const s = await api?.gitStatus?.(ws);
    root = typeof s?.root === 'string' ? s.root.replace(/\/+$/, '') : '';
  } catch { /* ????????? root ?? */ }
  if (root && root !== ws) {
    const hit = await tryRead(`${root}/${rel}`, root);
    if (hit) return hit;
  }

  /* 无 git root 时: 从工作区往上找, 看哪一层拼上 rel 能读到文件 */
  let dir = ws;
  for (let i = 0; i < 8; i++) {
    const slash = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'));
    if (slash <= 0) break;
    dir = dir.slice(0, slash);
    const hit = await tryRead(`${dir}/${rel}`, dir);
    if (hit) return hit;
  }
  return null;
}

async function revealPathInFinder(filePath: string): Promise<boolean> {
  if (!filePath) return false;
  const api = (window as any).neox;
  const candidates = [filePath];
  /* 文件不存在时逐级退到父目录, 至少能打开邻近位置 */
  let cur = filePath;
  for (let i = 0; i < 8; i++) {
    /* 同上: Windows 路径是反斜杠, 只认 '/' 的话这段回退完全不生效 */
    const slash = Math.max(cur.lastIndexOf('/'), cur.lastIndexOf('\\'));
    if (slash <= 0) break;
    cur = cur.slice(0, slash);
    if (cur) candidates.push(cur);
  }
  for (const p of candidates) {
    try {
      const r = api?.fsRevealInFinder ? await api.fsRevealInFinder(p) : null;
      if (r?.success) return true;
    } catch { /* try next */ }
    try {
      if (api?.openInFinder) {
        await api.openInFinder(p);
        return true;
      }
    } catch { /* try next */ }
  }
  return false;
}

interface Props {
  surface: Surface;
  workspacePath?: string;
}

/** 扩展名 → editor language id. 没命中走 'plaintext'. */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyw: 'python',
  java: 'java', kt: 'kotlin', kts: 'kotlin',
  go: 'go', rs: 'rust', rb: 'ruby', php: 'php',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', swift: 'swift', m: 'objective-c', mm: 'objective-c',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  yml: 'yaml', yaml: 'yaml', toml: 'plaintext',
  json: 'json', jsonc: 'json', json5: 'json',
  xml: 'xml', vue: 'html', svelte: 'html',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  scss: 'scss', sass: 'scss', less: 'less', css: 'css',
  dockerfile: 'dockerfile', makefile: 'makefile',
  ini: 'ini', env: 'shell', diff: 'diff', patch: 'diff',
};

function langOf(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? '';
  const lower = base.toLowerCase();
  if (lower === 'dockerfile' || lower.endsWith('.dockerfile')) return 'dockerfile';
  if (lower === 'makefile' || lower === 'gnumakefile') return 'makefile';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return 'plaintext';
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? 'plaintext';
}

interface ChangedLine {
  start: number;
  end: number;
  kind: 'add' | 'del' | 'modify';
}

interface EditHunk {
  oldString?: string;
  newString?: string;
  startLine?: number;
  oldLineCount?: number;
  newLineCount?: number;
  oldCharCount?: number;
  newCharCount?: number;
  /** editFileTool 大 hunk 截断标记 — true 时 oldString/newString 是 "[omitted N lines]"
   *  占位文本, 反向 apply 永远 indexOf 失败, 这条 hunk 必须整体跳过 (DiffEditor 退回单 editor + 色条). */
  previewTruncated?: boolean;
  /** E-03 持久化 review state — accept/reject 时通过 __sourceEntryId / __sourceHunkIdx 写回
   *   timelineEntry.editHunks[i].review (IndexedDB 落盘). 重新打开 surface 时从这条字段还原 reviewMap. */
  review?: 'pending' | 'accepted' | 'rejected';
  /** 反向索引: 这个 hunk 来自哪条 timelineEntry — writeback 用. aggregateTurnChanges 在聚合时塞.
   *   双下划线 = 渲染层内部约定, 不进 SavedTimelineEntry schema. */
  __sourceEntryId?: string;
  /** 该 hunk 在 entry.editHunks[] 数组里的 index, -1 = entry 走顶层 editStartLine 单 hunk 路径. */
  __sourceHunkIdx?: number;
}

type DiffViewMode = 'preview' | 'inline' | 'side-by-side' | 'render';


function splitHunkLines(value?: string): string[] {
  if (!value) return [];
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function countHunkLines(value?: string): number {
  return splitHunkLines(value).length;
}

/** 源码预览用: 按 hunk 原文标绿 — newString 每一行都绿 (含未改上下文行).
 *  不用 LCS: Myers/LCS 会把「注释+原行」收成只绿注释一行. */
function literalNewLineRangesFromHunk(hunk: EditHunk): Array<{ start: number; end: number }> {
  const startLine = Math.max(1, hunk.startLine ?? 1);
  const count = countHunkLines(hunk.newString);
  if (count <= 0) return [];
  return [{ start: startLine, end: startLine + count - 1 }];
}

/** 一段被删掉的原文 — 挂在新文件 afterLine 之后 (0 = 文件最顶). */
interface DeletedBlock {
  afterLine: number;
  lines: string[];
}

/** 源码预览用: 按 hunk 原文插红删行 — oldString 整段作为 view zone 插在 startLine 之前.
 *  不用 LCS: 否则「注释替换」里被当成公共上下文的旧行会丢红. */
function literalDeletedBlocksFromHunk(hunk: EditHunk): DeletedBlock[] {
  const startLine = Math.max(1, hunk.startLine ?? 1);
  const oldLines = splitHunkLines(hunk.oldString);
  if (oldLines.length === 0) return [];
  return [{ afterLine: startLine - 1, lines: oldLines }];
}

/** 单块删除最多渲染多少行 view zone — 再多屏幕也放不下, 末尾用一行省略提示收口. */
const MAX_DEL_ZONE_LINES = 200;

interface CodeTab {
  id: string;
  url: string;   /* ?? path (BrowserTab ????, url ??? path ?) */
  title?: string;
  /** 本轮改动的行号区间 — 渲染时 editor decorations 高亮 (单 editor 模式). */
  changedLines?: ChangedLine[];
  /** edit hunks 原始数据 — 有值时走 DiffEditor (老/新双色 diff), 没有走单 editor + 色条. */
  editHunks?: EditHunk[];
  /** 文件不存在/历史 workspace 不匹配时, 用 timeline diff/tool 数据兜底预览。 */
  fallbackContent?: string;
  /** 打开时聚焦滚动到的行号 (1-based) — timeline 文件引用带行号时 surfaceStore stash 进来. */
  focusLine?: number;
  /** 同一行重复点击也要重新触发 reveal — 每次 open 请求变一次. */
  focusNonce?: number;
}

/* Code host — 多 tab 模式, chrome 全部由 SurfacePanel 接管.
 *   空 tabs (openKindHome 创建的 home host) → KindHomeView (打开文件引导)
 *   有 tab → SingleCodeView, key 不带 tab.url 避免切 tab 重建 editor, 内部 effects 自己换 model */
export const CodeSurfaceViewer: React.FC<Props> = ({ surface, workspacePath: workspacePathProp }) => {
  const { activeSession, workspacePath: runtimeWorkspace } = useNeoxRuntime();
  const sessionId = activeSession?.id ?? '';
  const workspacePath =
    (typeof surface.metadata?.workspacePath === 'string' && surface.metadata.workspacePath)
    || workspacePathProp
    || runtimeWorkspace;

  const tabs: CodeTab[] = useMemo(() => {
    const raw = surface.metadata?.tabs as CodeTab[] | undefined;
    const cleaned = (raw ?? []).filter(t => !String(t.url ?? '').startsWith('inline-'));
    if (cleaned.length > 0) return cleaned;
    if (surface.source.type === 'file') {
      return [{ id: surface.id, url: surface.source.path, title: surface.title }];
    }
    if (surface.source.type === 'inline' && surface.source.content) {
      return [{ id: surface.id, url: `inline-${surface.id}`, title: surface.title || 'inline' }];
    }
    return [];
  }, [surface.metadata, surface.source, surface.id, surface.title]);

  const activeTabId = (surface.metadata?.activeTabId as string | undefined) ?? tabs[0]?.id;
  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0];
  const storeEdit = useAgentTurnEditForPath(sessionId, activeTab?.url);

  if (!activeTab) {
    return <KindHomeView kind="code" sessionId={sessionId} surfaceId={surface.id} workspacePath={workspacePath} />;
  }

  /* agent 自动 open 常不带 editHunks; 本轮 turn edits 作 fallback, 对齐手动点 Review */
  const editHunks = (activeTab.editHunks?.length ? activeTab.editHunks : storeEdit?.editHunks) as typeof activeTab.editHunks;
  const changedLines = (activeTab.changedLines?.length ? activeTab.changedLines : storeEdit?.changedLines) as typeof activeTab.changedLines;
  const diffOriginal = (activeTab as { diffOriginal?: string }).diffOriginal;
  const hasPendingReview = !!(editHunks?.some((h) =>
    (h.review ?? 'pending') === 'pending'
    && typeof h.oldString === 'string'
    && h.oldString.length > 0
    && !h.previewTruncated,
  ));

  const tabDefault = (activeTab as { defaultDiffViewMode?: string } | undefined)?.defaultDiffViewMode;
  /* 待审 hunk → 默认「源码」: 整文件 Monaco + 原文红删/绿增 (不要只剩 hunk 片段面板) */
  const resolvedTabDefault = hasPendingReview && tabDefault === 'render' ? 'preview' : tabDefault;
  const defaultDiffViewMode = (
    resolvedTabDefault === 'render'
    || resolvedTabDefault === 'preview'
    || resolvedTabDefault === 'inline'
    || resolvedTabDefault === 'side-by-side'
  )
    ? (resolvedTabDefault as DiffViewMode)
    : (hasPendingReview ? 'preview' as DiffViewMode : undefined);

  return (
    <SingleCodeView
      path={activeTab.url}
      title={activeTab.title}
      changedLines={changedLines}
      editHunks={editHunks}
      fallbackContent={activeTab.fallbackContent}
      diffOriginal={diffOriginal}
      focusLine={activeTab.focusLine}
      focusNonce={activeTab.focusNonce}
      workspacePath={workspacePath}
      sessionId={sessionId}
      defaultDiffViewMode={defaultDiffViewMode}
      openedBy={surface.metadata?.__openedBy === 'agent' ? 'agent' : 'user'}
    />
  );
};

/** 超大文件保护 — 超过这个字符数只往 Monaco 塞前半段, 顶部提示截断.
 *  1.5M chars ≈ 1.5MB utf-8 英文 / 更大中文, Monaco 在此规模仍流畅; 再大明显掉帧. */
const MAX_CODE_CHARS = 1_500_000;

interface TruncatedInfo {
  shownLines: number;
  totalLines: number;
  totalChars: number;
}

/** 单文件 Neox Editor Engine 渲染.
 *  · 默认 → 普通 readOnly editor + changedLines/editHunks decorations, 给右侧留足空间.
 *  · 用户切换 → DiffEditor 模式: 反向应用 hunks 重建"本轮改动前"内容,
 *    支持单窗上下红绿对比 / 左右双栏对比。 */
const SingleCodeView: React.FC<{
  path: string;
  title?: string;
  changedLines?: ChangedLine[];
  editHunks?: EditHunk[];
  fallbackContent?: string;
  focusLine?: number;
  focusNonce?: number;
  workspacePath?: string;
  /** Agent open_surface(kind:html) 会 stamp 'render'; 用户 chip 打开不传 → 源码. */
  defaultDiffViewMode?: DiffViewMode;
  /** Git History 等比对: 改前全文 (左右栏左 pane). */
  diffOriginal?: string;
  sessionId?: string;
  /** 这份 surface 是用户自己打开的还是 agent 推的 — 决定能不能编辑 */
  openedBy?: 'user' | 'agent';
}> = ({ path, changedLines, editHunks, fallbackContent, focusLine, focusNonce, workspacePath, defaultDiffViewMode, diffOriginal, sessionId, openedBy }) => {
  const { isZh } = useI18n();
  const [content, setContent] = useState<string>('');
  const [truncatedInfo, setTruncatedInfo] = useState<TruncatedInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* 加载用路径 — 可能被 monorepo 子目录拼错路径自动纠正 */
  const [resolvedPath, setResolvedPath] = useState(path);
  useEffect(() => { setResolvedPath(path); }, [path]);

  const RENDER_FIRST_KINDS = new Set(['svg', 'markdown', 'mermaid']);

  const resolveDefaultMode = (filePath: string, preferred?: DiffViewMode): DiffViewMode => {
    /* 'inline' 已经不在模式条里了 (见下方 base 的注释: 它与 'preview' 渲染完全相同)。
     * 但 surfaceStore 在"有待审 hunk"时仍会把默认值设成 'inline' —— 不归一的话
     * 模式条会一个高亮都没有。渲染行为本来就一致, 直接当 'preview'。 */
    if (preferred === 'inline') return 'preview';
    if (preferred) return preferred;
    const arrivesWithDiff = (editHunks?.length ?? 0) > 0
      || (changedLines?.length ?? 0) > 0
      || typeof diffOriginal === 'string';
    if (arrivesWithDiff) return 'preview';
    return RENDER_FIRST_KINDS.has(getPreviewKind(filePath) as string) ? 'render' : 'preview';
  };
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>(() => (
    resolveDefaultMode(path, defaultDiffViewMode)
  ));
  const containerRef = useRef<HTMLDivElement>(null);
  const sbsOrigContainerRef = useRef<HTMLDivElement>(null);
  const sbsModContainerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<any>(null);
  const sbsOrigEditorRef = useRef<any>(null);
  const diffEditorRef = useRef<any>(null);
  const editorEngineRef = useRef<any>(null);
  const { isDark, preset: themePreset } = useNeoxEditorTheme();
  /* editorReady — editor runtime 是 async import + 几百 ms 才能拿到 editor 实例.
   * 在 ref 设置完成那一刻必须 setState 触发 re-render, 否则 content effect / decoration
   * effect 第一次跑的时候 editorRef.current=null 全 no-op, 之后没有任何状态变化能让它们重新跑,
   * decorations 永远不 apply. (用户看到的"右侧没 diff" 真因) */
  const [editorReady, setEditorReady] = useState(false);

  const language = useMemo(() => langOf(resolvedPath || path), [resolvedPath, path]);
  const isFilePath = path && !path.startsWith('inline-');
  const decorationsRef = useRef<string[]>([]);
  const diffPreciseDecorationsRef = useRef<string[]>([]);
  const canRenderDiff = !!(
    (editHunks
    && editHunks.length > 0
    && !editHunks.some(h => h.previewTruncated))
    || (typeof diffOriginal === 'string')
  );
  /* render = HTML iframe ?;
   * preview / inline = 整文件 + hunk 原文红绿 (同一套; DiffEditor Myers 会丢 +2−1);
   * side-by-side = 左右各一枚 Monaco, 仍按 hunk 原文标红/绿 (不用 Myers). */
  const isRenderMode = diffViewMode === 'render';
  const isSideBySideMode = canRenderDiff && diffViewMode === 'side-by-side';
  /* 旧名 isDiffMode: 曾指 Monaco DiffEditor; 现仅左右双栏 (非 Myers DiffEditor). */
  const isDiffMode = isSideBySideMode;
  const hasDiffPreview = (editHunks?.length ?? 0) > 0 || (changedLines?.length ?? 0) > 0 || typeof diffOriginal === 'string';
  const canEdit = !!isFilePath
    && openedBy !== 'agent'
    && !hasDiffPreview
    && !truncatedInfo
    && !isRenderMode
    && !isSideBySideMode;
  const editorModeKey = isRenderMode
    ? 'render'
    : isSideBySideMode
      ? 'side-by-side'
      : (hasDiffPreview ? 'diff-preview' : 'preview');
  /* error 期间整个组件 early-return 错误页, containerRef 容器不挂载 → Monaco 必须跟着
   * 卸载/重挂. 用布尔量而不是 error 字符串本身: 错误文案变化不该无谓重建 editor. */
  const hasLoadError = !!error;

  useEffect(() => {
    /* SVG / agent-html 默认「渲染」; 普通代码 / 用户 chip-html 默认「源码」.
     * 换文件时重置, 不跨文件保留模式偏好. */
    setDiffViewMode(resolveDefaultMode(path, defaultDiffViewMode));
  }, [path, defaultDiffViewMode]);

  /* 当前光标处于哪个 hunk (-1 = 还没进入任何 hunk). 初始 0, content 装载后 effect 跳到首个. */
  const [hunkIdx, setHunkIdx] = useState(0);
  /* diff mode 下底层 diff 算出的实际 lineChanges 数量 — 用作 toolbar 显示. 异步更新. */
  const [diffHunkCount, setDiffHunkCount] = useState(0);

  const [reviewMap, setReviewMap] = useState<Partial<Record<number, 'accepted' | 'rejected'>>>(() => {
    const init: Partial<Record<number, 'accepted' | 'rejected'>> = {};
    (editHunks ?? []).forEach((h, i) => {
      if (h.review === 'accepted' || h.review === 'rejected') init[i] = h.review;
    });
    return init;
  });
  /* refs 给 widget click handler 内部用 — handler 是在 mount effect 里建的 closure, 必须用 ref 拿最新. */
  const reviewMapRef = useRef(reviewMap);
  useEffect(() => { reviewMapRef.current = reviewMap; });

  const resolveHunkReview = useCallback((i: number): 'pending' | 'accepted' | 'rejected' => {
    return reviewMap[i] ?? editHunks?.[i]?.review ?? 'pending';
  }, [reviewMap, editHunks]);

  /* 仍待审的 hunk — 接受后立刻从 diff 可视化里拿掉 (文件已在盘上, Accept = 收起审阅态). */
  const pendingEditHunks = useMemo(() => {
    if (!editHunks || editHunks.length === 0) return [] as EditHunk[];
    return editHunks.filter((_, i) => resolveHunkReview(i) === 'pending');
  }, [editHunks, resolveHunkReview]);

  /* Git History 等只给了 diffOriginal 快照时: 合成展示用 hunk (不进审阅).
   * 公共前后缀压掉, 中间段做上下红绿, 避免整文件当一块替换. */
  const snapshotDisplayHunks = useMemo(() => {
    if (pendingEditHunks.length > 0) return [] as EditHunk[];
    if (typeof diffOriginal !== 'string') return [] as EditHunk[];
    const oldLines = diffOriginal.replace(/\r\n/g, '\n').split('\n');
    const newLines = content.replace(/\r\n/g, '\n').split('\n');
    /* split 尾部空串是正常的 (文件以 \n 结尾); 比内容时去掉最后的空元素对齐行数观感 */
    const trimEndEmpty = (xs: string[]) => (xs.length > 0 && xs[xs.length - 1] === '' ? xs.slice(0, -1) : xs);
    const o = trimEndEmpty(oldLines);
    const n = trimEndEmpty(newLines);
    let i = 0;
    while (i < o.length && i < n.length && o[i] === n[i]) i += 1;
    let oEnd = o.length;
    let nEnd = n.length;
    while (oEnd > i && nEnd > i && o[oEnd - 1] === n[nEnd - 1]) {
      oEnd -= 1;
      nEnd -= 1;
    }
    const oldMid = o.slice(i, oEnd);
    const newMid = n.slice(i, nEnd);
    if (oldMid.length === 0 && newMid.length === 0) return [] as EditHunk[];
    const join = (xs: string[]) => (xs.length === 0 ? '' : `${xs.join('\n')}\n`);
    return [{
      oldString: join(oldMid),
      newString: join(newMid),
      startLine: i + 1,
    } as EditHunk];
  }, [pendingEditHunks.length, diffOriginal, content]);

  /* 可视化用 hunk: 待审优先, 否则 Git 快照合成 */
  const displayHunks = pendingEditHunks.length > 0 ? pendingEditHunks : snapshotDisplayHunks;

  /* 「源码」用 hunk 原文标绿 — 有完整 display hunks 时不用上游 LCS changedLines
   * (LCS 会把「注释+原行」收成只绿 1 行, 跟 +2 −1 对不上). */
  const previewChangedLines = useMemo<ChangedLine[]>(() => {
    const hunks = displayHunks;
    const canLiteral = hunks.length > 0 && !hunks.some(h => h.previewTruncated);
    if (canLiteral) {
      const lines: ChangedLine[] = [];
      for (const h of hunks) {
        for (const range of literalNewLineRangesFromHunk(h)) {
          lines.push({ start: range.start, end: range.end, kind: 'add' });
        }
        const oldCount = typeof h.oldLineCount === 'number' ? h.oldLineCount : countHunkLines(h.oldString);
        const newCount = typeof h.newLineCount === 'number' ? h.newLineCount : countHunkLines(h.newString);
        if (oldCount > 0 && newCount === 0) {
          const start = Math.max(1, h.startLine ?? 1);
          lines.push({ start, end: start, kind: 'del' });
        }
      }
      return lines;
    }
    /* 全部已审 → 不再用旧 changedLines 兜底, 否则 Accept 后红绿还在 */
    if (editHunks && editHunks.length > 0 && pendingEditHunks.length === 0 && snapshotDisplayHunks.length === 0) return [];
    if (changedLines && changedLines.length > 0) return changedLines;
    return [];
  }, [changedLines, editHunks, displayHunks, pendingEditHunks.length, snapshotDisplayHunks.length]);

  /* 「源码」预览: oldString 整段以 view zone 插回文件, 整行红底 (跟编辑器上下文一起看).
   * previewTruncated 的 hunk 里 oldString 是 "[omitted N lines]" 占位符, 直接跳过. */
  const deletedBlocks = useMemo<DeletedBlock[]>(() => {
    if (displayHunks.length === 0) return [];
    const out: DeletedBlock[] = [];
    for (const h of displayHunks) {
      if (h.previewTruncated) continue;
      out.push(...literalDeletedBlocksFromHunk(h));
    }
    return out;
  }, [displayHunks]);

  /* 排序去重的改动区间 — 跳转用. */
  const sortedHunks = useMemo<ChangedLine[]>(() => {
    if (displayHunks.length > 0) {
      const starts = displayHunks
        .map(h => h.startLine)
        .filter((n): n is number => typeof n === 'number' && n > 0)
        .sort((a, b) => a - b);
      const dedup: ChangedLine[] = [];
      for (const s of starts) {
        if (dedup.length === 0 || dedup[dedup.length - 1]!.start !== s) {
          dedup.push({ start: s, end: s, kind: 'add' });
        }
      }
      return dedup;
    }
    if (editHunks && editHunks.length > 0) return [];
    const arr = [...(changedLines ?? [])].sort((a, b) => a.start - b.start);
    const byStart = new Map<number, ChangedLine>();
    for (const h of arr) {
      const existing = byStart.get(h.start);
      if (!existing) { byStart.set(h.start, h); continue; }
      if (existing.kind === 'del' && h.kind !== 'del') byStart.set(h.start, h);
    }
    return Array.from(byStart.values()).sort((a, b) => a.start - b.start);
  }, [changedLines, editHunks, displayHunks]);

  /* 拿 updateHunkReview helper — context 提供, 不强依赖 (老 entry / 无 entryId 的场景仍 in-memory degrade). */
  const runtimeForReview = useNeoxRuntimeOptional();
  const updateHunkReview = runtimeForReview?.updateHunkReview;
  const sessionIdForReview = runtimeForReview?.activeSession?.id;
  /* writeback wrapper: timeline + turn-edits store (IDE 条 / 本轮改动) 一起刷. */
  const persistHunkReview = useCallback((hunkIdx: number, review: 'pending' | 'accepted' | 'rejected') => {
    const hunks = editHunks ?? [];
    const h = hunks[hunkIdx] as any;
    if (!h || !sessionIdForReview) return;
    if (review === 'accepted' || review === 'rejected') {
      try { patchAgentTurnHunkReview(sessionIdForReview, path, hunkIdx, review); } catch { /* */ }
    }
    if (!updateHunkReview) return;
    const sourceEntryId = h.__sourceEntryId as string | undefined;
    const sourceHunkIdx = typeof h.__sourceHunkIdx === 'number' ? h.__sourceHunkIdx : -1;
    if (!sourceEntryId) return;
    updateHunkReview(sessionIdForReview, sourceEntryId, sourceHunkIdx, review);
  }, [editHunks, sessionIdForReview, updateHunkReview, path]);
  const persistHunkReviewRef = useRef(persistHunkReview);
  useEffect(() => { persistHunkReviewRef.current = persistHunkReview; });

  useEffect(() => {
    /* 换文件时按 props 整表重置, 避免上一文件的 accepted 串台. */
    const init: Partial<Record<number, 'accepted' | 'rejected'>> = {};
    (editHunks ?? []).forEach((h, i) => {
      if (h.review === 'accepted' || h.review === 'rejected') init[i] = h.review;
    });
    setReviewMap(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 path 切换时整表重置
  }, [path]);

  useEffect(() => {
    /* 同文件内: 只把 props 里已落盘的 accepted/rejected 合进来; 不因 props 仍是 pending
     * 而清掉本地刚点的 Accept (tab.editHunks 常滞后于 reviewMap). */
    setReviewMap(prev => {
      let changed = false;
      const next = { ...prev };
      (editHunks ?? []).forEach((h, i) => {
        if (h.review === 'accepted' || h.review === 'rejected') {
          if (next[i] !== h.review) {
            next[i] = h.review;
            changed = true;
          }
        }
      });
      return changed ? next : prev;
    });
  }, [editHunks]);

  /* 全部接受后还停在左右/单窗无意义 (改前=改后) — 收回源码净稿. */
  useEffect(() => {
    if (!isDiffMode) return;
    if ((editHunks?.length ?? 0) === 0) return;
    if (pendingEditHunks.length > 0) return;
    setDiffViewMode('preview');
  }, [isDiffMode, editHunks, pendingEditHunks.length]);

  const jumpToHunk = useCallback((nextIdx: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    if (sortedHunks.length === 0) return;
    const clamped = ((nextIdx % sortedHunks.length) + sortedHunks.length) % sortedHunks.length;
    const h = sortedHunks[clamped]!;
    setHunkIdx(clamped);
    editor.revealLineInCenter(h.start);
    try { editor.setPosition({ lineNumber: h.start, column: 1 }); } catch { /* */ }
    try { sbsOrigEditorRef.current?.revealLineInCenter?.(h.start); } catch { /* */ }
  }, [sortedHunks]);

  /* refs 给 mount effect (deps=[]) 内部的 F7 命令拿最新值 — 否则 addCommand 抓的是
   * mount 时刻的 closure, hunkIdx 永远等于 0. */
  const jumpToHunkRef = useRef(jumpToHunk);
  useEffect(() => { jumpToHunkRef.current = jumpToHunk; });
  const hunkIdxRef = useRef(hunkIdx);
  useEffect(() => { hunkIdxRef.current = hunkIdx; });

  /* refs 同步最新值 — mount effect (deps=[]) 用 closure 拿不到后续 setState 的 content,
   * 用 ref 才能在 async import 完成后拿到最新 file content. */
  const contentRef = useRef(content);
  useEffect(() => { contentRef.current = content; });
  const languageRef = useRef(language);
  useEffect(() => { languageRef.current = language; });
  const isDarkRef = useRef(isDark);
  useEffect(() => { isDarkRef.current = isDark; });
  const editHunksRef = useRef(editHunks);
  useEffect(() => { editHunksRef.current = editHunks; });
  const changedLinesRef = useRef(changedLines);
  useEffect(() => { changedLinesRef.current = changedLines; });

  const isDiffModeRef = useRef(isDiffMode);
  useEffect(() => { isDiffModeRef.current = isDiffMode; });
  const canEditRef = useRef(canEdit);
  useEffect(() => { canEditRef.current = canEdit; });

  /* ══ 可编辑模式 ═══════════════════════════════════════════════════════
   *   dirty 是**唯一**能挡住轮询回写的闸: 上面那个 250ms 的 loadFile 一旦发现
   *   mtime 变了就 setContent → model.setValue, 用户正在敲的字会被整段冲掉。
   *   所以 dirty 期间既不接受外部内容, 也不让 model sync 动手 (见那个 effect)。 */
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(false);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  /* 切文件就清脏标记 —— 脏的是上一个文件, 跟着新文件走会永久挡住轮询 */
  useEffect(() => { setDirty(false); }, [resolvedPath]);

  const saveNowRef = useRef<() => Promise<void>>(async () => {});
  saveNowRef.current = async () => {
    const ed = editorRef.current;
    if (!ed || !canEditRef.current) return;
    const model = ed.getModel?.();
    const text = model?.getValue?.();
    if (typeof text !== 'string') return;
    const api = (window as any).neox;
    const writer = api?.surfaceWriteFile ?? api?.writeFile;
    if (!writer) {
      dispatchHint(isZh ? '这个版本不支持写文件' : 'Writing files is unavailable in this build', 'warning');
      return;
    }
    setSaving(true);
    try {
      const res = await writer(pathRef.current, text, workspacePath ? { workspacePath } : undefined);
      if (res && res.success === false) throw new Error(String(res.error || 'write failed'));
      /* 存完把 content 对齐, 否则下一次轮询发现 mtime 变了会 setValue 一遍,
       * 光标跳回文件头 —— 表现就是"存一下光标飞了"。 */
      setContent(text);
      lastMtimeRef.current = 0;
      setDirty(false);
      dispatchHint(isZh ? '已保存' : 'Saved', 'success');
    } catch (e: any) {
      dispatchHint(`${isZh ? '保存失败: ' : 'Save failed: '}${e?.message || e}`, 'warning');
    } finally {
      setSaving(false);
    }
  };

  /* 编辑器建好那一刻挂上: 脏标记 + ⌘S + IDEA 键位。
   * 用 ref 包一层是因为创建 editor 的 effect 是 async 且 deps 很少, 直接闭包会拿到旧的。 */
  const bindEditableEditorRef = useRef<(ed: any, engine: any) => void>(() => {});
  bindEditableEditorRef.current = (ed, engine) => {
    try {
      ed.onDidChangeModelContent(() => {
        if (!canEditRef.current) return;
        if (!dirtyRef.current) setDirty(true);
      });
    } catch { /* noop */ }
    try {
      const { KeyMod, KeyCode } = engine;
      const run = (id: string) => () => { try { ed.trigger('neox-idea-keymap', id, null); } catch { /* */ } };
      ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyR, run('editor.action.startFindReplaceAction'));
      ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyD, run('editor.action.copyLinesDownAction'));
      ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyY, run('editor.action.deleteLines'));
      ed.addCommand(KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyL, run('editor.action.formatDocument'));
      ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, () => { void saveNowRef.current(); });
    } catch { /* noop */ }
    try {
      registerGhostTextProvider(engine);
      ed.updateOptions({ inlineSuggest: { enabled: true } });
    } catch { /* noop */ }
  };

  const bindAiActionsRef = useRef<(ed: any, engine: any) => void>(() => {});
  bindAiActionsRef.current = (ed, engine) => {
    const runAi = (intent: EditorAiIntent) => {
      const code = collectCode(ed, pathRef.current);
      if (!code) return;
      if (intent === 'add') void sendCodeToComposer(code);
      else void sendCodeToComposer(code, { prompt: intentPrompt(intent, isZh), send: true });
    };
    try {
      const actions: Array<{ id: string; label: string; intent: EditorAiIntent; keybindings?: number[] }> = [
        { id: 'neox.ai.addToChat', label: isZh ? '添加到对话' : 'Add to Chat', intent: 'add', keybindings: [engine.KeyMod.CtrlCmd | engine.KeyCode.KeyL] },
        { id: 'neox.ai.explain', label: isZh ? '解释这段代码' : 'Explain Code', intent: 'explain' },
        { id: 'neox.ai.fix', label: isZh ? '修复这段代码' : 'Fix Code', intent: 'fix' },
        { id: 'neox.ai.optimize', label: isZh ? '优化这段代码' : 'Improve Code', intent: 'optimize' },
        { id: 'neox.ai.tests', label: isZh ? '写单元测试' : 'Write Tests', intent: 'tests' },
      ];
      actions.forEach((a, i) => {
        ed.addAction({
          id: a.id,
          label: `Neox: ${a.label}`,
          keybindings: a.keybindings,
          contextMenuGroupId: '0_neox_ai',
          contextMenuOrder: i + 1,
          run: () => runAi(a.intent),
        });
      });
      registerAiQuickFix(engine, isZh);
      onFixDiagnostic(ed, (diag: DiagnosticRef) => {
        const code = collectDiagnosticCode(ed, diag, pathRef.current);
        if (code) void sendCodeToComposer(code, { prompt: diagnosticPrompt(diag, isZh), send: true });
      });
    } catch { /* 引擎没这些 API 就不挂 —— 不影响看代码 */ }
  };

  /* canEdit 变了不重建 editor (重建会丢滚动位置和撤销栈), 只翻选项 */
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || isDiffMode) return;
    try { ed.updateOptions({ readOnly: !canEdit, domReadOnly: !canEdit }); } catch { /* */ }
  }, [canEdit, editorReady, isDiffMode]);
  const diffViewModeRef = useRef(diffViewMode);
  useEffect(() => { diffViewModeRef.current = diffViewMode; });

  /* DiffEditor 已弃用 (Myers 丢 +2−1); 左右改双栏独立 Monaco. 保留 reveal key 给跳转. */
  const diffRevealKeyRef = useRef('');
  const diffRevealedKeyRef = useRef('');
  const sbsOrigDecorationsRef = useRef<string[]>([]);

  /** 反向应用 hunks 重建 "本轮改动前" 的文件内容.
   *  ??:
   *   1. 用 hunk.startLine 做"位置感知" indexOf — newString 在文件多处出现时取离 startLine 最近的
   *      (避免 indexOf 总取第一个导致跨 hunk 内容错位, 这是常见的 ±1 误差源)
   *   2. trailing \n 归一 — 把 oldContent 末尾 \n 状态对齐 currentContent (都有/都无),
   *      消除 diff 看到"末尾多一行 phantom add"的视觉误导 */
  const reconstructOldContent = useCallback((current: string, hunks: EditHunk[]): string => {
    const lineToOffset = (text: string, hintLine?: number): number => {
      if (!hintLine || hintLine <= 1) return 0;
      let charOffset = 0;
      let line = 1;
      for (let i = 0; i < text.length && line < hintLine; i++) {
        if (text.charCodeAt(i) === 10 /* \n */) line++;
        charOffset = i + 1;
      }
      return charOffset;
    };
    const findClosestMatch = (text: string, needle: string, hintLine?: number): number => {
      if (!needle) return -1;
      const charOffset = lineToOffset(text, hintLine);
      if (!hintLine || hintLine <= 0) return text.indexOf(needle);
      let best = -1;
      let bestDist = Infinity;
      let pos = text.indexOf(needle, 0);
      while (pos >= 0) {
        const dist = Math.abs(pos - charOffset);
        if (dist < bestDist) { best = pos; bestDist = dist; }
        pos = text.indexOf(needle, pos + 1);
      }
      return best;
    };

    /* CRLF → LF 归一: editFileTool 在写文件时保留原行尾 (\r\n 或 \n), 但 hunks 的 newString
     * 是单 \n join 的. 如果文件是 CRLF, 反向 apply 时 indexOf(newString) 永远 -1. 把 current
     * 跟 hunks 都先归一到 \n 再 apply. */
    const normalize = (s: string) => s.replace(/\r\n/g, '\n');
    /* 反向 apply 顺序: editFileTool 正向是 startLine 降序; UNDO 必须升序. 否则每步 indexOf
     * 在已部分还原的中间状态找位置 → 微小漂移累积成 ±1 行偏差. */
    const sortedHunks = [...hunks].sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
    let text = normalize(current);
    for (const h of sortedHunks) {
      const newStr = normalize(h.newString ?? '');
      const oldStr = normalize(h.oldString ?? '');
      if (!newStr) {
        /* 纯删除 hunk: 当前文件里已经没有 newString 可匹配，必须按 startLine
         * 把 oldString 插回去，否则删除不会显示为红色，只会被吞掉。 */
        if (oldStr) {
          const idx = lineToOffset(text, h.startLine);
          text = text.slice(0, idx) + oldStr + (oldStr.endsWith('\n') || idx >= text.length ? '' : '\n') + text.slice(idx);
        }
        continue;
      }
      const idx = findClosestMatch(text, newStr, h.startLine);
      if (idx >= 0) {
        text = text.slice(0, idx) + oldStr + text.slice(idx + newStr.length);
      }
    }
    /* trailing newline 状态归一: 把 oldContent 末尾 \n 对齐到 normalize 后的 current */
    const normCurrent = normalize(current);
    const currentTrailsNewline = /\n+$/.test(normCurrent);
    const textTrailsNewline = /\n+$/.test(text);
    if (currentTrailsNewline && !textTrailsNewline) {
      text += '\n';
    } else if (!currentTrailsNewline && textTrailsNewline) {
      text = text.replace(/\n+$/, '');
    }
    return text;
  }, []);

  const lastMtimeRef = useRef(0);
  const loadFileRef = useRef<() => void>(() => {});
  const loadSeqRef = useRef(0);
  const pathRef = useRef(resolvedPath);
  useEffect(() => { pathRef.current = resolvedPath; }, [resolvedPath]);

  useEffect(() => {
    let cancelled = false;
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    const requestPath = resolvedPath;
    lastMtimeRef.current = 0;

    setContent('');
    setTruncatedInfo(null);
    setError(null);
    setDiffHunkCount(0);
    setHunkIdx(0);

    const commitIfCurrent = (fn: () => void) => {
      if (cancelled) return;
      if (seq !== loadSeqRef.current) return;
      if (pathRef.current !== requestPath) return;
      fn();
    };

    /* 超大文件保护: 超过 MAX_CODE_CHARS 只塞前半段进 Monaco (按行切齐), 顶部提示. */
    const applyContent = (text: string) => {
      if (text.length <= MAX_CODE_CHARS) {
        setContent(text);
        setTruncatedInfo(null);
        return;
      }
      const head = text.slice(0, MAX_CODE_CHARS);
      const lastNewline = head.lastIndexOf('\n');
      const shown = lastNewline > 0 ? head.slice(0, lastNewline + 1) : head;
      let totalLines = 1;
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) totalLines++;
      }
      let shownLines = 1;
      for (let i = 0; i < shown.length; i++) {
        if (shown.charCodeAt(i) === 10) shownLines++;
      }
      setContent(shown);
      setTruncatedInfo({ shownLines, totalLines, totalChars: text.length });
    };

    const isMissingErr = (msg: string) => /ENOENT|no such file or directory|not found/i.test(msg);

    const load = async () => {
      /* 有未保存改动时整个轮询停手 —— 连读都不读, 免得 mtime 一变就走到 setContent。 */
      if (dirtyRef.current) return;
      if (!isFilePath) {
        commitIfCurrent(() => {
          applyContent(fallbackContent ?? '');
          setError(null);
        });
        return;
      }
      /* Git History / 明确比对: fallbackContent 是快照正文, 不能被工作区脏文件盖掉 */
      const useSnapshot = fallbackContent !== undefined
        && (defaultDiffViewMode === 'side-by-side' || defaultDiffViewMode === 'inline');
      if (useSnapshot) {
        commitIfCurrent(() => {
          applyContent(fallbackContent ?? '');
          setError(null);
        });
        return;
      }
      const startedAt = performance.now();
      try {
        const api = (window as any).neox;
        const reader = api?.surfaceReadFile ?? api?.readFile;
        if (!reader) {
          commitIfCurrent(() => {
            if (fallbackContent !== undefined) {
              applyContent(fallbackContent);
              setError(null);
              return;
            }
            setError(isZh ? 'neox.surfaceReadFile 不可用' : 'neox.surfaceReadFile unavailable');
          });
          return;
        }
        const result = await reader(requestPath, workspacePath ? { workspacePath } : undefined);
        if (cancelled || seq !== loadSeqRef.current || pathRef.current !== requestPath) {
          if ((window as any).__NEOX_SURFACE_DIFF_DEBUG__) {
            console.debug('[SurfaceDiff]', 'stale-read-dropped', { path: requestPath, seq, activeSeq: loadSeqRef.current });
          }
          return;
        }
        if (result?.success === false) {
          const rawErr = String(result.error || 'read failed');
          /* monorepo 子目录拼错路径 → 试 git root 纠正, 成功则切 resolvedPath 重载 */
          if (isMissingErr(rawErr) && requestPath === path) {
            const healed = await healSubdirGitPath(requestPath, workspacePath);
            if (healed && !cancelled && seq === loadSeqRef.current) {
              setResolvedPath(healed);
              return;
            }
          }
          if (/access denied|outside workspace/i.test(rawErr) && workspacePath) {
            try {
              await api?.surfaceRememberAccess?.({ path: requestPath, root: workspacePath, capability: 'read' });
              const retry = await reader(requestPath, { workspacePath });
              if (retry?.success !== false) {
                const text = typeof retry === 'string' ? retry : (retry?.content ?? '');
                const mtime = typeof retry === 'object' ? (retry?.mtimeMs ?? retry?.mtime ?? 0) : 0;
                if (!(mtime && mtime === lastMtimeRef.current)) {
                  lastMtimeRef.current = mtime || lastMtimeRef.current;
                  applyContent(text);
                }
                setError(null);
                return;
              }
            } catch { /* fall through */ }
          }
          if (fallbackContent !== undefined) {
            applyContent(fallbackContent);
            setError(null);
          } else {
            setError(/access denied|outside workspace/i.test(rawErr)
              ? (isZh ? '预览暂时不可用，请稍后重试' : 'Preview temporarily unavailable')
              : rawErr);
          }
          return;
        }
        const text = typeof result === 'string' ? result : (result?.content ?? '');
        const mtime = typeof result === 'object' ? (result?.mtimeMs ?? result?.mtime ?? 0) : 0;
        if (mtime && mtime === lastMtimeRef.current) return;
        lastMtimeRef.current = mtime;
        applyContent(text);
        setError(null);
        if ((window as any).__NEOX_SURFACE_DIFF_DEBUG__) {
          console.debug('[SurfaceDiff]', 'load-commit', { path: requestPath, seq, ms: Math.round(performance.now() - startedAt), bytes: text.length, mtime });
        }
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (isMissingErr(msg) && requestPath === path) {
          try {
            const healed = await healSubdirGitPath(requestPath, workspacePath);
            if (healed && !cancelled && seq === loadSeqRef.current) {
              setResolvedPath(healed);
              return;
            }
          } catch { /* fall through */ }
        }
        commitIfCurrent(() => {
          if (fallbackContent !== undefined) {
            applyContent(fallbackContent);
            setError(null);
            return;
          }
          setError(msg);
        });
      }
    };
    loadFileRef.current = load;
    void load();
    return () => { cancelled = true; };
  }, [resolvedPath, path, isFilePath, fallbackContent, workspacePath, isZh, defaultDiffViewMode]);

  /* 250ms polling 仅在 tab 可见时跑 (visibilitychange 自动 pause/resume). */
  useVisibilityInterval(() => loadFileRef.current(), isFilePath ? 250 : 0);

  /* Neox Editor Engine 懒加载 + mount. 普通 editor ↔ DiffEditor 结构不同,
   * 模式切换时必须 dispose/recreate; 同模式内 path/content/language 仍走 model sync.
   * **必须用 ref 拿最新 content/language/theme** —
   * editor runtime import 是 async (几百 ms), 期间 content 可能已经 setState 多次, closure 失效.
   *
   * 三种展示:
   *   · preview: editor.create — 默认单编辑器 + decorations, 不挤右侧面板
   *   · inline: createDiffEditor(renderSideBySide=false) — 单窗上下红绿对比
   *   · side-by-side: createDiffEditor(renderSideBySide=true) — 左右对比 */
  useEffect(() => {
    let cancelled = false;
    const el = containerRef.current;
    if (!el) return;
    setEditorReady(false);
    /* NOTE deps 里必须带 hasLoadError — 见 effect 末尾的说明. */
    (async () => {
      const editorEngine: any = await loadNeoxEditorEngine();
      if (cancelled) return;
      editorEngineRef.current = editorEngine;
      if (editorRef.current || sbsOrigEditorRef.current || diffEditorRef.current) return;
      const activeIsSideBySide = isDiffModeRef.current;
      const activeHasDiffPreview = (editHunksRef.current?.length ?? 0) > 0 || (changedLinesRef.current?.length ?? 0) > 0;

      const commonOpts = {
        ...getNeoxCodeEditorOptions({
          isDiff: activeIsSideBySide,
          minimap: !activeIsSideBySide && !activeHasDiffPreview,
          fontSize: 13,
          lineHeight: activeHasDiffPreview ? 22 : 20,
          readOnly: true,
        }),
        bracketPairColorization: { enabled: false },
        guides: { bracketPairs: false, bracketPairsHorizontal: false },
        matchBrackets: 'never' as const,
        lineDecorationsWidth: 22,
        lineNumbersMinChars: 4,
        theme: defineNeoxEditorTheme(editorEngine, isDarkRef.current),
      };

      if (activeIsSideBySide) {
        /* 左右: 双栏独立 Monaco — 左改前红 / 右改后绿, 按 hunk 原文 (不用 Myers DiffEditor). */
        const origEl = sbsOrigContainerRef.current;
        const modEl = sbsModContainerRef.current;
        if (!origEl || !modEl) {
          /* React 子 ref 偶发未就绪 — 下一帧再挂, 避免 editorReady 永久 false */
          requestAnimationFrame(() => {
            if (cancelled) return;
            const o2 = sbsOrigContainerRef.current;
            const m2 = sbsModContainerRef.current;
            if (!o2 || !m2 || editorRef.current || sbsOrigEditorRef.current) return;
            const oldContent = reconstructOldContent(contentRef.current, editHunksRef.current ?? []);
            const normalizedCurrent = contentRef.current.replace(/\r\n/g, '\n');
            const origEd = createNeoxCodeEditor(editorEngine, o2, {
              value: oldContent,
              language: languageRef.current,
              fontSize: 13,
              readOnly: true,
              minimap: false,
              isDark: isDarkRef.current,
              extraOptions: commonOpts,
            });
            const modEd = createNeoxCodeEditor(editorEngine, m2, {
              value: normalizedCurrent,
              language: languageRef.current,
              fontSize: 13,
              readOnly: true,
              minimap: false,
              isDark: isDarkRef.current,
              extraOptions: commonOpts,
            });
            sbsOrigEditorRef.current = origEd;
            editorRef.current = modEd;
            setDiffHunkCount(editHunksRef.current?.length ?? 0);
            setEditorReady(true);
          });
          return;
        }
        const oldContent = reconstructOldContent(contentRef.current, editHunksRef.current ?? []);
        const normalizedCurrent = contentRef.current.replace(/\r\n/g, '\n');
        const origEd = createNeoxCodeEditor(editorEngine, origEl, {
          value: oldContent,
          language: languageRef.current,
          fontSize: 13,
          readOnly: true,
          minimap: false,
          isDark: isDarkRef.current,
          extraOptions: commonOpts,
        });
        const modEd = createNeoxCodeEditor(editorEngine, modEl, {
          value: normalizedCurrent,
          language: languageRef.current,
          fontSize: 13,
          readOnly: true,
          minimap: false,
          isDark: isDarkRef.current,
          extraOptions: commonOpts,
        });
        sbsOrigEditorRef.current = origEd;
        editorRef.current = modEd;
        setDiffHunkCount(editHunksRef.current?.length ?? 0);
        const firstStart = (editHunksRef.current ?? [])
          .map(h => h.startLine)
          .find((n): n is number => typeof n === 'number' && n > 0);
        if (firstStart) {
          try {
            modEd.revealLineInCenter(firstStart);
            origEd.revealLineInCenter(firstStart);
          } catch { /* noop */ }
        }
        try {
          modEd.addCommand(editorEngine.KeyCode.F7, () => {
            jumpToHunkRef.current(hunkIdxRef.current + 1);
          });
          modEd.addCommand(editorEngine.KeyMod.Shift | editorEngine.KeyCode.F7, () => {
            jumpToHunkRef.current(hunkIdxRef.current - 1);
          });
        } catch { /* noop */ }
        bindAiActionsRef.current(modEd, editorEngine);
      } else {
        const ed = createNeoxCodeEditor(editorEngine, el, {
          value: contentRef.current,
          language: languageRef.current,
          fontSize: 13,
          readOnly: !canEditRef.current,
          minimap: true,
          isDark: isDarkRef.current,
          extraOptions: { ...commonOpts, readOnly: !canEditRef.current, domReadOnly: !canEditRef.current },
        });
        editorRef.current = ed;
        try {
          ed.addCommand(editorEngine.KeyCode.F7, () => {
            jumpToHunkRef.current(hunkIdxRef.current + 1);
          });
          ed.addCommand(editorEngine.KeyMod.Shift | editorEngine.KeyCode.F7, () => {
            jumpToHunkRef.current(hunkIdxRef.current - 1);
          });
        } catch { /* noop */ }
        bindEditableEditorRef.current(ed, editorEngine);
        bindAiActionsRef.current(ed, editorEngine);
      }

      setEditorReady(true);
    })();
    return () => {
      cancelled = true;
      try { diffEditorRef.current?.dispose(); } catch { /* */ }
      try { sbsOrigEditorRef.current?.dispose?.(); } catch { /* */ }
      try { editorRef.current?.dispose?.(); } catch { /* */ }
      diffEditorRef.current = null;
      sbsOrigEditorRef.current = null;
      editorRef.current = null;
      editorEngineRef.current = null;
      /* 不要 el.innerHTML='' — Monaco dispose 已拆 DOM, 再清会跟 React 抢节点
       * (removeChild: node is not a child). */
      setEditorReady(false);
    };
  /* hasLoadError 必须进 deps —— 否则「点了文件夹 → 报错 → 再点文件」源码区永久空白.
   *
   * 链路: error 非空时组件在下面 early-return 错误页, `<div ref={containerRef}>` 整个不渲染
   * → containerRef.current = null. 此 effect 若只依赖 editorModeKey 就不会重跑, 于是
   *   1. 旧 editor 不被 dispose (cleanup 没机会跑) → 它还绑在已被 React 卸载的游离 DOM 上;
   *   2. error 清掉后容器 div 重新挂载成一个**全新的 DOM 节点**, 但 effect 依然不重跑
   *      → 新容器里什么都没有 → 源码区空白, 而「渲染」因为走 CodePreviewPane (纯 React,
   *        不依赖 Monaco) 反而正常, 这就是那个"点渲染又能看"的假象.
   * 带上 hasLoadError 后: 报错时先跑 cleanup dispose 掉旧 editor(顺带修了泄漏), 错误清掉时
   * 重跑并对着新容器重新 create. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorModeKey, hasLoadError]);

  useEffect(() => {
    if (!editorReady) return;
    const el = containerRef.current;
    if (!el) return;

    let raf = 0;
    let settleTimer = 0;
    let lateTimer = 0;

    const layoutEditor = () => {
      try {
        if (sbsOrigEditorRef.current && editorRef.current) {
          const origEl = sbsOrigContainerRef.current;
          const modEl = sbsModContainerRef.current;
          if (origEl && modEl) {
            const ow = origEl.clientWidth;
            const oh = origEl.clientHeight;
            const mw = modEl.clientWidth;
            const mh = modEl.clientHeight;
            if (ow >= 32 && oh >= 32) sbsOrigEditorRef.current.layout?.({ width: ow, height: oh });
            if (mw >= 32 && mh >= 32) editorRef.current.layout?.({ width: mw, height: mh });
          }
          return;
        }
        const width = el.clientWidth;
        const height = el.clientHeight;
        if (width < 32 || height < 32) return;
        editorRef.current?.layout?.({ width, height });
      } catch { /* Monaco can throw during disposal; next resize will recover. */ }
    };

    const scheduleLayout = () => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        layoutEditor();
      });
    };

    scheduleLayout();
    settleTimer = window.setTimeout(scheduleLayout, 80);
    lateTimer = window.setTimeout(scheduleLayout, 260);

    const ResizeObserverCtor = window.ResizeObserver;
    const observer = ResizeObserverCtor ? new ResizeObserverCtor(scheduleLayout) : null;
    observer?.observe(el);
    window.addEventListener('resize', scheduleLayout);
    window.addEventListener('neox:surface-layout', scheduleLayout);

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.clearTimeout(settleTimer);
      window.clearTimeout(lateTimer);
      observer?.disconnect();
      window.removeEventListener('resize', scheduleLayout);
      window.removeEventListener('neox:surface-layout', scheduleLayout);
    };
  }, [editorReady, isDiffMode, path]);

  /* content / language 变化 — 普通 editor 专用。
   * diff mode 不能在这里单独 set modified model，否则会出现“旧 original + 新 modified”
   * 或“新 hunks + 旧 content”的瞬时错配，Monaco 会把整文件标成红/绿。 */
  useEffect(() => {
    if (isDiffMode) return;
    const editor = editorRef.current;
    const editorEngine = editorEngineRef.current;
    if (!editor || !editorEngine) return;
    const model = editor.getModel();
    if (!model) return;
    /* 有未保存的改动就别回写 —— 轮询每 250ms 跑一次, 谁在敲字谁遭殃
       (setValue 会整段替换 + 光标弹回第一行)。存盘后 dirty 归 false 自然恢复同步。 */
    if (dirtyRef.current) return;
    if (model.getValue() !== content) {
      model.setValue(content);
      editor.revealPosition({ lineNumber: 1, column: 1 });
    }
    const curLang = model.getLanguageId?.() ?? '';
    if (curLang !== language) {
      editorEngine.editor.setModelLanguage(model, language);
    }
  }, [content, language, editorReady, isDiffMode]);

  /* 左右双栏内容同步 — 左=改前, 右=改后. */
  useEffect(() => {
    if (!isDiffMode) return;
    const editorEngine = editorEngineRef.current;
    const origEd = sbsOrigEditorRef.current;
    const modEd = editorRef.current;
    if (!editorEngine || !origEd || !modEd) return;
    const origModel = origEd.getModel?.();
    const modModel = modEd.getModel?.();
    if (!origModel || !modModel) return;

    const normalizedCurrent = content.replace(/\r\n/g, '\n');
    const oldContent = typeof diffOriginal === 'string'
      ? diffOriginal.replace(/\r\n/g, '\n')
      : reconstructOldContent(normalizedCurrent, pendingEditHunks);
    if (origModel.getValue() !== oldContent) origModel.setValue(oldContent);
    if (modModel.getValue() !== normalizedCurrent) modModel.setValue(normalizedCurrent);
    if ((origModel.getLanguageId?.() ?? '') !== language) {
      editorEngine.editor.setModelLanguage(origModel, language);
    }
    if ((modModel.getLanguageId?.() ?? '') !== language) {
      editorEngine.editor.setModelLanguage(modModel, language);
    }
    setDiffHunkCount(pendingEditHunks.length || (diffOriginal != null ? 1 : 0));
  }, [isDiffMode, path, content, pendingEditHunks, language, editorReady, reconstructOldContent, diffOriginal]);

  /* 主题切换 — 用 Neox 自定义主题 (跟 themePreset 色板对齐), 不再走底层默认 vs / vs-dark.
   * themePreset 在 deps 里, 切换 nuanyang → moye 时 defineTheme 用新色板重 register.
   * path/content 也跟: 新文件写入后 turn_summary 无头 Diff 曾误切全局 neox-light,
   * Surface 不重挂就一直错色; 内容到位时再 setTheme 一次兜住. */
  useEffect(() => {
    const editorEngine = editorEngineRef.current;
    if (!editorEngine) return;
    const themeName = defineNeoxEditorTheme(editorEngine, isDark);
    editorEngine.editor.setTheme(themeName);
  }, [isDark, themePreset, editorReady, path, content]);

  /* 左右双栏行高亮 — 左红(oldString 行) / 右绿(newString 行), 按 hunk 原文. */
  useEffect(() => {
    if (!isDiffMode) return;
    const editorEngine = editorEngineRef.current;
    const origEd = sbsOrigEditorRef.current;
    const modEd = editorRef.current;
    if (!editorEngine || !origEd || !modEd) return;

    const hunks = pendingEditHunks;
    const addDecs: any[] = [];
    const delDecs: any[] = [];
    const seenAdd = new Set<number>();
    const seenDel = new Set<number>();
    for (const h of hunks) {
      if (h.previewTruncated) continue;
      for (const range of literalNewLineRangesFromHunk(h)) {
        for (let line = range.start; line <= range.end; line++) {
          if (seenAdd.has(line)) continue;
          seenAdd.add(line);
          addDecs.push({
            range: new editorEngine.Range(line, 1, line, 1),
            options: {
              isWholeLine: true,
              className: 'sfc-code__line--add',
              linesDecorationsClassName: 'sfc-code__gutter sfc-code__gutter--add',
              lineNumberClassName: 'sfc-code__lineno--add',
              marginClassName: 'sfc-code__margin--add',
            },
          });
        }
      }
      const oldCount = countHunkLines(h.oldString);
      if (oldCount <= 0) continue;
      const startLine = Math.max(1, h.startLine ?? 1);
      for (let line = startLine; line < startLine + oldCount; line++) {
        if (seenDel.has(line)) continue;
        seenDel.add(line);
        delDecs.push({
          range: new editorEngine.Range(line, 1, line, 1),
          options: {
            isWholeLine: true,
            className: 'sfc-code__line--del',
            linesDecorationsClassName: 'sfc-code__gutter sfc-code__gutter--del',
            lineNumberClassName: 'sfc-code__lineno--del',
            marginClassName: 'sfc-code__margin--del',
          },
        });
      }
    }
    diffPreciseDecorationsRef.current = modEd.deltaDecorations(diffPreciseDecorationsRef.current, addDecs);
    sbsOrigDecorationsRef.current = origEd.deltaDecorations(sbsOrigDecorationsRef.current, delDecs);

    return () => {
      try {
        diffPreciseDecorationsRef.current = modEd.deltaDecorations(diffPreciseDecorationsRef.current, []);
      } catch { /* noop */ }
      try {
        sbsOrigDecorationsRef.current = origEd.deltaDecorations(sbsOrigDecorationsRef.current, []);
      } catch { /* noop */ }
    };
  }, [isDiffMode, pendingEditHunks, content, editorReady]);

  /* 改动行高亮 — editor deltaDecorations 应用 changedLines.
   * content 变更后也要重 apply (model 内容变了 decoration 会被冲掉).
   *
   * diff mode 跳过 — DiffEditor 自己渲染老/新双色 diff, 不需要我们手画 decoration. */
  useEffect(() => {
    if (isDiffMode) return;
    const editor = editorRef.current;
    const editorEngine = editorEngineRef.current;
    if (!editor || !editorEngine) return;
    /* 删除已经由 view zone 以整行红底真实呈现时, 不再叠加"顶边线"标记 — 那条线是
     * 没有原文可展示时的退化画法, 两者同时出现会读成一条多余的分隔线. */
    const lines = deletedBlocks.length > 0
      ? previewChangedLines.filter(l => l.kind !== 'del')
      : previewChangedLines;
    const newDecs = lines.flatMap(l => {
      const isDel = l.kind === 'del';
      /* ?? diff ??:
       *   add → 整行绿色背景 + 绿色 gutter strip
       *   del → 不染行背景 (被删的内容已不存在新文件里, 染整行红会误导)
       *         只画红色 gutter wedge + 红色 top-border 标记"这一行之前曾有删除"
       *         可以跟同一行的 add 装饰叠加而不冲突 */
      const out: any[] = [];
      for (let line = l.start; line <= l.end; line++) {
        out.push({
          range: new editorEngine.Range(line, 1, line, 1),
          options: {
            isWholeLine: true,
            className: isDel ? 'sfc-code__line--delmark' : 'sfc-code__line--add',
            linesDecorationsClassName: isDel ? 'sfc-code__gutter sfc-code__gutter--del' : 'sfc-code__gutter sfc-code__gutter--add',
            lineNumberClassName: isDel ? 'sfc-code__lineno--del' : 'sfc-code__lineno--add',
            marginClassName: isDel ? 'sfc-code__margin--del' : 'sfc-code__margin--add',
            minimap: {
              color: isDel ? '#ef444466' : '#22c55e66',
              position: 2 /* editor.MinimapPosition.Inline */,
            },
            overviewRuler: {
              color: isDel ? '#ef444466' : '#22c55e66',
              position: 4 /* editor.OverviewRulerLane.Right */,
            },
          },
        });
      }
      return out;
    });
    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, newDecs);
    /* 跳到第一个改动行, 让用户立刻看到. 只在 lines 非空且首次/path 变化时跳. */
    if (lines.length > 0) {
      editor.revealLineInCenter(lines[0]!.start);
      setHunkIdx(0);
    }
  }, [isDiffMode, previewChangedLines, deletedBlocks, content, editorReady]);

  /* 删除行 view zone — 内嵌真 Monaco (整份改前文件模型, 只露出删行).
   * colorize 只有语法 token, 绿行有语义高亮 → 同一句代码颜色/字重对不上. */
  const delZoneIdsRef = useRef<string[]>([]);
  useEffect(() => {
    if (isDiffMode || !editorReady) return;
    const editor = editorRef.current;
    const editorEngine = editorEngineRef.current;
    if (!editor || !editorEngine) return;

    let cancelled = false;
    let ids: string[] = [];
    let scrollSub: { dispose?: () => void } | null = null;
    let layoutSub: { dispose?: () => void } | null = null;
    let raf = 0;
    let tries = 0;
    let gen = 0;
    const miniEditors: any[] = [];

    const clear = () => {
      for (const mini of miniEditors) {
        try { mini.dispose?.(); } catch { /* noop */ }
      }
      miniEditors.length = 0;
      if (ids.length === 0) {
        delZoneIdsRef.current = [];
        return;
      }
      try {
        editor.changeViewZones((accessor: any) => {
          for (const id of ids) {
            try { accessor.removeZone(id); } catch { /* noop */ }
          }
        });
      } catch { /* editor disposing */ }
      ids = [];
      delZoneIdsRef.current = [];
    };

    const syncMiniChrome = () => {
      const x = editor.getScrollLeft?.() ?? 0;
      const w = editor.getLayoutInfo?.()?.contentWidth ?? 0;
      for (const mini of miniEditors) {
        try {
          const host = mini.getContainerDomNode?.() ?? mini.getDomNode?.()?.parentElement;
          const h = host?.clientHeight ?? 0;
          if (w > 0 && h > 0) mini.layout?.({ width: w, height: h });
          mini.setScrollLeft?.(x);
        } catch { /* */ }
      }
    };

    const apply = () => {
      if (cancelled) return;
      const myGen = ++gen;
      if (deletedBlocks.length === 0) {
        clear();
        return;
      }
      const model = editor.getModel?.();
      const lineCount = model?.getLineCount?.() ?? 0;
      if (lineCount <= 0) {
        if (tries++ < 30) raf = window.requestAnimationFrame(apply);
        return;
      }

      let lineHeight = 22;
      let fontSize = 14;
      let fontFamily: string | undefined;
      try {
        const Opt = editorEngine.editor?.EditorOption;
        if (Opt?.lineHeight !== undefined) {
          const v = editor.getOption?.(Opt.lineHeight);
          if (typeof v === 'number' && v > 0) lineHeight = v;
        }
        if (Opt?.fontSize !== undefined) {
          const v = editor.getOption?.(Opt.fontSize);
          if (typeof v === 'number' && v > 0) fontSize = v;
        }
        if (Opt?.fontFamily !== undefined) {
          const v = editor.getOption?.(Opt.fontFamily);
          if (typeof v === 'string' && v) fontFamily = v;
        }
      } catch { /* */ }

      let lineNoLeft = 0;
      let lineNoWidth = 0;
      let signLeft = 0;
      let signWidth = 22;
      try {
        const layout = editor.getLayoutInfo?.() ?? null;
        if (layout) {
          lineNoLeft = Math.max(0, layout.lineNumbersLeft ?? layout.glyphMarginWidth ?? 0);
          lineNoWidth = Math.max(0, layout.lineNumbersWidth ?? 0);
          signLeft = Math.max(0, layout.decorationsLeft ?? (lineNoLeft + lineNoWidth));
          signWidth = Math.max(0, layout.decorationsWidth ?? 22);
          /* 量不到时按 contentLeft 反推 */
          if (lineNoWidth <= 0) {
            const contentLeft = Math.max(0, layout.contentLeft ?? 0);
            const glyph = Math.max(0, layout.glyphMarginWidth ?? 0);
            lineNoLeft = glyph;
            lineNoWidth = Math.max(0, contentLeft - glyph - signWidth);
            signLeft = lineNoLeft + lineNoWidth;
          }
        }
      } catch { /* */ }
      const lang = language || model?.getLanguageId?.() || 'plaintext';
      const oldContent = typeof diffOriginal === 'string'
        ? diffOriginal.replace(/\r\n/g, '\n')
        : reconstructOldContent(content.replace(/\r\n/g, '\n'), editHunks ?? []);

      clear();
      editor.changeViewZones((accessor: any) => {
        for (const block of deletedBlocks) {
          const shown = block.lines.slice(0, MAX_DEL_ZONE_LINES);
          const omitted = block.lines.length - shown.length;
          const rows = shown.length + (omitted > 0 ? 1 : 0);
          if (rows <= 0) continue;

          /* 改前文件里删行起点 = hunk.startLine (= afterLine+1) */
          const startLine = Math.max(1, block.afterLine + 1);
          const host = document.createElement('div');
          host.className = 'sfc-code__delzone sfc-code__delzone--monaco';
          host.style.cssText = `height:${rows * lineHeight}px;overflow:hidden;pointer-events:none;position:relative;`;

          const marginDom = document.createElement('div');
          marginDom.className = 'sfc-code__margin sfc-code__margin--del sfc-code__delzone-margin';
          marginDom.style.cssText = `height:${rows * lineHeight}px;position:relative;width:100%;`;
          for (let i = 0; i < shown.length; i++) {
            const mRow = document.createElement('div');
            mRow.className = 'sfc-code__delzone-mrow';
            mRow.style.cssText = `position:absolute;left:0;right:0;top:${i * lineHeight}px;height:${lineHeight}px;`;
            const ln = document.createElement('span');
            ln.className = 'sfc-code__delzone-ln';
            /* 跟绿行共用 Monaco layoutInfo 坐标, 避免手算列宽整列左偏 */
            ln.style.cssText = `position:absolute;left:${lineNoLeft}px;width:${lineNoWidth}px;height:100%;`;
            ln.textContent = String(startLine + i);
            const sign = document.createElement('span');
            sign.className = 'sfc-code__delzone-sign';
            sign.style.cssText = `position:absolute;left:${signLeft}px;width:${signWidth}px;height:100%;`;
            /* U+2212 − , 跟 gutter--del::after 同一枚 (这里曾被写成 '?' —— 疑似编码事故的幸存者) */
            sign.textContent = '−';
            mRow.append(ln, sign);
            marginDom.appendChild(mRow);
          }
          if (omitted > 0) {
            const mRow = document.createElement('div');
            mRow.className = 'sfc-code__delzone-mrow';
            mRow.style.cssText = `position:absolute;left:0;right:0;top:${shown.length * lineHeight}px;height:${lineHeight}px;`;
            marginDom.appendChild(mRow);
          }

          ids.push(accessor.addZone({
            afterLineNumber: Math.min(Math.max(0, block.afterLine), lineCount),
            heightInPx: rows * lineHeight,
            domNode: host,
            marginDomNode: marginDom,
            showInHiddenAreas: true,
          }));

          /* zone 挂上后再建 mini editor — 整份改前模型 + 只露出删行, 跟绿行同一套语义高亮 */
          requestAnimationFrame(() => {
            if (cancelled || myGen !== gen || !host.isConnected) return;
            try {
              const mini = createNeoxCodeEditor(editorEngine, host, {
                value: oldContent,
                language: lang,
                fontSize,
                lineHeight,
                readOnly: true,
                minimap: false,
                isDark: isDarkRef.current,
                applyTheme: false,
                extraOptions: {
                  automaticLayout: false,
                  lineNumbers: 'off',
                  lineDecorationsWidth: 0,
                  lineNumbersMinChars: 0,
                  glyphMargin: false,
                  folding: false,
                  scrollBeyondLastLine: false,
                  renderLineHighlight: 'none',
                  overviewRulerLanes: 0,
                  overviewRulerBorder: false,
                  hideCursorInOverviewRuler: true,
                  contextmenu: false,
                  /* 跟主编辑器一致: 符号下划线 (ctrl/cmd 可点) */
                  links: true,
                  renderValidationDecorations: 'off',
                  scrollbar: {
                    vertical: 'hidden',
                    horizontal: 'hidden',
                    handleMouseWheel: false,
                    alwaysConsumeMouseWheel: false,
                    useShadows: false,
                    verticalScrollbarSize: 0,
                    horizontalScrollbarSize: 0,
                  },
                  padding: { top: 0, bottom: 0 },
                  ...(fontFamily ? { fontFamily } : null),
                },
              });
              if (cancelled || myGen !== gen) {
                try { mini.dispose?.(); } catch { /* */ }
                return;
              }
              miniEditors.push(mini);
              const miniModel = mini.getModel?.();
              const delDecs = [];
              for (let line = startLine; line < startLine + shown.length; line++) {
                const endCol = miniModel?.getLineMaxColumn?.(line) ?? 1;
                delDecs.push({
                  range: new editorEngine.Range(line, 1, line, endCol),
                  options: {
                    isWholeLine: true,
                    className: 'sfc-code__line--del',
                    marginClassName: 'sfc-code__margin--del',
                  },
                });
              }
              mini.deltaDecorations([], delDecs);

              const pinDeletedLines = () => {
                try {
                  const w = host.clientWidth || editor.getLayoutInfo?.()?.contentWidth || 400;
                  mini.layout?.({ width: w, height: rows * lineHeight });
                  const top = mini.getTopForLineNumber?.(startLine) ?? ((startLine - 1) * lineHeight);
                  mini.setScrollTop?.(top);
                  mini.setScrollLeft?.(editor.getScrollLeft?.() ?? 0);
                } catch { /* */ }
              };
              pinDeletedLines();
              requestAnimationFrame(pinDeletedLines);
              /* token / 语义高亮晚到时再钉一次, 避免首帧字色还是 plaintext */
              try {
                const tokSub = miniModel?.onDidChangeTokens?.(() => {
                  pinDeletedLines();
                  try { tokSub?.dispose?.(); } catch { /* */ }
                });
              } catch { /* */ }
            } catch { /* mini ????? zone ??, ?????? */ }
          });
        }
      });
      delZoneIdsRef.current = ids;

      try { scrollSub?.dispose?.(); } catch { /* */ }
      try { layoutSub?.dispose?.(); } catch { /* */ }
      scrollSub = editor.onDidScrollChange?.(syncMiniChrome) ?? null;
      layoutSub = editor.onDidLayoutChange?.(syncMiniChrome) ?? null;
    };

    apply();

    return () => {
      cancelled = true;
      gen += 1;
      if (raf) window.cancelAnimationFrame(raf);
      try { scrollSub?.dispose?.(); } catch { /* */ }
      try { layoutSub?.dispose?.(); } catch { /* */ }
      clear();
    };
  }, [isDiffMode, deletedBlocks, content, editorReady, isZh, path, language, editHunks, reconstructOldContent, diffOriginal]);

  /* 行号聚焦 — timeline 文件引用带行号打开时滚到目标行并短暂高亮.
   * 声明在 changedLines reveal effect 之后: 同一次 commit 两个 effect 都跑时后者胜出,
   * 显式行号请求优先于"跳到第一个改动"的默认行为. focusNonce 每次 open 请求都变,
   * 同一行重复点击也能重新触发. */
  const focusFlashTimerRef = useRef<number | null>(null);
  const focusDecorationsRef = useRef<string[]>([]);
  /* 同一个 focus 请求只处理一次 — content 轮询更新不该把用户从他滚到的位置拽回聚焦行. */
  const handledFocusKeyRef = useRef<string>('');
  useEffect(() => {
    if (!focusLine || focusLine <= 0) return;
    if (!editorReady || !content) return;
    const focusKey = `${path}::${focusLine}::${focusNonce ?? 0}`;
    if (handledFocusKeyRef.current === focusKey) return;
    const editor = editorRef.current;
    const editorEngine = editorEngineRef.current;
    if (!editor || !editorEngine) return;
    handledFocusKeyRef.current = focusKey;
    const model = editor.getModel?.();
    const lineCount = model?.getLineCount?.() ?? 0;
    if (lineCount === 0) return;
    const target = Math.min(Math.max(1, focusLine), lineCount);
    try {
      editor.revealLineInCenter(target);
      editor.setPosition({ lineNumber: target, column: 1 });
    } catch { /* editor disposing */ }
    /* 目标行短暂高亮 (2s 淡出) — 让用户看清跳到了哪 */
    try {
      focusDecorationsRef.current = editor.deltaDecorations(focusDecorationsRef.current, [{
        range: new editorEngine.Range(target, 1, target, 1),
        options: {
          isWholeLine: true,
          className: 'sfc-code__line--focus',
          linesDecorationsClassName: 'sfc-code__gutter sfc-code__gutter--focus',
        },
      }]);
    } catch { /* noop */ }
    if (focusFlashTimerRef.current != null) window.clearTimeout(focusFlashTimerRef.current);
    focusFlashTimerRef.current = window.setTimeout(() => {
      focusFlashTimerRef.current = null;
      try {
        focusDecorationsRef.current = editorRef.current?.deltaDecorations?.(focusDecorationsRef.current, []) ?? [];
      } catch { /* noop */ }
    }, 2000);
    return () => {
      /* 取消 pending 的淡出 timer 时同步清 decoration — 否则高亮永久残留. */
      if (focusFlashTimerRef.current != null) {
        window.clearTimeout(focusFlashTimerRef.current);
        focusFlashTimerRef.current = null;
        try {
          focusDecorationsRef.current = editorRef.current?.deltaDecorations?.(focusDecorationsRef.current, []) ?? [];
        } catch { /* noop */ }
      }
    };
  }, [focusLine, focusNonce, editorReady, content, path]);

  /* ========================================================================
   * E-03: per-hunk Accept/Reject overlay widgets (DiffEditor ??)
   *
   * 每个 hunk 在 modified editor 的 startLine 上方挂一个 ContentWidget,
   * DOM 是两个 button (✓ accept / ✗ reject). 视觉:
   *   pending: ✓ 绿框 + ✗ 红框 (两个都激活)
   *   accepted: ✓ 高亮填充 + ✗ 隐藏
   *   rejected: ✗ 高亮填充 + ✓ 隐藏 (此时文件物理内容已还原, hunk 显示一段时间后会因 diff 重算消失)
   *
   * Reject 物理行为: 调 file:revert-hunk IPC (带 startLine 锚定, 防多 hunk 同文件误删).
   *   IPC 写回文件 → content reload effect 自动拉新内容 → DiffEditor 重算 lineChanges → widget 重建.
   *
   * Accept 物理行为: 仅 UI 标记, 不动文件 (用户已经接受 LLM 的改动, 文件就是这状态).
   *
   * previewTruncated=true 的 hunk: disable Reject 按钮 + tooltip 解释 (newString 是占位符无法回滚).
   * ====================================================================== */
  useEffect(() => {
    if (!isDiffMode || !editorReady) return;
    const editorEngine = editorEngineRef.current;
    /* 左右双栏: editorRef 就是改后侧; 旧 DiffEditor 路径已弃用 */
    const modEditor = editorRef.current;
    if (!modEditor || !editorEngine) return;

    /* 旧 widgets 全 dispose. Map<widgetId, widget> 存在 closure 里, 这个 effect 重跑时清理. */
    const widgets: any[] = [];

    let buildPassSeq = 0;
    const buildWidgets = () => {
      const buildPass = ++buildPassSeq;
      for (const w of widgets) {
        try { modEditor.removeOverlayWidget(w); } catch { /* */ }
      }
      widgets.length = 0;

      /* 左右双栏按 editHunks 挂审批钮 (不再依赖 DiffEditor lineChanges). */
      const hunks = editHunksRef.current ?? [];
      const anchors: Array<{ line: number; lcIdx: number; hunkIdxs: number[] }> = [];
      for (let i = 0; i < hunks.length; i++) {
        const h = hunks[i];
        const line = (typeof h.startLine === 'number' && h.startLine > 0) ? h.startLine : 1;
        anchors.push({ line, lcIdx: i, hunkIdxs: [i] });
      }
      if (anchors.length === 0) return;

      anchors.forEach(({ line: startLine, lcIdx, hunkIdxs }) => {
        /* 这一段视觉 diff 区段的整体审批状态: 任何 hunk pending → pending;
         *  全 accepted → accepted; 全 rejected → rejected; 混合 → pending (用户能继续操作). */
        const reviews = hunkIdxs.map(i => reviewMapRef.current[i] ?? (hunks[i]?.review) ?? 'pending');
        const review: 'pending' | 'accepted' | 'rejected' =
          reviews.every(r => r === 'accepted') ? 'accepted' :
          reviews.every(r => r === 'rejected') ? 'rejected' :
          'pending';
        /* truncated: 任一相关 hunk truncated → 整段 reject 不可用 */
        const truncated = hunkIdxs.some(i => !!hunks[i]?.previewTruncated);

        const dom = document.createElement('div');
        dom.className = `sfc-hunk-actions sfc-hunk-actions--${review}`;
        if (truncated) dom.classList.add('sfc-hunk-actions--truncated');

        const renderBtn = (label: string, type: 'accept' | 'reject', title: string, disabled = false) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `sfc-hunk-actions__btn sfc-hunk-actions__${type}`;
          btn.textContent = label;
          btn.title = title;
          btn.disabled = disabled;
          btn.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
          btn.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (disabled) return;
            if (type === 'accept') {
              /* Accept 区段 = 标这段里所有 hunks 为 accepted */
              setReviewMap(prev => {
                const next = { ...prev };
                for (const i of hunkIdxs) next[i] = 'accepted';
                return next;
              });
              for (const i of hunkIdxs) persistHunkReviewRef.current(i, 'accepted');
            } else {
              /* Reject 区段 = 依次调 IPC 物理回滚该段所有 hunks. 任一失败 toast 报错, 已成功的
               *  仍标记 rejected (顶部状态 chips 会反映). */
              const api = (window as any).neox;
              if (typeof api?.revertFileHunk !== 'function') {
                console.warn('[hunk-review] revertFileHunk IPC unavailable');
                return;
              }
              btn.disabled = true;
              const succeeded: number[] = [];
              const failed: Array<{ idx: number; error?: string }> = [];
              for (const i of hunkIdxs) {
                const h = hunks[i];
                if (!h || h.previewTruncated) { failed.push({ idx: i, error: isZh ? '内容截断' : 'content truncated' }); continue; }
                try {
                  const r = await api.revertFileHunk({
                    filePath: path,
                    oldString: h.oldString,
                    newString: h.newString,
                    startLine: h.startLine,
                  });
                  if (r?.success) succeeded.push(i);
                  else failed.push({ idx: i, error: r?.error });
                } catch (err: any) {
                  failed.push({ idx: i, error: err?.message });
                }
              }
              if (succeeded.length > 0) {
                setReviewMap(prev => {
                  const next = { ...prev };
                  for (const i of succeeded) next[i] = 'rejected';
                  return next;
                });
                for (const i of succeeded) persistHunkReviewRef.current(i, 'rejected');
              }
              if (failed.length > 0) {
                window.dispatchEvent(new CustomEvent('neox:hint', {
                  detail: {
                    message: isZh
                      ? `拒绝失败 ${failed.length}/${hunkIdxs.length} hunk：${failed[0].error || '未知错误'}`
                      : `Reject failed for ${failed.length}/${hunkIdxs.length} hunk${hunkIdxs.length === 1 ? '' : 's'}: ${failed[0].error || 'unknown'}`,
                    type: 'warning',
                  },
                }));
              }
              btn.disabled = false;
            }
          };
          return btn;
        };

        const acceptBtn = renderBtn('✓', 'accept', isZh ? `接受此区段 (${hunkIdxs.length} hunk)` : `Accept this section (${hunkIdxs.length} hunk${hunkIdxs.length === 1 ? '' : 's'})`, false);
        const rejectBtn = renderBtn('✗', 'reject', truncated
          ? (isZh ? '内容被截断, 无法精准回退' : 'Content truncated — cannot revert precisely')
          : (isZh ? `回退此区段 (${hunkIdxs.length} hunk, 物理还原文件)` : `Revert this section (${hunkIdxs.length} hunk${hunkIdxs.length === 1 ? '' : 's'}, restores the file on disk)`), truncated);

        /* 已审过 inline 整组隐藏 (顶部 chips 已汇总) */
        if (review === 'accepted') rejectBtn.style.display = 'none';
        if (review === 'rejected') acceptBtn.style.display = 'none';

        dom.appendChild(acceptBtn);
        dom.appendChild(rejectBtn);

        const model = modEditor.getModel?.();
        const lineCount = model?.getLineCount?.() ?? 1;
        const safeLine = Math.min(Math.max(1, startLine), Math.max(1, lineCount));
        dom.dataset.line = String(safeLine);
        dom.style.position = 'absolute';
        /* 垂直条实际 ~10px (options.horizontal/verticalScrollbarSize); 旧注释写 14 已过时 */
        const layoutInfo = modEditor.getLayoutInfo?.();
        const vBar = Math.max(10, layoutInfo?.verticalScrollbarWidth ?? 10);
        dom.style.right = `${vBar + 2}px`;
        dom.style.zIndex = '10'; /* ?? < Monaco scrollbar(visible=11), ????????? */

        const widgetId = `sfc-hunk-action-p${buildPass}-lc-${lcIdx}`;
        const widget = {
          _line: safeLine,
          getId: () => widgetId,
          getDomNode: () => dom,
          /* OverlayWidget.getPosition() 返 null → 不插管位置, 我们自己 css 控制 */
          getPosition: () => null,
        };
        try {
          modEditor.addOverlayWidget(widget);
          widgets.push(widget);
        } catch { /* dispose ?? editor ? ready, ?? */ }
      });

      /* 设置每个 widget 的 top: editor 行的 y 坐标 - 滚动量. 在 scroll / diff 重算后更新.
       * 同时钳在横滑条上方 — 否则贴底 hunk 的透明药丸会压住横滑条右端拖不动. */
      const updateTops = () => {
        const scrollTop = modEditor.getScrollTop?.() ?? 0;
        const layout = modEditor.getLayoutInfo?.();
        const hBar = Math.max(10, layout?.horizontalScrollbarHeight ?? 10);
        const maxTop = Math.max(0, (layout?.height ?? 0) - hBar - 22);
        for (const w of widgets) {
          const line = (w as any)._line as number;
          const top = modEditor.getTopForLineNumber?.(line) ?? 0;
          const dom = w.getDomNode();
          dom.style.top = `${Math.min(Math.max(0, top - scrollTop), maxTop)}px`;
        }
      };
      updateTops();
      /* 暴露给 scroll 监听 */
      (buildWidgets as any)._updateTops = updateTops;
    };

    /* scroll ?? update top, ? rebuild */
    const scrollDisposable = modEditor.onDidScrollChange?.(() => {
      const upd = (buildWidgets as any)._updateTops;
      if (typeof upd === 'function') upd();
    });
    buildWidgets();

    return () => {
      try { scrollDisposable?.dispose?.(); } catch { /* */ }
      for (const w of widgets) {
        try { modEditor.removeOverlayWidget(w); } catch { /* */ }
      }
    };
  }, [isDiffMode, editorReady, editHunks, reviewMap, path]);


  const diffFileKind = useMemo((): 'new' | 'deleted' | 'modified' => {
    if (!editHunks || editHunks.length === 0) return 'modified';
    const lineCount = (s?: string) => {
      if (!s) return 0;
      const normalized = s.replace(/\r\n/g, '\n');
      return normalized.endsWith('\n')
        ? Math.max(0, normalized.split('\n').length - 1)
        : normalized.split('\n').length;
    };
    let oldLines = 0;
    let newLines = 0;
    for (const h of editHunks) {
      oldLines += typeof h.oldLineCount === 'number' ? h.oldLineCount : lineCount(h.oldString);
      newLines += typeof h.newLineCount === 'number' ? h.newLineCount : lineCount(h.newString);
    }
    if (oldLines === 0 && newLines > 0) return 'new';
    if (newLines === 0 && oldLines > 0) return 'deleted';
    return 'modified';
  }, [editHunks]);

  const diffBarTitle = diffFileKind === 'new'
    ? (isZh ? '新文件' : 'New file')
    : diffFileKind === 'deleted'
      ? (isZh ? '删除文件' : 'Deleted')
      : (isZh ? '改动' : 'Changes');
  /* 可渲染类型 — html/markdown/svg/json/csv/tsv/mermaid 都在同一 viewer 里就地渲染, 不换 surface 不开 tab.
   * 新增类型看 CodePreviewPane.getPreviewKind(). 纯代码 (ts/py/go/...) 没预览意义, 返 null 就不显 Render 档. */
  const previewKind = getPreviewKind(path);
  const canPreview = previewKind !== null;

  const [modeSlot, setModeSlot] = useState<HTMLElement | null>(null);
  /* 锚点用这条栏自己, **不能用 containerRef** —— containerRef 是 Monaco 的容器, 渲染态
   * (markdown / svg / mermaid) 下它根本不挂载, closest 拿不到宿主, 开关就永远留在原地。
   * 这条栏是无条件渲染的 (哪怕 display:none), 所以它的 ref 一直在。 */
  const diffbarRef = useRef<HTMLDivElement>(null);
  const [slotProbe, setSlotProbe] = useState(0);
  useEffect(() => {
    const host = diffbarRef.current?.closest('.sfc-files__preview');
    const next = (host?.querySelector('.sfc-files__mode-slot') as HTMLElement | null) ?? null;
    setModeSlot((prev) => (prev === next ? prev : next));
    /* 首帧 diffbar 可能比 FilesSurfaceViewer 的 slot 先挂 —— 补一次探测就够,
     * 不做轮询: 两者在同一棵树里, 差不了第二帧。 */
    if (!next && slotProbe === 0) setSlotProbe(1);
  }, [path, slotProbe]);
  const renderInSlot = (node: React.ReactNode): React.ReactNode =>
    (modeSlot ? createPortal(node, modeSlot) : node);
  const runtimeForPreview = useNeoxRuntimeOptional();
  const workspacePathForPreview = runtimeForPreview?.workspacePath;

  const navTotal = isDiffMode
    ? (diffHunkCount || sortedHunks.length)
    : sortedHunks.length;
  const hasDiff = navTotal > 0 || displayHunks.length > 0;

  /* 复制全文 — 大文件截断时只复制已加载部分, hint 里说明. */
  const copyAll = useCallback(() => {
    if (!content) return;
    navigator.clipboard.writeText(content).then(
      () => dispatchHint(
        truncatedInfo
          ? (isZh ? `已复制前 ${truncatedInfo.shownLines.toLocaleString()} 行 (文件被截断)` : `Copied first ${truncatedInfo.shownLines.toLocaleString()} lines (file truncated)`)
          : (isZh ? '已复制文件内容' : 'File content copied'),
        'success',
      ),
      () => dispatchHint(isZh ? '复制失败' : 'Copy failed', 'warning'),
    );
  }, [content, truncatedInfo, isZh]);

  /* per-hunk Review summary ? header ? N pending / N accepted / N rejected, ?? Accept All / Reject All
   *  批量按钮. 只要有 editHunks 就能标记/回退; 默认预览模式也保留这些操作入口. */
  /* +N −N: 只统计仍待审; 全部接受后徽章跟着消失. */
  const diffTotals = useMemo(() => {
    if (displayHunks.length === 0) return null;
    let add = 0;
    let del = 0;
    for (const h of displayHunks) {
      add += countHunkLines(h.newString);
      del += countHunkLines(h.oldString);
    }
    if (add === 0 && del === 0) return null;
    return { add, del };
  }, [displayHunks]);

  const reviewSummary = useMemo(() => {
    if (!editHunks || editHunks.length === 0) {
      return { total: 0, pending: 0, accepted: 0, rejected: 0, hasTruncated: false };
    }
    let pending = 0, accepted = 0, rejected = 0;
    for (let i = 0; i < editHunks.length; i++) {
      const r = resolveHunkReview(i);
      if (r === 'accepted') accepted++;
      else if (r === 'rejected') rejected++;
      else pending++;
    }
    return {
      total: editHunks.length,
      pending,
      accepted,
      rejected,
      hasTruncated: editHunks.some(h => h.previewTruncated),
    };
  }, [editHunks, resolveHunkReview]);

  const acceptAll = useCallback(() => {
    if (!editHunks) return;
    /* 副作用 (persistHunkReview 写 IndexedDB) 在 setState updater 之外做 — React StrictMode dev
     *  会 double-invoke updater, 在里面调副作用会被双触发. */
    const toAccept: number[] = [];
    editHunks.forEach((h, i) => {
      if (h.previewTruncated) return;
      if (resolveHunkReview(i) === 'pending') toAccept.push(i);
    });
    if (toAccept.length === 0) return;
    setReviewMap(prev => {
      const next = { ...prev };
      for (const i of toAccept) next[i] = 'accepted';
      return next;
    });
    for (const i of toAccept) persistHunkReview(i, 'accepted');
    dispatchHint(
      isZh ? `已接受 ${toAccept.length} 处改动` : `Accepted ${toAccept.length} change${toAccept.length === 1 ? '' : 's'}`,
      'success',
    );
  }, [editHunks, resolveHunkReview, persistHunkReview, isZh]);

  const rejectAll = useCallback(async () => {
    if (!editHunks) return;
    const api = (window as any).neox;
    if (typeof api?.revertFileHunk !== 'function') {
      dispatchHint(isZh ? '回退能力未就绪 (IPC bridge 缺失)' : 'Revert unavailable (IPC bridge missing)', 'warning');
      return;
    }
    /* Reject 顺序: startLine 降序 — 先回退行号大的, 避免前面 hunk 还原后后面 hunk 位置漂移
     *  超出 IPC 锚定容差 (±25 行). 失败的 hunk 单独跳过, 不阻断其他. */
    const sorted = editHunks
      .map((h, i) => ({ h, i }))
      .filter(({ h, i }) => {
        const cur: EditHunk['review'] = reviewMap[i] ?? h.review ?? 'pending';
        return !h.previewTruncated && cur === 'pending';
      })
      .sort((a, b) => (b.h.startLine ?? 0) - (a.h.startLine ?? 0));

    if (sorted.length === 0) return;

    const { confirmAsync } = await import('../../../components/confirmEvents');
    const okToRevert = await confirmAsync({
      title: isZh ? `回退 ${sorted.length} 处改动?` : `Revert ${sorted.length} change${sorted.length === 1 ? '' : 's'}?`,
      message: isZh
        ? `「${path.split('/').pop() || path}」里还没审过的 ${sorted.length} 处改动都会被撤销`
        : `All ${sorted.length} unreviewed change${sorted.length === 1 ? '' : 's'} in “${path.split('/').pop() || path}” will be undone`,
      description: isZh
        ? '这会直接改写磁盘上的文件。已经接受过的改动不受影响。'
        : 'This rewrites the file on disk. Changes you already accepted are not affected.',
      variant: 'danger',
      confirmLabel: isZh ? `回退 ${sorted.length} 处` : `Revert ${sorted.length}`,
    });
    if (!okToRevert) return;

    let okCount = 0;
    const failures: Array<{ idx: number; reason: string }> = [];
    for (const { h, i } of sorted) {
      try {
        const r = await api.revertFileHunk({
          filePath: path,
          oldString: h.oldString,
          newString: h.newString,
          startLine: h.startLine,
        });
        if (r?.success) {
          /* 每个成功后立刻 setReviewMap + 持久化 — 用户能看到逐条变红, 而不是等全部跑完一次性变. */
          setReviewMap(prev => ({ ...prev, [i]: 'rejected' }));
          persistHunkReview(i, 'rejected');
          okCount++;
        } else {
          failures.push({ idx: i, reason: r?.error || 'unknown' });
        }
      } catch (err: any) {
        failures.push({ idx: i, reason: err?.message || String(err) });
      }
    }

    /* 汇总 toast — 全成功 / 部分失败 / 全失败 三种情况都告诉用户.
     *  无任何处理的 (sorted.length === 0) 上面已 early return. dispatchHint 没 'error' 档,
     *  全失败也用 warning 表达 (用户能区分: 单数 vs 复数 + 失败 / 部分失败 文案). */
    if (failures.length === 0) {
      dispatchHint(isZh ? `已回退 ${okCount} 个 hunk` : `Reverted ${okCount} hunk${okCount === 1 ? '' : 's'}`, 'success');
    } else if (okCount > 0) {
      dispatchHint(
        isZh
          ? `已回退 ${okCount} 处，${failures.length} 处失败：${failures[0]!.reason}`
          : `Reverted ${okCount}, failed ${failures.length}: ${failures[0]!.reason}`,
        'warning',
      );
    } else {
      dispatchHint(
        isZh ? `全部 ${failures.length} 个 hunk 回退失败: ${failures[0]!.reason}` : `All ${failures.length} hunk${failures.length === 1 ? '' : 's'} failed to revert: ${failures[0]!.reason}`,
        'warning',
      );
    }
  }, [editHunks, reviewMap, path, persistHunkReview]);

  /* error early return — 必须在所有 hooks 之后, 否则 hook 数量随 error 变化 React 炸. */
  if (error) {
    const revealTarget = resolvedPath || path;
    const isMissing = /ENOENT|no such file|not found/i.test(String(error));
    return (
      <div className={`sfc-empty${isMissing ? '' : ' sfc-empty--error'}`}>
        <div className="sfc-empty__title">
          {isMissing
            ? (isZh ? '文件不存在了' : 'This file is gone')
            : (isZh ? '无法加载源码' : 'Failed to load source')}
        </div>
        <div className="sfc-empty__msg">
          {isMissing
            ? (isZh ? '可能是被回退撤销了、在别处删掉了, 或者切换了分支。' : 'It may have been reverted, deleted elsewhere, or lost in a branch switch.')
            : error}
        </div>
        {isFilePath && (
          <div className="sfc-empty__actions">
            <button
              type="button"
              className="sfc-empty__retry sfc-empty__retry--primary"
              onClick={() => { loadFileRef.current?.(); }}
            >
              {isZh ? '重试' : 'Retry'}
            </button>
            <button
              type="button"
              className="sfc-empty__retry sfc-empty__retry--quiet"
              onClick={() => {
                void (async () => {
                  const ok = await revealPathInFinder(revealTarget);
                  if (!ok) {
                    dispatchHint(isZh ? '无法在文件管理器中打开' : 'Could not reveal in file manager', 'warning');
                  }
                })();
              }}
            >
              {revealInFileManagerLabel(isZh)}
            </button>
            <button
              type="button"
              className="sfc-empty__retry sfc-empty__retry--quiet"
              onClick={() => {
                void navigator.clipboard.writeText(revealTarget).then(
                  () => dispatchHint(isZh ? '已复制路径' : 'Path copied', 'success'),
                  () => dispatchHint(isZh ? '复制失败' : 'Copy failed', 'warning'),
                );
              }}
            >
              {isZh ? '复制路径' : 'Copy path'}
            </button>
          </div>
        )}
      </div>
    );
  }

  const modeOptions: Array<[DiffViewMode, string, string]> = (() => {
    const isSvg = previewKind === 'svg';
    const sourceLabel = isZh ? '源码' : 'Code';
    const sourceTip = isSvg
      ? (isZh ? '切换到 SVG 源码（Monaco），可查看并复制' : 'Switch to SVG source in Monaco')
      : canRenderDiff
        ? (isZh ? '整文件源码：红删行插在改动处，绿增行标在正文里' : 'Full-file editor: deleted lines above the change, added lines highlighted in place')
        : (isZh ? '普通单文件预览：默认模式，不挤右侧空间' : 'Single-file preview: the default that leaves room on the right');
    /* SVG 只保留「预览 | 源码」— 整文件新增时单窗/左右意义不大, 工具条也更干净.
     * 普通代码仍保留单窗/左右 diff. */
    if (isSvg) {
      const renderOpt: [DiffViewMode, string, string] = [
        'render',
        isZh ? '预览' : 'Preview',
        isZh ? '在同一编辑器里预览这个 SVG（默认）' : 'Preview this SVG in the same editor (default)',
      ];
      return [renderOpt, ['preview', sourceLabel, sourceTip]];
    }
    const base: Array<[DiffViewMode, string, string]> = [
      ['preview', sourceLabel, sourceTip],
    ];
    if (canRenderDiff) {
      base.push([
        'side-by-side',
        isZh ? '分栏' : 'Split',
        isZh ? '左：改前（红）→ 右：改后（绿）' : 'Left: before (red) → Right: after (green)',
      ]);
    }
    if (canPreview) {
      /* 每个可预览类型的 hover 提示不同 — HTML 是 iframe, markdown/mermaid 走 renderer, csv/json 走表格/pretty. */
      const RENDER_TIP_ZH: Record<string, string> = {
        html: '在同一面板里以 iframe 沙盒渲染这个 HTML',
        markdown: '在同一面板里以富文本 (GFM / mermaid / katex) 渲染这个 Markdown',
        json: '在同一面板里格式化并高亮这个 JSON',
        csv: '在同一面板里以表格展示这个 CSV/TSV',
        mermaid: '在同一面板里渲染这个 Mermaid 图',
      };
      const RENDER_TIP_EN: Record<string, string> = {
        html: 'Render this HTML in a sandboxed iframe right here',
        markdown: 'Render this Markdown (GFM / mermaid / KaTeX) right here',
        json: 'Format and highlight this JSON right here',
        csv: 'Show this CSV/TSV as a table right here',
        mermaid: 'Render this Mermaid diagram right here',
      };
      const tip = (isZh ? RENDER_TIP_ZH : RENDER_TIP_EN)[previewKind as string]
        ?? (isZh ? '在同一面板里就地渲染这个文件' : 'Render this file right here');
      base.push(['render', isZh ? '渲染' : 'Render', tip]);
    }
    return base;
  })();
  return (
    <div className="sfc-code-wrap">
      {(hasDiff || canPreview || !!content) && (
        /* diff 导航条 + per-hunk review summary + 批量按钮 + Render 视图切换 + 复制/截断提示.
         * 无 diff 的普通源码也渲染 (只有复制按钮 + 可能的截断提示), 保证"复制内容"入口全类型可达. */
        <div
          ref={diffbarRef}
          className={`sfc-code-diffbar${isRenderMode ? ' sfc-code-diffbar--render' : ''}${hasDiff ? ' sfc-code-diffbar--hasdiff' : ''}${
            !hasDiff && !truncatedInfo && reviewSummary.total === 0 ? ' sfc-code-diffbar--float' : ''
          }`}
        >
          {hasDiff && (
          <span
            className={`sfc-code-diffbar__label sfc-code-diffbar__label--${diffFileKind}`}
            title={diffFileKind === 'new'
              ? (isZh ? '这是新增文件：旧版本为空，所以当前文件每一行都是新增，显示为绿色是符合 diff 语义的。' : 'New file: the previous version is empty, so every line is an addition (green).')
              : diffFileKind === 'deleted'
                ? (isZh ? '这是删除文件：新版本为空，删除内容显示为红色。' : 'Deleted file: the new version is empty; deleted lines are red.')
                : (isZh ? '只对真实新增/删除区域染色，未修改区域保持当前主题背景。' : 'Only real add/remove regions are colored; unchanged regions keep the theme background.')}
          >
            <span className="sfc-code-diffbar__badge" aria-hidden="true">
              {diffFileKind === 'new' ? (
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
                  <path d="M4.2 2.5h5.1L12 5.2v8.3H4.2V2.5Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
                  <path d="M9.2 2.5V5h2.7" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
                  <path d="M8 8v3.2M6.4 9.6H9.6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
                </svg>
              ) : diffFileKind === 'deleted' ? (
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
                  <path d="M4.2 2.5h5.1L12 5.2v8.3H4.2V2.5Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
                  <path d="M9.2 2.5V5h2.7" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
                  <path d="M6.4 9.6H9.6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
                  <path d="M4.2 2.5h5.1L12 5.2v8.3H4.2V2.5Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
                  <path d="M9.2 2.5V5h2.7" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
                  <path d="M6.5 8.2h3M6.5 10.4h2.2" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
                </svg>
              )}
            </span>
            {diffBarTitle}
          </span>
          )}
          {/* ??? / ? 1 ?????? ? n/n ? ? ???? SVG ??????? */}
          {hasDiff && !isRenderMode && navTotal > 1 && (
          <button
            type="button"
            className="sfc-code-diffbar__btn"
            onClick={() => jumpToHunk(hunkIdx - 1)}
            title={isZh ? '上一处改动 (Shift+F7)' : 'Previous change (Shift+F7)'}
            aria-label={isZh ? '上一处改动' : 'Previous change'}
            disabled={navTotal <= 0}
          >‹</button>
          )}
          {hasDiff && !isRenderMode && navTotal > 1 && (
          <span className="sfc-code-diffbar__pos">
            {navTotal > 0 ? Math.min(hunkIdx + 1, navTotal) : 0} / {navTotal}
          </span>
          )}
          {hasDiff && !isRenderMode && navTotal > 1 && (
          <button
            type="button"
            className="sfc-code-diffbar__btn"
            onClick={() => jumpToHunk(hunkIdx + 1)}
            title={isZh ? '下一处改动 (F7)' : 'Next change (F7)'}
            aria-label={isZh ? '下一处改动' : 'Next change'}
            disabled={navTotal <= 0}
          >›</button>
          )}
          {((editHunks?.length ?? 0) > 0 || canPreview) && renderInSlot(
            <span
              className={`sfc-code-diffbar__modes${modeSlot ? ' sfc-code-diffbar__modes--inbar' : ''}`}
              role="group"
              aria-label={isZh ? 'Diff 展示模式' : 'Diff view mode'}
            >
              {modeOptions.map(([mode, label, title]) => (
                <button
                  key={mode}
                  type="button"
                  className={`sfc-code-diffbar__mode${diffViewMode === mode ? ' is-active' : ''}`}
                  onClick={() => setDiffViewMode(mode)}
                  disabled={
                    /* preview 永远可用; render 需要有内容; inline/split 需要能算 diff. */
                    mode === 'preview'
                      ? false
                      : mode === 'render'
                        ? !content
                        : !canRenderDiff
                  }
                  aria-pressed={diffViewMode === mode}
                  title={title}
                >
                  {label}
                </button>
              ))}
            </span>
          )}
          {/* spacer ??? ? ? nav ??, ? chips/bulk ??. ?????????
           *   全挤左边, 右侧空一大段, 窄宽时反而是左半段先撞墙. */}
          <span className="sfc-code-diffbar__spacer" />
          {diffTotals && (
            <span
              className="sfc-code-diffbar__stat"
              title={isZh ? `本次改动新增 ${diffTotals.add} 行、删除 ${diffTotals.del} 行` : `${diffTotals.add} added, ${diffTotals.del} removed`}
            >
              <span className="sfc-code-diffbar__stat-add">+{diffTotals.add}</span>
              <span className="sfc-code-diffbar__stat-del">−{diffTotals.del}</span>
            </span>
          )}
          {truncatedInfo && (
            <span
              className="sfc-code-diffbar__truncated"
              title={isZh ? `文件约 ${(truncatedInfo.totalChars / 1024 / 1024).toFixed(1)}MB, 为保持流畅仅加载前 ${truncatedInfo.shownLines.toLocaleString()} 行 (共 ${truncatedInfo.totalLines.toLocaleString()} 行)。完整内容请用外部应用打开。` : `File is ~${(truncatedInfo.totalChars / 1024 / 1024).toFixed(1)}MB; only the first ${truncatedInfo.shownLines.toLocaleString()} of ${truncatedInfo.totalLines.toLocaleString()} lines are loaded to stay responsive. Open in an external app for the full content.`}
            >
              {isZh ? `已截断 ${truncatedInfo.shownLines.toLocaleString()} / ${truncatedInfo.totalLines.toLocaleString()} 行` : `Truncated ${truncatedInfo.shownLines.toLocaleString()} / ${truncatedInfo.totalLines.toLocaleString()} lines`}
            </span>
          )}
          {canEdit && dirty && (
            <button
              type="button"
              className="sfc-code-diffbar__bulk sfc-code-diffbar__bulk--save"
              onClick={() => { void saveNowRef.current(); }}
              disabled={saving}
              title={isZh ? '保存 (⌘S)' : 'Save (⌘S)'}
              aria-label={isZh ? '保存' : 'Save'}
            >
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 2.5h7.5L13.5 5.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z" />
                <path d="M5.5 2.5v3.5h5V2.5M5.5 13.5v-3.5h5v3.5" />
              </svg>
              <span className="sfc-code-diffbar__bulk-label">{isZh ? '保存' : 'Save'}</span>
            </button>
          )}
          {!!content && !isRenderMode && (
            <button
              type="button"
              className="sfc-code-diffbar__bulk"
              onClick={copyAll}
              title={isZh ? '复制文件全部内容到剪贴板' : 'Copy the whole file content to the clipboard'}
              aria-label={isZh ? '复制内容' : 'Copy content'}
            >
              <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />
                <path d="M2.5 9.5V3a1 1 0 0 1 1-1H9" />
              </svg>
              <span className="sfc-code-diffbar__bulk-label">{isZh ? '复制' : 'Copy'}</span>
            </button>
          )}
          {/* per-hunk review chips + bulk ? ? editHunks ???? SVG ?????????/??? */}
          {reviewSummary.total > 0 && (
            <>
              <span className="sfc-code-diffbar__divider" aria-hidden="true" />
              <span className="sfc-code-diffbar__chips" role="status" aria-label={isZh ? 'hunk 审批状态' : 'Hunk review status'}>
                {reviewSummary.pending > 0 && (
                  <span className="sfc-code-diffbar__chip sfc-code-diffbar__chip--pending" title={isZh ? `待审 ${reviewSummary.pending}` : `${reviewSummary.pending} pending`}>
                    <span className="sfc-code-diffbar__chip-label">{isZh ? '待审' : 'Pending'}</span>{' '}
                    <span className="sfc-code-diffbar__chip-num">{reviewSummary.pending}</span>
                  </span>
                )}
                {reviewSummary.accepted > 0 && (
                  <span className="sfc-code-diffbar__chip sfc-code-diffbar__chip--ok" title={isZh ? `已接受 ${reviewSummary.accepted}` : `${reviewSummary.accepted} accepted`}>
                    <span className="sfc-code-diffbar__chip-icon" aria-hidden="true">✓</span>
                    <span className="sfc-code-diffbar__chip-num">{reviewSummary.accepted}</span>
                  </span>
                )}
                {reviewSummary.rejected > 0 && (
                  <span className="sfc-code-diffbar__chip sfc-code-diffbar__chip--rej" title={isZh ? `已回退 ${reviewSummary.rejected}` : `${reviewSummary.rejected} reverted`}>
                    <span className="sfc-code-diffbar__chip-icon" aria-hidden="true">✗</span>
                    <span className="sfc-code-diffbar__chip-num">{reviewSummary.rejected}</span>
                  </span>
                )}
              </span>
              {reviewSummary.pending > 0 && (
                <>
                  <button
                    type="button"
                    className="sfc-code-diffbar__bulk sfc-code-diffbar__bulk--accept"
                    onClick={acceptAll}
                    title={isZh ? '接受所有未审 hunk (不改文件, 仅标记)' : 'Accept all pending hunks (marks only — file is untouched)'}
                    aria-label={isZh ? '接受全部' : 'Accept all'}
                  >
                    <span className="sfc-code-diffbar__bulk-icon" aria-hidden="true">✓</span>
                    <span className="sfc-code-diffbar__bulk-label">{isZh ? '接受全部' : 'Accept all'}</span>
                  </button>
                  <button
                    type="button"
                    className="sfc-code-diffbar__bulk sfc-code-diffbar__bulk--reject"
                    onClick={rejectAll}
                    title={reviewSummary.hasTruncated
                      ? (isZh ? '回退所有未审 hunk (截断的 hunk 会跳过)' : 'Revert all pending hunks (truncated hunks are skipped)')
                      : (isZh ? '回退所有未审 hunk (物理还原文件)' : 'Revert all pending hunks (restores the file on disk)')}
                    aria-label={isZh ? '全部回退' : 'Revert all'}
                  >
                    <span className="sfc-code-diffbar__bulk-icon" aria-hidden="true">✗</span>
                    <span className="sfc-code-diffbar__bulk-label">{isZh ? '全部回退' : 'Revert all'}</span>
                  </button>
                </>
              )}
            </>
          )}


        </div>
      )}
      {isRenderMode && previewKind ? (
        /* 就地渲染: iframe (html/svg) / Markdown 组件 (md/mermaid) / 表格 (csv/tsv) / pretty json ...
         * 加类型看 CodePreviewPane.tsx. Monaco 编辑器切到 render 时会 dispose (editorModeKey 触发), 不留残余. */
        <CodePreviewPane
          kind={previewKind}
          path={path}
          content={content}
          workspacePath={workspacePathForPreview}
          isZh={isZh}
        />
      ) : isSideBySideMode ? (
        <div
          ref={containerRef}
          className="sfc-code-sbs"
        >
          <div className="sfc-code-sbs__pane">
            <div className="sfc-code-sbs__hdr">{isZh ? '改前' : 'Before'}</div>
            <div ref={sbsOrigContainerRef} className="sfc-code-sbs__editor" />
          </div>
          <div className="sfc-code-sbs__pane">
            <div className="sfc-code-sbs__hdr">{isZh ? '改后' : 'After'}</div>
            <div ref={sbsModContainerRef} className="sfc-code-sbs__editor" />
          </div>
        </div>
      ) : (
        <div
          ref={containerRef}
          className="sfc-code"
          style={{ width: '100%', height: '100%', flex: '1 1 auto', minWidth: 0, minHeight: 0, overflow: 'hidden' }}
        />
      )}

    </div>
  );
};

export default CodeSurfaceViewer;
