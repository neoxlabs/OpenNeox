import brandMarkUrl from '../../assets/brand/mark-ring.webp?inline';
import brandMarkWhiteUrl from '../../assets/brand/mark-ring-dark.webp?inline';

for (const src of [brandMarkUrl, brandMarkWhiteUrl]) {
  const warm = new Image();
  warm.decoding = 'async';
  warm.src = src;
  void warm.decode?.().catch(() => { /* 预热失败不影响 <img> 自己加载 */ });
}

export { brandMarkWhiteUrl };
export default brandMarkUrl;
