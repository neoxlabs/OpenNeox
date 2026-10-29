export function shouldShowActivityChildHead(o: {
  /** 当前是否展开 */
  expanded: boolean;
  /** 内容自带标题条 (Explore / explore-group) */
  contentOwnsChrome: boolean;
  /** 因为 running/waiting 被**自动**展开 */
  expandLive: boolean;
  /** 用户手动切过没有 (null = 没碰过) */
  userToggled: boolean | null;
  /** 行类型 —— cluster 的 body 是 N 个各自带头的卡片, 外层这行是总开关 */
  kind: string;
  soleThinkingChild?: boolean;
  soleRedundantChild?: boolean;
}): boolean {
  if (o.soleThinkingChild) return false;
  if (o.soleRedundantChild) return false;
  /* 只有"用户没碰过 + 自动展开"才谈得上藏: 那种展开跑完会自己收, 不需要折叠入口。 */
  const autoExpandedOnly = o.expandLive && o.userToggled === null;
  return !(
    o.expanded && o.contentOwnsChrome && autoExpandedOnly && o.kind !== 'cluster'
  );
}
