/** 用量页的 token 数字格式 —— 本地统计和订阅面板共用一份, 两处数字才对得上。 */
export const formatTokenCount = (count: number): string => {
  if (count >= 1000000) {
    const value = count / 1000000;
    const nearest = Math.round(value);
    if (nearest >= 1 && Math.abs(value - nearest) <= 0.11) return `${nearest}M`;
    const formatted = value >= 10 ? `${Math.round(value)}` : value.toFixed(1).replace(/\.0$/, '');
    return `${formatted}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return count.toString();
};
