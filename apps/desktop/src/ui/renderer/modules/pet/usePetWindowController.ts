/**
 * usePetWindowController — 桌宠窗口的"外壳逻辑"(渲染无关)
 *
 * 把拖拽 / 心情状态机 / 气泡 / plan / 打字反应 / agent 事件订阅 / config 全抽到这里,
 * 让 PetWindowRoot (核心: svg+sprite) 和 Pet3DWindowRoot (插件: 3D) 共用同一套行为,
 * 唯一差别只剩"中间渲染什么". 这样 three 只进 3D 那个独立 bundle, 核心 pet 窗口不含 three.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { petBridge, type PetWindowConfig, type PetAgentEvent } from './petWindowBridge';
import type { PetMood } from './PetSceneR3F';

export const PET_SIZE_PX: Record<PetWindowConfig['size'], number> = {
  sm: 96,
  md: 128,
  lg: 180,
};

export interface PetBubbleState {
  text: string;
  kind: 'speech' | 'error' | 'success' | 'thinking';
}

export interface PetWindowController {
  config: PetWindowConfig | null;
  mood: PetMood;
  typing: boolean;
  bubble: PetBubbleState | null;
  plan: { done: number; total: number } | null;
  size: number;
  /** 外壳交互 handlers (拖拽 / 右键关闭 / 摸头) */
  handlers: {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
    onContextMenu: (e: React.MouseEvent) => void;
    onClick: (e: React.MouseEvent) => void;
  };
  draggingRef: React.MutableRefObject<boolean>;
}

export function usePetWindowController(): PetWindowController {
  const [config, setConfig] = useState<PetWindowConfig | null>(null);
  const [mood, setMood] = useState<PetMood>('idle');
  const [bubble, setBubble] = useState<PetBubbleState | null>(null);
  const [plan, setPlan] = useState<{ done: number; total: number } | null>(null);
  const [typing, setTyping] = useState(false);
  const typingTimerRef = useRef<number | null>(null);

  const draggingRef = useRef(false);
  const lastMouseRef = useRef<{ x: number; y: number } | null>(null);
  const pendingDeltaRef = useRef<{ dx: number; dy: number } | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const moodResetTimerRef = useRef<number | null>(null);

  const setMoodWithReset = useCallback((nextMood: PetMood, autoResetMs: number) => {
    setMood(nextMood);
    if (moodResetTimerRef.current !== null) window.clearTimeout(moodResetTimerRef.current);
    moodResetTimerRef.current = window.setTimeout(() => {
      setMood('idle');
      moodResetTimerRef.current = null;
    }, autoResetMs);
  }, []);

  /* config 拉取 + 订阅 */
  useEffect(() => {
    let cancelled = false;
    petBridge.getConfig().then((cfg) => {
      if (!cancelled) setConfig(cfg);
    }).catch((err) => console.error('[petController] getConfig failed:', err));
    const unsubCfg = petBridge.onConfigChange((cfg) => setConfig(cfg));
    return () => { cancelled = true; unsubCfg(); };
  }, []);

  /* agent 事件 → mood / bubble / plan / typing */
  useEffect(() => {
    const unsub = petBridge.onAgentEvent((evt: PetAgentEvent) => {
      switch (evt.type) {
        case 'speech':
          if (evt.text) setBubble({ text: evt.text, kind: 'speech' });
          setMoodWithReset('speaking', 8000);
          break;
        case 'mood':
          if (evt.mood) setMoodWithReset(evt.mood as PetMood, 6000);
          break;
        case 'plan':
          if (evt.planProgress) setPlan(evt.planProgress);
          break;
        case 'error':
          setBubble({ text: evt.text ?? '出错了', kind: 'error' });
          setMoodWithReset('error', 5000);
          break;
        case 'complete':
          setBubble({ text: '🎉 搞定!', kind: 'success' });
          setMoodWithReset('success', 5000);
          break;
        case 'activity':
          setTyping(true);
          if (typingTimerRef.current !== null) window.clearTimeout(typingTimerRef.current);
          typingTimerRef.current = window.setTimeout(() => {
            setTyping(false);
            typingTimerRef.current = null;
          }, 1200);
          break;
      }
    });
    return unsub;
  }, [setMoodWithReset]);

  const flushDrag = useCallback(() => {
    rafIdRef.current = null;
    const pending = pendingDeltaRef.current;
    if (!pending) return;
    pendingDeltaRef.current = null;
    petBridge.drag(pending.dx, pending.dy);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    draggingRef.current = true;
    lastMouseRef.current = { x: e.screenX, y: e.screenY };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    petBridge.startDrag();
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || !lastMouseRef.current) return;
    const dx = e.screenX - lastMouseRef.current.x;
    const dy = e.screenY - lastMouseRef.current.y;
    if (dx === 0 && dy === 0) return;
    lastMouseRef.current = { x: e.screenX, y: e.screenY };
    pendingDeltaRef.current = pendingDeltaRef.current
      ? { dx: pendingDeltaRef.current.dx + dx, dy: pendingDeltaRef.current.dy + dy }
      : { dx, dy };
    if (rafIdRef.current === null) rafIdRef.current = window.requestAnimationFrame(flushDrag);
  }, [flushDrag]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    lastMouseRef.current = null;
    if (rafIdRef.current !== null) {
      window.cancelAnimationFrame(rafIdRef.current);
      flushDrag();
    }
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    petBridge.endDrag();
  }, [flushDrag]);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    /* neox-allow-native-dialog: 桌宠是独立 BrowserWindow (pet-entry.tsx 第二入口),
     * 没挂 ConfirmDialogHost, confirmAsync 在这里会永远 pending —— 这是原生弹窗
     * 唯一合法的场景。要换掉的话得先给桌宠窗口也挂一份 Host。 */
    if (window.confirm('关闭桌宠?')) petBridge.dismiss();
  }, []);

  const onClick = useCallback((_e: React.MouseEvent) => {
    setMoodWithReset('happy', 3000);
    setBubble({ text: '嘿嘿~ 谢谢摸摸', kind: 'success' });
  }, [setMoodWithReset]);

  const size = config ? PET_SIZE_PX[config.size] : PET_SIZE_PX.md;

  return {
    config, mood, typing, bubble, plan, size,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onContextMenu, onClick },
    draggingRef,
  };
}
