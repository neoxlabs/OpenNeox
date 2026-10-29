
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileTypeIcon } from '../../components/FileTypeIcon';
import { useGitState } from '../../hooks/useGitState';
import { useI18n } from '../../hooks/useI18n';
import { getAllFsEvents, type WorkspaceFsEvent } from '../../state/workspaceFsEventLog';
import { openSurfaceFromPath } from '../../state/openSurfaceFromPath';
import { getBrowserThumb } from './railBrowserThumb';
import { absoluteToAssetUrl } from '../../../shared/assetUrlPath';
import type { Surface, SurfaceKind } from '../../state/surfaceStore';

export type RailPreviewTarget =
  | { type: 'surface'; surface: Surface }
  | { type: 'action'; kind: Extract<SurfaceKind, 'git' | 'web' | 'services' | 'files'> };

export interface RailPreviewAnchor {
  rect: DOMRect;
  target: RailPreviewTarget;
}

const CARD_W = 340;
const GAP = 10;
const EDGE = 12;
const MAX_ROWS = 8;

type TaskStatus = 'running' | 'completed' | 'failed' | 'killed';
interface BackgroundTask {
  pid: number;
  command: string;
  cwd: string;
  startTime: string;
  status: TaskStatus;
  exitCode?: number;
  endTime?: string;
  kind?: string;
}

/** git status 运行时对象带 add/del, 但 GitFileStatus 类型里没声明 */
interface GitFileLike {
  path: string;
  area?: 'staged' | 'unstaged' | 'untracked' | 'conflict';
  add?: number;
  del?: number;
}

