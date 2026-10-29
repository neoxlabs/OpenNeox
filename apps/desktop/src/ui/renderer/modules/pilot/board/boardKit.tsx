import React from 'react';

export interface BoardReminder { id: string; title: string; scheduledAt?: number; status?: string; ring?: boolean; payload?: { recurrence?: { kind?: string; spec?: unknown } } }
export interface BoardMemory { id: string; text: string; at: number }

interface BoardApi {
  pilotReminders?: (id: string) => Promise<{ cloud: boolean; reminders: BoardReminder[] }>;
  pilotCancelReminder?: (id: string) => Promise<unknown>;
  pilotAddReminder?: (id: string, r: { title: string; at: number; ring?: boolean }) => Promise<{ ok: boolean; error?: string }>;
  pilotMemories?: (id: string) => Promise<{ cloud: boolean; memories: BoardMemory[] }>;
  pilotAddMemory?: (id: string, text: string) => Promise<{ ok: boolean }>;
  pilotForgetMemory?: (id: string) => Promise<{ ok: boolean }>;
}
export const boardApi = (): BoardApi => ((window as unknown as { neox?: BoardApi }).neox ?? {});

export const SectionHead: React.FC<{
  /** 黏土图标 (board/art.ts); 没有就用线性小图标 */
  art?: string;
  icon?: React.ReactNode;
  title: string;
  count?: number;
  accent?: boolean;
  action?: { label: string; icon: React.ReactNode; onClick: () => void; active?: boolean };
}> = ({ art, icon, title, count, accent, action }) => (
  <h3 className="pb-head">
    {art ? <img className="pb-head__art" src={art} alt="" aria-hidden draggable={false} /> : <span className="pb-head__icon" aria-hidden>{icon}</span>}
    <span className="pb-head__title">{title}</span>
    {typeof count === 'number' && count > 0 && <span className={`pb-head__n${accent ? ' is-accent' : ''}`}>{count}</span>}
    {action && (
      <button type="button" className={`pb-head__act${action.active ? ' is-on' : ''}`} onClick={action.onClick} title={action.label} aria-label={action.label}>
        {action.icon}
      </button>
    )}
  </h3>
);

/** 一小时后, 取整到 5 分钟 */
const nextHour = () => Math.ceil((Date.now() + 3_600_000) / 300_000) * 300_000;

/** 常用时刻 (本地时间) */
function presets(isZh: boolean): Array<{ label: string; at: number }> {
  const now = new Date();
  const at = (dayOffset: number, h: number, m = 0) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, m);
    return d.getTime();
  };
  const list = [
    { label: isZh ? '1 小时后' : 'In 1 hour', at: nextHour() },
    ...(now.getHours() < 19 ? [{ label: isZh ? '今晚 8 点' : 'Tonight 8pm', at: at(0, 20) }] : []),
    { label: isZh ? '明早 9 点' : 'Tomorrow 9am', at: at(1, 9) },
    { label: isZh ? '明天下午 6 点' : 'Tomorrow 6pm', at: at(1, 18) },
  ];
  return list;
}

/** datetime-local 要的本地时间串 */
export function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const WhenPicker: React.FC<{ value: number | null; onChange: (ts: number) => void; isZh: boolean }> = ({ value, onChange, isZh }) => {
  const list = presets(isZh);
  /* 空的 datetime-local 跟系统区域走, 中文界面里也显示 mm/dd/yyyy —— 没选之前用一个按钮代替, 点了再换成真选择器 */
  const [exact, setExact] = React.useState(false);
  const isPreset = list.some((p) => p.at === value);
  return (
    <div className="pb-when">
      <div className="pb-when__chips">
        {list.map((p) => (
          <button key={p.label} type="button" className={`pb-pill${value === p.at ? ' is-on' : ''}`} onClick={() => { setExact(false); onChange(p.at); }}>{p.label}</button>
        ))}
        {!exact && (
          <button type="button" className={`pb-pill${value && !isPreset ? ' is-on' : ''}`} onClick={() => { setExact(true); if (!value || isPreset) onChange(nextHour()); }}>
            {value && !isPreset ? splitWhen(value, isZh).join(' ') : isZh ? '其他时间…' : 'Other…'}
          </button>
        )}
      </div>
      {exact && (
        <input
          type="datetime-local"
          className="pb-when__input"
          autoFocus
          value={toLocalInput(value ?? nextHour())}
          min={toLocalInput(Date.now())}
          onChange={(e) => { const t = new Date(e.target.value).getTime(); if (Number.isFinite(t)) onChange(t); }}
          aria-label={isZh ? '具体时间' : 'Exact time'}
        />
      )}
    </div>
  );
};

/** [哪天, HH:mm] */
export function splitWhen(ts: number | undefined, isZh: boolean): [string, string] {
  if (!ts) return ['', '--:--'];
  const d = new Date(ts);
  const now = new Date();
  const hm = d.toLocaleTimeString(isZh ? 'zh-CN' : undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  const wd = isZh ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] : d.toLocaleDateString(undefined, { weekday: 'short' });
  if (days === 0) return [isZh ? '今天' : 'Today', hm];
  if (days === 1) return [isZh ? '明天' : 'Tomorrow', hm];
  if (days === 2) return [isZh ? '后天' : 'In 2 days', hm];
  return [`${d.getMonth() + 1}/${d.getDate()} ${wd}`, hm];
}

/** 按天分组: 今天 / 明天 / 之后 */
export function dayBucket(ts: number | undefined): 0 | 1 | 2 {
  if (!ts) return 2;
  const d = new Date(ts);
  const now = new Date();
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  return days <= 0 ? 0 : days === 1 ? 1 : 2;
}
