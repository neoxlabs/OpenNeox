/**
 * 角色的眼睛 —— 单独一层矢量, 不在底图里。
 *
 * 【为什么眼睛要从图里抠出来】
 * 切换整张静态图做出来的只是幻灯片: 每一帧都是"跳"过去的, 中间没有过程。表情恰恰
 * 最需要过程 —— 眨眼真正好看的是眼睑压下去再弹回来的那两百毫秒, 换图换不出这一段。
 * 底图做成没有眼睛的空脸, 眼睛用矢量画上去, 眨眼就成了纵向缩放、看左右成了平移、
 * 吃惊成了放大, 全是连续量, 而且一张素材都不用多加。
 *
 * 位置和半径与 V2 空脸底图一起校准, 换算成画布百分比以适应不同显示尺寸。
 *
 * 【为什么套了四层 g】
 * 因为 **CSS 的 transform 会整个覆盖同一元素上的 SVG transform 属性**, 不是叠加。
 * 定位、转眼珠、睁大、眨眼这四件事都要改 transform, 挤在同一个元素上时后来的会把
 * 定位那一份抹掉 —— 眼睛就会跑回 viewBox 原点, 也就是飞到画面左上角去。
 * 所以每一层只留一个 transform 来源: 最外层用 SVG 属性定位, 且 CSS 永不碰它;
 * 里面三层各归一件事, 各自在 CSS 里独立驱动。
 *
 * 另外这几层都要 `transform-box: fill-box`: SVG 里 CSS transform 的原点默认在
 * viewBox 左上角, 不设的话"放大"是以整张画布的角为中心放大, 眼睛会一边变大一边
 * 朝右下方滑出去。
 */
import React from 'react';

export interface EyeGeometry {
  /** 相对画布的百分比位置 (0~1)。 */
  eyes: { cx: number; cy: number }[];
  /** 眼球半径, 同样是画布宽的百分比。 */
  r: number;
}

/** V2 空脸画布的眼位, 与素材预览和爪尖锚点一起校准。 */
export const EYE_GEOMETRY: Record<string, EyeGeometry> = {
  cat: { eyes: [{ cx: 184 / 480, cy: 221 / 397 }, { cx: 295 / 480, cy: 221 / 397 }], r: 0.024 },
  corgi: { eyes: [{ cx: 193 / 480, cy: 203 / 397 }, { cx: 287 / 480, cy: 203 / 397 }], r: 0.0234 },
};

/** 素材画布, 跟导出脚本保持一致。 */
export const CANVAS_W = 480;
export const CANVAS_H = 397;

export const MascotEyes: React.FC<{ species: string }> = ({ species }) => {
  const geo = EYE_GEOMETRY[species] ?? EYE_GEOMETRY.cat;
  const r = geo.r * CANVAS_W;

  return (
    <svg
      className="neox-mascot__eyes"
      viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {geo.eyes.map((e, i) => (
        /* 第一层: 只负责把这只眼放到脸上的位置。用 SVG 属性写, CSS 里没有任何规则
           选中这一层 —— 一旦被 CSS 的 transform 碰到, 定位就会被覆盖掉。 */
        <g key={i} transform={`translate(${e.cx * CANVAS_W} ${e.cy * CANVAS_H})`}>
          {/* 第二层: 眼珠朝哪看 (平移)。 */}
          <g className="neox-mascot__eye-shift">
            {/* 第三层: 睁大 / 缩小 (整体缩放)。 */}
            <g className="neox-mascot__eye-scale">
              {/* 第四层: 眼睑开合 (纵向缩放)。 */}
              <g className="neox-mascot__eye-lid">
                <ellipse className="neox-mascot__eye-ball" cx={0} cy={0} rx={r} ry={r} />
                {/* 高光随眼球缩放, 保持在眼心右上方。 */}
                <circle className="neox-mascot__eye-spec" cx={r * 0.3} cy={-r * 0.42} r={r * 0.3} />
              </g>
            </g>
          </g>
        </g>
      ))}
    </svg>
  );
};

export default MascotEyes;
