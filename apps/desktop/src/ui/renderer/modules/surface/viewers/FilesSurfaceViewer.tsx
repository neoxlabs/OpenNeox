import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FileExplorer, { type FileExplorerHandle } from '../../explorer/components/FileExplorer';
import { openSurfaceFromPath } from '../../../state/openSurfaceFromPath';
import { surfaceKindForPath, patchSurfaceMetadata, type Surface } from '../../../state/surfaceStore';
import { renderSurfaceViewer } from '../SurfacePanel';
import { useI18n } from '../../../hooks/useI18n';
import { IconPanelLeft, IconPanelRight, IconChevronLeft, IconChevronRight, IconRefresh, IconMoreH } from '../../shell/shellIcons';
import { ContextMenu, type ContextMenuItem } from '../../../components/ContextMenu';
import { confirmAsync, promptAsync } from '../../../components/confirmEvents';
import { fileSystemService } from '../../../services/fileSystemService';
import { revealInFileManagerLabel } from '../../../utils/fileManagerLabels';
import { fuzzyMatch } from '../../../../../ide/semantic/fuzzy/FuzzyMatcher.js';
import { resolveWorkspacePath, relativeToWorkspace, filePathKey } from '../../../utils/pathUtils';
import { pickFileIcon } from '../../../components/FileTypeIcons';
import Icons from '../../../components/Icons';
import { NeoxIllus } from '../../../media/illus';
import { kbd } from '../../../utils/keymap';
import { dispatchHint } from '../../../components/notifyEvents';

interface Props {
  surface: Surface;
  workspacePath?: string;
  sessionId: string;
}

/** 历史栈上限 —— 只是防无限增长, 正常翻代码远到不了。 */
const HISTORY_MAX = 50;
/** ⌘P 结果条数 —— 再多用户也不会往下看, 只会拖慢渲染。 */
const QUICK_OPEN_LIMIT = 60;
/** basename 命中比路径命中更值钱 (跟 CommandPalette 同一个常数)。 */
const BASENAME_BONUS = 60;

interface FileEntry { path: string; basename: string; abs: string }
interface FilesNav { stack: string[]; idx: number }

function normalizeNav(raw: { stack?: unknown; idx?: unknown } | null | undefined, workspacePath?: string): FilesNav | null {
  if (!raw || !Array.isArray(raw.stack) || raw.stack.length === 0) return null;
  const stack = raw.stack
    .map((p) => (typeof p === 'string' ? resolveWorkspacePath(p, workspacePath) : ''))
    .filter(Boolean);
  if (stack.length === 0) return null;
  const idxRaw = typeof raw.idx === 'number' && Number.isFinite(raw.idx) ? raw.idx : stack.length - 1;
  const idx = Math.min(Math.max(-1, Math.floor(idxRaw)), stack.length - 1);
  return { stack, idx };
}

function loadFilesNav(surface: Surface, workspacePath?: string): FilesNav {
  const fromMeta = normalizeNav(surface.metadata?.previewNav as FilesNav | undefined, workspacePath);
  if (fromMeta) return fromMeta;
  return { stack: [], idx: -1 };
}

