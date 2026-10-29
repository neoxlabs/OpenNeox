import { useEffect, useRef } from 'react';

/** 停顿这么久补发一次最终草稿。 */
const IDLE_MS = 250;
/** 一直在打字时, 最多隔这么久发一次当前草稿 —— 连接保持热, 前半句一打完预判就出来。 */
const MAX_WAIT_MS = 600;
/** 输入框聚焦时隔这么久保温一次 (连接空闲 ~5s 就冷, 冷连接前两个请求要 1–1.7s)。 */
const KEEP_WARM_MS = 3500;
/** 聚焦但这么久没打字就不保温了 (人走开了)。 */
const KEEP_WARM_FOR_MS = 120_000;
/** 不到 4 个字的文本 runtime 只拿来预热连接, 不预判。 */
const WARM_SIGNAL = '…';

const isComposer = (el: EventTarget | Element | null) =>
  el instanceof Element && !!el.closest('.atl-composer');

/**
 * Jev 加持: 打字期间把草稿递给 runtime 预判要用的工具包, 发送时直接取结果 (全文或覆盖一半以上的
 * 前缀), 不必在首字前再等一次网络。runtime 那边同时只飞一个请求, 这里发多了也只保留最新的。
 * 没开 Jev 时主进程直接丢掉, 这里不用判断。
 *
 * 输入框一聚焦就开始保温: 「列出我当前所有的定时任务」这种短句一秒多就打完, 等打字时才预热
 * 来不及 (两个冷请求 ~2.3s), 预判只能晚到。
 */
export function useJevDraftPrefetch(value: string): void {
  const lastSentAt = useRef(0);
  const lastInputAt = useRef(0);

  useEffect(() => {
    lastInputAt.current = Date.now();
    const text = value.trim();
    if (!text) return;
    const send = () => {
      lastSentAt.current = Date.now();
      void window.neox?.jevPrefetch?.(text)?.catch(() => { /* 预判失败不影响发送 */ });
    };
    if (Date.now() - lastSentAt.current >= MAX_WAIT_MS) {
      send();
      return;
    }
    const timer = window.setTimeout(send, IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    const warm = () => {
      if (Date.now() - lastSentAt.current < KEEP_WARM_MS) return;
      lastSentAt.current = Date.now();
      void window.neox?.jevPrefetch?.(WARM_SIGNAL)?.catch(() => {});
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!isComposer(e.target)) return;
      lastInputAt.current = Date.now();
      warm();
    };
    const timer = window.setInterval(() => {
      if (!document.hasFocus() || !isComposer(document.activeElement)) return;
      if (Date.now() - lastInputAt.current > KEEP_WARM_FOR_MS) return;
      warm();
    }, KEEP_WARM_MS);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);
}
