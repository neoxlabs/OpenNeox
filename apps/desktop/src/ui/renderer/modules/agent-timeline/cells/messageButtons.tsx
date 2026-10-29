/* ============================================================
 * messageButtons — 复制 / 编辑并重发 / 重试 共用按钮
 *   从 MessageRow.tsx 抽出 (Phase 3.7) — UserCell / AssistantTextCell 共用.
 *   编辑并重发派 neox:composer:prefill 事件, TimelineComposer 监听后填回输入框.
 * ============================================================ */

import React, { useEffect, useState } from 'react';
import { marked } from 'marked';
import { dispatchHint } from '../../../components/notifyEvents';
import { subscribeTtsPlayback, isTtsPlaying, stopTtsPlayback, getTtsPlayer, playTtsAudio } from '../../../utils/ttsPlayer';
import { useI18n, getGlobalLanguage } from '../../../hooks/useI18n';

/** 按句末标点切, 太短的并进下一句 (单个「好。」单独合成一段, 前后停顿会很怪) */
export function splitForSpeech(text: string, minChars = 6): string[] {
  const parts = text.split(/(?<=[。！？!?；;…\n])/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let carry = '';
  for (const p of parts) {
    const cur = carry + p;
    if (cur.replace(/\s/g, '').length < minChars) { carry = cur; continue; }
    out.push(cur);
    carry = '';
  }
  if (carry) {
    if (out.length) out[out.length - 1] += carry;
    else out.push(carry);
  }
  return out;
}

async function replayMessageText(text: string, setBusy: (b: boolean) => void): Promise<void> {
  const zh = getGlobalLanguage() === 'zh';
  try {
    setBusy(true);
    getTtsPlayer().setMuted(false);
    stopTtsPlayback();
    const api = window.neox as unknown as {
      ttsSpeak?: (t: string) => Promise<{ audio?: string; format?: string; voiceSummary?: string; error?: string }>;
      ttsGetConfig?: () => Promise<{ provider?: string; apiKey?: string }>;
    };

    const cfg = await api.ttsGetConfig?.().catch(() => null);
    const provider = cfg?.provider || '';
    /* 这几家必须有 key 才可能出声; edge / local / neoxcloud 不需要用户填 */
    const NEEDS_KEY = ['dashscope', 'openai', 'custom', 'xfyun', 'volc'];
    if (provider && NEEDS_KEY.includes(provider) && !cfg?.apiKey) {
      dispatchHint(
        zh ? `请先配置语音合成: 设置 → 语音 → 给「${provider}」填 API Key`
           : `Set up text-to-speech first: Settings → Voice → add an API key for "${provider}"`,
        'warning',
      );
      return;
    }

    const sentences = splitForSpeech(text);
    let r: Awaited<ReturnType<NonNullable<typeof api.ttsSpeak>>> | undefined;
    let played = 0;
    for (const s of sentences) {
      r = await api.ttsSpeak?.(s);
      if (!r?.audio) break;
      playTtsAudio(r.audio, r.format || 'mp3', r.voiceSummary);
      played += 1;
    }
    if (played > 0) { /* 读出来了 (中途哪句失败就停在那儿, 不补报错) */ }
    else {
      const raw = String(r?.error ?? '').trim();
      if (raw) console.warn('[TTS] ttsSpeak failed:', raw);
      const GENERIC = /^合成失败|^synthesis failed/i;
      const detail = raw && !GENERIC.test(raw) ? raw : '';
      dispatchHint(
        zh
          ? `朗读失败${detail ? `: ${detail.slice(0, 120)}` : ''} — 去 设置 → 语音 换个声音引擎或检查 API Key`
          : `Read-aloud failed${detail ? `: ${detail.slice(0, 120)}` : ''} — open Settings → Voice to switch engine or check the API key`,
        'warning',
      );
    }
  } catch {
    dispatchHint(zh ? '朗读失败' : 'Read-aloud failed', 'warning');
  } finally {
    setBusy(false);
  }
}

export const SpeakButton: React.FC<{ text: string; size?: 'sm' | 'md'; quiet?: boolean }> = ({ text, size = 'md', quiet }) => {
  const { isZh } = useI18n();
  const [playing, setPlaying] = useState(() => isTtsPlaying());
  const [busy, setBusy] = useState(false);
  useEffect(() => subscribeTtsPlayback(setPlaying), []);
  const dim = size === 'sm' ? 11 : 13;
  const base = size === 'sm' ? 'atl-msg__copy' : 'atl-msg__footer-btn';
  const cls = quiet ? `${base} atl-msg__footer-btn--quiet` : base;
  if (playing) {
    return (
      <button
        type="button"
        className={`${cls} atl-msg__speak is-speaking`}
        title={isZh ? '停止朗读' : 'Stop reading'}
        aria-label={isZh ? '停止朗读' : 'Stop reading'}
        onClick={() => { getTtsPlayer().setMuted(true); stopTtsPlayback(); }}
      >
        <svg viewBox="0 0 14 14" width={dim} height={dim} fill="currentColor" aria-hidden="true">
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
        </svg>
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`${cls} atl-msg__speak${busy ? ' is-busy' : ''}`}
      title={isZh ? '朗读这条' : 'Read this aloud'}
      aria-label={isZh ? '朗读这条' : 'Read this aloud'}
      data-label={isZh ? '朗读' : 'Read'}
      disabled={busy}
      onClick={() => void replayMessageText(text, setBusy)}
    >
      {busy ? (
        <svg viewBox="0 0 14 14" width={dim} height={dim} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" className="atl-msg__speak-spin" aria-hidden="true">
          <path d="M7 1.8a5.2 5.2 0 1 0 5.2 5.2" />
        </svg>
      ) : (
        <svg viewBox="0 0 14 14" width={dim} height={dim} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2.5 5.5v3h2l2.8 2.3V3.2L4.5 5.5h-2z" fill="currentColor" stroke="none" />
          <path d="M9.4 5a3 3 0 0 1 0 4M11 3.4a5.2 5.2 0 0 1 0 7.2" />
        </svg>
      )}
    </button>
  );
};



async function copyMessage(text: string): Promise<void> {
  const html = await marked.parse(text, { gfm: true, breaks: false });
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
    await navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob([text], { type: 'text/plain' }),
      'text/html': new Blob([html], { type: 'text/html' }),
    })]);
    return;
  }
  await navigator.clipboard.writeText(text);
}

