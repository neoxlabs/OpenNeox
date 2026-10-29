/**
 * Pet2DSprite — 2D 桌宠 canvas 渲染器
 *
 * 渲染 Pet2DSpec 到 canvas, mood 驱动每帧动画. 用 requestAnimationFrame 循环,
 * 但 idle 时降到 ~30fps 节省 CPU (idle 动画很慢, 不需要 60fps).
 *
 * pet window 内 / PetTab 预览都用这个组件 — 同一 spec 渲染同一只.
 */

import React, { useEffect, useRef } from 'react';
import { drawPet2D, type Pet2DSpec, type Pet2DMood } from './pet2d';

interface Pet2DSpriteProps {
  spec: Pet2DSpec;
  mood: Pet2DMood;
  /** canvas 显示像素 (内部会按 devicePixelRatio scale 出实际像素) */
  size: number;
  /** false 时停止 RAF, 用于不可见时省电 */
  active?: boolean;
}

export const Pet2DSprite: React.FC<Pet2DSpriteProps> = ({ spec, mood, size, active = true }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    ctx.scale(dpr, dpr);

    startRef.current = performance.now();
    /* 帧率门控 — idle/sleeping/thinking 走 30fps, happy/error/speaking 60fps. */
    const targetFps = mood === 'happy' || mood === 'error' || mood === 'speaking' ? 60 : 30;
    const frameInterval = 1000 / targetFps;
    let lastFrame = 0;

    const tick = (now: number) => {
      if (!active) return;
      if (now - lastFrame >= frameInterval) {
        const t = (now - startRef.current) / 1000;
        drawPet2D(ctx, spec, mood, t, size);
        lastFrame = now;
      }
      rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [spec, mood, size, active]);

  return <canvas ref={canvasRef} style={{ display: 'block', pointerEvents: 'none' }} />;
};

export default Pet2DSprite;
