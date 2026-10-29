
import React, { useCallback, useState } from 'react';

import { defaultIsZh } from '../../../hooks/useI18n';
import { dispatchOpFailed } from '../../../components/notifyEvents';
import { ScanBox, ScanDone, ScanLede, ScanSources, ScanStyles, scanPacing, type ScanSource } from './scanShell';

/** migrate:scan-providers 的返回形状 (electron/ipc/migrateHandlers.ts) */
export interface ScannedProvider {
  id: string;
  name: string;
  source: string;
  sourcePath: string;
  protocol: string;
  baseUrl?: string;
  hasKey: boolean;
  keyOrigin: string | null;
  keyEnvName?: string;
  keyPreview: string | null;
  alreadyImported: boolean;
}

interface Props {
  zh?: boolean;
  /** 导入成功后回调 (刷新列表 / 关闭向导) */
  onImported?: (count: number) => void;
  /** 'page' = 独占一屏; 'compact' = 引导页, 视觉更弱 */
  variant?: 'page' | 'compact';
}

const SOURCE_LABEL: Record<string, string> = {
  'Codex': 'Codex',
  'Claude Code': 'Claude Code',
  'CC Switch': 'CC Switch',
  'Environment': '环境变量',
};

/** 扫描时依次报出来的源 —— 跟 discoverProviders 实际读的地方一一对应, 不许编 */
const SOURCES: ScanSource[] = [
  { zh: '~/.codex/config.toml 与 auth.json', en: '~/.codex/config.toml and auth.json' },
  { zh: '~/.codex/.env 与 ~/.claude/.env', en: '~/.codex/.env and ~/.claude/.env' },
  { zh: '~/.claude/settings.json', en: '~/.claude/settings.json' },
  { zh: '~/.cc-switch', en: '~/.cc-switch' },
  { zh: 'shell 启动文件与环境变量', en: 'shell profiles and environment' },
];

/** 一个服务商归到上面哪一行 —— 按它的 sourcePath (discoverProviders 里写的真文件) */
function sourceRow(p: ScannedProvider): number {
  const f = (p.sourcePath ?? '').replace(/\\/g, '/');
  if (/\/\.codex\/(config\.toml|auth\.json)/.test(f)) return 0;
  if (/\/\.(codex|claude)\/\.env/.test(f)) return 1;
  if (f.includes('/.claude/')) return 2;
  if (f.includes('/.cc-switch')) return 3;
  if (p.source === 'Environment') return 4;
  return -1;
}

/** Key 是从哪读到的 —— 让用户能自己去核对, 而不是"它说有就有" */
const ORIGIN_LABEL: Record<string, { zh: string; en: string }> = {
  'config': { zh: '配置文件', en: 'config' },
  'dotenv': { zh: '.env', en: '.env' },
  'process-env': { zh: '环境变量', en: 'env' },
  'shell-profile': { zh: 'shell', en: 'shell' },
};

