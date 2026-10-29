import { getEditionHook, useEditionMembership, type EditionMembership } from '../shell/editionHooks';

/** 网关上的识别模型 (NeoxCloud model-gateway dashscopeasr) */
export const VOICE_ASR_MODEL = 'fun-asr-realtime';

export function voiceIncludedIn(m: EditionMembership | null | undefined): boolean {
  return !!m?.models?.some((x) => x.modelId === VOICE_ASR_MODEL && x.allowed);
}

export function hasVoiceSubscriptionNow(): boolean {
  return voiceIncludedIn(getEditionHook('getMembershipNow')());
}

export function useVoiceSubscription(): boolean {
  return voiceIncludedIn(useEditionMembership());
}

interface ProbeResult {
  ok?: boolean;
  avail?: Partial<Record<'official' | 'xfyun' | 'dashscope' | 'volc' | 'custom' | 'local', boolean>>;
  selected?: string;
}

/**
 * 'ready' = 交给主进程开流 (它按 config.stt 选家); 'setup' = 弹引导。
 * 主进程的自动档顺序是 本地 → 讯飞 → 自定义 → 订阅网关, 这里按同样的顺序判, 两边口径一致。
 */
export async function voiceReadiness(): Promise<'ready' | 'setup'> {
  const probe = await ((window as unknown as { neox?: { sttProbeProviders?: () => Promise<ProbeResult> } }).neox?.sttProbeProviders?.()
    .catch(() => null)) ?? null;
  const av = probe?.avail ?? {};
  const sel = probe?.selected ?? 'auto';
  const subscribed = hasVoiceSubscriptionNow();
  if (sel === 'official') return subscribed ? 'ready' : 'setup';
  if (sel !== 'auto') return av[sel as keyof typeof av] ? 'ready' : 'setup';
  if (av.local || av.xfyun || av.custom) return 'ready';
  return subscribed ? 'ready' : 'setup';
}
