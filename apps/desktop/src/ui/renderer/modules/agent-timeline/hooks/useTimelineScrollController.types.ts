import type { MutableRefObject } from "react";
import type { Row } from "../timelineRows";

export type ScrollBottomSource = "auto" | "user" | "new-message";

export interface UseTimelineScrollControllerArgs {
  rows: Row[];
  rowKeys: string[];
  rowHeightPrefix: number[];
  sessionId?: string | null;
  sessionStreaming?: boolean;
  scrollScope?: string;
  scrollerRef: MutableRefObject<HTMLElement | Window | null>;
  scrollerElRef: MutableRefObject<HTMLElement | null>;
  scrollingFlagRef: MutableRefObject<boolean>;
  commitViewportState: (
    nextViewport: { scrollTop: number; height: number },
    mode?: "scroll" | "resize" | "sync"
  ) => void;
  scheduleStableRowHeightSample: (reason: string, delay?: number) => void;
  /** 滚到顶时回捞更早历史; 返回本批 loaded 数与是否已到最早, 用于回捞后保持滚动锚点不跳. */
  onReachTop?: () => Promise<{ loaded: number; reachedStart: boolean }>;
  /**
   * TanStack Virtual 等库已用 getItemKey + anchorTo:end 处理 prepend 视口稳定时开启。
   * 开启后跳过自研 scrollHeight/prefix 双重补偿，避免和库抢 scrollTop。
   */
  libraryOwnsPrependAnchor?: boolean;
  libraryScrollToEnd?: (opts?: { behavior?: ScrollBehavior }) => void;
  /** 库的按 item 定位 — 见 revealBlockingAsk 里的用法。 */
  libraryScrollToIndex?: (
    index: number,
    opts?: { align?: 'start' | 'center' | 'end' | 'auto'; behavior?: ScrollBehavior },
  ) => void;
  /**
   * 立刻切换 TanStack 钉底。wheel 上滑必须同帧关掉 end-anchor，
   * 否则流式行高变化会把视口往下拽，表现为滑一下卡住。
   */
  librarySyncFollowBottom?: (follow: boolean) => void;
}

export interface UseTimelineScrollControllerResult {
  feedShellRef: MutableRefObject<HTMLDivElement | null>;
  scrollThumbElRef: MutableRefObject<HTMLSpanElement | null>;
  bottomSentinelRef: MutableRefObject<HTMLDivElement | null>;
  scrollToTop: (smooth: boolean) => void;
  forceScrollToBottom: (smooth: boolean, source?: ScrollBottomSource) => void;
  onScrollRailPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
}
