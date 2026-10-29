import React, { useState } from 'react';

const C = 'var(--pack-label, currentColor)';

/* 通用包装 — 统一 viewBox + 绝对覆盖父 .theme-pack-card__art */
const SvgFrame: React.FC<{ children: React.ReactNode; opacity?: number }> = ({ children, opacity = 0.72 }) => (
  <svg
    viewBox="0 0 160 100"
    xmlns="http://www.w3.org/2000/svg"
    style={{
      position: 'absolute',
      inset: 0,
      width: '100%',
      height: '100%',
      opacity,
      pointerEvents: 'none',
      zIndex: 1,
    }}
    aria-hidden
  >
    {children}
  </svg>
);

/* ─── 19 个 motif ─── */

const MotifSoftWhite = () => (
  <SvgFrame opacity={0.46}>
    {/* 浅白 — 干净工作台分栏 */}
    <rect x="32" y="22" width="96" height="56" rx="10" fill="none" stroke={C} strokeWidth="1.4" />
    <line x1="58" y1="22" x2="58" y2="78" stroke={C} strokeWidth="1.1" opacity="0.72" />
    <line x1="58" y1="38" x2="128" y2="38" stroke={C} strokeWidth="1.1" opacity="0.42" />
    <rect x="68" y="50" width="42" height="6" rx="3" fill={C} opacity="0.32" />
    <rect x="68" y="61" width="28" height="5" rx="2.5" fill={C} opacity="0.24" />
  </SvgFrame>
);

const MotifAnye = () => (
  <SvgFrame opacity={0.7}>
    {/* 暗夜 — 新月 + 3 颗星 */}
    <path d="M 100 30 a 24 24 0 1 0 0 40 a 18 18 0 1 1 0 -40 z" fill={C} />
    <circle cx="40" cy="30" r="1.5" fill={C} />
    <circle cx="55" cy="55" r="1" fill={C} />
    <circle cx="35" cy="68" r="1.5" fill={C} />
    <path d="M 38 25 l 0 6 M 35 28 l 6 0" stroke={C} strokeWidth="0.5" />
  </SvgFrame>
);

const MotifTaroBubble = () => (
  <SvgFrame opacity={0.55}>
    {/* 香芋啵啵 — 大小不一的奶茶珍珠泡泡 */}
    <circle cx="50" cy="68" r="10" fill={C} opacity="0.6" />
    <circle cx="72" cy="60" r="7" fill={C} opacity="0.6" />
    <circle cx="88" cy="74" r="9" fill={C} opacity="0.6" />
    <circle cx="106" cy="55" r="6" fill={C} opacity="0.6" />
    <circle cx="118" cy="68" r="8" fill={C} opacity="0.6" />
    <circle cx="60" cy="50" r="4" fill={C} opacity="0.4" />
  </SvgFrame>
);

const MotifSeaSalt = () => (
  <SvgFrame opacity={0.6}>
    {/* 海盐粉荔 — 一颗荔枝 + 飘散盐粒 */}
    <circle cx="78" cy="55" r="20" fill="none" stroke={C} strokeWidth="1.5" />
    {/* 荔枝皮纹理 */}
    <path d="M 65 48 l 3 3 M 75 45 l 3 3 M 85 50 l 3 3 M 70 60 l 3 3 M 82 62 l 3 3" stroke={C} strokeWidth="0.6" />
    {/* 叶柄 */}
    <path d="M 78 35 q -3 -8 -10 -10" stroke={C} strokeWidth="1.5" fill="none" />
    {/* 盐粒 */}
    <circle cx="35" cy="30" r="1.5" fill={C} />
    <circle cx="125" cy="38" r="1.5" fill={C} />
    <circle cx="120" cy="80" r="1" fill={C} />
    <circle cx="45" cy="78" r="1.5" fill={C} />
  </SvgFrame>
);

const MotifOrangeSoda = () => (
  <SvgFrame opacity={0.7}>
    {/* 橘子汽水 — 半个橘子切面 */}
    <circle cx="80" cy="50" r="28" fill="none" stroke={C} strokeWidth="1.5" />
    {/* 8 道果瓣 */}
    <g stroke={C} strokeWidth="1" opacity="0.7">
      <line x1="80" y1="22" x2="80" y2="78" />
      <line x1="52" y1="50" x2="108" y2="50" />
      <line x1="60" y1="30" x2="100" y2="70" />
      <line x1="100" y1="30" x2="60" y2="70" />
    </g>
    {/* 几颗气泡 */}
    <circle cx="35" cy="35" r="2" fill={C} opacity="0.5" />
    <circle cx="128" cy="68" r="2" fill={C} opacity="0.5" />
    <circle cx="120" cy="28" r="1.5" fill={C} opacity="0.5" />
  </SvgFrame>
);

