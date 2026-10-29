
import React, { useState } from 'react';

/* Vite 静态资产 glob import — 编译时把每个文件转换成打包后的 URL.
 * eager=true 立即加载所有 URL 到内存; import=default 拿默认导出 (asset URL string). */
const LOGO_URLS = import.meta.glob<string>(
  '../../../assets/provider-logos/*.{png,svg}',
  { eager: true, import: 'default', query: '?url' },
);

/* 建 preset-id → 本地 asset URL 的查表. key 是文件名 (去扩展). */
const logoByPresetId: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [path, url] of Object.entries(LOGO_URLS)) {
    const filename = path.split('/').pop() || '';
    const id = filename.replace(/\.(png|svg)$/i, '');
    if (id && url) out[id] = url;
  }
  return out;
})();

interface Props {
  presetId: string;
  fallbackLabel?: string;
  brandColor?: string;
  size?: number;
  /** tile: 统一装进 size×size 的圆角底座。见 FULL_BLEED 的说明。 */
  variant?: 'bare' | 'tile';
}

const FULL_BLEED = new Set(['anthropic', 'groq', 'kimi', 'opencode', 'minimax', 'glm', 'grok']);

/* Fallback 品牌色 (仅 logo 缺失时 monogram 用). */
const FALLBACK_COLORS: Record<string, string> = {
  openai:     '#10a37f',
  openrouter: '#6467F2',
  opencode:   '#141414',
  anthropic:  '#D97757',
  gemini:     '#4285F4',
  grok:       '#000000',
  mistral:    '#FA520F',
  groq:       '#F55036',
  together:   '#0F6FFF',
  doubao:     '#0057FF',
  deepseek:   '#4D6BFE',
  kimi:       '#2F7CF6',
  glm:        '#3859FF',
  dashscope:  '#615CED',
  minimax:    '#F8B333',
};

export const ProviderBrandLogo: React.FC<Props> = ({ presetId, fallbackLabel, brandColor, size = 26, variant = 'bare' }) => {
  const url = logoByPresetId[presetId];
  const color = brandColor || FALLBACK_COLORS[presetId] || '#64748b';
  const label = fallbackLabel || presetId;
  const [errored, setErrored] = useState(false);

  if (variant === 'tile') {
    const full = FULL_BLEED.has(presetId) || !url || errored;
    return (
      <span
        className={`provider-logo-tile${full ? ' is-full' : ''}`}
        style={{ width: size, height: size, borderRadius: Math.round(size * 0.26) }}
        aria-hidden
      >
        <ProviderBrandLogo
          presetId={presetId}
          fallbackLabel={fallbackLabel}
          brandColor={brandColor}
          size={full ? size : Math.round(size * 0.6)}
        />
      </span>
    );
  }

  if (url && !errored) {
    /* 无边框 无背景 - 品牌 logo 自带形态, 直接铺满 size × size, 圆角轻裁一下. */
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        style={{
          display: 'inline-block',
          objectFit: 'contain',
          flexShrink: 0,
          borderRadius: size * 0.18,
        }}
        onError={() => setErrored(true)}
        draggable={false}
      />
    );
  }

  /* Fallback: 品牌色圆角方 + 首字母. */
  const letter = label.trim().charAt(0).toUpperCase() || '·';
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size, borderRadius: size * 0.28,
        background: color, color: 'white',
        fontSize: size * 0.5, fontWeight: 700, lineHeight: 1, flexShrink: 0,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      {letter}
    </span>
  );
};

export default ProviderBrandLogo;