/** 大尺寸 footer 按钮 — 13×13 SVG, 跟 hover 的小按钮形态独立 */
export const FooterCopyButton: React.FC<{ text: string }> = ({ text }) => {
  const { isZh } = useI18n();
  return (
  <button
    type="button"
    className="atl-msg__footer-btn"
    title={isZh ? '复制' : 'Copy'}
    aria-label={isZh ? '复制消息' : 'Copy message'}
    data-label={isZh ? '复制' : 'Copy'}
    onClick={() => {
      copyMessage(text).then(
        () => dispatchHint(isZh ? '已复制' : 'Copied', 'success'),
        () => dispatchHint(isZh ? '复制失败' : 'Copy failed', 'warning'),
      );
    }}
  >
    <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />
      <path d="M2.5 9.5V3a1 1 0 0 1 1-1H9" />
    </svg>
  </button>
  );
};

export const FooterEditButton: React.FC<{ onEdit: () => void }> = ({ onEdit }) => {
  const { isZh } = useI18n();
  return (
  <button
    type="button"
    className="atl-msg__footer-btn"
    title={isZh ? '编辑并重发' : 'Edit & resend'}
    aria-label={isZh ? '编辑并重发' : 'Edit & resend'}
    onClick={onEdit}
  >
    <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 2.5l2 2L5 11l-2.5.5L3 9z" />
    </svg>
  </button>
  );
};

export const FooterRewindButton: React.FC<{ onRewind: () => void }> = ({ onRewind }) => {
  const { isZh } = useI18n();
  const label = isZh ? '退回到这条之前' : 'Rewind to before this';
  return (
  <button
    type="button"
    className="atl-msg__footer-btn"
    title={label}
    aria-label={label}
    onClick={onRewind}
  >
    <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.5 3.5L2.5 6.5l3 3" />
      <path d="M2.5 6.5h5.5a3 3 0 0 1 0 6H6" />
    </svg>
  </button>
  );
};


