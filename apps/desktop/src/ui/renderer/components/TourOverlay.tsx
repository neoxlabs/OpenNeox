import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { useEnterTransition } from '../hooks/useEnterTransition';
import { useI18n } from '../hooks/useI18n';
import { NeoxIllus } from '../media/illus';

/**
 * 首次进入主界面的悬浮引导 (coach-mark)。
 *  - 3 步, 每步指向一个真实 UI 锚点 (新建会话 → 选模型 → 输入框)。
 *  - 聚光灯高亮锚点 + 气泡讲解 + 右上角进度 + 跳过/下一步。
 *  - 看过一次后写 localStorage, 不再弹。设置里可重置 (清掉该 key) 重新看。
 *  - 锚点找不到 (例如不在 agent 模式) 时气泡居中, 不聚光, 不阻断。
 */

const DONE_KEY = 'neox-tour-shell-v1-done';

type Place = 'bottom' | 'top' | 'right' | 'left' | 'center';
interface Step {
  sel: string;
  title: string;
  body: string;
  place: Place;
  art: string;
}

const STEPS_ZH: Step[] = [
  {
    sel: '[data-tour="new-chat"]',
    title: '新建会话',
    body: '每个会话归在它的项目下，左边按项目找。',
    place: 'right',
    art: NeoxIllus.board,
  },
  {
    sel: '[data-tour="model"]',
    title: '换模型',
    body: '不同的活用不同的模型，随时切。',
    place: 'top',
    art: NeoxIllus.agentModel,
  },
  {
    sel: '[data-tour="composer"]',
    title: '开始干活',
    body: '说出要做的事。能贴图、@ 文件、/ 用技能。',
    place: 'top',
    art: NeoxIllus.convComposerStd,
  },
];

const STEPS_EN: Step[] = [
  {
    sel: '[data-tour="new-chat"]',
    title: 'New chat',
    body: 'Each chat is filed under its project on the left.',
    place: 'right',
    art: NeoxIllus.board,
  },
  {
    sel: '[data-tour="model"]',
    title: 'Switch models',
    body: 'Use a different model for each job, any time.',
    place: 'top',
    art: NeoxIllus.agentModel,
  },
  {
    sel: '[data-tour="composer"]',
    title: 'Get to work',
    body: 'Say what you need. Paste images, @ files, / for skills.',
    place: 'top',
    art: NeoxIllus.convComposerStd,
  },
];

interface AnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
  found: boolean;
}

const PAD = 8; // 聚光灯外扩
const BUBBLE_W = 300;
const GAP = 14; // 气泡与锚点间距

function measure(sel: string): AnchorRect {
  const el = document.querySelector(sel) as HTMLElement | null;
  if (!el) return { top: 0, left: 0, width: 0, height: 0, found: false };
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height, found: r.width > 0 && r.height > 0 };
}