export const ProviderScanImport: React.FC<Props> = ({
  zh = defaultIsZh(),
  onImported,
  variant = 'page',
}) => {
  const [scan, setScan] = useState<ScannedProvider[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [manualKeys, setManualKeys] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [probing, setProbing] = useState(0);
  const [result, setResult] = useState<{ imported: number; failed: number } | null>(null);

  const runScan = useCallback(async () => {
    const api = (window as any).neox;
    if (typeof api?.migrateScanProviders !== 'function') { setScan([]); return; }
    setBusy(true);
    setResult(null);
    setProbing(0);
    const tick = window.setInterval(() => setProbing((n) => n + 1), 220);
    const startedAt = Date.now();
    try {
      const r = await api.migrateScanProviders();
      const list: ScannedProvider[] = r?.providers ?? [];
      setScan(list);
      /* 默认勾上所有能直接用的 —— 用户来这一屏就是为了导入, 让他取消勾比让他一个个勾快 */
      setPicked(new Set(list.filter((p) => p.hasKey && !p.alreadyImported).map((p) => p.id)));
    } catch {
      setScan([]);
    } finally {
      window.setTimeout(() => {
        window.clearInterval(tick);
        setBusy(false);
      }, scanPacing(SOURCES, startedAt));
    }
  }, []);

  const fresh = (scan ?? []).filter((p) => !p.alreadyImported);
  const ready = fresh.filter((p) => p.hasKey);
  const importable = Array.from(picked).filter((id) => {
    const p = fresh.find((x) => x.id === id);
    return !!p && (p.hasKey || (manualKeys[id] ?? '').trim().length > 0);
  });

  const doImport = useCallback(async () => {
    const api = (window as any).neox;
    if (typeof api?.migrateImportProviders !== 'function') return;
    setImporting(true);
    try {
      const r = await api.migrateImportProviders({ ids: importable, keys: manualKeys });
      setResult({ imported: r?.imported ?? 0, failed: r?.failed ?? 0 });
      const errs: string[] = Array.isArray(r?.errors) ? r.errors : [];
      const noKey: string[] = Array.isArray(r?.skippedNoKey) ? r.skippedNoKey : [];
      if ((r?.imported ?? 0) === 0 && (errs.length > 0 || noKey.length > 0)) {
        dispatchOpFailed({
          op: zh ? '导入服务商' : 'Import providers',
          message: errs[0] || (zh ? `${noKey.join(', ')}: 没读到 Key, 手填一个再导入` : `${noKey.join(', ')}: no key found`),
        });
      }
      if ((r?.imported ?? 0) > 0) {
        try { window.dispatchEvent(new CustomEvent('neox-providers-changed')); } catch { /* noop */ }
        onImported?.(r.imported);
        setScan((prev) => (prev ?? []).map((p) => (
          importable.includes(p.id) ? { ...p, alreadyImported: true } : p
        )));
        setPicked(new Set());
      }
    } catch (err: any) {
      dispatchOpFailed({ op: zh ? '导入服务商' : 'Import providers', message: err?.message ?? String(err) });
    } finally {
      setImporting(false);
    }
  }, [importable, manualKeys, onImported, zh]);

  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setPicked((prev) => (
    prev.size >= fresh.length ? new Set() : new Set(fresh.map((p) => p.id))
  ));



  const counts = SOURCES.map((_, i) => fresh.filter((p) => sourceRow(p) === i).length);
  const unit = { zh: '个', en: '' };
  const doneBar = result && result.imported > 0 ? (
    <ScanDone
      title={zh ? `已导入 ${result.imported} 个服务商` : `Imported ${result.imported} providers`}
      note={result.failed > 0
        ? (zh ? `${result.failed} 个没导进去，原因在弹出的提示里。` : `${result.failed} failed — see the notice for why.`)
        : (zh ? '在模型选择器里就能选到它们的模型了。' : 'Their models are now in the model picker.')}
    />
  ) : null;

  /* ── 起手 / 扫描中: 同一屏, 源清单原地亮 ── */
  if (scan === null || busy) {
    return (
      <div className={`nx-scan nx-scan--${variant}`}>
        <ScanStyles />
        <ScanLede
          title={busy ? (zh ? '正在扫描…' : 'Scanning…') : (zh ? '从本机导入' : 'Import from this Mac')}
          desc={zh
            ? '只在你点「扫描本机」时读一次下面这几处。界面上只显示掩码，密钥不会离开这台机器。'
            : 'Reads the places below once, only when you click Scan. Keys are only ever shown masked and never leave this machine.'}
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
    const already = (scan?.length ?? 0) - fresh.length;
    return (
      <div className={`nx-scan nx-scan--${variant}`}>
        <ScanStyles />
        {doneBar}
        <ScanLede
          title={result?.imported ? (zh ? '都导完了' : 'All imported') : (zh ? '没找到可导入的服务商' : 'Nothing to import')}
          desc={already > 0
            ? (zh ? `找到的 ${already} 个都已经在 Neox 里了。` : `All ${already} found are already in Neox.`)
            : (zh ? '在 Codex / Claude Code / CC Switch 里配过之后再来试。' : 'Set one up in Codex / Claude Code / CC Switch, then try again.')}
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
        title={zh ? `找到 ${fresh.length} 个服务商` : `${fresh.length} providers found`}
        desc={ready.length === fresh.length
          ? (zh ? 'Key 都读到了，勾选后直接导入即可。' : 'All keys were found — pick and import.')
          : (zh
            ? `${ready.length} 个读到了 Key，其余 ${fresh.length - ready.length} 个的 Key 不在配置里（端点已经对了，补一个 Key 就能用）。`
            : `${ready.length} have keys; the other ${fresh.length - ready.length} store theirs elsewhere — paste a key to use them.`)}
      />
      <ScanSources sources={SOURCES} zh={zh} counts={counts} unit={unit} />

      <div className="nx-scan__rows">
        {fresh.map((p, i) => {
          const on = picked.has(p.id);
          return (
            <div
              key={p.id}
              className={`nx-scan__item${on ? '' : ' is-off'}`}
              style={{ animationDelay: `${Math.min(i, 8) * 28}ms` }}
              onClick={() => toggle(p.id)}
              role="checkbox"
              aria-checked={on}
              tabIndex={0}
              onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); toggle(p.id); } }}
              title={p.sourcePath}
            >
              <ScanBox on={on} />
              <div className="nx-scan__item-main">
                <div className="nx-scan__item-title">
                  <span>{p.name}</span>
                  <span className="nx-scan__pill">{SOURCE_LABEL[p.source] ?? p.source}</span>
                </div>
                {p.baseUrl && <div className="nx-scan__item-path">{p.baseUrl}</div>}
              </div>
              <span className="nx-scan__item-aside" onClick={(e) => { if (!p.hasKey) e.stopPropagation(); }}>
                {p.hasKey ? (
                  <span className="nx-scan__meta">
                    {p.keyPreview}
                    {p.keyOrigin && ORIGIN_LABEL[p.keyOrigin] && (
                      <span className="nx-scan__meta-dim">
                        {zh ? ORIGIN_LABEL[p.keyOrigin].zh : ORIGIN_LABEL[p.keyOrigin].en}
                      </span>
                    )}
                  </span>
                ) : (
                  <input
                    type="password"
                    className="nx-scan__input"
                    placeholder={zh
                      ? (p.keyEnvName ? `补 Key · ${p.keyEnvName}` : '补一个 Key')
                      : (p.keyEnvName ? `Key · ${p.keyEnvName}` : 'Paste a key')}
                    value={manualKeys[p.id] ?? ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      setManualKeys((prev) => ({ ...prev, [p.id]: v }));
                      /* 填了 Key 就顺手勾上 —— 填完还得回头去勾是多余的一步 */
                      if (v.trim()) setPicked((prev) => (prev.has(p.id) ? prev : new Set(prev).add(p.id)));
                    }}
                  />
                )}
              </span>
            </div>
          );
        })}
      </div>

      <div className="nx-scan__foot nx-scan__foot--sticky">
        <span className="nx-scan__foot-actions">
          <button type="button" className="nx-scan__link" onClick={toggleAll}>
            {picked.size >= fresh.length ? (zh ? '全不选' : 'Select none') : (zh ? '全选' : 'Select all')}
          </button>
          <span className="nx-scan__picked">{zh ? <>可导入 <b>{importable.length}</b> / {fresh.length}</> : <><b>{importable.length}</b> of {fresh.length} ready</>}</span>
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
              : (zh ? `导入 ${importable.length} 个` : `Import ${importable.length}`)}
          </button>
        </span>
      </div>
    </div>
  );
};

export default ProviderScanImport;
