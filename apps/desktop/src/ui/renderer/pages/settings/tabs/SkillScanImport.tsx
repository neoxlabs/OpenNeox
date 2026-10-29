
import React, { useCallback, useMemo, useState } from 'react';

import { defaultIsZh } from '../../../hooks/useI18n';
import { Segmented } from '../../../components/settings-base';
import { ScanBox, ScanChips, ScanDone, ScanLede, ScanSources, ScanStyles, scanPacing, type ScanSource } from './scanShell';

/** skills:discover-external 的返回形状 (electron/ipc/skillsHandlers.ts) */
export interface ScannedSkill {
  id: string;
  name: string;
  description: string;
  path: string;
  source: string;
  alreadyImported: boolean;
  assets: { references: number; scripts: number; agents: number; other: number; bytes: number };
}

interface Props {
  zh?: boolean;
  /** 导入落到哪 —— 用户级还是当前工作区 */
  target?: 'user' | 'workspace';
  onImported?: (count: number) => void;
  variant?: 'page' | 'compact';
}

/* 跟 SkillRegistry.discoverExternalSkills 实际读的目录一一对应 (registry.ts roots), 顺序也一样 */
const SOURCES: ScanSource[] = [
  { zh: '~/.claude/skills', en: '~/.claude/skills' },
  { zh: '~/.codex/skills', en: '~/.codex/skills' },
  { zh: '当前项目的 .claude/skills', en: '<workspace>/.claude/skills' },
  { zh: '当前项目的 .codex/skills', en: '<workspace>/.codex/skills' },
];
/** registry.ts 给每个根打的 source 标签 → 上面第几行 */
const SOURCE_ROW: Record<string, number> = { 'Claude Code': 0, 'Codex': 1, 'Claude Code (项目)': 2, 'Codex (项目)': 3 };

/** 附带内容一句话 —— 导入前让用户看清拿到的是"一页说明"还是"一套带脚本的东西" */
function assetSummary(a: ScannedSkill['assets'], zh: boolean): string {
  const parts: string[] = [];
  if (a.references) parts.push(zh ? `${a.references} 参考` : `${a.references} refs`);
  if (a.scripts) parts.push(zh ? `${a.scripts} 脚本` : `${a.scripts} scripts`);
  if (a.agents) parts.push(zh ? `${a.agents} 子 agent` : `${a.agents} agents`);
  if (!parts.length) return zh ? '仅 SKILL.md' : 'SKILL.md only';
  return parts.join(' · ');
}

