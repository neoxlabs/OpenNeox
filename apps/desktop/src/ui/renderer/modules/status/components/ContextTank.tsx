import React, { useEffect, useRef, useState } from 'react';
import { NeoxIllus } from '../../../media/illus';

const FX = 222;
const FY = 324;
const LX = 112;
const RX = 318;
const FULL = 184;
const leftY = FY - (FX - LX) / 2;
const rightY = FY - (RX - FX) / 2;
const backX = LX + RX - FX;
const backY = leftY + rightY - FY;
/** 刻度条轮廓 (占底图的百分比) */
const SCALE_CLIP = 'polygon(63.4% 27.3%, 71.1% 23.9%, 71.1% 56.3%, 63.4% 59.8%)';

export interface TankLayer {
  key: string;
  color: string;
  /** 占整个上下文窗口的比例 0..1 */
  fraction: number;
}

const shade = (hex: string, k: number): string => {
  const n = parseInt(hex.slice(1), 16);
  const to = k < 0 ? 0 : 255;
  const t = Math.abs(k);
  const mix = (c: number) => Math.round(c + (to - c) * t);
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
};

/** 数值变化时液面缓慢升降, 不是一下跳过去 */
function useTweened(target: number[], ms = 600): number[] {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  const key = target.map(v => v.toFixed(4)).join(',');
  useEffect(() => {
    const from = fromRef.current;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - p, 3);
      const next = target.map((v, i) => (from[i] ?? 0) + (v - (from[i] ?? 0)) * e);
      fromRef.current = next;
      setValue(next);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms]);
  return value;
}

const BUBBLES = [
  { x: 150, r: 3, delay: 0, dur: 4.2 },
  { x: 186, r: 2, delay: 1.6, dur: 3.4 },
  { x: 258, r: 2.5, delay: 0.8, dur: 4.8 },
  { x: 292, r: 1.8, delay: 2.6, dur: 3.8 },
];

/* 压缩时从液面往上挤出去的颗粒: x 位置 / 延迟 */
const SPARKS = [
  { x: 138, delay: 0.42 }, { x: 170, delay: 0.5 }, { x: 204, delay: 0.46 },
  { x: 240, delay: 0.54 }, { x: 276, delay: 0.44 }, { x: 302, delay: 0.52 },
];

