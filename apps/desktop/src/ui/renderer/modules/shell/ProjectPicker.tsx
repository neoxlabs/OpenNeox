import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconCheck, IconPlus } from './shellIcons';
import { displayWorkspaceName } from '../../utils/modeHomeName';
import { kbd } from '../../utils/keymap';
import './project-picker.css';

export interface ProjectChoice { path: string; name?: string | null }

/** 同一路径大小写 / 尾斜杠不同也算一个 (Windows 盘符大小写常不一致) */
function key(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase();
}

/** /Users/x/AI/OpenNeox → ~/AI/MK; 只留父目录, 名字已经在上一行 */
function shortParent(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  parts.pop();
  let s = parts.join('/');
  s = s.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~').replace(/^[A-Za-z]:\/Users\/[^/]+/i, '~');
  return s || '/';
}

/** 系统临时目录 —— 跑脚本 / 测试留下的, 不是用户的项目 */
export function isTempPath(p: string): boolean {
  const s = p.replace(/\\/g, '/');
  return /^\/(private\/)?tmp\//.test(s)
    || /^\/(private\/)?var\/folders\//.test(s)
    || /\/AppData\/Local\/Temp\//i.test(s);
}

/** 文件夹颜色: 按名字稳定挑一个陶土色 (同一个项目每次同色) */
const TINTS = ['amber', 'lilac', 'mint', 'clay', 'sky'] as const;
function tintOf(path: string): string {
  let h = 2166136261;
  for (const ch of key(path)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return TINTS[(h >>> 8) % TINTS.length];
}

const ClayFolder: React.FC<{ tint: string }> = ({ tint }) => (
  <span className={`nx-projpick__folder is-${tint}`} aria-hidden="true">
    <svg viewBox="0 0 32 26">
      <path className="back" d="M2 5.5C2 3.6 3.6 2 5.5 2h6.6c1 0 1.9.4 2.5 1.2L16.4 5.5H26.5C28.4 5.5 30 7.1 30 9v12.5c0 1.9-1.6 3.5-3.5 3.5h-21C3.6 25 2 23.4 2 21.5z" />
      <path className="front" d="M2 10c0-1.4 1.1-2.5 2.5-2.5h23c1.4 0 2.5 1.1 2.5 2.5v11.5c0 1.9-1.6 3.5-3.5 3.5h-21C3.6 25 2 23.4 2 21.5z" />
      <path className="lip" d="M4.5 9h23" />
    </svg>
  </span>
);

const SearchGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" />
  </svg>
);
const FolderLine = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" aria-hidden="true">
    <path d="M2 4.5c0-.6.4-1 1-1h3l1.4 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z" />
  </svg>
);
const Chevron: React.FC<{ open: boolean }> = ({ open }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" style={{ transform: open ? 'rotate(90deg)' : undefined }}>
    <path d="m6 4 4 4-4 4" />
  </svg>
);

type Item =
  | { kind: 'project'; path: string; name: string; temp: boolean }
  | { kind: 'temp-toggle' }
  | { kind: 'open' };

