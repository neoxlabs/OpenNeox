import { createContext, useContext } from 'react';
import type {
  Session,
  ModelInfo,
  Attachment,
  InteractionMode,
  DoubaoThinkingMode,
  StreamEvent,
} from '../../shared/ipc';
import type { TimelineEntry } from '../utils/workspaceUtils';

/** approval_needed 事件载荷 — 桥层转发后, NeoxRuntimeBridge owner 状态, TimelineComposer 渲染 banner.
 *  多个并行审批走队列, 这里暴露的是队首 (一次只渲染一条 banner). */
export type PendingApproval = Omit<
  Extract<StreamEvent, { type: 'approval_needed' }>,
  'type' | 'sessionId'
>;

/* ============================================================
 * NeoxRuntimeContext
 *   在 NeoxRuntimeBridge 内暴露给下层: timeline / sessions / compose actions.
 *   只暴露 agent-timeline 视图/左栏/composer/header 真正需要的字段,
 *   其它低层 store (useSessionState / useTimelineStore 等) 仍然可按需直接用.
 * ============================================================ */

export interface NeoxRuntimeContextValue {
  workspacePath: string;

  /* 会话 */
  sessions: Session[];
  /** 初次 getSessions IPC inflight 期间为 true, 第一次 setSessions 之后永远 false.
   *  Sidebar 用它区分"正在加载, 显示骨架"和"真的没有 sessions, 显示空状态". */
  sessionsLoading: boolean;
  activeSession: Session | null;
  createNewSession: (opts?: { kind?: 'chat' | 'image'; name?: string }) => Promise<Session | null>;
  selectSession: (id: string) => void;
  renameSession: (id: string, name: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  exportSession: (id: string, format?: 'md' | 'json') => Promise<void>;

  timelineEvents: TimelineEntry[];
  /** 滚到顶时按需回捞更早历史 — 内存上限外被切掉的老 entries 仍在 IndexedDB, prepend 回内存头部. */
  prependOlderTimelineEntries: (
    sessionId: string | null | undefined,
  ) => Promise<{ loaded: number; reachedStart: boolean }>;
  /** 抹掉一条 timeline 条目 —— 异常区的「关闭」用它 (异常态不落盘, 关掉就是彻底没了)。 */
  dismissTimelineEntry?: (sessionId: string, entryId: string) => void | Promise<void>;

  /* 运行态 */
  streaming: boolean;
  /* per-session 运行态 — 支持"切走的 session 也显示转圈". active session 的运行态
   * 通过 streaming 单值一次读到 (向后兼容); 后台 session 靠订阅这个 Set 独立感知. */
  runningSessionIds: ReadonlySet<string>;
  status: string;
  selectedModel: ModelInfo | null;
  availableModels: ModelInfo[];
  setSelectedModel: (model: ModelInfo) => void;
  /** 给某个会话定模型, 不用先切过去 (Pilot 分身各用各的模型) */
  setModelForSession: (sessionId: string, model: ModelInfo) => void;

  /* 模式 + thinking */
  mode: InteractionMode;
  setMode: (m: InteractionMode) => void;
  thinkingMode: DoubaoThinkingMode;
  setThinkingMode: (m: DoubaoThinkingMode) => void;
  effortLevel: string;
  effortByModel: Map<string, string>;
  setEffortForModel: (modelId: string, level: string) => void;

  /* 附件 */
  attachments: Attachment[];
  addAttachment: (a: Attachment) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;

  /* 动作 */
  /** opts.images: 排队消息被"中断并立即发送"时显式带的图片 (runtime 里已被清掉, 取不到) */
  sendPrompt: (
    prompt: string,
    opts?: { isRetry?: boolean; images?: Array<{ mediaType: string; data: string; name?: string }> },
  ) => Promise<void>;
  stopCurrent: () => Promise<void>;
  interruptCurrent: () => Promise<void>;
  retryLast: () => Promise<void>;
  /** 从上一轮断掉的那半截往下接着写 (不是重来一遍) —— 见 NeoxRuntimeBridge.continueLast。 */
  continueLast: () => Promise<void>;
  answerAskUser: (requestId: string, answers: Record<string, string>) => Promise<void>;

  /* 工具审批: per-session 队列, head 暴露给 banner.
   *   - dangerous 模式由桥层直接 reply, 不会有 pendingApproval
   *   - auto / manual 走 PermissionManager 决定 ASK/ALLOW, ASK 时 banner 显示
   *   - answerApproval 回 IPC + 出队 */
  pendingApproval: PendingApproval | null;
  answerApproval: (requestId: string, approved: boolean, remember: boolean) => Promise<void>;

  openFile: (absOrRelPath: string) => Promise<void>;
  compactActiveSession: () => Promise<void>;
  undoActiveSession: () => Promise<void>;
  checkpointActiveSession: (name?: string) => Promise<void>;
  rollbackActiveSession: (checkpointId: string) => Promise<void>;

  /* 运行子态 */
  paused: boolean;
  canRetry: boolean;
  lastError: { code?: string; message: string; suggestion?: string; raw?: string } | null;
  clearLastError: () => void;

  /* 上下文用量 (token 电池用) */
  contextUsed: number;
  totalTokens: number;


  /* 计时 */
  turnStartedAt: number | null;

  /* E-03 per-hunk Review state 持久化 — CodeSurfaceViewer 内点 ✓/✗ 时调.
   *   走 timelineStore.updateTimelineEntryById, 改 entry.editHunks[hunkIdx].review,
   *   自动 queueWrite 到 IndexedDB, 跨 mount/重启都还原.
   *   hunkIdx<0 时表示 entry 是顶层单 hunk (editStartLine/editNewString 路径), review 落 entry 顶层. */
  updateHunkReview?: (sessionId: string, entryId: string, hunkIdx: number, review: 'pending' | 'accepted' | 'rejected') => void;
}

export const NeoxRuntimeContext = createContext<NeoxRuntimeContextValue | null>(null);

export const useNeoxRuntime = (): NeoxRuntimeContextValue => {
  const ctx = useContext(NeoxRuntimeContext);
  if (!ctx) {
    throw new Error('useNeoxRuntime must be used within <NeoxRuntimeBridge>');
  }
  return ctx;
};

/** 允许软消费 — 演示/测试里没有 bridge 时拿到 null, 不抛. */
export const useNeoxRuntimeOptional = (): NeoxRuntimeContextValue | null => {
  return useContext(NeoxRuntimeContext);
};
