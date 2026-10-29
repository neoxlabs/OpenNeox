
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import { useI18n } from '../../hooks/useI18n';
import { PPTX_AVAILABLE } from '../surface/pptxAvailability';
import { ToolBackLabelContext } from '../../components/ToolPage';
import { revealInFileManagerLabel } from '../../utils/fileManagerLabels';
import { dispatchHint } from '../../components/notifyEvents';
import { useNeoxRuntimeOptional } from '../../app/NeoxRuntimeContext';
/* side-effect: FileTypeIcons 模块加载时 addCollection 注册 jb/vscode-icons 离线集 —
 * 直接用 <Icon icon="vscode-icons:..."> 前必须保证注册过 */
import '../../components/FileTypeIcons';
import './library.css';
import { absoluteToAssetUrl } from '../../../shared/assetUrlPath';

interface ShelfItem {
  name: string;
  path: string;
  size: number;
  mtime: number;
  ext: string;
  ts: number;
  sessionId?: string;
  sessionTitle?: string;
}

type Kind = 'all' | 'ppt' | 'sheet' | 'doc' | 'image' | 'video' | 'web';

const KIND_OF: Record<string, Exclude<Kind, 'all'>> = {
  pptx: 'ppt', ppt: 'ppt', key: 'ppt',
  xlsx: 'sheet', xls: 'sheet', csv: 'sheet', tsv: 'sheet',
  docx: 'doc', doc: 'doc', pdf: 'doc', md: 'doc', txt: 'doc',
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', svg: 'image', heic: 'image', avif: 'image', bmp: 'image',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', mp3: 'video', wav: 'video', m4a: 'video',
  html: 'web', htm: 'web',
};

const EXT_ICON: Record<string, string> = {
  md: 'vscode-icons:file-type-markdown', pdf: 'vscode-icons:file-type-pdf2',
  doc: 'vscode-icons:file-type-word', docx: 'vscode-icons:file-type-word',
  xls: 'vscode-icons:file-type-excel', xlsx: 'vscode-icons:file-type-excel', csv: 'vscode-icons:file-type-excel', tsv: 'vscode-icons:file-type-excel',
  ppt: 'vscode-icons:file-type-powerpoint', pptx: 'vscode-icons:file-type-powerpoint', key: 'vscode-icons:file-type-powerpoint',
  mp3: 'vscode-icons:file-type-audio', wav: 'vscode-icons:file-type-audio', m4a: 'vscode-icons:file-type-audio',
  mp4: 'vscode-icons:file-type-video', mov: 'vscode-icons:file-type-video', mkv: 'vscode-icons:file-type-video', webm: 'vscode-icons:file-type-video',
  txt: 'vscode-icons:file-type-text', html: 'vscode-icons:file-type-html', htm: 'vscode-icons:file-type-html',
};

const assetUrl = absoluteToAssetUrl;

