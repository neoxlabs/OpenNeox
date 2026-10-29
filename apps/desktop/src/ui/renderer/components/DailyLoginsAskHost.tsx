/**
 * DailyLoginsAskHost — the first time the agent's Chrome starts, ask whether it may carry the
 * user's everyday Chrome sign-ins. Asked once: the answer is the settings switch
 * (设置 › 浏览器), and with the switch on nothing is asked again.
 *
 * Handshake with the main process: see services/externalChrome/dailyLoginsConsent.ts.
 * Ack first, then show the dialog, so a user who reads it for a while is not timed out.
 */
import React, { useEffect, useRef } from 'react';
import { confirmAsync } from './confirmEvents';
import Icons from './Icons';
import { getGlobalLanguage } from '../hooks/useI18n';

export function DailyLoginsAskHost(): null {
  const handled = useRef(new Set<number>());

  useEffect(() => {
    const bridge = (window as any)?.neox;
    if (typeof bridge?.onDailyLoginsAsk !== 'function') return;

    const off = bridge.onDailyLoginsAsk(async (payload: { id: number }) => {
      const id = Number(payload?.id);
      if (!Number.isFinite(id) || handled.current.has(id)) return;
      handled.current.add(id);
      try { bridge.dailyLoginsAck?.(id); } catch { /* main times out and launches without */ }

      const zh = getGlobalLanguage() === 'zh';
      const allow = await confirmAsync({
        icon: <Icons.Globe />,
        title: zh ? '带上你的登录状态？' : 'Use your sign-ins?',
        message: zh
          ? 'Agent 要打开浏览器了。让它使用你日常 Chrome 的登录状态吗？'
          : 'The agent is opening its browser. Should it use the sign-ins from your everyday Chrome?',
        description: zh
          ? '会复制你日常 Chrome 的 Cookies：已经登录的网站 Agent 不用再登一遍，也就能以你的身份访问它们。不碰保存的密码。之后可在 设置 › 浏览器 里随时更改。'
          : 'Copies the cookies from your everyday Chrome, so sites you are signed into stay signed in and the agent can act as you there. Saved passwords are never touched. Change it any time in Settings › Browser.',
        confirmLabel: zh ? '带上我的登录' : 'Use my sign-ins',
        cancelLabel: zh ? '不用，单独登录' : 'No, sign in separately',
      });
      try { bridge.dailyLoginsAnswer?.(id, allow); } catch { /* main times out and asks next launch */ }
    });

    return () => { try { off?.(); } catch { /* unmounted */ } };
  }, []);

  return null;
}
