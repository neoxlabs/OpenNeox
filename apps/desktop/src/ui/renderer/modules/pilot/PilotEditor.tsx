import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../hooks/useI18n';
import { PilotAvatar } from './PilotAvatar';
import type { PilotAvatarKind, PilotProfile } from './pilotStore';

export interface PilotDraft {
  name: string;
  avatar: PilotAvatarKind;
  /** 分身卡造型 (v3/pilotLooks.ts) */
  look?: string;
  /** 声音 ('' = 跟设置里的) */
  voice?: string;
  /** 到点提醒打不打电话 */
  ringReminders?: boolean;
  /** 这个分身用的模型 id (只在分身抽屉里选; undefined = 不改) */
  modelId?: string;
  persona: string;
  /** 定时巡检间隔 (分钟), 0 = 不看 */
  patrolMinutes: number;
}

const PATROL_CHOICES = [0, 30, 60, 180] as const;
function patrolLabel(m: number, zh: boolean): string {
  if (!m) return zh ? '不看' : 'Off';
  if (m < 60) return zh ? `每 ${m} 分钟` : `Every ${m} min`;
  return zh ? `每 ${m / 60} 小时` : `Every ${m / 60} h`;
}

interface FormProps {
  initial?: Partial<PilotProfile>;
  submitLabel: string;
  onSubmit: (draft: PilotDraft) => void | Promise<void>;
  onCancel?: () => void;
}

const PilotForm: React.FC<FormProps> = ({ initial, submitLabel, onSubmit, onCancel }) => {
  const { isZh } = useI18n();
  const [name, setName] = useState(initial?.name ?? '');
  const [avatar, setAvatar] = useState<PilotAvatarKind>(initial?.avatar ?? 'cat');
  const [persona, setPersona] = useState(initial?.persona ?? '');
  const [patrol, setPatrol] = useState<number>(initial?.patrolMinutes ?? 0);
  const [busy, setBusy] = useState(false);
  const patrolIdx = Math.max(0, PATROL_CHOICES.indexOf(patrol as (typeof PATROL_CHOICES)[number]));
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onSubmit({ name: name.trim() || (isZh ? '小助理' : 'Pilot'), avatar, persona: persona.trim(), patrolMinutes: patrol });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="pilot-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="pilot-form__looks" role="radiogroup" aria-label={isZh ? '形象' : 'Look'}>
        {(['cat', 'corgi'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={avatar === k}
            className={`pilot-form__look${avatar === k ? ' is-on' : ''}`}
            onClick={() => setAvatar(k)}
          >
            <PilotAvatar kind={k} size={88} />
            <span>{k === 'cat' ? (isZh ? '猫' : 'Cat') : (isZh ? '柯基' : 'Corgi')}</span>
          </button>
        ))}
      </div>
      <label className="pilot-form__field">
        <span>{isZh ? '叫它什么' : 'Name'}</span>
        <input
          value={name}
          maxLength={24}
          autoFocus
          placeholder={isZh ? '比如 小航' : 'e.g. Nova'}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="pilot-form__field">
        <span>{isZh ? '它负责什么' : 'What it handles'}</span>
        <textarea
          value={persona}
          rows={3}
          maxLength={600}
          placeholder={isZh
            ? '比如 帮我盯日程和邮件, 早上八点打电话给我讲今天的安排'
            : 'e.g. Watch my calendar and email; call me at 8am with the day ahead'}
          onChange={(e) => setPersona(e.target.value)}
        />
      </label>
      <div className="pilot-form__row">
        <span className="pilot-form__row-label">
          {isZh ? '定时看一眼' : 'Check in'}
          <small>{isZh ? '按上面的分工去看, 要紧才打给你' : 'Looks per its role; calls only if it matters'}</small>
        </span>
        <span className="pilot-stepper">
          <button type="button" aria-label="-" disabled={patrolIdx === 0} onClick={() => setPatrol(PATROL_CHOICES[patrolIdx - 1])}>−</button>
          <span className="pilot-stepper__v pilot-stepper__v--wide">{patrolLabel(patrol, isZh)}</span>
          <button type="button" aria-label="+" disabled={patrolIdx === PATROL_CHOICES.length - 1} onClick={() => setPatrol(PATROL_CHOICES[patrolIdx + 1])}>+</button>
        </span>
      </div>
      <div className="pilot-form__actions">
        {onCancel &&<button type="button" className="pilot-btn pilot-btn--ghost" onClick={onCancel}>{isZh ? '取消' : 'Cancel'}</button>}
        <button type="submit" className="pilot-btn pilot-btn--primary" disabled={busy}>{submitLabel}</button>
      </div>
    </form>
  );
};

/** 一个 Pilot 都没有时的首页 */
export const PilotWelcome: React.FC<{ onCreate: (d: PilotDraft) => void | Promise<void> }> = ({ onCreate }) => {
  const { isZh } = useI18n();
  return (
    <div className="pilot-welcome">
      <h1 className="pilot-welcome__title">{isZh ? '给自己找个会打电话的助理' : 'Get an assistant that calls you'}</h1>
      <p className="pilot-welcome__sub">
        {isZh
          ? '你说话它就听, 事情办好了、要你拍板了, 它会打给你。'
          : 'Talk to it, and it calls you when something is done or needs your call.'}
      </p>
      <PilotForm submitLabel={isZh ? '就它了' : 'Create'} onSubmit={onCreate} />
    </div>
  );
};

export const PilotEditorDialog: React.FC<{
  initial?: Partial<PilotProfile>;
  creating: boolean;
  onSubmit: (d: PilotDraft) => void | Promise<void>;
  onClose: () => void;
}> = ({ initial, creating, onSubmit, onClose }) => {
  const { isZh } = useI18n();
  return createPortal(
    <div className="pilot-dialog__scrim" role="dialog" aria-modal="true" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pilot-dialog">
        <h2 className="pilot-dialog__title">{creating ? (isZh ? '新建 Pilot' : 'New Pilot') : (isZh ? '编辑 Pilot' : 'Edit Pilot')}</h2>
        <PilotForm
          initial={initial}
          submitLabel={creating ? (isZh ? '创建' : 'Create') : (isZh ? '保存' : 'Save')}
          onSubmit={async (d) => { await onSubmit(d); onClose(); }}
          onCancel={onClose}
        />
      </div>
    </div>,
    document.body,
  );
};
