import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { copyToClipboard } from '../../utils/copyToClipboard';
import { useI18n } from '../../hooks/useI18n';
import { computeCommitDiff, type CommitDiff } from './commitLineDiff';
import { DiffBody } from './DiffLines';
import { FileTypeIcon } from '../../components/FileTypeIcon';

export interface DetailFile { path: string; status: string; add?: number; del?: number }
export interface DetailCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  dateIso?: string;
  date: string;
  refs: string;
}

/* 头像: 没有真头像源 (git 只有名字和邮箱), 用**名字首字** + 由名字定的色相。
 * 比放一个通用的灰色人形好 —— 那个在多人仓库里每行长得一样, 等于没有。 */
function initialsOf(name: string): string {
  const n = (name || '?').trim();
  if (!n) return '?';
  /* 中文名取姓, 英文名取首字母 */
  if (/[一-龥]/.test(n[0]!)) return n[0]!;
  const parts = n.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return n.slice(0, 2).toUpperCase();
}
function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

type TreeNode =
  | { kind: 'dir'; name: string; full: string; children: TreeNode[] }
  | { kind: 'file'; name: string; full: string; file: DetailFile };

/** 建树 + 把单子目录链压成 a/b/c 一行 (窄列友好) */
function buildTree(files: DetailFile[]): TreeNode[] {
  type Dir = { kind: 'dir'; name: string; full: string; kids: Map<string, Dir | Extract<TreeNode, { kind: 'file' }>> };
  const root: Dir = { kind: 'dir', name: '', full: '', kids: new Map() };
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    if (!parts.length) continue;
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const full = parts.slice(0, i + 1).join('/');
      if (i === parts.length - 1) { cur.kids.set(part, { kind: 'file', name: part, full, file: f }); continue; }
      let next = cur.kids.get(part);
      if (!next || next.kind !== 'dir') { next = { kind: 'dir', name: part, full, kids: new Map() } as Dir; cur.kids.set(part, next); }
      cur = next as Dir;
    }
  }
  const fin = (kids: Dir['kids']): TreeNode[] => {
    const dirs: TreeNode[] = [];
    const leaves: TreeNode[] = [];
    for (const n of kids.values()) {
      if (n.kind === 'file') { leaves.push(n); continue; }
      let node: TreeNode = { kind: 'dir', name: n.name, full: n.full, children: fin(n.kids) };
      while (node.kind === 'dir' && node.children.length === 1 && node.children[0]!.kind === 'dir') {
        const only = node.children[0] as Extract<TreeNode, { kind: 'dir' }>;
        node = { kind: 'dir', name: `${node.name}/${only.name}`, full: only.full, children: only.children };
      }
      dirs.push(node);
    }
    const byName = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name);
    dirs.sort(byName); leaves.sort(byName);
    return [...dirs, ...leaves];
  };
  return fin(root.kids);
}

const STATUS_TONE: Record<string, string> = { A: 'a', D: 'd', R: 'r', M: 'm', U: 'u' };

const FileIcon = ({ path }: { path: string }) => (
  <FileTypeIcon path={path} size={13} className="gcd__ficon" />
);
const DirIcon = ({ open }: { open: boolean }) => (
  <>
    <svg className={`gcd__chev${open ? ' is-open' : ''}`} width="8" height="8" viewBox="0 0 24 24"
         fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="9 18 15 12 9 6" />
    </svg>
    <svg className="gcd__ficon gcd__ficon--dir" viewBox="0 0 16 16" width="13" height="13" aria-hidden>
      <path d="M2.6 4.4A1.6 1.6 0 0 1 4.2 2.8h2.05c.38 0 .74.16 1 .44l.7.8c.26.28.62.44 1 .44h4.85A1.6 1.6 0 0 1 15.4 6.1v6.3A1.6 1.6 0 0 1 13.8 14H4.2A1.6 1.6 0 0 1 2.6 12.4z"
            fill="currentColor" fillOpacity="0.16" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" />
    </svg>
  </>
);

const TreeRows: React.FC<{
  nodes: TreeNode[];
  depth: number;
  collapsed: Set<string>;
  selected: string;
  onToggleDir: (full: string) => void;
  onPick: (path: string) => void;
  onOpen: (path: string) => void;
  onCtx: (e: React.MouseEvent, path: string) => void;
}> = ({ nodes, depth, collapsed, selected, onToggleDir, onPick, onOpen, onCtx }) => (
  <>
    {nodes.map((n) => {
      /* 缩进走 CSS 变量而不是 padding-left: 引导线 (::before) 要按同一个数落位,
       * 两处各写一遍 padding 迟早对不齐。 */
      const style = { ['--gcd-depth' as string]: String(depth) };
      if (n.kind === 'dir') {
        const open = !collapsed.has(n.full);
        return (
          <div key={`d:${n.full}`}>
            <button type="button" className="gcd__dir" style={style} title={n.full}
                    onClick={() => onToggleDir(n.full)}>
              <DirIcon open={open} />
              <span className="gcd__dirname">{n.name}</span>
            </button>
            {open && (
              <TreeRows nodes={n.children} depth={depth + 1} collapsed={collapsed} selected={selected}
                        onToggleDir={onToggleDir} onPick={onPick} onOpen={onOpen} onCtx={onCtx} />
            )}
          </div>
        );
      }
      const f = n.file;
      const st = (f.status || 'M').toUpperCase().charAt(0);
      const tone = STATUS_TONE[st] || 'm';
      return (
        <div
          key={`f:${n.full}`}
          className={`gcd__file${selected === f.path ? ' is-sel' : ''}`}
          style={style}
          title={f.path}
          onClick={() => onPick(f.path)}
          onDoubleClick={() => onOpen(f.path)}
          onContextMenu={(e) => onCtx(e, f.path)}
        >
          <FileIcon path={f.path} />
          <span className="gcd__fname">{n.name}</span>
          {/* 三格定宽 grid, 空的也占位 —— 一整列的 +/−/状态字母才在同一条竖线上 */}
          <span className="gcd__fstat">
            <span className="gcd__add">{f.add ? `+${f.add}` : ''}</span>
            <span className="gcd__del">{f.del ? `−${f.del}` : ''}</span>
            <span className={`gcd__ch gcd__ch--${tone}`}>{st === 'M' ? '' : st}</span>
          </span>
        </div>
      );
    })}
  </>
);

