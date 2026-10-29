import React from 'react';
import { createPortal } from 'react-dom';
import { useSchemaModelInfo } from './useSchemaModelInfo';
import {
  deriveFamilyFromName, defaultEffortForModel, effectiveLevelsForFamily, glazeOf, nearestStop, shownLevel,
  thinkLabel, thinkMode, type EffortLevel, type Glaze, type SchemaEffortInfo,
} from './thinkLevels';
import offIcon from '../../media/think/off.webp';
import lowIcon from '../../media/think/low.webp';
import midIcon from '../../media/think/mid.webp';
import highIcon from '../../media/think/high.webp';
import xhighIcon from '../../media/think/xhigh.webp';
import maxIcon from '../../media/think/max.webp';
import ultraIcon from '../../media/think/ultra.webp';
import knobImg from '../../media/think/knob.webp';
import './think-level.css';

/* 窑火: 关 = 没点的灯芯, 往上火越旺越暖, 极限金焰, 至臻贝母焰。白瓷底座 + 玻璃火苗, 跟 logo 同一种材质 */
const FLAME: Record<Glaze, string> = { off: offIcon, low: lowIcon, mid: midIcon, high: highIcon, xhigh: xhighIcon, max: maxIcon, ultra: ultraIcon };

export const ThinkIcon: React.FC<{ level: EffortLevel; className?: string }> = ({ level, className }) => (
  <img className={className} src={FLAME[glazeOf(level)]} alt="" aria-hidden draggable={false} />
);

/** 一个模型的档位信息: schema 优先, 没回来先用家族兜底; schema 明说没有 → null (不给假控件) */
function useThinkLevels(modelId: string, initialInfo?: SchemaEffortInfo) {
  const { info, schemaMissing } = useSchemaModelInfo<SchemaEffortInfo>(modelId, initialInfo);
  if (schemaMissing || (info && !info.hasEffortMap)) return null;
  const levels = effectiveLevelsForFamily(info?.family ?? deriveFamilyFromName(modelId), info?.effectiveLevels);
  return { levels, fallback: defaultEffortForModel(modelId, info), known: !!info };
}

/* ── 滑杆 ─────────────────────────────────────────────────────────── */

export const ThinkSlider: React.FC<{
  levels: readonly EffortLevel[];
  value: EffortLevel;
  zh: boolean;
  onPick: (level: EffortLevel) => void;
}> = ({ levels, value, zh, onPick }) => {
  const railRef = React.useRef<HTMLDivElement>(null);
  const [drag, setDrag] = React.useState<number | null>(null);
  const n = levels.length;
  const valueIdx = Math.max(0, levels.indexOf(value));
  const idx = drag ?? valueIdx;
  const level = levels[idx] ?? value;
  const at = n > 1 ? idx / (n - 1) : 1;
  const pos = `calc(var(--tk-ball) / 2 + (100% - var(--tk-ball)) * ${at})`;

  const idxAt = (clientX: number): number => {
    const r = railRef.current?.getBoundingClientRect();
    if (!r) return valueIdx;
    const ball = 26;
    return nearestStop((clientX - r.left - ball / 2) / Math.max(1, r.width - ball), n);
  };
  const commit = (i: number) => { const lv = levels[i]; if (lv && lv !== value) onPick(lv); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (step) { e.preventDefault(); commit(Math.min(n - 1, Math.max(0, valueIdx + step))); return; }
    if (e.key === 'Home') { e.preventDefault(); commit(0); }
    if (e.key === 'End') { e.preventDefault(); commit(n - 1); }
  };

  return (
    <div className={`nx-think nx-think--${glazeOf(level)}${drag !== null ? ' is-dragging' : ''}`}>
      <div
        ref={railRef}
        className="nx-think__rail"
        role="slider"
        tabIndex={0}
        aria-label={zh ? '思考档位' : 'Thinking level'}
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={idx}
        aria-valuetext={thinkLabel(level, levels, zh)}
        onKeyDown={onKeyDown}
        onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.focus(); setDrag(idxAt(e.clientX)); }}
        onPointerMove={(e) => { if (drag !== null) setDrag(idxAt(e.clientX)); }}
        onPointerUp={(e) => { if (drag !== null) { commit(idxAt(e.clientX)); setDrag(null); } }}
        onPointerCancel={() => setDrag(null)}
      >
        <span className="nx-think__tag" style={{ left: pos }}>{thinkLabel(level, levels, zh)}</span>
        <span className="nx-think__track">
          <span className="nx-think__fill" style={{ width: `calc(var(--tk-ball) + (100% - var(--tk-ball)) * ${at})` }} />
          {levels.map((lv, i) => (
            <span key={lv} className={`nx-think__notch${i <= idx ? ' is-on' : ''}`} style={{ left: `calc(var(--tk-ball) / 2 + (100% - var(--tk-ball)) * ${n > 1 ? i / (n - 1) : 1})` }} />
          ))}
        </span>
        <img className="nx-think__ball" src={knobImg} alt="" aria-hidden draggable={false} style={{ left: pos }} />
      </div>
    </div>
  );
};

/* ── 按钮上方的小卡 ───────────────────────────────────────────────── */