export const ProjectPicker: React.FC<{
  /** 锚点矩形 (触发元素 getBoundingClientRect) —— 弹层贴它下沿, 左对齐 */
  anchor: DOMRect;
  /** 弹层宽度跟锚点一样宽 (侧栏那一行); 不传就用固定宽 */
  matchWidth?: boolean;
  title: string;
  projects: ProjectChoice[];
  currentPath?: string | null;
  isZh: boolean;
  onPick: (path: string) => void;
  onOpenFolder?: () => void;
  onClose: () => void;
}> = ({ anchor, matchWidth, title, projects, currentPath, isZh, onPick, onOpenFolder, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cur = currentPath ? key(currentPath) : '';
  const [q, setQ] = useState('');
  const [tempOpen, setTempOpen] = useState(false);

  /* 去重; 当前项目是临时目录也照样放在「最近」里 (不然打开弹层看不到自己在哪) */
  const all = useMemo(() => {
    const seen = new Set<string>();
    return projects.filter((p) => {
      if (!p?.path) return false;
      const k = key(p.path);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).map((p) => ({
      path: p.path,
      name: displayWorkspaceName(p.path, p.name ?? null, isZh),
      temp: isTempPath(p.path) && key(p.path) !== cur,
    }));
  }, [projects, isZh, cur]);

  const query = q.trim().toLowerCase();
  const items: Item[] = useMemo(() => {
    /* 搜索时不折叠: 临时目录里命中的也直接列出来 */
    if (query) {
      return [
        ...all.filter((p) => p.name.toLowerCase().includes(query) || p.path.toLowerCase().includes(query))
          .slice(0, 12).map((p) => ({ kind: 'project' as const, ...p })),
        ...(onOpenFolder ? [{ kind: 'open' as const }] : []),
      ];
    }
    const real = all.filter((p) => !p.temp).slice(0, 8);
    const temps = all.filter((p) => p.temp);
    return [
      ...real.map((p) => ({ kind: 'project' as const, ...p })),
      ...(temps.length ? [{ kind: 'temp-toggle' as const }] : []),
      ...(tempOpen ? temps.slice(0, 10).map((p) => ({ kind: 'project' as const, ...p })) : []),
      ...(onOpenFolder ? [{ kind: 'open' as const }] : []),
    ];
  }, [all, query, tempOpen, onOpenFolder]);
  const tempCount = useMemo(() => all.filter((p) => p.temp).length, [all]);

  const [active, setActive] = useState(() => Math.max(0, items.findIndex((it) => it.kind === 'project' && key(it.path) === cur)));
  useEffect(() => { setActive((i) => Math.min(i, Math.max(0, items.length - 1))); }, [items.length]);
  useEffect(() => { if (query) setActive(0); }, [query]);
  const activeRef = useRef(active);
  activeRef.current = active;

  const width = matchWidth ? Math.max(240, Math.min(280, anchor.width)) : 264;
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean }>({ left: anchor.left, top: anchor.bottom + 6, up: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.max(8, Math.min(anchor.left, vw - width - 8));
    const down = anchor.bottom + 6;
    const up = down + h > vh - 8 && anchor.top - 6 - h > 8;
    setPos({ left, top: up ? anchor.top - 6 - h : down, up });
    /* 只在打开时定一次位: 展开临时文件夹 / 搜索改变高度时不跳来跳去 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, width]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const activate = (it: Item | undefined) => {
    if (!it) return;
    if (it.kind === 'project') onPick(it.path);
    else if (it.kind === 'temp-toggle') setTempOpen((v) => !v);
    else onOpenFolder?.();
  };

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => {
      const n = items.length;
      if (e.key === 'Escape') { e.preventDefault(); if (q) setQ(''); else onClose(); }
      else if (e.key === 'ArrowDown' && n) { e.preventDefault(); setActive((i) => (i + 1) % n); }
      else if (e.key === 'ArrowUp' && n) { e.preventDefault(); setActive((i) => (i - 1 + n) % n); }
      else if (e.key === 'Enter') { e.preventDefault(); activate(items[activeRef.current]); }
      else if ((e.metaKey || e.ctrlKey) && (e.key === 'o' || e.key === 'O') && onOpenFolder) { e.preventDefault(); onOpenFolder(); }
    };
    const onBlur = () => onClose();
    const t = setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, q, onPick, onOpenFolder, onClose]);

  const firstTempIdx = items.findIndex((it) => it.kind === 'temp-toggle');
  const projectCount = items.filter((it) => it.kind === 'project').length;

  return createPortal(
    <div
      ref={ref}
      className={`nx-projpick${pos.up ? ' is-up' : ''}`}
      style={{ left: pos.left, top: pos.top, width }}
      role="listbox"
      aria-label={title}
    >
      <div className="nx-projpick__title">{title}</div>
      <label className="nx-projpick__search">
        <SearchGlyph />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={isZh ? '搜项目' : 'Search projects'}
          spellCheck={false}
          aria-label={isZh ? '搜项目' : 'Search projects'}
        />
      </label>
      {!query && projectCount > 0 && <div className="nx-projpick__group">{isZh ? '最近' : 'Recent'}</div>}
      {query && projectCount === 0 && (
        <div className="nx-projpick__empty">{isZh ? '没有匹配的项目' : 'No matching projects'}</div>
      )}
      {items.map((it, i) => {
        if (it.kind === 'temp-toggle') {
          return (
            <React.Fragment key="__temp">
              <div className="nx-projpick__sep" />
              <button
                type="button"
                className={`nx-projpick__row nx-projpick__row--temp${i === active ? ' is-active' : ''}`}
                aria-expanded={tempOpen}
                onMouseEnter={() => setActive(i)}
                onClick={() => setTempOpen((v) => !v)}
              >
                <span className="nx-projpick__ico" aria-hidden="true"><FolderLine /></span>
                <span className="nx-projpick__name">{isZh ? '临时文件夹' : 'Temporary folders'}<em> · {tempCount}</em></span>
                <span className="nx-projpick__chev"><Chevron open={tempOpen} /></span>
              </button>
            </React.Fragment>
          );
        }
        if (it.kind === 'open') {
          return (
            <React.Fragment key="__open">
              {(projectCount > 0 || firstTempIdx >= 0) && <div className="nx-projpick__sep" />}
              <button
                type="button"
                className={`nx-projpick__row nx-projpick__row--open${i === active ? ' is-active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={onOpenFolder}
              >
                <span className="nx-projpick__ico" aria-hidden="true"><IconPlus size={14} /></span>
                <span className="nx-projpick__name">{isZh ? '打开其他文件夹…' : 'Open another folder…'}</span>
                <kbd className="nx-projpick__kbd">{kbd('mod+o')}</kbd>
              </button>
            </React.Fragment>
          );
        }
        const isCur = key(it.path) === cur;
        return (
          <button
            key={it.path}
            type="button"
            role="option"
            aria-selected={isCur}
            className={`nx-projpick__row${isCur ? ' is-current' : ''}${i === active ? ' is-active' : ''}${it.temp ? ' is-temp' : ''}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(it.path)}
            title={it.path}
          >
            <ClayFolder tint={it.temp ? 'grey' : tintOf(it.path)} />
            <span className="nx-projpick__text">
              <span className="nx-projpick__name">{it.name}</span>
              <span className="nx-projpick__path">{shortParent(it.path)}</span>
            </span>
            {isCur && <span className="nx-projpick__check" aria-hidden="true"><IconCheck size={14} /></span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
};
