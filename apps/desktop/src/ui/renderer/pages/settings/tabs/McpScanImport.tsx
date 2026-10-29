
import React, { useCallback, useMemo, useState } from 'react';

import { defaultIsZh } from '../../../hooks/useI18n';
import { ScanBox, ScanChips, ScanDone, ScanLede, ScanSources, ScanStyles, scanPacing, type ScanSource } from './scanShell';

type Candidate = Awaited<ReturnType<NonNullable<Window['neox']['migrateScanMcp']>>>[number];

/* 跟 core/migrate/discoverMcp.ts discoverExternalMcpServers 实际读的文件一一对应, 顺序也一样 */
const SOURCES: ScanSource[] = [
  { zh: '~/.claude.json（含各项目的）', en: '~/.claude.json (incl. per-project)' },
  { zh: 'Claude Desktop 配置', en: 'Claude Desktop config' },
  { zh: '~/.cursor/mcp.json', en: '~/.cursor/mcp.json' },
  { zh: '~/.codex/config.toml', en: '~/.codex/config.toml' },
];
const SOURCE_ROW: Record<string, number> = { 'Claude Code': 0, 'Claude Desktop': 1, 'Cursor': 2, 'Codex': 3 };

interface Props {
  zh?: boolean;
  onImported?: (count: number) => void;
}

