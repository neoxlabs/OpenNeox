/* 本地语音: 引擎包 + 模型的状态 / 下载 / 删除 / 导入 —— 语音输入和语音播报两块共用一份 (同一个引擎, 同一个模型目录)。
 * 后端: electron/services/localVoiceService.ts (模型) · assetPackService.ts (引擎包) · localAsr.ts (导入) */
import { useCallback, useEffect, useState } from 'react';

export interface LocalModelRow {
  id: string;
  title: string;
  sizeMB: number;
  installed: boolean;
  active?: boolean;
  partialPct?: number;
  custom?: boolean;
  streaming?: boolean;
}

export interface EngineState {
  available: boolean;
  installed: boolean;
  /** 装过旧版本 (包换代了) —— 写「有更新」而不是「未安装」 */
  outdated: boolean;
  sizeMB: number;
}

type Api = {
  localvoiceStatus?: () => Promise<{ supported: boolean; models: LocalModelRow[] }>;
  localvoiceDownload?: (id: string, source: string) => Promise<{ ok?: boolean; error?: string }>;
  localvoicePause?: (id: string) => Promise<unknown>;
  localvoiceRemove?: (id: string) => Promise<unknown>;
  localvoiceImportModel?: () => Promise<{ ok: boolean; canceled?: boolean; error?: string; title?: string; streaming?: boolean }>;
  onLocalvoiceProgress?: (cb: (d: { modelId: string; pct?: number; done?: boolean; error?: string; paused?: boolean }) => void) => () => void;
  assetpackStatus?: () => Promise<{ packs: Array<{ id: string; available: boolean; installed: boolean; outdated?: boolean; sizeBytes: number }> }>;
  assetpackDownload?: (id: string) => Promise<{ ok?: boolean; error?: string }>;
  onAssetpackProgress?: (cb: (d: { packId: string; pct: number }) => void) => () => void;
};
const api = (): Api => (window as unknown as { neox?: Api }).neox ?? {};

export type DownloadSource = 'auto' | 'cn' | 'global';

export function useLocalVoice() {
  const [supported, setSupported] = useState(true);
  const [models, setModels] = useState<LocalModelRow[]>([]);
  const [engine, setEngine] = useState<EngineState | null>(null);
  const [enginePct, setEnginePct] = useState<number | null>(null);
  const [engineErr, setEngineErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [source, setSource] = useState<DownloadSource>('auto');

  const refresh = useCallback(async () => {
    try {
      const r = await api().localvoiceStatus?.();
      if (r) { setSupported(r.supported); setModels(r.models); }
      const p = (await api().assetpackStatus?.())?.packs.find(x => x.id === 'voice-engine');
      setEngine(p ? { available: p.available, installed: p.installed, outdated: !!p.outdated, sizeMB: Math.round(p.sizeBytes / 1048576) } : null);
    } catch { /* 读不到状态 = 当不支持处理, 下面各块自己不渲染 */ }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const offModel = api().onLocalvoiceProgress?.((d) => {
      const clear = () => setProgress(p => { const n = { ...p }; delete n[d.modelId]; return n; });
      if (d.error) { setErrors(e => ({ ...e, [d.modelId]: d.error! })); clear(); return; }
      if (d.paused || d.done) { clear(); void refresh(); return; }
      if (typeof d.pct === 'number') setProgress(p => ({ ...p, [d.modelId]: d.pct! }));
    });
    const offEngine = api().onAssetpackProgress?.((d) => {
      if (d.packId !== 'voice-engine') return;
      setEnginePct(d.pct >= 100 ? null : d.pct);
      if (d.pct >= 100) void refresh();
    });
    return () => { offModel?.(); offEngine?.(); };
  }, [refresh]);

  const downloadEngine = useCallback(async () => {
    setEngineErr(null);
    setEnginePct(0);
    const r = await api().assetpackDownload?.('voice-engine');
    setEnginePct(null);
    if (r && !r.ok) setEngineErr(r.error || '下载失败');
    void refresh();
  }, [refresh]);

  const download = useCallback(async (id: string) => {
    setErrors(e => { const n = { ...e }; delete n[id]; return n; });
    setProgress(p => ({ ...p, [id]: 0 }));
    const r = await api().localvoiceDownload?.(id, source);
    if (r && !r.ok && r.error !== 'paused') {
      setErrors(e => ({ ...e, [id]: r.error || '下载失败' }));
      setProgress(p => { const n = { ...p }; delete n[id]; return n; });
    }
    void refresh();
  }, [source, refresh]);

  const pause = useCallback(async (id: string) => { await api().localvoicePause?.(id); }, []);
  const remove = useCallback(async (id: string) => { await api().localvoiceRemove?.(id); void refresh(); }, [refresh]);
  const importModel = useCallback(async () => {
    const r = await api().localvoiceImportModel?.();
    void refresh();
    return r;
  }, [refresh]);

  /** 引擎能用 (模型下了还得有它才跑得起来) */
  const engineReady = !engine?.available || engine.installed;

  return { supported, models, engine, engineReady, enginePct, engineErr, progress, errors, source, setSource, refresh, downloadEngine, download, pause, remove, importModel };
}

export type LocalVoice = ReturnType<typeof useLocalVoice>;
