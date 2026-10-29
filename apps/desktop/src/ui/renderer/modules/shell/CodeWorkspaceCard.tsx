/**
 * Code 工作区管理卡片 —— 「项目」标题右边「＋ 项目 ▾」里的「工作区管理 / 新建工作区」(设计稿 E8jf「Code · 工作区」)
 *
 *   列表: 色点 + 名字 + 里面的项目 → 点进去编辑; 底部「＋ 新建工作区」
 *   编辑: 名字 / 6 个颜色 / 勾选哪些项目 (第一个是主项目, 可「设为主项目」) / 解散 · 保存
 *
 * 数据见 codeWorkspaces.ts (就是原来的多根工作区 + 一个颜色)。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sameWorkspace } from '../../utils/pathUtils';
import { WS_COLORS, dissolveCodeWorkspace, nextWorkspaceColor, saveCodeWorkspace, workspaceOf, type CodeWorkspace } from './codeWorkspaces';
import './work-projects.css';

export const openFolderIcon = (color?: string, size = 16) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="none" aria-hidden="true">
    <path d="M2.2 6.2V4.1a1.1 1.1 0 0 1 1.1-1.1h2.6l1.4 1.5h4.3a1.1 1.1 0 0 1 1.1 1.1v.6" stroke={color ?? 'currentColor'} strokeWidth="1.35" strokeLinejoin="round" />
    <path d="M1.6 7h12.1a.8.8 0 0 1 .77 1l-1.05 4.15a1.1 1.1 0 0 1-1.07.85H3.1a1.1 1.1 0 0 1-1.07-.84L.85 8a.8.8 0 0 1 .75-1z" fill={color ?? 'none'} fillOpacity={color ? 0.18 : undefined} stroke={color ?? 'currentColor'} strokeWidth="1.35" strokeLinejoin="round" />
  </svg>
);
const dot = (c: string, s = 9) => <span className="cw-dot" style={{ width: s, height: s, background: c }} aria-hidden="true" />;
const plus = (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
);
const back = (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
);
const checkbox = (on: boolean, color: string) => (
  <span className={`cw-check${on ? ' is-on' : ''}`} style={on ? { background: color, borderColor: color } : undefined} aria-hidden="true">
    {on && <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.3 6.5 11 12.5 5" /></svg>}
  </span>
);

export interface CodeWorkspaceCardProps {
  anchor: DOMRect;
  /** 侧栏里的全部项目 (路径 + 名字) */
  projects: ReadonlyArray<{ key: string; name: string }>;
  workspaces: readonly CodeWorkspace[];
  /** 打开时直接进哪一页: 'list' 管理 / 'new' 新建 */
  start: 'list' | 'new';
  onSaved: (changed: Array<{ primary: string; roots: string[]; name?: string }>) => void;
  onClose: () => void;
  /** 回到「＋ 项目 ▾」菜单 (卡片是从那里点进来的) */
  onBack?: () => void;
  zh: boolean;
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export const CodeWorkspaceCard: React.FC<CodeWorkspaceCardProps> = ({ anchor, projects, workspaces, start, onSaved, onClose, onBack, zh }) => {
  const ref = useRef<HTMLDivElement>(null);
  /* null = 列表页; { primary: undefined } = 新建 */
  const [editing, setEditing] = useState<{ primary?: string } | null>(start === 'new' ? {} : null);
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(WS_COLORS[0]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [top, setTop] = useState<number | null>(null);

  const nameOf = (p: string) => projects.find((x) => sameWorkspace(x.key, p))?.name ?? baseName(p);

  /* 进编辑页时把这个工作区的现状填进去 */
  useEffect(() => {
    if (!editing) return;
    const ws = editing.primary ? workspaces.find((w) => sameWorkspace(w.primary, editing.primary!)) : undefined;
    setName(ws?.name ?? '');
    setColor(ws?.color ?? nextWorkspaceColor(workspaces));
    setPicked(ws?.roots ?? []);
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Element;
      if (ref.current?.contains(t) || t.closest?.('.wp-trigger')) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      if (editing && start === 'list') setEditing(null); else onClose();
    };
    document.addEventListener('mousedown', down, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down, true); document.removeEventListener('keydown', key, true); };
  }, [onClose, editing, start]);

  /* 放不下就往上收 */
  React.useLayoutEffect(() => {
    const h = ref.current?.getBoundingClientRect().height ?? 0;
    setTop(Math.max(56, Math.min(anchor.top - 10, window.innerHeight - 14 - h)));
  }, [anchor.top, editing, picked.length, workspaces.length]);

  /* 侧栏里有、但不在任何工作区, 或在别的工作区里的项目 —— 都能勾; 在别处的标一句「在 X 里」, 勾了就换过来 */
  /* 勾上的排在最前 (主项目第一), 其余照侧栏顺序 —— 项目一多, 勾了什么一眼看得到 */
  const candidates = useMemo(() => {
    const rest = projects.map((p) => p.key).filter((k) => !picked.some((x) => sameWorkspace(x, k)));
    return [...picked, ...rest];
  }, [projects, picked]);
  /* 新建时名字框拿焦点 —— autoFocus 撞上菜单收起抢焦点不可靠, 打的字会落进底下的输入框 */
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing || editing.primary) return;
    const t = window.setTimeout(() => nameRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [editing]);

  const toggle = (p: string) => setPicked((cur) => (cur.some((x) => sameWorkspace(x, p)) ? cur.filter((x) => !sameWorkspace(x, p)) : [...cur, p]));
  const makePrimary = (p: string) => setPicked((cur) => [p, ...cur.filter((x) => !sameWorkspace(x, p))]);

  const save = async () => {
    if (picked.length < 2 || busy) return;
    setBusy(true);
    try {
      const changed = await saveCodeWorkspace({ primary: editing?.primary, name: name.trim() || nameOf(picked[0]!), color, roots: picked });
      onSaved(changed);
      if (start === 'list') setEditing(null); else onClose();
    } finally { setBusy(false); }
  };
  const dissolve = async () => {
    if (!editing?.primary || busy) return;
    setBusy(true);
    try {
      onSaved(await dissolveCodeWorkspace(editing.primary));
      if (start === 'list') setEditing(null); else onClose();
    } finally { setBusy(false); }
  };

  const sidebarRight = (document.querySelector('.neox-sidebar') as HTMLElement | null)?.getBoundingClientRect().right ?? anchor.right;
  const style = { left: sidebarRight + 2, top: top ?? anchor.top - 10, visibility: top === null ? 'hidden' as const : undefined };

  if (!editing) {
    return createPortal(
      <div ref={ref} className="wp-pop cw-card" style={style} role="dialog" aria-label={zh ? '工作区管理' : 'Workspaces'}>
        <div className="cw-head cw-head--title">
          {onBack && <button type="button" className="cw-back" onClick={onBack} aria-label={zh ? '返回' : 'Back'}>{back}</button>}
          <span className="cw-title">{zh ? '工作区' : 'Workspaces'}</span>
        </div>
        <div className="cw-sub">{zh ? '一起改的几个项目放进一个工作区：同一个颜色，agent 在任何一个里都能读写其它几个。' : 'Projects you change together share a color; the agent can read and write all of them.'}</div>
        {workspaces.length > 0 && <div className="wp-sep" />}
        {workspaces.map((w) => (
          <div key={w.primary} role="button" tabIndex={-1} className="wp-row cw-ws" onClick={() => setEditing({ primary: w.primary })} title={w.roots.join('\n')}>
            <span className="wp-row__plus">{dot(w.color)}</span>
            <span className="cw-ws__text">
              <span className="wp-row__name">{w.name}</span>
              <span className="cw-ws__members">{w.roots.map(nameOf).join(' · ')}</span>
            </span>
            <span className="wp-row__tail">{w.roots.length}</span>
          </div>
        ))}
        <div className="wp-sep" />
        <div role="button" tabIndex={-1} className="wp-row is-action" onClick={() => setEditing({})}>
          <span className="wp-row__plus">{plus}</span>
          <span>{zh ? '新建工作区' : 'New workspace'}</span>
        </div>
      </div>,
      document.body,
    );
  }

  const existing = editing.primary ? workspaces.find((w) => sameWorkspace(w.primary, editing.primary!)) : undefined;
  return createPortal(
    <div ref={ref} className="wp-pop cw-card" style={{ ...style, width: 330 }} role="dialog" aria-label={zh ? '编辑工作区' : 'Edit workspace'}>
      <div className="cw-head">
        {(start === 'list' || onBack) && (
          <button type="button" className="cw-back" onClick={() => (start === 'list' ? setEditing(null) : onBack?.())} aria-label={zh ? '返回' : 'Back'}>{back}</button>
        )}
        {dot(color, 12)}
        <input
          ref={nameRef}
          className="cw-name"
          value={name}
          placeholder={zh ? '工作区名字，比如「Neox 全家」' : 'Workspace name'}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
        />
      </div>
      <div className="cw-swatches" role="radiogroup" aria-label={zh ? '颜色' : 'Color'}>
        {WS_COLORS.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={c === color} className={`cw-swatch${c === color ? ' is-on' : ''}`} style={{ background: c, ['--sw' as string]: c }} onClick={() => setColor(c)} />
        ))}
      </div>
      <div className="wp-sep" />
      <div className="wp-cap"><span>{zh ? '里面的项目 · 第一个是主项目' : 'Projects · first is primary'}</span><span>{picked.length}</span></div>
      <div className="wp-scroll cw-list">
        {candidates.map((p) => {
          const on = picked.some((x) => sameWorkspace(x, p));
          const isPrimary = on && sameWorkspace(picked[0]!, p);
          const elsewhere = workspaceOf(p, workspaces);
          const inOther = elsewhere && (!editing.primary || !sameWorkspace(elsewhere.primary, editing.primary));
          return (
            <div key={p} role="checkbox" aria-checked={on} tabIndex={-1} className="wp-row cw-proj" onClick={() => toggle(p)} title={p}>
              {checkbox(on, color)}
              <span className="cw-proj__icon">{openFolderIcon(on ? color : inOther ? elsewhere!.color : undefined)}</span>
              <span className="wp-row__name">{nameOf(p)}</span>
              <span className="wp-row__tail">
                {isPrimary
                  ? <span className="cw-badge">{zh ? '主项目' : 'Primary'}</span>
                  : on
                    ? <button type="button" className="cw-link" onClick={(e) => { e.stopPropagation(); makePrimary(p); }}>{zh ? '设为主项目' : 'Make primary'}</button>
                    : inOther ? <span>{zh ? `在「${elsewhere!.name}」` : `in ${elsewhere!.name}`}</span> : null}
              </span>
            </div>
          );
        })}
      </div>
      <div className="wp-sep" />
      <div className="cw-foot">
        {existing && <button type="button" className="cw-danger" onClick={() => void dissolve()} disabled={busy}>{zh ? '解散工作区' : 'Dissolve'}</button>}
        <span className="cw-foot__hint">{picked.length < 2 ? (zh ? '至少选两个项目' : 'Pick at least two') : ''}</span>
        <button type="button" className="cw-save" onClick={() => void save()} disabled={busy || picked.length < 2}>{zh ? '保存' : 'Save'}</button>
      </div>
    </div>,
    document.body,
  );
};

export default CodeWorkspaceCard;