const MotifMungBean = () => (
  <SvgFrame opacity={0.65}>
    {/* 绿豆冰沙 — 杯顶视图 + 吸管 */}
    <ellipse cx="78" cy="55" rx="28" ry="22" fill="none" stroke={C} strokeWidth="1.5" />
    {/* 几粒绿豆 */}
    <circle cx="68" cy="50" r="3" fill={C} opacity="0.7" />
    <circle cx="82" cy="58" r="3" fill={C} opacity="0.7" />
    <circle cx="92" cy="48" r="2.5" fill={C} opacity="0.7" />
    <circle cx="72" cy="62" r="2.5" fill={C} opacity="0.7" />
    {/* 吸管 */}
    <line x1="98" y1="40" x2="118" y2="20" stroke={C} strokeWidth="2.5" strokeLinecap="round" />
  </SvgFrame>
);

const MotifTwilight = () => (
  <SvgFrame opacity={0.75}>
    {/* 暮云青 — 3 层叠山 */}
    <path d="M 0 80 L 30 50 L 50 70 L 75 35 L 100 60 L 130 40 L 160 65 L 160 100 L 0 100 Z" fill={C} opacity="0.4" />
    <path d="M 0 90 L 25 65 L 55 78 L 80 55 L 115 75 L 145 60 L 160 75 L 160 100 L 0 100 Z" fill={C} opacity="0.6" />
    {/* 远处月 */}
    <circle cx="118" cy="28" r="6" fill={C} opacity="0.5" />
  </SvgFrame>
);

const MotifImperialGold = () => (
  <SvgFrame opacity={0.75}>
    {/* 典雅金 — 古印 + 笔触 */}
    <rect x="58" y="30" width="44" height="40" fill="none" stroke={C} strokeWidth="2" />
    {/* 印内简化字 — 一横一竖一点 */}
    <line x1="68" y1="42" x2="92" y2="42" stroke={C} strokeWidth="1.5" />
    <line x1="80" y1="42" x2="80" y2="62" stroke={C} strokeWidth="1.5" />
    <circle cx="80" cy="58" r="2" fill={C} />
    {/* 旁边一笔 */}
    <path d="M 30 80 q 10 -8 25 0" stroke={C} strokeWidth="1.5" fill="none" strokeLinecap="round" />
  </SvgFrame>
);

const MotifLilac = () => (
  <SvgFrame opacity={0.7}>
    {/* 丁香紫 — 4 瓣丁香花 + 茎 */}
    <g transform="translate(80 45)">
      <ellipse cx="0" cy="-10" rx="6" ry="9" fill={C} opacity="0.7" />
      <ellipse cx="10" cy="0" rx="9" ry="6" fill={C} opacity="0.7" />
      <ellipse cx="0" cy="10" rx="6" ry="9" fill={C} opacity="0.7" />
      <ellipse cx="-10" cy="0" rx="9" ry="6" fill={C} opacity="0.7" />
      <circle cx="0" cy="0" r="3" fill={C} />
    </g>
    {/* 茎 */}
    <path d="M 80 55 Q 78 75 70 90" stroke={C} strokeWidth="1.5" fill="none" strokeLinecap="round" />
    {/* 一片叶 */}
    <path d="M 78 72 q 8 -3 12 -10" stroke={C} strokeWidth="1.2" fill="none" strokeLinecap="round" />
  </SvgFrame>
);

const MotifCinnabar = () => (
  <SvgFrame opacity={0.75}>
    {/* 辰砂朱 — 圆印 + 一笔水墨 */}
    <circle cx="80" cy="50" r="24" fill={C} opacity="0.85" />
    {/* 印内一字 — "朱" 简化 */}
    <g stroke="var(--pack-bg, #fff)" strokeWidth="2" fill="none" strokeLinecap="round">
      <line x1="80" y1="38" x2="80" y2="62" />
      <line x1="70" y1="48" x2="90" y2="48" />
      <line x1="74" y1="56" x2="86" y2="56" />
    </g>
    {/* 旁边一笔 */}
    <path d="M 25 80 q 20 -10 35 -3" stroke={C} strokeWidth="2" fill="none" strokeLinecap="round" />
  </SvgFrame>
);

const MotifAgedInk = () => (
  <SvgFrame opacity={0.75}>
    {/* 苍墨 — 一笔大弧水墨 + 一点 */}
    <path d="M 20 70 Q 50 20 110 40 Q 130 48 140 70" stroke={C} strokeWidth="5" fill="none" strokeLinecap="round" opacity="0.6" />
    <path d="M 25 75 Q 55 28 105 48 Q 125 56 138 75" stroke={C} strokeWidth="2.5" fill="none" strokeLinecap="round" />
    <circle cx="125" cy="85" r="3" fill={C} />
  </SvgFrame>
);

