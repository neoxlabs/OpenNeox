/* ============================================================
 * BrowserBrandIcon — 外置浏览器的真 brand logo
 *
 *   资源在 assets/icons/browsers/*.svg, 由
 *   `apps/desktop/scripts/fetch-browser-icons.sh` 从 simple-icons (CC0)
 *   拉下来, Vite 构建期 inline 进 bundle, 运行时零网络请求.
 *
 *   做法跟 components/FileTypeIcon.tsx 完全一致: simple-icons 的 mark 是单 path
 *   无 fill 的单色图形, 我们在渲染时注入官方 brand hex —— 所以拿到的是真实的品牌
 *   外形 + 真实的品牌色, 不是随手画的圆点.
 * ============================================================ */

import React, { useMemo } from 'react';

/* Vite eager glob 取 SVG **源码字符串** (?raw) —— 要往里注 fill, 不能走 URL. */
const BROWSER_ICON_RAW = import.meta.glob('../../../assets/icons/browsers/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

export type BrowserBrand = 'chrome' | 'chromium' | 'brave' | 'edge';

interface BrandSpec {
  /** assets/icons/browsers/<file>.svg */
  file: string;
  /** simple-icons 官方 brand color (公开数据) */
  color: string;
  /** 卡片文案里用的显示名 */
  label: string;
}

const BROWSER_BRANDS: Record<BrowserBrand, BrandSpec> = {
  chrome:   { file: 'googlechrome',  color: '#4285F4', label: 'Chrome' },
  chromium: { file: 'googlechrome',  color: '#4587F3', label: 'Chromium' },
  brave:    { file: 'brave',         color: '#FB542B', label: 'Brave' },
  edge:     { file: 'microsoftedge', color: '#0078D7', label: 'Edge' },
};

export function browserLabel(brand: BrowserBrand | undefined): string {
  return BROWSER_BRANDS[brand ?? 'chrome']?.label ?? 'Chrome';
}

function rawOf(file: string): string | null {
  const key = Object.keys(BROWSER_ICON_RAW).find(p => p.endsWith(`/${file}.svg`));
  return key ? BROWSER_ICON_RAW[key] : null;
}

/** 注 fill + 强制尺寸 —— 跟 FileTypeIcon.colorizeSvg 同一套处理. */
function colorize(raw: string, color: string, size: number): string {
  let out = raw.replace(/<path(?![^>]*\sfill=)/g, `<path fill="${color}"`);
  out = out.replace(/<svg([^>]*)>/, (_m, attrs: string) => {
    const cleaned = attrs.replace(/\swidth="[^"]*"/g, '').replace(/\sheight="[^"]*"/g, '');
    return `<svg${cleaned} width="${size}" height="${size}">`;
  });
  return out;
}

/**
 * dimmed: 浏览器没在跑时降饱和 + 压透明度 —— 状态还是靠 logo 本身表达,
 * 不再需要旁边那个跟品牌无关的绿点。
 */
export const BrowserBrandIcon: React.FC<{
  brand?: BrowserBrand;
  size?: number;
  dimmed?: boolean;
}> = ({ brand = 'chrome', size = 18, dimmed = false }) => {
  const spec = BROWSER_BRANDS[brand] ?? BROWSER_BRANDS.chrome;
  const html = useMemo(() => {
    const raw = rawOf(spec.file);
    return raw ? colorize(raw, spec.color, size) : null;
  }, [spec.file, spec.color, size]);

  if (!html) return null;
  return (
    <span
      className={`sfc-browser-brand${dimmed ? ' is-dimmed' : ''}`}
      style={{ width: size, height: size }}
      title={spec.label}
      aria-label={spec.label}
      role="img"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

export default BrowserBrandIcon;