export const FilesSurfaceViewer: React.FC<Props> = ({ surface, workspacePath, sessionId }) => {
  const { isZh } = useI18n();

  /* 导航栈单源 —— selected 从它派生而不是各自 setState, 否则"当前文件"和"历史位置"
   * 会漂开 (点了树但没进栈 / 后退了但 selected 没跟着变)。
   * 切走 Surface 会卸载本组件 → 必须落 surface.metadata + localStorage, 否则回来空白. */
  const [nav, setNav] = useState<FilesNav>(() => loadFilesNav(surface, workspacePath));
  const selected = nav.idx >= 0 ? (nav.stack[nav.idx] ?? null) : null;
  const canBack = nav.idx > 0;
  const canForward = nav.idx >= 0 && nav.idx < nav.stack.length - 1;
  const navWriteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* 工作区换了 → 重新 hydrate (别把上一个项目的路径带过来) */
  useEffect(() => {
    setNav(loadFilesNav(surface, workspacePath));
    // 只跟工作区走; surface.id 稳定 (singleton)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath, surface.id]);

  /* SQLite restore 往往晚于首渲 —— 本地还空时吃迟到的 metadata.previewNav */
  useEffect(() => {
    const fromMeta = normalizeNav(surface.metadata?.previewNav as FilesNav | undefined, workspacePath);
    if (!fromMeta) return;
    setNav((prev) => (prev.stack.length > 0 ? prev : fromMeta));
  }, [surface.metadata?.previewNav, workspacePath]);

  useEffect(() => {
    const payload = { stack: nav.stack, idx: nav.idx };
    if (navWriteTimer.current) clearTimeout(navWriteTimer.current);
    navWriteTimer.current = setTimeout(() => {
      if (!sessionId || !surface.id) return;
      const cur = surface.metadata?.previewNav as FilesNav | undefined;
      if (cur
        && cur.idx === payload.idx
        && Array.isArray(cur.stack)
        && cur.stack.length === payload.stack.length
        && cur.stack.every((p, i) => filePathKey(p) === filePathKey(payload.stack[i]!))) {
        return;
      }
      patchSurfaceMetadata(sessionId, surface.id, { previewNav: payload });
    }, 120);
    return () => {
      if (navWriteTimer.current) clearTimeout(navWriteTimer.current);
    };
  }, [nav, sessionId, surface.id, workspacePath, surface.metadata?.previewNav]);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const searchSeq = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const explorerRef = useRef<FileExplorerHandle>(null);

  /* ⌘P 快速切换 */
  const [quickOpen, setQuickOpen] = useState(false);
  const [qoQuery, setQoQuery] = useState('');
  const [qoIdx, setQoIdx] = useState(0);
  const [allFiles, setAllFiles] = useState<FileEntry[] | null>(null);
  const qoInputRef = useRef<HTMLInputElement>(null);
  const qoMouseMoved = useRef(false);

  /* ---------- 导航 ---------- */

  /** 打开一个文件并入栈。前进分支在新导航时截断 —— 浏览器语义。 */
  const navigate = useCallback((p: string) => {
    const abs = resolveWorkspacePath(p, workspacePath);
    if (!abs) return;
    setNav((prev) => {
      const cur = prev.idx >= 0 ? (prev.stack[prev.idx] ?? '') : '';
      if (cur && filePathKey(cur) === filePathKey(abs)) return prev;
      const next = [...prev.stack.slice(0, prev.idx + 1), abs];
      const overflow = Math.max(0, next.length - HISTORY_MAX);
      const stack = overflow ? next.slice(overflow) : next;
      return { stack, idx: stack.length - 1 };
    });
  }, [workspacePath]);
  /* idx === -1 是"关掉预览了"(预览头的 ×)。从那儿按 ⌘[ 该回到刚才看的那个,
   * 而不是没反应 —— 否则关掉预览就等于把历史丢了。 */
  const goBack = useCallback(() => setNav((p) => {
    if (p.idx === -1) return p.stack.length > 0 ? { ...p, idx: p.stack.length - 1 } : p;
    return p.idx > 0 ? { ...p, idx: p.idx - 1 } : p;
  }), []);
  const goForward = useCallback(
    () => setNav((p) => (p.idx < p.stack.length - 1 ? { ...p, idx: p.idx + 1 } : p)),
    [],
  );

  /* ---------- 树里的搜索 (ripgrep) ---------- */

  /* 250ms 防抖。seq 用来丢弃过期响应: 打字快时后发的请求可能先回,
   * 不比对 seq 会出现"结果闪回上一个关键词"。 */
  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits([]); setSearching(false); return; }
    const mine = ++searchSeq.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const api = (window as any)?.neox;
        const res = await api?.searchFiles?.(q, { maxResults: 300 });
        if (mine !== searchSeq.current) return;
        /* file:search-files 返回的是 { file, type } 且 file 是**相对**工作区的路径
         * (rg 以 workspace 为 cwd 跑 --files)。这里统一成绝对路径, 下游预览/开 tab
         * 都按绝对路径走。之前当成字符串数组直接 .split, 一搜索整块就白屏。 */
        const raw: Array<{ file?: string; type?: string } | string> = Array.isArray(res?.files) ? res.files : [];
        setHits(raw
          .map((it) => (typeof it === 'string' ? it : String(it?.file ?? '')))
          .filter(Boolean)
          .map((rp) => resolveWorkspacePath(rp, workspacePath)));
      } catch {
        if (mine === searchSeq.current) setHits([]);
      } finally {
        if (mine === searchSeq.current) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, workspacePath]);

  /* ---------- ⌘P 全量文件 (懒加载一次) ---------- */

  const ensureFileList = useCallback(async () => {
    if (allFiles) return;
    try {
      const api = (window as any)?.neox;
      const res = await api?.semanticListFiles?.({ maxResults: 50_000 });
      const raw: Array<{ file?: string; path?: string } | string> = Array.isArray(res?.files) ? res.files : [];
      const list: FileEntry[] = raw
        .map((it) => (typeof it === 'string' ? it : String(it?.file ?? it?.path ?? '')))
        .filter(Boolean)
        .map((rp) => {
          const abs = resolveWorkspacePath(rp, workspacePath);
          const relRaw = relativeToWorkspace(abs, workspacePath);
          const rel = (relRaw === '.' ? abs.split(/[/\\]/).pop() || abs : relRaw).replace(/\\/g, '/');
          return { path: rel, basename: abs.split(/[/\\]/).pop() || abs, abs };
        });
      setAllFiles(list);
    } catch {
      setAllFiles([]);   /* 失败也要落地, 否则每次开浮层都重试一遍 */
    }
  }, [allFiles, workspacePath]);

  const openQuickOpen = useCallback((prefill = '') => {
    setQoQuery(prefill);
    setQoIdx(0);
    qoMouseMoved.current = false;
    setQuickOpen(true);
    void ensureFileList();
    /* 等浮层挂上去再 focus, 否则 ref 还是 null */
    setTimeout(() => qoInputRef.current?.focus(), 0);
  }, [ensureFileList]);

  /** 「打开文件」—— 走系统选择器, 挑哪个文件不受工作区限制 (跟源码/表格 home 同一套)。 */
  const openViaDialog = useCallback(async () => {
    const api = (window as any).neox;
    if (!api?.openFileDialog || !sessionId) return;
    const picked = await api.openFileDialog({ defaultPath: workspacePath });
    if (picked) openSurfaceFromPath({ sessionId, path: picked, workspacePath });
  }, [sessionId, workspacePath]);

  const createNewFile = useCallback(async () => {
    if (!sessionId || !workspacePath) return;
    const api = (window as any).neox;
    const writer = api?.surfaceWriteFile ?? api?.writeFile;
    const reader = api?.surfaceReadFile ?? api?.readFile;
    if (!writer) return;
    /* 挑一个没被占的名字 —— 读得到就说明已存在, 往后顺延 */
    let abs = '';
    for (let i = 1; i <= 50; i++) {
      const candidate = resolveWorkspacePath(`untitled-${i}.txt`, workspacePath);
      let taken = false;
      try {
        const r = await reader?.(candidate, { workspacePath });
        taken = !!r && r.success !== false;
      } catch { taken = false; }
      if (!taken) { abs = candidate; break; }
    }
    if (!abs) return;
    try {
      const res = await writer(abs, '', { workspacePath });
      if (res && res.success === false) throw new Error(String(res.error || 'write failed'));
      openSurfaceFromPath({ sessionId, path: abs, workspacePath });
    } catch (err) {
      const detail = String((err as Error)?.message ?? err).slice(0, 120);
      dispatchHint(isZh ? `新建文件失败：${detail}` : `Could not create file: ${detail}`, 'warning');
    }
  }, [sessionId, workspacePath, isZh]);

  /* 匹配: basename / 全路径双打分取高者 —— 跟 CommandPalette 同策略, 让
   * "surface/Files" 这种路径分段查询也可用。 */
  const qoResults = useMemo<FileEntry[]>(() => {
    if (!allFiles) return [];
    const q = qoQuery.trim();
    if (!q) return allFiles.slice(0, QUICK_OPEN_LIMIT);
    const scored: Array<{ f: FileEntry; score: number }> = [];
    for (const f of allFiles) {
      const byName = fuzzyMatch(q, f.basename);
      const byPath = fuzzyMatch(q, f.path);
      const nameScore = Number.isFinite(byName.score) ? byName.score + BASENAME_BONUS : -Infinity;
      const pathScore = Number.isFinite(byPath.score) ? byPath.score : -Infinity;
      const best = Math.max(nameScore, pathScore);
      if (best === -Infinity) continue;
      scored.push({ f, score: best });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, QUICK_OPEN_LIMIT).map((s) => s.f);
  }, [allFiles, qoQuery]);

  /* 换关键词回到第一条; 同时防越界 —— 结果集变短时旧 idx 会指向不存在的项, 回车就打不开。 */
  useEffect(() => { setQoIdx(0); qoMouseMoved.current = false; }, [qoQuery]);
  useEffect(() => {
    setQoIdx((i) => (i >= qoResults.length ? Math.max(0, qoResults.length - 1) : i));
  }, [qoResults.length]);

  const commitQuickOpen = useCallback((f: FileEntry | undefined, asTab: boolean) => {
    if (!f) return;
    setQuickOpen(false);
    if (asTab) { if (sessionId) openSurfaceFromPath({ sessionId, path: f.abs, workspacePath }); }
    else navigate(f.abs);
  }, [navigate, sessionId, workspacePath]);

  /* ---------- 快捷键 ---------- */

  /* 挂 window 但用可见性把关: 同时存在多个 files surface 时, 只有真正显示的那个响应
   * (隐藏的 tab offsetParent 为 null)。⌘K/⌘N 是全局占用的, 这里只取 ⌘P 和 ⌘[ / ⌘]。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = rootRef.current;
      if (!el || el.offsetParent === null) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === 'p' || e.key === 'P') { e.preventDefault(); openQuickOpen(); }
      else if (e.key === '[') { e.preventDefault(); goBack(); }
      else if (e.key === ']') { e.preventDefault(); goForward(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openQuickOpen, goBack, goForward]);

  /* ---------- 布局 ---------- */

  const preview = useMemo<Surface | null>(() => {
    if (!selected) return null;
    const title = selected.split(/[/\\]/).filter(Boolean).pop() || selected;
    return {
      id: `files-preview:${filePathKey(selected) || selected}`,
      kind: surfaceKindForPath(selected),
      source: { type: 'file', path: selected },
      title,
      pinned: false,
      createdAt: 0,
      updatedAt: 0,
      metadata: { ephemeralPreview: true, workspacePath },
    };
  }, [selected, workspacePath]);

  const [fileMenu, setFileMenu] = useState<{ x: number; y: number } | null>(null);
  const fileActionItems = useCallback((p: string): ContextMenuItem[] => {
    const name = p.split(/[/\\]/).filter(Boolean).pop() || p;
    const fail = (what: string) => (e: unknown) =>
      dispatchHint(`${what}: ${String((e as Error)?.message ?? e).slice(0, 120)}`, 'warning');
    return [
      {
        id: 'reveal',
        label: revealInFileManagerLabel(isZh),
        onClick: () => { void fileSystemService.revealInFinder(p).catch(fail(isZh ? '无法打开文件管理器' : 'Could not open file manager')); },
      },
      {
        id: 'copy-path',
        label: isZh ? '复制路径' : 'Copy path',
        onClick: () => { void navigator.clipboard.writeText(p).then(
          () => dispatchHint(isZh ? '已复制路径' : 'Path copied', 'success'),
          () => dispatchHint(isZh ? '复制失败' : 'Copy failed', 'warning')); },
      },
      {
        id: 'rename',
        label: isZh ? '重命名' : 'Rename',
        onClick: () => { void (async () => {
          const next = await promptAsync({
            title: isZh ? '重命名' : 'Rename',
            message: p,
            defaultValue: name,
            confirmLabel: isZh ? '重命名' : 'Rename',
          });
          if (!next || next === name) return;
          try {
            const newPath = await fileSystemService.rename(p, next);
            setNav((current) => ({
              ...current,
              stack: current.stack.map((entry) => filePathKey(entry) === filePathKey(p) ? newPath : entry),
            }));
            setAllFiles(null);
          } catch (e) { fail(isZh ? '重命名失败' : 'Rename failed')(e); }
        })(); },
      },
      {
        id: 'terminal',
        label: isZh ? '在终端中打开' : 'Open in terminal',
        onClick: () => { void fileSystemService.openInTerminal(p).catch(fail(isZh ? '无法打开终端' : 'Could not open terminal')); },
      },
      { separator: true } as ContextMenuItem,
      {
        id: 'trash',
        label: isZh ? '移到回收站' : 'Move to Trash',
        destructive: true,
        onClick: () => { void (async () => {
          const ok = await confirmAsync({
            title: isZh ? '移到回收站' : 'Move to Trash',
            message: isZh ? `确定把「${name}」移到回收站？` : `Move “${name}” to Trash?`,
            description: p,
            variant: 'danger',
            confirmLabel: isZh ? '移到回收站' : 'Move to Trash',
          });
          if (!ok) return;
          try {
            await fileSystemService.trash(p);
            setNav((current) => ({
              stack: current.stack.filter((entry) => filePathKey(entry) !== filePathKey(p)),
              idx: -1,
            }));
            setAllFiles(null);
          } catch (e) { fail(isZh ? '删除失败' : 'Delete failed')(e); }
        })(); },
      },
    ];
  }, [isZh]);

  const pinAsTab = useCallback((path: string) => {
    if (!sessionId) return;
    const abs = resolveWorkspacePath(path, workspacePath);
    openSurfaceFromPath({ sessionId, path: abs, workspacePath });
  }, [sessionId, workspacePath]);

  const isWorkspaceRoot = useCallback((p: string) => {
    if (!workspacePath || !p) return false;
    return filePathKey(p) === filePathKey(workspacePath);
  }, [workspacePath]);


  const rel = useCallback(
    (p: string) => {
      if (!workspacePath) return p;
      return relativeToWorkspace(p, workspacePath).replace(/\\/g, '/');
    },
    [workspacePath],
  );


  if (!workspacePath) {
    return (
      <div className="sfc-empty">
        {isZh ? '当前会话还没有关联项目 —— 先打开一个项目再用文件管理器。'
              : 'This session has no project yet — open a project first.'}
      </div>
    );
  }

  /* 面包屑: 最后一段是文件名(不可点), 前面每段目录都可点 —— 点了用 ⌘P 浮层
   * 列出该目录下的文件, 解决"同目录还有什么"。 */
  const relPath = selected ? rel(selected) : '';
  const segs = relPath ? relPath.split('/') : [];
  const dirSegs = segs.slice(0, -1);

  return (
    <div className="sfc-files sfc-files--v3" ref={rootRef}>
      <aside className="sfc-files__tree">
        <button type="button" className="sfc-files__tree-search" onClick={() => openQuickOpen()}>
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3 3" /></svg>
          <span>{isZh ? '搜文件' : 'Find file'}</span>
          <kbd>{kbd('mod+p')}</kbd>
        </button>
        <FileExplorer
          ref={explorerRef}
          workspacePath={workspacePath}
          selectedFile={selected ?? null}
          onSelectFile={(p, isDir) => { if (!isDir) navigate(p); }}
          onOpenFile={(p) => pinAsTab(p)}
          singleClickOpens={false}
          respondsToGlobalActions={false}
          hideHeader
          className="sfc-files__tree-body"
        />
      </aside>
      <div className="sfc-files__preview">
        {preview && (
          <div className="sfc-files__preview-bar">
            <button
              type="button"
              className="sfc-files__panelbtn"
              disabled={!canBack}
              onClick={goBack}
              title={isZh ? `后退 (${kbd('mod+[')})` : `Back (${kbd('mod+[')})`}
            >
              <IconChevronLeft />
            </button>
            <button
              type="button"
              className="sfc-files__panelbtn"
              disabled={!canForward}
              onClick={goForward}
              title={isZh ? `前进 (${kbd('mod+]')})` : `Forward (${kbd('mod+]')})`}
            >
              <IconChevronRight />
            </button>
            <span className="sfc-files__preview-name">{preview.title}</span>
            <span className="sfc-files__preview-path" title={selected ?? ''}>
              {selected ? relativeToWorkspace(selected, workspacePath) : ''}
            </span>
            <div className="sfc-files__preview-actions">
              <button
                type="button"
                className="sfc-files__panelbtn"
                onClick={(e) => setFileMenu({ x: e.clientX, y: e.clientY })}
                title={isZh ? '文件操作' : 'File actions'}
              >
                <IconMoreH />
              </button>
              <button
                type="button"
                className="sfc-files__panelbtn"
                /* 回空态: 只把游标移出栈, 历史留着 —— ⌘[ 能回到刚才那个 (见 goBack) */
                onClick={() => setNav((p) => ({ ...p, idx: -1 }))}
                title={isZh ? '关闭预览' : 'Close preview'}
              >
                <Icons.X />
              </button>
            </div>
          </div>
        )}
        <div className="sfc-files__preview-body">
          {preview ? (
            renderSurfaceViewer(preview, workspacePath, true, isZh, sessionId)
          ) : (
            <div className="sfc-files__empty">
              <img
                className="sfc-files__empty-art"
                src={NeoxIllus.files}
                alt=""
                aria-hidden
                draggable={false}
              />
              <h3 className="sfc-files__empty-title">
                {isZh ? '还没打开文件' : 'No file open yet'}
              </h3>
              <p className="sfc-files__empty-desc">
                {isZh
                  ? `点左边一个文件就在这里看，或者 ${kbd('mod+p')} 按名字找。`
                  : `Click a file on the left to view it here, or ${kbd('mod+p')} to find by name.`}
              </p>
              <div className="sfc-files__empty-actions">
                {/* 树删了以后这里一度只剩「快速切换」—— 用户当场问"打开的按钮呢???"。
                    空态要能自己走完一整件事: 挑一个已有文件打开, 或者直接建一个新的。 */}
                <button
                  type="button"
                  className="sfc-files__empty-btn sfc-files__empty-btn--primary"
                  onClick={() => { void openViaDialog(); }}
                >
                  {isZh ? '打开文件' : 'Open file'}
                </button>
                <button
                  type="button"
                  className="sfc-files__empty-btn"
                  onClick={() => { void createNewFile(); }}
                >
                  {isZh ? '新建文件' : 'New file'}
                </button>
                <button
                  type="button"
                  className="sfc-files__empty-btn"
                  onClick={() => openQuickOpen()}
                >
                  {isZh ? `${kbd('mod+p')} 快速切换` : `${kbd('mod+p')} Quick Open`}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>


      {fileMenu && selected && (
        <ContextMenu
          position={{ x: fileMenu.x, y: fileMenu.y }}
          items={fileActionItems(selected)}
          onClose={() => setFileMenu(null)}
        />
      )}

      {/* ⌘P 快速切换 */}
      {quickOpen && (
        <>
          <div className="sfc-files__scrim" onClick={() => setQuickOpen(false)} />
          <div className="sfc-files__qo" role="dialog" aria-modal="true">
            <input
              ref={qoInputRef}
              className="sfc-files__qo-input"
              value={qoQuery}
              onChange={(e) => setQoQuery(e.target.value)}
              placeholder={isZh ? '按文件名或路径切换…' : 'Switch file by name or path…'}
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); setQuickOpen(false); }
                else if (e.key === 'ArrowDown') { e.preventDefault(); qoMouseMoved.current = false; setQoIdx((i) => Math.min(qoResults.length - 1, i + 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); qoMouseMoved.current = false; setQoIdx((i) => Math.max(0, i - 1)); }
                else if (e.key === 'Enter') {
                  e.preventDefault();
                  /* ⌘/⇧ + Enter = 开成 tab (要并排对照的); 单 Enter = 就地预览 (路过的) */
                  commitQuickOpen(qoResults[qoIdx], e.metaKey || e.ctrlKey || e.shiftKey);
                }
              }}
            />
            <div className="sfc-files__qo-list" onMouseMove={() => { qoMouseMoved.current = true; }}>
              {allFiles === null && <div className="sfc-files__hint-row">{isZh ? '加载文件列表…' : 'Loading files…'}</div>}
              {allFiles !== null && qoResults.length === 0 && (
                <div className="sfc-files__hint-row">{isZh ? '没有匹配的文件' : 'No matching files'}</div>
              )}
              {qoResults.map((f, i) => (
                <button
                  key={f.abs}
                  type="button"
                  className={`sfc-files__qo-item${i === qoIdx ? ' is-active' : ''}`}
                  onMouseEnter={() => { if (qoMouseMoved.current) setQoIdx(i); }}
                  onClick={(e) => commitQuickOpen(f, e.metaKey || e.ctrlKey || e.shiftKey)}
                  title={f.path}
                >
                  <span className="sfc-files__qo-name">{f.basename}</span>
                  <span className="sfc-files__qo-dir">{f.path.split('/').slice(0, -1).join('/')}</span>
                </button>
              ))}
            </div>
            <div className="sfc-files__qo-foot">
              {isZh ? `↑↓ 选择 · Enter 预览 · ${kbd('mod+enter')} 开成标签 · Esc 关闭`
                    : `↑↓ select · Enter preview · ${kbd('mod+enter')} open as tab · Esc close`}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default FilesSurfaceViewer;
