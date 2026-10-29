import { useEffect, useRef, useState } from 'react';
import type { VoiceCallBinding } from '../voice-mode/VoiceMode';
import { pilotApi, pilotVoice, type PilotCall } from './pilotStore';

type Audio = { audio: string; format?: string; voiceSummary?: string };

export function usePilotCallController(): { call: VoiceCallBinding | null; end: () => void } {
  const [call, setCall] = useState<VoiceCallBinding | null>(null);
  const preSynth = useRef(new Map<string, Promise<Audio | null>>());

  useEffect(() => {
    const api = pilotApi() as ReturnType<typeof pilotApi> & {
      ttsSpeak?: (t: string, voice?: string) => Promise<Audio & { error?: string }>;
    };

    const synth = (c: PilotCall) => {
      if (!c.opening || preSynth.current.has(c.id)) return;
      /* 开场白用打来的这个分身自己的声音 */
      const job = (api.ttsSpeak?.(c.opening, pilotVoice(c.sessionId)) ?? Promise.resolve(null))
        .then((r) => (r?.audio ? { audio: r.audio, format: r.format, voiceSummary: r.voiceSummary } : null))
        .catch(() => null);
      preSynth.current.set(c.id, job);
    };

    const connect = async (c: PilotCall) => {
      if (c.sessionId) {
        window.dispatchEvent(new CustomEvent('neox:select-session', { detail: { sessionId: c.sessionId } }));
      }
      synth(c);
      /* 合成还没好就最多等 1.5s —— 再慢宁可先开听, 开场白由 VoiceMode 自己现合成 */
      const pending = preSynth.current.get(c.id);
      const audio = pending
        ? await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), 1500))])
        : null;
      preSynth.current.delete(c.id);
      setCall({ id: c.id, opening: c.opening || undefined, openingAudio: audio, voice: pilotVoice(c.sessionId) });
    };

    const offs = [
      api.onPilotCall?.('incoming', (c: PilotCall) => synth(c)),
      api.onPilotCall?.('connect', (c: PilotCall) => void connect(c)),
      api.onPilotCall?.('open-session', (p: { sessionId?: string }) => {
        if (p?.sessionId) window.dispatchEvent(new CustomEvent('neox:select-session', { detail: { sessionId: p.sessionId } }));
      }),
      api.onPilotCall?.('state', (s: PilotCall | null) => {
        /* 没接起来就结束了 (拒接 / 超时): 丢掉合成好的开场白 */
        if (!s) preSynth.current.clear();
      }),
    ];
    const onLocal = (e: Event) => {
      const c = (e as CustomEvent<PilotCall>).detail;
      if (c?.id) void connect(c);
    };
    window.addEventListener('neox:pilot-call-connect', onLocal);
    return () => {
      for (const off of offs) off?.();
      window.removeEventListener('neox:pilot-call-connect', onLocal);
    };
  }, []);

  return { call, end: () => setCall(null) };
}
