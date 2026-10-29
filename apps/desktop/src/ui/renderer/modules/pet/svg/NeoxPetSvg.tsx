/**
 * NeoxPetSvg — Neox 原创矢量桌宠 "Neo"
 *
 * 一只圆润柔软的"灵体"小生物: 大眼睛 + 一根会发光的触角 (Neox 的签名细节).
 * 不是猫、不是机器人 — 独立设计, 矢量绘制, 零美工资源依赖.
 *
 * 渲染哲学 (分层 SVG + CSS 驱动):
 *   · 身体 / 头 / 眼 / 嘴 / 腮红 / 触角 各自独立 <g> 层
 *   · 表情切换 = 切根容器 class (neox-pet--{expr}), CSS 控制 expression-* 子层显隐,
 *     不靠 React 条件渲染 — 切心情零重渲染
 *   · 情绪动画全是 CSS @keyframes (呼吸 / 跳 / 摇 / 抖 / 弹)
 *   · 视线跟随鼠标: JS 写 CSS 变量 --gaze-x/y (眼) 和 --head-tilt (头), 头比眼慢出层次
 *   · 打字反应: typing=true 时加 --typing 类, 触角发光 + 身体轻点 (像在认真陪你写)
 *
 * 性能: 纯 CSS 动画走 GPU 合成, 几乎不耗 CPU; 跟 macOS 透明窗口完全兼容 (无 WebGL).
 */

import React, { useEffect, useMemo, useRef } from 'react';
import type { PetMood } from '../PetSceneR3F';
import './NeoxPetSvg.css';

/** Neo 的色板变体 — 每个是 [主体, 高光, 描边, 触角光] */
export interface NeoVariant {
  id: string;
  name: string;
  nameEn: string;
  body: string;
  bodyHi: string;
  stroke: string;
  glow: string;
}

export const NEO_VARIANTS: NeoVariant[] = [
  { id: 'aurora', name: '月白', nameEn: 'Moonlight', body: '#d8dade', bodyHi: '#f6f7f8', stroke: '#343840', glow: '#ffffff' },
  { id: 'mint',   name: '薄荷', nameEn: 'Mint',   body: '#5fd6b4', bodyHi: '#9bf0d8', stroke: '#1d4f43', glow: '#fff39b' },
  { id: 'peach',  name: '蜜桃', nameEn: 'Peach',  body: '#ff9bb0', bodyHi: '#ffc4d0', stroke: '#5e2230', glow: '#ffe27a' },
  { id: 'slate',  name: '夜空', nameEn: 'Slate',  body: '#5b6b8c', bodyHi: '#8ea0c4', stroke: '#1a2238', glow: '#9be7ff' },
];

export function resolveVariant(id: string | undefined): NeoVariant {
  return NEO_VARIANTS.find((v) => v.id === id) ?? NEO_VARIANTS[0];
}

type NeoExpr = 'idle' | 'happy' | 'sleepy' | 'think' | 'speak' | 'error' | 'success';

function moodToExpr(mood: PetMood): NeoExpr {
  switch (mood) {
    case 'happy':    return 'happy';
    case 'success':  return 'success';
    case 'sleeping': return 'sleepy';
    case 'error':    return 'error';
    case 'speaking': return 'speak';
    case 'thinking':
    case 'waiting':  return 'think';
    case 'running':
    case 'coding':
    case 'reading':  return 'think';
    default:         return 'idle';
  }
}

const MAX_GAZE_PX = 5;
const MAX_TILT_DEG = 7;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export interface NeoxPetSvgProps {
  mood: PetMood;
  size: number;
  variant?: string;
  /** 用户正在打字时 true — 触角发光 + 轻点反应 */
  typing?: boolean;
  /** 是否跟随鼠标视线 (透明窗口里鼠标相对窗口中心) */
  gaze?: boolean;
}

