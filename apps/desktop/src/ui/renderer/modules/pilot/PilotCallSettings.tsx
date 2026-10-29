import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../hooks/useI18n';
import { pilotApi } from './pilotStore';

interface Settings {
  pilot: {
    callOn?: { reminders?: boolean; decisions?: boolean; alerts?: boolean; agent?: boolean };
    maxUnaskedPerHour?: number;
    ringSeconds?: number;
  };
  quietHours: { enabled: boolean; start: string; end: string };
}

interface TelegramStatus { configured: boolean; bound: boolean; botName?: string; pairingCode?: string; running: boolean; lastError?: string }

type Api = {
  pilotGetSettings?: () => Promise<Settings>;
  pilotSaveSettings?: (next: Partial<Settings>) => Promise<unknown>;
  pilotTelegramStatus?: () => Promise<TelegramStatus>;
  pilotTelegramSetToken?: (token: string) => Promise<{ ok: boolean; status?: TelegramStatus; error?: string }>;
  pilotTelegramPair?: () => Promise<TelegramStatus>;
  pilotTelegramDisconnect?: () => Promise<TelegramStatus>;
};
const api = () => (window as unknown as { neox?: Api }).neox ?? {};

/** 不在电脑前用 Telegram 找 Pilot: 填 bot token → 把配对码发给 bot → 连上 */
const TelegramGroup: React.FC<{ t: (zh: string, en: string) => string }> = ({ t }) => {
  const [st, setSt] = useState<TelegramStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { void api().pilotTelegramStatus?.().then((v) => setSt(v ?? null)).catch(() => {}); }, []);
  /* 等配对时轮询: 你在手机上发完码, 这里自己变成「已连上」 */
  useEffect(() => {
    if (!st?.configured || st.bound) return undefined;
    const id = window.setInterval(() => { void api().pilotTelegramStatus?.().then((v) => v && setSt(v)).catch(() => {}); }, 2000);
    return () => window.clearInterval(id);
  }, [st?.configured, st?.bound]);

  const connect = async () => {
    setBusy(true); setErr(null);
    const r = await api().pilotTelegramSetToken?.(token).catch((e): { ok: boolean; status?: TelegramStatus; error?: string } => ({ ok: false, error: String(e) }));
    setBusy(false);
    if (r?.ok && r.status) { setSt(r.status); setToken(''); } else setErr(r?.error ?? t('连不上', 'Could not connect'));
  };
  const disconnect = async () => setSt((await api().pilotTelegramDisconnect?.().catch(() => null)) ?? null);
  const repair = async () => setSt((await api().pilotTelegramPair?.().catch(() => null)) ?? st);

  if (!st) return null;
  const bot = st.botName ? `@${st.botName}` : 'bot';
  return (
    <div className="pilot-settings__group">
      <div className="pilot-settings__h">{t('不在电脑前 · Telegram', 'Away from the Mac · Telegram')}</div>
      {!st.configured && (
        <>
          <div className="pilot-settings__row">
            <input className="pilot-settings__input" type="password" value={token} placeholder={t('机器人 token (找 @BotFather 建)', 'Bot token (from @BotFather)')}
              onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && token.trim()) void connect(); }} />
            <button type="button" className="pilot-btn pilot-btn--ghost" disabled={busy || !token.trim()} onClick={() => void connect()}>
              {busy ? t('连接中…', 'Connecting…') : t('连上', 'Connect')}
            </button>
          </div>
          {err && <p className="pilot-settings__note pilot-settings__note--err">{err}</p>}
        </>
      )}
      {st.configured && !st.bound && (
        <div className="pilot-settings__row">
          <span>{st.pairingCode
            ? <>{t('把 ', 'Send ')}<b className="pilot-settings__code">{st.pairingCode}</b>{t(` 发给 ${bot}`, ` to ${bot}`)}</>
            : t('配对码过期了', 'Pairing code expired')}</span>
          <span className="pilot-settings__actions">
            <button type="button" className="pilot-btn pilot-btn--ghost" onClick={() => void repair()}>{t('换一个码', 'New code')}</button>
            <button type="button" className="pilot-btn pilot-btn--ghost" onClick={() => void disconnect()}>{t('取消', 'Cancel')}</button>
          </span>
        </div>
      )}
      {st.bound && (
        <>
          <div className="pilot-settings__row">
            <span>{t(`已连上 ${bot}`, `Connected to ${bot}`)}</span>
            <button type="button" className="pilot-btn pilot-btn--ghost" onClick={() => void disconnect()}>{t('断开', 'Disconnect')}</button>
          </div>
          <p className="pilot-settings__note">{t('你离开电脑时, 未接来电和它要说的话会发到那里; 在那里说话它也听得到。',
            'When you are away, missed calls and updates go there, and you can talk to it there.')}</p>
        </>
      )}
      {st.configured && st.lastError && <p className="pilot-settings__note pilot-settings__note--err">{st.lastError}</p>}
    </div>
  );
};

const Switch: React.FC<{ on: boolean; onChange: (v: boolean) => void; label: string }> = ({ on, onChange, label }) => (
  <button type="button" role="switch" aria-checked={on} aria-label={label} className={`pilot-switch${on ? ' is-on' : ''}`} onClick={() => onChange(!on)}>
    <span className="pilot-switch__knob" />
  </button>
);

const Stepper: React.FC<{ value: number; min: number; max: number; step?: number; suffix: string; onChange: (v: number) => void }> = ({ value, min, max, step = 1, suffix, onChange }) => (
  <span className="pilot-stepper">
    <button type="button" onClick={() => onChange(Math.max(min, value - step))} disabled={value <= min} aria-label="-">−</button>
    <span className="pilot-stepper__v">{value}{suffix}</span>
    <button type="button" onClick={() => onChange(Math.min(max, value + step))} disabled={value >= max} aria-label="+">+</button>
  </span>
);