/* 窗口刚 reload 时 neox-asset 协议偶尔没就绪, 第一次失败会被缓存成裂图 (文件本身好好的) —— 换个查询串重试一次 */
const retryOnce = (e: React.SyntheticEvent<HTMLImageElement>) => {
  const img = e.currentTarget;
  if (img.dataset.retried) return;
  img.dataset.retried = '1';
  img.src = `${img.src.split('?')[0]}?r=${Date.now()}`;
};

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function dayLabel(ms: number, zh: boolean): string {
  const d = new Date(ms);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86_400_000);
  if (diff === 0) return zh ? '今天' : 'Today';
  if (diff === 1) return zh ? '昨天' : 'Yesterday';
  if (diff < 7) return zh ? `${diff} 天前` : `${diff} days ago`;
  return zh ? `${d.getMonth() + 1}月${d.getDate()}日` : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function timeOf(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const LibraryPage: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const backLabel = React.useContext(ToolBackLabelContext);
  const { isZh } = useI18n();
  /* Esc 也能回去; 搜索框里有字时 Esc 先交给输入框清空, 不抢 */
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.tagName === 'INPUT' && (t as HTMLInputElement).value) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const runtime = useNeoxRuntimeOptional();
  const [items, setItems] = useState<ShelfItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<Kind>('all');
  const [query, setQuery] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const api = window.neox as unknown as {
        librarySessionOutputs?: () => Promise<{ items?: ShelfItem[] }>;
        agentModeEnsureHome?: (m: string) => Promise<{ success?: boolean; path?: string }>;
        libraryList?: (dir: string) => Promise<{ files?: Array<Omit<ShelfItem, 'ts'>> }>;
      };
      const [fromSessions, home] = await Promise.all([
        api.librarySessionOutputs?.().catch(() => null),
        api.agentModeEnsureHome?.('work').catch(() => null),
      ]);
      const fromHome = home?.path ? await api.libraryList?.(home.path).catch(() => null) : null;
      const byPath = new Map<string, ShelfItem>();
      for (const it of fromSessions?.items ?? []) byPath.set(it.path, it);
      for (const f of fromHome?.files ?? []) {
        if (!byPath.has(f.path) && KIND_OF[f.ext]) byPath.set(f.path, { ...f, ts: f.mtime });
      }
      setItems([...byPath.values()].sort((a, b) => b.ts - a.ts));
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const counts = useMemo(() => {
    const c: Record<Kind, number> = { all: items.length, ppt: 0, sheet: 0, doc: 0, image: 0, video: 0, web: 0 };
    for (const it of items) { const k = KIND_OF[it.ext]; if (k) c[k] += 1; }
    return c;
  }, [items]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const vis = items.filter((it) => {
      if (kind !== 'all' && KIND_OF[it.ext] !== kind) return false;
      if (q && !it.name.toLowerCase().includes(q) && !(it.sessionTitle ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
    const out: Array<{ label: string; items: ShelfItem[] }> = [];
    for (const it of vis) {
      const label = dayLabel(it.ts, isZh);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(it);
      else out.push({ label, items: [it] });
    }
    return out;
  }, [items, kind, query, isZh]);

  const api = window.neox as unknown as {
    surfaceOpenExternal?: (p: string) => Promise<unknown>;
    fsRevealInFinder?: (p: string) => Promise<unknown>;
  };

  const reportFailure = useCallback((what: string, r: any) => {
    if (r?.success !== false) return;
    const reason = typeof r?.error === 'string' ? r.error : '';
    dispatchHint(`${what}${reason ? `：${reason}` : ''}`, 'warning');
  }, []);
  const openIt = useCallback((path: string) => {
    void api.surfaceOpenExternal?.(path)
      .then((r) => reportFailure(isZh ? '打不开这个文件' : 'Couldn’t open this file', r))
      .catch((e: any) => dispatchHint(`${isZh ? '打不开这个文件' : 'Couldn’t open this file'}：${e?.message || e}`, 'warning'));
  }, [reportFailure, isZh]);
  const revealIt = useCallback((path: string) => {
    void api.fsRevealInFinder?.(path)
      .then((r) => reportFailure(revealInFileManagerLabel(isZh), r))
      .catch((e: any) => dispatchHint(`${revealInFileManagerLabel(isZh)}：${e?.message || e}`, 'warning'));
  }, [reportFailure, isZh]);

  const kindLabel = (k: Exclude<Kind, 'all'>) => {
    const m = kinds.find((x) => x.id === k)!;
    return isZh ? (k === 'video' ? '视频' : m.zh) : m.en;
  };

  const kinds: Array<{ id: Kind; zh: string; en: string }> = [
    { id: 'all', zh: '全部', en: 'All' },
    { id: 'ppt', zh: 'PPT', en: 'Slides' },
    { id: 'sheet', zh: '表格', en: 'Sheets' },
    { id: 'doc', zh: '文档', en: 'Docs' },
    { id: 'image', zh: '图片', en: 'Images' },
    { id: 'video', zh: '音视频', en: 'Media' },
    { id: 'web', zh: '网页', en: 'Web' },
  ];

  return (
    <div className="neox-shelf">
      {onClose && (
        <button type="button" className="neox-shelf__back" onClick={onClose} title={isZh ? '返回 (Esc)' : 'Back (Esc)'}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
          {/* 跟别的工具页同一套说法: 从工具主页进来写「工具」, 否则「返回任务」(ToolBackLabelContext) */}
          {backLabel ?? (isZh ? '返回任务' : 'Back to tasks')}
        </button>
      )}
      <header className="neox-shelf__head">
        <div className="neox-shelf__title">
          <h1>{isZh ? '成品架' : 'Shelf'}</h1>
          <p>{isZh ? '所有任务做出来的东西，都在这' : 'Everything your tasks have produced'}</p>
        </div>
        <label className="neox-shelf__search">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><circle cx="7.2" cy="7.2" r="4.6" /><path d="m10.6 10.6 3.4 3.4" /></svg>
          <input
            id="shelf-search"
            type="text"
            placeholder={isZh ? '搜成品名或任务…' : 'Search by name or task…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </header>

      <div className="neox-shelf__kinds" role="group">
        {kinds.filter((k) => k.id === 'all' || counts[k.id] > 0).map((k) => (
          <button
            key={k.id}
            type="button"
            /* aria-pressed 而不是 tab/aria-selected: 主题包给 [aria-selected=true] 统一刷灰底 (!important), 会盖掉这里的钴蓝 */
            aria-pressed={kind === k.id}
            className={`neox-shelf__kind${kind === k.id ? ' is-on' : ''}`}
            onClick={() => setKind(k.id)}
          >
            {isZh ? k.zh : k.en}<em>{counts[k.id]}</em>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="neox-shelf__empty neox-text-shimmer">{isZh ? '正在整理…' : 'Gathering…'}</div>
      ) : groups.length === 0 ? (
        <div className="neox-shelf__empty">
          <p className="neox-shelf__empty-title">
            {query || kind !== 'all' ? (isZh ? '没有对得上的成品' : 'Nothing matches') : (isZh ? '架子还是空的' : 'The shelf is empty')}
          </p>
          <p className="neox-shelf__empty-hint">
            {PPTX_AVAILABLE
              ? (isZh ? '让 Neox 做一份 PPT、表格或报告，做好的文件会自动摆上来' : 'Ask Neox for slides, a sheet or a report — finished files land here')
              : (isZh ? '让 Neox 做一份表格或报告，做好的文件会自动摆上来' : 'Ask Neox for a sheet or a report — finished files land here')}
          </p>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.label} className="neox-shelf__group">
            <h2>{g.label}</h2>
            <div className="neox-shelf__grid">
              {g.items.map((it) => {
                const k = KIND_OF[it.ext];
                return (
                  <div
                    key={it.path}
                    className="neox-shelf__card"
                    role="button"
                    tabIndex={0}
                    title={it.path}
                    onClick={() => openIt(it.path)}
                    onKeyDown={(e) => { if (e.key === 'Enter') openIt(it.path); }}
                  >
                    <div className={`neox-shelf__thumb is-${k ?? 'file'}`}>
                      {k === 'image'
                        ? <img src={assetUrl(it.path)} alt="" loading="lazy" draggable={false} onError={retryOnce} />
                        : <Icon icon={EXT_ICON[it.ext] ?? 'vscode-icons:default-file'} width={44} height={44} />}
                      {/* 设计稿: 缩略图右下角一枚类型小签 */}
                      {k && <span className="neox-shelf__tag">{kindLabel(k)}</span>}
                    </div>
                    <div className="neox-shelf__name">{it.name}</div>
                    <div className="neox-shelf__meta">
                      {it.sessionId ? (
                        <button
                          type="button"
                          className="neox-shelf__from"
                          onClick={(e) => { e.stopPropagation(); runtime?.selectSession(it.sessionId!); }}
                          title={isZh ? '回到做出它的那个任务' : 'Go to the task that made it'}
                        >
                          {isZh ? '来自 · ' : 'From · '}{it.sessionTitle || (isZh ? '未命名任务' : 'Untitled task')}
                        </button>
                      ) : (
                        <span>{fmtSize(it.size)}</span>
                      )}
                    </div>
                    <div className="neox-shelf__time">{timeOf(it.ts)}</div>
                    {/* 悬停才浮出的一排动作 (设计稿「打开 / 继续改 / 在文件夹显示」), 盖在时间那一行上 */}
                    <div className="neox-shelf__acts" onClick={(e) => e.stopPropagation()}>
                      <button type="button" onClick={() => openIt(it.path)}>
                        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9.5 2.5h4v4M13.5 2.5 8 8M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" /></svg>
                        {isZh ? '打开' : 'Open'}
                      </button>
                      {it.sessionId && (
                        <button type="button" onClick={() => runtime?.selectSession(it.sessionId!)}>
                          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m10.5 3 2.5 2.5L6 12.5H3.5V10z" /></svg>
                          {isZh ? '继续改' : 'Edit'}
                        </button>
                      )}
                      <button type="button" onClick={() => revealIt(it.path)} title={revealInFileManagerLabel(isZh)}>
                        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 4.5a1.5 1.5 0 0 1 1.5-1.5h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" /></svg>
                        {isZh ? '文件夹' : 'Folder'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
};

export default LibraryPage;