const ThinkPopover: React.FC<{
  anchor: DOMRect;
  children: React.ReactNode;
  onClose: () => void;
}> = ({ anchor, children, onClose }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Element;
      if (ref.current?.contains(t) || t.closest?.('.atl-composer__thinkchip')) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', down, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down, true); document.removeEventListener('keydown', key, true); };
  }, [onClose]);
  /* 卡片打开就把焦点给滑杆: 方向键直接能调 */
  React.useEffect(() => { ref.current?.querySelector<HTMLElement>('[role="slider"]')?.focus(); }, []);
  const width = 232;
  const left = Math.min(window.innerWidth - width - 12, Math.max(12, anchor.left + anchor.width / 2 - width / 2));
  return createPortal(
    <div
      ref={ref}
      className="atl-model__menu nx-think-pop"
      role="dialog"
      style={{ left, bottom: window.innerHeight - anchor.top + 8, width }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
};

/* ── 输入框里的思考按钮 ───────────────────────────────────────────── */

export const ThinkChip: React.FC<{
  modelId: string;
  /** 这一轮实际要发的档 (运行时算好的; 'standard' = 没指定) */
  sent: EffortLevel | undefined;
  zh: boolean;
  anchor: DOMRect | null;
  onOpen: (rect: DOMRect) => void;
  onClose: () => void;
  onPick: (level: EffortLevel) => void;
}> = ({ modelId, sent, zh, anchor, onOpen, onClose, onPick }) => {
  const t = useThinkLevels(modelId);
  if (!t) return null;
  const mode = thinkMode(t.levels);
  const level = shownLevel(sent, t.levels, t.fallback);
  const glaze = mode === 'fixed' ? 'mid' : glazeOf(level);
  const label = mode === 'fixed' ? (zh ? '思考' : 'Thinking') : thinkLabel(level, t.levels, zh);
  const title = mode === 'fixed'
    ? (zh ? '这个模型一直开着思考，不能调' : 'This model always thinks; it cannot be changed')
    : mode === 'toggle'
      ? (zh ? '点一下开 / 关思考' : 'Click to turn thinking on or off')
      : (zh ? '思考档位' : 'Thinking level');
  return (
    <>
      <button
        type="button"
        className={`atl-composer__thinkchip nx-thinkchip nx-thinkchip--${glaze}${mode === 'fixed' ? ' is-fixed' : ''}${anchor ? ' is-open' : ''}`}
        aria-label={`${zh ? '思考' : 'Thinking'} · ${label}`}
        aria-haspopup={mode === 'slider' ? 'dialog' : undefined}
        aria-expanded={mode === 'slider' ? !!anchor : undefined}
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          if (mode === 'fixed') return;
          if (mode === 'toggle') {
            const offKey = t.levels.find((l) => l === 'off' || l === 'fast')!;
            const onKey = t.levels.find((l) => l !== offKey)!;
            onPick(level === offKey ? onKey : offKey);
            return;
          }
          if (anchor) onClose(); else onOpen(e.currentTarget.getBoundingClientRect());
        }}
      >
        <ThinkIcon level={mode === 'fixed' ? 'on' : level} className="nx-thinkchip__icon" />
        <span className="atl-composer__thinkchip-text nx-thinkchip__label">{label}</span>
      </button>
      {anchor && mode === 'slider' && (
        <ThinkPopover anchor={anchor} onClose={onClose}>
          <ThinkSlider levels={t.levels} value={level} zh={zh} onPick={onPick} />
        </ThinkPopover>
      )}
    </>
  );
};

/* ── 模型菜单里的后备段 ───────────────────────────────────────────── */

/** 输入框上的思考按钮此刻是否看得见 —— 看得见时模型菜单不重复放滑杆 */
export function thinkChipVisible(): boolean {
  const el = document.querySelector<HTMLElement>('.atl-composer__thinkchip');
  return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

export const ThinkMenuSection: React.FC<{
  modelId: string;
  sent: EffortLevel | undefined;
  initialInfo?: SchemaEffortInfo;
  zh: boolean;
  onPick: (level: EffortLevel) => void;
}> = ({ modelId, sent, initialInfo, zh, onPick }) => {
  const t = useThinkLevels(modelId, initialInfo);
  if (!t) return null;
  const mode = thinkMode(t.levels);
  if (mode === 'fixed' && !t.known) return null;
  const level = shownLevel(sent, t.levels, t.fallback);
  return (
    <div className="atl-model__effort-inline nx-think-menu" role="group" aria-label={zh ? '思考' : 'Thinking'}>
      <div className="atl-model__section-label"><span>{zh ? '思考' : 'Thinking'}</span></div>
      {mode === 'fixed' ? (
        <div className="nx-think-fixed" title={zh ? '上游不支持关闭或调深浅' : 'The provider does not allow changing it'}>
          <ThinkIcon level="on" className="nx-thinkchip__icon" />
          <span>{zh ? '一直开着，不能调' : 'Always on'}</span>
        </div>
      ) : (
        <ThinkSlider levels={t.levels} value={level} zh={zh} onPick={onPick} />
      )}
    </div>
  );
};