export const PilotCallSettings: React.FC<{ sessionId: string | null; onClose: () => void }> = ({ sessionId, onClose }) => {
  const { isZh } = useI18n();
  const t = (zh: string, en: string) => (isZh ? zh : en);
  const [s, setS] = useState<Settings | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  useEffect(() => { void api().pilotGetSettings?.().then((v) => setS(v ?? null)).catch(() => setS(null)); }, []);

  const save = (next: Settings) => {
    setS(next);
    void api().pilotSaveSettings?.(next).catch(() => { /* 下次打开再读 */ });
  };
  const callOn = s?.pilot.callOn ?? {};
  const setCallOn = (k: keyof NonNullable<Settings['pilot']['callOn']>, v: boolean) => s && save({ ...s, pilot: { ...s.pilot, callOn: { ...callOn, [k]: v } } });

  const testRing = async (device?: 'phone') => {
    setTesting(t('响铃中…', 'Ringing…'));
    const r = await pilotApi().pilotCallTestRing?.({ sessionId: sessionId ?? undefined, device }).catch(() => null);
    const label: Record<string, string> = {
      answered: t('接通了', 'Answered'), declined: t('你挂了', 'Declined'), missed: t('没接', 'Missed'),
      busy: t('没打: 你在忙', 'Held: busy'), blocked: t('没打出去', 'Not placed'),
    };
    if (r?.status === 'blocked' && r.detail === 'no phone connected') { setTesting(t('手机没连着', 'No phone connected')); return; }
    setTesting(r ? label[r.status] ?? r.status : t('没打出去', 'Not placed'));
  };

  const rows: Array<{ k: keyof NonNullable<Settings['pilot']['callOn']>; title: string; def: boolean }> = [
    { k: 'reminders', title: t('提醒到点', 'Reminders'), def: true },
    { k: 'decisions', title: t('事情卡在要你拍板', 'Needs your decision'), def: true },
    { k: 'alerts', title: t('让它盯的东西出事了', 'Something it watches broke'), def: true },
    { k: 'agent', title: t('它自己觉得要紧', 'It thinks it matters'), def: false },
  ];

  return createPortal(
    <div className="pilot-dialog__scrim" role="dialog" aria-modal="true" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pilot-dialog">
        <h2 className="pilot-dialog__title">{t('来电', 'Calls')}</h2>
        {!s ? <p className="pilot-board__empty neox-text-shimmer">{t('读取中…', 'Loading…')}</p> : (
          <div className="pilot-settings">
            <div className="pilot-settings__group">
              <div className="pilot-settings__h">{t('什么时候打给你', 'When it may call')}</div>
              {rows.map((r) => (
                <div key={r.k} className="pilot-settings__row">
                  <span>{r.title}</span>
                  <Switch on={callOn[r.k] ?? r.def} onChange={(v) => setCallOn(r.k, v)} label={r.title} />
                </div>
              ))}
              <p className="pilot-settings__note">{t('你亲口让它打的, 比如「明早八点叫我」, 总会打。', 'Calls you asked for, like "wake me at 8", always ring.')}</p>
            </div>

            <div className="pilot-settings__group">
              <div className="pilot-settings__row">
                <span>{t('没让它打时, 每小时最多', 'Unasked calls per hour')}</span>
                <Stepper value={s.pilot.maxUnaskedPerHour ?? 3} min={0} max={10} suffix={t(' 次', '')}
                  onChange={(v) => save({ ...s, pilot: { ...s.pilot, maxUnaskedPerHour: v } })} />
              </div>
              <div className="pilot-settings__row">
                <span>{t('响多久算没接', 'Ring before missed')}</span>
                <Stepper value={s.pilot.ringSeconds ?? 25} min={10} max={27} step={5} suffix={t(' 秒', 's')}
                  onChange={(v) => save({ ...s, pilot: { ...s.pilot, ringSeconds: v } })} />
              </div>
            </div>

            <div className="pilot-settings__group">
              <div className="pilot-settings__row">
                <span>{t('勿扰时段', 'Quiet hours')}</span>
                <Switch on={s.quietHours.enabled} label={t('勿扰时段', 'Quiet hours')}
                  onChange={(v) => save({ ...s, quietHours: { ...s.quietHours, enabled: v } })} />
              </div>
              {s.quietHours.enabled && (
                <div className="pilot-settings__row pilot-settings__row--sub">
                  <span className="pilot-settings__times">
                    <input type="time" value={s.quietHours.start} onChange={(e) => save({ ...s, quietHours: { ...s.quietHours, start: e.target.value } })} />
                    <span>–</span>
                    <input type="time" value={s.quietHours.end} onChange={(e) => save({ ...s, quietHours: { ...s.quietHours, end: e.target.value } })} />
                  </span>
                </div>
              )}
            </div>

            <TelegramGroup t={t} />

            <div className="pilot-form__actions">
              <span className="pilot-settings__test">{testing ?? ''}</span>
              <button type="button" className="pilot-btn pilot-btn--ghost" onClick={() => void testRing('phone')} disabled={testing === t('响铃中…', 'Ringing…')}>
                {t('打到手机', 'To phone')}
              </button>
              <button type="button" className="pilot-btn pilot-btn--ghost" onClick={() => void testRing()} disabled={testing === t('响铃中…', 'Ringing…')}>
                {t('试打一下', 'Test call')}
              </button>
              <button type="button" className="pilot-btn pilot-btn--primary" onClick={onClose}>{t('好', 'Done')}</button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};
