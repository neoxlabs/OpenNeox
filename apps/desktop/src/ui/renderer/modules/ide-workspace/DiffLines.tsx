/* DiffLines — 行级 diff 的渲染。历史页的提交详情栏和改动页的右栏共用这一份。
 *
 * 折叠带 (gap) 是**可点的**: 点一下把这一段未改动的行放出来。
 * 不做成"永远展开"是因为 diff 的价值在改动本身, 中间几百行没改的只是噪音;
 * 但也不能不给出口 —— 判断一处改动对不对, 常常要看它上下文更远一点。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { langFromPath } from '../../components/shikiHighlighter';
import type { ShikiToken } from '../../components/shikiHighlighter';
import { highlightInWorker } from '../../components/shikiWorkerClient';
import type { CommitDiff, DiffRow } from './commitLineDiff';

const MAX_HL_CHARS = 400_000;
const MAX_HL_LINES = 12_000;

const detectIsDark = (): boolean => {
  const t = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null;
  if (t === 'light') return false;
  if (t === 'dark') return true;
  if (typeof matchMedia !== 'undefined') return matchMedia('(prefers-color-scheme: dark)').matches;
  return true;
};

function tooBig(s: string): boolean {
  if (s.length > MAX_HL_CHARS) return true;
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10 && ++n > MAX_HL_LINES) return true;
  return false;
}

/** 两侧全文 → 每侧的 tokens[行]。认不出语言 / 文件太大 / Shiki 挂了 → null (纯文本)。 */
function useDiffTokens(diff: CommitDiff | null, path: string): { old: ShikiToken[][] | null; neu: ShikiToken[][] | null } {
  const [isDark, setIsDark] = useState(detectIsDark);
  useEffect(() => {
    const el = document.documentElement;
    const update = () => setIsDark(detectIsDark());
    const mo = new MutationObserver(update);
    mo.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change', update);
    return () => { mo.disconnect(); mq.removeEventListener?.('change', update); };
  }, []);

  const [toks, setToks] = useState<{ old: ShikiToken[][] | null; neu: ShikiToken[][] | null }>({ old: null, neu: null });
  const lang = useMemo(() => langFromPath(path), [path]);
  const original = diff?.original ?? '';
  const modified = diff?.modified ?? '';

  useEffect(() => {
    setToks({ old: null, neu: null });
    if (!lang || !diff || diff.binary || diff.rows.length === 0) return;
    if (tooBig(original) || tooBig(modified)) return;
    let cancelled = false;
    const theme = isDark ? 'github-dark' : 'github-light';
    const run = (s: string) => (s ? highlightInWorker(s.replace(/\n$/, ''), lang, theme) : Promise.resolve(null));
    void Promise.all([run(original), run(modified)]).then(([old, neu]) => {
      if (!cancelled) setToks({ old, neu });
    });
    return () => { cancelled = true; };
  }, [lang, diff, original, modified, isDark]);

  return toks;
}

const DiffText: React.FC<{ row: DiffRow; old: ShikiToken[][] | null; neu: ShikiToken[][] | null }> = ({ row, old, neu }) => {
  /* del 行只存在于旧文件, 其余 (add / ctx) 都按新文件那侧取 —— ctx 两边内容相同 */
  const side = row.kind === 'del' ? old : neu;
  const no = row.kind === 'del' ? row.oldNo : row.newNo;
  const line = side && no !== undefined ? side[no - 1] : undefined;
  if (!line || line.length === 0) return <span className="gcd__dtext">{row.text || ' '}</span>;
  return (
    <span className="gcd__dtext">
      {line.map((t, i) => (
        <span key={i} style={t.color ? { color: t.color } : undefined}>{t.content}</span>
      ))}
    </span>
  );
};

export const DiffBody: React.FC<{
  diff: CommitDiff | null;
  loading: boolean;
  /** 空串 = 还没选文件 */
  path: string;
  status?: string;
  /** 没选文件时那句提示 */
  idleHint?: string;
}> = ({ diff, loading, path, status, idleHint }) => {
  const { isZh } = useI18n();
  /* 展开过的折叠带 (按它在 rows 里的下标记) —— 换文件要清空 */
  const [opened, setOpened] = useState<Set<number>>(() => new Set());
  useEffect(() => { setOpened(new Set()); }, [path]);
  const { old: oldTok, neu: newTok } = useDiffTokens(diff, path);

  const rows = useMemo<Array<DiffRow & { key: string }>>(() => {
    if (!diff) return [];
    const out: Array<DiffRow & { key: string }> = [];
    diff.rows.forEach((r, i) => {
      if (r.kind === 'gap' && opened.has(i) && r.hiddenRows) {
        r.hiddenRows.forEach((h, k) => out.push({ ...h, key: `${i}-${k}` }));
        return;
      }
      out.push({ ...r, key: String(i) });
    });
    return out;
  }, [diff, opened]);

  if (!path) return <div className="gcd__diff-hint">{idleHint ?? (isZh ? '选一个文件看改了什么' : 'Pick a file to see what changed')}</div>;
  if (loading) return <div className="gcd__diff-hint">{isZh ? '正在取差异…' : 'Loading diff…'}</div>;
  if (!diff) return <div className="gcd__diff-hint">{isZh ? '取不到这个文件的差异' : 'Diff unavailable'}</div>;
  if (diff.binary) return <div className="gcd__diff-hint">{isZh ? '二进制文件，不显示逐行差异' : 'Binary file — no line diff'}</div>;
  if (diff.identical) {
    const st = (status || '').toUpperCase().charAt(0);
    if (st === 'A') {
      return <div className="gcd__diff-hint">{isZh ? '新增的文件 · 取不到可逐行比较的文本（多半是二进制）' : 'New file · no comparable text (likely binary)'}</div>;
    }
    if (st === 'D') {
      return <div className="gcd__diff-hint">{isZh ? '已删除的文件 · 取不到可逐行比较的文本（多半是二进制）' : 'Deleted file · no comparable text (likely binary)'}</div>;
    }
    if (st === 'R') {
      return <div className="gcd__diff-hint">{isZh ? '只改了路径（重命名），内容没动' : 'Renamed only — content unchanged'}</div>;
    }
    return <div className="gcd__diff-hint">{isZh ? '内容没有变化（可能只改了文件模式）' : 'No content change (mode only?)'}</div>;
  }

  return (
    <div className="gcd__diff">
      {rows.map((r, idx) => {
        if (r.kind === 'gap') {
          return (
            <button
              type="button"
              className="gcd__dl gcd__dl--gap"
              key={r.key}
              onClick={() => setOpened((prev) => new Set(prev).add(Number(r.key)))}
              title={isZh ? '点开这一段' : 'Expand this range'}
            >
              <span className="gcd__dno" />
              <span className="gcd__dno" />
              <span className="gcd__dtext">
                {isZh ? `⋯ 未改动 ${r.hidden} 行，点开` : `⋯ ${r.hidden} unchanged lines — expand`}
              </span>
            </button>
          );
        }
        return (
          <div className={`gcd__dl gcd__dl--${r.kind}`} key={`${r.key}-${idx}`}>
            <span className="gcd__dno">{r.oldNo ?? ''}</span>
            <span className="gcd__dno">{r.newNo ?? ''}</span>
            <DiffText row={r} old={oldTok} neu={newTok} />
          </div>
        );
      })}
    </div>
  );
};

export default DiffBody;
