import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../../hooks/useI18n';
import { useNeoxRuntimeOptional } from '../../../../app/NeoxRuntimeContext';
import { startVoiceStream, type VoiceStream } from '../../../../utils/voiceStream';
import { CustomSelect } from '../../../../components/CustomSelect';
import Icons from '../../../../components/Icons';
import { NeoxButton, NeoxInput, SettingsRow, SwitchRow } from '../../../../components/settings-base';
import { Glyph, WaveIcon } from './VoiceParts';

/* ==================== 语音对话专用模型 ==================== */

export const VoiceModelSelect: React.FC<{ zh: boolean; value: string; onChange: (v: string) => void }> = ({ zh, value, onChange }) => {
  const runtime = useNeoxRuntimeOptional();
  const models = runtime?.availableModels ?? [];
  return (
    <div style={{ width: 'min(100%, 240px)' }}>
      <CustomSelect
        value={value}
        onChange={onChange}
        options={[
          { value: '', label: zh ? '跟随会话 (默认)' : 'Follow session (default)' },
          ...models.map(m => ({ value: m.id, label: m.name || m.id })),
        ]}
      />
    </div>
  );
};

/* ==================== 声纹锁 (嘈杂环境 L2) ====================
 * 注册主人声纹, 语音对话只认你 —— 电视 / 旁人全挡。全本地 CAM++ ONNX (~28MB 首次启用下载), 零 API 零上传。 */

interface VoiceLockStatus { enabled: boolean; enrolled: boolean; modelReady: boolean; createdAt?: number }

const ENROLL_SECONDS = 5;