export const SkillScanImport: React.FC<Props> = ({
  zh = defaultIsZh(),
  target = 'user',
  onImported,
  variant = 'page',
}) => {
  const [scan, setScan] = useState<ScannedSkill[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; failed: number } | null>(null);
  const [mode, setMode] = useState<'copy' | 'link'>('copy');

  const runScan = useCallback(async () => {
    const api = (window as any).neox;
    if (typeof api?.skillsDiscoverExternal !== 'function') { setScan([]); return; }
    setBusy(true);
    setResult(null);
    setProbing(0);
    setFilter('all');
    setQuery('');
    const tick = window.setInterval(() => setProbing((n) => n + 1), 220);
    const startedAt = Date.now();
    try {
      const list = await api.skillsDiscoverExternal();
      const arr: ScannedSkill[] = Array.isArray(list) ? list : [];
      setScan(arr);
      /* 默认全勾还没导过的 —— 用户来这一屏就是为了搬, 让他取消勾比让他一个个勾快 */
      setPicked(new Set(arr.filter((s) => !s.alreadyImported).map((s) => s.path)));
    } catch {
      setScan([]);
    } finally {
      window.setTimeout(() => {
        window.clearInterval(tick);
        setBusy(false);
      }, scanPacing(SOURCES, startedAt));
    }
  }, []);

  const fresh = useMemo(() => (scan ?? []).filter((s) => !s.alreadyImported), [scan]);
  const already = (scan?.length ?? 0) - fresh.length;
  const counts = useMemo(() => {
    const n = SOURCES.map(() => 0);
    for (const s of fresh) { const i = SOURCE_ROW[s.source]; if (i !== undefined) n[i]++; }
    return n;
  }, [fresh]);
  const chips = useMemo(() => {
    const out = [{ value: 'all', label: zh ? '全部' : 'All', count: fresh.length }];
    const sources = Array.from(new Set(fresh.map((s) => s.source)));
    if (sources.length > 1) for (const s of sources) out.push({ value: s, label: s, count: fresh.filter((x) => x.source === s).length });
    return out;
  }, [fresh, zh]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return fresh.filter((s) => (filter === 'all' || s.source === filter) && (!q
      || s.id.toLowerCase().includes(q)
      || s.name.toLowerCase().includes(q)
      || s.description.toLowerCase().includes(q)));
  }, [fresh, query, filter]);

  const importable = Array.from(picked).filter((p) => fresh.some((s) => s.path === p));

  const doImport = useCallback(async () => {
    const api = (window as any).neox;
    if (typeof api?.skillsImportPath !== 'function') return;
    setImporting(true);
    let ok = 0;
    let failed = 0;
    try {
      /* 一条一条导 —— IPC 只有单条的形态。串行而不是并发: 它们都往同一个
       * ~/.neox/skills 里写目录, 并发只会把失败原因搅在一起。 */
      for (const path of importable) {
        try {
          const r = await api.skillsImportPath(path, target, mode);
          if (r?.success) ok++; else failed++;
        } catch { failed++; }
      }
      setResult({ imported: ok, failed });
      if (ok > 0) {
        /* 导过的就地标掉, 免得用户对着一排已经导好的再点一次 */
        setScan((prev) => (prev ?? []).map((s) => (
          importable.includes(s.path) ? { ...s, alreadyImported: true } : s
        )));
        setPicked(new Set());
        onImported?.(ok);
      }
    } finally {
      setImporting(false);
    }
  }, [importable, target, mode, onImported]);

  const toggle = (path: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const shownPicked = shown.filter((s) => picked.has(s.path)).length;
  const allShownPicked = shown.length > 0 && shownPicked === shown.length;
  const toggleShown = () => setPicked((prev) => {
    const next = new Set(prev);
    for (const s of shown) { if (allShownPicked) next.delete(s.path); else next.add(s.path); }
    return next;
  });

  const unit = { zh: '个', en: '' };
  const doneBar = result && (result.imported > 0 || result.failed > 0) ? (
    <ScanDone
      bad={result.imported === 0}
      title={result.imported > 0
        ? (zh ? `已导入 ${result.imported} 个技能` : `Imported ${result.imported} skills`)
        : (zh ? '一个都没导进去' : 'Nothing was imported')}
      note={result.failed > 0
        ? (zh ? `${result.failed} 个失败 —— 多半是同名技能已存在，或源目录读不了。` : `${result.failed} failed — usually a skill with the same name exists, or the folder is unreadable.`)
        : (mode === 'link'
          ? (zh ? '是软链，源目录里改了这边跟着变。' : 'Linked — edits in the source show up here.')
          : (zh ? '已复制一份，之后跟源目录互不影响。' : 'Copied — independent from the source from now on.'))}
    />
  ) : null;

  /* ── 起手 / 扫描中 ── */
  if (scan === null || busy) {
    return (
      <div className={`nx-scan nx-scan--${variant}`}>
        <ScanStyles />
        <ScanLede
          title={busy ? (zh ? '正在扫描…' : 'Scanning…') : (zh ? '从本机扫描技能' : 'Scan this Mac for skills')}
          desc={zh
            ? '只在你点「扫描本机」时读一次下面这几个目录。导入时可选复制或软链，源目录都不动。'
            : 'Reads the folders below once, only when you click Scan. Import by copy or by link; the source is left untouched.'}
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

  /* ── 空 ── */
  if (fresh.length === 0) {
    return (
      <div className={`nx-scan nx-scan--${variant}`}>
        <ScanStyles />
        {doneBar}
        <ScanLede
          title={result?.imported ? (zh ? '都导完了' : 'All imported') : (zh ? '没找到可导入的技能' : 'Nothing to import')}
          desc={already > 0
            ? (zh ? `找到的 ${already} 个都已经导过了。` : `All ${already} found are already imported.`)
            : (zh ? '在 Claude Code / Codex 里写过技能之后再来试。' : 'Write a skill in Claude Code / Codex, then try again.')}
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
    <div className={`nx-scan nx-scan--${variant}`}>
      <ScanStyles />
      {doneBar}
      <ScanLede
        title={zh ? `找到 ${fresh.length} 个可导入的技能` : `${fresh.length} skills ready to import`}
        desc={zh
          ? `勾选要搬的，一次导入。${already > 0 ? `另有 ${already} 个已经导过，不再列出。` : ''}`
          : `Pick the ones you want and import them in one go.${already > 0 ? ` ${already} already imported are hidden.` : ''}`}
      />
      <ScanSources sources={SOURCES} zh={zh} counts={counts} unit={unit} />

      {(fresh.length > 8 || chips.length > 2) && (
        <div className="nx-scan__filters">
          {chips.length > 2 && <ScanChips value={filter} options={chips} onChange={setFilter} />}
          <input
            className="nx-scan__search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={zh ? '搜技能名 / 说明' : 'Filter by name or description'}
          />
        </div>
      )}

      <div className="nx-scan__rows">
        {shown.map((s, i) => {
          const on = picked.has(s.path);
          return (
            <div
              key={s.path}
              className={`nx-scan__item${on ? '' : ' is-off'}`}
              style={{ animationDelay: `${Math.min(i, 10) * 24}ms` }}
              onClick={() => toggle(s.path)}
              role="checkbox"
              aria-checked={on}
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(s.path); } }}
              title={s.path}
            >
              <ScanBox on={on} />
              <div className="nx-scan__item-main">
                <div className="nx-scan__item-title">
                  <span>{s.name || s.id}</span>
                  <span className="nx-scan__pill">{s.source}</span>
                </div>
                {s.description && <div className="nx-scan__item-sub">{s.description}</div>}
              </div>
              <span className="nx-scan__item-aside nx-scan__meta">
                <span className="nx-scan__meta-dim">{assetSummary(s.assets, zh)}</span>
              </span>
            </div>
          );
        })}
        {shown.length === 0 && <div className="nx-scan__empty">{zh ? '没有符合条件的。' : 'Nothing matches.'}</div>}
      </div>

      <div className="nx-scan__foot nx-scan__foot--sticky">
        <span className="nx-scan__foot-actions">
          <button type="button" className="nx-scan__link" onClick={toggleShown} disabled={shown.length === 0}>
            {allShownPicked ? (zh ? '全不选' : 'Select none') : (zh ? '全选' : 'Select all')}
          </button>
          <span className="nx-scan__picked">{zh ? <>已选 <b>{importable.length}</b> / {fresh.length}</> : <><b>{importable.length}</b> of {fresh.length} picked</>}</span>
        </span>
        <span className="nx-scan__foot-actions">
          <button type="button" className="nx-scan__link" onClick={runScan} disabled={importing}>
            {zh ? '重新扫描' : 'Rescan'}
          </button>
          <span title={mode === 'link'
            ? (zh ? '软链到源目录，那边改了这边跟着变' : 'Symlink to the source; edits there show up here')
            : (zh ? '复制一份到 Neox，源目录以后改了这边不变' : 'Copy into Neox; later edits to the source do not affect it')}
          >
            <Segmented
              value={mode}
              onChange={(v) => setMode(v)}
              aria-label={zh ? '导入方式' : 'Import as'}
              options={[
                { value: 'copy', label: zh ? '复制' : 'Copy' },
                { value: 'link', label: zh ? '软链' : 'Link' },
              ]}
            />
          </span>
          <button
            type="button"
            className="nx-scan__cta nx-scan__cta--primary"
            disabled={importing || importable.length === 0}
            onClick={doImport}
          >
            {importing
              ? (zh ? '导入中…' : 'Importing…')
              : (zh ? `导入 ${importable.length} 个` : `Import ${importable.length}`)}
          </button>
        </span>
      </div>
    </div>
  );
};

export default SkillScanImport;
