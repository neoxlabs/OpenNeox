/**
 * DiffSurfaceViewer — 文件 diff viewer (unified diff string)
 *
 * source.type='inline': content 是 unified diff (--- / +++ / @@).
 * source.type='file':  当 .diff/.patch 文件读, 内容仍是 unified diff.
 * metadata: { path?, before_label?, after_label? } — 用于头部展示
 *
 * 解析: 用自写宽松解析器, 不依赖 diff 库的 parsePatch (后者对 LLM 出品的亚标准 diff 太严, 行数对不上就拒收).
 *   - 容忍 hunk 内裸空行(LLM 常忘前导空格)
 *   - 容忍 hunk header 行数与实际不符(实际行数 > 头部声明) — 按实际为准
 *   - 容忍多 patch, 容忍缺 --- / +++ 头(只有 @@)
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { Surface } from '../../../state/surfaceStore';
import { dispatchHint } from '../../../components/notifyEvents';
import { useI18n } from '../../../hooks/useI18n';

interface Props {
  surface: Surface;
}

/** 超长 diff 保护 — 首屏只渲染这么多行 (hunk 为最小单位截断), 点按钮再展开全部.
 *  几万行 diff 一次性渲染 DOM 直接卡死面板; 2000 行以内滚动无感. */
const MAX_INITIAL_DIFF_ROWS = 2000;

interface DiffPatch {
  oldFileName: string;
  newFileName: string;
  hunks: DiffHunk[];
}

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];   // 包含首字符 sigil(' '/'+'/'-'/'\') 的原始行
}

type DiffLine = {
  kind: 'add' | 'del' | 'ctx' | 'meta';
  text: string;
  oldNo?: number;
  newNo?: number;
};

const HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * 宽松 unified diff 解析器. 对 LLM 出品做了几处容忍:
 *   - hunk 内空行 → 当成 ` ` context line
 *   - hunk header 行数不准 → 解析时按实际行数为准
 *   - hunk 内出现首字符非 ` `/`+`/`-`/`\` 的行 → 视为 hunk 结束
 */
function parseUnifiedDiff(raw: string): DiffPatch[] {
  const patches: DiffPatch[] = [];
  const lines = raw.split(/\r?\n/);
  let current: DiffPatch | null = null;
  let currentHunk: DiffHunk | null = null;

  const flushHunk = () => {
    if (!currentHunk) return;
    /* 按实际行数 recount, 比 header 准 */
    let oldLn = 0;
    let newLn = 0;
    for (const l of currentHunk.lines) {
      const c = l.charAt(0);
      if (c === ' ') { oldLn++; newLn++; }
      else if (c === '-') { oldLn++; }
      else if (c === '+') { newLn++; }
    }
    currentHunk.oldLines = oldLn;
    currentHunk.newLines = newLn;
    currentHunk = null;
  };

  const startPatch = (oldName: string, newName: string) => {
    if (current) patches.push(current);
    current = { oldFileName: oldName, newFileName: newName, hunks: [] };
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    if (l.startsWith('--- ')) {
      flushHunk();
      const oldName = l.slice(4).split('\t')[0].trim().replace(/^a\//, '');
      let newName = '';
      if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        newName = lines[i + 1].slice(4).split('\t')[0].trim().replace(/^b\//, '');
        i++;
      }
      startPatch(oldName, newName);
      continue;
    }

    const hm = HUNK_RE.exec(l);
    if (hm) {
      flushHunk();
      if (!current) current = { oldFileName: '', newFileName: '', hunks: [] };
      currentHunk = {
        oldStart: parseInt(hm[1], 10),
        oldLines: hm[2] ? parseInt(hm[2], 10) : 1,
        newStart: parseInt(hm[3], 10),
        newLines: hm[4] ? parseInt(hm[4], 10) : 1,
        lines: [],
      };
      current.hunks.push(currentHunk);
      continue;
    }

    if (currentHunk) {
      if (l.length === 0) {
        /* 裸空行 → 当 context */
        currentHunk.lines.push(' ');
      } else {
        const c = l.charAt(0);
        if (c === ' ' || c === '+' || c === '-' || c === '\\') {
          currentHunk.lines.push(l);
        } else {
          /* 异常首字符 → 当 hunk 结束 */
          flushHunk();
        }
      }
    }
  }

  flushHunk();
  if (current) patches.push(current);
  return patches.filter(p => p.hunks.length > 0);
}

function classifyHunkLines(hunk: DiffHunk): DiffLine[] {
  const out: DiffLine[] = [];
  let oldLn = hunk.oldStart;
  let newLn = hunk.newStart;
  for (const raw of hunk.lines) {
    const sigil = raw.charAt(0);
    const text = raw.slice(1);
    if (sigil === '+') {
      out.push({ kind: 'add', text, newNo: newLn });
      newLn++;
    } else if (sigil === '-') {
      out.push({ kind: 'del', text, oldNo: oldLn });
      oldLn++;
    } else if (sigil === '\\') {
      out.push({ kind: 'meta', text: raw });
    } else {
      out.push({ kind: 'ctx', text, oldNo: oldLn, newNo: newLn });
      oldLn++;
      newLn++;
    }
  }
  return out;
}

function readSource(surface: Surface): Promise<string> {
  if (surface.source.type === 'inline') {
    return Promise.resolve(surface.source.content);
  }
  if (surface.source.type === 'file') {
    const api = (window as any).neox;
    const reader = api?.surfaceReadFile ?? api?.readFile;
    if (!reader) return Promise.reject(new Error('neox.surfaceReadFile not available'));
    return reader(surface.source.path).then((res: any) => {
      if (res?.success === false) throw new Error(res.error || 'read failed');
      return typeof res === 'string' ? res : (res?.content ?? '');
    });
  }
  return Promise.reject(new Error('diff surface only supports inline or file source'));
}

function countChanges(patches: DiffPatch[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const p of patches) {
    for (const h of p.hunks) {
      for (const l of h.lines) {
        if (l.startsWith('+')) added++;
        else if (l.startsWith('-')) removed++;
      }
    }
  }
  return { added, removed };
}

export const DiffSurfaceViewer: React.FC<Props> = ({ surface }) => {
  const { isZh } = useI18n();
  const [raw, setRaw] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setShowAll(false);
    readSource(surface)
      .then((txt) => { if (!cancelled) { setRaw(txt); setError(null); } })
      .catch((err: any) => { if (!cancelled) setError(err?.message || String(err)); });
    return () => { cancelled = true; };
  }, [surface.source, surface.updatedAt]);

  const patches = useMemo<DiffPatch[]>(() => raw ? parseUnifiedDiff(raw) : [], [raw]);
  const totals = useMemo(() => countChanges(patches), [patches]);

  /* 超长 diff 截断: 以 hunk 为最小单位累积行数, 超出 MAX_INITIAL_DIFF_ROWS 停止渲染,
   * 尾部给"展开剩余 N 行"按钮. 数据不丢 (复制仍是全量 raw). */
  const { visiblePatches, hiddenRows, totalRows } = useMemo(() => {
    let total = 0;
    for (const p of patches) for (const h of p.hunks) total += h.lines.length + 1;
    if (showAll || total <= MAX_INITIAL_DIFF_ROWS) {
      return { visiblePatches: patches, hiddenRows: 0, totalRows: total };
    }
    let budget = MAX_INITIAL_DIFF_ROWS;
    const out: DiffPatch[] = [];
    for (const p of patches) {
      if (budget <= 0) break;
      const keptHunks: DiffHunk[] = [];
      for (const h of p.hunks) {
        if (budget <= 0) break;
        keptHunks.push(h);
        budget -= h.lines.length + 1;
      }
      if (keptHunks.length > 0) out.push({ ...p, hunks: keptHunks });
    }
    let shown = 0;
    for (const p of out) for (const h of p.hunks) shown += h.lines.length + 1;
    return { visiblePatches: out, hiddenRows: total - shown, totalRows: total };
  }, [patches, showAll]);

  const meta = surface.metadata as
    | { path?: string; before_label?: string; after_label?: string }
    | undefined;

  if (error) {
    return <div className="sfc-diff-error">{isZh ? `读取 diff 失败: ${error}` : `Failed to read diff: ${error}`}</div>;
  }
  if (!raw) {
    return <div className="sfc-diff-empty">{isZh ? '等待 diff 内容…' : 'Waiting for diff content…'}</div>;
  }
  if (patches.length === 0) {
    return (
      <div className="sfc-diff">
        <div className="sfc-diff__hdr">
          <span className="sfc-diff__hdr-path">{meta?.path ?? surface.title}</span>
          <span className="sfc-diff__hdr-warn">{isZh ? '无法解析为 unified diff (需要 --- / +++ / @@ 头)' : 'Not a unified diff (needs --- / +++ / @@ headers)'}</span>
        </div>
        <pre className="sfc-diff__raw">{raw}</pre>
      </div>
    );
  }

  return (
    <div className="sfc-diff">
      <div className="sfc-diff__hdr">
        <span className="sfc-diff__hdr-path" title={meta?.path ?? surface.title}>
          {meta?.path ?? patches[0]?.newFileName ?? patches[0]?.oldFileName ?? surface.title}
        </span>
        <span className="sfc-diff__hdr-stat">
          <span className="sfc-diff__stat-add">+{totals.added}</span>
          <span className="sfc-diff__stat-del">−{totals.removed}</span>
        </span>
        {(meta?.before_label || meta?.after_label) && (
          <span className="sfc-diff__hdr-rev">
            {meta?.before_label ?? 'before'} → {meta?.after_label ?? 'after'}
          </span>
        )}
        <button
          type="button"
          className="sfc-diff__hdr-copy"
          title={isZh ? '复制完整 diff' : 'Copy full diff'}
          aria-label={isZh ? '复制 diff' : 'Copy diff'}
          onClick={() => {
            navigator.clipboard.writeText(raw).then(
              () => dispatchHint(isZh ? '已复制 diff' : 'Diff copied', 'success'),
              () => dispatchHint(isZh ? '复制失败' : 'Copy failed', 'warning'),
            );
          }}
        >
          <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />
            <path d="M2.5 9.5V3a1 1 0 0 1 1-1H9" />
          </svg>
          <span>{isZh ? '复制' : 'Copy'}</span>
        </button>
      </div>
      <div className="sfc-diff__body">
        {visiblePatches.map((patch, pi) => (
          <div className="sfc-diff__patch" key={pi}>
            {patches.length > 1 && (
              <div className="sfc-diff__file">
                {patch.oldFileName} → {patch.newFileName}
              </div>
            )}
            {patch.hunks.map((hunk, hi) => (
              <HunkBlock key={hi} hunk={hunk} />
            ))}
          </div>
        ))}
        {hiddenRows > 0 && (
          <div className="sfc-diff__truncated">
            <span>
              {isZh
                ? `超长 diff, 已折叠 ${hiddenRows.toLocaleString()} 行 (共 ${totalRows.toLocaleString()} 行)`
                : `Long diff — ${hiddenRows.toLocaleString()} of ${totalRows.toLocaleString()} rows collapsed`}
            </span>
            <button type="button" onClick={() => setShowAll(true)}>
              {isZh ? '展开全部 (可能较卡)' : 'Show all (may be slow)'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

const HunkBlock: React.FC<{ hunk: DiffHunk }> = ({ hunk }) => {
  const lines = useMemo(() => classifyHunkLines(hunk), [hunk]);
  return (
    <div className="sfc-diff__hunk">
      <div className="sfc-diff__hunkhead">
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </div>
      {lines.map((l, i) => (
        <div className={`sfc-diff__row is-${l.kind}`} key={i}>
          <span className="sfc-diff__gut sfc-diff__gut-old">{l.oldNo ?? ''}</span>
          <span className="sfc-diff__gut sfc-diff__gut-new">{l.newNo ?? ''}</span>
          <span className="sfc-diff__sigil">
            {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : l.kind === 'meta' ? '⋯' : ' '}
          </span>
          <span className="sfc-diff__text">{l.text || ' '}</span>
        </div>
      ))}
    </div>
  );
};

export default DiffSurfaceViewer;
