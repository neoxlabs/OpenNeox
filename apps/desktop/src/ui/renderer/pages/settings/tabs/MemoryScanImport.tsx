
import React, { useCallback, useMemo, useState } from 'react';

import { defaultIsZh } from '../../../hooks/useI18n';
import { NeoxButton } from '../../../components/settings-base';
import { ScanBox, ScanChips, ScanDone, ScanLede, ScanSources, ScanStyles, scanPacing, type ScanSource } from './scanShell';

type Candidate = NonNullable<Awaited<ReturnType<NonNullable<Window['neox']['memoryDiscoverExternal']>>>>[number];

/* 跟 core/migrate/discoverMemories.ts 实际读的位置一一对应 */
const SOURCES: ScanSource[] = [
  { zh: '~/.claude/CLAUDE.md', en: '~/.claude/CLAUDE.md' },
  { zh: 'Claude Code 这个项目的自动记忆', en: 'Claude Code memory for this project' },
  { zh: '~/.codex/AGENTS.md 与 memories', en: '~/.codex/AGENTS.md and memories' },
  { zh: '~/.hermes/memories', en: '~/.hermes/memories' },
];

/** 一条候选归到上面哪个源 (按读出它的文件路径) —— 归不进去返回 -1, 不算进任何一行 */
function sourceIndex(c: Candidate): number {
  const p = String((c as any).sourcePath ?? '').replace(/\\/g, '/');
  if (/\/\.claude\/CLAUDE\.md$/i.test(p)) return 0;
  if (p.includes('/.claude/projects/')) return 1;
  if (p.includes('/.codex/')) return 2;
  if (c.source === 'Hermes') return 3;
  return -1;
}

const CATEGORY_LABEL: Record<string, [string, string]> = {
  pinned: ['固定', 'Pinned'],
  standard: ['规范', 'Convention'],
  lesson: ['教训', 'Lesson'],
  progress: ['进度', 'Progress'],
};
const CATEGORY_ORDER = ['pinned', 'standard', 'lesson', 'progress'];

/** 进度类默认不勾 —— 见文件头 */
const defaultPicked = (c: Candidate) => !c.alreadyImported && c.category !== 'progress';

