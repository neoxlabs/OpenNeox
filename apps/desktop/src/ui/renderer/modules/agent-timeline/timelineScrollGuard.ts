const TIMELINE_SCROLL_GUARD_KEY = "__neoxTimelineUserScrollGuardUntil";

type TimelineGuardWindow = Window & { [TIMELINE_SCROLL_GUARD_KEY]?: number };

export function getTimelineUserScrollGuardUntil(): number {
  if (typeof window === "undefined") return 0;
  return (window as TimelineGuardWindow)[TIMELINE_SCROLL_GUARD_KEY] ?? 0;
}

export function isTimelineUserScrollGuardActive(): boolean {
  return typeof performance !== "undefined" && performance.now() < getTimelineUserScrollGuardUntil();
}

export function setTimelineUserScrollGuardUntil(until: number): void {
  if (typeof window === "undefined") return;
  (window as TimelineGuardWindow)[TIMELINE_SCROLL_GUARD_KEY] = until;
}

/* ============================================================
 * Bottom-follow lease — 单一滚动主人协调.
 *
 * 流式贴底 (scroll controller) 与 行高锚点保持 (viewport window hook) 是两套会写
 * scrollTop 的系统, 方向相反 (贴底 vs 钉住可视锚点). 之前它们在流式期同时开火 →
 * 抖动. 这里用一个短租约做互斥: scroll controller 每次真的贴底就续租, viewport
 * hook 见租约有效就不再捕获/保持锚点 (贴底期本来就要到底, 锚点保持纯属对打).
 * 租约到期 (流式停 + 贴底停) 后, 锚点保持自动恢复, 供用户翻历史时用.
 * ============================================================ */
const TIMELINE_BOTTOM_FOLLOW_KEY = "__neoxTimelineBottomFollowUntil";

type TimelineFollowWindow = Window & { [TIMELINE_BOTTOM_FOLLOW_KEY]?: number };

export function isTimelineBottomFollowActive(): boolean {
  if (typeof window === "undefined" || typeof performance === "undefined") {
    return false;
  }
  return (
    performance.now() <
    ((window as TimelineFollowWindow)[TIMELINE_BOTTOM_FOLLOW_KEY] ?? 0)
  );
}

export function setTimelineBottomFollowUntil(until: number): void {
  if (typeof window === "undefined") return;
  (window as TimelineFollowWindow)[TIMELINE_BOTTOM_FOLLOW_KEY] = until;
}

/* ============================================================
 * Bottom-follow intent probe — 220ms 租约的补丁.
 *
 * 租约只在 scrollToBottom 真的执行时续期; 流式期 gap 因估高误差暂时 >40 时
 * follow tick 会跳过 → 租约断档 → viewport hook 捕获锚点 → 锚点保持和下一次
 * 贴底反向拉扯 (长会话虚拟化路径的抖动主源之一).
 * 这里让 scroll controller 注册一个"跟底意图"探针 (读实时 ref: 流式中 + 用户
 * 没离底), 意图在则锚点保持让位 —— 不依赖某一次贴底动作是否刚发生.
 * ============================================================ */
let bottomFollowIntentProbe: (() => boolean) | null = null;

export function setTimelineBottomFollowIntentProbe(
  probe: (() => boolean) | null
): void {
  bottomFollowIntentProbe = probe;
}

export function isTimelineBottomFollowIntentActive(): boolean {
  try {
    return bottomFollowIntentProbe?.() ?? false;
  } catch {
    return false;
  }
}
