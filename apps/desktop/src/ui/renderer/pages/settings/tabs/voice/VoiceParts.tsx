/* 语音页的共用小件: 本地 / 云端二选一卡片、本地引擎行、模型行、失焦才保存的输入框 */
import React, { useEffect, useState } from 'react';
import { NeoxIllus } from '../../../../media/illus';
import { NeoxButton, NeoxInput, SettingsRow } from '../../../../components/settings-base';
import type { LocalModelRow, LocalVoice } from './useLocalVoice';

export type VoiceKind = 'local' | 'cloud';

/** 行首的软方块图标 (28px 底 + 16px 线条, 线宽 1.5 由 TtsTab.clay.css 统一压) */
export const Glyph: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="tts3-glyph" aria-hidden="true">{children}</span>
);
/** 稿里有、现成图标库里没有的两个 */
export const SpeakerIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
  </svg>
);
export const WaveIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
    <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10v4" />
  </svg>
);

/** 本地 / 云端 —— 跟对话区那两组一样的横排小卡 (.cv-choices) */
export const KindChooser: React.FC<{
  zh: boolean;
  value: VoiceKind;
  onPick: (k: VoiceKind) => void;
  localDesc: string;
  cloudDesc: string;
  localDisabled?: boolean;
}> = ({ zh, value, onPick, localDesc, cloudDesc, localDisabled }) => (
  <div className="cv-choices cv-choices--2 vc-kind" role="radiogroup" aria-label={zh ? '本地还是云端' : 'Local or cloud'}>
    {([
      { id: 'local' as const, art: NeoxIllus.runLocal, name: zh ? '本地' : 'Local', desc: localDesc, disabled: localDisabled },
      { id: 'cloud' as const, art: NeoxIllus.runCloud, name: zh ? '云端' : 'Cloud', desc: cloudDesc, disabled: false },
    ]).map((o) => (
      <button key={o.id} type="button" role="radio" aria-checked={value === o.id} disabled={o.disabled}
        className={`ws-engine${value === o.id ? ' is-on' : ''}`} onClick={() => onPick(o.id)}>
        <span className="ws-engine__stage" aria-hidden="true"><img src={o.art} alt="" draggable={false} /></span>
        <span className="ws-engine__head">
          <b>{o.name}</b>
          {value === o.id && <span className="ws-engine__tag">{zh ? '当前' : 'Current'}</span>}
        </span>
        <span className="ws-engine__desc">{o.desc}</span>
      </button>
    ))}
  </div>
);

/** 本地引擎 (原生包) —— 模型的前提: 没装它, 模型下了也跑不起来, 所以排在模型前面 */
export const EngineRow: React.FC<{ zh: boolean; lv: LocalVoice }> = ({ zh, lv }) => {
  const e = lv.engine;
  if (!e?.available || (e.installed && !lv.engineErr)) return null;
  const busy = lv.enginePct !== null;
  return (
    <SettingsRow
      title={e.outdated ? (zh ? '本地引擎有更新' : 'Local engine update') : (zh ? '先装本地引擎' : 'Install the local engine')}
      desc={lv.engineErr
        ? `✗ ${lv.engineErr}`
        : busy
          ? (zh ? `下载中 ${lv.enginePct}%` : `Downloading ${lv.enginePct}%`)
          /* sizeMB 是解压后的占用 (下载的压缩包只有它的 1/4 左右) —— 写成「占」而不是「下载」 */
          : e.outdated
            ? (zh ? `装好约占 ${e.sizeMB}MB · 更新后才能用实时识别` : `Uses ~${e.sizeMB}MB · needed for live recognition`)
            : (zh ? `装好约占 ${e.sizeMB}MB · 下面的模型都靠它运行` : `Uses ~${e.sizeMB}MB · every model below runs on it`)}
      control={
        <NeoxButton variant="primary" size="sm" onClick={() => void lv.downloadEngine()} disabled={busy}>
          {busy ? `${lv.enginePct}%` : e.outdated ? (zh ? '更新' : 'Update') : (zh ? '下载' : 'Download')}
        </NeoxButton>
      }
    />
  );
};

/** 一个模型一行: 下载 / 暂停 / 继续 / 删除 */
export const ModelRow: React.FC<{ zh: boolean; lv: LocalVoice; m: LocalModelRow; note?: string }> = ({ zh, lv, m, note }) => {
  const pct = lv.progress[m.id];
  const busy = typeof pct === 'number';
  const paused = !busy && !m.installed && typeof m.partialPct === 'number';
  const err = lv.errors[m.id];
  const state = err
    ? `✗ ${err}`
    : busy ? (zh ? `下载中 ${pct}%` : `Downloading ${pct}%`)
      : paused ? (zh ? `已暂停 ${m.partialPct}%` : `Paused ${m.partialPct}%`)
        : m.installed ? (zh ? `已装 · ${m.sizeMB}MB` : `Installed · ${m.sizeMB}MB`)
          : (zh ? `约 ${m.sizeMB}MB` : `~${m.sizeMB}MB`);
  return (
    <SettingsRow
      title={m.active ? `${m.title} · ${zh ? '使用中' : 'in use'}` : m.title}
      desc={note ? `${note} · ${state}` : state}
      control={
        <div style={{ display: 'flex', gap: 8 }}>
          {busy && <NeoxButton variant="ghost" size="sm" onClick={() => void lv.pause(m.id)}>{zh ? '暂停' : 'Pause'}</NeoxButton>}
          {!m.installed && (
            <NeoxButton variant="primary" size="sm" onClick={() => void lv.download(m.id)} disabled={busy || !lv.engineReady}>
              {busy ? `${pct}%` : paused ? (zh ? '继续' : 'Resume') : (zh ? '下载' : 'Download')}
            </NeoxButton>
          )}
          {m.installed && <NeoxButton variant="ghost" size="sm" onClick={() => void lv.remove(m.id)}>{zh ? '删除' : 'Remove'}</NeoxButton>}
        </div>
      }
    />
  );
};

