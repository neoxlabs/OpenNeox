/* 聚光卡的挂载点 —— 只挂在主工作区 (AppShell 的 workspace 分支)。
 *
 *   什么时候弹 (调度规则在 spotlightScheduler, 这里只管"此刻方不方便"):
 *     · 进工作区后先等 FIRST_CHECK_MS, 之后每 RECHECK_MS 看一次, 一次会话最多弹一张;
 *     · 窗口在前台、有焦点, 用户这几秒没在敲键盘 / 点鼠标;
 *     · 屏上没有别的模态 (确认框、登录、接模型浮层…) —— 不跟它们抢。
 *
 *   也能点名弹: window.dispatchEvent(new CustomEvent('neox:spotlight', { detail: { id } }))
 *   (新功能上线后在合适的时机主动介绍自己; 不受冷却和"不再提示"限制 —— 那是功能自己的决定)。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { getEditionHook } from '../shell/editionHooks';
import { hasByokConfigured } from '../../app/welcomeGate';
import { getSpotlightCard, getSpotlightCards, type SpotlightAction, type SpotlightCardDef } from './spotlightCards';
import { loadSpotlightState, markShown, pickSpotlight, saveSpotlightState } from './spotlightScheduler';
import { SpotlightCard, type SpotlightCloseReason } from './SpotlightCard';

const FIRST_CHECK_MS = 45_000;
const RECHECK_MS = 60_000;
const IDLE_MS = 6_000;

function runAction(action: SpotlightAction): void {
  try {
    if (action.type === 'settings') {
      window.dispatchEvent(new CustomEvent('neox:open-settings', { detail: { tab: action.tab } }));
    } else if (action.type === 'event') {
      window.dispatchEvent(new CustomEvent(action.name, { detail: action.detail }));
    } else if (action.type === 'url') {
      void (window as any).neox?.openExternal?.(action.url);
    }
  } catch { /* 动作失败不影响关卡 */ }
}

function screenIsBusy(): boolean {
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return true;
  if (document.querySelector('[aria-modal="true"], .model-connect-overlay')) return true;
  /* 正在设置页里 (预热的那份是 display:none, 量不出盒子) */
  return Array.from(document.querySelectorAll('.settings-page')).some((el) => el.getClientRects().length > 0);
}

export const SpotlightHost: React.FC<{ ready: boolean }> = ({ ready }) => {
  const { language } = useI18n();
  const [card, setCard] = useState<SpotlightCardDef | null>(null);
  const shownThisSession = useRef(false);
  const lastInputAt = useRef(Date.now());
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const show = useCallback((c: SpotlightCardDef) => {
    shownThisSession.current = true;
    /* 弹出就记"看过" —— 不等关闭: 弹着的时候应用崩了 / 被强退, 下次不该再弹同一张 */
    saveSpotlightState(markShown(loadSpotlightState(Date.now()), c.id, Date.now()));
    setCard(c);
  }, []);

  useEffect(() => {
    const bump = () => { lastInputAt.current = Date.now(); };
    window.addEventListener('keydown', bump, true);
    window.addEventListener('pointerdown', bump, true);
    return () => {
      window.removeEventListener('keydown', bump, true);
      window.removeEventListener('pointerdown', bump, true);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      if (cancelled || shownThisSession.current) return;
      const now = Date.now();
      if (readyRef.current && now - lastInputAt.current >= IDLE_MS && !screenIsBusy()) {
        const modelReady = getEditionHook('isAuthenticated')() || await hasByokConfigured();
        if (cancelled) return;
        const picked = pickSpotlight(getSpotlightCards(), loadSpotlightState(now), {
          now,
          hasAccount: getEditionHook('hasAccount'),
          modelReady,
        });
        /* await 期间用户可能刚好开了别的弹窗 —— 弹之前再看一眼 */
        if (picked && !screenIsBusy()) { show(picked); return; }
      }
      timer = window.setTimeout(() => { void tick(); }, RECHECK_MS);
    };
    timer = window.setTimeout(() => { void tick(); }, FIRST_CHECK_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [show]);

  useEffect(() => {
    const onShow = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      const c = id ? getSpotlightCard(id) : undefined;
      if (c) show(c);
    };
    window.addEventListener('neox:spotlight', onShow);
    return () => window.removeEventListener('neox:spotlight', onShow);
  }, [show]);

  if (!card) return null;
  return (
    <SpotlightCard
      key={card.id}
      card={card}
      zh={language === 'zh'}
      onAction={(reason: SpotlightCloseReason) => {
        if (reason === 'off') saveSpotlightState({ ...loadSpotlightState(Date.now()), off: true });
        if (reason === 'cta' && card.cta) runAction(card.cta.action);
      }}
      onClosed={() => setCard(null)}
    />
  );
};