const MotifInkStone = () => (
  <SvgFrame opacity={0.7}>
    {/* 乌墨砚 — 砚台俯视 + 一滴水 */}
    <ellipse cx="78" cy="62" rx="44" ry="22" fill="none" stroke={C} strokeWidth="2" />
    <ellipse cx="78" cy="62" rx="32" ry="14" fill={C} opacity="0.35" />
    {/* 一滴墨 */}
    <path d="M 78 22 q -4 14 0 18 q 4 -4 0 -18 z" fill={C} />
    {/* 涟漪 */}
    <ellipse cx="78" cy="62" rx="20" ry="9" fill="none" stroke={C} strokeWidth="0.7" opacity="0.5" />
  </SvgFrame>
);

const MotifSakura = () => (
  <SvgFrame opacity={0.7}>
    {/* 桃桃满满 — 5 瓣桃花 */}
    <g transform="translate(80 50)" fill={C}>
      {[0, 72, 144, 216, 288].map((deg, i) => (
        <ellipse
          key={i}
          cx="0"
          cy="-15"
          rx="7"
          ry="11"
          transform={`rotate(${deg})`}
          opacity="0.7"
        />
      ))}
      <circle cx="0" cy="0" r="4" />
    </g>
    {/* 几粒花蕊小点 */}
    <circle cx="40" cy="30" r="1.5" fill={C} opacity="0.5" />
    <circle cx="125" cy="78" r="1.5" fill={C} opacity="0.5" />
  </SvgFrame>
);

const MotifPurpleYours = () => (
  <SvgFrame opacity={0.55}>
    {/* 紫属于你 — 抽象有机 blob 叠加 */}
    <ellipse cx="58" cy="55" rx="28" ry="22" fill={C} opacity="0.4" transform="rotate(-20 58 55)" />
    <ellipse cx="98" cy="48" rx="22" ry="30" fill={C} opacity="0.4" transform="rotate(30 98 48)" />
    <circle cx="80" cy="65" r="14" fill={C} opacity="0.5" />
  </SvgFrame>
);

const MotifHardToStayBlue = () => (
  <SvgFrame opacity={0.65}>
    {/* 蓝以为情 — 几道空气线 + 一只小鸟剪影 */}
    <path d="M 20 35 q 30 -10 60 0 q 30 10 60 -3" stroke={C} strokeWidth="1.2" fill="none" />
    <path d="M 20 55 q 30 -8 60 0 q 30 8 60 -2" stroke={C} strokeWidth="1.2" fill="none" />
    <path d="M 20 75 q 30 -8 60 0 q 30 8 60 -2" stroke={C} strokeWidth="1.2" fill="none" />
    {/* 一只飞鸟 */}
    <path d="M 95 35 q 6 -5 12 0 q -6 -2 -12 0 z M 107 35 q 6 -5 12 0 q -6 -2 -12 0 z" fill={C} />
  </SvgFrame>
);

const MotifSeaMoon = () => (
  <SvgFrame opacity={0.75}>
    {/* 海月寐 — 月亮 + 海面水波 */}
    <circle cx="98" cy="35" r="14" fill={C} opacity="0.85" />
    {/* 海平线 */}
    <line x1="0" y1="65" x2="160" y2="65" stroke={C} strokeWidth="0.8" />
    {/* 海面波纹 */}
    <path d="M 0 75 q 16 -5 32 0 t 32 0 t 32 0 t 32 0 t 32 0" stroke={C} strokeWidth="1" fill="none" opacity="0.7" />
    <path d="M 0 85 q 16 -5 32 0 t 32 0 t 32 0 t 32 0 t 32 0" stroke={C} strokeWidth="1" fill="none" opacity="0.5" />
    {/* 月亮倒影 */}
    <ellipse cx="98" cy="78" rx="8" ry="2" fill={C} opacity="0.4" />
  </SvgFrame>
);

const MotifNeon = () => (
  <SvgFrame opacity={0.85}>
    {/* 夜霓虹 — 两道发光霓虹长条 */}
    <defs>
      <filter id="neonglow" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="2" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
    <g filter="url(#neonglow)" stroke={C} strokeWidth="2.5" strokeLinecap="round">
      <line x1="20" y1="40" x2="100" y2="40" />
      <line x1="55" y1="65" x2="140" y2="65" />
    </g>
    {/* 几粒霓虹点 */}
    <circle cx="115" cy="40" r="2" fill={C} />
    <circle cx="40" cy="65" r="2" fill={C} />
  </SvgFrame>
);

