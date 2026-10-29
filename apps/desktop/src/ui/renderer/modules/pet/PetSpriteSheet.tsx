
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  PET_SPRITE_STATES,
  type PetSpriteState,
  type SpriteAtlas,
  CODEX_ATLAS,
} from './petSpriteStates';

export interface PetSpriteSheetProps {
  /** sprite sheet URL — /sprites/x.webp (内置), neox-pet://local/sprite/y.webp (导入), 或 https://... */
  url: string;
  /** 当前播放的动画状态 */
  state: PetSpriteState;
  /** 显示尺寸 (px) — 整只桌宠的目标边长, 内部按 atlas 比例缩放单元格 */
  size: number;
  /** 图集描述 — 缺省用内置 192×208. 导入的 sheet 传各自实际单元格尺寸. */
  atlas?: SpriteAtlas;
  /** 镜像 (用于 left/right 朝向). 默认 false. */
  mirror?: boolean;
  /** 暂停动画 (sleep 状态用) — 停在首帧 */
  paused?: boolean;
}

/* 是否用户偏好减少动态 — 模块级求值一次 */
const prefersReducedMotion =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const PetSpriteSheet: React.FC<PetSpriteSheetProps> = ({
  url,
  state,
  size,
  atlas = CODEX_ATLAS,
  mirror = false,
  paused = false,
}) => {
  const def = PET_SPRITE_STATES[state];
  const frozen = paused || prefersReducedMotion;

  /* 当前帧索引 — 唯一进 state 的动画变量, 仅在换帧时 setState (低频) */
  const [frame, setFrame] = useState(0);

  /* 缩放: 以单元格宽度为基准, 把 cellWidth 映射到目标 size */
  const scale = size / atlas.cellWidth;
  const displayW = atlas.cellWidth * scale;
  const displayH = atlas.cellHeight * scale;
  /* 渲染质量自适应: 放大小尺寸像素画 → pixelated 保持锐利; 缩小高清图集 → auto 平滑不发糊.
   * (咕咕嘎嘎等高分辨率 sheet 单元格远大于显示尺寸, 走 auto 才高素质) */
  const imageRendering: 'auto' | 'pixelated' = scale >= 1 ? 'pixelated' : 'auto';

  /* state / atlas / url 变化时复位到首帧 */
  useEffect(() => {
    setFrame(0);
  }, [state, url, atlas.cellWidth, atlas.cellHeight]);

  /* rAF 帧步进 — 累计 elapsed, 跨过当前帧时长就前进, 支持逐帧可变时长 */
  useEffect(() => {
    if (frozen) return;
    const durations = def.frameDurationsMs;
    if (durations.length <= 1) return; /* 单帧无需动画 */

    let rafId = 0;
    let last = performance.now();
    let acc = 0;
    let idx = 0;

    const tick = (now: number) => {
      acc += now - last;
      last = now;
      /* 可能跨过多帧 (掉帧时), while 消化 */
      let advanced = false;
      while (acc >= durations[idx]) {
        acc -= durations[idx];
        idx = (idx + 1) % durations.length;
        advanced = true;
      }
      if (advanced) setFrame(idx);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [def, frozen]);

  const style = useMemo<React.CSSProperties>(() => {
    const fx = frozen ? 0 : frame;
    return {
      width: displayW,
      height: displayH,
      backgroundImage: `url("${url}")`,
      backgroundRepeat: 'no-repeat',
      /* 整张图按 scale 拉伸 */
      backgroundSize: `${atlas.cellWidth * atlas.cols * scale}px ${atlas.cellHeight * atlas.rows * scale}px`,
      /* 定位到 (col=fx, row=def.row) 那一格 */
      backgroundPositionX: `${-fx * displayW}px`,
      backgroundPositionY: `${-def.row * displayH}px`,
      imageRendering: imageRendering as any, /* 自适应: 放大像素画锐利 / 缩小高清图平滑 */
      contain: 'layout paint',
      willChange: 'background-position',
      transform: mirror ? 'scaleX(-1)' : 'none',
      transformOrigin: 'center',
      pointerEvents: 'none',
      userSelect: 'none',
      WebkitUserSelect: 'none',
    } as React.CSSProperties;
  }, [url, frame, frozen, def.row, displayW, displayH, atlas, scale, mirror, imageRendering]);

  return <div className="pet-sprite-sheet" style={style} aria-hidden="true" />;
};

export default PetSpriteSheet;
