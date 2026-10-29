/**
 * 日程 —— 它替你盯着的时刻。按 今天 / 明天 / 之后 分组, 一条一行 (大号时间 + 事)。
 * 闭环: 「+」直接新建 (常用时刻一点即选) · 点一条展开: 改时间 / 到点打电话还是推送 / 取消。
 * 云端 Pilot 直接写云端账本 (不经模型, 点了就成); 本机 Pilot 只读本机提醒库, 能取消。
 */
import React, { useEffect, useRef, useState } from 'react';
import { StageIcon } from '../stage/StageCards';
import * as S from '../../shell/shellIcons';
import { boardApi, dayBucket, SectionHead, splitWhen, WhenPicker, type BoardReminder } from './boardKit';
import { ART } from './art';

interface LifeEventsApi {
  listForSession?: (id: string) => Promise<{ success: boolean; events?: BoardReminder[] }>;
  onChanged?: (cb: () => void) => () => void;
  delete?: (id: string) => Promise<{ success: boolean }>;
}
const lifeApi = () => (window as unknown as { neox?: { lifeEvents?: LifeEventsApi } }).neox?.lifeEvents;

const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];
function repeatLabel(r: { kind?: string; spec?: unknown } | undefined, isZh: boolean): string {
  switch (r?.kind) {
    case 'daily': return isZh ? '每天' : 'Daily';
    case 'weekly': {
      const days = Array.isArray(r.spec) ? (r.spec as number[]) : [];
      return isZh ? (days.length ? `每周${days.map((d) => WEEKDAY_ZH[d % 7]).join('')}` : '每周') : 'Weekly';
    }
    case 'monthly': return isZh ? '每月' : 'Monthly';
    case 'cron': return isZh ? '定期' : 'Recurring';
    default: return '';
  }
}

export function useAgenda(sessionId: string | null, refreshKey: number) {
  const [rows, setRows] = useState<BoardReminder[]>([]);
  const [cloud, setCloud] = useState(false);
  const cloudRef = useRef(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!sessionId) { setRows([]); return undefined; }
    let alive = true;
    const load = async () => {
      const c = await boardApi().pilotReminders?.(sessionId).catch(() => null);
      if (!alive) return;
      cloudRef.current = !!c?.cloud;
      setCloud(!!c?.cloud);
      if (c?.cloud) { setRows([...c.reminders].sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0))); return; }
      const r = await lifeApi()?.listForSession?.(sessionId).catch(() => null);
      if (!alive) return;
      const list = r?.success ? r.events ?? [] : [];
      setRows(list.filter((e) => e.status === 'scheduled').sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0)));
    };
    void load();
    const off = lifeApi()?.onChanged?.(() => { void load(); });
    const h = window.setInterval(load, 60_000);
    return () => { alive = false; off?.(); window.clearInterval(h); };
  }, [sessionId, refreshKey, nonce]);

  const reload = () => setNonce((n) => n + 1);
  const cancel = async (id: string) => {
    setRows((r) => r.filter((x) => x.id !== id));
    if (cloudRef.current) await boardApi().pilotCancelReminder?.(id)?.catch(() => {});
    else await lifeApi()?.delete?.(id)?.catch(() => {});
  };
  const add = async (r: { title: string; at: number; ring?: boolean }) => {
    if (!sessionId) return false;
    const res = await boardApi().pilotAddReminder?.(sessionId, r).catch(() => null);
    reload();
    return !!res?.ok;
  };
  /** 改时间 / 改提醒方式 = 新建一条 + 取消旧的 (账本没有改接口; 先建后删, 中途失败不丢) */
  const update = async (old: BoardReminder, patch: { at?: number; ring?: boolean }) => {
    const ok = await add({ title: old.title, at: patch.at ?? old.scheduledAt ?? Date.now(), ring: patch.ring ?? old.ring });
    if (ok) await cancel(old.id);
    reload();
  };
  return { rows, cloud, cancel, add, update };
}

