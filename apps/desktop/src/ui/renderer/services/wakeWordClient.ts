
import { dispatchHint } from '../components/notifyEvents';

interface WakeWordEvent {
  type: string;
  text?: string;
  keyword?: string;
  matched?: string;
  speech?: string;
  mic?: string;
  message?: string;
  onDevice?: boolean;
}

interface NeoxWake {
  wakeWordGetState?: () => Promise<any>;
  wakeWordSetConfig?: (cfg: { enabled: boolean; keywords: string[]; locale: string }) => Promise<any>;
  wakeWordSubscribe?: () => Promise<any>;
  onWakeWordEvent?: (cb: (data: WakeWordEvent) => void) => (() => void) | null;
}

let installed = false;

export function installWakeWordClient(): void {
  if (installed) return;
  installed = true;
  const api = (window as unknown as { neox?: NeoxWake }).neox;
  if (!api?.wakeWordSubscribe || !api?.onWakeWordEvent) return;

  void api.wakeWordSubscribe().catch(() => { /* noop */ });

  api.onWakeWordEvent((evt) => {
    handleEvent(evt);
  });
}

function handleEvent(evt: WakeWordEvent): void {
  /* 状态类事件广播给设置页面 */
  if (['ready', 'started', 'stopped', 'permission', 'keywords_set'].includes(evt.type)) {
    window.dispatchEvent(new CustomEvent('neox:wake-word-state', { detail: evt }));
  }
  if (evt.type === 'permission') {
    if (evt.speech === 'denied' || evt.speech === 'restricted') {
      dispatchHint('🎙️ 语音识别权限被拒 · 打开: 系统设置 → 隐私与安全性 → 语音识别 → 勾 NeoxMacSpeech', 'warning');
    } else if (evt.mic === 'denied' || evt.mic === 'restricted') {
      dispatchHint('🎙️ 麦克风权限被拒 · 打开: 系统设置 → 隐私与安全性 → 麦克风 → 勾 NeoxMacSpeech (若没有, 关闭再启用一次)', 'warning');
      /* 尝试直接打开系统设置 macOS 隐私麦克风页 (URL scheme 支持 15+) */
      try {
        const link = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
        setTimeout(() => window.open(link, '_blank'), 800);
      } catch { /* noop */ }
    }
    return;
  }
  if (evt.type === 'error') {
    if (evt.message === 'mic permission denied') {
      /* 已在 permission 事件里给了详细引导, 这里就不再重复吵用户 */
      return;
    }
    if (evt.message && /Siri and Dictation are disabled/i.test(evt.message)) {
      dispatchHint(
        '🎙️ 唤醒词需要 Siri 或 听写 (Dictation) 启用. 打开: 系统设置 → 键盘 → 听写 → 开启. 只开听写就够, 不用开 Siri.',
        'warning'
      );
      try {
        /* 直接跳键盘设置 (听写在里面) */
        setTimeout(() => window.open('x-apple.systempreferences:com.apple.preference.keyboard', '_blank'), 800);
      } catch { /* noop */ }
      return;
    }
    if (evt.message) dispatchHint(`🎙️ 唤醒词: ${evt.message}`, 'warning');
    return;
  }
  if (evt.type === 'wake') {
    dispatchHint(`🎙️ ${evt.keyword ?? '已唤醒'}`, 'info');
    window.dispatchEvent(new CustomEvent('neox:composer-mic-open'));
    return;
  }
  /* partial 事件不弹提示 (太吵), 只广播给设置页面调试 */
  window.dispatchEvent(new CustomEvent('neox:wake-word-partial', { detail: evt }));
}
