import React, { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { fileOf } from './brandLogos';

type SourceKey = 'calendar' | 'reminders' | 'contacts' | 'messages' | 'bank';
interface SourceRow { key: SourceKey; enabled: boolean; lastAt: number | null; count: number; error: string | null; syncing: boolean }
interface NodeStatus { mac: boolean; cloud: boolean; actions: boolean; sources: SourceRow[]; recent: Array<{ tool: string; ok: boolean; at: number }> }

interface NodeApi {
  pilotNodeStatus?: () => Promise<NodeStatus>;
  pilotNodeSetSource?: (k: SourceKey, on: boolean) => Promise<boolean>;
  pilotNodeSetActions?: (on: boolean) => Promise<boolean>;
  pilotNodeSyncNow?: (k?: SourceKey) => Promise<boolean>;
  pilotNodeForget?: (k: SourceKey) => Promise<number>;
  pilotNodeOpenPrivacy?: (which: string) => Promise<boolean>;
}
const api = (): NodeApi => ((window as unknown as { neox?: NodeApi }).neox ?? {});

const META: Record<SourceKey, { zh: string; en: string; logo: string; dzh: string; den: string; privacy: string }> = {
  calendar: { zh: '日历', en: 'Calendar', logo: 'mac-calendar', dzh: '前 30 天到后 90 天的日程', den: 'Events from 30 days back to 90 days ahead', privacy: 'calendar' },
  reminders: { zh: '提醒事项', en: 'Reminders', logo: 'mac-reminders', dzh: '没做完的; 做完了它也知道', den: 'Open reminders, and when you finish them', privacy: 'reminders' },
  contacts: { zh: '通讯录', en: 'Contacts', logo: 'mac-contacts', dzh: '名字、电话、邮箱、生日', den: 'Names, numbers, emails, birthdays', privacy: 'contacts' },
  messages: { zh: '信息', en: 'Messages', logo: 'mac-messages', dzh: 'iMessage 和转到电脑的短信; 验证码不收', den: 'iMessage and forwarded SMS; codes skipped', privacy: 'disk' },
  bank: { zh: '银行短信', en: 'Bank texts', logo: 'unionpay', dzh: '消费、入账自动记一笔', den: 'Spending and deposits logged automatically', privacy: 'disk' },
};

/* 状态没回来前先把五行摆出来 (不然整块先空再跳) */
const PLACEHOLDER: SourceRow[] = (['calendar', 'reminders', 'contacts', 'messages', 'bank'] as SourceKey[])
  .map((key) => ({ key, enabled: true, lastAt: null, count: 0, error: null, syncing: false }));

const TOOL_LABEL: Record<string, [string, string]> = {
  calendar_events: ['看了日历', 'Read calendar'], calendar_add: ['加了日程', 'Added an event'],
  apple_reminders: ['改了提醒事项', 'Reminders'], contacts_search: ['查了通讯录', 'Looked up a contact'],
  send_imessage: ['发了一条信息', 'Sent a message'], notify: ['在电脑上提醒你', 'Notified you'],
};

function ago(ms: number | null, zh: boolean): string {
  if (!ms) return zh ? '还没同步过' : 'Not synced yet';
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return zh ? '刚刚' : 'just now';
  if (m < 60) return zh ? `${m} 分钟前` : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return zh ? `${h} 小时前` : `${h} h ago`;
  return zh ? `${Math.round(h / 24)} 天前` : `${Math.round(h / 24)} d ago`;
}

const Switch: React.FC<{ on: boolean; onToggle: () => void; label: string }> = ({ on, onToggle, label }) => (
  <button type="button" role="switch" aria-checked={on} aria-label={label} className={`pv3-switchbtn${on ? ' is-on' : ''}`} onClick={onToggle}><i /></button>
);

export const PilotConnectPage: React.FC = () => {
  const { isZh } = useI18n();
  const [st, setSt] = useState<NodeStatus | null>(null);
  const [missing, setMissing] = useState(false);
  /* 「断开」要点两下: 第一下变成「再点一次, 删掉云端 N 条」 */
  const [arm, setArm] = useState<SourceKey | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const f = api().pilotNodeStatus;
    if (!f) { setMissing(true); return; }
    try { setSt(await f()); } catch { setMissing(true); }
  }, []);

  const anySyncing = !!st?.sources.some((s) => s.syncing);
  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, anySyncing || busy ? 2_500 : 15_000);
    return () => clearInterval(t);
  }, [load, anySyncing, busy]);

  const toggle = async (k: SourceKey, on: boolean) => {
    setSt((s) => (s ? { ...s, sources: s.sources.map((x) => (x.key === k ? { ...x, enabled: on, error: on ? x.error : null } : x)) } : s));
    await api().pilotNodeSetSource?.(k, on);
    void load();
  };
  const forget = async (k: SourceKey) => {
    if (arm !== k) { setArm(k); return; }
    setArm(null);
    setBusy(k);
    try { await api().pilotNodeForget?.(k); } finally { setBusy(null); void load(); }
  };
  const syncAll = async () => {
    setBusy('all');
    try { await api().pilotNodeSyncNow?.(); } finally { setBusy(null); void load(); }
  };

  if (missing || (st && !st.mac)) {
    return (
      <div className="pv3-room">
        <header><h1 className="pv3-pagehead">{isZh ? '连接' : 'Connections'}</h1></header>
        <p className="pv3-box__empty">{isZh ? '这台电脑接不了 (要 Mac 版 Neox 并登录)。' : 'Not available on this computer (needs Neox for Mac, signed in).'}</p>
      </div>
    );
  }

  return (
    <div className="pv3-room" data-loading={st ? undefined : ''}>
      <header>
        <h1 className="pv3-pagehead">{isZh ? '连接' : 'Connections'}</h1>
        <p className="pv3-pagesub">{isZh ? '这台电脑给它看什么、替它做什么。都同步进你的个人记录，手机上看到的是同一份' : 'What this computer shares with it and does for it. Synced into your records, same on your phone'}</p>
      </header>
      {st && !st.cloud && (
        <p className="pv3-connect__note">{isZh ? '你的账号还没开 Pilot，开了才会同步。' : 'Pilot is not on for your account yet; syncing starts once it is.'}</p>
      )}
      <div className="pv3-room__cols">
        <section className="pv3-box">
          <h2 className="pv3-box__title">{isZh ? '这台 Mac 上的' : 'On this Mac'}</h2>
          {(
            <ul className="pv3-list pv3-list--ruled" aria-busy={!st}>
              {(st?.sources ?? PLACEHOLDER).map((s) => {
                const m = META[s.key];
                const logo = fileOf(m.logo);
                const state = !st ? '—' : !s.enabled
                  ? (isZh ? '没开' : 'Off')
                  : s.syncing || busy === s.key
                    ? (busy === s.key ? (isZh ? '正在删云端的…' : 'Deleting…') : (isZh ? '正在同步…' : 'Syncing…'))
                    : s.error ?? `${isZh ? `${s.count.toLocaleString()} 条` : `${s.count.toLocaleString()} items`} · ${ago(s.lastAt, isZh)}`;
                return (
                  <li key={s.key} className="pv3-connect__row">
                    <span className="pv3-list__ic is-logo">{logo ? <img src={logo} alt="" /> : null}</span>
                    <span className="pv3-list__main">
                      <b>{isZh ? m.zh : m.en}</b>
                      <small className={s.enabled && s.error ? 'is-bad' : undefined}>{state}</small>
                      {s.enabled && !s.error && <small className="pv3-connect__desc">{isZh ? m.dzh : m.den}</small>}
                      {s.enabled && s.error && (
                        <button type="button" className="pv3-connect__link" onClick={() => void api().pilotNodeOpenPrivacy?.(/自动化|Automation/i.test(s.error ?? '') ? 'automation' : m.privacy)}>
                          {isZh ? '去系统设置里打开' : 'Open System Settings'}
                        </button>
                      )}
                      {!s.enabled && s.count > 0 && (
                        <button type="button" className={`pv3-connect__link${arm === s.key ? ' is-bad' : ''}`} onClick={() => void forget(s.key)} onBlur={() => setArm(null)}>
                          {arm === s.key
                            ? (isZh ? `再点一次，删掉云端这 ${s.count.toLocaleString()} 条` : `Click again to delete ${s.count.toLocaleString()} synced items`)
                            : (isZh ? '断开并删掉已同步的' : 'Disconnect and delete synced')}
                        </button>
                      )}
                    </span>
                    <Switch on={s.enabled} label={isZh ? m.zh : m.en} onToggle={() => void toggle(s.key, !s.enabled)} />
                  </li>
                );
              })}
            </ul>
          )}
          <button type="button" className="pv3-wide" disabled={!st?.cloud || busy === 'all' || anySyncing} onClick={() => void syncAll()}>
            {busy === 'all' || anySyncing ? (isZh ? '正在同步…' : 'Syncing…') : (isZh ? '现在同步一次' : 'Sync now')}
          </button>
        </section>
        <section className="pv3-box">
          <h2 className="pv3-box__title">{isZh ? '替它办事' : 'Acting for it'}</h2>
          <ul className="pv3-list pv3-list--ruled">
            <li className="pv3-connect__row">
              <span className="pv3-list__ic">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12" rx="1.8" /><path d="M9 20h6M12 16.5V20" /></svg>
              </span>
              <span className="pv3-list__main">
                <b>{isZh ? '让它用这台电脑办事' : 'Let it use this computer'}</b>
                <small className="pv3-connect__desc">{isZh ? '加日程、改提醒、查电话、用你的 iMessage 发消息。发消息前它会先问你' : 'Add events, edit reminders, look up numbers, send iMessages. It asks before sending'}</small>
              </span>
              {st && <Switch on={st.actions} label={isZh ? '让它用这台电脑办事' : 'Let it use this computer'} onToggle={() => { const on = !st.actions; setSt({ ...st, actions: on }); void api().pilotNodeSetActions?.(on); }} />}
            </li>
          </ul>
          <h3 className="pv3-connect__sub">{isZh ? '最近替它办的' : 'Recently'}</h3>
          {!st?.recent.length ? (
            <p className="pv3-box__empty">{isZh ? '还没有。跟它说「把明天下午三点的会加到日历」试试' : 'Nothing yet. Try "put tomorrow 3pm meeting on my calendar"'}</p>
          ) : (
            <ul className="pv3-list">
              {st.recent.slice(0, 8).map((r) => {
                const [z, en] = TOOL_LABEL[r.tool] ?? [r.tool, r.tool];
                return (
                  <li key={`${r.at}-${r.tool}`} className="pv3-connect__act">
                    <span className="pv3-list__main"><b>{isZh ? z : en}</b></span>
                    <span className={`pv3-list__amt pv3-list__amt--small${r.ok ? '' : ' is-bad'}`}>{r.ok ? ago(r.at, isZh) : (isZh ? '没办成' : 'Failed')}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};

export default PilotConnectPage;