export const TourOverlay: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const { language } = useI18n();
  const isZh = language === 'zh';
  const STEPS = isZh ? STEPS_ZH : STEPS_EN;
  const [active, setActive] = useState(false);
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<AnchorRect>({ top: 0, left: 0, width: 0, height: 0, found: false });
  const rafRef = useRef<number | null>(null);
  /* 气泡高度随插画 / 文案变, 放在锚点上方时要用真高度, 不能再写死 168 */
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [bubbleH, setBubbleH] = useState(260);
  useLayoutEffect(() => {
    const h = bubbleRef.current?.offsetHeight;
    if (h && Math.abs(h - bubbleH) > 1) setBubbleH(h);
  });

  // 首次进入: 没看过 + enabled → 等界面渲染稳定后启动
  useEffect(() => {
    if (!enabled) return;
    let done = false;
    try { done = localStorage.getItem(DONE_KEY) === '1'; } catch { /* ignore */ }
    if (done) return;
    const t = setTimeout(() => setActive(true), 900);
    return () => clearTimeout(t);
  }, [enabled]);

  // 手动重看: 设置页 / 调试 dispatch `neox:tour:restart` 即可重新引导
  useEffect(() => {
    const restart = () => { try { localStorage.removeItem(DONE_KEY); } catch { /* ignore */ } setStep(0); setActive(true); };
    window.addEventListener('neox:tour:restart', restart);
    return () => window.removeEventListener('neox:tour:restart', restart);
  }, []);

  const finish = useCallback(() => {
    try { localStorage.setItem(DONE_KEY, '1'); } catch { /* ignore */ }
    setActive(false);
  }, []);

  // 跟踪当前步锚点位置 (resize / 滚动 / 布局变化都重测)
  useLayoutEffect(() => {
    if (!active) return;
    const cur = STEPS[step];
    const update = () => setRect(measure(cur.sel));
    update();
    const onChange = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(update);
    };
    window.addEventListener('resize', onChange);
    window.addEventListener('scroll', onChange, true);
    const iv = window.setInterval(update, 400); // 异步出现的锚点 (composer 晚挂) 兜底
    return () => {
      window.removeEventListener('resize', onChange);
      window.removeEventListener('scroll', onChange, true);
      window.clearInterval(iv);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active, step]);

  useEffect(() => {
    if (!active) return;
    document.documentElement.setAttribute('data-tour', '1');
    return () => document.documentElement.removeAttribute('data-tour');
  }, [active]);

  // ESC 跳过
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(); }
      else if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); next(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, step]);

  const next = useCallback(() => {
    setStep((s) => {
      if (s >= STEPS.length - 1) { finish(); return s; }
      return s + 1;
    });
  }, [finish]);

  /* 必须在 early return 之前: active 从 false→true 时若这里才挂 hook,
   * React #310 "Rendered more hooks than during the previous render"。
   * 新装用户 900ms 后第一次弹出引导就会白屏。enabled=active 让入场动画仍在打开那帧播。 */
  const entered = useEnterTransition(active);

  if (!active) return null;
  const cur = STEPS[step];
  const isLast = step === STEPS.length - 1;

  // 聚光灯框 (锚点外扩 PAD)
  const spot = rect.found
    ? { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }
    : null;

  // 气泡定位
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let bubbleStyle: React.CSSProperties;
  if (!rect.found) {
    bubbleStyle = { top: vh / 2 - 90, left: vw / 2 - BUBBLE_W / 2 };
  } else {
    const cx = rect.left + rect.width / 2;
    let top = 0;
    let left = 0;
    switch (cur.place) {
      case 'bottom': top = rect.top + rect.height + GAP; left = cx - BUBBLE_W / 2; break;
      case 'top': top = rect.top - GAP - bubbleH; left = cx - BUBBLE_W / 2; break;
      case 'right': top = rect.top; left = rect.left + rect.width + GAP; break;
      case 'left': top = rect.top; left = rect.left - GAP - BUBBLE_W; break;
      default: top = vh / 2 - 90; left = vw / 2 - BUBBLE_W / 2;
    }
    // 夹到视口内
    left = Math.max(12, Math.min(left, vw - BUBBLE_W - 12));
    top = Math.max(12, Math.min(top, vh - bubbleH - 12));
    bubbleStyle = { top, left };
  }

  return (
    <div className={`neox-tour nx-in nx-in--modal ${entered ? 'is-in' : ''}`} style={S.root} aria-modal="true" role="dialog">
      {/* 背景遮罩: 用聚光灯框的超大 box-shadow 把四周压暗, 中间留亮 */}
      {spot ? (
        <div className="neox-tour__spot" style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }} />
      ) : (
        <div className="neox-tour__dim" onClick={finish} />
      )}

      {/* 气泡 — 跟首次使用介绍弹窗 (.nx-intro) 同一套: 上插画带淡光晕, 下标题 + 一句话 + 按钮 */}
      <div className="neox-tour__bubble" style={bubbleStyle} ref={bubbleRef}>
        <div className="neox-tour__stage" aria-hidden="true">
          <span className="neox-tour__glow" />
          <img className="neox-tour__art" src={cur.art} alt="" draggable={false} key={step} />
        </div>
        <div className="neox-tour__main">
          <div className="neox-tour__head">
            <span className="neox-tour__title">{cur.title}</span>
            <span className="neox-tour__count">{step + 1} / {STEPS.length}</span>
          </div>
          <div className="neox-tour__body">{cur.body}</div>
          <div className="neox-tour__actions">
            <button className="neox-tour__skip" onClick={finish}>{isZh ? '跳过' : 'Skip'}</button>
            <button className="neox-tour__next" onClick={next}>
              {isLast ? (isZh ? '开始使用' : 'Get started') : (isZh ? '下一步' : 'Next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/* 容器级布局 — 跟主题无关的固定值 */
const S: Record<string, React.CSSProperties> = {
  root: { position: 'fixed', inset: 0, zIndex: 99999, pointerEvents: 'none' },
};

export default TourOverlay;
