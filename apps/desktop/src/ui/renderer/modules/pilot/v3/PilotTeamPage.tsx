/**
 * Pilot · 分身 (稿 pl7): 一个分身管一摊事。每张卡 = 造型 + 名字 + 分工 + 在不在忙 + 跟它说 / 编辑,
 * 最后一张虚线卡新建。编辑 / 新建在右边抽屉里 (PilotTeamDrawer), 不弹窗。
 */
import React, { useEffect, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import type { PilotDraft } from '../PilotEditor';
import type { PilotProfile } from '../pilotStore';
import type { PilotContact } from '../PilotSidebar';
import { PILOT_LOOKS, lookOf } from './pilotLooks';
import { VOICE_SAMPLE, voicesFor } from './pilotVoices';
import { CustomSelect } from '../../../components/CustomSelect';
import { dispatchOpFailed } from '../../../components/notifyEvents';
import { playTtsAudio } from '../../../utils/ttsPlayer';

interface PageProps {
  contacts: PilotContact[];
  profiles: Record<string, PilotProfile>;
  running: ReadonlySet<string>;
  editingId: string | null;
  onTalk: (id: string) => void;
  onEdit: (id: string) => void;
  onCreate: () => void;
}

export const PilotTeamPage: React.FC<PageProps> = ({ contacts, profiles, running, editingId, onTalk, onEdit, onCreate }) => {
  const { isZh } = useI18n();
  return (
    <div className="pv3-team">
      <h1 className="pv3-pagehead">{isZh ? '分身' : 'Team'}</h1>
      <p className="pv3-pagesub">{isZh ? '一个分身管一摊事，可以同时帮你办' : 'Each one handles one thing — they work at the same time'}</p>
      <div className="pv3-team__grid">
        {contacts.map((c) => {
          const p = profiles[c.id];
          const busy = running.has(c.id);
          return (
            <article key={c.id} className={`pv3-mate${editingId === c.id ? ' is-editing' : ''}`}>
              <div className="pv3-mate__art"><img src={lookOf(p).src} alt="" draggable={false} /></div>
              <h2 className="pv3-mate__name">{p?.name || c.title}</h2>
              <p className="pv3-mate__role">{p?.persona?.split('\n')[0] || (isZh ? '还没写它负责什么' : 'No role yet')}</p>
              <div className={`pv3-mate__state${busy ? ' is-busy' : ''}`}>
                <i aria-hidden />
                {busy ? (isZh ? '正在办' : 'Working') : (isZh ? '空闲' : 'Idle')}
                {busy && c.subtitle ? <span> · {c.subtitle}</span> : null}
              </div>
              <div className="pv3-mate__acts">
                <button type="button" className="pv3-pill" onClick={() => onTalk(c.id)}>{isZh ? '跟它说' : 'Talk'}</button>
                <button type="button" className="pv3-pill pv3-pill--soft" onClick={() => onEdit(c.id)}>{isZh ? '编辑' : 'Edit'}</button>
              </div>
            </article>
          );
        })}
        <button type="button" className={`pv3-mate pv3-mate--new${editingId === 'new' ? ' is-editing' : ''}`} onClick={onCreate}>
          <span className="pv3-mate__plus" aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </span>
          {isZh ? '新建分身' : 'New'}
        </button>
      </div>
    </div>
  );
};

const PATROL_CHOICES = [0, 30, 60, 180] as const;
function patrolLabel(m: number, zh: boolean): string {
  if (!m) return zh ? '不看' : 'Off';
  if (m < 60) return zh ? `每 ${m} 分钟` : `Every ${m} min`;
  return zh ? `每 ${m / 60} 小时` : `Every ${m / 60} h`;
}

interface DrawerProps {
  creating: boolean;
  initial?: Partial<PilotProfile>;
  onSubmit: (d: PilotDraft) => void | Promise<void>;
  onClose: () => void;
  /** 能选的模型 + 这个分身现在用的 */
  models: Array<{ id: string; name?: string }>;
  modelId: string | null;
}

/** 右边的编辑抽屉 (稿 pl7): 大头像 + 造型一排 · 名字 · 它负责 · 声音 (试听) · 模型 · 到点打电话叫我 · 定时看一眼 · 保存 */
export const PilotTeamDrawer: React.FC<DrawerProps> = ({ creating, initial, onSubmit, onClose, models, modelId: initialModel }) => {
  const { isZh } = useI18n();
  const [look, setLook] = useState(() => lookOf(initial).id);
  const [name, setName] = useState(initial?.name ?? '');
  const [persona, setPersona] = useState(initial?.persona ?? '');
  const [patrol, setPatrol] = useState<number>(initial?.patrolMinutes ?? 0);
  const [voice, setVoice] = useState(initial?.voice ?? '');
  const [ring, setRing] = useState(initial?.ringReminders !== false);
  const [model, setModel] = useState(initialModel ?? '');
  const [busy, setBusy] = useState(false);
  const [tts, setTts] = useState<{ provider?: string; model?: string } | null>(null);
  const [trying, setTrying] = useState(false);
  useEffect(() => {
    const api = (window as unknown as { neox?: { ttsGetConfig?: () => Promise<{ config?: { provider?: string; model?: string } } & { provider?: string; model?: string }> } }).neox;
    void api?.ttsGetConfig?.().then((r) => setTts(r?.config ?? r ?? {})).catch(() => setTts({}));
  }, []);
  const voices = voicesFor(tts?.provider, tts?.model);
  const tryVoice = async () => {
    if (trying) return;
    setTrying(true);
    try {
      const api = (window as unknown as { neox?: { ttsSpeak?: (t: string, v?: string) => Promise<{ audio?: string; format?: string; error?: string }> } }).neox;
      const r = await api?.ttsSpeak?.(VOICE_SAMPLE, voice || undefined);
      if (r?.audio) playTtsAudio(r.audio, r.format || 'mp3');
      else dispatchOpFailed({ op: isZh ? '试听' : 'Preview', message: r?.error || (isZh ? '合成失败' : 'Synthesis failed') });
    } finally {
      setTrying(false);
    }
  };
  const patrolIdx = Math.max(0, PATROL_CHOICES.indexOf(patrol as (typeof PATROL_CHOICES)[number]));
  const cur = PILOT_LOOKS.find((l) => l.id === look) ?? PILOT_LOOKS[3];

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onSubmit({
        name: name.trim() || (isZh ? '小助理' : 'Pilot'), avatar: cur.avatar, look: cur.id, persona: persona.trim(), patrolMinutes: patrol,
        voice, ringReminders: ring, modelId: model && model !== initialModel ? model : undefined,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="pv3-drawer" aria-label={creating ? (isZh ? '新建分身' : 'New') : (isZh ? '编辑分身' : 'Edit')}>
      <header className="pv3-drawer__head">
        <h2>{creating ? (isZh ? '新建分身' : 'New') : (isZh ? '编辑分身' : 'Edit')}</h2>
        <button type="button" className="pv3-drawer__x" onClick={onClose} aria-label={isZh ? '关闭' : 'Close'}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <form className="pv3-drawer__body" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="pv3-drawer__face"><img src={cur.src} alt="" draggable={false} /></div>
        <div className="pv3-drawer__looks" role="radiogroup" aria-label={isZh ? '形象' : 'Look'}>
          {PILOT_LOOKS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={look === l.id}
              title={l.label[isZh ? 0 : 1]}
              className={`pv3-drawer__look${look === l.id ? ' is-on' : ''}`}
              onClick={() => setLook(l.id)}
            >
              <img src={l.src} alt="" draggable={false} />
            </button>
          ))}
        </div>
        <label className="pv3-field">
          <span>{isZh ? '名字' : 'Name'}</span>
          <input value={name} maxLength={24} autoFocus={creating} placeholder={isZh ? '比如 小航' : 'e.g. Nova'} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="pv3-field">
          <span>{isZh ? '它负责' : 'Handles'}</span>
          <textarea
            value={persona}
            rows={4}
            maxLength={600}
            placeholder={isZh ? '比如 帮你盯日程和提醒，到点打电话叫你' : 'e.g. Watch my calendar; call me when it is time'}
            onChange={(e) => setPersona(e.target.value)}
          />
        </label>
        <div className="pv3-field">
          <span>{isZh ? '声音' : 'Voice'}</span>
          <div className="pv3-field__pair">
            {voices.length > 0 ? (
              <CustomSelect
                value={voice}
                onChange={setVoice}
                options={[{ value: '', label: isZh ? '跟设置里一样' : 'Same as settings' }, ...voices.map((v) => ({ value: v.id, label: v.label }))]}
              />
            ) : (
              <span className="pv3-field__note">{isZh ? '跟设置里的语音一样 (这个引擎没有可选音色)' : 'Same as settings (this engine has no voice list)'}</span>
            )}
            <button type="button" className="pv3-pill pv3-pill--soft" disabled={trying} onClick={() => void tryVoice()}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M7 4.5v15l12-7.5z" /></svg>
              {trying ? (isZh ? '合成中…' : '…') : (isZh ? '试听' : 'Play')}
            </button>
          </div>
        </div>
        {models.length > 0 && (
          <div className="pv3-field">
            <span>{isZh ? '模型' : 'Model'}</span>
            <CustomSelect
              value={model}
              onChange={setModel}
              placeholder={isZh ? '跟当前一样' : 'Current'}
              options={models.map((m) => ({ value: m.id, label: m.name || m.id }))}
            />
          </div>
        )}
        <div className="pv3-field pv3-field--row">
          <span>
            {isZh ? '到点打电话叫我' : 'Call me for reminders'}
            <small>{isZh ? '关了就只弹通知，不响铃' : 'Off = notification only'}</small>
          </span>
          <button type="button" role="switch" aria-checked={ring} className={`pv3-switchbtn${ring ? ' is-on' : ''}`} onClick={() => setRing((v) => !v)}><i /></button>
        </div>
        <div className="pv3-field pv3-field--row">
          <span>
            {isZh ? '定时看一眼' : 'Check in'}
            <small>{isZh ? '按分工去看，要紧才打给你' : 'Looks per its role; calls only if it matters'}</small>
          </span>
          <span className="pv3-stepper">
            <button type="button" aria-label="-" disabled={patrolIdx === 0} onClick={() => setPatrol(PATROL_CHOICES[patrolIdx - 1])}>−</button>
            <b>{patrolLabel(patrol, isZh)}</b>
            <button type="button" aria-label="+" disabled={patrolIdx === PATROL_CHOICES.length - 1} onClick={() => setPatrol(PATROL_CHOICES[patrolIdx + 1])}>+</button>
          </span>
        </div>
        <button type="submit" className="pv3-drawer__save" disabled={busy}>{creating ? (isZh ? '创建' : 'Create') : (isZh ? '保存' : 'Save')}</button>
      </form>
    </aside>
  );
};

export default PilotTeamPage;
