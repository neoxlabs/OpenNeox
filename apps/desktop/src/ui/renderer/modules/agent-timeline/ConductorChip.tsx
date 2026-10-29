import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NEOX_CLOUD_PAYG_PROVIDER_ID, NEOX_CLOUD_PROVIDER_ID } from '../../../shared/neoxCloud';
import { isByokPinned, getByokHiddenModels } from '../../state/byokPickerPrefs';
import './conductor-chip.css';

interface PickerModelLike {
  id: string;
  name: string;
  providerId?: string;
  provider?: string;
  isAutoRouted?: boolean;
  payAsYouGoPrice?: { inputPerMtok: number; outputPerMtok: number } | null;
}

type Source = 'sub' | 'payg' | 'byok';
const sourceOf = (m: PickerModelLike): Source =>
  m.providerId === NEOX_CLOUD_PROVIDER_ID ? 'sub' : m.providerId === NEOX_CLOUD_PAYG_PROVIDER_ID ? 'payg' : 'byok';

interface ModelSpend { usd: number; requests: number; unpriced?: boolean }
interface BudgetSnapshot {
  limitUsd: number;
  spentUsd: number;
  ratio: number;
  exceeded: boolean;
  byModel: Record<string, ModelSpend>;
}
export interface SavedConductor { limitUsd: number; workerId: string }

