import React, { useCallback, useEffect, useState } from 'react';
import { cronToHuman } from '../../../modules/agent-timeline/cronHuman';
import './AutomationsSection.css';

interface Job { root: string; id: string; cron: string; prompt: string; recurring: boolean; createdAt?: number; lastFiredAt?: number }

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

function ago(ms: number, zh: boolean): string {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return zh ? '刚刚' : 'just now';
  if (m < 60) return zh ? `${m} 分钟前` : `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return zh ? `${h} 小时前` : `${h}h ago`;
  return zh ? `${Math.round(h / 24)} 天前` : `${Math.round(h / 24)}d ago`;
}

export const AutomationsSection: React.FC<{ zh: boolean }> = ({ zh }) => {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setJobs(((await (window as any).neox?.automationsList?.()) ?? []) as Job[]); } catch { setJobs([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const remove = async (j: Job) => {
    if (confirm !== `${j.root}#${j.id}`) { setConfirm(`${j.root}#${j.id}`); return; }
    setConfirm(null);
    await (window as any).neox?.automationsDelete?.(j.root, j.id);
    await load();
  };

  if (jobs === null) return null;
  return (
    <section className="sk3-auto">
      <div className="sk3-auto__head">
        <span className="sk3-auto__title">{zh ? '自动化' : 'Automations'}</span>
        <span className="sk3-auto__count">{jobs.length}</span>
        <span className="sk3-auto__hint">{zh ? '跟 Agent 说「每周五下午 5 点帮我…」就会建一条; Neox 开着时到点自动跑' : 'Ask "every Friday at 5pm, …" to create one; runs while Neox is open'}</span>
      </div>
      {jobs.length === 0 && <div className="sk3-auto__empty">{zh ? '还没有自动化' : 'No automations yet'}</div>}
      {jobs.map((j) => {
        const key = `${j.root}#${j.id}`;
        return (
          <div key={key} className="sk3-auto__row">
            <span className="sk3-auto__clock" aria-hidden>
              <svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 4.6V8l2.4 1.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </span>
            <div className="sk3-auto__main">
              <div className="sk3-auto__when">{j.recurring ? cronToHuman(j.cron, zh) : (zh ? `一次 · ${cronToHuman(j.cron, zh)}` : `Once · ${cronToHuman(j.cron, zh)}`)}</div>
              <div className="sk3-auto__what" title={j.prompt}>{j.prompt}</div>
              <div className="sk3-auto__meta">
                {base(j.root)}{j.lastFiredAt ? (zh ? ` · 上次 ${ago(j.lastFiredAt, zh)}` : ` · last ${ago(j.lastFiredAt, zh)}`) : (zh ? ' · 还没跑过' : ' · not run yet')}
              </div>
            </div>
            <button type="button" className={`sk3-auto__del${confirm === key ? ' is-confirm' : ''}`} onClick={() => void remove(j)} onBlur={() => setConfirm(null)}>
              {confirm === key ? (zh ? '确认删除' : 'Confirm') : (zh ? '删除' : 'Delete')}
            </button>
          </div>
        );
      })}
    </section>
  );
};

export default AutomationsSection;
