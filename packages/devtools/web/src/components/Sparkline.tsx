interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  /** 固定上限(如成功率 1.0);不传则用数据最大值自适应 */
  max?: number;
  /** 是否填充面积 */
  fill?: boolean;
}

/**
 * 极简 SVG 折线/面积图 —— 零依赖, 用于指标历史趋势。
 */
export function Sparkline({ data, width = 120, height = 32, color = 'var(--accent)', max, fill = true }: SparklineProps) {
  if (data.length < 2) {
    return <svg width={width} height={height} className="spark" />;
  }
  const lo = 0;
  const hi = max ?? Math.max(...data, 1e-9);
  const span = hi - lo || 1;
  const stepX = width / (data.length - 1);
  const y = (v: number) => height - ((v - lo) / span) * (height - 4) - 2;

  const pts = data.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`);
  const linePath = `M${pts.join(' L')}`;
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`;
  const gid = `g-${Math.abs(hashStr(color))}`;

  return (
    <svg width={width} height={height} className="spark" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={areaPath} fill={`url(#${gid})`} />}
      <path d={linePath} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={(data.length - 1) * stepX} cy={y(data[data.length - 1])} r="2" fill={color} />
    </svg>
  );
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}