export const McpScanImport: React.FC<Props> = ({ zh = defaultIsZh(), onImported }) => {
  const [scan, setScan] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('all');
  const [withEnv, setWithEnv] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; failed: number; errors: string[]; envStripped: string[] } | null>(null);

  const runScan = useCallback(async () => {
    const api = window.neox;
    if (typeof api?.migrateScanMcp !== 'function') { setScan([]); return; }
    setBusy(true);
    setResult(null);
    setProbing(0);
    setFilter('all');
    const tick = window.setInterval(() => setProbing((n) => n + 1), 220);
    const startedAt = Date.now();
    try {
      const arr = (await api.migrateScanMcp()) ?? [];
      setScan(arr);
      /* 源里关着的默认不勾 —— 用户在那边就没打算跑它 */
      setPicked(new Set(arr.filter((c) => !c.alreadyImported && !c.disabledAtSource).map((c) => c.id)));
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
    for (const c of fresh) { const i = SOURCE_ROW[c.source]; if (i !== undefined) n[i]++; }
    return n;
  }, [fresh]);
  const chips = useMemo(() => {
    const out = [{ value: 'all', label: zh ? '全部' : 'All', count: fresh.length }];
    const sources = Array.from(new Set(fresh.map((c) => c.source)));
    if (sources.length > 1) for (const s of sources) out.push({ value: s, label: s, count: fresh.filter((c) => c.source === s).length });
    return out;
  }, [fresh, zh]);
  const shown = fresh.filter((c) => filter === 'all' || c.source === filter);
  const importable = fresh.filter((c) => picked.has(c.id)).map((c) => c.id);
  const pickedEnvKeys = fresh.filter((c) => picked.has(c.id)).reduce((n, c) => n + c.envKeys.length, 0);

  const doImport = useCallback(async () => {
    const api = window.neox;
    if (typeof api?.migrateApply !== 'function') return;
    setImporting(true);
    try {
      const r = await api.migrateApply({ mcpIds: importable, withEnv });
      setResult({ imported: r?.imported ?? 0, failed: r?.failed ?? 0, errors: r?.errors ?? [], envStripped: r?.envStripped ?? [] });
      if ((r?.imported ?? 0) > 0) {
        const done = new Set(importable);
        setScan((prev) => (prev ?? []).map((c) => (done.has(c.id) ? { ...c, alreadyImported: true } : c)));
        setPicked(new Set());
        onImported?.(r.imported);
      }
    } catch (e: any) {
      setResult({ imported: 0, failed: importable.length, errors: [e?.message ?? String(e)], envStripped: [] });
    } finally {
      setImporting(false);
    }
  }, [importable, withEnv, onImported]);

  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allShownPicked = shown.length > 0 && shown.every((c) => picked.has(c.id));
  const toggleShown = () => setPicked((prev) => {
    const next = new Set(prev);
    for (const c of shown) { if (allShownPicked) next.delete(c.id); else next.add(c.id); }
    return next;
  });

  const unit = { zh: '个', en: '' };
  const doneBar = result && (result.imported > 0 || result.failed > 0) ? (
    <ScanDone
      bad={result.imported === 0}
      title={result.imported > 0
        ? (zh ? `已导入 ${result.imported} 个 MCP 服务器` : `Imported ${result.imported} MCP servers`)
        : (zh ? '一个都没导进去' : 'Nothing was imported')}
      note={result.failed > 0
        ? (result.errors[0] ?? '')
        : result.envStripped.length > 0
          ? (zh ? `没带环境变量：${result.envStripped.join('、')}。要用的话在服务器详情里补上。` : `Env not copied: ${result.envStripped.join(', ')}. Add it in the server's settings if needed.`)
          : (zh ? '导进来默认不自动连接，在列表里点一下就连。' : 'They don’t auto-connect — click one in the list to connect.')}
    />
  ) : null;

  /* ── 起手 / 扫描中 ── */
  if (scan === null || busy) {
    return (
      <div className="nx-scan nx-scan--page">
        <ScanStyles />
        <ScanLede
          title={busy ? (zh ? '正在扫描…' : 'Scanning…') : (zh ? '从其他工具导入 MCP 服务器' : 'Import MCP servers from other tools')}
          desc={zh
            ? '只在你点「扫描本机」时读一次下面这几处。导入到所有项目，源配置不动；环境变量（常含密钥）默认不带。'
            : 'Reads the places below once, only when you click Scan. Imports for all projects and leaves the source alone; env vars (often secrets) are left out by default.'}
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
      <div className="nx-scan nx-scan--page">
        <ScanStyles />
        {doneBar}
        <ScanLede
          title={result?.imported ? (zh ? '都导完了' : 'All imported') : (zh ? '没找到可导入的 MCP 服务器' : 'Nothing to import')}
          desc={already > 0
            ? (zh ? `找到的 ${already} 个都已经在 Neox 里了。` : `All ${already} found are already in Neox.`)
            : (zh ? '在 Claude Code / Claude Desktop / Cursor / Codex 里配过 MCP 之后再来试。' : 'Configure MCP in Claude Code / Claude Desktop / Cursor / Codex, then try again.')}
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
        title={zh ? `找到 ${fresh.length} 个可导入的 MCP 服务器` : `${fresh.length} MCP servers ready to import`}
        desc={zh
          ? `源里关着的默认不勾。${already > 0 ? `另有 ${already} 个已经在 Neox 里，不再列出。` : ''}`
          : `Ones turned off at the source start unticked.${already > 0 ? ` ${already} already in Neox are hidden.` : ''}`}
      />
      <ScanSources sources={SOURCES} zh={zh} counts={counts} unit={unit} />

      {chips.length > 2 && (
        <div className="nx-scan__filters">
          <ScanChips value={filter} options={chips} onChange={setFilter} />
        </div>
      )}

      <div className="nx-scan__rows">
        {shown.map((c, i) => {
          const on = picked.has(c.id);
          return (
            <div
              key={c.id}
              className={`nx-scan__item${on ? '' : ' is-off'}`}
              style={{ animationDelay: `${Math.min(i, 10) * 24}ms` }}
              onClick={() => toggle(c.id)}
              role="checkbox"
              aria-checked={on}
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(c.id); } }}
              title={c.sourceProject ? `${c.sourcePath} · ${c.sourceProject}` : c.sourcePath}
            >
              <ScanBox on={on} />
              <div className="nx-scan__item-main">
                <div className="nx-scan__item-title">
                  <span>{c.name || c.id}</span>
                  <span className="nx-scan__pill">{c.source}</span>
                  <span className="nx-scan__pill">{String(c.transport).toUpperCase()}</span>
                  {c.disabledAtSource && <span className="nx-scan__pill">{zh ? '源里已关' : 'Off at source'}</span>}
                </div>
                {c.summary && <div className="nx-scan__item-path">{c.summary}</div>}
                {c.sourceProject && (
                  <div className="nx-scan__item-sub">{zh ? `来自项目 ${c.sourceProject}` : `From project ${c.sourceProject}`}</div>
                )}
              </div>
              {c.envKeys.length > 0 && (
                <span className="nx-scan__item-aside nx-scan__meta" title={c.envKeys.join(', ')}>
                  <span className="nx-scan__meta-dim">{zh ? `${c.envKeys.length} 个环境变量` : `${c.envKeys.length} env`}</span>
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="nx-scan__foot nx-scan__foot--sticky">
        <span className="nx-scan__foot-actions">
          <button type="button" className="nx-scan__link" onClick={toggleShown}>
            {allShownPicked ? (zh ? '全不选' : 'Select none') : (zh ? '全选' : 'Select all')}
          </button>
          <span className="nx-scan__picked">{zh ? <>已选 <b>{importable.length}</b> / {fresh.length}</> : <><b>{importable.length}</b> of {fresh.length} picked</>}</span>
        </span>
        <span className="nx-scan__foot-actions">
          {pickedEnvKeys > 0 && (
            <span
              className="nx-scan__envtoggle"
              role="checkbox"
              aria-checked={withEnv}
              tabIndex={0}
              onClick={() => setWithEnv((v) => !v)}
              onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setWithEnv((v) => !v); } }}
              title={zh ? '会在 ~/.neox/mcp.json 里多存一份明文' : 'Stores another plaintext copy in ~/.neox/mcp.json'}
            >
              <ScanBox on={withEnv} />
              {zh ? `带上环境变量（${pickedEnvKeys} 个，可能含密钥）` : `Include env (${pickedEnvKeys}, may contain secrets)`}
            </span>
          )}
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
              : (zh ? `导入 ${importable.length} 个` : `Import ${importable.length}`)}
          </button>
        </span>
      </div>
    </div>
  );
};

export default McpScanImport;