export const CONDUCTOR_OPEN_EVENT = 'neox:conductor-open';
const RECOMMENDED_WORKER = /deepseek-v4\.1-flash/i;
const PRESETS = [0, 1, 2, 5];
const keyOf = (sid: string) => `neox.conductor.v1:${sid}`;
const PENDING_SID = '__pending__';
export const readSavedConductor = (sid: string | null): SavedConductor | null => {
  try { const v = localStorage.getItem(keyOf(sid ?? PENDING_SID)); return v ? JSON.parse(v) as SavedConductor : null; } catch { return null; }
};
const writeSaved = (sid: string, v: SavedConductor | null) => {
  try { if (v) localStorage.setItem(keyOf(sid), JSON.stringify(v)); else localStorage.removeItem(keyOf(sid)); } catch { /* 存不了就只在本次生效 */ }
  window.dispatchEvent(new CustomEvent('neox:conductor-changed', { detail: { sessionId: sid } }));
};
const money = (n: number) => (n >= 10 ? `$${n.toFixed(1)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const shortName = (n: string) => n.replace(/^claude-/, '').replace(/-sol$|-astra$|-terra$/, '');
const api = () => (window as unknown as { neox?: { sessionBudget?: (sid: string, cmd: string, cfg?: unknown) => Promise<BudgetSnapshot | null> } }).neox;

export const ConductorChip: React.FC<{
  sessionId: string | null;
  models: PickerModelLike[];
  /** 输入框里选的模型 = 负责人 */
  leadModelName?: string;
  leadModelId?: string;
  /** 在面板里换了指挥模型 → 就是换输入框的模型 (同一个东西) */
  onSelectLead?: (m: PickerModelLike) => void;
  isZh: boolean;
}> = ({ sessionId, models, leadModelName, leadModelId, onSelectLead, isZh }) => {
  const t = (zh: string, en: string) => (isZh ? zh : en);
  const [snap, setSnap] = useState<BudgetSnapshot | null>(null);
  const [saved, setSaved] = useState<SavedConductor | null>(null);
  const [open, setOpen] = useState(false);
  const [draftLimit, setDraftLimit] = useState('0');
  const [draftWorker, setDraftWorker] = useState('');
  const [draftLead, setDraftLead] = useState('');
  /* 正在给哪张卡挑模型, 和挑的是哪种来源 */
  const [slot, setSlot] = useState<'lead' | 'worker'>('worker');
  const [tab, setTab] = useState<Source>('payg');
  const chipRef = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const prices = useMemo(() => {
    const out: Record<string, { input: number; output: number }> = {};
    for (const m of models) if (m.payAsYouGoPrice) out[m.name] = { input: m.payAsYouGoPrice.inputPerMtok, output: m.payAsYouGoPrice.outputPerMtok };
    return out;
  }, [models]);
  /* 三种来源各一份: 订阅 = 套餐里的; 按量 = 平台目录 (开关打开才有); BYOK = 用户自己 key 的,
   * 跟主模型选择器一样只放在「显示控制」里勾上的那些。推荐的 DeepSeek Flash 置顶, 按量按价格从低到高。 */
  const bySource = useMemo(() => {
    const out: Record<Source, PickerModelLike[]> = { sub: [], payg: [], byok: [] };
    const seen = new Set<string>();
    for (const m of models) {
      if (m.isAutoRouted || seen.has(m.id)) continue;
      const s = sourceOf(m);
      /* 正在用的那个 (输入框的指挥模型 / 存着的干活模型) 就算在显示控制里藏了也要列出来, 不然看不出选的是谁 */
      if (s === 'byok' && m.id !== leadModelId && m.id !== saved?.workerId) {
        const hidden = isByokPinned(m.providerId ?? '') ? getByokHiddenModels(m.providerId ?? '') : null;
        if (!hidden || hidden.has(m.name)) continue;
      }
      seen.add(m.id);
      out[s].push(m);
    }
    const rec = (m: PickerModelLike) => Number(RECOMMENDED_WORKER.test(m.name));
    out.sub.sort((a, b) => rec(b) - rec(a));
    out.payg.sort((a, b) => rec(b) - rec(a) || ((a.payAsYouGoPrice?.outputPerMtok ?? 0) - (b.payAsYouGoPrice?.outputPerMtok ?? 0)));
    return out;
  }, [models, leadModelId, saved?.workerId]);
  const sources = (['sub', 'payg', 'byok'] as Source[]).filter((s) => bySource[s].length > 0);
  const byId = (id: string) => models.find((m) => m.id === id);
  const defaultWorkerFor = useCallback((leadId: string) => {
    const lead = byId(leadId);
    const order: Source[] = lead ? [sourceOf(lead), 'sub', 'payg', 'byok'] : ['sub', 'payg', 'byok'];
    for (const s of order) {
      const hit = bySource[s].find((m) => m.id !== leadId && RECOMMENDED_WORKER.test(m.name));
      if (hit) return hit.id;
    }
    for (const s of order) {
      const hit = bySource[s].find((m) => m.id !== leadId);
      if (hit) return hit.id;
    }
    return '';
  }, [bySource, models]); // eslint-disable-line react-hooks/exhaustive-deps
  const recommendedId = defaultWorkerFor(leadModelId ?? '');

  const apply = useCallback(async (sid: string, cfg: SavedConductor) => {
    const w = models.find((m) => m.id === cfg.workerId);
    if (!w) return;
    const s = await api()?.sessionBudget?.(sid, 'set', {
      limitUsd: cfg.limitUsd,
      worker: { providerId: w.providerId ?? 'neox-cloud-payg', modelName: w.name },
      prices,
    });
    setSnap(s ?? null);
  }, [models, prices]);

  /* 切会话: 读本机存的设置; worker 那边没有 (应用重启过) 就重新挂上 */
  useEffect(() => {
    setSnap(null); setOpen(false);
    let sv = readSavedConductor(sessionId);
    /* 首页存的「待用」设置: 新会话一出现就搬过去 (只搬一次, 搬完清掉, 不会挂到之后打开的老会话上) */
    if (sessionId && !sv) {
      const pending = readSavedConductor(null);
      if (pending) { writeSaved(sessionId, pending); writeSaved(PENDING_SID, null); sv = pending; }
    }
    setSaved(sv);
    if (!sessionId || !sv) return;
    void api()?.sessionBudget?.(sessionId, 'get').then((s) => { if (s) setSnap(s); else void apply(sessionId, sv); });
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!sessionId || !saved) return;
    const tick = () => { void api()?.sessionBudget?.(sessionId, 'get').then((s) => setSnap(s ?? null)); };
    const id = window.setInterval(tick, 2000);
    return () => window.clearInterval(id);
  }, [sessionId, saved]);

  const pickSlot = useCallback((s: 'lead' | 'worker', id: string) => {
    setSlot(s);
    const m = byId(id);
    setTab(m ? sourceOf(m) : (sources[0] ?? 'payg'));
  }, [models, sources]); // eslint-disable-line react-hooks/exhaustive-deps

  const openPanel = useCallback((at?: DOMRect | null) => {
    const worker = saved?.workerId && byId(saved.workerId) ? saved.workerId : recommendedId;
    setDraftLimit(String(saved?.limitUsd ?? 0));
    setDraftWorker(worker);
    setDraftLead(leadModelId ?? '');
    pickSlot('worker', worker);
    setAnchor(at ?? chipRef.current?.getBoundingClientRect() ?? null);
    setOpen(true);
  }, [saved, recommendedId, leadModelId, pickSlot]); // eslint-disable-line react-hooks/exhaustive-deps

  /* 「+」菜单 → 打开面板; 没有标签可锚时贴着输入框 */
  useEffect(() => {
    const onOpen = () => {
      /* 从「+」菜单来: 贴着「+」弹 (菜单本来就从那里出来), 不再贴整个输入框右沿飘到右上角 */
      const plus = document.querySelector('.atl-composer__plus-wrap') as HTMLElement | null;
      const box = document.querySelector('.atl-composer__box') as HTMLElement | null;
      openPanel(plus?.getBoundingClientRect() ?? chipRef.current?.getBoundingClientRect() ?? box?.getBoundingClientRect() ?? null);
    };
    window.addEventListener(CONDUCTOR_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(CONDUCTOR_OPEN_EVENT, onOpen);
  }, [openPanel]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => document.querySelector('.atl-conductor-pop__model.is-on')?.scrollIntoView({ block: 'nearest' }));
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const save = async () => {
    if (!draftWorker) return;
    if (draftLead && draftLead !== leadModelId) {
      const lead = byId(draftLead);
      if (lead) onSelectLead?.(lead);
    }
    const cfg: SavedConductor = { limitUsd: Math.max(0, Number(draftLimit) || 0), workerId: draftWorker };
    writeSaved(sessionId ?? PENDING_SID, cfg); setSaved(cfg);
    if (sessionId) await apply(sessionId, cfg);
    setOpen(false);
  };
  const turnOff = async () => {
    writeSaved(sessionId ?? PENDING_SID, null); setSaved(null); setSnap(null); setOpen(false);
    if (sessionId) await api()?.sessionBudget?.(sessionId, 'clear');
  };

  const active = !!saved;
  const limited = !!snap && snap.limitUsd > 0;
  const ratio = limited ? Math.min(1, snap!.ratio) : 0;
  const level = snap?.exceeded ? 'over' : ratio >= 0.8 ? 'warn' : 'ok';
  const rows = snap ? Object.entries(snap.byModel).sort((a, b) => b[1].usd - a[1].usd) : [];
  const workerName = models.find((m) => m.id === saved?.workerId)?.name;
  const isPreset = PRESETS.includes(Number(draftLimit)) && draftLimit !== '';

  return (
    <>
      {active && (
        <span ref={chipRef} className={`atl-conductor-chip is-${level}`}>
          <button type="button" className="atl-conductor-chip__main" onClick={() => openPanel()}
            title={t('指挥模式: 输入框里的模型负责规划和验收, 便宜模型写代码', 'Conductor: the selected model plans and reviews, a cheap model writes the code')}>
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden><path d="M3 13 11.5 4.5M10 3.2l2.8 2.8M2.6 13.4l1.2.4.4 1.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span>{t('指挥', 'Conductor')}</span>
            {snap && <span className="atl-conductor-chip__money">{money(snap.spentUsd)}{limited && <em> / {money(snap.limitUsd)}</em>}</span>}
          </button>
          <button type="button" className="atl-conductor-chip__x" onClick={() => void turnOff()} aria-label={t('关闭指挥模式', 'Turn off conductor mode')} title={t('关闭指挥模式', 'Turn off')}>
            <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden><path d="M3 3l6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </span>
      )}
      {open && anchor && createPortal(
        <>
          <div className="atl-conductor-scrim" onClick={() => setOpen(false)} />
          {/* 往空间大的一侧弹, 高度不超过那一侧 (首屏输入框在正中, 上下都可能放不下整块) —— 超出的在面板里滚 */}
          <div className="atl-conductor-pop" style={{
            /* 左沿跟触发点对齐 (「+」/ 标签都在输入框左侧), 右边放不下才往左挪 */
            left: Math.max(12, Math.min(anchor.left, window.innerWidth - 372)),
            ...(anchor.top >= window.innerHeight - anchor.bottom
              /* 往上弹时让出顶栏 (中间那颗状态岛), 放不下的在面板里滚 */
              ? { bottom: window.innerHeight - anchor.top + 10, maxHeight: anchor.top - 64 }
              : { top: anchor.bottom + 10, maxHeight: window.innerHeight - anchor.bottom - 22 }),
          }}>
            <div className="atl-conductor-pop__head">
              <div className="atl-conductor-pop__title">{t('指挥模式', 'Conductor mode')}</div>
              {limited && <div className={`atl-conductor-pop__meter is-${level}`}><b>{money(snap!.spentUsd)}</b><span> / {money(snap!.limitUsd)}</span></div>}
            </div>
            {(() => {
              const srcLabel: Record<Source, string> = { sub: t('订阅', 'Plan'), payg: t('按量', 'Pay-as-you-go'), byok: 'BYOK' };
              const card = (s: 'lead' | 'worker', id: string, role: string, duty: string) => {
                const m = byId(id);
                const name = m?.name ?? (s === 'lead' ? leadModelName : undefined);
                return (
                  <button type="button" className={`atl-conductor-pop__role${slot === s ? ' is-on' : ''}`} onClick={() => pickSlot(s, id)}
                    title={t('点一下换模型', 'Click to change the model')}>
                    <span>{role}{m && <em className={`is-${sourceOf(m)}`}>{srcLabel[sourceOf(m)]}</em>}</span>
                    <b>{name ? shortName(name) : '—'}</b>
                    <small>{duty}</small>
                  </button>
                );
              };
              const current = slot === 'lead' ? draftLead : draftWorker;
              const list = bySource[tab].filter((m) => (slot === 'worker' ? m.id !== draftLead : true));
              const note = tab === 'sub'
                ? t('用套餐额度', 'Uses your plan quota')
                : tab === 'payg' ? t('每百万 token 输入 / 输出, 从余额扣', 'per 1M tokens in / out, from balance') : t('用你自己的 API Key', 'Your own API keys');
              return (
                <>
                  <div className="atl-conductor-pop__roles">
                    {card('lead', draftLead, t('指挥', 'Lead'), t('规划 · 派活 · 验收', 'plan · delegate · review'))}
                    <i aria-hidden>→</i>
                    {card('worker', draftWorker, t('干活', 'Workers'), t('写代码 · 跑测试', 'code · tests'))}
                  </div>

                  <div className="atl-conductor-pop__label">{slot === 'lead' ? t('指挥模型', 'Lead model') : t('干活模型', 'Worker model')}<span>{note}</span></div>
                  {sources.length > 1 && (
                    <div className="atl-conductor-pop__seg atl-conductor-pop__src" role="tablist">
                      {sources.map((s) => (
                        <button key={s} type="button" role="tab" aria-selected={tab === s} className={tab === s ? 'is-on' : ''} onClick={() => setTab(s)}>{srcLabel[s]}</button>
                      ))}
                    </div>
                  )}
                  <div className="atl-conductor-pop__models" role="radiogroup">
                    {list.length === 0 && <div className="atl-conductor-pop__empty">{t('这一类里没有可选的模型', 'No models here')}</div>}
                    {list.map((m) => {
                      const on = current === m.id;
                      return (
                        <button key={m.id} type="button" role="radio" aria-checked={on} className={`atl-conductor-pop__model${on ? ' is-on' : ''}`}
                          onClick={() => {
                            if (slot === 'lead') {
                              setDraftLead(m.id);
                              /* 干活跟指挥撞成同一个了 → 干活换回推荐的 */
                              if (draftWorker === m.id) setDraftWorker(defaultWorkerFor(m.id));
                            } else {
                              setDraftWorker(m.id);
                            }
                          }}>
                          <i className="atl-conductor-pop__radio" />
                          <span className="atl-conductor-pop__model-name">{m.name}{slot === 'worker' && RECOMMENDED_WORKER.test(m.name) && <em>{t('推荐', 'Recommended')}</em>}</span>
                          <span className="atl-conductor-pop__model-price">
                            {m.payAsYouGoPrice ? `$${m.payAsYouGoPrice.inputPerMtok} / $${m.payAsYouGoPrice.outputPerMtok}` : tab === 'byok' ? (m.provider ?? '') : ''}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </>
              );
            })()}

            <div className="atl-conductor-pop__label">{t('花费上限', 'Spending limit')}</div>
            <div className="atl-conductor-pop__seg" role="radiogroup">
              {PRESETS.map((p) => {
                const on = isPreset && Number(draftLimit) === p;
                return <button key={p} type="button" role="radio" aria-checked={on} className={on ? 'is-on' : ''} onClick={() => setDraftLimit(String(p))}>{p === 0 ? t('不限', 'None') : `$${p}`}</button>;
              })}
              <label className={`atl-conductor-pop__custom${isPreset ? '' : ' is-on'}`}>
                <span>$</span>
                <input inputMode="decimal" placeholder={t('自定', 'Other')} value={isPreset ? '' : draftLimit} onChange={(e) => setDraftLimit(e.target.value.replace(/[^\d.]/g, ''))} />
              </label>
            </div>

            {snap && rows.length > 0 && (
              <div className="atl-conductor-pop__bill">
                {rows.map(([name, m]) => (
                  <div key={name} className="atl-conductor-pop__row">
                    <span>{name}{name === workerName ? <em>{t(' 干活', ' worker')}</em> : null}</span>
                    <span>{m.requests}{t(' 次', '×')}</span>
                    <b>{m.unpriced ? '—' : money(m.usd)}</b>
                  </div>
                ))}
                <div className="atl-conductor-pop__row is-total"><span>{t('合计', 'Total')}</span><span /><b>{money(snap.spentUsd)}</b></div>
                <div className="atl-conductor-pop__note">{t('按官方价估算; 实际以平台账单为准 (夜间半价等优惠不计入)。', 'Estimated at list price; your bill is authoritative (off-peak discounts not counted).')}</div>
              </div>
            )}

            <div className="atl-conductor-pop__actions">
              {active && <button type="button" className="is-ghost" onClick={() => void turnOff()}>{t('关闭指挥模式', 'Turn off')}</button>}
              <button type="button" className="is-primary" disabled={!draftWorker} onClick={() => void save()}>{active ? t('更新', 'Update') : t('开启', 'Turn on')}</button>
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
};