export const VoiceLockRows: React.FC<{ zh: boolean }> = ({ zh }) => {
  const [status, setStatus] = useState<VoiceLockStatus>({ enabled: false, enrolled: false, modelReady: false });
  const [phase, setPhase] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [countdown, setCountdown] = useState(ENROLL_SECONDS);
  const [err, setErr] = useState<string | null>(null);
  const streamRef = useRef<VoiceStream | null>(null);

  const refresh = useCallback(async () => {
    try {
      const api = window.neox as unknown as { voiceprintStatus?: () => Promise<VoiceLockStatus> };
      const r = await api.voiceprintStatus?.();
      if (r) setStatus(r);
    } catch { /* noop */ }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const setEnabled = useCallback(async (v: boolean) => {
    setStatus(st => ({ ...st, enabled: v }));
    const api = window.neox as unknown as { sttSetConfig?: (u: Record<string, unknown>) => Promise<unknown> };
    await api.sttSetConfig?.({ voiceLockEnabled: v });
  }, []);

  const enroll = useCallback(async () => {
    setErr(null);
    setPhase('recording');
    setCountdown(ENROLL_SECONDS);
    const chunks: ArrayBuffer[] = [];
    try {
      streamRef.current = await startVoiceStream((c) => { chunks.push(c.slice(0)); }, {});
    } catch {
      setErr(zh ? '麦克风权限被拒绝' : 'Microphone permission denied');
      setPhase('idle');
      return;
    }
    for (let i = ENROLL_SECONDS; i > 0; i--) {
      setCountdown(i);
      await new Promise(r => setTimeout(r, 1000));
    }
    try { streamRef.current?.stop(); } catch { /* noop */ }
    streamRef.current = null;
    setPhase('processing');
    try {
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { merged.set(new Uint8Array(c), off); off += c.byteLength; }
      let bin = '';
      for (let i = 0; i < merged.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, merged.subarray(i, i + 0x8000) as unknown as number[]);
      }
      const api = window.neox as unknown as { voiceprintEnroll?: (b64: string) => Promise<{ ok?: boolean; error?: string }> };
      const r = await api.voiceprintEnroll?.(btoa(bin));
      if (!r?.ok) setErr(r?.error || (zh ? '注册失败' : 'Enroll failed'));
      await refresh();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setPhase('idle');
  }, [refresh, zh]);

  const clear = useCallback(async () => {
    const api = window.neox as unknown as { voiceprintClear?: () => Promise<unknown> };
    await api.voiceprintClear?.();
    await refresh();
  }, [refresh]);

  useEffect(() => () => { try { streamRef.current?.stop(); } catch { /* noop */ } }, []);

  const enrollLabel = phase === 'recording'
    ? (zh ? `请正常说话… ${countdown}s` : `Keep talking… ${countdown}s`)
    : phase === 'processing'
      ? (zh ? (status.modelReady ? '提取声纹中…' : '首次下载模型中 (~28MB)…') : 'Processing…')
      : status.enrolled
        ? (zh ? '重新注册' : 'Re-enroll')
        : (zh ? '注册我的声纹 (说 5 秒话)' : 'Enroll my voice (5s)');

  return (
    <>
      <SwitchRow
        leading={<Glyph><Icons.User /></Glyph>}
        title={zh ? '只听我的声音' : 'Only listen to me'}
        desc={zh
          ? '语音对话只认注册过的声音，旁人说话直接忽略。本地比对，声音不上传。'
          : 'Voice chat only responds to the enrolled voice — TV and bystanders are ignored. Fully on-device.'}
        checked={status.enabled}
        onChange={(v) => void setEnabled(v)}
      />
      {status.enabled && (
        <SettingsRow
          title={status.enrolled
            ? (zh ? `已注册${status.createdAt ? ' · ' + new Date(status.createdAt).toLocaleDateString() : ''}` : 'Enrolled')
            : (zh ? '还没注册声纹' : 'Not enrolled yet')}
          desc={err ?? (zh ? '找个安静点的地方，用平常的音量说几句话' : 'Enroll in a quiet spot, speak normally')}
          control={
            <div style={{ display: 'flex', gap: 8 }}>
              <NeoxButton variant="primary" size="sm" onClick={() => void enroll()} disabled={phase !== 'idle'}>
                {enrollLabel}
              </NeoxButton>
              {status.enrolled && phase === 'idle' && (
                <NeoxButton variant="ghost" size="sm" onClick={() => void clear()}>
                  {zh ? '清除' : 'Clear'}
                </NeoxButton>
              )}
            </div>
          }
        />
      )}
    </>
  );
};

/* ==================== 唤醒词 (macOS) ====================
 * 走 macOS SFSpeechRecognizer 常驻监听 + 关键词匹配。本地识别 (requiresOnDeviceRecognition=true), 数据不出机器。 */

interface WakeWordServiceState {
  supported: boolean;
  running: boolean;
  permission: { speech: string; mic: string };
  enabled: boolean;
  keywords: string[];
  locale: string;
}

export const WakeWordRows: React.FC = () => {
  const { isZh } = useI18n();
  const [state, setState] = useState<WakeWordServiceState>({
    supported: false, running: false,
    permission: { speech: 'notDetermined', mic: 'notDetermined' },
    enabled: false, keywords: [], locale: 'zh-CN',
  });
  const [enabled, setEnabled] = useState(false);
  const [keywordsText, setKeywordsText] = useState('hey neox, 嘿 neox, neox');
  const [locale, setLocale] = useState('zh-CN');
  const [lastPartial, setLastPartial] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const api = (window as unknown as {
      neox?: { wakeWordGetState?: () => Promise<WakeWordServiceState> }
    }).neox;
    void api?.wakeWordGetState?.().then((s) => {
      if (s) {
        setState(s);
        /* 从主进程持久化状态回填 UI (关面板/重启 app 后不再丢) */
        setEnabled(s.enabled === true);
        if (s.keywords && s.keywords.length > 0) setKeywordsText(s.keywords.join(', '));
        if (s.locale) setLocale(s.locale);
      }
    });
    /* 订阅状态变化 (Swift 桥推的事件由 wakeWordClient 广播到 window 上) */
    const onStateChange = (e: Event) => {
      const detail = (e as CustomEvent<any>).detail;
      if (detail?.type === 'permission') {
        setState(s => ({ ...s, permission: { speech: detail.speech || 'unknown', mic: detail.mic || 'unknown' } }));
      }
      if (detail?.type === 'started') setState(s => ({ ...s, running: true }));
      if (detail?.type === 'stopped') setState(s => ({ ...s, running: false }));
    };
    const onPartial = (e: Event) => {
      const detail = (e as CustomEvent<any>).detail;
      if (detail?.text) setLastPartial(detail.text);
    };
    window.addEventListener('neox:wake-word-state', onStateChange);
    window.addEventListener('neox:wake-word-partial', onPartial);
    return () => {
      window.removeEventListener('neox:wake-word-state', onStateChange);
      window.removeEventListener('neox:wake-word-partial', onPartial);
    };
  }, []);

  const parseKeywords = (s: string): string[] =>
    s.split(/[,，、;；]/).map(k => k.trim().toLowerCase()).filter(Boolean);

  const applyConfig = useCallback(async (nextEnabled: boolean, nextKws?: string[], nextLocale?: string) => {
    setSaving(true);
    try {
      const api = (window as unknown as {
        neox?: { wakeWordSetConfig?: (c: any) => Promise<{ ok: boolean; error?: string }> }
      }).neox;
      const kws = nextKws || parseKeywords(keywordsText);
      const res = await api?.wakeWordSetConfig?.({ enabled: nextEnabled, keywords: kws, locale: nextLocale || locale });
      if (res && !res.ok) {
        const m = await import('../../../../components/notifyEvents');
        m.dispatchHint(`唤醒词: ${res.error || '未知错误'}`, 'warning');
      }
    } finally {
      setSaving(false);
    }
  }, [keywordsText, locale]);

  const permBadge = (v: string): string => ({
    granted: '已授权', denied: '已拒绝', restricted: '受限', notDetermined: '未询问', unknown: '未知',
  })[v] ?? v;

  if (!state.supported) return null;

  return (
    <>
      <SwitchRow
        leading={<Glyph><WaveIcon /></Glyph>}
        title={isZh ? '唤醒词' : 'Wake word'}
        desc={isZh ? '说出关键词就进入语音对话，本机识别，不上云。' : 'Say the keyword to start voice chat. On-device, no cloud.'}
        checked={enabled}
        disabled={saving}
        onChange={(next) => {
          setEnabled(next);
          void applyConfig(next);
        }}
      />
      {enabled && <>
        <SettingsRow
          title={isZh ? '关键词' : 'Keywords'}
          desc={isZh ? '逗号分隔，命中任一个就触发' : 'Comma-separated; any match triggers'}
          control={
            <div style={{ width: 'min(100%, 320px)' }}>
              <NeoxInput
                value={keywordsText}
                onChange={(e) => setKeywordsText(e.target.value)}
                onBlur={() => void applyConfig(enabled, parseKeywords(keywordsText))}
                placeholder="hey neox, 嘿 neox"
                disabled={saving}
              />
            </div>
          }
        />
        <SettingsRow
          advanced
          title={isZh ? '识别语言' : 'Locale'}
          desc={isZh ? '中英混说选中文' : 'Recognizer locale'}
          control={
            <div style={{ width: 'min(100%, 180px)' }}>
              <CustomSelect
                value={locale}
                onChange={(v) => { setLocale(v); void applyConfig(enabled, undefined, v); }}
                options={[
                  { value: 'zh-CN', label: '中文 (普通话)' },
                  { value: 'en-US', label: 'English (US)' },
                  { value: 'en-GB', label: 'English (UK)' },
                  { value: 'ja-JP', label: '日本語' },
                ]}
              />
            </div>
          }
        />
        <SettingsRow
          advanced
          title={isZh ? '权限' : 'Permission'}
          desc={isZh ? '被拒绝的话到 系统设置 → 隐私 里打开' : 'If denied, enable in System Settings → Privacy'}
          control={
            <div style={{ fontSize: 12, color: 'var(--neox-fg-secondary)', display: 'flex', gap: 10 }}>
              <span>{isZh ? '语音' : 'Speech'}: {permBadge(state.permission.speech)}</span>
              <span>·</span>
              <span>{isZh ? '麦克风' : 'Mic'}: {permBadge(state.permission.mic)}</span>
            </div>
          }
        />
        <SettingsRow
          advanced
          title={isZh ? '实时诊断' : 'Live'}
          desc={isZh ? '看看你的话被听成了什么，据此调关键词' : 'See what was recognized and tune keywords'}
          control={
            <div style={{ maxWidth: 360, fontSize: 12, color: 'var(--neox-fg-secondary)' }}>
              <div style={{ marginBottom: 4 }}>
                <span style={{ color: state.running ? '#22c55e' : 'var(--neox-fg-tertiary)' }}>
                  {state.running ? (isZh ? '● 监听中' : '● Listening') : (isZh ? '○ 未运行' : '○ Stopped')}
                </span>
              </div>
              <div style={{ fontStyle: 'italic', color: 'var(--neox-fg-tertiary)', minHeight: 18 }}>
                {lastPartial
                  ? `“${lastPartial.length > 80 ? '…' + lastPartial.slice(-80) : lastPartial}”`
                  : (state.running ? (isZh ? '还没听到内容，说句话试试' : 'Nothing yet — say something') : '')}
              </div>
            </div>
          }
        />
      </>}
    </>
  );
};