export const AgendaSection: React.FC<{
  agenda: ReturnType<typeof useAgenda>;
  isZh: boolean;
}> = ({ agenda, isZh }) => {
  const t = (zh: string, en: string) => (isZh ? zh : en);
  const { rows, cloud } = agenda;
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState<number | null>(null);
  const [ring, setRing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const submit = async () => {
    if (!title.trim() || !when || busy) return;
    setBusy(true);
    const ok = await agenda.add({ title: title.trim(), at: when, ring });
    setBusy(false);
    if (ok) { setAdding(false); setTitle(''); setWhen(null); setRing(false); }
  };

  const groups: Array<{ key: 0 | 1 | 2; label: string; items: BoardReminder[] }> = [
    { key: 0, label: t('今天', 'Today'), items: [] },
    { key: 1, label: t('明天', 'Tomorrow'), items: [] },
    { key: 2, label: t('之后', 'Later'), items: [] },
  ];
  for (const r of rows) groups[dayBucket(r.scheduledAt)].items.push(r);

  return (
    <section className="pb-sec is-agenda">
      <SectionHead
        art={ART.calendar}
        title={t('日程', 'Schedule')}
        count={rows.length}
        action={cloud ? { label: t('新建提醒', 'New reminder'), icon: <S.IconPlus size={14} />, onClick: () => setAdding((v) => !v), active: adding } : undefined}
      />
      {adding && (
        <div className="pb-form">
          <input
            className="pb-input"
            autoFocus
            placeholder={t('提醒我…（例：给王总回电话）', 'Remind me to…')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit(); if (e.key === 'Escape') setAdding(false); }}
          />
          <WhenPicker value={when} onChange={setWhen} isZh={isZh} />
          <label className="pb-check">
            <input type="checkbox" checked={ring} onChange={(e) => setRing(e.target.checked)} />
            {t('到点打电话叫我（不勾就推送到手机）', 'Call me when due (otherwise a push)')}
          </label>
          <div className="pb-form__row">
            <button type="button" className="pb-btn" onClick={() => setAdding(false)}>{t('取消', 'Cancel')}</button>
            <button type="button" className="pb-btn pb-btn--primary" disabled={!title.trim() || !when || busy} onClick={() => void submit()}>
              {busy ? t('设置中…', 'Saving…') : t('设好', 'Set')}
            </button>
          </div>
        </div>
      )}
      {groups.filter((g) => g.items.length > 0).map((g) => (
        <div key={g.key} className="pb-group">
          <div className="pb-group__label">{g.label}</div>
          {g.items.map((r) => {
            const [day, hm] = splitWhen(r.scheduledAt, isZh);
            const rep = repeatLabel(r.payload?.recurrence, isZh);
            const isOpen = open === r.id;
            return (
              <div key={r.id} className={`pb-timed${isOpen ? ' is-open' : ''}`}>
                <button type="button" className="pb-timed__row" onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={isOpen}>
                  <span className="pb-timed__clock"><b>{hm}</b><small>{rep || (g.key === 2 ? day : '')}</small></span>
                  <span className="pb-timed__what">{r.title}</span>
                  <span className={`pb-timed__how${r.ring ? ' is-ring' : ''}`} title={r.ring ? t('到点打电话', 'Calls you') : t('到点推送', 'Push notification')}>
                    {r.ring ? <StageIcon name="phone" size={13} /> : <StageIcon name="bell" size={13} />}
                  </span>
                </button>
                {isOpen && (
                  <ReminderEditor reminder={r} cloud={cloud} isZh={isZh} onUpdate={(p) => { setOpen(null); void agenda.update(r, p); }} onCancel={() => { setOpen(null); void agenda.cancel(r.id); }} />
                )}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
};

const ReminderEditor: React.FC<{
  reminder: BoardReminder;
  cloud: boolean;
  isZh: boolean;
  onUpdate: (p: { at?: number; ring?: boolean }) => void;
  onCancel: () => void;
}> = ({ reminder, cloud, isZh, onUpdate, onCancel }) => {
  const t = (zh: string, en: string) => (isZh ? zh : en);
  const [when, setWhen] = useState<number | null>(null);
  return (
    <div className="pb-edit">
      {cloud && (
        <>
          <div className="pb-edit__label">{t('改到', 'Move to')}</div>
          <WhenPicker value={when} onChange={setWhen} isZh={isZh} />
        </>
      )}
      <div className="pb-form__row">
        <button type="button" className="pb-btn pb-btn--danger" onClick={onCancel}>
          <S.IconTrash size={13} />{t('取消提醒', 'Cancel reminder')}
        </button>
        {cloud && (
          <button type="button" className="pb-btn" onClick={() => onUpdate({ ring: !reminder.ring })}>
            {reminder.ring ? <StageIcon name="bell" size={13} /> : <StageIcon name="phone" size={13} />}
            {reminder.ring ? t('改成推送', 'Push instead') : t('改成打电话', 'Call instead')}
          </button>
        )}
        {cloud && (
          <button type="button" className="pb-btn pb-btn--primary" disabled={!when} onClick={() => when && onUpdate({ at: when })}>
            {t('改时间', 'Reschedule')}
          </button>
        )}
      </div>
    </div>
  );
};