const MotifMatrix = () => (
  <SvgFrame opacity={0.65}>
    {/* 终端微光 — 光标 + dot 矩阵 */}
    <g fill={C}>
      {/* 几行 dots */}
      {[0, 1, 2, 3].map((row) =>
        [0, 1, 2, 3, 4, 5, 6, 7].map((col) => (
          <circle
            key={`${row}-${col}`}
            cx={30 + col * 15}
            cy={30 + row * 13}
            r={(row + col) % 3 === 0 ? 2 : 1}
            opacity={0.4 + ((row + col) % 3) * 0.2}
          />
        )),
      )}
    </g>
    {/* 光标 */}
    <rect x="143" y="76" width="6" height="14" fill={C} />
  </SvgFrame>
);

const MotifAurora = () => (
  <SvgFrame opacity={0.75}>
    {/* 极光 — 3 道波纹 */}
    <path d="M 0 40 Q 40 20 80 35 T 160 30" stroke={C} strokeWidth="2.5" fill="none" opacity="0.5" />
    <path d="M 0 55 Q 40 35 80 50 T 160 45" stroke={C} strokeWidth="2" fill="none" opacity="0.7" />
    <path d="M 0 72 Q 40 52 80 67 T 160 62" stroke={C} strokeWidth="1.5" fill="none" />
    {/* 几颗星 */}
    <circle cx="120" cy="20" r="1" fill={C} />
    <circle cx="40" cy="22" r="1" fill={C} />
  </SvgFrame>
);

const MotifVaporwave = () => (
  <SvgFrame opacity={0.8}>
    {/* 暮霭 — 半个太阳从云中升起 + 网格地平线 */}
    {/* 太阳半圆 */}
    <path d="M 50 55 a 30 30 0 0 1 60 0 z" fill={C} opacity="0.8" />
    {/* 横线条 (vaporwave 特色) */}
    <line x1="50" y1="40" x2="110" y2="40" stroke="var(--pack-bg, #fff)" strokeWidth="1" />
    <line x1="55" y1="48" x2="105" y2="48" stroke="var(--pack-bg, #fff)" strokeWidth="1" />
    {/* 透视地平线网格 */}
    <line x1="0" y1="60" x2="160" y2="60" stroke={C} strokeWidth="1" opacity="0.5" />
    {/* 几条远去的透视线 */}
    {[40, 60, 80, 100, 120].map((x) => (
      <line key={x} x1={x} y1="60" x2={x + (x - 80) * 0.8} y2="95" stroke={C} strokeWidth="0.6" opacity="0.5" />
    ))}
  </SvgFrame>
);

/* ────────────────────────────────────────────────────────── */

/* SVG motif 兜底 — 按 pack id dispatch */
const SvgMotif: React.FC<{ packId: string }> = ({ packId }) => {
  switch (packId) {
    case 'liulibasic':   return <MotifSoftWhite />;
    case 'anye':         return <MotifAnye />;
    case 'liuli':        return <MotifTaroBubble />;
    case 'chenguang':    return <MotifSeaSalt />;
    case 'nuanyang':     return <MotifOrangeSoda />;
    case 'moye':         return <MotifMungBean />;
    case 'muyunqing':    return <MotifTwilight />;
    case 'dianyajin':    return <MotifImperialGold />;
    case 'dingxiangzi':  return <MotifLilac />;
    case 'chenshazhu':   return <MotifCinnabar />;
    case 'songyanmo':    return <MotifAgedInk />;
    case 'wumoyan':      return <MotifInkStone />;
    case 'sakura':       return <MotifSakura />;
    case 'musanzi':      return <MotifPurpleYours />;
    case 'qingkong':     return <MotifHardToStayBlue />;
    case 'haiyue':       return <MotifSeaMoon />;
    case 'neonlight':    return <MotifNeon />;
    case 'matrix':       return <MotifMatrix />;
    case 'jiguang':      return <MotifAurora />;
    case 'vaporwave':    return <MotifVaporwave />;
    default:             return null;
  }
};

type ImgStage = 'webp' | 'png' | 'svg';

export const ThemePackThumb: React.FC<{ packId: string }> = ({ packId }) => {
  const [stage, setStage] = useState<ImgStage>('webp');

  if (stage === 'svg') {
    return <SvgMotif packId={packId} />;
  }

  const ext = stage;  /* 'webp' | 'png' */
  const src = `${import.meta.env.BASE_URL}themes/${packId}.${ext}`;

  return (
    <img
      key={ext}                          /* ext 切换时强制重新挂载 + 重试 */
      src={src}
      alt=""
      aria-hidden
      onError={() => setStage((s) => (s === 'webp' ? 'png' : 'svg'))}
      draggable={false}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        pointerEvents: 'none',
        zIndex: 1,
        userSelect: 'none',
      }}
    />
  );
};

export default ThemePackThumb;
