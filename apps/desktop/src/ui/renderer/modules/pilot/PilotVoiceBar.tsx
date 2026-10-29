import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { useNeoxRuntimeOptional } from '../../app/NeoxRuntimeContext';
import { startVoiceStream, type VoiceStream } from '../../utils/voiceStream';

type Phase = 'idle' | 'listening' | 'finishing';

interface SttEvent { streamId: string; type: string; text?: string; message?: string }
interface SttApi {
  sttStreamStart?: () => Promise<{ ok: boolean; streamId?: string; error?: string }>;
  sttStreamAudio?: (id: string, chunk: ArrayBuffer) => void;
  sttStreamStop?: (id: string) => Promise<unknown>;
  onSttStreamEvent?: (cb: (e: SttEvent) => void) => () => void;
}
const stt = (): SttApi => ((window as unknown as { neox?: SttApi }).neox ?? {});

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/** 有弹窗盖着 (编辑 Pilot / 卡片放大 / 设置) 时不抢键盘。
 * 设置页关着时也挂在 DOM 里 (visibility:hidden), 只认看得见的 */
const modalOpen = () => [...document.querySelectorAll('[aria-modal="true"]')]
  .some((el) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true }));

/** onSent: 说完 / 打完一句发出去之后 (今天页用它跳到对话页看回复) */
export const PilotVoiceBar: React.FC<{ onSent?: () => void }> = ({ onSent }) => {
  const { isZh } = useI18n();
  const runtime = useNeoxRuntimeOptional();
  const [phase, setPhase] = useState<Phase>('idle');
  const [heard, setHeard] = useState('');
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0);
  const [draft, setDraft] = useState('');
  const [composing, setComposing] = useState(false);
  const drafting = draft !== '' || composing;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rec = useRef<VoiceStream | null>(null);
  const streamId = useRef<string | null>(null);
  const unsub = useRef<(() => void) | null>(null);
  const text = useRef('');
  const raf = useRef(0);

  const cleanup = useCallback(() => {
    try { rec.current?.stop(); } catch { /* 已经停了 */ }
    rec.current = null;
    unsub.current?.();
    unsub.current = null;
    streamId.current = null;
    cancelAnimationFrame(raf.current);
    setLevel(0);
  }, []);
  useEffect(() => cleanup, [cleanup]);

  const send = useCallback((said: string) => {
    const s = said.trim();
    if (s && runtime) { void runtime.sendPrompt(s); onSent?.(); }
  }, [runtime, onSent]);

  useEffect(() => {
    const onFill = (e: Event) => {
      const d = (e as CustomEvent<{ text?: string; send?: boolean; images?: Array<{ mediaType: string; data: string; name?: string }> }>).detail;
      const t = d?.text?.trim();
      if (!d?.send || !t || !runtime) return;
      void (async () => {
        if (runtime.streaming) { try { await runtime.stopCurrent(); } catch { /* 停不了就排着 */ } }
        await runtime.sendPrompt(t, d.images?.length ? { images: d.images } : undefined);
      })();
    };
    window.addEventListener('neox:composer-fill', onFill);
    return () => window.removeEventListener('neox:composer-fill', onFill);
  }, [runtime]);

  /* 收口: 停采集, 等识别给 final; 网关不给 final 也有超时兜住, 免得卡在「在听」 */
  const finish = useCallback(async () => {
    const id = streamId.current;
    if (!id) return;
    try { rec.current?.stop(); } catch { /* noop */ }
    rec.current = null;
    cancelAnimationFrame(raf.current);
    setLevel(0);
    setPhase('finishing');
    await stt().sttStreamStop?.(id)?.catch?.(() => {});
    window.setTimeout(() => {
      if (streamId.current !== id) return;
      cleanup();
      send(text.current);
      setPhase('idle');
    }, 3000);
  }, [cleanup, send]);

  const start = useCallback(async (autoStop: boolean) => {
    if (phase !== 'idle') return;
    setError('');
    setHeard('');
    setDraft('');
    text.current = '';
    const res: { ok: boolean; streamId?: string; error?: string } | undefined = await stt().sttStreamStart?.()
      .catch((e: Error) => ({ ok: false, error: e.message }));
    if (!res?.ok || !res.streamId) {
      setError(res?.error || (isZh ? '语音识别没起来, 去 设置 → 语音 看一下' : 'Speech recognition unavailable — check Settings → Voice'));
      return;
    }
    const id = res.streamId;
    streamId.current = id;
    unsub.current = stt().onSttStreamEvent?.((e) => {
      if (e.streamId !== id) return;
      if ((e.type === 'transcript' || e.type === 'final') && e.text) {
        text.current = e.text;
        setHeard(e.text);
      }
      if (e.type === 'final' || e.type === 'close') {
        cleanup();
        send(text.current);
        setPhase('idle');
      } else if (e.type === 'error') {
        cleanup();
        setError(e.message || (isZh ? '没听清' : 'Didn’t catch that'));
        setPhase('idle');
      }
    }) ?? null;
    try {
      rec.current = await startVoiceStream(
        (chunk) => stt().sttStreamAudio?.(id, chunk),
        autoStop ? { silenceMs: 1200, onSilence: () => { void finish(); } } : {},
      );
    } catch (err) {
      cleanup();
      setError((err as Error)?.name === 'NotAllowedError'
        ? (isZh ? '没有麦克风权限' : 'Microphone permission denied')
        : (isZh ? '麦克风打不开' : 'Microphone unavailable'));
      return;
    }
    setPhase('listening');
    /* 麦克风音量 → 球的光圈 */
    const an = rec.current.analyser;
    const buf = new Uint8Array(an.frequencyBinCount);
    const tick = () => {
      an.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i];
      setLevel(Math.min(1, sum / buf.length / 90));
      raf.current = requestAnimationFrame(tick);
    };
    tick();
  }, [phase, isZh, cleanup, send, finish]);

  /* 键盘: 按住空格说话; 敲字 / 粘贴 → 打字行 */
  const holding = useRef(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey || modalOpen() || e.isComposing) return;
      if (e.code === 'Space') {
        if (e.repeat) { e.preventDefault(); return; }
        e.preventDefault();
        holding.current = true;
        void start(false);
        return;
      }
      /* 敲字: 只把焦点挪到打字行, 不拦这个键 —— 这一下连同输入法 (key = 'Process') 都落进打字行,
       * 中文拼音的第一个字母不会丢 */
      if ((e.key.length === 1 || e.key === 'Process') && phase === 'idle') {
        setError('');
        inputRef.current?.focus();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !holding.current) return;
      e.preventDefault();
      holding.current = false;
      void finish();
    };
    const paste = (e: ClipboardEvent) => {
      if (isEditable(e.target) || modalOpen() || phase !== 'idle') return;
      const t = e.clipboardData?.getData('text') ?? '';
      if (!t) return;
      e.preventDefault();
      setDraft((d) => d + t);
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('paste', paste);
    };
  }, [phase, start, finish]);

  const submitDraft = () => {
    send(draft);
    setDraft('');
  };

  const onOrb = () => {
    if (draft.trim()) { submitDraft(); return; }
    if (phase === 'listening') void finish();
    else if (phase === 'idle') void start(true);
  };

  const hint = phase !== 'idle'
    ? (heard || (isZh ? '在听…' : 'Listening…'))
    : error || (isZh ? '点一下, 或按住空格说话' : 'Tap, or hold Space to talk');

  return (
    <div className={`pilot-voice is-${phase}${drafting ? ' is-drafting' : ''}`}>
      {/* 打字行一直挂着 (看不见), 敲字时焦点挪过来; 有字 / 输入法在拼时才显形 */}
      <input
        ref={inputRef}
        className={`pilot-voice__draft${drafting ? '' : ' is-hidden'}`}
        value={draft}
        tabIndex={drafting ? 0 : -1}
        aria-label={isZh ? '打字跟它说' : 'Type to it'}
        placeholder={isZh ? '打字跟它说, 回车发' : 'Type, Enter to send'}
        onChange={(e) => setDraft(e.target.value)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') { e.preventDefault(); submitDraft(); }
          else if (e.key === 'Escape') { e.preventDefault(); setDraft(''); e.currentTarget.blur(); }
          /* 打字行空着时空格仍是「按住说话」 */
          else if (e.code === 'Space' && !draft) {
            e.preventDefault();
            if (!e.repeat) { holding.current = true; e.currentTarget.blur(); void start(false); }
          }
        }}
      />
      {!drafting && (
        <div className={`pilot-voice__said${error && phase === 'idle' ? ' is-error' : ''}${heard && phase !== 'idle' ? ' has-text' : ''}`}>{hint}</div>
      )}
      <button
        type="button"
        className="pilot-voice__orb"
        onClick={onOrb}
        disabled={phase === 'finishing'}
        aria-label={draft.trim() ? (isZh ? '发送' : 'Send') : phase === 'listening' ? (isZh ? '说完了' : 'Done') : (isZh ? '说话' : 'Talk')}
        style={{ ['--lv' as string]: String(level) }}
      >
        <span className="pilot-voice__ring" aria-hidden />
        <span className="pilot-voice__core">
          {draft.trim() ? (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 19V5M6 11l6-6 6 6" /></svg>
          ) : phase === 'listening' ? (
            <span className="pilot-voice__bars" aria-hidden><i /><i /><i /><i /></span>
          ) : (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
              <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" stroke="none" />
              <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
            </svg>
          )}
        </span>
      </button>
    </div>
  );
};