export const NeoxPetSvg: React.FC<NeoxPetSvgProps> = ({ mood, size, variant, typing = false, gaze = true }) => {
  const v = resolveVariant(variant);
  const expr = moodToExpr(mood);
  const ref = useRef<SVGSVGElement>(null);

  /* 视线跟随 — 鼠标相对窗口中心, 透明全屏 pet 窗口里直接用 window 尺寸 */
  useEffect(() => {
    if (!gaze) return;
    const onMove = (e: MouseEvent) => {
      const svg = ref.current;
      if (!svg) return;
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      const gx = clamp(((e.clientX - cx) / cx) * MAX_GAZE_PX, -MAX_GAZE_PX, MAX_GAZE_PX);
      const gy = clamp(((e.clientY - cy) / cy) * MAX_GAZE_PX, -MAX_GAZE_PX, MAX_GAZE_PX);
      const tilt = clamp(((e.clientX - cx) / cx) * MAX_TILT_DEG, -MAX_TILT_DEG, MAX_TILT_DEG);
      svg.style.setProperty('--gaze-x', `${gx.toFixed(2)}px`);
      svg.style.setProperty('--gaze-y', `${gy.toFixed(2)}px`);
      svg.style.setProperty('--head-tilt', `${tilt.toFixed(2)}deg`);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [gaze]);

  const rootClass = useMemo(
    () => ['neox-pet', `neox-pet--${expr}`, typing ? 'neox-pet--typing' : ''].filter(Boolean).join(' '),
    [expr, typing],
  );

  return (
    <div className={rootClass} style={{ width: size, height: size }}>
      <svg
        ref={ref}
        viewBox="0 0 200 220"
        xmlns="http://www.w3.org/2000/svg"
        className="neox-pet-svg"
        style={{ width: size, height: size, overflow: 'visible' }}
        aria-label={`Neo is ${expr}`}
      >
        {/* 贴地阴影 */}
        <ellipse className="neo-shadow" cx="100" cy="200" rx="46" ry="9" fill="rgba(0,0,0,0.18)" />

        {/* 身体 (mochi 圆体) */}
        <g className="neo-body">
          <path
            d="M100 60
               C150 60 168 104 168 140
               C168 182 138 198 100 198
               C62 198 32 182 32 140
               C32 104 50 60 100 60 Z"
            fill={v.body}
            stroke={v.stroke}
            strokeWidth="3"
          />
          {/* 高光 */}
          <ellipse cx="74" cy="108" rx="22" ry="16" fill={v.bodyHi} opacity="0.55" />
          {/* 肚皮浅色块 */}
          <ellipse cx="100" cy="160" rx="34" ry="30" fill="#fffef5" opacity="0.85" />
        </g>

        {/* 触角 (Neox 签名 — typing / success 时发光) */}
        <g className="neo-antenna">
          <path d="M100 62 C98 44 104 36 100 22" fill="none" stroke={v.stroke} strokeWidth="3" strokeLinecap="round" />
          <circle className="neo-antenna-tip" cx="100" cy="18" r="7" fill={v.glow} stroke={v.stroke} strokeWidth="2" />
        </g>

        {/* 头部组 (视线跟随的 tilt 目标 — 这里整只一起轻倾) */}
        <g className="neo-head">
          {/* 腮红 (happy / excited / success) */}
          <g className="neo-blush">
            <g className="expression-happy">
              <ellipse cx="64" cy="150" rx="11" ry="7" fill="rgba(255,110,130,0.30)" />
              <ellipse cx="136" cy="150" rx="11" ry="7" fill="rgba(255,110,130,0.30)" />
            </g>
            <g className="expression-success">
              <ellipse cx="64" cy="150" rx="12" ry="8" fill="rgba(255,110,130,0.28)" />
              <ellipse cx="136" cy="150" rx="12" ry="8" fill="rgba(255,110,130,0.28)" />
            </g>
          </g>

          {/* 眼睛组 (视线偏移目标) */}
          <g className="neo-eyes">
            {/* idle: 圆亮眼 */}
            <g className="expression-idle">
              <ellipse cx="76" cy="128" rx="11" ry="13" fill={v.stroke} />
              <circle cx="80" cy="123" r="3.6" fill="#fff" />
              <ellipse cx="124" cy="128" rx="11" ry="13" fill={v.stroke} />
              <circle cx="128" cy="123" r="3.6" fill="#fff" />
            </g>
            {/* happy: 弯月 ^_^ */}
            <g className="expression-happy">
              <path d="M65 132 Q76 118 87 132" fill="none" stroke={v.stroke} strokeWidth="4" strokeLinecap="round" />
              <path d="M113 132 Q124 118 135 132" fill="none" stroke={v.stroke} strokeWidth="4" strokeLinecap="round" />
            </g>
            {/* sleepy: 半阖 */}
            <g className="expression-sleepy">
              <path d="M65 130 Q76 136 87 130" fill="none" stroke={v.stroke} strokeWidth="3.4" strokeLinecap="round" />
              <path d="M113 130 Q124 136 135 130" fill="none" stroke={v.stroke} strokeWidth="3.4" strokeLinecap="round" />
            </g>
            {/* think: 眼珠上飘 + 一眼略眯 */}
            <g className="expression-think">
              <ellipse cx="76" cy="126" rx="10" ry="12" fill={v.stroke} />
              <circle cx="79" cy="120" r="3.2" fill="#fff" />
              <path d="M114 128 Q124 122 134 128" fill="none" stroke={v.stroke} strokeWidth="3.6" strokeLinecap="round" />
            </g>
            {/* speak: 正常 + 微张 */}
            <g className="expression-speak">
              <ellipse cx="76" cy="128" rx="10" ry="12" fill={v.stroke} />
              <circle cx="79" cy="123" r="3.4" fill="#fff" />
              <ellipse cx="124" cy="128" rx="10" ry="12" fill={v.stroke} />
              <circle cx="127" cy="123" r="3.4" fill="#fff" />
            </g>
            {/* error: > < 委屈眼 */}
            <g className="expression-error">
              <path d="M66 122 L86 130 L66 136" fill="none" stroke={v.stroke} strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M134 122 L114 130 L134 136" fill="none" stroke={v.stroke} strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
            </g>
            {/* success: 星星眼 */}
            <g className="expression-success">
              {[76, 124].map((cx) => (
                <path
                  key={cx}
                  d={`M${cx} 116 L${cx + 3} 126 L${cx + 13} 128 L${cx + 3} 130 L${cx} 140 L${cx - 3} 130 L${cx - 13} 128 L${cx - 3} 126 Z`}
                  fill={v.glow}
                  stroke={v.stroke}
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
              ))}
            </g>
          </g>

          {/* 嘴组 */}
          <g className="neo-mouth">
            <g className="expression-idle">
              <path d="M92 148 Q100 154 108 148" fill="none" stroke={v.stroke} strokeWidth="2.4" strokeLinecap="round" />
            </g>
            <g className="expression-happy">
              <path d="M88 148 Q100 162 112 148" fill={v.stroke} stroke={v.stroke} strokeWidth="2.4" strokeLinejoin="round" />
            </g>
            <g className="expression-sleepy">
              <path d="M95 150 Q100 153 105 150" fill="none" stroke={v.stroke} strokeWidth="2.2" strokeLinecap="round" />
            </g>
            <g className="expression-think">
              <path d="M93 150 L107 150" fill="none" stroke={v.stroke} strokeWidth="2.4" strokeLinecap="round" />
            </g>
            <g className="expression-speak">
              <ellipse className="neo-speak-mouth" cx="100" cy="150" rx="6" ry="5" fill={v.stroke} />
            </g>
            <g className="expression-error">
              <path d="M92 154 Q100 148 108 154" fill="none" stroke={v.stroke} strokeWidth="2.4" strokeLinecap="round" />
            </g>
            <g className="expression-success">
              <path d="M86 147 Q100 165 114 147" fill={v.stroke} stroke={v.stroke} strokeWidth="2.4" strokeLinejoin="round" />
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
};

export default NeoxPetSvg;
