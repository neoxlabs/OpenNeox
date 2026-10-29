
import { useI18n } from '../../hooks/useI18n';
import React, { useEffect, useRef } from 'react';

interface Props {
  analyser: AnalyserNode | null;
  state: 'recording' | 'transcribing';
  onStop?: () => void;
  label?: string;
  variant?: 'bar' | 'field';
}

export const ComposerMicWave: React.FC<Props> = ({ analyser, state, onStop, label, variant = 'bar' }) => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      const rect = cvs.getBoundingClientRect();
      cvs.width = Math.floor(rect.width * dpr);
      cvs.height = Math.floor(rect.height * dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cvs);

    /* 从 CSS 变量读色 (亮/暗主题自动跟随, 主题切换时下一帧生效) */
    const readColors = () => {
      const cs = getComputedStyle(cvs);
      const primary = cs.getPropertyValue('--atl-wave-primary').trim()
        || cs.getPropertyValue('--neox-primary-500').trim()
        || '#6d5df3';
      const accent = cs.getPropertyValue('--atl-wave-accent').trim()
        || cs.getPropertyValue('--neox-primary-300').trim()
        || '#a89bff';
      return { primary, accent };
    };

    const bins = analyser ? new Uint8Array(analyser.frequencyBinCount) : new Uint8Array(0);

    let raf = 0;
    let t = 0;
    /* level 平滑 — 电平低通滤波, 呼吸感 */
    let smooth = 0.08;

    /* 波形两条股, 相位/频率错开 (借鉴 SiriWaveCanvas 但极简: 2 股 × 1 层, 无 additive) */
    const STRANDS = [
      { key: 'primary' as const, freq: 3.4, speed: 1.15, offset: 0, lineWidthScale: 1.0, alpha: 0.95 },
      { key: 'accent' as const,  freq: 5.1, speed: 0.82, offset: 2.3, lineWidthScale: 0.7, alpha: 0.55 },
    ];

    const draw = () => {
      t += 0.016;
      const W = cvs.width;
      const H = cvs.height;
      ctx.clearRect(0, 0, W, H);

      /* level: recording 时读 analyser RMS; transcribing/idle 用衰减到低点位的呼吸 */
      /* field: 输入框里那条要一眼看出「在听」, 静音底噪也给 0.28±0.08 的呼吸, 有声音再往上顶 */
      const floor = variant === 'field' ? 0.28 + Math.sin(t * 1.8) * 0.08 : 0.08;
      let target = floor;
      if (analyser && state === 'recording') {
        analyser.getByteFrequencyData(bins);
        /* 只取前 40% bin (人声主频 <4kHz), 求平均 → 0..1 */
        const usable = Math.floor(bins.length * 0.4);
        let sum = 0;
        for (let i = 0; i < usable; i++) sum += bins[i];
        target = Math.max(floor, Math.min(1, (sum / usable) / 200));
      } else if (state === 'transcribing') {
        /* 转写中: 低幅呼吸 (0.15±) */
        target = 0.15 + Math.sin(t * 2.5) * 0.05;
      }
      smooth += (target - smooth) * 0.18;

      const { primary, accent } = readColors();
      const midY = H / 2;
      const maxHalf = H * 0.42;

      for (const s of STRANDS) {
        const color = s.key === 'primary' ? primary : accent;
        ctx.beginPath();
        const step = Math.max(2, Math.round(2 * dpr));
        for (let px = 0; px <= W; px += step) {
          const x = (px / W) * 2 - 1;                       /* -1..1 */
          const env = Math.pow(Math.max(0, 1 - x * x), 1.5); /* 钟形包络: 两端归零 */
          const y = midY + env * smooth * maxHalf
            * Math.sin((px / W) * s.freq * Math.PI + t * 2.2 * s.speed + s.offset);
          if (px === 0) ctx.moveTo(px, y); else ctx.lineTo(px, y);
        }
        /* 透明度联动电平 — 电平低时更淡 (呼吸感), 高时清晰 */
        const alphaMul = state === 'transcribing' ? 0.45 : (0.55 + 0.45 * Math.min(1, smooth * 2));
        ctx.strokeStyle = withAlpha(color, s.alpha * alphaMul);
        ctx.lineWidth = 1.5 * dpr * s.lineWidthScale;
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [analyser, state, variant]);

  return (
    <button
      type="button"
      className={`atl-mic-wave atl-mic-wave--${state} atl-mic-wave--${variant}`}
      onClick={onStop}
      aria-label={label || (state === 'recording' ? (zh ? '正在录音, 点击结束' : 'Recording — click to stop') : (zh ? '识别中' : 'Transcribing'))}
      title={state === 'recording' ? (zh ? '点击结束录音' : 'Click to stop recording') : (zh ? '识别中…' : 'Transcribing…')}
    >
      <canvas ref={canvasRef} className="atl-mic-wave__canvas" />
      <span className="atl-mic-wave__hint">
        {state === 'recording' ? (zh ? '聆听中' : 'Listening') : (zh ? '识别中' : 'Transcribing')}
      </span>
    </button>
  );
};

/** 把任意 CSS 颜色 (hex / rgb / var) 转成带 alpha 版本. hex 精确; rgb 直接改; 其他直接用 (canvas 认 currentColor 有限). */
function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  if (c.startsWith('#')) {
    const hex = c.slice(1);
    const full = hex.length === 3 ? hex.split('').map(x => x + x).join('') : hex;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const m = c.match(/^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${alpha})`;
  return c;  /* 未知格式回退, 忽略 alpha */
}

export default ComposerMicWave;