interface Props {
  commit: DetailCommit | null;
  files: DetailFile[];
  loadFile: (hash: string, path: string) => Promise<{ original: string; modified: string }>;
  /** 双击 → 交给编辑器开一个真正的 tab */
  onOpenInEditor: (path: string) => void;
  onFileContextMenu: (e: React.MouseEvent, path: string) => void;
  emptyHint?: React.ReactNode;
}

export const CommitDetailPane: React.FC<Props> = ({
  commit, files, loadFile, onOpenInEditor, onFileContextMenu, emptyHint,
}) => {
  const { isZh } = useI18n();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [picked, setPicked] = useState('');
  const [diff, setDiff] = useState<CommitDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);

  const hash = commit?.hash || '';
  useEffect(() => { setPicked(''); setDiff(null); setCollapsed(new Set()); }, [hash]);

  const tree = useMemo(() => buildTree(files), [files]);
  const pickedStatus = useMemo(
    () => files.find((f) => f.path === picked)?.status ?? '',
    [files, picked],
  );
  const totals = useMemo(
    () => files.reduce((s, f) => ({ add: s.add + (f.add ?? 0), del: s.del + (f.del ?? 0) }), { add: 0, del: 0 }),
    [files],
  );

  const pick = useCallback(async (path: string) => {
    if (!hash) return;
    setPicked(path);
    setLoading(true);
    const id = ++reqRef.current;
    try {
      const { original, modified } = await loadFile(hash, path);
      if (reqRef.current !== id) return;
      setDiff(computeCommitDiff(original, modified));
    } catch {
      if (reqRef.current === id) setDiff(null);
    } finally {
      if (reqRef.current === id) setLoading(false);
    }
  }, [hash, loadFile]);

  useEffect(() => {
    if (!hash || picked || files.length === 0) return;
    const first = [...files].sort((a, b) => a.path.localeCompare(b.path))[0];
    if (first) void pick(first.path);
  }, [hash, picked, files, pick]);

  const toggleDir = useCallback((full: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(full)) next.delete(full); else next.add(full);
      return next;
    });
  }, []);

  if (!commit) return <div className="gcd gcd--empty">{emptyHint}</div>;

  const when = commit.dateIso ? new Date(commit.dateIso) : null;
  const whenText = when && Number.isFinite(when.getTime())
    ? when.toLocaleString(isZh ? 'zh-CN' : undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    : commit.date;

  /* 提交消息第一行是标题, 其余是正文 —— git 的约定, 这里照着分两级显示 */
  const [subject, ...bodyLines] = commit.message.split('\n');
  const body = bodyLines.join('\n').trim();

  return (
    <div className="gcd">
      <div className="gcd__head">
        <div className="gcd__who">
          <span className="gcd__avatar" style={{ ['--gcd-hue' as string]: String(hueOf(commit.author)) }}>
            {initialsOf(commit.author)}
          </span>
          <span className="gcd__who-text">
            <span className="gcd__author">{commit.author || (isZh ? '未知作者' : 'Unknown')}</span>
            <span className="gcd__when">{whenText}</span>
          </span>
          <button
            type="button"
            className="gcd__hash"
            title={isZh ? '复制完整 hash' : 'Copy full hash'}
            onClick={() => void copyToClipboard(commit.hash)}
          >
            {commit.shortHash}
          </button>
        </div>
        <h3 className="gcd__subject">{subject}</h3>
        {body && <pre className="gcd__body">{body}</pre>}
      </div>

      <div className="gcd__files-head">
        <span>{isZh ? `${files.length} 个文件` : `${files.length} files`}</span>
        {totals.add > 0 && <span className="gcd__add">+{totals.add}</span>}
        {totals.del > 0 && <span className="gcd__del">−{totals.del}</span>}
      </div>
      <div className="gcd__files">
        <TreeRows nodes={tree} depth={0} collapsed={collapsed} selected={picked}
                  onToggleDir={toggleDir} onPick={(p) => void pick(p)}
                  onOpen={onOpenInEditor} onCtx={onFileContextMenu} />
      </div>

      <div className="gcd__diff-wrap">
        {picked && <div className="gcd__diff-path" title={picked}>{picked}</div>}
        <DiffBody diff={diff} loading={loading} path={picked} status={pickedStatus} />
      </div>
    </div>
  );
};

export default CommitDetailPane;
