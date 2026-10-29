/**
 * 空态品牌标: 浅色主题纯蓝、深色主题纯白。两张都挂着, 由 brand-mark.css 按 data-theme 只显示一张 ——
 * 切主题不重渲染、不重新解码, 也就不会出现「换主题那一帧没有 logo」。
 */
import brandMarkUrl, { brandMarkWhiteUrl } from './brandMark';
import './brand-mark.css';

export function BrandMarkImg({ className, size }: { className?: string; size?: number }) {
  const cls = className ? `${className} ` : '';
  return (
    <>
      <img className={`${cls}neox-brandmark--light`} src={brandMarkUrl} alt="NeoX" width={size} height={size} decoding="sync" draggable={false} />
      <img className={`${cls}neox-brandmark--dark`} src={brandMarkWhiteUrl} alt="" aria-hidden width={size} height={size} decoding="sync" draggable={false} />
    </>
  );
}