function elapsed(startTime: string, endTime?: string): string {
  const start = new Date(startTime).getTime();
  if (!Number.isFinite(start)) return '';
  const end = endTime ? new Date(endTime).getTime() : Date.now();
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m${(sec % 60).toString().padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${(m % 60).toString().padStart(2, '0')}m`;
}

function ago(ts: number, isZh: boolean): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return isZh ? '刚刚' : 'just now';
  const m = Math.floor(sec / 60);
  if (m < 60) return isZh ? `${m} 分钟前` : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return isZh ? `${h} 小时前` : `${h}h ago`;
  return isZh ? `${Math.floor(h / 24)} 天前` : `${Math.floor(h / 24)}d ago`;
}

function shortCmd(cmd: string, max = 40): string {
  const clean = (cmd || '').replace(/^cd\s+\S+\s+&&\s+/, '');
  return clean.length <= max ? clean : clean.slice(0, max - 1) + '…';
}

/** 拆成 [目录, 文件名] —— 文件名是身份, 目录只是定位 */
function splitPath(p: string, workspacePath?: string): { dir: string; base: string } {
  let rel = p || '';
  if (workspacePath && rel.startsWith(workspacePath)) rel = rel.slice(workspacePath.length);
  const parts = rel.split(/[/\\]/).filter(Boolean);
  const base = parts.pop() || rel;
  /* 目录只留最后两级: 完整路径会把这行挤没, 而"在哪个模块下"两级就够定位 */
  const dir = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/');
  return { dir, base };
}

/** 状态点。**常态(已修改)不给点** —— 一列里每行都挂一个同样的记号等于没有记号,
 *  只是噪音。只有"不寻常"的三种状态才值得占一个视觉位。 */
function areaDot(area: GitFileLike['area'], isZh: boolean): { cls: string; title: string } | null {
  switch (area) {
    case 'staged': return { cls: 'is-staged', title: isZh ? '已暂存' : 'Staged' };
    case 'untracked': return { cls: 'is-untracked', title: isZh ? '未跟踪' : 'Untracked' };
    case 'conflict': return { cls: 'is-conflict', title: isZh ? '冲突' : 'Conflict' };
    default: return null;
  }
}

function fsKindDot(kind: WorkspaceFsEvent['kind'], isZh: boolean): { cls: string; title: string } | null {
  if (kind === 'add' || kind === 'addDir') return { cls: 'is-untracked', title: isZh ? '新建' : 'Added' };
  if (kind === 'unlink' || kind === 'unlinkDir') return { cls: 'is-conflict', title: isZh ? '删除' : 'Deleted' };
  return null;
}

/** services: 只在卡片打开时轮询 */
function useRunningTasks(active: boolean): { tasks: BackgroundTask[]; loaded: boolean } {
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const list = await (window as any).neox?.listBackgroundTasks?.();
        if (cancelled) return;
        setTasks(Array.isArray(list) ? list : []);
        setLoaded(true);
      } catch {
        if (!cancelled) setLoaded(true);
      }
    };
    void pull();
    const id = window.setInterval(() => { void pull(); }, 2000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [active]);
  return { tasks, loaded };
}

const FS_NOISE_DIR = /(^|[/\\])(node_modules|\.git|dist|build|out|coverage|\.next|\.turbo|\.cache|target|Pods|vendor)([/\\]|$)/;
const FS_NOISE_BUNDLE = /\.(app|framework|dSYM|xcarchive|asar\.unpacked)[/\\]/i;
const FS_NOISE_FILE = /(\.log$|\.lock$|\.tsbuildinfo$|(^|[/\\])\.DS_Store$)/;

function isNoiseFsPath(p: string): boolean {
  return FS_NOISE_DIR.test(p) || FS_NOISE_BUNDLE.test(p) || FS_NOISE_FILE.test(p);
}

/** 浏览器缩略图: 只在卡片打开且浏览器**已经在跑**时抓一次。
 *  取消语义很重要 —— 卡片关掉后到达的结果直接丢弃, 不 setState。 */
const THUMB_LIVE_MS = 1200;

function useBrowserThumb(active: boolean, surfaceId: string | undefined, url: string): {
  thumb: string | null; pending: boolean;
} {
  const [thumb, setThumb] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!active || !surfaceId) { setThumb(null); setPending(false); return; }
    let cancelled = false;
    setPending(true);
    const pull = (fresh: boolean) => {
      void getBrowserThumb(surfaceId, url, fresh).then((d) => {
        if (cancelled) return;
        /* 抓失败保留上一帧 —— 闪回骨架屏比停在旧帧更难看 */
        if (d) setThumb(d);
        setPending(false);
      });
    };
    pull(false);
    const id = window.setInterval(() => pull(true), THUMB_LIVE_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [active, surfaceId, url]);
  return { thumb, pending };
}


/** 这些 kind 的 file 源是纯文本, 可以直接读来做预览; 二进制的 (pdf/docx/pptx/image) 不读。 */
const TEXT_PREVIEW_KINDS = new Set<SurfaceKind>(['doc', 'plan', 'todo', 'diagram', 'html', 'svg', 'code', 'diff']);
const IMAGE_PREVIEW_KINDS = new Set<SurfaceKind>(['image', 'svg']);
/** 预览读文件的上限 —— 卡片只放十来行, 读一整个 5MB 的 .md 纯属浪费 */
const EXCERPT_MAX_CHARS = 4000;
const EXCERPT_LINES = 12;
/** 流式时看的是"正在写的那几行", 取尾部 */
const TAIL_LINES = 6;

function excerptHead(text: string, lines = EXCERPT_LINES): string {
  return (text || '').split('\n').slice(0, lines).join('\n').trim();
}

function excerptTail(text: string, lines = TAIL_LINES): string {
  const all = (text || '').split('\n');
  return all.slice(Math.max(0, all.length - lines)).join('\n').trim();
}

/** 已生成多少 —— 流式期间唯一真拿得到的"进度"。没有总量, 所以**不画百分比进度条**:
 *  分母是编的, 画出来就是假信息 (本文件第 1 条约束)。只报已出的量, 它在涨就说明还活着。 */
function producedStat(text: string, isZh: boolean): string {
  const chars = (text || '').length;
  const lines = text ? text.split('\n').length : 0;
  if (!chars) return isZh ? '刚开始' : 'starting';
  return isZh ? `已生成 ${lines} 行 · ${chars} 字` : `${lines} lines · ${chars} chars`;
}

/** file 源的文本预览: 只在卡片打开、且是文本类 kind 时读一次。 */
function useFileExcerpt(active: boolean, path: string): { text: string; loaded: boolean } {
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!active || !path) { setText(''); setLoaded(false); return; }
    let cancelled = false;
    setLoaded(false);
    void (async () => {
      try {
        const api = (window as any).neox;
        const reader = api?.surfaceReadFile ?? api?.readFile;
        const res = await reader?.(path);
        if (cancelled) return;
        /* 两种返回形状都见过 (裸字符串 / {success, content}) —— 都认, 认不出就当没有 */
        const raw = typeof res === 'string' ? res : (res?.content ?? res?.data ?? '');
        setText(typeof raw === 'string' ? raw.slice(0, EXCERPT_MAX_CHARS) : '');
      } catch {
        if (!cancelled) setText('');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [active, path]);
  return { text, loaded };
}

/** 本地图片走 neox-asset 协议 (跟 ImageSurfaceViewer 同一条路) */
function localAssetUrl(p: string): string {
  return absoluteToAssetUrl(p);
}

const DIFF_PREVIEW_LINES = 200;

interface DiffLine { text: string; kind: 'add' | 'del' | 'ctx' | 'meta'; }

/** 把 unified diff 文本切成可渲染的行 —— 只取前若干行, 卡片里放不下一整个 patch */
function parseDiff(raw: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const line of (raw || '').split('\n')) {
    if (out.length >= DIFF_PREVIEW_LINES) break;
    /* 文件头那几行 (diff --git / index / +++ / ---) 对读者没有信息, 跳过 */
    if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) continue;
    if (line.startsWith('@@')) { out.push({ text: line, kind: 'meta' }); continue; }
    if (line.startsWith('+')) { out.push({ text: line.slice(1), kind: 'add' }); continue; }
    if (line.startsWith('-')) { out.push({ text: line.slice(1), kind: 'del' }); continue; }
    if (line.trim()) out.push({ text: line.replace(/^ /, ''), kind: 'ctx' });
  }
  return out;
}

function useFileDiff(cwd: string | undefined, filePath: string | null, untracked: boolean): {
  lines: DiffLine[]; loading: boolean;
} {
  const [lines, setLines] = useState<DiffLine[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!cwd || !filePath) { setLines([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        if (untracked) {
          const api = (window as any).neox;
          const reader = api?.surfaceReadFile ?? api?.readFile;
          const res = await reader?.(`${cwd}/${filePath}`);
          if (cancelled) return;
          const text = typeof res === 'string' ? res : (res?.content ?? res?.data ?? '');
          setLines(String(text || '')
            .split('\n')
            .slice(0, DIFF_PREVIEW_LINES)
            .map((t) => ({ text: t, kind: 'add' as const })));
          return;
        }
        const r = await (window as any).neox?.gitDiffFile?.(cwd, filePath, false);
        if (cancelled) return;
        const raw = typeof r === 'string' ? r : (r?.diff ?? r?.content ?? r?.data ?? '');
        setLines(parseDiff(String(raw || '')));
      } catch {
        if (!cancelled) setLines([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [cwd, filePath, untracked]);
  return { lines, loading };
}

/** 最近文件动静: 只在卡片打开时快照一次, 不订阅 (卡片生命周期就几秒) */
function useRecentFsEvents(active: boolean): WorkspaceFsEvent[] {
  return useMemo(() => {
    if (!active) return [];
    const seen = new Set<string>();
    const out: WorkspaceFsEvent[] = [];
    const all = getAllFsEvents();
    for (let i = all.length - 1; i >= 0 && out.length < 5; i--) {
      const e = all[i];
      if (seen.has(e.path)) continue;
      if (isNoiseFsPath(e.path)) continue;
      seen.add(e.path);
      out.push(e);
    }
    return out;
  }, [active]);
}

const PathCell: React.FC<{ path: string; workspacePath?: string }> = ({ path, workspacePath }) => {
  const { dir, base } = splitPath(path, workspacePath);
  return (
    <span className="atl-ctx-card__path" title={path}>
      <span className="atl-ctx-card__path-base">{base}</span>
      {dir && <span className="atl-ctx-card__path-dir">{dir}</span>}
    </span>
  );
};

const DiffPair: React.FC<{ add?: number; del?: number }> = ({ add, del }) => {
  if (!add && !del) return null;
  return (
    <span className="atl-ctx-card__diff">
      {!!add && <span className="is-add">+{add}</span>}
      {!!del && <span className="is-del">−{del}</span>}
    </span>
  );
};

interface Props {
  anchor: RailPreviewAnchor | null;
  workspacePath: string;
  railLeft: number;
  /** 点卡片里的文件要落到某条会话上 */
  sessionId: string | null;
  liveWebSurfaces: Surface[];
  onEnter: () => void;
  onLeave: () => void;
}

export const AgentTimelineContextRailPreview: React.FC<Props> = ({
  anchor, workspacePath, railLeft, sessionId, liveWebSurfaces, onEnter, onLeave,
}) => {
  const { isZh } = useI18n();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);

  const kind: SurfaceKind | null = anchor
    ? (anchor.target.type === 'surface' ? anchor.target.surface.kind : anchor.target.kind)
    : null;
  const hoverSurface = anchor && anchor.target.type === 'surface' ? anchor.target.surface : null;

  const git = useGitState(kind === 'git' ? (workspacePath || undefined) : undefined);
  const { tasks, loaded: tasksLoaded } = useRunningTasks(kind === 'services');
  const recentFiles = useRecentFsEvents(kind === 'files');
  const tabSource = hoverSurface ?? liveWebSurfaces[0] ?? null;
  const webTabs = useMemo(() => {
    const own = (tabSource?.metadata?.tabs as Array<{ id: string; url: string; title?: string }> | undefined) ?? [];
    if (own.length > 0 || hoverSurface) return own;
    /* surface 自己没记 tabs (刚建、或外置浏览器只记了地址) —— 退而用每个 web surface
     * 本身当一个页面, 至少说得出"开着哪几个", 而不是谎称一个都没有。 */
    return liveWebSurfaces
      .map((s) => ({
        id: s.id,
        url: (s.source?.type === 'url' ? s.source.url : '') || (s.metadata?.url as string | undefined) || '',
        title: s.title,
      }))
      .filter((x) => x.url || x.title);
  }, [tabSource, hoverSurface, liveWebSurfaces]);
  const webActiveId = tabSource?.metadata?.activeTabId as string | undefined;
  const webActiveUrl = webTabs.find((x) => x.id === webActiveId)?.url ?? webTabs[0]?.url ?? '';
  const { thumb: webThumb, pending: webThumbPending } = useBrowserThumb(
    kind === 'web', hoverSurface?.id ?? '__rail_web__', webActiveUrl,
  );

  /* 悬停到 Changes 卡里某一行文件时, 就地展开它的 diff (hook 无条件跑) */
  const [diffPath, setDiffPath] = useState<string | null>(null);
  useEffect(() => { setDiffPath(null); }, [anchor?.target]);
  const diffUntracked = useMemo(() => {
    if (kind !== 'git' || !diffPath) return false;
    const f = (git.files as unknown as GitFileLike[] | undefined)?.find((x) => x.path === diffPath);
    return f?.area === 'untracked';
  }, [kind, diffPath, git.files]);
  const { lines: diffLines, loading: diffLoading } = useFileDiff(
    kind === 'git' ? (workspacePath || undefined) : undefined,
    kind === 'git' ? diffPath : null,
    diffUntracked,
  );

  /* 普通 surface 的文本预览。hook 必须无条件跑, 条件全部塞进 active 参数里。 */
  const hoverPath = hoverSurface?.source.type === 'file' ? hoverSurface.source.path : '';
  const { text: fileExcerpt } = useFileExcerpt(
    !!hoverSurface && !!hoverPath && !!kind && TEXT_PREVIEW_KINDS.has(kind),
    hoverPath,
  );

  useEffect(() => {
    if (!anchor) { setHeight(0); return; }
    setHeight(cardRef.current?.getBoundingClientRect().height ?? 0);
  }, [anchor, git.files.length, tasks.length, recentFiles.length, fileExcerpt.length]);

  const pos = useMemo(() => {
    if (!anchor) return null;
    const top = Math.min(
      Math.max(EDGE, anchor.rect.top - 6),
      Math.max(EDGE, window.innerHeight - (height || 140) - EDGE),
    );
    return { top, left: Math.max(EDGE, railLeft - CARD_W - GAP) };
  }, [anchor, height, railLeft]);

  if (!anchor || !pos) return null;

  const t = anchor.target;
  const surface = t.type === 'surface' ? t.surface : null;

  /* 卡片里的文件行点了直接开那个文件, 而不是"打开 Changes 面板再自己找一遍"。
   * 删除事件那种没有文件可开的行不给点 —— 给了点不动比不给更糟。 */
  const openFile = (path: string) => {
    if (!sessionId || !path) return;
    openSurfaceFromPath({ sessionId, path, workspacePath: workspacePath || undefined });
  };

  let title = '';
  let headStat: React.ReactNode = null;
  let subline: React.ReactNode = null;
  let shot: React.ReactNode = null;
  let body: React.ReactNode = null;
  let action: React.ReactNode = null;

  /** 打开这一行背后的东西 —— 跟点击右栏那一行等价 */
  const openThis = () => {
    if (t.type === 'surface') {
      window.dispatchEvent(new CustomEvent('neox:surface-panel-open-requested', {
        detail: { sessionId, surfaceId: t.surface.id },
      }));
      return;
    }
    window.dispatchEvent(new CustomEvent('neox:open-surface', {
      detail: {
        kind: t.kind,
        title: '',
        source: { type: 'inline', content: '', mime: 'text/plain' },
        metadata: { singleton: true },
        byUser: true,
      },
    }));
  };

  if (kind === 'services') {
    const running = tasks.filter((x) => x.status === 'running' && x.kind !== 'free-shell');
    title = isZh ? '服务' : 'Services';
    headStat = tasksLoaded
      ? <span className="atl-ctx-card__stat">{isZh ? `${running.length} 个在跑` : `${running.length} running`}</span>
      : null;
    body = !tasksLoaded ? null : running.length === 0 ? (
      <div className="atl-ctx-card__empty">{isZh ? '当前没有在跑的服务' : 'Nothing running'}</div>
    ) : (
      <ul className="atl-ctx-card__list">
        {running.slice(0, MAX_ROWS).map((x) => (
          <li key={x.pid} className="atl-ctx-card__item">
            <span className="atl-ctx-card__dot is-running" aria-hidden />
            <span className="atl-ctx-card__item-main is-mono" title={x.command}>{shortCmd(x.command)}</span>
            <span className="atl-ctx-card__item-tail">
              <span className="atl-ctx-card__dim">pid {x.pid}</span>
              <span>{elapsed(x.startTime)}</span>
            </span>
          </li>
        ))}
        {running.length > MAX_ROWS && (
          <li className="atl-ctx-card__more">
            {isZh ? `还有 ${running.length - MAX_ROWS} 个` : `+${running.length - MAX_ROWS} more`}
          </li>
        )}
      </ul>
    );
  } else if (kind === 'git') {
    const files = (git.files as unknown as GitFileLike[]) ?? [];
    const totalAdd = files.reduce((s, f) => s + (f.add || 0), 0);
    const totalDel = files.reduce((s, f) => s + (f.del || 0), 0);
    title = isZh ? '改动' : 'Changes';
    headStat = <DiffPair add={totalAdd} del={totalDel} />;
    subline = (
      <div className="atl-ctx-card__meta">
        {git.branch && <span className="atl-ctx-card__branch is-mono">{git.branch}</span>}
        {git.ahead > 0 && (
          <span className="atl-ctx-card__dim" title={isZh ? '本地领先' : 'Ahead of remote'}>↑{git.ahead}</span>
        )}
        {git.behind > 0 && (
          <span className="atl-ctx-card__dim" title={isZh ? '落后远端' : 'Behind remote'}>↓{git.behind}</span>
        )}
        <span className="atl-ctx-card__dim">
          {isZh ? `${files.length} 个文件` : `${files.length} ${files.length === 1 ? 'file' : 'files'}`}
        </span>
      </div>
    );
    body = files.length === 0 ? (
      <div className="atl-ctx-card__empty">{isZh ? '工作区干净' : 'Working tree clean'}</div>
    ) : (
      <ul className="atl-ctx-card__list">
        {files.slice(0, MAX_ROWS).map((f) => {
          const dot = areaDot(f.area, isZh);
          return (
            <li
              key={f.path}
              className={`atl-ctx-card__item is-clickable${diffPath === f.path ? ' is-peeking' : ''}`}
              role="button"
              tabIndex={0}
              onMouseEnter={() => setDiffPath(f.path)}
              onFocus={() => setDiffPath(f.path)}
              onClick={() => openFile(f.path)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFile(f.path); } }}
            >
              <span className="atl-ctx-card__ficon">
                <FileTypeIcon path={f.path} size={15} />
                {dot && <span className={`atl-ctx-card__dot-badge ${dot.cls}`} title={dot.title} />}
              </span>
              <PathCell path={f.path} workspacePath={workspacePath} />
              <DiffPair add={f.add} del={f.del} />
            </li>
          );
        })}
        {files.length > MAX_ROWS && (
          <li className="atl-ctx-card__more">
            {isZh ? `还有 ${files.length - MAX_ROWS} 个文件` : `+${files.length - MAX_ROWS} files`}
          </li>
        )}
      </ul>
    );
    /* diff 就地展开 —— 拿不到内容就整块不渲染, 不摆一个空框 (本文件第 1 条约束) */
    if (diffPath && (diffLines.length > 0 || diffLoading)) {
      body = (
        <>
          {body}
          <div className="atl-ctx-diff">
            <div className="atl-ctx-diff__head">{splitPath(diffPath, workspacePath).base}</div>
            {diffLoading && diffLines.length === 0 ? (
              <div className="atl-ctx-diff__loading" aria-hidden />
            ) : (
              <pre className="atl-ctx-diff__body">
                {diffLines.map((l, i) => (
                  <span key={i} className={`atl-ctx-diff__l is-${l.kind}`}>{l.text || ' '}</span>
                ))}
              </pre>
            )}
          </div>
        </>
      );
    }
  } else if (kind === 'web') {
    const tabs = webTabs;
    const activeTabId = webActiveId;
    title = isZh ? '浏览器' : 'Browser';
    headStat = tabs.length > 0
      ? <span className="atl-ctx-card__stat">{isZh ? `${tabs.length} 个标签` : `${tabs.length} tabs`}</span>
      : null;
    const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };
    action = (
      <button type="button" className="atl-ctx-card__action" onClick={openThis}>
        {tabs.length > 0 || webThumb
          ? (isZh ? '在右栏打开浏览器' : 'Open browser')
          : (isZh ? '打开浏览器' : 'Open browser')}
      </button>
    );
    /* 缩略图只在真拿到时占位 —— 抓不到就整块不渲染, 不留一个空灰框 */
    shot = webThumb ? (
      <div className="atl-ctx-card__shot">
        <img src={webThumb} alt="" draggable={false} />
      </div>
    ) : webThumbPending && tabs.length > 0 ? (
      <div className="atl-ctx-card__shot is-loading" aria-hidden />
    ) : null;
    body = tabs.length === 0 ? (
      webThumb ? null : (
        <div className="atl-ctx-card__empty">{isZh ? '还没有打开页面' : 'No page open'}</div>
      )
    ) : (
      <ul className="atl-ctx-card__list">
        {tabs.slice(0, MAX_ROWS).map((tab) => (
          <li key={tab.id} className={`atl-ctx-card__item${tab.id === activeTabId ? ' is-active' : ''}`}>
            <span className="atl-ctx-card__ficon" aria-hidden>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><path d="M2 12h20" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              {tab.id === activeTabId && <span className="atl-ctx-card__dot-badge is-staged" />}
            </span>
            <span className="atl-ctx-card__path" title={tab.url}>
              <span className="atl-ctx-card__path-base">{tab.title || host(tab.url)}</span>
              {tab.title && <span className="atl-ctx-card__path-dir">{host(tab.url)}</span>}
            </span>
          </li>
        ))}
        {tabs.length > MAX_ROWS && (
          <li className="atl-ctx-card__more">
            {isZh ? `还有 ${tabs.length - MAX_ROWS} 个标签` : `+${tabs.length - MAX_ROWS} tabs`}
          </li>
        )}
      </ul>
    );
  } else if (kind === 'files') {
    title = isZh ? '文件' : 'Files';
    subline = workspacePath ? (
      <div className="atl-ctx-card__meta">
        <span className="atl-ctx-card__branch is-mono" title={workspacePath}>
          {splitPath(workspacePath).base}
        </span>
        <span className="atl-ctx-card__dim">{workspacePath}</span>
      </div>
    ) : null;
    body = recentFiles.length === 0 ? (
      workspacePath ? <div className="atl-ctx-card__empty">{isZh ? '本次会话还没有文件变动' : 'No file activity yet'}</div> : null
    ) : (
      <>
        <div className="atl-ctx-card__sect">{isZh ? '最近变动' : 'Recent activity'}</div>
        <ul className="atl-ctx-card__list">
          {recentFiles.map((e) => {
            const dot = fsKindDot(e.kind, isZh);
            return (
              <li
                key={e.path}
                className={`atl-ctx-card__item${e.kind === 'unlink' || e.kind === 'unlinkDir' ? '' : ' is-clickable'}`}
                role={e.kind === 'unlink' || e.kind === 'unlinkDir' ? undefined : 'button'}
                tabIndex={e.kind === 'unlink' || e.kind === 'unlinkDir' ? undefined : 0}
                onClick={() => { if (e.kind !== 'unlink' && e.kind !== 'unlinkDir') openFile(e.path); }}
              >
                <span className="atl-ctx-card__ficon">
                  <FileTypeIcon path={e.path} size={15} />
                  {dot && <span className={`atl-ctx-card__dot-badge ${dot.cls}`} title={dot.title} />}
                </span>
                <PathCell path={e.path} workspacePath={workspacePath} />
                <span className="atl-ctx-card__item-tail">{ago(e.ts, isZh)}</span>
              </li>
            );
          })}
        </ul>
      </>
    );
  } else if (surface) {
    const meta = (surface.metadata ?? {}) as Record<string, unknown>;
    const streaming = meta.__streaming === true;
    const inlineText = surface.source.type === 'inline' ? (surface.source.content || '') : '';
    const path = surface.source.type === 'file' ? surface.source.path : '';
    const innerTabs = (meta.tabs as Array<{ id: string; title?: string; path?: string; url?: string }> | undefined) ?? [];

    title = surface.title || (kind ? String(kind) : '');

    headStat = streaming ? (
      <span className="atl-ctx-card__stat is-live">{isZh ? '渲染中' : 'Rendering'}</span>
    ) : innerTabs.length > 0 ? (
      <span className="atl-ctx-card__stat">
        {isZh ? `${innerTabs.length} 项` : `${innerTabs.length} items`}
      </span>
    ) : surface.updatedAt > 0 ? (
      <span className="atl-ctx-card__stat">{ago(surface.updatedAt, isZh)}</span>
    ) : null;

    subline = path ? (
      <div className="atl-ctx-card__meta">
        <PathCell path={path} workspacePath={workspacePath} />
      </div>
    ) : null;

    /* 图直接给图 —— 这是最字面意义上的"内容截图"。inline 的 svg 走 data URI,
     * 本地文件走 neox-asset (跟 ImageSurfaceViewer 同一条协议, 不另起一套)。 */
    if (kind && IMAGE_PREVIEW_KINDS.has(kind)) {
      const src = path
        ? localAssetUrl(path)
        : inlineText.trim().startsWith('<')
          ? `data:image/svg+xml;utf8,${encodeURIComponent(inlineText)}`
          : '';
      if (src) {
        shot = (
          <div className="atl-ctx-card__shot">
            <img src={src} alt="" draggable={false} />
          </div>
        );
      }
    }

    /* 正文: 流式看**尾部**(正在写的那几行, 能看出它在动), 静态看**头部**(它是什么)。 */
    const excerptSrc = inlineText || fileExcerpt;
    const excerpt = streaming ? excerptTail(excerptSrc) : excerptHead(excerptSrc);

    if (streaming) {
      body = (
        <>
          <div className="atl-ctx-card__prog">
            <span className="atl-ctx-card__dot is-running" aria-hidden />
            <span>{producedStat(excerptSrc, isZh)}</span>
          </div>
          {excerpt && <pre className="atl-ctx-card__excerpt is-tail">{excerpt}</pre>}
        </>
      );
    } else if (excerpt) {
      body = <pre className="atl-ctx-card__excerpt">{excerpt}</pre>;
    } else if (innerTabs.length > 0) {
      /* host-tabs 类 (源码 / 表格 / PDF / Word / PPT): 内容读不出来 (二进制或多份),
       * 但"里面装了哪几个文件"本身就是答案。 */
      body = (
        <ul className="atl-ctx-card__list">
          {innerTabs.slice(0, MAX_ROWS).map((tab) => {
            const p = tab.path || tab.url || tab.title || '';
            return (
              <li key={tab.id} className="atl-ctx-card__item">
                <span className="atl-ctx-card__ficon"><FileTypeIcon path={p} size={15} /></span>
                <PathCell path={p} workspacePath={workspacePath} />
              </li>
            );
          })}
          {innerTabs.length > MAX_ROWS && (
            <li className="atl-ctx-card__more">
              {isZh ? `还有 ${innerTabs.length - MAX_ROWS} 项` : `+${innerTabs.length - MAX_ROWS} more`}
            </li>
          )}
        </ul>
      );
    } else if (meta.isHome === true) {
      body = (
        <div className="atl-ctx-card__empty">
          {isZh ? '还是空的 —— 点开选一个文件或新建' : 'Empty — open it to pick a file or start one'}
        </div>
      );
    } else if (!shot && surface.updatedAt > 0) {
      /* 什么都读不到时的兜底 —— 至少别弹一张空卡 */
      body = (
        <div className="atl-ctx-card__kv">
          <span className="atl-ctx-card__k">{isZh ? '更新' : 'Updated'}</span>
          <span className="atl-ctx-card__v">{ago(surface.updatedAt, isZh)}</span>
        </div>
      );
    }
  }

  /* 其余 kind 统一给一个出口 —— 不是每张卡都要专门写一遍 */
  if (!action) {
    const label = kind === 'git' ? (isZh ? '打开改动' : 'Open changes')
      : kind === 'services' ? (isZh ? '打开服务' : 'Open services')
      : kind === 'files' ? (isZh ? '打开文件' : 'Open files')
      : (isZh ? '在右栏打开' : 'Open');
    action = (
      <button type="button" className="atl-ctx-card__action" onClick={openThis}>{label}</button>
    );
  }

  /* 一段可显示内容都没有就不弹卡 —— 空卡比没有卡更让人困惑 */
  if (!body && !subline && !shot) return null;

  return createPortal(
    <div
      ref={cardRef}
      className="atl-ctx-card"
      style={{ top: pos.top, left: pos.left, width: CARD_W }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      role="tooltip"
    >
      <div className="atl-ctx-card__head">
        <span className="atl-ctx-card__title">{title}</span>
        {headStat}
      </div>
      {subline}
      {shot}
      {body && <div className="atl-ctx-card__body">{body}</div>}
      {action && <div className="atl-ctx-card__actions">{action}</div>}

    </div>,
    document.body,
  );
};

export default AgentTimelineContextRailPreview;