/** 输入框: 打字只改本地状态, 失焦才保存 (每敲一个字存一次会把半截 key 写进配置) */
export const BlurInput: React.FC<{
  value: string;
  onSave: (v: string) => void;
  placeholder?: string;
  secret?: boolean;
  width?: number;
}> = ({ value, onSave, placeholder, secret, width = 280 }) => {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <div style={{ width: `min(100%, ${width}px)` }}>
      <NeoxInput
        type={secret ? 'password' : 'text'}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== value) onSave(draft.trim()); }}
      />
    </div>
  );
};

const EyeIcon: React.FC<{ off?: boolean }> = ({ off }) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" /><circle cx="12" cy="12" r="2.8" />
    {off && <path d="M4 4l16 16" />}
  </svg>
);
const CopyIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);
const PencilIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </svg>
);
const CheckIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);

/** SecretField 的 reveal: 问主进程要语音配置里某个 Key 的真值 */
export const revealVoiceSecret = (section: 'stt' | 'tts', field: string) => async (): Promise<string> => {
  const api = (window as unknown as { neox?: { voiceRevealSecret?: (s: string, f: string) => Promise<{ ok: boolean; value?: string }> } }).neox;
  const r = await api?.voiceRevealSecret?.(section, field);
  return r?.ok && r.value ? r.value : '';
};

export const SecretField: React.FC<{
  zh: boolean;
  /** 主进程回显的打码值 (***尾号) 或空 */
  value: string;
  onSave: (v: string) => void;
  /** 取真值 (点眼睛 / 复制时才调) */
  reveal: () => Promise<string>;
  placeholder?: string;
  width?: number;
}> = ({ zh, value, onSave, reveal, placeholder, width = 280 }) => {
  const configured = /^\*{3}/.test(value);
  const tail = configured ? value.replace(/^\*+/, '') : '';
  const [editing, setEditing] = useState(!configured);
  const [draft, setDraft] = useState('');
  const [shown, setShown] = useState(false);
  const [plain, setPlain] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { setEditing(!/^\*{3}/.test(value)); setDraft(''); setPlain(null); setShown(false); }, [value]);

  const getPlain = async () => {
    if (plain) return plain;
    const v = await reveal().catch(() => '');
    setPlain(v || null);
    return v;
  };
  const toggleShow = async () => {
    if (!shown) await getPlain();
    setShown((s) => !s);
  };
  const copy = async () => {
    const v = await getPlain();
    if (!v) return;
    try { await navigator.clipboard.writeText(v); setCopied(true); window.setTimeout(() => setCopied(false), 1400); } catch { /* 剪贴板不给就算了 */ }
  };
  const commit = () => {
    const v = draft.trim();
    if (v) onSave(v);
    if (configured) setEditing(false);
    setDraft('');
  };

  if (!editing) {
    return (
      <div className="vc-secret" style={{ width, maxWidth: '100%' }}>
        <span className={`vc-secret__value${shown && plain ? ' is-plain' : ''}`} title={shown && plain ? plain : undefined}>
          {shown && plain ? plain : `•••••••• ${tail}`}
        </span>
        <button type="button" className="vc-secret__btn" onClick={() => void toggleShow()} title={shown ? (zh ? '隐藏' : 'Hide') : (zh ? '显示' : 'Show')} aria-label={shown ? (zh ? '隐藏' : 'Hide') : (zh ? '显示' : 'Show')}>
          <EyeIcon off={shown} />
        </button>
        <button type="button" className={`vc-secret__btn${copied ? ' is-done' : ''}`} onClick={() => void copy()} title={copied ? (zh ? '已复制' : 'Copied') : (zh ? '复制' : 'Copy')} aria-label={zh ? '复制' : 'Copy'}>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
        <button type="button" className="vc-secret__btn" onClick={() => { setEditing(true); setShown(false); }} title={zh ? '换一个' : 'Replace'} aria-label={zh ? '换一个' : 'Replace'}>
          <PencilIcon />
        </button>
      </div>
    );
  }
  return (
    <div className="vc-secret vc-secret--edit" style={{ width, maxWidth: '100%' }}>
      <NeoxInput
        type={shown ? 'text' : 'password'}
        value={draft}
        autoFocus={configured}
        placeholder={configured ? (zh ? `粘贴新的，替换 …${tail}` : `Paste a new one to replace …${tail}`) : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape' && configured) { e.preventDefault(); setDraft(''); setEditing(false); }
        }}
      />
      <button type="button" className="vc-secret__btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setShown((s) => !s)} title={shown ? (zh ? '隐藏' : 'Hide') : (zh ? '显示' : 'Show')} aria-label={shown ? (zh ? '隐藏' : 'Hide') : (zh ? '显示' : 'Show')}>
        <EyeIcon off={shown} />
      </button>
    </div>
  );
};

/** 多行文本 (词库 / 专名映射): 失焦保存 */
export const BlurTextarea: React.FC<{ value: string; onSave: (v: string) => void; placeholder: string; rows?: number }> = ({ value, onSave, placeholder, rows = 4 }) => {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <textarea
      className="nx-input vc-textarea"
      rows={rows}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== value) onSave(draft); }}
    />
  );
};

/** Key 行的说明: 配了显示尾号, 没配给出去哪拿 */
export const keyDesc = (zh: boolean, v: string, where: string): string =>
  v ? (zh ? `已配置 ${v}` : `Set ${v}`) : where;