const ContextTank: React.FC<{ layers: TankLayer[]; compactAt?: number; compressing?: boolean }> = ({
  layers, compactAt = 0.7, compressing = false,
}) => {
  const heights = useTweened(layers.map(l => Math.max(0, l.fraction) * FULL), 900);
  let h0 = 0;
  const faces: React.ReactNode[] = [];
  layers.forEach((layer, i) => {
    const h1 = Math.min(FULL, h0 + (heights[i] ?? 0));
    if (h1 - h0 > 0.2) {
      faces.push(
        <polygon key={`${layer.key}-l`} points={`${LX},${leftY - h0} ${FX},${FY - h0} ${FX},${FY - h1} ${LX},${leftY - h1}`} fill={layer.color} />,
        <polygon key={`${layer.key}-r`} points={`${FX},${FY - h0} ${RX},${rightY - h0} ${RX},${rightY - h1} ${FX},${FY - h1}`} fill={shade(layer.color, -0.22)} />,
      );
    }
    h0 = h1;
  });
  const top = h0;
  const topLayer = layers[heights.reduce((acc, h, i) => (h > 0.2 ? i : acc), -1)];
  const surface = `${LX},${leftY - top} ${FX},${FY - top} ${RX},${rightY - top} ${backX},${backY - top}`;
  const column = `${LX},${leftY} ${FX},${FY} ${RX},${rightY} ${RX},${rightY - top} ${FX},${FY - top} ${LX},${leftY - top}`;
  const ch = compactAt * FULL;
  /* 压板: 贴着液面的一块等距白板 + 连到盖子的推杆。每一冲程液体被压扁 SQUEEZE,
   * 压板跟着下沉同样的距离 (两边用同一个 --squeeze, 动画同相位)。 */
  const SQUEEZE = 0.12;
  const PLATE = 7;
  const plateAt = top + 3;
  const plate = (h: number) => `${LX},${leftY - h} ${FX},${FY - h} ${RX},${rightY - h} ${backX},${backY - h}`;
  const glass = `${LX},${leftY} ${FX},${FY} ${RX},${rightY} ${RX},${rightY - FULL - 10} ${backX},${backY - FULL - 10} ${LX},${leftY - FULL - 10}`;
  const centerX = (LX + RX) / 2;
  const centerY = (leftY + rightY) / 2;

  return (
    <div className={`cxp-tank${compressing ? ' is-compressing' : ''}`} aria-hidden="true"
      style={{ '--squeeze': `${top * SQUEEZE}px` } as React.CSSProperties}>
      <img src={NeoxIllus.ctxTank} alt="" draggable={false} decoding="sync" />
      <svg viewBox="0 0 440 490">
        <defs>
          <clipPath id="cxp-tank-column"><polygon points={column} /></clipPath>
          <clipPath id="cxp-tank-surface"><polygon points={surface} /></clipPath>
          <clipPath id="cxp-tank-glass"><polygon points={glass} /></clipPath>
        </defs>
        <g className="cxp-tank__body" style={{ transformOrigin: `${FX}px ${FY}px` }}>
        <g className="cxp-tank__liquid">{faces}</g>
        {topLayer && (
          <>
            <polygon className="cxp-tank__surface" points={surface} fill={shade(topLayer.color, 0.3)} />
            <g clipPath="url(#cxp-tank-surface)">
              <polygon className="cxp-tank__shine" points={`${LX - 40},${FY - top} ${LX - 10},${FY - top} ${LX + 60},${backY - top - 40} ${LX + 30},${backY - top - 40}`} />
            </g>
            {top > 24 && !compressing && (
              <g clipPath="url(#cxp-tank-column)">
                {BUBBLES.map(b => {
                  const bottom = (b.x < FX ? FY - (FX - b.x) / 2 : FY - (b.x - FX) / 2) - 4;
                  return (
                    <circle
                      key={b.x}
                      className="cxp-tank__bubble"
                      cx={b.x}
                      cy={bottom}
                      r={b.r}
                      style={{ '--rise': `${-(top - 6)}px`, animationDelay: `${b.delay}s`, animationDuration: `${b.dur}s` } as React.CSSProperties}
                    />
                  );
                })}
              </g>
            )}
          </>
        )}
        </g>
        <polyline
          className="cxp-tank__line"
          points={`${LX},${leftY - ch} ${FX},${FY - ch} ${RX},${rightY - ch}`}
        />
        {compressing && topLayer && (
          <g clipPath="url(#cxp-tank-glass)">
            <g className="cxp-tank__press">
              <rect className="cxp-tank__rod" x={centerX - 5} y={centerY - plateAt - PLATE - 260} width={10} height={260} rx={3} />
              <polygon className="cxp-tank__plate-l" points={`${LX},${leftY - plateAt} ${FX},${FY - plateAt} ${FX},${FY - plateAt - PLATE} ${LX},${leftY - plateAt - PLATE}`} />
              <polygon className="cxp-tank__plate-r" points={`${FX},${FY - plateAt} ${RX},${rightY - plateAt} ${RX},${rightY - plateAt - PLATE} ${FX},${FY - plateAt - PLATE}`} />
              <polygon className="cxp-tank__plate-t" points={plate(plateAt + PLATE)} />
              <polyline className="cxp-tank__plate-glow" points={`${LX},${leftY - plateAt} ${FX},${FY - plateAt} ${RX},${rightY - plateAt}`} />
            </g>
            {SPARKS.map(s => {
              const y = (s.x < FX ? FY - (FX - s.x) / 2 : FY - (s.x - FX) / 2) - top;
              return <circle key={s.x} className="cxp-tank__spark" cx={s.x} cy={y} r={5} style={{ animationDelay: `${s.delay}s` }} />;
            })}
          </g>
        )}
      </svg>
      <img className="cxp-tank__scale" src={NeoxIllus.ctxTank} alt="" draggable={false} style={{ clipPath: SCALE_CLIP }} />
    </div>
  );
};

export default ContextTank;