/** slug 一样的标题 (没空格、带 - 或 _) 读不懂, 换成正文第一行 */
function displayOf(c: Candidate): { head: string; rest: string } {
  const text = c.summary.trim();
  const nl = text.indexOf('\n');
  const first = (nl < 0 ? text : text.slice(0, nl)).replace(/^#+\s*/, '').trim();
  const restRaw = nl < 0 ? '' : text.slice(nl + 1);
  const slugLike = !c.title || (!/\s/.test(c.title) && /[-_]/.test(c.title));
  if (slugLike && first) return { head: plain(first), rest: plain(restRaw) };
  return { head: c.title || plain(first), rest: plain(text) };
}

/** 列表里的一行预览: 去掉 markdown 记号 (**粗体** / `代码` / 行首 - #), 压成一行。展开后看原文。 */
function plain(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*(?:[-*]|#+)\s+/gm, '')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const PAGE = 60;

interface Props {
  zh?: boolean;
  onImported?: (count: number) => void;
  /** 导入后「去看看」—— 切到记住的事 */
  onShowImported?: () => void;
}

export const MemoryScanImport: React.FC<Props> = ({ zh = defaultIsZh(), onImported, onShowImported }) => {
  const [scan, setScan] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<string>('all');
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runScan = useCallback(async () => {
    const api = window.neox;
    if (typeof api?.memoryDiscoverExternal !== 'function') { setScan([]); return; }
    setBusy(true);
    setImported(null);
    setError(null);
    setProbing(0);
    setFilter('all');
    setQuery('');
    setLimit(PAGE);
    const tick = window.setInterval(() => setProbing((n) => n + 1), 220);
    const startedAt = Date.now();
    try {
      const arr = (await api.memoryDiscoverExternal()) ?? [];
      setScan(arr);
      setPicked(new Set(arr.filter(defaultPicked).map((c) => c.key)));
    } catch {
      setScan([]);
    } finally {
      /* 计时器跟 busy 同时收, 见 SkillScanImport 同一处 */
      window.setTimeout(() => {
        window.clearInterval(tick);
        setBusy(false);
      }, scanPacing(SOURCES, startedAt));
    }
  }, []);

  const fresh = useMemo(() => (scan ?? []).filter((c) => !c.alreadyImported), [scan]);
  const already = (scan?.length ?? 0) - fresh.length;
  const counts = useMemo(() => {
    const n = SOURCES.map(() => 0);
    for (const c of fresh) { const i = sourceIndex(c); if (i >= 0) n[i]++; }
    return n;
  }, [fresh]);

  /* 筛选项: 全部 + 有东西的分类 + (不止一个来源时) 来源 */
  const chips = useMemo(() => {
    const out: Array<{ value: string; label: string; count: number }> = [
      { value: 'all', label: zh ? '全部' : 'All', count: fresh.length },
    ];
    for (const cat of CATEGORY_ORDER) {
      const count = fresh.filter((c) => c.category === cat).length;
      if (count > 0) out.push({ value: `cat:${cat}`, label: CATEGORY_LABEL[cat][zh ? 0 : 1], count });
    }
    const sources = Array.from(new Set(fresh.map((c) => c.source)));
    if (sources.length > 1) {
      for (const s of sources) out.push({ value: `src:${s}`, label: s, count: fresh.filter((c) => c.source === s).length });
    }
    return out;
  }, [fresh, zh]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return fresh.filter((c) => {
      if (filter.startsWith('cat:') && c.category !== filter.slice(4)) return false;
      if (filter.startsWith('src:') && c.source !== filter.slice(4)) return false;
      return !q || c.title.toLowerCase().includes(q) || c.summary.toLowerCase().includes(q);
    });
  }, [fresh, query, filter]);

  const importable = fresh.filter((c) => picked.has(c.key)).map((c) => c.key);
  const shownPicked = shown.filter((c) => picked.has(c.key)).length;

  const doImport = useCallback(async () => {
    const api = window.neox;
    if (typeof api?.memoryImportExternal !== 'function') return;
    setImporting(true);
    setError(null);
    try {
      const r = await api.memoryImportExternal(importable);
      if (!r?.success) { setError(r?.error ?? (zh ? '导入失败' : 'Import failed')); return; }
      setImported(r.imported);
      const done = new Set(importable);
      setScan((prev) => (prev ?? []).map((c) => (done.has(c.key) ? { ...c, alreadyImported: true } : c)));
      setPicked(new Set());
      if (r.imported > 0) onImported?.(r.imported);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setImporting(false);
    }
  }, [importable, onImported, zh]);

  const toggle = (key: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  /* 全选 / 全不选只作用于当前筛出来的这些 */
  const allShownPicked = shown.length > 0 && shownPicked === shown.length;
  const toggleShown = () => setPicked((prev) => {
    const next = new Set(prev);
    for (const c of shown) { if (allShownPicked) next.delete(c.key); else next.add(c.key); }
    return next;
  });

  const unit = { zh: '条', en: '' };
  const doneBar = imported !== null && imported > 0 ? (
    <ScanDone
      title={zh ? `已导入 ${imported} 条记忆到这个项目` : `Imported ${imported} memories into this project`}
      note={zh ? '新会话会参考它们，记错的随时可以删。' : 'New sessions use them. Delete anything that is wrong.'}
      action={onShowImported && (
        <NeoxButton size="sm" variant="ghost" onClick={onShowImported}>{zh ? '去看看' : 'View'}</NeoxButton>
      )}
    />
  ) : error ? <ScanDone bad title={zh ? '导入失败' : 'Import failed'} note={error} /> : null;

  /* ── 起手 / 扫描中: 同一屏, 源清单原地亮 ── */
  if (scan === null || busy) {
    return (
      <div className="nx-scan nx-scan--page">
        <ScanStyles />
        <ScanLede
          title={busy ? (zh ? '正在扫描…' : 'Scanning…') : (zh ? '从其他 Agent 导入记忆' : 'Import memory from other agents')}
          desc={zh
            ? '只在你点「扫描本机」时读一次下面这几处。导入到当前项目，源文件不动。'
            : 'Reads the places below once, only when you click Scan. Imports into this project; the source files are left untouched.'}
        />
        <ScanSources sources={SOURCES} zh={zh} at={busy ? probing : undefined} />
        {!busy && (
          <div className="nx-scan__start">
            <button type="button" className="nx-scan__cta nx-scan__cta--primary" onClick={runScan}>
              {zh ? '扫描本机' : 'Scan this Mac'}
            </button>
          </div>
        )}
      </div>
    );
  }

  /* ── 没有可导入的 ── */
  if (fresh.length === 0) {
    return (
      <div className="nx-scan nx-scan--page">
        <ScanStyles />
        {doneBar}
        <ScanLede
          title={imported ? (zh ? '都导完了' : 'All imported') : (zh ? '没找到可导入的记忆' : 'Nothing to import')}
          desc={already > 0
            ? (zh ? `找到的 ${already} 条这个项目里都已经有了。` : `All ${already} found are already in this project.`)
            : (zh ? '在 Claude Code / Codex / Hermes 里攒下记忆之后再来试。' : 'Build up some memory in Claude Code / Codex / Hermes, then try again.')}
        />
        <ScanSources sources={SOURCES} zh={zh} counts={counts} unit={unit} />
        <div className="nx-scan__start">
          <button type="button" className="nx-scan__cta" onClick={runScan}>{zh ? '重新扫描' : 'Rescan'}</button>
        </div>
      </div>
    );
  }

  /* ── 结果 ── */
  return (
    <div className="nx-scan nx-scan--page">
      <ScanStyles />
      {doneBar}
      <ScanLede
        title={zh ? `找到 ${fresh.length} 条可导入的记忆` : `${fresh.length} memories ready to import`}
        desc={zh
          ? `「进度」类默认不勾——那是当时手上的活，多半已经过时。${already > 0 ? `另有 ${already} 条这个项目里已经有了，不再列出。` : ''}`
          : `“Progress” items start unticked — they describe work in flight back then and are usually stale.${already > 0 ? ` ${already} already in this project are hidden.` : ''}`}
      />
      <ScanSources sources={SOURCES} zh={zh} counts={counts} unit={unit} />

      <div className="nx-scan__filters">
        <ScanChips value={filter} options={chips} onChange={(v) => { setFilter(v); setLimit(PAGE); }} />
        <input
          className="nx-scan__search"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }}
          placeholder={zh ? '搜标题 / 内容' : 'Filter by title or content'}
        />
      </div>

      <div className="nx-scan__rows">
        {shown.slice(0, limit).map((c, i) => {
          const on = picked.has(c.key);
          const { head, rest } = displayOf(c);
          const isOpen = open === c.key;
          return (
            <div
              key={c.key}
              className={`nx-scan__item${on ? '' : ' is-off'}`}
              style={{ animationDelay: `${Math.min(i, 10) * 24}ms` }}
              onClick={() => toggle(c.key)}
              role="checkbox"
              aria-checked={on}
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(c.key); } }}
            >
              <ScanBox on={on} />
              <div className="nx-scan__item-main">
                <div className="nx-scan__item-title">
                  <span>{head}</span>
                  <span className="nx-scan__pill">{(CATEGORY_LABEL[c.category] ?? [c.category, c.category])[zh ? 0 : 1]}</span>
                  <span className="nx-scan__pill">{c.source}</span>
                </div>
                {!isOpen && rest && <div className="nx-scan__item-sub">{rest}</div>}
                {isOpen && (
                  <div onClick={(e) => e.stopPropagation()}>
                    <div className="nx-scan__item-full">{c.summary}</div>
                    {(c as any).sourcePath && <div className="nx-scan__item-path">{(c as any).sourcePath}</div>}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="nx-scan__expand"
                onClick={(e) => { e.stopPropagation(); setOpen(isOpen ? null : c.key); }}
              >
                {isOpen ? (zh ? '收起' : 'Less') : (zh ? '展开' : 'More')}
              </button>
            </div>
          );
        })}
        {shown.length === 0 && (
          <div className="nx-scan__empty">{zh ? '没有符合条件的。' : 'Nothing matches.'}</div>
        )}
        {shown.length > limit && (
          <NeoxButton className="nx-scan__more" size="sm" variant="ghost" onClick={() => setLimit((n) => n + PAGE)}>
            {zh ? `再显示 ${Math.min(PAGE, shown.length - limit)} 条（还有 ${shown.length - limit} 条）` : `Show ${Math.min(PAGE, shown.length - limit)} more (${shown.length - limit} left)`}
          </NeoxButton>
        )}
      </div>

      <div className="nx-scan__foot nx-scan__foot--sticky">
        <span className="nx-scan__foot-actions">
          <button type="button" className="nx-scan__link" onClick={toggleShown} disabled={shown.length === 0}>
            {allShownPicked
              ? (zh ? (filter === 'all' && !query ? '全不选' : '这些都不选') : 'Select none')
              : (zh ? (filter === 'all' && !query ? '全选' : '这些全选') : 'Select all')}
          </button>
          <span className="nx-scan__picked">{zh ? <>已选 <b>{importable.length}</b> / {fresh.length}</> : <><b>{importable.length}</b> of {fresh.length} picked</>}</span>
        </span>
        <span className="nx-scan__foot-actions">
          <button type="button" className="nx-scan__link" onClick={runScan} disabled={importing}>
            {zh ? '重新扫描' : 'Rescan'}
          </button>
          <button
            type="button"
            className="nx-scan__cta nx-scan__cta--primary"
            disabled={importing || importable.length === 0}
            onClick={doImport}
          >
            {importing
              ? (zh ? '导入中…' : 'Importing…')
              : (zh ? `导入 ${importable.length} 条` : `Import ${importable.length}`)}
          </button>
        </span>
      </div>
    </div>
  );
};

export default MemoryScanImport;
