import React, { useMemo } from 'react';

/* 运行中文字扫光 —— 观感对齐旧配方, 实现改走合成器.
 *
 * 旧: background-clip:text + 动画 background-position。Chromium 每帧 RecalcStyle,
 * 再叠加输入环 @property 锥形渐变, UHD 630 上回合中渲染核 100%。
 *
 * 新: 底色字形 + 峰值色复制层。复制层用与旧配方同构的 400% 渐变做亮度遮罩
 * (0–37 透明 / 50 全黑 / 63–100 透明), transform 对向平移。每列像素
 * mix(base, peak, mask) ≡ 旧的 clip-text 渐变, 字母本身在变亮, 不是色块糊一层。
 * 周期 / 缓动 / 相位 (--atl-shimmer-phase, 滚动重挂接续) 都不动。 */

let shimmerDurMs = 0;

function shimmerPhaseStyle(): React.CSSProperties | undefined {
  if (typeof window === 'undefined') return undefined;
  if (!shimmerDurMs) {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--neox-shimmer-dur').trim();
    shimmerDurMs = raw.endsWith('ms') ? parseFloat(raw) : (parseFloat(raw) || 2.2) * 1000;
    if (!Number.isFinite(shimmerDurMs) || shimmerDurMs <= 0) shimmerDurMs = 2200;
  }
  return { ['--atl-shimmer-phase' as string]: `-${((performance.now() % shimmerDurMs) / 1000).toFixed(3)}s` };
}

/** 工具行动词按设计稿收短 (只改显示, title 悬停仍是原文) */
const SHORT_VERB: Record<string, string> = {
  执行命令: '运行', 运行命令: '运行', 读取文件: '读取', 写入文件: '新建', 编辑文件: '编辑', 修改文件: '编辑',
  搜索文件: '搜索', 搜索代码: '搜索', 浏览网页: '浏览', 打开网页: '浏览', 生成图片: '出图', 调用工具: '调用',
};

export const LiveShimmerText: React.FC<{
  text: string;
  live?: boolean;
  className?: string;
  title?: string;
}> = React.memo(({ text, live, className, title }) => {
  const phaseStyle = useMemo(() => (live ? shimmerPhaseStyle() : undefined), [live]);
  if (!live) {
    /* UI 3.0 工具行规范 (设计稿 v6): 「动词 · 对象」拆成两段 —— 动词墨色 13 中粗, 对象等宽 12 灰;
     * 长动词收成稿里的短词 (执行命令 → 运行)。没有 「 · 」的标题照原样。 */
    const cut = text.indexOf(' · ');
    if (cut > 0 && cut <= 8) {
      const verb = text.slice(0, cut);
      return (
        <span className={className} title={title}>
          <span className="atl-tt__verb">{SHORT_VERB[verb] ?? verb}</span>
          <span className="atl-tt__obj">{text.slice(cut + 3)}</span>
        </span>
      );
    }
    return <span className={className} title={title}>{text}</span>;
  }
  return (
    <span
      className={`nx-live-shimmer${className ? ` ${className}` : ''}`}
      title={title}
      style={phaseStyle}
    >
      <span className="nx-live-shimmer__base">{text}</span>
      <span className="nx-live-shimmer__peak" aria-hidden="true">
        <span className="nx-live-shimmer__shine">
          <span className="nx-live-shimmer__peak-text">{text}</span>
        </span>
      </span>
    </span>
  );
});
LiveShimmerText.displayName = 'LiveShimmerText';
