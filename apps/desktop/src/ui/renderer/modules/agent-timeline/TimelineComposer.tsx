import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useSurfaces, useActiveSurfaceId } from '../../state/surfaceStore';
import { IconPaperclip, IconSend, IconStop, IconRefresh, IconZap, IconTools, IconImage, IconFile, IconHome, IconCloud, IconPhone, IconCheck, IconChevronLeft, IconSearch } from '../shell/shellIcons';
import { restoreComposerDraft } from './restoreComposerDraft';
import { recentScopeOf, filterRecentByScope, type RecentFileEntry } from './recentFilesScope';
import { displayWorkspacePath } from '../../utils/pathUtils';
/* 登录态 / 会员 / 额度 / 云端运行走发行版能力钩子与插槽 —— 公开构建里恒为未登录、无会员 */
import {
  getEditionHook, useEditionAuth as useAuth, useEditionMembership as useMembership,
  useEditionMembershipStatus as useMembershipStatus, useCloudAgentAvailable, useQuotaBannerVisible,
  useEditionPlatformModels,
  type EntitledModelInfo,
} from '../shell/editionHooks';
import { UiSlot } from '../shell/uiSlots';
import { IntentChipBar, INTENT_CHIPS, decorateMessageWithIntents } from './IntentChipBar';
import { directGenerateImageStream, emitDirectImageTurn } from '../../services/imageDirectClient';
import { getImageParamValues, buildRequestParams, useImageParamValues, setImageParam } from '../../state/imageGenParams';
import { trackImage } from '../../services/imageTelemetry';
import { saveImageTemplate } from '../../state/imageTemplates';
import { ImageParamsButton } from '../image-studio/ImageParamsBar';
import { ImageToImageBar } from '../image-studio/ImageToImageBar';
import { TargetInlineBanner } from './TargetInlineBanner';
import { useSubAgents } from '../../state/subAgentsStore';
import { classifyError, describeKind, type ErrorKind } from './errorPill.js';
import { isByokPinned, getByokHiddenModels, useByokPickerPrefsVersion } from '../../state/byokPickerPrefs';
import { useNeoxRuntime, type PendingApproval } from '../../app/NeoxRuntimeContext';
import { NEOX_CLOUD_PAYG_PROVIDER_ID, NEOX_CLOUD_PROVIDER_ID, isNeoxCloudProviderId } from '../../../shared/neoxCloud';
import type { Attachment, ModelInfo, InteractionMode } from '../../../shared/ipc';
import { homeDraftKey, isHomeDraftKey, stashComposerDraft, swapComposerDraft } from './composerSessionDrafts';
import { useService } from '../../platform/useService.js';
import { EDITOR_SERVICE } from '../../../../ide/index.js';
import ContextDetailPopup, { type ContextCompactControl } from '../status/components/ContextDetailPopup';
import { getContextSnapshot, useContextSnapshot } from '../../state/contextSnapshot';
import { useApprovalMode, setApprovalMode, type ApprovalMode } from './approvalModeStore';
import { useChatMode } from '../../app/chatModeStore';
import { useComposerStylePreference } from './timelinePreferences';
import { ProviderBrandIcon, inferProviderBrand, isAutoRoutedModelName } from './ProviderBrandIcon'; import { paygPromoRatio, renderPaygPromoTag } from './paygPromo';
import { ApprovalProvenanceLine } from './ApprovalProvenanceLine';
import { parseDocument, isParseableDocument } from '../../services/documentParseClient';
import { openSurfaceFromPath } from '../../state/openSurfaceFromPath';
import { startVoiceStream, type VoiceStream } from '../../utils/voiceStream';
import { ComposerMicWave } from './ComposerMicWave';
import { dispatchOpFailed, dispatchOpFailedFromError, dispatchHint } from '../../components/notifyEvents';
import { confirmAsync } from '../../components/confirmEvents';
import { LiveStatusLine, ImageThumb, ContextPill, formatCompactTokens } from './ComposerStatusPills';
import { FileTypeIcon } from '../../components/FileTypeIcon';
import { ConductorChip, CONDUCTOR_OPEN_EVENT, readSavedConductor } from './ConductorChip';
import { LiveShimmerText } from './components/LiveShimmerText';

/** /target <goal> 发出去后, 等这么久再查它到底进没进目标模式。
 *  激活是模型在对话里调 activate_target 完成的, 查太早会把"还没轮到"误报成"没进去"。 */
const TARGET_ACTIVATION_GRACE_MS = 120_000;
const TARGET_INTENT_RE =
  /(^|\s)\/target(\s|$)|[设开启建]{1,2}[^。，,.\n]{0,6}target|target\s*模式|长期(目标|跑|运行)|长跑模式|持续.{0,4}跑(到|直到)|一直(干|做)(到|下去)?|一直跑(到|下去)|(围绕|按).{0,6}目标.{0,4}(一直|持续|反复)|[设定置]{1,2}[^。，,.\n]{0,4}目标/;
import type { TimelineEntry } from '../../utils/workspaceUtils';
import TurnAnomalyDock from './TurnAnomalyDock';
import { shouldCollapsePaste, pasteToken, expandPastes, prunePastes } from './pastedText';

/** 稳定空引用 —— 没有异常时不因为新数组身份触发 dock 重渲染。 */
const EMPTY_ANOMALIES: TimelineEntry[] = [];
import { isBackendWaitingStatus } from './timelinePresentation';
import { getPanelLayout } from '../../state/panelLayoutStore';
import {
  unwrapApprovalTool, splitApprovalArg, approvalSteps,
  APPROVAL_REASON_ZH, APPROVAL_ACTION_ZH,
} from './approvalPresentation';
import { useI18n, getGlobalLanguage } from '../../hooks/useI18n';
import { useStableCallback } from '../../hooks/useStableCallback';
import { useSessionModeGlow } from './useSessionModeGlow';
import { useSessionMessageQueue } from './useSessionMessageQueue';
import type { EffortLevel, SchemaEffortInfo } from './thinkLevels';
import { ThinkChip, ThinkMenuSection, thinkChipVisible } from './ThinkLevel';
import { ContextModeBadge, RequestModeDialog, useContextProfile } from './ContextModeSection';
import { ChoiceDialog } from './ChoiceDialog';
import { McpDialog, RunDestDialog } from './ComposerSurfaceDialogs';
import { VoiceSetupDialog } from './VoiceSetupDialog';
import { voiceReadiness } from './voiceReadiness';
import { OutputStyleDialog, outputStyleLabel, useOutputStyle } from './OutputStyleSection';
import { NeoxIllus } from '../../media/illus';
import { useJevDraftPrefetch } from './useJevDraftPrefetch';
import { markTargetIntent, clearTargetIntent } from './targetIndicatorStore';
import { subscribeStreamingTokensHud, useStreamingTokensHud } from '../../state/streamingHudStore';
import { useTimelineFeed } from '../../state/timelineFeedStore';
import { useAgentModeVariant, isDefaultSessionName } from '../../hooks/useAgentModeVariant';
import { friendlyOpError } from '../../components/notifyEvents';

// Multiple mounted composers must not restore the same returned message twice.
const restoredMessageEvents = new WeakSet<Event>();

interface Props {
  placeholder?: string;
  onSubmit?: (prompt: string) => void;
  /** 运行中插话: 提供则 streaming 时允许打字+Enter 排队下一条 (走 inject); 不提供则保持旧行为 (禁用). */
  /** opts.when='turn-end' = 回车一次的默认: 引擎等这一轮全部结束再接着跑它 (不出气泡、不转向)。
   *  不传 = 下一步就插 (语音等直发路径)。 */
  onInject?: (prompt: string, images?: Array<{ mediaType: string; data: string; name?: string }>, opts?: { when?: 'turn-end' }) => void;
  /** 硬插 (第二次回车 / 药丸「立即插入」): 这些已在引擎排着的消息现在就插进去 —— 出气泡 + 转向。 */
  onSteer?: (items: Array<{ text: string; images?: Array<{ mediaType: string; data: string; name?: string }> }>) => void;
  /** 取消一条排队消息 —— 从 server 队列摘掉**这一条**, 返回摘到的文本 (没摘到返回 null)。
   *  返回值很重要: 摘不到说明引擎已经把它消费了, 这时候绝不能再退回输入框, 否则
   *  对话里有一条、输入框里还有一条 = 同一句话出现两次。 */
  onCancelQueued?: (text: string) => Promise<string | null> | void;
  /** 中断当前轮 + 立即发送这条排队消息 (不等本轮结束) */
  /** 当前这一轮的异常态 (错误卡 /「已停止」) —— 渲染在输入框正上方, 不进 timeline。
   *  判据和缘由见 turnAnomaly.ts; 放这儿是为了跟输入框宽度/边界天然对齐。 */
  anomalies?: TimelineEntry[];
  /** 关掉某一条异常提示 (异常态不落盘, 关掉即彻底消失)。 */
  onDismissAnomaly?: (entryId: string) => void;
  /** 重跑这一轮 —— 异常行上的「重试」和可恢复故障的自动重试都走它。 */
  onRetryAnomaly?: () => void;
  /** 从断掉的那半截往下接着写 —— 有断点时它才是主动作 (见 TurnAnomalyDock)。 */
  onContinueAnomaly?: () => void;
  /** 这一轮有没有断点可续 (本轮已经落下过助手正文)。 */
  canContinueAnomaly?: boolean;
  /* compact: IDE 右栏窄宽场景, 把附件 + 审批模式塞进"⋯"overflow popover, 释放工具栏宽度.
   * 默认 false (Agent 主面板宽足够, 不需要折叠). */
  compact?: boolean;
  /** session 在云端跑时, 本地 composer 不能发送 — read-only + 显式提示去 mobile 操作或拉回. */
  cloudReadonly?: boolean;
  defaultIntentIds?: string[];
  /** placeholder 覆盖用. ImageStudioPage 传 "描述你想要的图片…" 覆盖默认聊天提示. */
  placeholderOverride?: string;
  /** 空会话首页 (UI 3.0): 简约输入框恒为卡片 + 模型芯片带名字; 对话里仍是省地方的胶囊。 */
  heroCard?: boolean;
  /** Includes programmatic draft restoration and clearing, not just input events. */
  onDraftPresenceChange?: (hasText: boolean) => void;
  flat?: boolean;
  inlineSlot?: React.ReactNode;
}

import { isImageModelInfo, isChatModelInfo } from '../../utils/modelKind';
import { normalizeImageDataUrl, unsupportedImageMessage } from '../../utils/normalizeImage';
import { Lightbox } from './cells/attachments';


/* 单文件阈值分两档:
 *   · 图片 (截图/PNG/JPG): 10MB — 1920×1080 PNG 普遍 2-5MB, 之前 500KB 上限实际把 99% 截图全拦掉
 *   · 文本/代码/其他: 500KB — 防止大日志/二进制误识为文本 + 防爆内存
 * 不再 UI 层硬截总数 — 上游 LLM 自己有上下文窗口管理, 在这里设 10 张顶头反而堵流水线. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 500 * 1024;
/* 文档 (PDF/Word/Excel/CSV/PPT) 上传上限 — 跟 NeoxCloud /document/parse 的
 * MAX_UPLOAD_BYTES (50MB) 保持一致. 服务端会再次校验. */
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_HISTORY = 30;
const TEXT_MIME_HINT = /^(text\/|application\/(json|xml|yaml|javascript|typescript))/;
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|md|txt|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|sh|sql|html|css|scss|less|vue|svelte|toml|ini|cfg|env|gitignore|dockerfile)$/i;

/* 粘贴大段文本自动转附件的阈值 */
const PASTE_LINE_THRESHOLD = 12;
const PASTE_CHAR_THRESHOLD = 800;
/* "最近使用文件" 本地缓存 key */
const RECENT_FILES_KEY = 'neox:composer:recentFiles';
/** 右侧面板看代码时输入框自动挂的「当前文件」附件 id —— 固定一个, 换文件走 upsert 替换 */
const ACTIVE_FILE_ATT_ID = 'ctx:active-file';

function pathOfFile(file: File): string | undefined {
  try {
    return (window as unknown as { neox?: { getPathForFile?: (f: File) => string | null } }).neox?.getPathForFile?.(file) || undefined;
  } catch {
    return undefined;
  }
}
const RECENT_FILES_MAX = 10;
const COMPOSER_OVERLAY_MARGIN = 8;
const COMPOSER_POPOVER_Z = 100000;
const COMPOSER_FLYOUT_Z = 100010;
/* 模型菜单的内边距 (跟 CSS --nx-menu-pad 的默认值对齐) — 量内容高时要把它加回去 */
const MODEL_MENU_PAD = 5;
const COMPOSER_TOOLTIP_Z = 100020;
/* 粗略 token 估算: 英文 ~4 chars/token, CJK ~1 char/token 的加权平均 */
const estimateTokens = (s: string): number => {
  if (!s) return 0;
  let cjk = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x3000 && c <= 0x9fff) cjk++;
  }
  const other = s.length - cjk;
  return Math.ceil(cjk + other / 4);
};

type ComposerOverlayPlacement = 'top-start' | 'top-end' | 'right-start';

interface ComposerOverlayStyleOptions {
  anchor: DOMRect;
  width: number;
  estimatedHeight: number;
  placement: ComposerOverlayPlacement;
  gap?: number;
  margin?: number;
  zIndex?: number;
  applyWidth?: boolean;
  preferBelow?: boolean;
  constrainHeight?: boolean;
}

const clampNumber = (value: number, min: number, max: number): number => {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
};

function getComposerOverlayStyle({
  anchor,
  width,
  estimatedHeight,
  placement,
  gap = 6,
  margin = COMPOSER_OVERLAY_MARGIN,
  zIndex = COMPOSER_POPOVER_Z,
  applyWidth = true,
  preferBelow = false,
  constrainHeight = false,
}: ComposerOverlayStyleOptions): React.CSSProperties {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const viewportMaxHeight = Math.max(80, viewportHeight - margin * 2);
  const naturalHeight = Math.min(estimatedHeight, viewportMaxHeight);
  const maxLeft = Math.max(margin, viewportWidth - width - margin);

  if (placement === 'right-start') {
    const rightLeft = anchor.right + gap;
    const canFitRight = rightLeft + width + margin <= viewportWidth;
    const left = canFitRight
      ? rightLeft
      : clampNumber(anchor.left - width - gap, margin, maxLeft);
    const height = constrainHeight ? naturalHeight : estimatedHeight;
    const maxTop = Math.max(margin, viewportHeight - height - margin);
    const top = clampNumber(anchor.top, margin, maxTop);
    return {
      position: 'fixed',
      left,
      top,
      right: 'auto',
      bottom: 'auto',
      ...(applyWidth ? { width } : {}),
      ...(constrainHeight ? { maxHeight: height } : {}),
      zIndex,
    };
  }

  const rawLeft = placement === 'top-end' ? anchor.right - width : anchor.left;
  const left = clampNumber(rawLeft, margin, maxLeft);
  const spaceAbove = Math.max(0, anchor.top - margin - gap);
  const spaceBelow = Math.max(0, viewportHeight - anchor.bottom - margin - gap);
  const fitsAbove = spaceAbove >= naturalHeight;
  const fitsBelow = spaceBelow >= naturalHeight;
  const placeAbove = preferBelow
    ? !fitsBelow && (fitsAbove || spaceAbove > spaceBelow)
    : fitsAbove || (!fitsBelow && spaceAbove >= spaceBelow);
  const availableHeight = placeAbove ? spaceAbove : spaceBelow;
  const height = constrainHeight
    ? Math.min(naturalHeight, Math.max(80, availableHeight))
    : estimatedHeight;
  const maxTop = Math.max(margin, viewportHeight - height - margin);
  const rawTop = placeAbove
    ? anchor.top - gap - height
    : anchor.bottom + gap;
  const top = clampNumber(rawTop, margin, maxTop);
  return {
    position: 'fixed',
    left,
    top,
    right: 'auto',
    bottom: 'auto',
    ...(applyWidth ? { width } : {}),
    ...(constrainHeight ? { maxHeight: height } : {}),
    zIndex,
  };
}

type ComposerRunPhase =
  | 'speaking'
  | 'waiting_output'
  | 'tool'
  | 'subagent'
  | 'approval'
  | 'settling';

interface ComposerRunActivity {
  phase: ComposerRunPhase;
  label: string;
  placeholderLead: string;
}

const TOKEN_IDLE_WAITING_MS = 2500;

const MESSAGE_ENTRY_TYPES = new Set(['assistant_message', 'agent_message', 'assistant_prefix']);
const SUBAGENT_ENTRY_TYPES = new Set(['agent_delegation', 'explore_status', 'worker_status', 'dag_execution']);

/* 以下 6 个是「输入框运行态推断」的纯逻辑, 导出仅为可测
 * (见 __tests__/composerRunActivity.test.ts)。判错一次 = 用户感知卡死 / 发不出消息。 */
/**
 * 输入框上方那颗错误药丸.
 *
 * 只报**持续性的、挡住你下一步**的状态 (登录失效 / 额度用尽), 一次只报最要紧
 * 的那一条 —— 同时报三个错等于什么都没报。一次性的请求失败由 timeline 里的
 * 错误卡承担, 不往这儿挤。
 */
/** 药丸被「知道了」关掉的记号。只活一次启动 —— 换了档位/重启该再说一次。 */
const QUOTA_PILL_SS_KEY = 'neox.quotaPill.dismissed';

const ComposerErrorPill: React.FC<{ isZh: boolean }> = ({ isZh }) => {
  const { isAuthenticated } = useAuth();
  const membership = useMembership();
  const status = useMembershipStatus();
  const bannerVisible = useQuotaBannerVisible();
  /* 「一直杵在那儿很烦人」—— 额度这条是持续状态, 但持续不等于要一直喊。
   * 关掉记在 sessionStorage: 这一次启动内不再说, 重启或换了档位再说一次。 */
  const [pillDismissed, setPillDismissed] = React.useState(
    () => { try { return sessionStorage.getItem(QUOTA_PILL_SS_KEY) === '1'; } catch { return false; } },
  );

  let kind: ErrorKind | null = null;
  if (isAuthenticated && status.stale && status.lastError) {
    const k = classifyError({ code: status.lastError });
    /* 只有认证类值得常驻提示 —— 服务器/网络抖动会自愈, 常驻反而吵 */
    if (k === 'auth') kind = k;
  }
  /* exhausted 是**窗口**上的字段, 不在 usage 根上。而且"哪些窗口生效"必须走
   * activeUsageWindows —— 直接点 fiveHour/weekly 是 quotaWindowsSingleSource
   * 那道闸明令禁止的 (月额度套餐会被判成"没有限额")。 */
  void membership;
  void bannerVisible; void pillDismissed; void setPillDismissed;
  if (!kind) return null;

  const spec = describeKind(kind, isZh);
  const onAct = () => {
    if (kind === 'auth') {
      window.dispatchEvent(new CustomEvent('neox:login-required', { detail: { from: 'composer-pill' } }));
      return;
    }
  };

  return (
    <div className={`atl-composer__pill atl-composer__pill--${spec.blocking ? 'block' : 'warn'}`} role="status">
      <span className="atl-composer__pill-dot" aria-hidden />
      <span className="atl-composer__pill-text">{spec.label}</span>
      {spec.action && (
        <button type="button" className="atl-composer__pill-act" onClick={onAct}>
          {spec.action}
        </button>
      )}
    </div>
  );
};


export function currentTurnEntries(entries: TimelineEntry[]): TimelineEntry[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    // Insertion stays inside the running turn; do not hide its active tools.
    if (entry?.type === 'user_message'
      && !String(entry.id ?? '').startsWith('msg-injected-')
      && (entry as any).messageSource !== 'system-background-task') return entries.slice(i);
  }
  return entries;
}

export function hasActiveApproval(entries: TimelineEntry[], pendingApproval: PendingApproval | null): boolean {
  if (pendingApproval) return true;
  return entries.some((entry) =>
    entry.awaitingApproval === true ||
    (entry.type === 'ask_user' && entry.askUserStatus === 'waiting')
  );
}

export function hasActiveSubagent(entries: TimelineEntry[]): boolean {
  return entries.some((entry) => {
    if (!SUBAGENT_ENTRY_TYPES.has(entry.type)) return false;
    if (entry.delegationStatus === 'running' && !entry.delegationIsBackground) return true;
    if (entry.exploreStatus === 'running') return true;
    if (entry.workerStatus === 'running') return true;
    if (entry.dagNodes?.some((node) => node.status === 'running' || node.status === 'pending')) return true;
    if (entry.exploreGroupMembers?.some((member) => member.status === 'running')) return true;
    if (entry.exploreToolRecords?.some((record) => record.status === 'running')) return true;
    if (entry.delegationToolRecords?.some((record) => record.status === 'running')) return true;
    return false;
  });
}

export function hasActiveTool(entries: TimelineEntry[]): boolean {
  return entries.some((entry) => {
    if (MESSAGE_ENTRY_TYPES.has(entry.type)) return false;
    if (entry.type === 'ask_user') return entry.askUserStatus === 'waiting';
    if (entry.commandStatus === 'running') return true;
    if (entry.editStreaming === true) return true;
    if (entry.streaming === true && (entry.type === 'tool_call' || entry.type === 'file_stream' || entry.type === 'edit_file')) return true;
    if (entry.pending === true && entry.type !== 'user_message') return true;
    if (entry.compactionStatus === 'started') return true;
    return false;
  });
}

export function hasPendingAssistantText(entries: TimelineEntry[]): boolean {
  return entries.some((entry) => MESSAGE_ENTRY_TYPES.has(entry.type) && entry.pending === true);
}

export function inferComposerRunActivity(
  timelineEvents: TimelineEntry[],
  pendingApproval: PendingApproval | null,
  status: string | undefined,
  tokenIdleMs: number,
  isZh: boolean,
  streaming: boolean,
): ComposerRunActivity {
  const turn = currentTurnEntries(timelineEvents);
  if (hasActiveApproval(turn, pendingApproval)) {
    return { phase: 'approval', label: isZh ? '等待确认' : 'Waiting for confirmation', placeholderLead: isZh ? '等待你确认工具请求' : 'Waiting for your tool confirmation' };
  }
  if (turn.some((entry) => entry.type === 'context_compaction'
    && (entry.compactionStatus === 'started' || entry.compactionStatus === 'compressing'))) {
    return { phase: 'tool', label: isZh ? '压缩上下文中' : 'Compacting context', placeholderLead: isZh ? '正在压缩上下文' : 'Compacting context' };
  }
  if (hasActiveSubagent(turn)) {
    return { phase: 'subagent', label: isZh ? '子任务执行中' : 'Sub-task running', placeholderLead: isZh ? '子任务执行中' : 'Sub-task running' };
  }
  if (hasActiveTool(turn)) {
    return { phase: 'tool', label: isZh ? '工具执行中' : 'Tool running', placeholderLead: isZh ? '工具执行中' : 'Tool running' };
  }

  const assistantPending = hasPendingAssistantText(turn);
  const waitingStatus = isBackendWaitingStatus(status);
  if (assistantPending && !waitingStatus && tokenIdleMs < TOKEN_IDLE_WAITING_MS) {
    return { phase: 'speaking', label: isZh ? '回复中' : 'Replying', placeholderLead: isZh ? 'Neox 正在回复' : 'Neox is replying' };
  }
  if (assistantPending || waitingStatus) {
    return { phase: 'waiting_output', label: isZh ? '等待下一步' : 'Waiting for next step', placeholderLead: isZh ? '等待下一步输出' : 'Waiting for next output' };
  }
  if (!turn.some((entry) => entry.type !== 'user_message')) {
    return { phase: 'waiting_output', label: isZh ? '思考中' : 'Thinking', placeholderLead: isZh ? 'Agent 正在思考' : 'Agent is thinking' };
  }
  if (streaming) {
    return { phase: 'waiting_output', label: isZh ? '等待模型响应' : 'Waiting for model', placeholderLead: isZh ? '等待模型返回下一步' : 'Waiting for the model' };
  }
  return { phase: 'settling', label: isZh ? '等待收尾' : 'Wrapping up', placeholderLead: isZh ? '等待回合收尾' : 'Waiting for turn to finish' };
}

/**
 * 取消一条排队消息之后, 本地队列与输入框各自该变成什么。
 *
 *   抽成纯函数是为了能测 —— 这段逻辑原本内联在 JSX 的 onClick 里, 而它有两个
 *   一旦写错就直接被用户看见的分支:
 *
 *     · removed 有值 = 真从服务端队列摘下来了 → 必须退回输入框, 否则用户点了"取消"
 *       内容就凭空消失 (这就是 3.22.0 上报的那个 bug)。
 *     · removed 为空 = 引擎已经消费了它, 这条稍后会出现在对话里 → **不能**退回,
 *       退回就是同一句话发两遍。
 *
 *   本地一律摘**最后一条**, 因为服务端只有 dequeue-last 一种能力。按点击的 index
 *   删会让两边队列错位。
 */
export function resolveQueuedCancel<T>(
  queued: T[],
  /* 入参要含 void —— onCancelQueued 的类型是 `Promise<string|null> | void` (它是可选回调,
   * 调用方也允许只做副作用不返值), await 之后就是 string | void | null | undefined。
   * 这里收窄成 string|null|undefined 会让调用点编译不过。 */
  removed: string | void | null | undefined,
  currentValue: string,
): { nextQueued: T[]; nextValue: string; restored: boolean } {
  const nextQueued = queued.slice(0, -1);
  if (removed === null || removed === undefined || removed === '') {
    return { nextQueued, nextValue: currentValue, restored: false };
  }
  const nextValue = currentValue.trim() ? `${currentValue}\n${removed}` : removed;
  return { nextQueued, nextValue, restored: true };
}

export function buildStreamingPlaceholder(activity: ComposerRunActivity, canQueue: boolean, isZh: boolean): string {
  return canQueue
    ? (isZh ? '补充消息…' : 'Add a message…')
    : activity.placeholderLead;
}

const isImage = (f: File) => f.type.startsWith('image/');
const isLikelyText = (f: File) =>
  TEXT_MIME_HINT.test(f.type) || (!f.type && TEXT_EXT.test(f.name));

const readAsDataURL = (file: File): Promise<string> =>
  new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result ?? ''));
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(file);
  });
const readAsText = (file: File): Promise<string> =>
  new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result ?? ''));
    fr.onerror = () => rej(fr.error);
    fr.readAsText(file);
  });

const makeId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

interface FileSuggestion {
  name: string;
  path: string;
  isDirectory: boolean;
}

/* @ 补全条目 · 覆盖 file / folder / recent 三种 */
type AtItem = {
  kind: 'file' | 'folder' | 'recent' | 'git' | 'codebase' | 'computer' | 'browser';
  name: string;
  path: string;
  description?: string;
};

/** @ 菜单顶部的上下文芯片（对齐 Cursor @git / @codebase 最小集） */
function buildContextAtItems(query: string, isZh: boolean): AtItem[] {
  const q = query.trim().toLowerCase();
  const all: AtItem[] = [
    {
      kind: 'git',
      name: '@git',
      path: '@git',
      description: isZh ? '当前分支与变更文件' : 'Branch + changed files',
    },
    {
      kind: 'codebase',
      name: '@codebase',
      path: '@codebase',
      description: isZh ? '工作区顶层结构摘要' : 'Workspace top-level map',
    },
    /* @Computer / @Browser (对齐 Codex 的 @Computer): 选中 = 这条消息要直接
     * 操作桌面 / 浏览器, 不要先问。Windows 与 mac 都有 OS 桥, 两台都显示。 */
    {
      kind: 'browser',
      name: '@browser',
      path: '@browser',
      description: isZh ? '直接操作浏览器完成这条' : 'Do this by driving the browser',
    },
    {
      kind: 'computer' as const,
      name: '@computer',
      path: '@computer',
      description: isZh ? '直接操作桌面应用完成这条' : 'Do this by driving desktop apps',
    },
  ];
  if (!q) return all;
  return all.filter((it) =>
    it.name.toLowerCase().includes(q)
    || it.kind.includes(q)
    || (it.description?.toLowerCase().includes(q) ?? false),
  );
}

/** @computer / @browser 的附件: 一句给模型的硬指令, 跟 @git 走同一条附件通道 */
function isBlockingOverlayOpen(): boolean {
  return Array.from(
    document.querySelectorAll('[role="dialog"], [role="menu"], .neox-modal, .neox-drawer, .nx-confirm'),
  ).some((node) => {
    const rect = (node as HTMLElement).getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const cs = getComputedStyle(node as HTMLElement);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.01;
  });
}

function buildDriveContextAttachment(kind: 'computer' | 'browser', isZh: boolean): Attachment {
  const data = kind === 'computer'
    ? (isZh
      ? '# @computer\n用户点了 @computer: 这条消息要用 computer_snapshot 看、computer_run 做, 直接操作桌面应用。有编号就按编号, 没有 (axBlind) 就看附带截图用 click_at 按比例点。不要先问用户要不要, 也不要改用命令行或某个软件的 MCP 绕过; 做完把看到的结果说出来。'
      : '# @computer\nThe user tagged @computer: fulfil this message by driving desktop apps — snapshot then computer_run. Use numbered elements when present; if axBlind, look at the screenshot and click_at by ratio. Do not ask first and do not fall back to shell or an app MCP; report what you saw at the end.')
    : (isZh
      ? '# @browser\n用户点了 @browser: 这条消息要用 browser_run 直接操作浏览器完成 (navigate 看一眼 → 一条脚本做完并以 expect 收尾), 不要先问用户要不要; 做完把页面上的结果说出来。'
      : '# @browser\nThe user tagged @browser: fulfil this message by driving the browser with browser_run (navigate to look → one script that finishes and ends with expect). Do not ask first; report the on-page result at the end.');
  return {
    id: makeId(`ctx-${kind}`),
    type: 'file',
    name: `@${kind}`,
    path: `@${kind}`,
    data,
    language: 'markdown',
    preview: data.slice(0, 200),
    status: 'parsed',
  };
}

async function fetchGitContextAttachment(workspacePath: string): Promise<Attachment | null> {
  const api = (window as any).neox;
  if (typeof api?.gitStatus !== 'function') return null;
  try {
    const st = await api.gitStatus(workspacePath);
    const files: Array<{ path: string; area?: string; indexStatus?: string; worktreeStatus?: string }> =
      Array.isArray(st?.files) ? st.files : [];
    const lines: string[] = [
      `# @git context`,
      `branch: ${st?.branch || '(unknown)'}`,
      `ahead: ${st?.ahead ?? 0}  behind: ${st?.behind ?? 0}`,
      `changed: ${files.length}`,
      '',
    ];
    if (files.length === 0) {
      lines.push('(clean working tree)');
    } else {
      lines.push('files:');
      for (const f of files.slice(0, 100)) {
        const mark = `${f.indexStatus || ' '}${f.worktreeStatus || ' '}`.trim() || '?';
        lines.push(`- [${f.area || 'worktree'} ${mark}] ${f.path}`);
      }
      if (files.length > 100) lines.push(`… +${files.length - 100} more`);
    }
    lines.push('', 'Use git_* / execute_shell for diffs; prefer these paths when editing.');
    const data = lines.join('\n').slice(0, 12_000);
    return {
      id: makeId('ctx-git'),
      type: 'file',
      name: '@git',
      path: '@git',
      data,
      language: 'markdown',
      preview: data.slice(0, 200),
      status: 'parsed',
    };
  } catch {
    return null;
  }
}

async function fetchCodebaseContextAttachment(workspacePath: string): Promise<Attachment | null> {
  const api = (window as any).neox;
  if (typeof api?.listFiles !== 'function') return null;
  try {
    const res = await api.listFiles(workspacePath);
    const entries: Array<{ name: string; path: string; isDirectory?: boolean }> = res?.files ?? [];
    const lines: string[] = [
      `# @codebase context`,
      `root: ${workspacePath}`,
      '',
      'top-level:',
    ];
    const dirs = entries.filter((e) => e.isDirectory).slice(0, 40);
    const files = entries.filter((e) => !e.isDirectory).slice(0, 40);
    for (const d of dirs) lines.push(`  ${d.name}/`);
    for (const f of files) lines.push(`  ${f.name}`);
    if (entries.length === 0) lines.push('  (empty)');

    /* 再扫一层常见源码根, 帮模型少瞎 glob */
    const peekDirs = ['src', 'packages', 'app', 'apps', 'lib', 'services']
      .filter((n) => dirs.some((d) => d.name === n))
      .slice(0, 3);
    for (const name of peekDirs) {
      const child = entries.find((e) => e.name === name && e.isDirectory);
      if (!child?.path) continue;
      try {
        const nested = await api.listFiles(child.path);
        const kids: Array<{ name: string; isDirectory?: boolean }> = nested?.files ?? [];
        lines.push('', `${name}/:`);
        for (const k of kids.slice(0, 30)) {
          lines.push(`  ${k.name}${k.isDirectory ? '/' : ''}`);
        }
        if (kids.length > 30) lines.push(`  … +${kids.length - 30} more`);
      } catch { /* ignore */ }
    }
    lines.push('', 'Prefer search/readfile on these paths before broad recursive scans.');
    const data = lines.join('\n').slice(0, 10_000);
    return {
      id: makeId('ctx-codebase'),
      type: 'file',
      name: '@codebase',
      path: '@codebase',
      data,
      language: 'markdown',
      preview: data.slice(0, 200),
      status: 'parsed',
    };
  } catch {
    return null;
  }
}


async function confirmAndClearSession(sid: string, isZh: boolean): Promise<void> {
  const ok = await confirmAsync({
    title: isZh ? '清空对话' : 'Clear conversation',
    variant: 'danger',
    message: isZh
      ? '模型会忘掉这段对话，磁盘上的消息记录也会删除 —— 屏幕上的内容要到下次启动才消失。不可撤销。'
      : 'The model forgets this conversation and the stored messages are deleted — what is on screen goes away at next launch. This cannot be undone.',
    confirmLabel: isZh ? '清空' : 'Clear',
  });
  if (!ok) return;
  try {
    await (window as any).neox.clearSession(sid);
  } catch (e) {
    dispatchOpFailedFromError(isZh ? '清空对话' : 'Clear conversation', e);
  }
}

/* / 补全条目 · skills + 内置命令 (Target Mission / Compact / Clear) */
type SlashItem = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  /** true = 内置命令 (不是 skill), 走 builtinAction 或 fillPrefix, 不走 @skill: 引用. */
  builtin?: boolean;
  /** 无参数直接触发的 action:
   *    compact → window.neox.compactSession(sid)
   *    clear   → window.neox.clearSession(sid)  */
  builtinAction?: 'compact' | 'clear';
  /** 有参数命令的前缀 (含斜杠+空格), 用于 fill 到 input 等用户补全参数. 例: "/target " */
  fillPrefix?: string;
};

/* 内置命令 — 桌面端 skill 列表里 merge 进这批, 让用户能从 popover 里发现常用命令.
 * 选中后:
 *   有 builtinAction (compact / clear) → 直接调 window.neox API
 *   有 fillPrefix (target 系列)         → fill 前缀到 input 等用户补参数
 * 手动敲 /compact 或 /clear + Enter 时 submit 里的 handleBuiltinCommand 也会拦截.
 * /target 系列敲上去 = 普通 chat + LLM 自主 activate_target 工具处理. */
/** `/` 面板一次最多列几条。弹层本身 max-height + overflow-y 已能滚, 这里只是别一次灌太多。 */
const SLASH_MAX = 12;

/** 空 query 下要收起来的 /target 子命令 —— 只有你已经打了 "target" 它们才有意义。 */
const TARGET_SUB_IDS = new Set([
  'target-status', 'target-off', 'target-pause', 'target-continue', 'target-refine',
]);

export function pickSlashItems(
  builtins: SlashItem[],
  skills: SlashItem[],
  max = SLASH_MAX,
): SlashItem[] {
  const skillFloor = Math.min(skills.length, Math.ceil(max / 2));
  const takenBuiltins = builtins.slice(0, Math.max(0, max - skillFloor));
  const takenSkills = skills.slice(0, max - takenBuiltins.length);
  return [...takenBuiltins, ...takenSkills];
}

function buildBuiltinSlashItems(): SlashItem[] {
  /* 直接读 module-level global (getGlobalLanguage), 不接 hook 参数.
   * 原因: hook closure 在 HMR / language 切换时可能 stale, 传入 isZh 会用旧值.
   * 每次 factory 调用都拿最新的 global language, 天然幂等且总是正确. */
  const isZh = getGlobalLanguage() === 'zh';
  const desc = isZh
    ? {
        target: '长跑任务 — 跑到自己确认达成',
        /* 中文一律说「目标」, 跟 targetPill 的状态文案对齐 (RELEASE_SCAN #116)。
         * 命令名 `/target` 本身是要照打的字符串, 不翻。 */
        targetStatus: '看当前目标跑到哪了',
        targetOff: '退出目标, 结束长跑',
        targetRefine: '只改目标文本, 保留进度',
        compact: '压缩上下文, 释放 token',
        clear: '清空上下文, 模型忘掉前文',
        research: '深度调研 — 多个调研员并行查, 带出处出报告',
      }
    : {
        target: 'Long-run task — until the agent confirms done',
        targetStatus: 'Where the current Target stands',
        targetOff: 'Exit Target, end the long-run',
        targetRefine: 'Change the goal text, keep progress',
        compact: 'Compact context, free tokens',
        clear: 'Clear context — model forgets the thread',
        research: 'Deep research — parallel researchers, cited report',
      };
  const BUILTIN_LABEL = isZh ? '内置' : 'Built-in';
  return [
    /* /research <题目> —— 交给模型, core 侧 buildSlashResearchDirective 把它变成
     * "第一个动作必须是 deep_research" 的硬指令 (光发原文模型会自己拿 web_search 糊弄过去)。 */
    {
      id: 'research',
      name: '/research',
      description: desc.research,
      category: BUILTIN_LABEL,
      builtin: true,
      fillPrefix: '/research ',
    },
    {
      id: 'target',
      name: '/target',
      description: desc.target,
      category: BUILTIN_LABEL,
      builtin: true,
      fillPrefix: '/target ',
    },
    {
      id: 'target-status',
      name: '/target status',
      description: desc.targetStatus,
      category: BUILTIN_LABEL,
      builtin: true,
      fillPrefix: '/target status',
    },
    {
      id: 'target-off',
      name: '/target off',
      description: desc.targetOff,
      category: BUILTIN_LABEL,
      builtin: true,
      fillPrefix: '/target off',
    },
    {
      id: 'target-refine',
      name: '/target refine',
      description: desc.targetRefine,
      category: BUILTIN_LABEL,
      builtin: true,
      fillPrefix: '/target refine ',
    },
    {
      id: 'compact',
      name: '/compact',
      description: desc.compact,
      category: BUILTIN_LABEL,
      builtin: true,
      builtinAction: 'compact',
    },
    {
      id: 'clear',
      name: '/clear',
      description: desc.clear,
      category: BUILTIN_LABEL,
      builtin: true,
      builtinAction: 'clear',
    },
  ];
}

/* # 补全条目 · 当前打开的 tab / 选中代码 */
type HashItem =
  | { kind: 'tab'; name: string; path: string; tabId: string }
  | { kind: 'selection'; name: string }
  | { kind: 'activeFile'; name: string; path: string };

/* 简约输入框 Morph Surface 形态 */
type MinimalSurface = 'strip' | 'skills';

/* ============================================================
 * TimelineComposer · 真实化五件套
 *   · 附件: 按钮 / drag&drop / paste image
 *   · @ 文件补全 (listFiles IPC)
 *   · agent / ask 模式切换
 *   · ↑/↓ 翻历史 prompt
 *   · model picker + per-model effort flyout
 *   · streaming 时: 停止按钮 (红)
 * ============================================================ */
export const TimelineComposer: React.FC<Props> = ({
  placeholder,
  onSubmit,
  onDraftPresenceChange,
  onInject,
  onSteer,
  onCancelQueued,
  anomalies,
  onDismissAnomaly,
  onRetryAnomaly,
  onContinueAnomaly,
  canContinueAnomaly = false,
  compact = false,
  cloudReadonly = false,
  defaultIntentIds,
  placeholderOverride,
  heroCard = false,
  flat = false,
  inlineSlot,
}) => {
  const runtime = useNeoxRuntime();
  const { isZh } = useI18n();
  const timelineEvents = useTimelineFeed();
  const {
    streaming: chatStreaming,
    attachments,
    addAttachment,
    removeAttachment,
    clearAttachments,
    selectedModel,
    availableModels,
    setSelectedModel,
    mode,
    effortLevel,
    effortByModel,
    setEffortForModel,
    workspacePath,
    interruptCurrent,
    retryLast,
    canRetry: chatCanRetry,
    lastError,
    clearLastError,
    contextUsed,
    totalTokens,
    turnStartedAt,
    activeSession,
    status,
    pendingApproval,
  } = runtime;
  const streaming = !flat && chatStreaming;
  const canRetry = !flat && chatCanRetry;
  const modeVariant = useAgentModeVariant();
  const effectivePlaceholder = placeholderOverride
    ?? placeholder
    ?? modeVariant.composerPlaceholder
    ?? (isZh ? '继续补充要求, 或让 Agent 调整下一步...' : 'Add more details, or ask Agent to adjust the next step...');

  /* 草稿 localStorage · 按 sessionId 维度 */
  const membership = useMembership();
  const entitledModels = useMemo(
    () => getEditionHook('decorateModelsWithEntitlement')(availableModels, membership),
    [availableModels, membership],
  );
  /* BYOK provider 默认显示; 用户显式隐藏后才从 BYOK 菜单移除. */
  const byokPrefsVersion = useByokPickerPrefsVersion();

  const draftKey = activeSession ? `neox:draft:${activeSession.id}` : null;
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const sessModeRaw = useSessionModeGlow(activeSession?.id);
  const sessMode = flat ? null : sessModeRaw;
  const [boxH, setBoxH] = React.useState(56);
  React.useEffect(() => {
    if (!sessMode) return;
    const el = composerBoxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setBoxH(el.getBoundingClientRect().height || 56);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sessMode]);

  const loadedForRef = useRef<string | null>(null);

  /* EditorService · # 引用用 (打开的 tabs + selection) */
  const editorService = useService(EDITOR_SERVICE);

  const [value, setValue] = useState('');
  const hasDraftText = value.trim().length > 0;
  useEffect(() => {
    onDraftPresenceChange?.(hasDraftText);
  }, [hasDraftText, onDraftPresenceChange]);
  const [dragOver, setDragOver] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  /* 首页卡片「思考 · 档位」芯片点开的思考档卡片 (锚点 = 芯片位置) */
  const [thinkAnchor, setThinkAnchor] = useState<DOMRect | null>(null);
  /* 错误卡上的「换个模型」CTA —— 高负载/线路熔断时这是唯一真正管用的动作,
   * 直接把选择器展开, 别让用户自己去输入框上找那颗胶囊。 */
  useEffect(() => {
    const onOpenModelPicker = () => setModelOpen(true);
    window.addEventListener('neox:open-model-picker', onOpenModelPicker as EventListener);
    return () => window.removeEventListener('neox:open-model-picker', onOpenModelPicker as EventListener);
  }, []);
  /* 「服务正忙」卡的「换回标准版」: 按模型名直接切 (特惠 → 标准, 同一来源优先), 找不到就退回打开选择器 */
  const switchTargetsRef = useRef<{ models: ModelInfo[]; current: ModelInfo | null; select: (m: ModelInfo) => void }>({ models: [], current: null, select: () => {} });
  useEffect(() => {
    const onSwitch = (e: Event) => {
      const name = String((e as CustomEvent).detail?.name ?? '');
      const { models, current, select } = switchTargetsRef.current;
      const hits = models.filter((m) => m.name === name);
      const hit = hits.find((m) => m.providerId === current?.providerId) ?? hits[0];
      if (hit) select(hit);
      else setModelOpen(true);
    };
    window.addEventListener('neox:switch-model', onSwitch as EventListener);
    return () => window.removeEventListener('neox:switch-model', onSwitch as EventListener);
  }, []);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [previewAtt, setPreviewAtt] = useState<Attachment | null>(null);
  /* Stop 两级: 第一次 pause, 3 秒内再点 interrupt */
  const lastTokenAtRef = useRef<number>(Date.now());
  const [tokenIdleMs, setTokenIdleMs] = useState(0);

  useEffect(() => {
    /* store 订阅只写 ref, 不 setState — token 频率不进 React 渲染 */
    const unsub = subscribeStreamingTokensHud(() => {
      lastTokenAtRef.current = Date.now();
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!streaming) {
      lastTokenAtRef.current = Date.now();
      setTokenIdleMs(0);
      return;
    }
    lastTokenAtRef.current = Date.now();
    setTokenIdleMs(0);
    const id = window.setInterval(() => {
      setTokenIdleMs(Date.now() - lastTokenAtRef.current);
    }, 500);
    return () => window.clearInterval(id);
  }, [streaming]);

  /* @ / · / # 统一 trigger 补全状态 */
  type TriggerKind = 'at' | 'slash' | 'hash';
  const [triggerKind, setTriggerKind] = useState<TriggerKind | null>(null);
  const [triggerQuery, setTriggerQuery] = useState('');
  const [triggerIdx, setTriggerIdx] = useState(0);
  const [atItems, setAtItems] = useState<AtItem[]>([]);
  const [slashItems, setSlashItems] = useState<SlashItem[]>([]);
  const [hashItems, setHashItems] = useState<HashItem[]>([]);
  /* 当前 session 是否在 cloud — @ picker 切数据源 + 别处可能需要. 监听 NeoxShellHost 广播的事件. */
  const [activeIsCloud, setActiveIsCloud] = useState(false);
  useEffect(() => {
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent<{ cloudActive: boolean }>).detail;
      setActiveIsCloud(!!detail?.cloudActive);
    };
    window.addEventListener('neox:active-session-cloud-state', handler as EventListener);
    window.dispatchEvent(new CustomEvent('neox:request-cloud-state'));
    return () => window.removeEventListener('neox:active-session-cloud-state', handler as EventListener);
  }, []);
  /* 递增 Paste #N 的计数器 */
  const pasteCounterRef = useRef(0);
  /* 长粘贴: 占位词 → 原文。见 pastedText.ts —— 发送时展开, 占位词被删就丢掉 */
  const pastesRef = useRef<Map<string, string>>(new Map());

  /* 历史 prompts */
  const historyRef = useRef<string[]>([]);
  const [histIdx, setHistIdx] = useState<number>(-1);  // -1 = 非浏览态

  /* 当前会话的审批档 —— 只为一件事: 「都不问」这一档在简约态也要常驻可见 (见下方渲染处)。 */
  const approvalMode = useApprovalMode(activeSession?.id ?? null);
  /* 聊天 / Agent (+ 菜单切, 记在会话上); 本机没切过就看会话记录 chat:C1-01 */
  const [chatModeOn, setChatModeOn] = useChatMode(activeSession?.id ?? null, activeSession?.chatMode ?? null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el || el.disabled) return;
    const raf = requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active === el) return;
      const tag = active?.tagName;
      const editable =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active?.isContentEditable === true;
      if (editable) return;                       /* 别人正在输入 —— 让开 */
      if (active && active !== document.body && tag !== 'BUTTON') return;  /* 有交互控件占着 —— 让开 */
      /* 弹窗/抽屉**真的开着**时让开: 用户此刻的注意力不在输入框 (判据见 isBlockingOverlayOpen) */
      if (isBlockingOverlayOpen()) return;
      try { el.focus({ preventScroll: true }); } catch { /* 焦点抢不到不是错误 */ }
    });
    return () => cancelAnimationFrame(raf);
  }, [activeSession?.id]);

  /* 「新建会话」复用了当前空会话时的聚焦回执。
   *
   *   上面那个 effect 依赖 activeSession?.id —— 而复用分支**不换 id**, 所以它不会跑。
   *   而复用恰恰是最常见的那条路 (用户在空会话上点「新建会话」)。
   *   没有这一条, 用户点下去屏幕上一个像素都不动。见 NeoxRuntimeBridge 的 shouldReuseBlankSession 分支。 */
  useEffect(() => {
    const onFocusRequest = () => {
      const el = textareaRef.current;
      if (!el || el.disabled) return;
      requestAnimationFrame(() => {
        try { el.focus({ preventScroll: true }); } catch { /* 抢不到不是错误 */ }
      });
    };
    window.addEventListener('neox:composer-focus', onFocusRequest);
    return () => window.removeEventListener('neox:composer-focus', onFocusRequest);
  }, []);

  const [activeIntentIds, setActiveIntentIds] = useState<string[]>(defaultIntentIds ?? []);
  const imageIntentActive = activeIntentIds.includes('create-image');
  const pickerModels = useMemo(() => {
    if (!imageIntentActive) {
      const chatOnly = entitledModels.filter(isChatModelInfo);
      return chatOnly.length > 0 ? chatOnly : entitledModels;
    }
    const imageOnly = entitledModels.filter(isImageModelInfo);
    return imageOnly.length > 0 ? imageOnly : entitledModels;
  }, [entitledModels, imageIntentActive]);
  const [imageModelId, setImageModelId] = useState<string | null>(() => {
    try { return window.localStorage.getItem('neox:image-model-id'); } catch { return null; }
  });
  const imageModel = useMemo(
    () => pickerModels.find(m => m.id === imageModelId) ?? pickerModels[0] ?? null,
    [pickerModels, imageModelId],
  );
  /* 图片意图激活 → composer 的"当前模型"= 图片模型 (显示/参数/出图都用它), 全局 selectedModel 不受影响. */
  const activeModel = imageIntentActive ? imageModel : selectedModel;
  switchTargetsRef.current = { models: pickerModels, current: selectedModel, select: (m) => setSelectedModel(m) };

  const activeModelVision = useMemo<boolean | null>(() => {
    const curName = (activeModel?.name || '').trim().toLowerCase();
    const entModel = curName
      ? entitledModels.find((m) => (m.name || '').trim().toLowerCase() === curName)
      : undefined;
    return entModel?.entitlement?.caps?.vision
      ?? (entModel?.supportsVision || activeModel?.supportsVision ? true : null);
  }, [activeModel, entitledModels]);
  /* 抽卡: 出图数量 (imageGenParams.n), composer 底栏快选. */
  const imageParamValues = useImageParamValues();
  const imageCount = Math.max(1, Math.min(10, Number(imageParamValues.n ?? 1)));
  /* 直连图片模式执行函数 — chip 挂着时敲的每一句都走这里.
   *   1. 立刻 emit pending turn 事件, AgentTimelineView 挂个占位卡显 "生成中"
   *   2. IPC 直连主进程 → ImageGenService.generate → 落 <userData>/neox-artifacts/generated/
   *   3. emit ok/error turn 事件, 卡自动填图 (fileUrl) 或红字失败原因
   * 不进 chat session store, 不占 tokens, 不打断当前对话. */
  const runDirectImageMode = useCallback(async (prompt: string) => {
    const turnId = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const chip = INTENT_CHIPS.find(c => c.id === 'create-image');
    const createdAt = Date.now();
    /* 图生图: 收集当前挂着的图片附件 (dataURL) 作参考图, 走 input_references. */
    const refImages = attachments
      .filter(a => a.type === 'image' && typeof a.data === 'string' && a.data.startsWith('data:image/'))
      .map(a => a.data);
    const isImg2Img = refImages.length > 0;
    const chipLabel = isImg2Img ? (isZh ? '改图' : 'Edit') : chip?.label;
    /* 带上参考图渲染进用户气泡 (可多张). 空数组时不传, 省得 UI 判空. */
    const refField = isImg2Img ? refImages : undefined;
    const forceNew = typeof window !== 'undefined' && (window as { __neoxImageScratch?: boolean }).__neoxImageScratch === true;
    let sess = runtime.activeSession as { id?: string; name?: string; kind?: string } | null;
    if (forceNew || sess?.kind !== 'image') {
      try { sess = (await runtime.createNewSession({ kind: 'image' })) as typeof sess; }
      catch { sess = null; }
      if (forceNew) (window as { __neoxImageScratch?: boolean }).__neoxImageScratch = false;
    }
    const targetSid = sess?.id || 'image-studio';
    emitDirectImageTurn({ sessionId: targetSid, turnId, prompt, chipLabel, createdAt, status: 'pending', refImages: refField });
    /* 自动命名: 首条出图描述作会话标题 (图片会话默认名"图片·M月D日", 全叫这个分不清) — 跟 chat 一致.
     * 手动改过则 isDefaultSessionName 不匹配, 不覆盖. */
    if (sess?.id && isDefaultSessionName(sess.name)) {
      const cleaned = prompt.replace(/^<[a-z-]+>\s*/, '').replace(/\s+/g, ' ').trim();
      const title = cleaned.length > 20 ? cleaned.slice(0, 20) + '…' : cleaned;
      if (title) void runtime.renameSession(sess.id, title).catch(() => { /* 不阻塞 */ });
    }
    /* 参考图已消费 → 清出输入框 (避免下一句又带上). */
    if (isImg2Img) {
      for (const a of attachments) {
        if (a.type === 'image' && typeof a.data === 'string' && a.data.startsWith('data:image/')) removeAttachment(a.id);
      }
    }
    try {
      /* 用用户选的图像模型的真实 name (e.g. openai/gpt-image-2), 不能用 .id —
       * .id 是 "<providerId>:<name>" 带前缀 (openrouter:openai/gpt-image-2), 直发上游会 404.
       * 参数从 imageGenParams store 数据驱动读, buildRequestParams 拆成字段 + providerOptions 透传. */
      const p = buildRequestParams(getImageParamValues());
      /* 流式出图: partial 帧一到就更新 pending 卡的渐进预览 (模糊→清晰), 失败不掉图.
       * 有参考图 → 带 image (input_references), 上游按图生图/改图处理. */
      const result = await directGenerateImageStream({
        prompt,
        model: imageModel?.name,
        providerId: imageModel?.providerId,
        tier: p.tier,
        quality: p.quality,
        size: p.size,
        n: p.n,
        background: p.background,
        outputCompression: p.outputCompression,
        providerOptions: p.providerOptions,
        image: isImg2Img ? refImages : undefined,
      }, {
        onPartial: (dataUrl) => {
          emitDirectImageTurn({ sessionId: targetSid, turnId, prompt, chipLabel, createdAt, status: 'pending', partialUrl: dataUrl, refImages: refField });
        },
        onImage: (dataUrl) => {
          emitDirectImageTurn({ sessionId: targetSid, turnId, prompt, chipLabel, createdAt, status: 'pending', partialUrl: dataUrl, refImages: refField });
        },
      });
      emitDirectImageTurn({
        sessionId: targetSid, turnId, prompt, chipLabel, createdAt,
        status: result.ok ? 'ok' : 'error',
        result, refImages: refField,
      });
      if (result.ok) trackImage(isImg2Img ? 'edit' : 'generate', { n: result.count }, result.mode);
    } catch (err: any) {
      emitDirectImageTurn({
        sessionId: targetSid, turnId, prompt, chipLabel, createdAt, status: 'error',
        result: { ok: false, paths: [], fileUrls: [], count: 0, error: err?.message || String(err) }, refImages: refField,
      });
    }
  }, [imageModel?.name, attachments, removeAttachment, isZh, runtime]);
  const imageAttachData = useMemo(
    () => attachments
      .filter(a => a.type === 'image' && typeof a.data === 'string' && a.data.startsWith('data:image/'))
      .map(a => a.data as string),
    [attachments],
  );

  useEffect(() => {
    if (!flat) return;
    const onAttach = async (evt: Event) => {
      const d = (evt as CustomEvent).detail as { dataUrl?: string; url?: string; path?: string; name?: string } | undefined;
      let data = d?.dataUrl;
      if (!data && d?.url) {
        try {
          const blob = await (await fetch(d.url)).blob();
          data = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(blob); });
        } catch { /* 拿不到就算了 */ }
      }
      if (!data || !data.startsWith('data:image/')) return;
      /* 跟上面文件附件那条同一口径 —— 这条路径 (最近图点选 / 结果卡「继续」/ 整页拖粘贴)
       * 同样能带进 BMP 之类上游不收的格式, 只改一处就是半截。 */
      const norm = await normalizeImageDataUrl(data);
      if (!norm.ok) {
        const notify = await import('../../components/notifyEvents');
        notify.dispatchOpFailed({
          op: isZh ? '添加图片' : 'Attach image',
          message: unsupportedImageMessage(norm.fromType, isZh),
        });
        return;
      }
      addAttachment({ id: makeId('img'), type: 'image', data: norm.dataUrl, name: d?.name || 'image.png' });
    };
    const onNewCanvas = () => {
      for (const a of attachments) {
        if (a.type === 'image') removeAttachment(a.id);
      }
    };
    window.addEventListener('neox:image-attach', onAttach as EventListener);
    window.addEventListener('neox:image-new-canvas', onNewCanvas);
    return () => { window.removeEventListener('neox:image-attach', onAttach as EventListener); window.removeEventListener('neox:image-new-canvas', onNewCanvas); };
  }, [flat, attachments, addAttachment, removeAttachment]);

  /* Popover anchor: 三个 mention popover (@ / slash / #) 都通过 Portal 渲染到 body,
   * 用这个 ref 定位到 input-wrap 上方 (脱离 timeline 内所有 stacking context, 保证不被
   * turn_summary / bgtasks 等元素遮住). */
  const inputWrapRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /* 外部 (neox:composer-fill pickFile) 要弹选文件: handlePick 定义在后面, 经 ref 拿 */
  const pickFileRef = useRef<(() => void) | null>(null);
  /* 容器宽度自适应: 监测自身实际宽度, 窄于阈值就把 compact = true.
   *   - 阈值 720: 已经放不下 PRO PLUS + 模型 label + 思考 + ctx + 工具栏 — 把次要工具折叠进 ⋯
   *   - 跟 CSS container query (560/440/360) 互补 — container query 改可见样式,
   *     这里通过 React state 控制结构 (减少渲染的 button 数量).
   *   props.compact 永远优先 (IDE 右栏强制 compact), false 时由自动判断. */
  const composerRef = useRef<HTMLDivElement>(null);
  const [autoCompact, setAutoCompact] = useState(false);
  useEffect(() => {
    if (!composerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setAutoCompact(e.contentRect.width < 720);
      }
    });
    ro.observe(composerRef.current);
    return () => ro.disconnect();
  }, []);
  const effectiveCompact = compact || autoCompact;

  const [composerStyle] = useComposerStylePreference();
  const minimal = composerStyle === 'minimal' && !flat;
  const [minimalSurface, setMinimalSurface] = useState<MinimalSurface>('strip');
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const plusBtnRef = useRef<HTMLButtonElement | null>(null);
  const composerBoxRef = useRef<HTMLDivElement | null>(null);
  /* 简约态上下文详情弹层 — 由加号菜单打开, 不占长条位置 */
  const [contextPopOpen, setContextPopOpen] = useState(false);
  /* 「+」→ 请求模式 的弹窗 (ContextModeSection.tsx) */
  const [requestModeOpen, setRequestModeOpen] = useState(false);
  const [outputStyleOpen, setOutputStyleOpen] = useState(false);
  const [conversationModeOpen, setConversationModeOpen] = useState(false);
  const [approvalDialogOpen, setApprovalDialogOpen] = useState(false);
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
  const [runDestOpen, setRunDestOpen] = useState(false);
  /* 面板自适应: 贴底 → 向上弹; 中间/上方有空位 → 向下弹 */
  const [panelSide, setPanelSide] = useState<'above' | 'below'>('below');
  const showMinimalPanel = minimal && minimalSurface !== 'strip';
  const resolvePanelSide = useCallback((surface: MinimalSurface = minimalSurface): 'above' | 'below' => {
    const el = composerBoxRef.current;
    if (!el) return 'below';
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const gap = 6;
    const need = 220;
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - margin - gap);
    const spaceAbove = Math.max(0, rect.top - margin - gap);
    if (spaceBelow >= need) return 'below';
    if (spaceAbove >= need) return 'above';
    return spaceAbove > spaceBelow ? 'above' : 'below';
  }, [minimalSurface]);
  const openMinimalSurface = useCallback((surface: MinimalSurface) => {
    setPlusMenuOpen(false);
    setPanelSide(resolvePanelSide(surface));
    setMinimalSurface(surface);
  }, [resolvePanelSide]);
  const closeMinimalSurface = useCallback(() => {
    setPlusMenuOpen(false);
    setMinimalSurface('strip');
  }, []);
  /* 打开期间随窗口/滚动重算方向 */
  useEffect(() => {
    if (!showMinimalPanel) return;
    const update = () => setPanelSide(resolvePanelSide());
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [showMinimalPanel, resolvePanelSide]);
  /* 切回标准形态时复位 */
  useEffect(() => {
    if (!minimal) {
      closeMinimalSurface();
      setContextPopOpen(false);
    }
  }, [minimal, closeMinimalSurface]);
  /* panel 态: Esc / 点外壳外 → 回长条 */
  useEffect(() => {
    if (!showMinimalPanel) return;
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeMinimalSurface();
      }
    };
    const onDoc = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (
        t.closest('.atl-composer__stack')
        || t.closest('.atl-composer__box')
        || t.closest('.atl-mini-panel')
        || t.closest('.atl-dangerous')
        || t.closest('.nx-confirm')
      ) return;
      closeMinimalSurface();
    };
    window.addEventListener('keydown', onEsc, true);
    document.addEventListener('pointerdown', onDoc, true);
    return () => {
      window.removeEventListener('keydown', onEsc, true);
      document.removeEventListener('pointerdown', onDoc, true);
    };
  }, [showMinimalPanel, closeMinimalSurface]);

  const isPlaceholderModel = imageIntentActive
    ? !imageModel                                   // 图片模式: 有图像模型就不算占位
    : (!selectedModel || !selectedModel.id || selectedModel.id.startsWith('default:') ||
       !availableModels.some((m) => m.id === selectedModel.id));

  /* 冷启动时模型列表可能先是空的(云端模型异步拉), 立刻判定会闪一下提示条并瞬间禁发。
   * 挂载后等一拍再认这个判断 —— 真没配 provider 的用户晚 1.2s 看到提示无所谓,
   * 已配好的用户绝不该看到闪烁。 */
  const [settleTick, setSettleTick] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSettleTick(true), 1200);
    return () => clearTimeout(t);
  }, []);
  const needsProviderSetup = settleTick && availableModels.length === 0;

  /* 运行中插话: 提供 onInject 时 streaming 也能发 (走排队), 否则保持旧行为 (streaming 禁发) */
  const canQueueWhileRunning = streaming && !!onInject;
  const canSend = value.trim().length > 0 && (!streaming || canQueueWhileRunning) && !cloudReadonly
    /* F7+N4 v2: 文档解析中 disable send, 防 agent 收到空 data 看不到内容 */
    && !attachments.some(a => (a as any).status === 'parsing')
    /* 没有任何可用模型时禁发 —— 光禁不给出路会变成新的困惑, 所以配合上方提示条一起做 */
    && !needsProviderSetup;

  const sendBlockedReason = ((): string | null => {
    if (canSend) return null;
    if (value.trim().length === 0) return isZh ? '先输入内容' : 'Type something first';
    if (needsProviderSetup) {
      return isZh ? '还没有可用的模型 —— 先在 设置 → API 服务商 里配一个' : 'No model available yet — set one up under Settings → API providers';
    }
    if (cloudReadonly) {
      return isZh ? '会话正在与云端同步, 同步完就能发' : 'Syncing with the cloud — you can send once it finishes';
    }
    if (attachments.some(a => (a as any).status === 'parsing')) {
      return isZh ? '附件还在解析中, 解析完就能发' : 'Still parsing an attachment — you can send once it finishes';
    }
    if (streaming && !canQueueWhileRunning) {
      return isZh ? '本轮还在跑, 这个会话不支持排队 —— 等它结束或先点停止' : 'This turn is still running and can’t queue — wait for it or hit Stop';
    }
    return isZh ? '现在还不能发送' : 'Can’t send right now';
  })();

  const runActivity = useMemo(
    () => inferComposerRunActivity(timelineEvents, pendingApproval, status, tokenIdleMs, isZh, streaming),
    /* streaming 必须进依赖 —— 漏了会 stale closure: turn 结束后标签还停在等待模型响应 */
    [timelineEvents, pendingApproval, status, tokenIdleMs, isZh, streaming],
  );

  /* 手动压缩发生在非 streaming 的空闲态 (上下文面板"立即压缩"按钮) — LiveStatusLine
   * 只在 streaming 渲染, 之前压缩全程 status 区一片空白。这里单独感知进行中的压缩条目,
   * 空闲时也给一条 "压缩上下文中 · N%" 的状态。 */
  const activeCompaction = useMemo(() => {
    for (let i = timelineEvents.length - 1; i >= 0; i--) {
      const entry = timelineEvents[i] as any;
      if (entry?.type === 'context_compaction') {
        return (entry.compactionStatus === 'started' || entry.compactionStatus === 'compressing') ? entry : null;
      }
    }
    return null;
  }, [timelineEvents]);
  const compactionPct = useMemo(() => {
    const total = activeCompaction?.compressionTotalBuckets;
    const done = activeCompaction?.compressionCompletedBuckets;
    if (typeof total !== 'number' || total <= 0 || typeof done !== 'number') return null;
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  }, [activeCompaction]);

  /* 按会话保存排队条；只按引擎明确的消费/拒收/丢弃事件逐条结算。
   * streaming=false 不代表队列未送达，不能据此整体退回或重发。 */
  /* 排队条现在带图片 —— 「立即发送」要把原样的附件一起重发, 只存文字会把图丢掉。 */
  const activeSessionIdForQueue = activeSession?.id ?? null;
  const {
    items: queuedLocal, set: setQueuedLocal, get: getQueued,
    setForSession: setQueuedForSession,
  } = useSessionMessageQueue(activeSessionIdForQueue);

  const {
    items: draftQueue, set: setDraftQueue, takeAll: takeDrafts,
    get: getDrafts, setForSession: setDraftsForSession,
  } = useSessionMessageQueue(activeSessionIdForQueue);
  /* 被退回、但当时不在前台的那些 —— 切回该会话时倒回输入框 (文字 + 图片) */
  const {
    items: returnedQueue, takeAll: takeReturned, setForSession: setReturnedForSession,
  } = useSessionMessageQueue(activeSessionIdForQueue);

  /* 附件 → 引擎的图片格式。
   *   附件里存的是 dataURL ("data:image/png;base64,AAA…"), 引擎 injectUserMessage 要的是
   *   拆开的 { mediaType, data }。跟 runDirectImageMode 里收集 refImages 是同一批数据,
   *   只是那边直接用 dataURL, 这边要拆。拆不出来的 (非 dataURL / 非图片) 一律跳过, 不猜。 */
  /* 本组件里链上互相引用的回调一律走 useStableCallback —— 见 hooks/useStableCallback.ts (闭包链内存泄漏) */
  const collectInjectImages = useStableCallback((): Array<{ mediaType: string; data: string; name?: string }> => {
    const out: Array<{ mediaType: string; data: string; name?: string }> = [];
    for (const a of attachments) {
      if ((a as any).type !== 'image') continue;
      const d = (a as any).data;
      if (typeof d !== 'string') continue;
      const m = /^data:([^;,]+);base64,(.*)$/.exec(d);
      if (!m) continue;
      out.push({ mediaType: m[1], data: m[2], name: (a as any).name });
    }
    return out;
  });

  /* 插话把图片带走之后要清掉, 否则下一条排队消息会把同一批图再发一遍。
   *   只清图片附件 —— 文档类附件走的是另一条 (parse 成文本进 prompt), 不归这里管。 */
  const clearAttachmentsAfterSend = useStableCallback(() => {
    for (const a of attachments) {
      if ((a as any).type === 'image') removeAttachment((a as any).id);
    }
  });
  /* steering 把排队消息注入引擎时 (user_message_injected 已渲染进 timeline),
   * 同步把这条从本地排队条移除 — 只移除匹配的那一条, 多条排队时其余保留。 */

  /* 硬插 —— 第二次回车 / 点药丸上的「立即插入」走这里.
   *
   *   消息早已在引擎里 (回车一次时就交了), 这里只是让引擎把它们提到下一步并转向
   *   (host.requestSteeringInterrupt): 模型输出中直接打断 (半截保留), 工具执行中则工具结束就插。
   *   本轮**不停** —— 老「立即发送」是 stop + 当新一轮重发, 会把在途的活一起作废。 */
  const flushDrafts = useCallback(() => {
    if (!onSteer) return;
    const drafts = takeDrafts();
    if (!drafts.length) return;
    /* 这一轮已经结束: 引擎里早没有它们了 (run-end drain 接走的会先把药丸摘掉), onSteer 当新一轮发。
     * 不进 queuedLocal —— 那是"在引擎里排着"的账, 发失败走 sendPrompt 自己的退回通道。 */
    if (streaming) setQueuedLocal((q) => [...q, ...drafts]);
    onSteer(drafts);
  }, [onSteer, takeDrafts, setQueuedLocal, streaming]);
  const flushDraftsRef = useRef(flushDrafts);
  flushDraftsRef.current = flushDrafts;
  const hasSteer = !!onSteer;
  useEffect(() => {
    if (streaming || draftQueue.length === 0 || !hasSteer) return;
    const id = setTimeout(() => flushDraftsRef.current(), 1500);
    return () => clearTimeout(id);
  }, [streaming, draftQueue.length, hasSteer, activeSessionIdForQueue]);
  const subAgentsForStrip = useSubAgents(activeSessionIdForQueue);
  const runningSubAgentTokens = subAgentsForStrip.reduce(
    (sum, a) => (a.status === 'running' ? sum + (a.outputTokens || 0) : sum), 0);
  useEffect(() => {
    const onInjected = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string; text?: string }>).detail;
      if (!detail?.text) return;
      const sid = detail.sessionId ?? activeSessionIdForQueue;
      /* 等本轮结束的药丸被引擎接走了 → 摘掉 (时间线那边会出这条气泡) */
      setDraftsForSession(sid, (prev) => {
        const idx = prev.findIndex((q) => q.text === detail.text);
        return idx < 0 ? prev : prev.filter((_, i) => i !== idx);
      });
      setQueuedForSession(sid, (prev) => {
        const idx = prev.findIndex((q) => q.text === detail.text);
        if (idx < 0) return prev;
        return prev.filter((_, i) => i !== idx);
      });
    };
    const onRejected = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string; text?: string; images?: Array<{ mediaType: string; data: string; name?: string }> }>).detail;
      const text = detail?.text;
      if (!text) return;
      const sid = detail.sessionId ?? activeSessionIdForQueue;
      const queued = getQueued(sid);
      const idx = queued.findIndex(q => q.text === text);
      /* 等本轮结束的药丸也在这条安全网里: 被拒 / 本轮被停 → 摘药丸, 文字回输入框 */
      const drafts = getDrafts(sid);
      const draftIdx = drafts.findIndex(q => q.text === text);
      const returned = { text, images: detail.images ?? queued[idx]?.images ?? drafts[draftIdx]?.images };
      if (idx >= 0) setQueuedForSession(sid, queued.filter((_, i) => i !== idx));
      if (draftIdx >= 0) setDraftsForSession(sid, drafts.filter((_, i) => i !== draftIdx));
      if (restoredMessageEvents.has(e)) return;
      if (idx < 0 && draftIdx < 0 && !isVisible()) return;
      restoredMessageEvents.add(e);
      /* 同上: 对象数组里 indexOf 一个字符串恒为 -1。排队被拒时文字虽然退回了输入框,
       * 那条 chip 却还挂着 —— 用户看到"已排队"和输入框里的原文同时存在。 */
      if (sid !== activeSessionIdForQueue || !isVisible()) {
        setReturnedForSession(sid, prev => [...prev, returned]);
        return;
      }
      setValue((cur) => restoreComposerDraft(cur, text));
      setQueuedRestoredAt(Date.now());
      for (const img of returned.images ?? []) {
        if (!img?.data) continue;
        addAttachment({
          id: makeId('img'), type: 'image', name: img.name || 'image.png',
          data: img.data.startsWith('data:')
            ? img.data
            : `data:${img.mediaType || 'image/png'};base64,${img.data}`,
        });
      }
      /* 直接量高度 —— 这个 effect 在 adjust 声明之前, 不能引用它 (TDZ) */
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = '';
        el.style.height = `${el.scrollHeight}px`;
      });
    };
    window.addEventListener('neox:user-message-injected', onInjected);
    window.addEventListener('neox:queued-message-rejected', onRejected);
    return () => {
      window.removeEventListener('neox:user-message-injected', onInjected);
      window.removeEventListener('neox:queued-message-rejected', onRejected);
    };
  }, [activeSessionIdForQueue, addAttachment, getQueued, setQueuedForSession, getDrafts, setDraftsForSession, setReturnedForSession]);

  useEffect(() => {
    const onFill = (e: Event) => {
      const detail = (e as CustomEvent<{ text?: string; focus?: boolean; send?: boolean; replace?: boolean; selectBlank?: boolean; pickFile?: boolean; images?: Array<{ name?: string; data: string }> }>).detail;
      /* 退回一条只发了图的消息: 没文字也要把图放回来 */
      const backImages = !detail?.send ? (detail?.images ?? []).filter((im) => im.data?.startsWith('data:')) : [];
      if (!detail?.text && backImages.length === 0) return;
      if (!isVisible()) return;   /* 同上: 只有露在外面的那个 composer 该响应 */
      for (const im of backImages) {
        addAttachment({ id: makeId('img'), type: 'image', name: im.name || 'image.png', data: im.data });
      }
      if (!detail.text) {
        requestAnimationFrame(() => { textareaRef.current?.focus(); });
        return;
      }
      if (detail.send) {
        const t = detail.text.trim();
        if (!t) return;
        if (imageIntentActive) { void runDirectImageMode(t); return; } // 图片模式: 直连出图 (换一批/一键出图)
        if (streaming) {
          if (!onInject) return;
          const imgs = collectInjectImages();
          setQueuedLocal((q) => [...q, { text: t, images: imgs.length > 0 ? imgs : undefined }]);
          onInject(t, imgs.length > 0 ? imgs : undefined);
          clearAttachmentsAfterSend();
        } else {
          onSubmit?.(t);
        }
        return;
      }
      const shouldAppend = detail.replace === false;
      setValue((v) => (shouldAppend && v.trim() ? `${v}\n${detail.text}` : (detail.text as string)));
      if (detail.focus !== false) {
        requestAnimationFrame(() => {
          const ta = textareaRef.current;
          ta?.focus();
          /* 起手卡片 (WorkStarters): 选中第一处【…】, 小白直接打字就把它换掉 */
          if (ta && detail.selectBlank) {
            const from = ta.value.indexOf('【');
            const to = from >= 0 ? ta.value.indexOf('】', from) : -1;
            if (from >= 0 && to > from) ta.setSelectionRange(from, to + 1);
          }
        });
      }
      /* 这件事要先给文件 (翻译 / 润色 / 整理表格): 顺手弹出选文件 */
      if (detail.pickFile) requestAnimationFrame(() => pickFileRef.current?.());
    };
    window.addEventListener('neox:composer-fill', onFill);
    const onWakeMic = () => {
      if (micState !== 'idle') return;
      void toggleMicRef.current?.();
    };
    window.addEventListener('neox:composer-mic-open', onWakeMic);
    return () => {
      window.removeEventListener('neox:composer-fill', onFill);
      window.removeEventListener('neox:composer-mic-open', onWakeMic);
    };
  }, [streaming, onInject, onSubmit, activeSessionIdForQueue, imageIntentActive, runDirectImageMode, addAttachment]);

  const isVisible = useCallback(() => composerRef.current?.offsetParent != null, []);

  const [minimalInputTall, setMinimalInputTall] = useState(false);
  /* IME 组字中: 预览字会改 scrollHeight, 但 Windows 上此时改几何/重绘会拆掉 TSF。
   * 组字期间整段 adjust 停住, compositionend 再量一次 (见 onCompositionEnd). */
  const composingRef = useRef(false);
  /* adjust 里读当前文本用 —— adjust 是 useCallback, 不能把 value 进依赖(每次输入都重建) */
  const valueRef = useRef('');
  const tallDecisionRef = useRef<{ value: string; tall: boolean } | null>(null);

  const adjust = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    /* 组字中禁止任何 height/class 写入。Windows Chromium 在 TSF 组字时改 textarea
     * 几何或 flushSync 重绘, 会把输入上下文掐掉, 之后候选框不再弹出、只能打英文。 */
    if (composingRef.current) return;
    if (minimal) {
      const minH = 32;
      const maxH = Math.round(Math.min(window.innerHeight * 0.5, 480));
      const currentValue = valueRef.current;
      /* 关键: 量高【不要】写 height:auto —— 那会让单行胶囊瞬间塌成内容高/空一帧
       * (用户报"正在换行的时候明显全空了"). textarea 即使 height 锁 32,
       * scrollHeight 仍反映完整内容高. */
      const sh = el.scrollHeight;

      const cached = tallDecisionRef.current;
      let tall: boolean;
      if (cached && cached.value === currentValue) {
        tall = cached.tall;
      } else if (!currentValue.trim()) {
        tall = false;
        tallDecisionRef.current = { value: currentValue, tall };
      } else {
        tall = sh > minH + 2 || currentValue.includes('\n');
        tallDecisionRef.current = { value: currentValue, tall };
      }
      /* 展开用 flushSync: class 必须在写 height 之前上屏,
       * 否则单行 overflow:hidden 会先裁一帧空白 (用户报"换行时全空"). */
      if (tall) {
        flushSync(() => setMinimalInputTall(true));
      } else {
        setMinimalInputTall(false);
      }

      if (!tall) {
        el.style.height = '';
        el.style.overflowY = 'hidden';
        return;
      }
      el.style.height = `${Math.min(Math.max(sh, minH), maxH)}px`;
      el.style.overflowY = sh > maxH + 1 ? 'auto' : 'hidden';
      return;
    }
    const maxH = effectiveCompact ? 60 : 240;
    el.style.height = 'auto';
    const scrollHeight = el.scrollHeight;
    el.style.height = `${Math.min(scrollHeight, maxH)}px`;
    el.style.overflowY = scrollHeight > maxH + 1 ? 'auto' : 'hidden';
  }, [effectiveCompact, minimal]);

  useEffect(() => { valueRef.current = value; }, [value]);
  /* 输入框非受控: React 受控 `value=` 每次 commit 都会赋 .value, Windows 上即使
   * 字符串没变也会拆掉 TSF 组字。React 状态仍作镜像 (发送/草稿/触发器用); 程序化
   * 改稿经这一跳写回 DOM, 组字期间跳过。 */
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el || composingRef.current) return;
    if (el.value !== value) el.value = value;
  }, [value]);
  /* 依赖里**不能**有 minimalInputTall —— 它正是 adjust 自己 set 出来的. */
  useEffect(() => {
    const frame = requestAnimationFrame(adjust);
    return () => cancelAnimationFrame(frame);
  }, [adjust, value]);

  /* is-expanded class 上屏后用新几何 (line-height 1.45) 再钉一次高度 */
  useEffect(() => {
    if (!minimal || !minimalInputTall) return;
    const el = textareaRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      if (composingRef.current) return;
      const minH = 32;
      const maxH = Math.round(Math.min(window.innerHeight * 0.5, 480));
      const sh = el.scrollHeight;
      el.style.height = `${Math.min(Math.max(sh, minH), maxH)}px`;
      el.style.overflowY = sh > maxH + 1 ? 'auto' : 'hidden';
    });
    return () => cancelAnimationFrame(frame);
  }, [minimal, minimalInputTall]);

  const switchKey = draftKey ?? homeDraftKey(modeVariant.isPilot ? 'pilot' : modeVariant.isWork ? 'work' : 'code');
  const switchKeyRef = useRef<string | null>(null);
  /* valueRef 在上面 (由更早声明的 effect 同步, 到这里已是本次提交的值) */
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  /* 刚从首页发出第一条 (会话随之建出来): 首页那份已经发走了, 不能再存回去 */
  const sentFromHomeRef = useRef(false);
  useEffect(() => {
    if (flat) return;
    const prev = switchKeyRef.current;
    if (prev === switchKey) return;
    switchKeyRef.current = switchKey;
    /* prev=null = 刚挂上 (首页大输入框 ↔ 会话输入框是两个实例, 来回会重挂): 只取不存 ——
     * 上一个实例卸载时已经存过了 (见下面的卸载 effect), runtime 里留着的附件是它的, 一样要换掉。 */
    const discardPrev = prev !== null && sentFromHomeRef.current && isHomeDraftKey(prev);
    if (prev !== null) sentFromHomeRef.current = false;
    const swap = swapComposerDraft(prev, switchKey, {
      text: valueRef.current, attachments: attachmentsRef.current,
    }, { discardPrev });
    loadedForRef.current = draftKey;
    let nextText = swap.homeText ?? '';
    let nextPastes: Array<[string, string]> = [];
    if (draftKey) {
      try {
        nextText = window.localStorage?.getItem(draftKey) ?? '';
        const savedPastes = JSON.parse(window.localStorage?.getItem(`${draftKey}:pastes`) || '[]');
        if (Array.isArray(savedPastes)) nextPastes = savedPastes;
      } catch { /* ignore */ }
    }
    pastesRef.current = new Map(nextPastes);
    setValue(nextText);
    setEditingEntry(null);
    setQueuedRestoredAt(null);
    setHistIdx(-1);
    clearAttachments();
    for (const a of swap.attachments) addAttachment(a);
    requestAnimationFrame(adjust);
    /* 只跟着 key 走: value / attachments 走 ref, 否则每打一个字都会当成一次切换 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switchKey, flat]);
  /* 卸载时把手上这份存下 —— 下一个挂上来的实例 (或切回来时) 按 key 取 */
  useEffect(() => () => {
    const key = switchKeyRef.current;
    if (flat || !key) return;
    stashComposerDraft(key, { text: valueRef.current, attachments: attachmentsRef.current }, {
      discardPrev: sentFromHomeRef.current && isHomeDraftKey(key),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (returnedQueue.length === 0) return;
    if (!isVisible()) return;
    const drafts = takeReturned();
    const leftover = drafts.map((d) => d.text).join('\n');
    setValue((v) => (v.trim() ? `${v}\n${leftover}` : leftover));
    for (const draft of drafts) {
      for (const img of draft.images ?? []) {
        addAttachment({
          id: makeId('img'), type: 'image', name: img.name || 'image.png',
          data: img.data.startsWith('data:') ? img.data : `data:${img.mediaType};base64,${img.data}`,
        });
      }
    }
    setQueuedRestoredAt(Date.now());
    requestAnimationFrame(() => { adjust(); textareaRef.current?.focus(); });
  }, [returnedQueue, adjust, activeSessionIdForQueue, takeReturned, addAttachment]);

  /* 排队消息被退回的提示 —— 显示 6 秒后自动消失 */
  const [queuedRestoredAt, setQueuedRestoredAt] = useState<number | null>(null);
  useEffect(() => {
    if (!queuedRestoredAt) return;
    const id = setTimeout(() => setQueuedRestoredAt(null), 6000);
    return () => clearTimeout(id);
  }, [queuedRestoredAt]);

  /* 语音输入 (流式 STT, 边说边出字) —— 麦克风按钮.
   * 渲染端采 16k PCM → 主进程 WS → 网关 /n1/asr/stream → 火山流式 ASR, 转写实时刷进输入框。
   * result_type:full 每包返回当前完整文本, 故每次都是 base + 全量替换。 */
  const [micState, setMicState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [voiceSetupOpen, setVoiceSetupOpen] = useState(false);
  const [voiceInputOn, setVoiceInputOn] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void (window.neox as unknown as { sttGetConfig?: () => Promise<{ enabled?: boolean }> })
        ?.sttGetConfig?.()
        ?.then((r) => { if (alive && r) setVoiceInputOn(r.enabled === true); })
        ?.catch(() => { /* 读不到 = 关着, 跟缺省一致 */ });
    };
    load();
    /* 设置页改完立刻生效, 不用重开窗口 —— 设置页保存后广播这个事件 */
    window.addEventListener('neox:stt-config-changed', load);
    return () => { alive = false; window.removeEventListener('neox:stt-config-changed', load); };
  }, []);
  const voiceStreamRef = useRef<VoiceStream | null>(null);
  const sttStreamIdRef = useRef<string | null>(null);
  const sttUnsubRef = useRef<(() => void) | null>(null);
  const sttBaseRef = useRef<string>('');
  const [micAnalyser, setMicAnalyser] = useState<AnalyserNode | null>(null);
  /* 录音时盖在输入框上的波形条: 跟 textarea 同位同高 (上方可能有附件 chip, 不能直接铺满 input-wrap) */
  const [voiceBox, setVoiceBox] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    if (micState === 'idle') { setVoiceBox(null); return; }
    const ta = textareaRef.current;
    if (!ta) return;
    const next = { top: ta.offsetTop, left: ta.offsetLeft, width: ta.offsetWidth, height: ta.offsetHeight };
    setVoiceBox((p) => (p && p.top === next.top && p.left === next.left && p.width === next.width && p.height === next.height ? p : next));
  }, [micState, value]);
  /* 波形左边只露最近识别出的一截 (本次录音新增的字), 完整内容结束后回到输入框里 */
  const voiceTail = micState === 'idle' ? '' : (() => {
    const base = sttBaseRef.current;
    const fresh = (value.startsWith(base) ? value.slice(base.length) : value).trim();
    return fresh.length > 24 ? `…${fresh.slice(-24)}` : fresh;
  })();
  const cleanupStt = useCallback(() => {
    try { voiceStreamRef.current?.stop(); } catch { /* noop */ }
    voiceStreamRef.current = null;
    setMicAnalyser(null);
    if (sttUnsubRef.current) { sttUnsubRef.current(); sttUnsubRef.current = null; }
    sttStreamIdRef.current = null;
  }, []);
  useEffect(() => () => cleanupStt(), [cleanupStt]);
  /* 结束录音 (手动点 or 说完静音自动触发) — 停采集 + 通知网关收尾, 等 final/close 回 idle. */
  const stopMic = useCallback(async () => {
    try { voiceStreamRef.current?.stop(); } catch { /* noop */ }
    voiceStreamRef.current = null;
    setMicAnalyser(null);
    setMicState((s) => (s === 'recording' ? 'transcribing' : s));
    const id = sttStreamIdRef.current;
    if (id) { try { await window.neox?.sttStreamStop?.(id); } catch { /* noop */ } }
    setTimeout(() => setMicState((s) => (s === 'transcribing' ? 'idle' : s)), 4000);
  }, []);
  const toggleMic = useStableCallback(async () => {
    if (micState === 'transcribing') return;
    if (micState === 'recording') { void stopMic(); return; }
    if (await voiceReadiness() === 'setup') {
      setVoiceSetupOpen(true);
      return;
    }
    try {
      const res = await window.neox?.sttStreamStart?.();
      if (!res?.ok || !res.streamId) {
        /* 兜底错误引导: 主进程给的 error 已足够精确 (e.g. "讯飞未配置...");
         * 若前端拿到"需要登录 NeoxCloud"提示 → probe 一次给用户看全景, 提示如何切 BYOK */
        let msg = res?.error || (isZh ? '无法启动语音识别' : 'Failed to start speech recognition');
        if (/登录|NeoxCloud|订阅|sign in/i.test(msg)) {
          try {
            const probe: any = await (window.neox as any)?.sttProbeProviders?.();
            const av = probe?.avail || {};
            const has = av.xfyun || av.local || av.custom;
            if (!has) {
              msg = getEditionHook('hasAccount')
                ? (isZh
                  ? '语音输入未配置: 官方需登录; BYOK 可去 设置 → 语音 → 讯飞 / 自定义 (OpenAI 兼容) / 本地 任选一路配置'
                  : 'Voice input unavailable: official STT needs sign-in; BYOK options in Settings → Voice (Xfyun / Custom / Local).')
                : (isZh
                  ? '语音输入未配置: 去 设置 → 语音 → 讯飞 / 自定义 (OpenAI 兼容) / 本地 任选一路配置'
                  : 'Voice input not set up: pick one in Settings → Voice (Xfyun / Custom OpenAI-compatible / Local).');
            } else {
              msg = isZh
                ? `已有可用 BYOK 引擎 (${[av.xfyun && '讯飞', av.local && '本地', av.custom && '自定义'].filter(Boolean).join(' / ')}), 但当前选中"官方"。去 设置 → 语音 → Provider 切换`
                : `BYOK engines available (${[av.xfyun && 'Xfyun', av.local && 'Local', av.custom && 'Custom'].filter(Boolean).join(' / ')}), but "official" selected. Change in Settings → Voice.`;
            }
          } catch { /* ignore probe error */ }
        }
        dispatchOpFailed({ op: isZh ? '语音输入' : 'Voice input', message: msg });
        return;
      }
      const streamId = res.streamId;
      sttStreamIdRef.current = streamId;
      sttBaseRef.current = textareaRef.current?.value ?? value;
      sttUnsubRef.current = window.neox?.onSttStreamEvent?.((data) => {
        if (data.streamId !== streamId) return;
        if ((data.type === 'transcript' || data.type === 'final') && data.text) {
          const base = sttBaseRef.current;
          setValue(base ? (base.endsWith(' ') ? base : base + ' ') + data.text : data.text);
        }
        if (data.type === 'final') {
          const cur = (textareaRef.current?.value ?? '').trim();
          if (cur) {
            /* 关键词表 — 常用中文口语 + 英文兜底. 尾部标点空格容忍. */
            const CANCEL_RE = /[，。、\s]*(撤回|不发了|算了|取消|不要了|重新说|重来|作废|删了|cancel|scratch that)[。！？!?.\s]*$/i;
            const SEND_RE = /[，。、\s]*(发送吧|发送出去|发出去|就这样发|发送|发出|发它|发一下|OK发送|okay send|send it|please send|send)[。！？!?.\s]*$/i;
            if (CANCEL_RE.test(cur)) {
              setValue('');
              sttBaseRef.current = '';
              dispatchHint(isZh ? '🎙️ 已撤回' : '🎙️ Cancelled', 'info');
              cleanupStt();
              setMicState('idle');
              return;
            }
            const sendMatch = cur.match(SEND_RE);
            if (sendMatch) {
              const cleaned = cur.slice(0, cur.length - sendMatch[0].length).trim();
              if (cleaned) {
                /* 直接调 onSubmit prop, 不经过 submit() 那条历史/streaming 分支路径 —
                 * 语音场景不需要历史累积, 也不该被 streaming 挡; 若 streaming 且有 onInject 走排队. */
                setValue('');
                if (textareaRef.current) textareaRef.current.style.height = '';
                if (streaming && onInject) {
                  const imgs = collectInjectImages();
                  onInject(cleaned, imgs.length > 0 ? imgs : undefined);
                  clearAttachmentsAfterSend();
                } else if (!streaming) {
                  onSubmit?.(cleaned);
                }
                dispatchHint(isZh ? '🎙️ 已发送' : '🎙️ Sent', 'info');
                cleanupStt();
                setMicState('idle');
                return;
              }
            }
          }
          cleanupStt();
          setMicState('idle');
          requestAnimationFrame(() => textareaRef.current?.focus());
        } else if (data.type === 'close') {
          cleanupStt();
          setMicState('idle');
          requestAnimationFrame(() => textareaRef.current?.focus());
        } else if (data.type === 'error') {
          dispatchOpFailed({ op: isZh ? '语音识别' : 'Speech recognition', message: data.message || (isZh ? '识别失败' : 'Recognition failed') });
          cleanupStt();
          setMicState('idle');
        }
      }) || null;
      /* onSilence: 说完静音 1.5s 自动结束, 不用手动再点 (用户选的体验). */
      voiceStreamRef.current = await startVoiceStream(
        (chunk) => { window.neox?.sttStreamAudio?.(streamId, chunk); },
        { silenceMs: 1500, onSilence: () => { void stopMic(); } },
      );
      setMicAnalyser(voiceStreamRef.current.analyser);
      setMicState('recording');
    } catch (err: any) {
      dispatchOpFailed({
        op: isZh ? '语音输入' : 'Voice input',
        message: err?.name === 'NotAllowedError'
          ? (isZh ? '麦克风权限被拒绝' : 'Microphone permission denied')
          : (err?.message || (isZh ? '无法启动麦克风' : 'Failed to start microphone')),
      });
      cleanupStt();
      setMicState('idle');
    }
  });

  /* 麦克风键: 标准态在左侧工具条, 简约态在右侧发送键旁边 —— 同一颗, 只是图标大小不同 */
  const renderMicButton = (iconSize: number) => (voiceInputOn ? (
    <button
      type="button"
      className={`atl-composer__iconbtn voice-input-btn voice-input-btn--${micState}`}
      title={
        micState === 'recording' ? (isZh ? '点击结束并识别 (⌘⇧M)' : 'Tap to stop & transcribe (⌘⇧M)')
        : micState === 'transcribing' ? (isZh ? '识别中…' : 'Transcribing…')
        : (isZh ? '语音输入 (⌘⇧M)' : 'Voice input (⌘⇧M)')
      }
      aria-label={isZh ? '语音输入' : 'Voice input'}
      onClick={() => void toggleMic()}
      disabled={micState === 'transcribing' || cloudReadonly}
    >
      <svg width={iconSize} height={iconSize} viewBox="0 0 20 20" fill="none">
        <rect x="7.5" y="2.5" width="5" height="9" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="M5 9a5 5 0 0010 0M10 14.5V17M7.5 17h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  ) : null);

  /* toggleMicRef: 唤醒词 wake 事件回调需要在 toggleMic 定义前的 useEffect 里引用它,
   * 用 ref 打破依赖顺序 (React 常规模式). */
  const toggleMicRef = useRef<typeof toggleMic | null>(null);
  useEffect(() => { toggleMicRef.current = toggleMic; }, [toggleMic]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'm' || e.key === 'M')) {
        /* 语音输入关着时这个快捷键不该有任何反应 —— 按钮都没有 (hideVoice={!voiceInputOn}),
         * 按了却开始录音 = 藏了一个看不见的功能, 而且是**打开麦克风**这种。
         *
         * 开关关着就当这个快捷键不存在, 连 preventDefault 都不做
         * (那是系统/其它应用的按键, 我们没理由吞它)。 */
        if (!voiceInputOn) return;
        e.preventDefault();
        void toggleMic();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleMic, voiceInputOn]);

  /* 正在编辑哪一条用户消息 (null = 普通发送)。见下面 neox:composer:edit-message 的说明。 */
  const [editingEntry, setEditingEntry] = useState<{ id: string; ordinal: number } | null>(null);
  const cancelEditing = useCallback(() => {
    setEditingEntry(null);
    setValue('');
    requestAnimationFrame(adjust);
  }, [adjust]);

  useEffect(() => {
    const onPrefill = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (typeof text !== 'string') return;
      if (!isVisible()) return;   /* 隐藏那份不吃事件, 否则两个输入框会被同时填 */
      setValue(text);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) { el.focus(); el.setSelectionRange(text.length, text.length); }
        adjust();
      });
    };
    window.addEventListener('neox:composer:prefill', onPrefill as EventListener);
    return () => window.removeEventListener('neox:composer:prefill', onPrefill as EventListener);
  }, [adjust, isVisible]);

  useEffect(() => {
    const onEdit = (e: Event) => {
      const d = (e as CustomEvent<{ entryId?: string; text?: string; ordinal?: number; images?: Array<{ name?: string; data: string }> }>).detail;
      if (!d?.entryId || typeof d.text !== 'string') return;
      if (!isVisible()) return;
      setEditingEntry({ id: d.entryId, ordinal: d.ordinal ?? 0 });
      setValue(d.text);
      /* 原消息的图一起回来, 不然「编辑并重发」发出去就少了图 */
      for (const im of d.images ?? []) {
        if (!im.data?.startsWith('data:')) continue;
        addAttachment({ id: makeId('img'), type: 'image', name: im.name || 'image.png', data: im.data });
      }
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) { el.focus(); el.setSelectionRange(d.text!.length, d.text!.length); }
        adjust();
      });
    };
    window.addEventListener('neox:composer:edit-message', onEdit as EventListener);
    return () => window.removeEventListener('neox:composer:edit-message', onEdit as EventListener);
  }, [adjust, isVisible, addAttachment]);

  /* 换会话就取消编辑态 (entryId 是上一个会话的) —— 已并进上面的切会话处理 */

  /* 值变化 → 存 draft */
  useEffect(() => {
    /* 占位词被删掉的那段原文随之丢弃 (发完清空输入框时整张表也就清了) */
    pastesRef.current = prunePastes(value, pastesRef.current);
    const draftKey = draftKeyRef.current;
    if (!draftKey) return;
    try {
      if (value) window.localStorage?.setItem(draftKey, value);
      else window.localStorage?.removeItem(draftKey);
      if (pastesRef.current.size > 0) {
        window.localStorage?.setItem(`${draftKey}:pastes`, JSON.stringify([...pastesRef.current]));
      } else {
        window.localStorage?.removeItem(`${draftKey}:pastes`);
      }
    } catch { /* ignore */ }
    /* 只跟着 value 走 (key 走 ref): 切会话那一帧 value 还是上一个会话的字, 跟着 key 跑就会把它
     * 存进新会话。新会话的字换上来 value 才变, 那时再存。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useJevDraftPrefetch(value);

  /* ---------- 提交 ---------- */
  /* Slash 命令拦截层 — 用户手动敲 /compact /clear 或 /target 子命令时不发给 LLM,
   * 直接调对应 window.neox API. /target <goal> 激活仍走 LLM (由 activate_target 工具自主处理).
   * 返回 true 表示已处理, submit 不再走 chat 分支. */
  /* /target <goal> 的兜底自查 —— 见 handleBuiltinCommand 里 /target 分支的说明。
   * 给足一轮规划的时间再查: 激活是模型在对话过程中调 activate_target 完成的,
   * 查太早会把"还没轮到它"误报成"没进去"。 */
  const scheduleTargetActivationCheck = useCallback((sessionId: string): void => {
    const api = (window as any).neox;
    if (typeof api?.targetCommand !== 'function') return;
    window.setTimeout(() => {
      void (async () => {
        try {
          const r = await api.targetCommand(sessionId, 'status');
          if ((r?.status ?? 'off') !== 'off') return; /* 进去了, 不打扰 */
          /* 这一轮没进目标模式 —— 乐观药丸必须跟着撤, 不然它会一直亮着骗人 */
          clearTargetIntent(sessionId);
          dispatchHint(
            isZh
              ? '这一轮没有进入目标模式 (Target: off) — 不会有目标横幅和分块进度。可以再发一次 /target，或就当普通任务继续。'
              : 'Target mode was not activated this round (Target: off) — no goal banner or block progress. Send /target again, or just continue as a normal task.',
            'warning',
          );
        } catch { /* 查不到就别拿不确定的事去烦用户 */ }
      })();
    }, TARGET_ACTIVATION_GRACE_MS);
  }, [isZh]);

  const handleBuiltinCommand = useStableCallback((rawText: string): boolean => {
    const t = rawText.trim();
    const sid = activeSessionIdForQueue;
    if (!sid) return false;
    const api = (window as any).neox;
    if (t === '/compact') {
      if (typeof api?.compactSession !== 'function') return false;
      void api.compactSession(sid).catch((e: any) => console.error('[/compact] failed:', e));
      return true;
    }
    if (t === '/clear') {
      if (typeof api?.clearSession !== 'function') return false;
      void confirmAndClearSession(sid, isZh);
      return true;
    }
    if (t.startsWith('/target')) {
      if (typeof api?.targetCommand !== 'function') return false;
      const rest = t.slice('/target'.length).trim();
      if (!rest) return false; // 空 /target 交 LLM
      const [sub, ...restParts] = rest.split(/\s+/);
      const subCmd = sub.toLowerCase();
      const arg = restParts.join(' ').trim();
      const known = new Set(['status', 'off', 'pause', 'continue', 'resume', 'refine']);
      if (!known.has(subCmd)) {
        void api.targetCommand(sid, 'consent').catch(() => { /* 授权失败不该挡住发消息 */ });
        scheduleTargetActivationCheck(sid);
        return false;
      }
      void api.targetCommand(sid, subCmd, arg || undefined)
        .then((result: any) => {
          if (!result) {
            dispatchHint(`/target ${subCmd}: (无返回)`, 'warning');
            return;
          }
          if (result.ok === false) {
            if ((subCmd === 'continue' || subCmd === 'resume') && result.status === 'active') {
              dispatchHint(
                isZh
                  ? '目标已经是「进行中」—— 直接发一条消息（比如「接着做下一阶段」）就能推进这一轮。'
                  : 'Target is already active — just send a message (e.g. "continue with the next phase") to push it forward.',
                'info',
              );
              return;
            }
            dispatchHint(`/target ${subCmd} 失败: ${result.error || '(未知)'}`, 'warning');
            return;
          }
          // status: 展示完整状态摘要 (多行文本 -> 一段简洁 hint, 复杂细节看 timeline banner)
          if (subCmd === 'status') {
            const st = result.status || 'off';
            if (st === 'off') {
              dispatchHint('Target: off (当前无激活目标)', 'info');
              return;
            }
            const parts: string[] = [`Target · ${st}`];
            if (result.plan?.target) {
              const targetTxt = String(result.plan.target).slice(0, 80);
              parts.push(`目标: ${targetTxt}${result.plan.target.length > 80 ? '…' : ''}`);
            }
            if (result.plan?.sub_missions?.length) {
              parts.push(`sub-missions: ${result.plan.sub_missions.length} 项`);
            }
            if (result.lastDoneCheck) {
              parts.push(`上次自查: done=${result.lastDoneCheck.done} · ${String(result.lastDoneCheck.reason ?? '').slice(0, 60)}`);
            }
            if (result.abandonReason) {
              parts.push(`abandon: ${String(result.abandonReason).slice(0, 60)}`);
            }
            dispatchHint(parts.join(' · '), 'info');
            return;
          }
          // 其他子命令 (off / pause / continue / refine): 状态转换成功即报 success
          /* pause 只是把状态位翻成 paused, 当前这一步会跑完 (故意的: 半路掐断会留下写了一半的文件)。
           * 所以还在跑的时候不能说"已暂停" —— 用户点完看着它继续改文件, 就是"控制不住"的感觉。
           * 跟横幅同一套说法。 */
          const stillWorking = subCmd === 'pause' && streaming;
          const stateMsg: Record<string, string> = {
            off:       'Target mode 已退出',
            pause:     stillWorking
              ? 'Target 会在本轮结束后暂停 · 正在收尾当前这一步'
              : 'Target 已暂停 · 发消息说「继续」恢复',
            continue:  'Target 已恢复 · 下一条 chat 继续',
            resume:    'Target 已恢复 · 下一条 chat 继续',
            refine:    'Target 目标已更新',
          };
          dispatchHint(stateMsg[subCmd] || `/target ${subCmd} 已执行`, 'success');
        })
        .catch((e: any) => {
          console.error(`[/target ${subCmd}] failed:`, e);
          dispatchOpFailed({ op: `/target ${subCmd}`, message: e?.message || String(e) });
        });
      return true;
    }
    return false;
  });

  /* 连点/双击提交去重用的 ref (见 submit 内的说明) */
  const lastSubmitRef = useRef<{ text: string; sessionId: string | null; at: number } | null>(null);
  const submit = useCallback(() => {
    /* 以 DOM 为准: 组字刚结束那一帧 React state 可能还是旧的, 受控改非受控后更是这样.
     * 长粘贴的占位词在这里换回原文 —— 之后所有分支 (插话 / 编辑重发 / 普通发送) 拿到的都是全文。 */
    const t = expandPastes((textareaRef.current?.value ?? value).trim(), pastesRef.current);
    if (!t) {
      /* 输入框空 + 手上有待发送 = 用户按的第二次回车 → 强制插进正在跑的这一轮.
       * (第一次回车把文字挪成了药丸, 输入框正好是空的, 所以"回车两次"就是这条路。) */
      if (streaming && draftQueue.length > 0) flushDrafts();
      return;
    }
    /* Compare the actual submitted text within this session, never stale React state.
     * Empty-input Enter above must remain available to flush queued messages. */
    const now = Date.now();
    const last = lastSubmitRef.current;
    if (last?.sessionId === activeSessionIdForQueue && last.text === t && now - last.at < 400) return;
    lastSubmitRef.current = { text: t, sessionId: activeSessionIdForQueue, at: now };
    /* 编辑态: 这一发不是"新的一轮", 是"把那一条改掉再从那儿重跑"。
     * 交给 neox:message:edit-resend (三层一起裁), 这里的意图识别/图片直连都不适用。 */
    if (editingEntry) {
      const entryId = editingEntry.id;
      setEditingEntry(null);
      setValue('');
      if (textareaRef.current) textareaRef.current.style.height = '';
      requestAnimationFrame(adjust);
      window.dispatchEvent(new CustomEvent('neox:message:edit-resend', {
        detail: { entryId, text: t },
      }));
      return;
    }
    {
      const sid = activeSessionIdForQueue;
      const api = (window as any).neox;
      if (sid && typeof api?.targetCommand === 'function') {
        void api.targetCommand(sid, 'remember', t).catch(() => { /* 留档失败不挡发消息 */ });
        if (TARGET_INTENT_RE.test(t)) {
          void api.targetCommand(sid, 'consent').catch(() => { /* 授权失败不挡发消息 */ });
          /* 药丸立刻亮 —— 真激活要等模型那一轮, 中间的空档不能让用户以为没生效。
           * 宽限窗过了还是 off, 下面 scheduleTargetActivationCheck 会把它撤掉。 */
          markTargetIntent(sid);
        }
      }
    }
    /* 意图 chip 快捷命令 — "/图片 <描述>" or "/image <desc>" 一次挂 chip + 立发直连. */
    const imageIntent = /^\/(?:图片|image)(?:\s+|$)/i.exec(t);
    if (imageIntent) {
      const rest = t.slice(imageIntent[0].length).trim();
      if (!activeIntentIds.includes('create-image')) {
        setActiveIntentIds(prev => [...prev, 'create-image']);
      }
      if (!rest) {
        setValue('');
        if (textareaRef.current) textareaRef.current.style.height = '';
        requestAnimationFrame(adjust);
        return;
      }
      /* 有 desc: 走直连图片模式 (bypass LLM). timeline 靠 emitDirectImageTurn 事件挂 UI 卡. */
      if (historyRef.current[0] !== rest) {
        historyRef.current = [rest, ...historyRef.current].slice(0, MAX_HISTORY);
      }
      setHistIdx(-1);
      runDirectImageMode(rest);
      setValue('');
      if (textareaRef.current) textareaRef.current.style.height = '';
      requestAnimationFrame(adjust);
      return;
    }
    /* chip 挂着 (通过 + 号菜单 or 别处激活) 且直接敲文本 → 也走直连 (跟 /图片 一样体验). */
    if (activeIntentIds.includes('create-image')) {
      if (historyRef.current[0] !== t) {
        historyRef.current = [t, ...historyRef.current].slice(0, MAX_HISTORY);
      }
      setHistIdx(-1);
      runDirectImageMode(t);
      setValue('');
      if (textareaRef.current) textareaRef.current.style.height = '';
      requestAnimationFrame(adjust);
      return;
    }
    /* 内置命令拦截 — /compact /clear 直接调 window.neox API, 不发给 LLM (省 token 且真生效). */
    if (handleBuiltinCommand(t)) {
      setValue('');
      if (textareaRef.current) textareaRef.current.style.height = '';
      requestAnimationFrame(adjust);
      return;
    }
    if (activeModelVision === false && attachments.some((a) => (a as any).type === 'image')) {
      dispatchHint(
        isZh
          ? `当前模型「${activeModel?.name ?? ''}」不支持图片输入 —— 这条发出去必然失败。换一个带「图片输入」标记的模型, 或先移除图片附件。`
          : `The current model does not accept image input — this message would fail. Switch to a model marked "Image input", or remove the image attachment.`,
        'warning',
      );
      return;
    }
    /* 运行中回车: 交给引擎排在**这一轮全部结束之后** (见 draftQueue), 输入框上方出药丸。
     * 输入框随即空出来; 再按一次回车 (或药丸「立即插入」) 才是硬插。 */
    if (streaming) {
      if (!onInject) return;
      if (historyRef.current[0] !== t) {
        historyRef.current = [t, ...historyRef.current].slice(0, MAX_HISTORY);
      }
      setHistIdx(-1);
      const injectImgs = collectInjectImages();
      const imgs = injectImgs.length > 0 ? injectImgs : undefined;
      setDraftQueue((d) => [...d, { text: t, images: imgs }]);
      onInject(t, imgs, { when: 'turn-end' });
      clearAttachmentsAfterSend();
      setValue('');
      if (textareaRef.current) textareaRef.current.style.height = '';
      requestAnimationFrame(adjust);
      return;
    }
    /* 推入历史 (去重相邻) */
    if (historyRef.current[0] !== t) {
      historyRef.current = [t, ...historyRef.current].slice(0, MAX_HISTORY);
    }
    setHistIdx(-1);
    /* 意图 chip 装饰: chip.instruction 拼在 t 前, LLM 看到会优先按意图行事 (如调 generate_image). */
    const decorated = decorateMessageWithIntents(t, activeIntentIds);
    /* 发完不清 chip — 用户可能想连续出多张图, 手动 × 关掉才复位. */
    setValue('');
    setQueuedRestoredAt(null);
    /* 首页发第一条会建出新会话 → 切会话处理别把首页这份 (马上发走的图) 存回去 */
    if (!activeSession) sentFromHomeRef.current = true;
    onSubmit?.(decorated);
    if (textareaRef.current) textareaRef.current.style.height = '';
    requestAnimationFrame(adjust);
    /* draftQueue / flushDrafts 必须在依赖里 —— 少了它们, submit 闭包里的 draftQueue
     * 永远是建立这个 callback 那一刻的旧值 (空数组), "第二次回车插入"判定恒为假。 */
  }, [value, streaming, onInject, onSubmit, adjust, activeSessionIdForQueue, handleBuiltinCommand, activeIntentIds, runDirectImageMode, editingEntry, activeModelVision, attachments, activeModel?.name, isZh, draftQueue, flushDrafts]);


  const stop = useStableCallback(() => {
    void interruptCurrent();
  });

  useEffect(() => {
    if (!streaming) return;
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      if (!isVisible()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [contenteditable="true"]'))) return;
      if (isBlockingOverlayOpen()) return;
      e.preventDefault();
      stop();
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [streaming, isVisible, stop]);

  /* ---------- 统一 trigger 扫描 · @/ # ----------
   * @ : 文件 / 文件夹 / 最近 (workspace listFiles + recent 缓存)
   * / : slash 命令 (skillsList)
   * # : 当前打开的 tab / active 选中
   */
  const closeTriggers = useCallback(() => {
    setTriggerKind(null);
    setTriggerQuery('');
    setAtItems([]);
    setSlashItems([]);
    setHashItems([]);
  }, []);

  const scanTrigger = useCallback((val: string, cursor: number): { kind: 'at' | 'slash' | 'hash'; query: string } | null => {
    const before = val.slice(0, cursor);
    /* @ 保持旧规则 (向后兼容): 紧跟字符即可; `:` 不在 @ 字符集里, 所以 @skill:xxx
     * 一旦打了冒号就不会再触发 */
    const atM = before.match(/@([\w./\-]*)$/);
    if (atM) return { kind: 'at', query: atM[1] };
    /* / 仅在行首 / 空白后 */
    const slashM = before.match(/(?:^|\s)\/([\w-]*)$/);
    if (slashM) return { kind: 'slash', query: slashM[1] };
    /* # 仅在行首 / 空白后 */
    const hashM = before.match(/(?:^|\s)#([\w./\-]*)$/);
    if (hashM) return { kind: 'hash', query: hashM[1] };
    return null;
  }, []);

  const recentScope = recentScopeOf({
    isCloud: activeIsCloud,
    sessionId: activeSession?.id,
    workspacePath,
  });

  const loadRecentFiles = useStableCallback((): AtItem[] => {
    if (!recentScope) return [];
    try {
      const raw = window.localStorage?.getItem(RECENT_FILES_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw) as RecentFileEntry[];
      return filterRecentByScope(arr || [], recentScope)
        .slice(0, RECENT_FILES_MAX)
        .map((r) => ({ kind: 'recent' as const, name: r.name, path: r.path }));
    } catch { return []; }
  });

  const pushRecentFile = useCallback((name: string, path: string) => {
    if (!recentScope) return;
    try {
      const raw = window.localStorage?.getItem(RECENT_FILES_KEY);
      const arr: RecentFileEntry[] = raw ? JSON.parse(raw) : [];
      /* 去重按 (域, 路径) —— 不同域下同名同路径几乎不可能, 但云 pod 里 `./src/a.ts`
       * 这种相对路径在两个 pod 之间是会撞的。 */
      const filtered = arr.filter((r) => !(r.path === path && (r.ws ?? '') === recentScope));
      filtered.unshift({ name, path, ws: recentScope });
      /* 上限按**全表**算, 不按域算: 这是一份 localStorage 缓存, 域多了也不该无限长。 */
      window.localStorage?.setItem(RECENT_FILES_KEY, JSON.stringify(filtered.slice(0, RECENT_FILES_MAX * 4)));
    } catch { /* ignore */ }
  }, [recentScope]);

  const updateTriggers = useStableCallback(async (val: string, cursor: number) => {
    const t = scanTrigger(val, cursor);
    if (!t) { closeTriggers(); return; }
    setTriggerKind(t.kind);
    setTriggerQuery(t.query);
    setTriggerIdx(0);

    if (t.kind === 'at') {
      const api = (window as any).neox;
      const sessionId = activeSession?.id;
      const contextItems = buildContextAtItems(t.query, isZh);
      /* cloud 会话: 列 pod workspace, 不是本机 fs.  pod 不存在 / sessionId 缺失会 fallback recent. */
      if (activeIsCloud && sessionId && typeof api?.cloudSession?.fsList === 'function') {
        try {
          const r = await api.cloudSession.fsList(sessionId, '.', 500);
          if (r?.ok && Array.isArray(r.items)) {
            const filtered = t.query
              ? r.items.filter((it: any) => String(it.name ?? '').toLowerCase().includes(t.query.toLowerCase()))
              : r.items;
            const files: AtItem[] = filtered
              .filter((it: any) => it.type === 'file')
              .slice(0, 10)
              .map((it: any) => ({ kind: 'file' as const, name: it.name, path: it.path }));
            const folders: AtItem[] = filtered
              .filter((it: any) => it.type === 'dir')
              .slice(0, 4)
              .map((it: any) => ({ kind: 'folder' as const, name: it.name, path: it.path }));
            const recent = !t.query ? loadRecentFiles().slice(0, 4) : [];
            const merged = [...contextItems, ...recent, ...folders, ...files];
            const seen = new Set<string>();
            setAtItems(merged.filter((x) => (seen.has(x.path) ? false : (seen.add(x.path), true))));
            return;
          }
        } catch { /* 失败 fallback 到 recent */ }
        setAtItems([...contextItems, ...loadRecentFiles()]);
        return;
      }
      /* 无 workspace: 上下文芯片 + recent */
      if (typeof api?.listFiles !== 'function' || !workspacePath) {
        setAtItems([...contextItems, ...loadRecentFiles()]);
        return;
      }
      try {
        const all: FileSuggestion[] = t.query
          ? await (async () => {
            const r = await api.searchFiles?.(t.query, { maxResults: 40 });
            /* 返回形状是 { file, type } —— 跟 file:list 的 { name, path, isDirectory } 不同, 这里归一 */
            return (r?.files ?? []).map((f: { file: string; type?: string }) => {
              const p = f.file;
              return {
                name: p.split('/').pop() ?? p,
                path: p.startsWith('/') ? p : `${workspacePath}/${p}`,
                isDirectory: f.type === 'directory',
              } as FileSuggestion;
            });
          })()
          : ((await api.listFiles(workspacePath, '**/*'))?.files ?? []);
        const files: AtItem[] = all.filter((f) => !f.isDirectory).slice(0, 10).map((f) => ({ kind: 'file' as const, name: f.name, path: f.path }));
        const folders: AtItem[] = all.filter((f) => f.isDirectory).slice(0, 4).map((f) => ({ kind: 'folder' as const, name: f.name, path: f.path }));
        const recent = !t.query ? loadRecentFiles().slice(0, 4) : [];
        /* 顺序: @git/@codebase → recent → folder → file */
        const merged = [...contextItems, ...recent, ...folders, ...files];
        const seen = new Set<string>();
        setAtItems(merged.filter((x) => (seen.has(x.path) ? false : (seen.add(x.path), true))));
      } catch {
        setAtItems([...contextItems, ...loadRecentFiles()]);
      }
    } else if (t.kind === 'slash') {
      const api = (window as any).neox;
      const q = t.query.toLowerCase();
      const matchQuery = (s: SlashItem) =>
        !q || s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q);
      /* 内置命令排在最前面 (用户高频), 但要给技能留位置 —— 见 pickSlashItems。
       * description 走 i18n (module-level global). */
      const builtins = buildBuiltinSlashItems()
        .filter((b) => (q ? true : !TARGET_SUB_IDS.has(b.id)))
        .filter(matchQuery);
      if (typeof api?.skillsList !== 'function') {
        setSlashItems(builtins.slice(0, SLASH_MAX));
        return;
      }
      try {
        const list = await api.skillsList({ userInvocable: true });
        // description 走 i18n: 英文 UI 优先 description_en, 缺失才 fallback 中文 description.
        const isZh = getGlobalLanguage() === 'zh';
        const skillItems: SlashItem[] = (list ?? [])
          .filter((s: any) => s.source !== 'builtin')
          .filter((s: any) => modeVariant.isSkillVisibleForMode(s.metadata?.neox?.category))
          .map((s: any) => ({
            id: s.id,
            name: s.metadata?.name ?? s.id,
            description: isZh
              ? (s.metadata?.description ?? s.metadata?.description_en)
              : (s.metadata?.description_en ?? s.metadata?.description),
            category: s.metadata?.neox?.category,
          }))
          .filter(matchQuery);
        setSlashItems(pickSlashItems(builtins, skillItems));
      } catch {
        setSlashItems(builtins.slice(0, SLASH_MAX));
      }
    } else if (t.kind === 'hash') {
      const state = editorService?.getState?.();
      const tabs = state?.tabs ?? [];
      const q = t.query.toLowerCase();
      const active = tabs.find((tab) => tab.id === state?.activeTabId);
      const base: HashItem[] = [];
      if (active) {
        base.push({ kind: 'selection', name: (isZh ? `选中代码 · ${active.name}` : `Selection · ${active.name}`) });
        base.push({ kind: 'activeFile', name: (isZh ? `当前文件 · ${active.name}` : `Current file · ${active.name}`), path: active.path });
      }
      const tabItems: HashItem[] = tabs
        .filter((tab) => !active || tab.id !== active.id)
        .map((tab) => ({ kind: 'tab' as const, name: tab.name, path: tab.path, tabId: tab.id }));
      const merged = [...base, ...tabItems].filter((it) => !q || it.name.toLowerCase().includes(q));
      setHashItems(merged.slice(0, 12));
    }
  });

  /* 共用: 把 trigger 前后的 trigger 片段从输入框删掉, 并还原光标 */
  const stripTriggerFragment = useStableCallback((triggerChar: '@' | '/' | '#') => {
    const el = textareaRef.current;
    if (!el) return null;
    const cursor = el.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const startIdx = before.lastIndexOf(triggerChar);
    if (startIdx < 0) return null;
    const after = value.slice(cursor);
    const nextValue = before.slice(0, startIdx) + after;
    setValue(nextValue);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(startIdx, startIdx);
      adjust();
    });
    return startIdx;
  });

  const pickAt = useCallback((item: AtItem) => {
    stripTriggerFragment('@');
    if (item.kind === 'computer' || item.kind === 'browser') {
      closeTriggers();
      addAttachment(buildDriveContextAttachment(item.kind, isZh));
      return;
    }
    if (item.kind === 'git' || item.kind === 'codebase') {
      closeTriggers();
      if (!workspacePath) {
        dispatchHint(isZh ? '需要先打开工作区才能挂 @git / @codebase' : 'Open a workspace first for @git / @codebase');
        return;
      }
      void (async () => {
        const att = item.kind === 'git'
          ? await fetchGitContextAttachment(workspacePath)
          : await fetchCodebaseContextAttachment(workspacePath);
        if (!att) {
          dispatchOpFailed({
            op: item.name,
            message: isZh ? `无法生成 ${item.name} 上下文` : `Failed to build ${item.name} context`,
          });
          return;
        }
        addAttachment(att);
      })();
      return;
    }
    const ext = (item.path.match(/\.([\w]+)$/)?.[1] ?? '').toLowerCase();
    if (item.kind === 'folder') {
      /* folder 作为 path hint 插入 prompt, 不走附件 */
      setValue((v) => `${item.path}/ ${v}`);
    } else {
      addAttachment({
        id: makeId('file'),
        type: 'file',
        data: '',
        name: item.name,
        path: item.path,
        language: ext || undefined,
      });
      pushRecentFile(item.name, item.path);
    }
    closeTriggers();
  }, [stripTriggerFragment, addAttachment, closeTriggers, pushRecentFile, workspacePath, isZh]);

  const pickSlash = useCallback((item: SlashItem) => {
    stripTriggerFragment('/');
    if (item.builtin) {
      /* 无参数命令 (compact / clear) — 直接触发 window.neox API, 不 fill 到 input. */
      if (item.builtinAction) {
        const sid = activeSessionIdForQueue;
        if (sid) {
          const api = (window as any).neox;
          if (item.builtinAction === 'compact' && typeof api?.compactSession === 'function') {
            void api.compactSession(sid).catch((e: any) => console.error('[/compact] failed:', e));
          } else if (item.builtinAction === 'clear' && typeof api?.clearSession === 'function') {
            void confirmAndClearSession(sid, isZh);
          }
        }
        closeTriggers();
        return;
      }
      /* 有参数命令 (target / target status / target off): 直接 fill 前缀到 input 顶部,
       * 用户继续输入参数回车触发. 桌面端 submit 里会拦截 /target /compact /clear;
       * /target 走 LLM (通过 activate_target 工具自主处理), /compact /clear 走 window.neox API. */
      const prefix = item.fillPrefix || `/${item.id} `;
      setValue((v) => prefix + v);
      closeTriggers();
      return;
    }
    /* skill: 在 prompt 顶部插入 @skill:id 引用 */
    const ref = `@skill:${item.id}\n`;
    setValue((v) => ref + v);
    closeTriggers();
  }, [stripTriggerFragment, closeTriggers, activeSessionIdForQueue]);

  const pickHash = useCallback(async (item: HashItem) => {
    stripTriggerFragment('#');
    if (item.kind === 'selection') {
      /* 读取 monaco 当前选区 */
      try {
        const mod = await import('monaco-editor');
        const editors = mod.editor.getEditors();
        let found = false;
        for (const ed of editors) {
          const sel = ed.getSelection();
          const model = ed.getModel();
          if (sel && model && !sel.isEmpty()) {
            const text = model.getValueInRange(sel);
            if (text) {
              const state = editorService?.getState?.();
              const active = state?.tabs.find((t) => t.id === state.activeTabId);
              const name = active ? `${active.name}:${sel.startLineNumber}-${sel.endLineNumber}` : `selection:${sel.startLineNumber}-${sel.endLineNumber}`;
              addAttachment({
                id: makeId('sel'),
                type: 'file',
                data: text,
                name,
                path: active?.path,
                preview: text.slice(0, 200),
                lineRange: { start: sel.startLineNumber, end: sel.endLineNumber },
              });
              found = true;
              break;
            }
          }
        }
        if (!found) setPickerError(isZh ? '当前编辑器无选中代码' : 'No selection in the current editor');
      } catch {
        setPickerError(isZh ? '读取选中代码失败' : 'Failed to read the current selection');
      }
    } else {
      /* tab / activeFile — 两种都有 path + name */
      const ext = (item.path.match(/\.([\w]+)$/)?.[1] ?? '').toLowerCase();
      /* 若编辑器里已有 content (dirty or 任意), 直接用内存内容, 否则 data='' 走懒加载 */
      const state = editorService?.getState?.();
      const openTab = state?.tabs.find((x) => x.path === item.path);
      addAttachment({
        id: makeId('file'),
        type: 'file',
        data: openTab?.content ?? '',
        name: item.name,
        path: item.path,
        language: ext || undefined,
        preview: openTab?.content ? openTab.content.slice(0, 200) : undefined,
      });
      pushRecentFile(item.name, item.path);
    }
    closeTriggers();
  }, [stripTriggerFragment, addAttachment, closeTriggers, editorService, pushRecentFile]);

  const pickActive = useCallback(() => {
    if (triggerKind === 'at' && atItems[triggerIdx]) pickAt(atItems[triggerIdx]);
    else if (triggerKind === 'slash' && slashItems[triggerIdx]) pickSlash(slashItems[triggerIdx]);
    else if (triggerKind === 'hash' && hashItems[triggerIdx]) void pickHash(hashItems[triggerIdx]);
  }, [triggerKind, triggerIdx, atItems, slashItems, hashItems, pickAt, pickSlash, pickHash]);

  const activeItemsLen = triggerKind === 'at' ? atItems.length : triggerKind === 'slash' ? slashItems.length : triggerKind === 'hash' ? hashItems.length : 0;

  /* ---------- 键盘 ---------- */
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    /* Windows IME: 组字中的方向键/Enter/Tab 是给候选框的。Process 是 TSF 占位键。
     * 这里 preventDefault 会让输入法「按了没反应」, 之后停在英文。 */
    if (e.nativeEvent.isComposing || e.key === 'Process') return;

    /* 1) trigger 补全 active 时接管 (@ / #) */
    if (triggerKind !== null && activeItemsLen > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setTriggerIdx((i) => Math.min(i + 1, activeItemsLen - 1)); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setTriggerIdx((i) => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickActive();
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); closeTriggers(); return; }
    }

    /* P1-13: streaming 时 Esc 触发"温柔停"(等同 stop 按钮第一下) — 跟 IDE 直觉对齐.
     *   stop() 内部两段: 第一次 pause, 3s 内再次 = interrupt. Esc 让用户少抬手到 stop 按钮.
     *   仅在 textarea 空且无 trigger active 时生效, 防破坏正常 textarea 编辑. */
    if (e.key === 'Escape' && streaming && triggerKind === null) {
      e.preventDefault();
      stop();
      return;
    }

    /* 2) 空输入下 ↑ / ↓ 翻历史 */
    if (triggerKind === null && historyRef.current.length > 0) {
      if (e.key === 'ArrowUp' && value.length === 0 && !e.shiftKey) {
        e.preventDefault();
        const next = Math.min(histIdx + 1, historyRef.current.length - 1);
        setHistIdx(next);
        setValue(historyRef.current[next] ?? '');
        requestAnimationFrame(adjust);
        return;
      }
      if (e.key === 'ArrowDown' && histIdx >= 0 && !e.shiftKey) {
        e.preventDefault();
        const next = histIdx - 1;
        setHistIdx(next);
        setValue(next < 0 ? '' : historyRef.current[next] ?? '');
        requestAnimationFrame(adjust);
        return;
      }
    }

    /* 3) Enter: 有内容发送, 空输入滚底 */
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const live = (textareaRef.current?.value ?? value).trim();
      if (live.length === 0) {
        /* 也要过 needsProviderSetup 这道闸 —— 没配来源时理论上根本跑不起来 (streaming
         * 不可能为真), 但"回车这条路一律先过检查"是那条闸的原意, 不给它开例外。 */
        if (streaming && draftQueue.length > 0 && !needsProviderSetup) { submit(); return; }
        const feed = document.querySelector('.atl-feed') as HTMLElement | null;
        if (feed) feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
        return;
      }
      if (needsProviderSetup) return;
      submit();
    }
  };

  /* ---------- 输入变化 ---------- */
  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    valueRef.current = next;
    /* 组字中只记 DOM, 不 setState / 不量高 / 不跑 @# 触发器 —— 那些都会重绘。 */
    if (composingRef.current) return;
    setValue(next);
    /* 输入视为离开历史浏览态 */
    if (histIdx >= 0) setHistIdx(-1);
    adjust();
    void updateTriggers(next, e.target.selectionStart ?? next.length);
  };

  /* ---------- 附件 intake (文件 → Attachment) ---------- */
  const intake = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files);
      if (arr.length === 0) return;
      if (activeModelVision === false && arr.some((f) => (f.type || '').startsWith('image/'))) {
        dispatchHint(
          isZh
            ? `当前模型「${activeModel?.name ?? ''}」不支持图片输入 —— 它看不到你贴的图。换一个带「图片输入」标记的模型再发。`
            : `The current model does not accept image input — it will not see this picture. Switch to a model marked "Image input".`,
          'warning',
        );
      }
      const queue = arr;
      let rejected = 0;
      for (const file of queue) {
        try {
          /* 文档 (PDF/Word/Excel/CSV/PPT) — 走 NeoxCloud /document/parse 解析成 markdown.
           * 不在客户端装 pdfjs/mammoth/xlsx 等库 (~1.5MB), 也不让 LLM 跑 Python.
           * 失败时 (未登录 / 网络 / 不支持 / 大小超限) — 在 toast 中提示, 跳过此文件继续后面的. */
          if (isParseableDocument(file)) {
            if (file.size > MAX_DOCUMENT_BYTES) { rejected++; continue; }

            /* 用户拖文件时顺手自动打开对应 surface (除了走文档解析喂 agent).
             *   依赖 electron File.path — browser-only drop 没这个字段, 跳过 (用户后续可手动开).
             *   ext 由 openSurfaceFromPath 内部 EXT_TO_KIND 判定:
             *     S1 D2: xlsx/xls/csv/tsv → sheet
             *     P0   : pdf → pdf
             *     P1   : docx/doc → docx (Word 只读) */
            const filePath = pathOfFile(file);
            if (filePath && activeSession?.id && getPanelLayout() !== 'tabs') {
              const ext = file.name.split('.').pop()?.toLowerCase();
              if (ext && ['xlsx', 'xls', 'csv', 'tsv', 'pdf', 'docx', 'doc'].includes(ext)) {
                openSurfaceFromPath({
                  sessionId: activeSession.id,
                  path: filePath,
                  workspacePath,
                });
              }
            }

            const id = makeId('doc');
            /* v2 (Files API 范式): 不在 attachment.data 塞全文, 只塞 fileId + summary.
             * agent 用 read_document(fileId) 工具按需读本地缓存, 不重发 LLM. */
            addAttachment({
              id, type: 'file', data: '',
              name: file.name, size: file.size,
              preview: isZh ? '解析中…' : 'Parsing…',
              status: 'parsing' as any,
            } as any);
            try {
              /* parseDocument: 按 settings mode 自动分发 (local 本地 parser / cloud NeoxCloud).
               * 两路径返回结构相同, 都会写本地缓存. */
              const result = await parseDocument(file);
              addAttachment({
                id, type: 'file',
                data: '',   // 空 — 不塞全文, agent 用 read_document 读本地缓存
                name: file.name, size: file.size,
                preview: result.summary || result.markdown.slice(0, 200),
                fileId: result.fileId,
                /* 原文件路径: 翻译要保留图表时 agent 得拿原文件, 见 agentRuntimeHostHelpers 文档附件段 */
                ...(filePath ? { path: filePath } : {}),
                summary: result.summary,
                chars: result.metadata.chars,
                pages: result.metadata.pages,
                channel: result.metadata.channel,
                status: 'parsed' as any,
              } as any);
            } catch (err: any) {
              const errMsg = err?.message || String(err) || (isZh ? '未知错误' : 'Unknown error');
              console.error('[Composer] document parse failed', { file: file.name, err, errMsg });
              addAttachment({
                id, type: 'file', data: '',
                name: file.name, size: file.size,
                preview: isZh ? `❌ 解析失败: ${errMsg}` : `❌ Parse failed: ${errMsg}`,
                status: 'failed' as any,
              } as any);
              const notify = await import('../../components/notifyEvents');
              notify.dispatchOpFailed({ op: isZh ? `解析 ${file.name}` : `Parse ${file.name}`, message: errMsg });
            }
            continue;  // 文档分支结束, 下一个文件
          }

          const limit = isImage(file) ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
          if (file.size > limit) { rejected++; continue; }
          if (isImage(file)) {
            const raw = await readAsDataURL(file);
            /* 归一化到上游收的四种格式 (RELEASE #image-format)。
             * Windows 截图粘贴多为 image/bmp, 直接发上去会被上游 400 拒 ——
             * 而且那个错要等打完一整轮上游才回来, 用户看到的还是一句
             * "请求格式异常, 请刷新或重启客户端"(重启没用)。在这里就转掉。 */
            const norm = await normalizeImageDataUrl(raw);
            if (!norm.ok) {
              const notify = await import('../../components/notifyEvents');
              notify.dispatchOpFailed({
                op: isZh ? `添加图片 ${file.name}` : `Attach ${file.name}`,
                message: unsupportedImageMessage(norm.fromType, isZh),
              });
              continue;
            }
            const data = norm.dataUrl;
            addAttachment({
              id: makeId('img'), type: 'image', data, name: file.name,
              /* 转过码的话原来的 file.size 就不对了 —— 附件条上显示的是这份 dataURL 的实际大小 */
              size: norm.converted ? Math.floor((data.length - data.indexOf(',') - 1) * 0.75) : file.size,
            });
          } else if (isLikelyText(file)) {
            const data = await readAsText(file);
            addAttachment({
              id: makeId('file'), type: 'file', data,
              name: file.name, size: file.size,
              path: pathOfFile(file),
              preview: data.slice(0, 200),
            });
          } else {
            addAttachment({
              id: makeId('file'), type: 'file', data: '',
              name: file.name, size: file.size,
              path: pathOfFile(file),
            });
          }
        } catch (err) {
          /* 区分"超限"(已在上方 size limit 处理) 和"真解析失败" — 后者要 toast 提示, 不然
           *  用户只见到 picker error 合并计数, 分不清是文件坏还是大小问题. */
          console.error('[Composer] read file failed', file.name, err);
          const msg = err instanceof Error ? err.message : String(err);
          void import('../../components/notifyEvents').then((m) =>
            m.dispatchOpFailed({ op: isZh ? `读取附件 ${file.name}` : `Read attachment ${file.name}`, message: msg }),
          );
          rejected++;
        }
      }
      if (rejected > 0) setPickerError(isZh
        ? `${rejected} 个文件超限或解析失败已跳过 (图片 ≤10MB / 文档 ≤50MB / 文本 ≤500KB)`
        : `Skipped ${rejected} file${rejected === 1 ? '' : 's'} that exceeded the limit or failed to parse (images ≤10MB / docs ≤50MB / text ≤500KB)`);
      else setPickerError(null);
    },
    [attachments, addAttachment, activeSession?.id, workspacePath, isZh, activeModelVision, activeModel?.name],
  );

  const handlePick = useCallback(() => {
    fileInputRef.current?.click();
  }, [streaming]);
  pickFileRef.current = handlePick;

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) void intake(files);
    e.target.value = '';
  };

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = () => setDragOver(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);

    const internal = e.dataTransfer?.getData('application/x-neox-files') ?? '';
    if (internal.trim()) {
      let meta: Array<{ path: string; dir?: boolean; name?: string }> = [];
      try { meta = JSON.parse(e.dataTransfer?.getData('application/x-neox-file-meta') || '[]'); } catch { /* 老版本没这条 */ }
      const dirOf = new Map(meta.map((m) => [m.path, !!m.dir]));
      for (const raw of internal.split('\n')) {
        const p = raw.trim();
        if (!p) continue;
        const name = p.split(/[\\/]/).pop() || p;
        if (dirOf.get(p)) {
          setValue((v) => `${p}/ ${v}`);
          continue;
        }
        const ext = (name.match(/\.([\w]+)$/)?.[1] ?? '').toLowerCase();
        addAttachment({
          id: makeId('file'), type: 'file', data: '', name, path: p,
          language: ext || undefined,
        });
        pushRecentFile(name, p);
      }
      return;
    }

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) void intake(files);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    /* 收集所有 file 类型 — 不只 image, 也含 PDF/docx/xlsx/csv/tsv 等文档.
     * 用户在 Finder/Explorer 复制文件 (Cmd+C) 后切到 Composer 粘贴 (Cmd+V)
     * 时, clipboard items 是 File 引用. 一律走 intake, 让 intake 自己路由
     * (image / parseable document / text / 其他) — 跟拖拽 + 文件选择按钮
     * 同一条入口. */
    const pasted: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) pasted.push(f);
      }
    }
    if (pasted.length > 0) {
      e.preventDefault();
      void intake(pasted);
      return;
    }
    const text = e.clipboardData?.getData('text/plain') ?? '';
    const el = textareaRef.current;
    if (el && shouldCollapsePaste(text)) {
      e.preventDefault();
      pasteCounterRef.current += 1;
      const token = pasteToken(pasteCounterRef.current, text, isZh);
      pastesRef.current.set(token, text);
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      const next = `${el.value.slice(0, start)}${token}${el.value.slice(end)}`;
      valueRef.current = next;
      setValue(next);
      requestAnimationFrame(() => {
        const caret = start + token.length;
        el.setSelectionRange(caret, caret);
        adjust();
      });
      return;
    }
    requestAnimationFrame(adjust);
  };

  useEffect(() => {
    const onAttachPath = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { paths?: string[]; dir?: boolean } | undefined;
      const paths = Array.isArray(detail?.paths) ? detail!.paths : [];
      if (paths.length === 0) return;
      for (const p of paths) {
        const name = p.split(/[\\/]/).pop() || p;
        if (detail?.dir) { setValue((v) => `${p}/ ${v}`); continue; }
        const ext = (name.match(/\.([\w]+)$/)?.[1] ?? '').toLowerCase();
        addAttachment({ id: `file:${p}`, type: 'file', data: '', name, path: p, language: ext || undefined });
        pushRecentFile(name, p);
      }
      textareaRef.current?.focus();
    };
    window.addEventListener('neox:composer-attach-path', onAttachPath as EventListener);
    return () => window.removeEventListener('neox:composer-attach-path', onAttachPath as EventListener);
  }, [addAttachment, pushRecentFile]);

  const sessionSurfaces = useSurfaces(activeSessionIdForQueue);
  const activeSurfaceId = useActiveSurfaceId(activeSessionIdForQueue);
  const activeSurface = sessionSurfaces.find((s) => s.id === activeSurfaceId);
  const activeEditorPath = activeSurface?.kind === 'code' && activeSurface.source.type === 'file'
    ? activeSurface.source.path
    : null;
  const [dismissedActivePath, setDismissedActivePath] = useState<string | null>(null);
  /* 代码面板是懒挂载的: 刚开文件那一帧 .sfc-code-wrap 还不在 DOM 里。
   * 右栏开合 / 版面变化都会派 neox:surface-layout —— 借它重查; 换文件后再补查一次。 */
  const [codePaneTick, setCodePaneTick] = useState(0);
  useEffect(() => {
    const bump = () => setCodePaneTick((t) => t + 1);
    window.addEventListener('neox:surface-layout', bump);
    const timer = activeEditorPath ? window.setTimeout(bump, 600) : 0;
    return () => {
      window.removeEventListener('neox:surface-layout', bump);
      if (timer) window.clearTimeout(timer);
    };
  }, [activeEditorPath]);
  useEffect(() => {
    if (!isVisible()) return;
    const existing = attachments.find((a) => a.id === ACTIVE_FILE_ATT_ID);
    const codePane = document.querySelector('.sfc-code-wrap') as HTMLElement | null;
    if (!modeVariant.isCode || !activeEditorPath || !codePane || codePane.offsetParent === null) {
      if (existing) removeAttachment(ACTIVE_FILE_ATT_ID);
      return;
    }
    if (dismissedActivePath === activeEditorPath) return;
    /* 这个文件已经挂了代码片段 (⌘L / 右键) —— 再挂一个「当前文件」是重复的 */
    if (attachments.some((a) => a.id !== ACTIVE_FILE_ATT_ID && a.path === activeEditorPath)) {
      if (existing) removeAttachment(ACTIVE_FILE_ATT_ID);
      return;
    }
    if (existing?.path === activeEditorPath) return;
    const name = activeEditorPath.split(/[\\/]/).pop() || activeEditorPath;
    const ext = (name.match(/\.([\w]+)$/)?.[1] ?? '').toLowerCase();
    addAttachment({
      id: ACTIVE_FILE_ATT_ID,
      type: 'file',
      data: '',
      name: isZh ? `当前文件 · ${name}` : `Current file · ${name}`,
      path: activeEditorPath,
      language: ext || undefined,
    });
  }, [activeEditorPath, dismissedActivePath, attachments, addAttachment, removeAttachment, isVisible, isZh, codePaneTick, modeVariant.isCode]);

  const pendingCodeAskRef = useRef<{ attId: string; prompt: string } | null>(null);
  useEffect(() => {
    const onAttachCode = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as import('../editor/editorAiBridge').ComposerAttachCodeDetail | undefined;
      if (!detail?.code?.text || detail.handled || !isVisible()) return;
      detail.handled = true;
      const { code } = detail;
      const range = code.lineRange ? `${code.lineRange.start}-${code.lineRange.end}` : 'all';
      const attId = `code:${code.path ?? code.name}:${range}`;
      addAttachment({
        id: attId,
        type: 'file',
        data: code.text,
        name: code.name,
        path: code.path,
        language: code.language,
        preview: code.text.slice(0, 200),
        lineRange: code.lineRange,
      });
      if (detail.prompt) {
        if (detail.send && !streaming) {
          pendingCodeAskRef.current = { attId, prompt: detail.prompt };
        } else {
          /* 不自动发 (外部编辑器切过项目) 或正在跑 (不硬插): 把那句话放进输入框, 用户自己决定何时发 */
          setValue(detail.prompt);
          requestAnimationFrame(() => textareaRef.current?.focus());
        }
        return;
      }
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener('neox:composer-attach-code', onAttachCode as EventListener);
    return () => window.removeEventListener('neox:composer-attach-code', onAttachCode as EventListener);
  }, [addAttachment, isVisible, streaming]);
  useEffect(() => {
    const pending = pendingCodeAskRef.current;
    if (!pending || !attachments.some((a) => a.id === pending.attId)) return;
    pendingCodeAskRef.current = null;
    onSubmit?.(pending.prompt);
  }, [attachments, onSubmit]);

  /* ---------- 模型下拉点外关闭 + 打开时立即刷 membership (拿最新模型清单) ---------- */
  useEffect(() => {
    if (!modelOpen) return;
    /* 带 ETag, 没改返 304 几乎零成本 — 保证 admin 改完套餐, 用户点开就看到 */
    void getEditionHook('refreshMembership')();
    const close = () => setModelOpen(false);
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setModelOpen(false); };
    window.addEventListener('click', close as any);
    window.addEventListener('keydown', onKeyDown as any);
    return () => {
      window.removeEventListener('click', close as any);
      window.removeEventListener('keydown', onKeyDown as any);
    };
  }, [modelOpen]);

  /* 从 prompt 里 parse 出 @skill:xxx 引用 */
  const skillRefs = useMemo(() => {
    const matches = value.match(/@skill:([^\s]+)/g);
    if (!matches) return [] as string[];
    return Array.from(new Set(matches.map((m) => m.slice(7))));
  }, [value]);

  const removeSkillRef = useCallback(
    (id: string) => {
      /* 删除 `@skill:id\n?` 整段 */
      setValue((v) => v.replace(new RegExp(`@skill:${escapeRegex(id)}\\n?`, 'g'), '').replace(/\n{3,}/g, '\n\n'));
      requestAnimationFrame(adjust);
    },
    [adjust],
  );

  /* auto 模型按会员等级显示不同 brand 名 — 跟设计图对齐:
   *   pro-plus → Nexus Pro / ultra → Aurora Ultra / elite → Titan Elite / vip → Vertex VIP
   * 实际模型还是 Neox Cloud 'auto' 路由, 这里只是 cosmetic 化名让付费用户感觉更 brand. */
  const planSkinKey = useMemo(() => {
    const k = (membership?.plan?.id ?? '').toLowerCase().replace(/_/g, '-');
    if (k.includes('vip') || k.includes('enterprise')) return 'vip';
    if (k.includes('elite') || k.includes('team')) return 'elite';
    if (k.includes('ultra')) return 'ultra';
    if (k.includes('plus')) return 'pro-plus';
    if (k.includes('pro')) return 'pro';
    return 'free';
  }, [membership?.plan?.id]);
  const modelLabel = useMemo(() => {
    if (isPlaceholderModel) return isZh ? '选择模型' : 'Select model';
    const rawName = activeModel?.name ?? '';
    const isAutoRouted = isAutoRoutedModelName(rawName) || activeModel?.isAutoRouted === true;
    if (isAutoRouted) return getAutoDisplayName(planSkinKey);
    const name = rawName || activeModel?.id || '';
    const pid = activeModel?.providerId ?? '';
    if (name && pid && pid !== 'neox-cloud'
      && pickerModels.some((m) => m.providerId === 'neox-cloud' && m.name === rawName)) {
      return `${name} · BYOK`;
    }
    return name;
  }, [isPlaceholderModel, activeModel, planSkinKey, isZh, pickerModels]);

  /* Phase 2.8+: effort UI 已下放到模型菜单的右侧 fly-out, composer 顶层不再维护
   * selectedModelEffortMultiplier。 */
  const triMode = mode;

  /* 预估本轮发送 (prompt + attachments + skills + 系统固定预算) 会消耗多少 token */
  const pendingTokens = useMemo(() => {
    let t = 0;
    t += estimateTokens(value);
    for (const a of attachments) {
      if (a.data) t += estimateTokens(a.data);
      else if (a.size) t += Math.ceil(a.size / 4);
      else t += 400;  // 路径懒加载: 平均估 400
    }
    t += skillRefs.length * 600;  // skill 平均 600 token
    return t;
  }, [value, attachments, skillRefs]);

  /* 简约形态下发送键外圈那道环 —— 上下文用量。口径跟 ContextButton 完全一致
   * (同一个 used / max), 不另起一套算法, 否则环和弹窗会打架。 */
  const minimalContextUsed = (contextUsed && contextUsed > 0)
    ? contextUsed
    : Math.max(activeSession?.contextUsed || 0, activeSession?.latestRequestUsage?.totalTokens || 0);
  const minimalContextMax = isPlaceholderModel ? 0 : (selectedModel?.contextWindow ?? 0);
  const minimalContextPct = minimalContextMax > 0
    ? Math.min(100, Math.round((minimalContextUsed / minimalContextMax) * 100))
    : 0;
  const minimalContextTitle = minimalContextMax > 0
    ? (isZh
        ? `上下文已用 ${minimalContextPct}% (${formatCompactTokens(minimalContextUsed)} / ${formatCompactTokens(minimalContextMax)})`
        : `Context ${minimalContextPct}% used (${formatCompactTokens(minimalContextUsed)} / ${formatCompactTokens(minimalContextMax)})`)
    : (isZh ? '上下文用量未知 (先选一个模型)' : 'Context usage unknown — pick a model first');

  /* 模式牌 (team 绿 / target 黄)。两种输入框形态落点不同, 所以抽成变量在两处渲染:
   *   极简 → 挂在 __box 里, + 号右边;
   *   标准 → 挂在工具条最左, 紧挨附件键 —— 直接挂 __box 会排到最后, 变成底部居中独占一行。 */
  const modeChip = sessMode ? (
          <span
            className={`atl-composer__modechip is-${sessMode.kind} is-mode-${sessMode.phase}`}
            title={isZh
              ? (sessMode.kind === 'team'
                ? (sessMode.phase === 'running' ? '团队正在执行' : sessMode.phase === 'done' ? '团队刚完工' : sessMode.phase === 'idle' ? '这是一个团队会话' : '团队方案进行中')
                : (sessMode.phase === 'running' ? 'Target 目标进行中' : 'Target 已收尾'))
              : `${sessMode.label} mode`}
          >
            {sessMode.kind === 'team' ? (
              /* 双人 = 团队 */
              <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="5.4" cy="4.6" r="2.1" /><path d="M1.9 11.4c0-1.9 1.6-3.2 3.5-3.2s3.5 1.3 3.5 3.2" />
                <circle cx="10.4" cy="5.4" r="1.5" /><path d="M12.1 11.4c0-1.4-.7-2.3-2-2.6" />
              </svg>
            ) : (
              /* 靶心 = target */
              <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <circle cx="7" cy="7" r="4.8" /><circle cx="7" cy="7" r="2" />
                <path d="M7 .9v1.4M7 11.7v1.4M.9 7h1.4M11.7 7h1.4" />
              </svg>
            )}
            <b>{sessMode.kind === 'team' ? 'Team' : (isZh ? '目标' : 'Target')}</b>
          </span>
  ) : null;

  /* 聊天模式药丸: 跟 Team / 目标同一个位置同一种形状。点一下回 Agent —— 切回去不丢东西,
   * 所以可以放在随手点得到的地方 (不像解散团队)。 */
  const chatChip = chatModeOn ? (
    <button
      type="button"
      className="atl-composer__modechip is-chat"
      onClick={() => setChatModeOn(false)}
      title={isZh ? '聊天模式：只带联网搜索和画图，最省 token。点一下回到 Agent' : 'Chat mode: search and image only, fewest tokens. Click to switch back to Agent'}
    >
      <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.2 3.6c0-.8.6-1.4 1.4-1.4h6.8c.8 0 1.4.6 1.4 1.4v4.2c0 .8-.6 1.4-1.4 1.4H6.2L3.6 11.4V9.2c-.8 0-1.4-.6-1.4-1.4V3.6z" />
      </svg>
      <b>{isZh ? '聊天' : 'Chat'}</b>
    </button>
  ) : null;

  return (
    <div
      ref={composerRef}
      className={[
        'atl-composer',
        dragOver ? 'is-drag-over' : '',
        effectiveCompact ? 'is-compact' : '',
        flat ? 'atl-composer--flat' : '',
        minimal ? 'atl-composer--minimal' : '',
        minimal && (heroCard || attachments.length > 0 || skillRefs.length > 0 || !!inlineSlot
          || (value.trim().length > 0 && value.includes('\n'))
          || minimalInputTall)
          ? 'is-expanded' : '',
      ].filter(Boolean).join(' ')}
      data-mode={triMode}
      data-surface={minimal ? minimalSurface : undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {!minimal && <TargetInlineBanner activeSessionId={activeSessionIdForQueue} />}
      <UiSlot name="composer.quota.banner" props={{}} />
      {queuedRestoredAt && (
        <div role="status" aria-live="polite" style={{ fontSize: 12, opacity: .8, padding: '4px 12px', overflowWrap: 'anywhere' }}>
          {isZh ? '这条消息未发送，已保留为草稿' : 'This message was not sent and has been kept as a draft.'}
        </div>
      )}
      <div className={[
        'atl-composer__stack',
        showMinimalPanel ? 'is-panel' : '',
        showMinimalPanel ? (panelSide === 'above' ? 'is-panel-above' : 'is-panel-below') : '',
        sessMode?.glow ? `is-mode-glow is-mode-${sessMode.phase} is-mode-kind-${sessMode.kind}` : '',
      ].filter(Boolean).join(' ')}>
      <ComposerErrorPill isZh={isZh} />
      {needsProviderSetup && !editingEntry && (
        <div className="atl-composer__pill atl-composer__pill--setup" role="status">
          <span className="atl-composer__pill-dot" aria-hidden />
          <span className="atl-composer__pill-text">
            {getEditionHook('hasAccount')
              ? (isZh ? '还没有订阅或 API Key · 配置后才能发送' : 'No subscription or API key yet')
              : (isZh ? '还没有 API Key · 添加后才能发送' : 'No API key yet — add one to start')}
          </span>
          <button
            type="button"
            className="atl-composer__pill-act"
            onClick={() => {
              /* 跟引导页同一套接模型流程 (AppShell 的浮层), 不再落到设置页那张全字段表单 */
              try { window.dispatchEvent(new CustomEvent('neox:open-model-connect', { detail: { mode: 'choose' } })); } catch { /* ignore */ }
            }}
          >
            {isZh ? '去配置' : 'Set up'}
          </button>
        </div>
      )}
      {editingEntry && (
        <div className="atl-composer__pill atl-composer__pill--edit" role="status">
          <span className="atl-composer__pill-dot" aria-hidden />
          <span className="atl-composer__pill-text">
            {isZh ? '编辑中 · 发送后从这条重跑' : 'Editing · resend reruns from here'}
          </span>
          <button type="button" className="atl-composer__pill-act" onClick={cancelEditing}>
            {isZh ? '取消' : 'Cancel'}
          </button>
        </div>
      )}
      {/* 面板方向自适应: below 长条下 / above 长条上 (column-reverse) */}
      <div className={`atl-composer__boxwrap${sessMode ? ` is-mode-glow is-mode-${sessMode.phase} is-mode-kind-${sessMode.kind}` : ''}`}>
      {/* 异常区 —— 贴在输入框正上方, 跟 __box 做兄弟, 左右边界由构造保证一致
          (自己写居中 padding 那版偏了 128px, 见 TurnAnomalyDock 文件头)。 */}
      <TurnAnomalyDock
        entries={anomalies ?? EMPTY_ANOMALIES}
        sessionId={activeSessionIdForQueue}
        onDismiss={onDismissAnomaly}
        onRetry={onRetryAnomaly}
        onContinue={onContinueAnomaly}
        canContinue={canContinueAnomaly}
      />
      {draftQueue.length > 0 && (
        <div className="atl-composer__queued atl-composer__queued--draft" role="status" aria-live="polite">
          {draftQueue.map((d, i) => (
            <div key={`draft-${i}`} className="atl-composer__queued-row">
              <span
                className="atl-composer__queued-badge"
                title={isZh ? '这一轮做完后自动发送' : 'Sends automatically when this turn finishes'}
              >{isZh ? '本轮后发送' : 'Up next'}</span>
              <span className="atl-composer__queued-text">{d.text}</span>
              {!!d.images?.length && (
                <span className="atl-composer__queued-imgs" title={isZh ? `含 ${d.images.length} 张图片` : `${d.images.length} image(s)`}>
                  <IconImage size={12} />
                  {d.images.length}
                </span>
              )}
              <button
                type="button"
                className="atl-composer__queued-action"
                title={isZh ? '不等这一轮结束, 现在就插进去 (本轮不停)' : 'Insert now instead of waiting for this turn to finish'}
                onClick={() => flushDrafts()}
              >{isZh ? '立即插入' : 'Insert now'}</button>
              <button
                type="button"
                className="atl-composer__queued-action atl-composer__queued-action--cancel"
                title={isZh ? '撤回, 放回输入框' : 'Take it back into the box'}
                /* 它已经在引擎里排着 —— 先摘这一条, 摘到了才放回输入框。
                   摘不到 = 引擎刚好已经接走了, 时间线上会出现这条, 再放回就成了两份。 */
                onClick={() => {
                  void (async () => {
                    const sid = activeSessionIdForQueue;
                    const removed = await onCancelQueued?.(d.text);
                    /* 摘之前药丸可能已被引擎接走 (user_message_injected 会先把它摘掉) —— 还在说明没被接走 */
                    if (!getDrafts(sid).includes(d)) return;
                    setDraftsForSession(sid, (p) => p.filter((x) => x !== d));
                    /* 等引擎回话这会儿用户切走了: 别塞进别的会话的输入框, 存着, 切回来再倒回 */
                    if (draftKeyRef.current !== (sid ? `neox:draft:${sid}` : null)) {
                      setReturnedForSession(sid, (prev) => [...prev, { text: d.text, images: d.images }]);
                      return;
                    }
                    void removed;
                    setValue((v) => (v.trim() ? `${v}\n${d.text}` : d.text));
                    for (const img of d.images ?? []) {
                      addAttachment({
                        id: makeId('img'), type: 'image', name: img.name || 'image.png',
                        data: img.data.startsWith('data:') ? img.data : `data:${img.mediaType};base64,${img.data}`,
                      });
                    }
                    requestAnimationFrame(() => { adjust(); textareaRef.current?.focus(); });
                  })();
                }}
              >{isZh ? '取消' : 'Cancel'}</button>
            </div>
          ))}
        </div>
      )}
      {/* 光走 box 自己的 box-shadow (贴合圆角, 且不被自身 overflow:hidden 裁) */}
      <div
        className={`atl-composer__box${sessMode ? ` is-mode-glow is-mode-${sessMode.phase} is-mode-kind-${sessMode.kind}` : ''}${dragOver ? ' is-drop' : ''}`}
        ref={composerBoxRef}
      >
        {/* 拖拽落点 = **整个输入框**, 所以遮罩挂在这一层。inset:0 + border-radius:inherit
          * 让它在极简 (药丸) 和标准 (圆角矩形) 两种形态下都严丝合缝, 不用各写一套。 */}
        {dragOver && <span className="atl-composer__dropmask" aria-hidden="true" />}
        {!flat && (
        <div className={`atl-composer__top${modeVariant.hideComposerTopRule ? ' atl-composer__top--flat' : ''}`}>
          {!modeVariant.hideAgenticBadge && (
            <span className="atl-mode-pill" title={isZh ? 'Agentic 模式' : 'Agentic mode'}>Agentic</span>
          )}
          <LiveStatusLine
            streaming={streaming}
            turnStartedAt={turnStartedAt}
            subAgentTokens={runningSubAgentTokens}
            activityLabel={runActivity.label}
            idlePersist={modeVariant.hideComposerTopRule}
          />
          {!streaming && activeCompaction && (
            <div className="atl-livestatus" aria-live="polite">
              <LiveShimmerText
                className="atl-livestatus__phase"
                live
                text={`${isZh ? '压缩上下文中' : 'Compacting context'}${compactionPct != null ? ` · ${compactionPct}%` : '…'}`}
              />
            </div>
          )}
        </div>
        )}

        {pickerError && (
          <div className="atl-composer__err">
            {pickerError}
            <button type="button" onClick={() => setPickerError(null)} aria-label={isZh ? "关闭" : "Close"}>×</button>
          </div>
        )}


        {/* 点麦克风但还没法说 (不是订阅、也没配过) —— 简约 / 完整两种输入框都会走到, 所以挂在这里 (弹窗本身 portal 到 body) */}
        {voiceSetupOpen && <VoiceSetupDialog onClose={() => setVoiceSetupOpen(false)} />}

        {minimal && (
          <span
            className={[
              'atl-composer__plus-wrap',
              !modeVariant.hideContextChip ? 'atl-composer__ctxring' : '',
              !modeVariant.hideContextChip && streaming ? 'is-running' : '',
              !modeVariant.hideContextChip && !streaming && minimalContextPct >= 95 ? 'is-full' : '',
              !modeVariant.hideContextChip && !streaming && minimalContextPct >= 85 && minimalContextPct < 95 ? 'is-warn' : '',
              !modeVariant.hideContextChip && !streaming && minimalContextPct >= 8 && minimalContextPct < 85 ? 'is-busy' : '',
              !modeVariant.hideContextChip && !streaming && minimalContextPct < 8 ? 'is-idle' : '',
            ].filter(Boolean).join(' ')}
            style={!modeVariant.hideContextChip
              ? ({ ['--nx-ring-pct' as string]: minimalContextPct } as React.CSSProperties)
              : undefined}
            title={!modeVariant.hideContextChip ? minimalContextTitle : undefined}
          >
            <button
              ref={plusBtnRef}
              type="button"
              className={`atl-composer__plus${plusMenuOpen ? ' is-open' : ''}`}
              onClick={() => setPlusMenuOpen((v) => !v)}
              aria-expanded={plusMenuOpen}
              aria-haspopup="menu"
              aria-label={isZh ? '添加内容和设置' : 'Add content and settings'}
              title={isZh ? '添加附件、技能，或调整这轮怎么跑' : 'Add attachments or skills, or change how this run behaves'}
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
                <path d="M10 4.5v11M4.5 10h11" />
              </svg>
              {/* 附件数角标已去掉 (4.0.1): 附件签就在输入框里摆着, 角标重复; 骑在用量环的弧上还显得怪 */}
            </button>
            {plusMenuOpen && (
              <ComposerPlusMenu
                anchorRef={plusBtnRef}
                isZh={isZh}
                disabled={streaming}
                attachmentCount={attachments.length + skillRefs.length}
                contextPct={minimalContextPct}
                hideContext={modeVariant.hideContextChip}
                onClose={() => setPlusMenuOpen(false)}
                onPickFiles={() => { setPlusMenuOpen(false); handlePick(); }}
                hideVoice={!voiceInputOn}
                chatMode={chatModeOn}
                onConversationMode={() => { setPlusMenuOpen(false); setConversationModeOpen(true); }}
                onOutputStyle={() => { setPlusMenuOpen(false); setOutputStyleOpen(true); }}
                sessionId={activeSession?.id ?? null}
                onVoice={() => { setPlusMenuOpen(false); void toggleMic(); }}
                onSkills={() => openMinimalSurface('skills')}
                onMcp={() => { setPlusMenuOpen(false); setMcpDialogOpen(true); }}
                onApproval={() => { setPlusMenuOpen(false); setApprovalDialogOpen(true); }}
                onRunDest={() => { setPlusMenuOpen(false); setRunDestOpen(true); }}
                onContext={() => { setPlusMenuOpen(false); setContextPopOpen(true); }}
                onRequestMode={() => { setPlusMenuOpen(false); setRequestModeOpen(true); }}
                onConductor={() => { setPlusMenuOpen(false); window.dispatchEvent(new CustomEvent(CONDUCTOR_OPEN_EVENT)); }}
                hideMcp={modeVariant.hideMcpPicker}
                hideApproval={modeVariant.hidePermissionMode}
                hideRunDest={modeVariant.hideRunDestination}
              />
            )}
            {requestModeOpen && <RequestModeDialog onClose={() => setRequestModeOpen(false)} />}
            {outputStyleOpen && <OutputStyleDialog onClose={() => setOutputStyleOpen(false)} />}
            {conversationModeOpen && (
              <ConversationModeDialog
                chatMode={chatModeOn}
                onPick={(on) => { setChatModeOn(on); setConversationModeOpen(false); }}
                onClose={() => setConversationModeOpen(false)}
              />
            )}
            {approvalDialogOpen && (
              <ApprovalModeDialog sessionId={activeSession?.id ?? null} onClose={() => setApprovalDialogOpen(false)} />
            )}
            {mcpDialogOpen && <McpDialog onClose={() => setMcpDialogOpen(false)} />}
            {runDestOpen && (
              <RunDestDialog selectedProviderId={selectedModel?.providerId ?? null} onClose={() => setRunDestOpen(false)} />
            )}
          </span>
        )}

        {minimal && (modeChip ?? chatChip)}

        <div className="atl-composer__input-wrap" data-tour="composer" ref={inputWrapRef}>
          {/* 图片模式 (flat) 不显 "创建图片" chip — 进了图片页本身就是出图态, 挂个标签是废话.
           *  intent 仍在 activeIntentIds 里驱动 runDirectImageMode, 只是不渲染这个可视 chip. */}
          {!flat && (
            <IntentChipBar
              activeIntentIds={activeIntentIds}
              onRemove={(id) => setActiveIntentIds(prev => prev.filter(x => x !== id))}
              zh={isZh}
            />
          )}
          {/* 附件 / Skill 引用 chips — 移到 textarea 上方 (输入框内部),
            * 这样视觉上跟 prompt 文本一体 (CC/CR/Cursor 都这种摆位), 不再
            * 挤在顶部 toolbar 跟模式切换器抢空间. */}
          {(attachments.length > 0 || skillRefs.length > 0 || inlineSlot) && (
            <div className="atl-composer__ctx atl-composer__ctx--inline atl-composer__ctx--noline">
              {inlineSlot}
              {attachments.map((a) => (
                a.type === 'image' && typeof a.data === 'string' && a.data.startsWith('data:image/') ? (
                  <ImageThumb
                    key={a.id}
                    src={a.data}
                    alt={a.name ?? (isZh ? '图片' : 'Image')}
                    onOpen={() => setPreviewAtt(a)}
                    onRemove={() => removeAttachment(a.id)}
                  />
                ) : (
                  <ContextPill
                    key={a.id}
                    icon={a.type === 'image'
                      ? <IconImage size={14} />
                      : (a.path || a.name) ? <FileTypeIcon path={a.path ?? a.name ?? ''} size={14} /> : <IconFile size={14} />}
                    /* 「当前文件」的 name 里带着前缀 (发给模型用), 签上只放文件名, 来历挪到后面淡字 */
                    label={a.id === ACTIVE_FILE_ATT_ID && a.path
                      ? (a.path.split(/[\\/]/).pop() || a.path)
                      : (a.name ?? a.path ?? (isZh ? '附件' : 'Attachment'))}
                    hint={a.id === ACTIVE_FILE_ATT_ID ? (isZh ? '当前文件' : 'Current file') : undefined}
                    tone="file"
                    onOpen={() => setPreviewAtt(a)}
                    onRemove={() => {
                      /* 点掉「当前文件」= 这个文件别再自动带 (换到别的文件才重新带) */
                      if (a.id === ACTIVE_FILE_ATT_ID && a.path) setDismissedActivePath(a.path);
                      removeAttachment(a.id);
                    }}
                  />
                )
              ))}
              {skillRefs.map((id) => (
                <ContextPill
                  key={`skill-${id}`}
                  icon="✦"
                  label={id}
                  tone="skill"
                  onRemove={() => removeSkillRef(id)}
                />
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className={`atl-composer__input${micState !== 'idle' ? ' is-voice' : ''}`}
            placeholder={
              cloudReadonly
                ? (isZh ? '会话正在迁移中 · 完成后即可发送' : 'Session is migrating · you can send when it finishes')
                : dragOver
                ? (isZh ? '松开以添加附件…' : 'Release to add attachments…')
                : streaming
                ? queuedLocal.length > 0
                  ? (isZh ? '插话待处理' : 'Inserted message pending')
                  : buildStreamingPlaceholder(runActivity, !!onInject, isZh)
                : chatModeOn && !placeholderOverride
                ? (isZh ? '随便聊聊，问点什么…' : 'Ask or chat about anything…')
                : effectivePlaceholder
            }
            defaultValue=""
            onChange={onChange}
            onKeyDown={onKey}
            onPaste={onPaste}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={(e) => {
              const next = e.currentTarget.value;
              composingRef.current = false;
              valueRef.current = next;
              setValue(next);
              if (histIdx >= 0) setHistIdx(-1);
              /* 拼写结束立刻重测 — 清掉 composition 期间被冻结的判定缓存 */
              tallDecisionRef.current = null;
              void updateTriggers(next, e.currentTarget.selectionStart ?? next.length);
              requestAnimationFrame(adjust);
            }}
            rows={1}
            readOnly={cloudReadonly}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
          {micState !== 'idle' && voiceBox && (
            <div className="atl-composer__voice" style={voiceBox}>
              {voiceTail && <span className="atl-composer__voice-text">{voiceTail}</span>}
              <ComposerMicWave
                variant="field"
                analyser={micAnalyser}
                state={micState === 'recording' ? 'recording' : 'transcribing'}
                onStop={() => { void stopMic(); }}
                label={isZh ? (micState === 'recording' ? '正在录音, 点击结束' : '识别中') : (micState === 'recording' ? 'Recording — click to stop' : 'Transcribing…')}
              />
            </div>
          )}
          {triggerKind === 'at' && atItems.length > 0 && (
            <AtPopover
              items={atItems}
              activeIdx={triggerIdx}
              onPick={pickAt}
              onClose={closeTriggers}
              anchorRef={inputWrapRef}
              workspacePath={workspacePath}
            />
          )}
          {triggerKind === 'slash' && slashItems.length > 0 && (
            <SlashPopover
              items={slashItems}
              activeIdx={triggerIdx}
              onPick={pickSlash}
              onClose={closeTriggers}
              anchorRef={inputWrapRef}
            />
          )}
          {triggerKind === 'hash' && hashItems.length > 0 && (
            <HashPopover
              items={hashItems}
              activeIdx={triggerIdx}
              onPick={(it) => void pickHash(it)}
              onClose={closeTriggers}
              anchorRef={inputWrapRef}
            />
          )}
          {/* 空状态提示 (触发了但没结果) */}
          {triggerKind !== null && activeItemsLen === 0 && (
            <div className="atl-mention atl-mention--empty">
              <div className="atl-mention__empty-hint">
                {triggerKind === 'at' && (isZh ? '无匹配文件 · 尝试部分文件名或路径' : 'No matching files · try part of a name or path')}
                {triggerKind === 'slash' && (isZh ? '无匹配 skill · 在 Settings 导入 skill' : 'No matching skill · import skills in Settings')}
                {triggerKind === 'hash' && (isZh ? '暂无打开的编辑器 tab' : 'No open editor tabs')}
              </div>
            </div>
          )}
        </div>

        <input ref={fileInputRef} type="file" multiple hidden onChange={onFileInput} />

        <div className="atl-composer__actions">

          {flat ? (
            <div className="atl-composer__tools">
              <IconToolButton
                icon={<IconImage size={12} />}
                title={isZh ? '上传参考图 (图生图 / 改图, 可多张)' : 'Upload reference image (img2img)'}
                onClick={handlePick}
                disabled={streaming}
              />
              {/* 抽卡: 出几张 —— 一次多出对比挑选; 也可以就 1 张. */}
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, height: 28, padding: 2, borderRadius: 8, border: '1px solid var(--neox-line, rgba(0,0,0,0.1))' }}
                title={isZh ? '一次出几张 (多张对比挑选)' : 'Images per run'}>
                {[1, 2, 4, 6].map(cnt => {
                  const active = imageCount === cnt;
                  return (
                    <button key={cnt} type="button" onClick={() => setImageParam('n', cnt)}
                      style={{ minWidth: 22, height: 22, borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: active ? 700 : 500,
                        background: active ? 'var(--neox-primary-500, #3b82f6)' : 'transparent',
                        color: active ? '#fff' : 'var(--neox-fg-secondary, #6b7280)' }}>
                      {cnt === 1 ? (isZh ? '单' : '1') : `×${cnt}`}
                    </button>
                  );
                })}
              </div>
              <ImageParamsButton modelName={imageModel?.name} zh={isZh} />
              {/* 存为模板 —— 调好的 prompt+参数存起来, 发现墙"我的模板"复用 */}
              <IconToolButton
                icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>}
                title={isZh ? '把当前描述+参数存为模板' : 'Save prompt + params as template'}
                onClick={() => {
                  const text = value.trim();
                  if (!text) { textareaRef.current?.focus(); return; }
                  /* Electron 禁 window.prompt → 自动用描述前段做名字 (发现墙"我的模板"里可删). */
                  saveImageTemplate({
                    id: `ut-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    name: text.slice(0, 14).trim() || '未命名',
                    mode: 'generate', category: '我的',
                    prompt: text, params: getImageParamValues(),
                  }, { dedupName: true });
                }}
                disabled={streaming}
              />
            </div>
          ) : (
          <div className="atl-composer__tools">
            {!minimal && modeChip}
            {/* 附件 — 最常用, 永远露在第一位. */}
            <IconToolButton
              icon={<IconPaperclip size={12} />}
              title={isZh ? "添加附件 (拖拽 / 粘贴图片 / 点击选文件)" : "Add attachments (drag / paste image / choose files)"}
              onClick={handlePick}
              disabled={streaming}
            />
            {!minimal && renderMicButton(12)}
            {/* 简约态 Skills/MCP 走 Morph Surface panel, 标准态才在工具栏渲染。 */}
            {!minimal && (effectiveCompact ? (
              <CompactOverflowTools
                skillsOpen={skillsOpen}
                onToggleSkills={() => setSkillsOpen((v) => !v)}
                onPickSkill={(s) => {
                  const ref = `@skill:${s.id}\n`;
                  setValue((v) => ref + v);
                  requestAnimationFrame(() => {
                    textareaRef.current?.focus();
                    adjust();
                  });
                  setSkillsOpen(false);
                }}
                mcpOpen={mcpOpen}
                onToggleMcp={() => setMcpOpen((v) => !v)}
              />
            ) : (
              <>
                <SkillsDropdown
                  open={skillsOpen}
                  onToggle={() => setSkillsOpen((v) => !v)}
                  emphasized={false}
                  onPick={(s) => {
                    const ref = `@skill:${s.id}\n`;
                    setValue((v) => ref + v);
                    requestAnimationFrame(() => {
                      textareaRef.current?.focus();
                      adjust();
                    });
                    setSkillsOpen(false);
                  }}
                />
                {!modeVariant.hideMcpPicker && (
                  <McpDropdown
                    open={mcpOpen}
                    onToggle={() => setMcpOpen((v) => !v)}
                  />
                )}
              </>
            ))}
          </div>
          )}

          <div className="atl-composer__right">
            {flat && imageAttachData.length > 0 && (
              <ImageToImageBar zh={isZh} images={imageAttachData} />
            )}
            {/* 简约态权限/运行位置走 Morph Surface panel; 标准态才常驻右侧 */}
            {!minimal && !modeVariant.hideRunDestination && !flat && (
              <RunDestinationPicker selectedModel={selectedModel} />
            )}
            {!imageIntentActive && (
              <ConductorChip sessionId={activeSessionIdForQueue} models={pickerModels} leadModelName={selectedModel?.name} leadModelId={selectedModel?.id}
                onSelectLead={(m) => { const hit = pickerModels.find((x) => x.id === m.id); if (hit) setSelectedModel(hit); }} isZh={getGlobalLanguage() === 'zh'} />
            )}
            {/* 思考按钮: 釉球 + 档位名, 点开一根滑杆 (ThinkLevel.tsx); 显示的档 = 这一轮实际发的档 */}
            {(heroCard || minimal) && !imageIntentActive && activeModel && (
              <ThinkChip modelId={activeModel.id} sent={activeModel.id === selectedModel?.id ? effortLevel : effortByModel.get(activeModel.id)} zh={getGlobalLanguage() === 'zh'}
                anchor={thinkAnchor} onOpen={(r) => { setModelOpen(false); setThinkAnchor(r); }} onClose={() => setThinkAnchor(null)} onPick={(level) => setEffortForModel(activeModel.id, level)} />
            )}
            <ModelPicker
              label={modelLabel}
              compact={false}
              isPlaceholder={isPlaceholderModel}
              open={modelOpen}
              onToggle={() => setModelOpen((v) => !v)}
              models={pickerModels}
              selectedId={activeModel?.id}
              byokPrefsVersion={byokPrefsVersion}
              planId={membership?.plan?.id}
              onSelect={(m) => {
                /* 图片模式只更新自己的图像模型记忆, 不动全局聊天 selectedModel (防穿台). */
                if (imageIntentActive) {
                  setImageModelId(m.id);
                  try { window.localStorage.setItem('neox:image-model-id', m.id); } catch { /* ignore */ }
                } else {
                  setSelectedModel(m);
                }
                setModelOpen(false);
              }}
              effortByModel={effortByModel} sentEffort={effortLevel}
              onEffortChange={setEffortForModel}
              hideEffortMenu={imageIntentActive} /* 平时思考在输入框按钮里; 按钮看不见时 (窄 / 标准输入框 / 出问题) 菜单里才出后备滑杆, simple 档也给 */
            />
            {/* 标准态: 常驻上下文 chip。简约态: 用量环融进发送钮, 详情走加号菜单。 */}
            {!minimal && !modeVariant.hideContextChip && !flat && (
              <ContextButton
                used={(contextUsed && contextUsed > 0)
                  ? contextUsed
                  : Math.max(
                      activeSession?.contextUsed || 0,
                      activeSession?.latestRequestUsage?.totalTokens || 0,
                    )}
                max={isPlaceholderModel ? 0 : (selectedModel?.contextWindow ?? 0)}
                totalTokens={totalTokens}
                pending={pendingTokens}
                sessionId={activeSession?.id}
                compactionActive={!!activeCompaction}
                compactionPct={compactionPct}
              />
            )}
            {/* 简约态无触发器宿主 — 加号「上下文」打开同一套详情/压缩/高级弹层 */}
            {minimal && !modeVariant.hideContextChip && !flat && (
              <ContextButton
                hideTrigger
                open={contextPopOpen}
                onOpenChange={setContextPopOpen}
                externalAnchorRef={plusBtnRef}
                used={(contextUsed && contextUsed > 0)
                  ? contextUsed
                  : Math.max(
                      activeSession?.contextUsed || 0,
                      activeSession?.latestRequestUsage?.totalTokens || 0,
                    )}
                max={isPlaceholderModel ? 0 : (selectedModel?.contextWindow ?? 0)}
                totalTokens={totalTokens}
                pending={pendingTokens}
                sessionId={activeSession?.id}
                compactionActive={!!activeCompaction}
                compactionPct={compactionPct}
              />
            )}
            {minimal && !streaming && renderMicButton(15)}
            {streaming ? (
              <button
                type="button"
                className="atl-composer__stop"
                onClick={stop}
                aria-label={isZh ? '停止' : 'Stop'}
                title={isZh ? '停止本轮（上下文保留，可继续对话）' : 'Stop this turn (context is kept)'}
              >
                <IconStop size={14} />
              </button>
            ) : canRetry ? (
              /* retry 按钮 — 错误文案已经挪到 textarea 上方 banner, 这里只留一个圆按钮.
                * banner 自带"重试" 主操作; toolbar 这个是兜底, 用户可能想直接点这里. */
              <button
                type="button"
                className="atl-composer__retry"
                onClick={() => void retryLast()}
                aria-label={isZh ? "重试" : "Retry"}
                title={isZh ? "重新发送上一条" : "Resend previous message"}
              >
                <IconRefresh size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="atl-composer__send"
                onClick={submit}
                disabled={!canSend}
                aria-label={isZh ? "发送" : "Send"}
                title={sendBlockedReason ?? (isZh ? "发送 (Enter)" : "Send (Enter)")}
              >
                {minimal ? (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M13.5 2.5 6.8 9.2M13.5 2.5 9.3 13.5 6.8 9.2 2.5 6.7z" />
                  </svg>
                ) : (
                  <IconSend size={12} />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
      </div>{/* /atl-composer__boxwrap */}
      {showMinimalPanel && (
        <MinimalComposerPanel
          surface={minimalSurface as Exclude<MinimalSurface, 'strip'>}
          isZh={isZh}
          disabled={streaming}
          sessionId={activeSession?.id ?? null}
          selectedModel={selectedModel}
          onBack={closeMinimalSurface}
          onPickSkill={(s) => {
            const ref = `@skill:${s.id}\n`;
            setValue((v) => ref + v);
            closeMinimalSurface();
            requestAnimationFrame(() => {
              textareaRef.current?.focus();
              adjust();
            });
          }}
        />
      )}
      </div>
      {previewAtt && <AttachmentPreview att={previewAtt} onClose={() => setPreviewAtt(null)} />}
    </div>
  );
};

type MiniSkillRow = {
  id: string;
  name: string;
  description: string;
  category?: string;
  source: string;
};

const MinimalComposerPanel: React.FC<{
  surface: Exclude<MinimalSurface, 'strip'>;
  isZh: boolean;
  disabled?: boolean;
  sessionId: string | null;
  selectedModel: ModelInfo | null | undefined;
  onBack: () => void;
  onPickSkill: (s: MiniSkillRow) => void;
}> = ({ surface, isZh, disabled, sessionId, selectedModel, onBack, onPickSkill }) => {
  const modeVariant = useAgentModeVariant();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [skills, setSkills] = useState<MiniSkillRow[]>([]);
  const needsSearch = surface === 'skills';

  useEffect(() => {
    if (!needsSearch) return;
    const t = window.setTimeout(() => searchRef.current?.focus(), 40);
    return () => window.clearTimeout(t);
  }, [needsSearch, surface]);

  useEffect(() => {
    if (surface !== 'skills') return;
    const api = (window as any).neox;
    if (typeof api?.skillsList !== 'function') {
      setSkills([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.skillsList({ userInvocable: true })
      .then((list: any[]) => {
        if (cancelled) return;
        setSkills((list ?? [])
          .filter((s) => s.source !== 'builtin')   /* 只列用户自己的技能, 同斜杠菜单 */
          .filter((s) => modeVariant.isSkillVisibleForMode(s.metadata?.neox?.category))
          .map((s) => ({
            id: s.id,
            name: s.metadata?.name ?? s.id,
            description: isZh
              ? (s.metadata?.description ?? s.metadata?.description_en ?? '')
              : (s.metadata?.description_en ?? s.metadata?.description ?? ''),
            category: s.metadata?.neox?.category,
            source: s.source ?? 'builtin',
          })));
      })
      .catch(() => { if (!cancelled) setSkills([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [surface, modeVariant, isZh]);

  const filteredSkills = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter((s) =>
      s.name.toLowerCase().includes(query)
      || s.description.toLowerCase().includes(query)
      || s.id.toLowerCase().includes(query),
    );
  }, [q, skills]);

  const title = isZh ? '技能' : 'Skills';

  return (
    <div className={`atl-mini-panel atl-mini-panel--${surface}`} role="dialog" aria-label={title}>
      <div className="atl-mini-panel__head">
        <button
          type="button"
          className="atl-mini-panel__back"
          onClick={onBack}
          aria-label={isZh ? '返回' : 'Back'}
          title={isZh ? '返回输入' : 'Back to compose'}
        >
          <IconChevronLeft size={14} />
        </button>
        {needsSearch ? (
          <label className="atl-mini-panel__search">
            <IconSearch size={12} />
            <input
              ref={searchRef}
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={isZh ? '搜索技能…' : 'Search skills…'}
            />
          </label>
        ) : (
          <div className="atl-mini-panel__title">{title}</div>
        )}
      </div>

      <div className="atl-mini-panel__body">
        {surface === 'skills' && (
          <>
            {loading && <div className="atl-mini-panel__hint neox-text-shimmer">{isZh ? '加载中…' : 'Loading…'}</div>}
            {!loading && filteredSkills.length === 0 && (
              <div className="atl-mini-panel__empty atl-mini-panel__empty--skills">
                <span className="atl-mini-panel__empty-icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M10 2.5l1.6 4.9H16.5l-4 2.9 1.5 4.7L10 12.2l-4 2.8 1.5-4.7-4-2.9h4.9L10 2.5z" />
                  </svg>
                </span>
                <span>{isZh ? '还没有自己的技能 · 去「技能」页创建' : 'No skills of your own yet — create one on the Skills page'}</span>
              </div>
            )}
            {!loading && filteredSkills.length > 0 && (
              <ul className="atl-mini-panel__list" role="listbox">
                {filteredSkills.map((s, i) => (
                  <li key={s.id} style={{ ['--stagger' as string]: Math.min(i, 5) }}>
                    <button
                      type="button"
                      role="option"
                      className="atl-mini-panel__item"
                      onClick={() => onPickSkill(s)}
                    >
                      <span className="atl-mini-panel__item-main">
                        <span className="atl-mini-panel__item-title">{s.name}</span>
                        {s.description && (
                          <span className="atl-mini-panel__item-sub">{s.description}</span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

      </div>
    </div>
  );
};

const ComposerPlusMenu: React.FC<{
  /** 加号按钮 —— 菜单 portal 到 body 后靠它算坐标; 外点关闭也要认它 */
  anchorRef: React.RefObject<HTMLElement | null>;
  isZh: boolean;
  disabled?: boolean;
  attachmentCount: number;
  contextPct?: number;
  hideContext?: boolean;
  hideMcp?: boolean;
  hideApproval?: boolean;
  hideRunDest?: boolean;
  /** 语音输入没开时, 「+」菜单里不列这一项 —— 简约态它是唯一入口 */
  hideVoice?: boolean;
  /** 聊天模式 (不带文件 / 命令工具) / Agent 模式, 见 app/chatModeStore */
  chatMode: boolean;
  /** 打开「对话方式」弹窗 (Agent / 聊天) */
  onConversationMode: () => void;
  /** 打开「回复风格」弹窗 */
  onOutputStyle: () => void;
  /** 权限模式那一行显示当前档要用 */
  sessionId: string | null;
  onClose: () => void;
  onPickFiles: () => void;
  onVoice: () => void;
  onSkills: () => void;
  onMcp: () => void;
  onApproval: () => void;
  onRunDest: () => void;
  onContext: () => void;
  onRequestMode: () => void;
  /** 指挥模式 (ConductorChip): 贵模型指挥, 便宜模型干活 */
  onConductor: () => void;
}> = ({
  anchorRef, isZh, disabled, attachmentCount, contextPct, hideContext,
  hideMcp: hideMcpProp, hideApproval: hideApprovalProp, hideRunDest: hideRunDestProp, hideVoice,
  chatMode, onConversationMode, onOutputStyle, sessionId,
  onClose, onPickFiles, onVoice, onSkills, onMcp, onApproval, onRunDest, onContext, onRequestMode, onConductor,
}) => {
  const requestProfile = useContextProfile();
  const outputStyle = useOutputStyle();
  const approvalMode = useApprovalMode(sessionId);
  /* 聊天模式不带文件 / 命令工具: MCP / 权限 / 运行位置 / 技能都用不上, 不列 */
  const hideMcp = hideMcpProp || chatMode;
  const hideApproval = hideApprovalProp || chatMode;
  const hideRunDest = hideRunDestProp || chatMode;
  const ref = useRef<HTMLDivElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null);

  /* 必须 portal 到 body: .atl-composer__box 有 container-type:inline-size,
   * .neox-shell__main 有 overflow:hidden —— absolute 上弹会被直接裁掉 (看起来像"点了没反应")。
   *
   * 水平定位不是"菜单左缘 = 按钮左缘", 而是**菜单图标列中心 = 加号图标中心**。
   * 几何常量必须跟 dock.css 里 --nx-pm-* 同步:
   *   pad 3 + item-pl 5 + icon/2 8 = 16 */
  const MENU_W = 252;
  const ICON_CENTER_FROM_MENU_LEFT = 16;

  useEffect(() => {
    const update = () => {
      const a = anchorRef.current;
      if (!a) return;
      const plusRect = a.getBoundingClientRect();
      /* 竖直间距相对**胶囊外缘**, 不是加号按钮 —— 按钮比条顶矮一截 pad,
       * 若按按钮 top 留 6px, 视觉上菜单几乎贴住长条。 */
      const boxEl = a.closest('.atl-composer__box') as HTMLElement | null;
      const boxRect = boxEl?.getBoundingClientRect() ?? plusRect;
      const measured = ref.current?.getBoundingClientRect().height ?? 0;
      const GAP = 10;
      const plusIconCenter = plusRect.left + plusRect.width / 2;
      const maxLeft = Math.max(
        COMPOSER_OVERLAY_MARGIN,
        window.innerWidth - MENU_W - COMPOSER_OVERLAY_MARGIN,
      );
      const left = clampNumber(
        plusIconCenter - ICON_CENTER_FROM_MENU_LEFT,
        COMPOSER_OVERLAY_MARGIN,
        maxLeft,
      );
      const spaceAbove = Math.max(0, boxRect.top - COMPOSER_OVERLAY_MARGIN - GAP);
      const spaceBelow = Math.max(0, window.innerHeight - boxRect.bottom - COMPOSER_OVERLAY_MARGIN - GAP);
      const naturalH = measured > 0 ? measured : 200;
      const placeAbove = spaceBelow < naturalH && (spaceAbove >= naturalH || spaceAbove > spaceBelow);
      if (placeAbove) {
        setMenuStyle({
          position: 'fixed',
          left,
          right: 'auto',
          top: 'auto',
          /* 菜单底边 = 胶囊顶边上方 GAP */
          bottom: Math.max(COMPOSER_OVERLAY_MARGIN, window.innerHeight - boxRect.top + GAP),
          width: MENU_W,
          maxHeight: Math.max(80, spaceAbove),
          zIndex: COMPOSER_POPOVER_Z,
        });
      } else {
        const base = getComposerOverlayStyle({
          anchor: boxRect,
          width: MENU_W,
          estimatedHeight: naturalH,
          placement: 'top-start',
          gap: GAP,
          preferBelow: true,
        });
        setMenuStyle({ ...base, left, width: MENU_W });
      }
    };
    update();
    const raf = window.requestAnimationFrame(update);
    /* 布局稳定后再量一次高度, 避免首帧 measured=0 */
    const raf2 = window.requestAnimationFrame(() => window.requestAnimationFrame(update));
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.cancelAnimationFrame(raf2);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onDoc = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onEsc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onEsc, true);
    return () => {
      document.removeEventListener('pointerdown', onDoc, true);
      document.removeEventListener('keydown', onEsc, true);
    };
  }, [onClose, anchorRef]);

  /* 全部走同 viewBox / 同 stroke 的 14px SVG, 塞进 16px 槽 —— 禁止混用 emoji/文字图标 */
  const strokeIcon = (d: React.ReactNode) => (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d}
    </svg>
  );

  type PlusItem = {
    id: string;
    label: string;
    hint?: string;
    icon: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
    sepBefore?: boolean;
  };
  const items: PlusItem[] = [
    {
      id: 'chatmode',
      label: isZh ? '对话方式' : 'Mode',
      hint: chatMode
        ? (isZh ? '聊天 · 只带搜索和画图' : 'Chat · search and image only')
        : (isZh ? 'Agent · 读写文件、跑命令' : 'Agent · files, commands, web'),
      icon: strokeIcon(
        <>
          <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3h0A1.5 1.5 0 0 1 4 11.5z" />
          <path d="M7.5 8.5h5" />
        </>,
      ),
      onClick: onConversationMode,
    },
    /* 回复风格 —— 聊天 / Agent 都管用, 所以不随 chatMode 隐藏 */
    {
      id: 'outputstyle',
      label: isZh ? '回复风格' : 'Reply style',
      hint: outputStyleLabel(outputStyle, isZh),
      icon: strokeIcon(
        <>
          <path d="M4 5h12M4 9h8M4 13h10" />
          <path d="M14.5 12.5l1.8 1.8-3.3 3.3H11.2v-1.8z" />
        </>,
      ),
      onClick: onOutputStyle,
    },
    {
      id: 'files',
      sepBefore: true,
      label: isZh ? '附件' : 'Attach',
      hint: attachmentCount > 0
        ? (isZh ? `已带 ${attachmentCount} 项` : `${attachmentCount} attached`)
        : (isZh ? '文件 / 图片, 也可直接拖进来' : 'Files or images — drag & drop works too'),
      icon: <IconPaperclip size={14} />,
      onClick: onPickFiles,
      disabled,
    },
    ...(hideVoice ? [] : [{
      id: 'voice',
      label: isZh ? '语音输入' : 'Voice',
      hint: isZh ? '说话转文字 (⌘⇧M)' : 'Speak to text (⌘⇧M)',
      icon: strokeIcon(
        <>
          <rect x="7.5" y="2.5" width="5" height="9" rx="2.5" />
          <path d="M5 9a5 5 0 0010 0M10 14.5V17M7.5 17h5" />
        </>,
      ),
      onClick: onVoice,
    }]),
    ...(chatMode ? [] : [{
      id: 'skills',
      label: isZh ? '技能' : 'Skills',
      hint: isZh ? '挂一段可复用的做事方法' : 'Attach a reusable procedure',
      icon: strokeIcon(
        <path d="M10 2.5l1.6 4.9H16.5l-4 2.9 1.5 4.7L10 12.2l-4 2.8 1.5-4.7-4-2.9h4.9L10 2.5z" />,
      ),
      onClick: onSkills,
    }]),
    /* 请求模式 标准 / 节约 —— 点开是带插画的对比弹窗 (ContextModeSection.tsx)。聊天模式本来就不带这些工具, 不列 */
    ...(chatMode ? [] : [{
      id: 'reqmode',
      label: isZh ? '请求模式' : 'Request mode',
      hint: requestProfile === 'lean'
        ? (isZh ? '节约 · 开局约 3K' : 'Saver · ~3K to start')
        : (isZh ? '标准 · 开局约 17-26K' : 'Standard · ~17-26K to start'),
      icon: strokeIcon(
        <>
          <path d="M3.5 13.5a6.5 6.5 0 1 1 13 0" />
          <path d="M10 13.5 13 8.5" />
          <circle cx="10" cy="13.5" r="1" />
        </>,
      ),
      onClick: onRequestMode,
    }]),
    ...(chatMode ? [] : [{
      id: 'conductor',
      label: isZh ? '指挥模式' : 'Conductor mode',
      hint: readSavedConductor(sessionId)
        ? (isZh ? '已开启 · 点开调整或关闭' : 'On · adjust or turn off')
        : (isZh ? '贵模型指挥, 便宜模型写代码' : 'Expensive model leads, cheap model codes'),
      icon: strokeIcon(<path d="M4 16 14.5 5.5M12.5 3.5l4 4M3.5 16.5l1.5.5.5 1.5" />),
      onClick: onConductor,
    }]),
  ];
  /* 第二组: 上下文详情 / MCP / 权限 / 运行位置 —— 组前一道分隔线 */
  const second: PlusItem[] = [];
  if (!hideContext) {
    const pctLabel = typeof contextPct === 'number' ? `${Math.round(contextPct)}%` : '—';
    second.push({
      id: 'context',
      label: isZh ? '上下文' : 'Context',
      hint: isZh ? `已用 ${pctLabel} · 详情 / 压缩 / 高级` : `${pctLabel} used · details / compact / advanced`,
      icon: strokeIcon(
        <>
          <circle cx="10" cy="10" r="7" />
          <path d="M10 3a7 7 0 0 1 7 7" />
        </>,
      ),
      onClick: onContext,
    });
  }
  if (!hideMcp) {
    second.push({
      id: 'mcp',
      label: 'MCP',
      hint: isZh ? '外部工具服务器' : 'External tool servers',
      icon: strokeIcon(<path d="M4 13.5 10 4l6 9.5M6.8 11h6.4" />),
      onClick: onMcp,
    });
  }
  if (!hideApproval) {
    second.push({
      id: 'approval',
      label: isZh ? '权限模式' : 'Permissions',
      hint: getApprovalOptions(isZh).find((o) => o.key === approvalMode)?.label,
      icon: strokeIcon(<path d="M10 2.5 16 5v4.5c0 3.7-2.4 6.2-6 7.5-3.6-1.3-6-3.8-6-7.5V5l6-2.5z" />),
      onClick: onApproval,
    });
  }
  if (!hideRunDest) {
    second.push({
      id: 'rundest',
      label: isZh ? '运行位置' : 'Run target',
      hint: isZh ? '本地 / 云端' : 'Local / Cloud',
      icon: strokeIcon(
        <>
          <rect x="3.5" y="4" width="13" height="9" rx="1.5" />
          <path d="M7 16h6M10 13v3" />
        </>,
      ),
      onClick: onRunDest,
    });
  }
  if (second.length > 0) second[0] = { ...second[0], sepBefore: true };
  items.push(...second);

  return createPortal(
    <div
      className="atl-plusmenu"
      role="menu"
      ref={ref}
      style={menuStyle ?? { position: 'fixed', left: -9999, top: -9999, width: MENU_W, zIndex: COMPOSER_POPOVER_Z }}
    >
      {items.map((it) => (
        <React.Fragment key={it.id}>
          {it.sepBefore && <div className="atl-plusmenu__sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className="atl-plusmenu__item"
            onClick={it.onClick}
            disabled={it.disabled}
          >
            <span className="atl-plusmenu__icon" aria-hidden="true">{it.icon}</span>
            <span className="atl-plusmenu__body">
              <span className="atl-plusmenu__label">{it.label}</span>
              {it.hint && <span className="atl-plusmenu__hint">{it.hint}</span>}
            </span>
          </button>
        </React.Fragment>
      ))}
    </div>,
    document.body,
  );
};

/* LiveStatusLine / ImageThumb / ContextPill / formatCompactTokens → ./ComposerStatusPills */

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


/* ============================================================
 * Effort levels are schema keys, not a fixed product-wide enum.
 * Examples: GPT uses minimal/low/medium/high/xhigh, Claude uses
 * low/medium/high/xhigh/max, Gemini still uses fast/standard/deep/max.
 * ============================================================ */
/* 类型和档位函数在 thinkLevels.ts (按钮和菜单共用) */

/* ============================================================
 * RunDestinationPicker · 运行位置切换 (本地 / 云端)
 *
 *   Phase 1 (现在): 占位入口 — 显示当前位置, 云端项 disabled + "即将上线"
 *   Phase 2 (Mode C 接通后): 真启用云端项 — 点云端推 task 到 NeoxCloud sandbox
 *
 *   设计原则:
 *     - 本地默认 (跟 Neox 隐私 first 哲学一致)
 *     - 云端 opt-in, 单 task 显式选择 (不做"默认云端"避免误用付费资源)
 *     - chip-style + 下拉, 跟 ApprovalModeMenu 同款交互
 * ============================================================ */
const RunDestinationPicker: React.FC<{
  selectedModel?: ModelInfo | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  anchorRef?: React.RefObject<HTMLElement | null>;
}> = ({ selectedModel, open: openProp, onOpenChange, hideTrigger, anchorRef }) => {
  const { isZh } = useI18n();
  const cloudNotOpen = !useCloudAgentAvailable();
  const [openLocal, setOpenLocal] = useState(false);
  const open = openProp ?? openLocal;
  const setOpen = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? next(open) : next;
    if (openProp === undefined) setOpenLocal(resolved);
    onOpenChange?.(resolved);
  }, [open, openProp, onOpenChange]);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null);
  /* mobile bridge 状态: 已配对设备数 + 当前活跃 WS 连接数 */
  const [mobileStatus, setMobileStatus] = useState<{ paired: number; active: number } | null>(null);
  /* 当前 active session 是否已在 cloud — 决定云端项是否 disable.
   * 用 window event 跟 NeoxShellHost 同步, 避免 picker 自己再发 30s poll. */
  const [activeCloudActive, setActiveCloudActive] = useState(false);

  useEffect(() => {
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent<{ cloudActive: boolean }>).detail;
      setActiveCloudActive(!!detail?.cloudActive);
    };
    window.addEventListener('neox:active-session-cloud-state', handler as EventListener);
    /* 主动 ping 一次 — 防止刚挂载错过事件 */
    window.dispatchEvent(new CustomEvent('neox:request-cloud-state'));
    return () => window.removeEventListener('neox:active-session-cloud-state', handler as EventListener);
  }, []);

  /* 拉 mobile bridge 状态 — 让 chip 真显当前是否有 Mobile 设备在连 */
  useEffect(() => {
    const api = (window as any).neox?.mobileBridge;
    if (!api?.status) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const s = await api.status();
        if (cancelled) return;
        setMobileStatus({ paired: s.paired_count ?? 0, active: s.active_connections ?? 0 });
      } catch { /* ignore */ }
    };
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  useEffect(() => {
    if (!open) {
      setMenuStyle(null);
      return;
    }
    const updatePosition = () => {
      const el = anchorRef?.current ?? buttonRef.current;
      const r = el?.getBoundingClientRect();
      if (!r) return;
      setMenuStyle(getComposerOverlayStyle({
        anchor: r,
        width: 180,
        estimatedHeight: 112,
        placement: hideTrigger ? 'top-start' : 'top-end',
        gap: 6,
      }));
    };
    updatePosition();
    const raf = window.requestAnimationFrame(updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, anchorRef, hideTrigger]);

  /* 点击外面 / Esc 关菜单 — 菜单 portal 到 body, 要同时检查 menu 本体 */
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.atl-rundest') || t.closest('.atl-rundest__menu') || t.closest('.atl-composer__plus')) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onEsc as any);
    return () => {
      window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onEsc as any);
    };
  }, [open, setOpen]);

  const mobileCount = mobileStatus?.active ?? 0;
  const mobileActive = mobileCount > 0;
  const selectedUsesLocalProvider = !!selectedModel && !isNeoxCloudProviderId(selectedModel.providerId);

  return (
    <div className="atl-rundest">
      {!hideTrigger && (
      <button
        ref={buttonRef}
        type="button"
        className={`atl-rundest__pill${mobileActive ? ' is-mobile-active' : ''}${activeCloudActive ? ' is-cloud' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={activeCloudActive
          ? (isZh ? '当前会话在云端跑' : 'Session is running in the cloud')
          : (isZh ? '切换运行位置' : 'Switch run location')}
        aria-expanded={open}
      >
        {activeCloudActive ? <IconCloud size={12} /> : <IconHome size={12} />}
        <span className="atl-rundest__label">{activeCloudActive ? (isZh ? '云端' : 'Cloud') : (isZh ? '本地' : 'Local')}</span>
        {!activeCloudActive && mobileCount > 0 && (
          <span className="atl-rundest__mobile-badge">
            <IconPhone size={10} />
            <span>{mobileCount}</span>
          </span>
        )}
      </button>
      )}
      {open && menuStyle && createPortal(
        <div
          className="atl-rundest__menu"
          role="menu"
          style={menuStyle}
        >
          <div className={`atl-rundest__item${!activeCloudActive ? ' is-active' : ''}`} role="menuitem">
            <IconHome size={14} />
            <div className="atl-rundest__item-text">
              <span className="atl-rundest__item-title">{isZh ? '本地' : 'Local'}</span>
              <span className="atl-rundest__item-sub">{isZh ? '本机文件直达' : 'Runs on this machine'}</span>
            </div>
            {!activeCloudActive && <IconCheck size={12} />}
          </div>
          {(() => {
            const cloudBlocked = cloudNotOpen || selectedUsesLocalProvider;
            if (cloudNotOpen) return null;
	            const cloudTooltip = cloudNotOpen
	              ? (isZh
	                  ? '云端运行还没开放。所有任务都在你自己的机器上跑。'
	                  : 'Cloud runs are not available yet. Everything runs on your own machine.')
	              : selectedUsesLocalProvider
	              ? (isZh
	                  ? '云端运行需要 Neox Cloud 模型。BYOK API Key 只在本机使用，不会上传到云端 pod。'
	                  : 'Cloud run needs a Neox Cloud model. BYOK API keys stay on your machine and are never uploaded to a cloud pod.')
	              : (activeCloudActive
	                  ? (isZh ? '当前会话已在云端运行' : 'Session already running in the cloud')
	                  : (isZh ? '推到 NeoxCloud pod 继续, 关机不停' : 'Push to a NeoxCloud pod so it keeps running while you close the laptop'));
            const itemDisabled = cloudBlocked || activeCloudActive;
            return (
              <div
                className={`atl-rundest__item${activeCloudActive ? ' is-active' : ''}${itemDisabled ? ' is-disabled' : ''}`}
                role="menuitem"
                title={cloudTooltip}
                aria-disabled={itemDisabled}
                onClick={() => {
                  if (itemDisabled) return; // 点击无效, tooltip 已解释
                  window.dispatchEvent(new CustomEvent('neox:request-push-current-to-cloud'));
                  setOpen(false);
                }}
              >
                <IconCloud size={14} />
                <div className="atl-rundest__item-text">
                  <span className="atl-rundest__item-title">{isZh ? '云端' : 'Cloud'}</span>
                  <span className="atl-rundest__item-sub">
	                    {cloudBlocked
	                      ? (isZh ? '需云端模型 · BYOK 留在本机' : 'Cloud model required')
	                      : (isZh ? '云上跑,关机不停' : 'Runs in the cloud')}
                  </span>
                </div>
                {activeCloudActive && <IconCheck size={12} />}
              </div>
            );
          })()}
        </div>,
        document.body,
      )}
    </div>
  );
};

/* ============================================================
 * ApprovalModeMenu · 审批模式切换 (per-session, 三档)
 *
 *   Auto      工具调用自动通过 (默认, 适合熟悉/低风险任务)
 *   Manual    每个工具调用都要点确认 (强约束, 适合代码审查 / 重要操作)
 *   YOLO      所有审批一律放行 (含 sandbox 白名单外的命令; 慎用)
 *
 *   状态从 approvalModeStore 拿; 切换时双写 (UI 立即响应 + IPC 通知后端).
 *   下拉菜单, 不做点击循环 (避免误切 YOLO).
 * ============================================================ */
type ApprovalOption = {
  key: ApprovalMode;
  /** 菜单里的档位名 — 跟设置页「When to ask you」同一套词 */
  label: string;
  /** 药丸上显示的短标签, **必须自带主语** (见按钮渲染处的注释) */
  chip: string;
  hint: string;
};
function getApprovalOptions(isZh: boolean): ApprovalOption[] {
  return isZh
    ? [
        { key: 'auto',      label: '危险操作才问', chip: '问: 危险时', hint: '改文件、跑命令直接做, 只有删除/重置/强推这类危险操作才问你 (默认)' },
        { key: 'manual',    label: '每步都问',     chip: '问: 每步',   hint: '读取类直接做, 其余每一步都要你点确认' },
        { key: 'dangerous', label: '都不问',       chip: '问: 从不',   hint: '所有操作直接执行, 危险命令也不问 · 慎用' },
      ]
    : [
        { key: 'auto',      label: 'Risky actions',  chip: 'Ask: risky only', hint: 'Edits and everyday commands run freely; only risky actions ask first (default)' },
        { key: 'manual',    label: 'Every step',     chip: 'Ask: each step',  hint: 'Reads run freely; every other step needs your approval' },
        { key: 'dangerous', label: 'Never',          chip: 'Ask: never',      hint: 'Everything runs directly · never asks, not even for risky commands · use carefully' },
      ];
}

const ApprovalModeMenu: React.FC<{
  sessionId: string | null;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  anchorRef?: React.RefObject<HTMLElement | null>;
}> = ({ sessionId, disabled, open: openProp, onOpenChange, hideTrigger, anchorRef }) => {
  const { isZh } = useI18n();
  const APPROVAL_OPTIONS = getApprovalOptions(isZh);
  const mode = useApprovalMode(sessionId);
  const [openLocal, setOpenLocal] = useState(false);
  const open = openProp ?? openLocal;
  const setOpen = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? next(open) : next;
    if (openProp === undefined) setOpenLocal(resolved);
    onOpenChange?.(resolved);
  }, [open, openProp, onOpenChange]);
  /* 切到 dangerous 前先弹双勾确认; 用户取消就回到原 mode (UI 不变). */
  const [confirmDangerous, setConfirmDangerous] = useState(false);
  const cur = APPROVAL_OPTIONS.find((o) => o.key === mode) ?? APPROVAL_OPTIONS[0];

  /* 点击外面 / Esc 关菜单 — 菜单是 portal 到 body 的, 要同时检查 .atl-approval 和 .atl-approval__menu */
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.atl-approval') || t.closest('.atl-approval__menu') || t.closest('.atl-composer__plus')) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onEsc as any);
    return () => {
      window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onEsc as any);
    };
  }, [open, setOpen]);

  const commitMode = (
    next: ApprovalMode,
    dangerousConfirmation?: { acknowledgeNoApproval: true; acknowledgeHighRiskExecution: true },
  ): void => {
    void setApprovalMode(sessionId, next, undefined, dangerousConfirmation ? { dangerousConfirmation } : undefined)
      .catch((err) => {
        /* server 落盘失败 — 必须让用户看到, 不再静默 */
        console.error('[ApprovalModeMenu] setApprovalMode failed:', err);
        dispatchOpFailed({
          op: '切换审批模式',
          message: `${friendlyOpError(err)} — 请重试或检查 server 状态`,
        });
      });
  };

  const handlePick = (next: ApprovalMode): void => {
    setOpen(false);
    if (next === mode) return;
    if (next === 'dangerous') {
      /* dangerous 不直接 commit; 弹确认 dialog, 用户勾两条 + 点"启用"才真切 */
      setConfirmDangerous(true);
      return;
    }
    commitMode(next);
  };

  const approvalBtnRef = React.useRef<HTMLButtonElement>(null);
  const approvalMenuRef = React.useRef<HTMLDivElement>(null);
  const [approvalMenuStyle, setApprovalMenuStyle] = React.useState<React.CSSProperties | null>(null);
  React.useEffect(() => {
    if (!open) {
      setApprovalMenuStyle(null);
      return;
    }
    const updatePosition = () => {
      const el = anchorRef?.current ?? approvalBtnRef.current;
      const r = el?.getBoundingClientRect();
      if (!r) return;
      const measuredHeight = approvalMenuRef.current?.getBoundingClientRect().height ?? 0;
      setApprovalMenuStyle(getComposerOverlayStyle({
        anchor: r,
        width: 240,
        estimatedHeight: measuredHeight > 0 ? measuredHeight : 164,
        placement: 'top-start',
        gap: 6,
      }));
    };
    updatePosition();
    const raf = window.requestAnimationFrame(updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, anchorRef]);

  return (
    <>
      {!hideTrigger && (
      <div className={`atl-approval atl-approval--wrap-${mode}`}>
        <button
          ref={approvalBtnRef}
          type="button"
          className={`atl-approval__btn atl-approval--${mode}${open ? ' is-open' : ''}`}
          onClick={() => !disabled && setOpen((v) => !v)}
          disabled={disabled}
          title={sessionId
            ? `${isZh ? '审批模式' : 'Approval mode'}: ${cur.label} · ${cur.hint}`
            : `${isZh ? '新会话默认审批模式' : 'Default approval mode for new sessions'}: ${cur.label} · ${cur.hint}`}
          aria-label={`${isZh ? '审批模式' : 'Approval mode'}: ${cur.label}`}
        >
          {cur.chip ?? cur.label}
        </button>
      </div>
      )}
        {open && approvalMenuStyle && createPortal(
          <div ref={approvalMenuRef} className="atl-approval__menu" role="listbox" style={approvalMenuStyle}>
            {APPROVAL_OPTIONS.map((o) => (
              <button
                key={o.key}
                type="button"
                role="option"
                aria-selected={mode === o.key}
                className={`atl-approval__item atl-approval__item--${o.key}${mode === o.key ? ' is-active' : ''}`}
                onClick={() => handlePick(o.key)}
              >
                <span className="atl-approval__item-main">
                  <span className="atl-approval__item-label">{o.label}</span>
                  {mode === o.key && <span className="atl-approval__item-check" aria-hidden="true">✓</span>}
                </span>
                <span className="atl-approval__item-hint">{o.hint}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
      {confirmDangerous && createPortal(
        <DangerousConfirmDialog
          onCancel={() => setConfirmDangerous(false)}
          onConfirm={() => {
            setConfirmDangerous(false);
            commitMode('dangerous', { acknowledgeNoApproval: true, acknowledgeHighRiskExecution: true });
          }}
        />,
        document.body,
      )}
    </>
  );
};

const APPROVAL_ART: Record<ApprovalMode, string> = {
  auto: NeoxIllus.permAuto,
  manual: NeoxIllus.permManual,
  dangerous: NeoxIllus.permYolo,
};
const APPROVAL_POINTS: Record<ApprovalMode, { zh: string[]; en: string[] }> = {
  auto: {
    zh: ['改文件、跑常用命令直接做', '删除 / 重置 / 强推这类才停下问你', '默认档, 大多数时候用它'],
    en: ['Edits and everyday commands just run', 'Stops to ask before deletes, resets, force pushes', 'The default — right for most work'],
  },
  manual: {
    zh: ['读取类直接做', '改文件、跑命令每一步都等你点确认', '适合陌生项目或重要操作'],
    en: ['Reads run freely', 'Every edit and command waits for your OK', 'For unfamiliar projects or critical work'],
  },
  dangerous: {
    zh: ['所有操作直接执行, 一次都不问', '危险命令也不拦', '只在你完全信任的环境里用'],
    en: ['Everything runs, nothing asks', 'Risky commands are not stopped either', 'Only in environments you fully trust'],
  },
};

const ApprovalModeDialog: React.FC<{ sessionId: string | null; onClose: () => void }> = ({ sessionId, onClose }) => {
  const { isZh } = useI18n();
  const mode = useApprovalMode(sessionId);
  const [confirmDangerous, setConfirmDangerous] = useState(false);
  const commit = (
    next: ApprovalMode,
    dangerousConfirmation?: { acknowledgeNoApproval: true; acknowledgeHighRiskExecution: true },
  ) => setApprovalMode(sessionId, next, undefined, dangerousConfirmation ? { dangerousConfirmation } : undefined)
    .catch((err) => {
      console.error('[ApprovalModeDialog] setApprovalMode failed:', err);
      dispatchOpFailed({ op: '切换审批模式', message: `${friendlyOpError(err)} — 请重试或检查 server 状态` });
      throw err;
    });

  return (
    <>
      <ChoiceDialog<ApprovalMode>
        title={isZh ? '权限模式' : 'Permissions'}
        sub={sessionId
          ? (isZh ? 'Agent 动手之前什么时候先问你。只管这个会话, 马上生效。' : 'When the agent asks before acting. This session only, effective now.')
          : (isZh ? '新会话默认用哪一档。' : 'Default for new sessions.')}
        options={getApprovalOptions(isZh).map((o) => ({
          id: o.key,
          art: APPROVAL_ART[o.key],
          name: o.label,
          points: isZh ? APPROVAL_POINTS[o.key].zh : APPROVAL_POINTS[o.key].en,
          ...(o.key === 'dangerous' ? { tone: 'danger' as const } : {}),
        }))}
        current={mode}
        onPick={(next) => {
          if (next === 'dangerous') { setConfirmDangerous(true); return; }
          return commit(next);
        }}
        onClose={onClose}
      />
      {confirmDangerous && createPortal(
        <DangerousConfirmDialog
          onCancel={() => setConfirmDangerous(false)}
          onConfirm={() => {
            setConfirmDangerous(false);
            void commit('dangerous', { acknowledgeNoApproval: true, acknowledgeHighRiskExecution: true }).catch(() => {});
          }}
        />,
        document.body,
      )}
    </>
  );
};

const ConversationModeDialog: React.FC<{
  chatMode: boolean;
  onPick: (chat: boolean) => void;
  onClose: () => void;
}> = ({ chatMode, onPick, onClose }) => {
  const { isZh } = useI18n();
  return (
    <ChoiceDialog<'agent' | 'chat'>
      title={isZh ? '对话方式' : 'Conversation mode'}
      sub={isZh ? '这个会话接下来怎么跑。新会话沿用上次选的。' : 'How this conversation runs from here. New conversations keep your last choice.'}
      options={[
        {
          id: 'agent',
          art: NeoxIllus.modeAgent,
          name: 'Agent',
          lead: isZh ? '动手把事做完' : 'Gets the work done',
          points: isZh
            ? ['读写文件、跑命令、上网查', '多步推进, 做完再汇报', '改代码、做文档、查问题']
            : ['Reads and edits files, runs commands, browses', 'Works through multiple steps to the end', 'Code changes, documents, debugging'],
        },
        {
          id: 'chat',
          art: NeoxIllus.modeChat,
          name: isZh ? '聊天' : 'Chat',
          lead: isZh ? '只对话, 能搜索和画图' : 'Talk, search and draw',
          points: isZh
            ? ['不读文件、不跑命令', '回得快, 最省 token', '问答、写作、翻译、出主意']
            : ["Doesn't touch files or run commands", 'Fastest replies, fewest tokens', 'Q&A, writing, translation, ideas'],
        },
      ]}
      current={chatMode ? 'chat' : 'agent'}
      onPick={(id) => onPick(id === 'chat')}
      onClose={onClose}
    />
  );
};

/* ============================================================
 * DangerousConfirmDialog · YOLO 模式进入前的双勾确认
 *
 *   切 dangerous (YOLO) 一旦生效, 工具调用全部静默放行 (含 sandbox 白名单外的 shell);
 *   用户必须勾两条 acknowledge 才能 commit. 任意一条没勾 → 启用钮 disabled.
 *
 *   不做"输入 YOLO 确认"那种额外摩擦, 走"双 checkbox + 红色启用按钮"的标准危险操作 UX.
 *   Esc / 取消 / 点遮罩都 = cancel. 自动 focus 取消, 不 focus 启用 (防止误回车).
 * ============================================================ */
const DangerousConfirmDialog: React.FC<{
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ onCancel, onConfirm }) => {
  const { isZh } = useI18n();
  const [ackNoApproval, setAckNoApproval] = useState(false);
  const [ackHighRisk, setAckHighRisk] = useState(false);
  const canConfirm = ackNoApproval && ackHighRisk;

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="atl-dangerous" role="dialog" aria-modal="true" aria-label={isZh ? '确认切到「都不问」' : 'Enable YOLO mode confirmation'} onClick={onCancel}>
      <div className="atl-dangerous__box" onClick={(e) => e.stopPropagation()}>
        {/* 中文标题跟档位名保持一致 (「都不问」), 别在这儿又冒出个 YOLO —— 同一个东西两个名字,
            * 用户看不出这个弹窗说的就是他刚点的那一档。英文保留 YOLO。 */}
        <h3 className="atl-dangerous__title">{isZh ? '切到「都不问」' : 'Enable YOLO mode'}</h3>
        <p className="atl-dangerous__desc">
          {isZh ? '所有工具调用将直接执行，不再请求确认。' : 'All tool calls will run directly, without asking for confirmation.'}
        </p>
        <div className="atl-dangerous__checks">
          <label className="atl-dangerous__check">
            <span className={`atl-dangerous__checkbox${ackNoApproval ? ' is-checked' : ''}`} aria-hidden="true">
              {ackNoApproval && <svg viewBox="0 0 12 12" width="10" height="10"><path d="M2.5 6.2 L5 8.5 L9.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </span>
            <input type="checkbox" checked={ackNoApproval} onChange={(e) => setAckNoApproval(e.target.checked)} />
            <span className="atl-dangerous__check-text">{isZh ? '不再有审批弹窗，工具直接执行' : 'No more approval dialogs — tools run directly'}</span>
          </label>
          <label className="atl-dangerous__check">
            <span className={`atl-dangerous__checkbox${ackHighRisk ? ' is-checked' : ''}`} aria-hidden="true">
              {ackHighRisk && <svg viewBox="0 0 12 12" width="10" height="10"><path d="M2.5 6.2 L5 8.5 L9.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </span>
            <input type="checkbox" checked={ackHighRisk} onChange={(e) => setAckHighRisk(e.target.checked)} />
            <span className="atl-dangerous__check-text">{isZh ? '可能产生不可恢复的副作用，我自行承担' : 'May cause irreversible side effects — I accept the risk'}</span>
          </label>
        </div>
        <div className="atl-dangerous__btns">
          <button type="button" className="atl-dangerous__btn atl-dangerous__btn--cancel" onClick={onCancel} autoFocus>{isZh ? '取消' : 'Cancel'}</button>
          <button type="button" className="atl-dangerous__btn atl-dangerous__btn--confirm" onClick={onConfirm} disabled={!canConfirm}>{isZh ? '启用' : 'Enable'}</button>
        </div>
      </div>
    </div>
  );
};

type ApprovalRiskLevel = 'low' | 'medium' | 'high' | 'critical' | undefined;


export const ApprovalBanner: React.FC<{
  request: PendingApproval;
  onReply: (approved: boolean, remember: boolean) => void | Promise<void>;
}> = ({ request, onReply }) => {
  const { isZh } = useI18n();
  const [open, setOpen] = useState(false);
  const risk = (request.risk?.level as ApprovalRiskLevel) ?? 'low';
  const { toolName, rawName: rawTool, summary, args: unwrappedArgs } = useMemo(
    () => unwrapApprovalTool(request, isZh),
    [request, isZh],
  );
  /* 操作电脑 / 操作浏览器的展开层不放 JSON, 放逐条步骤 —— 卡上那一行只摊几步, 剩下的在这儿看全。
   * 浏览器里要跑的脚本原文附在下面 (跟 Claude Code 审批一样: 人话在上, 真要执行的东西原样给你看)。 */
  const computerSteps = useMemo(
    () => approvalSteps(rawTool, unwrappedArgs, isZh),
    [rawTool, unwrappedArgs, isZh],
  );
  const pageScripts = useMemo(() => {
    if (rawTool !== 'browser_run' || !Array.isArray((unwrappedArgs as { steps?: unknown }).steps)) return [];
    return ((unwrappedArgs as { steps: Array<{ action?: string; args?: { expression?: unknown } }> }).steps)
      .filter((s) => s?.action === 'eval' && typeof s.args?.expression === 'string')
      .map((s) => String(s.args!.expression));
  }, [rawTool, unwrappedArgs]);
  const actionName = (isZh && APPROVAL_ACTION_ZH[rawTool]) || toolName;
  /* 后端 reason 是英文硬编码 (kernel 层不该管 UI 语言), 中文界面按工具名查本地文案。
   * 它对每条同类调用都一样, 不占默认那一行 —— 进展开层, 跟完整参数放一起。 */
  const reasonText = useMemo(() => {
    const key = rawTool;
    /* 按风险弹的卡 (computer_run 这类) 不在中文表里; request.reason 的 "Risk HIGH:" 前缀是给日志看的,
     * 风险等级已由盾牌颜色说了。直接取信号那句 (更具体: 带 App 名和步数)。 */
    const signal = request.risk?.signals?.find((s) => s.message)?.message;
    const text = (isZh ? APPROVAL_REASON_ZH[key] : undefined) ?? signal ?? request.reason ?? '';
    return text.replace(/^[⚠️️\s]+/, '');
  }, [request, isZh]);

  return (
    <div className={`atl-approve atl-approve--${risk}${open ? ' is-open' : ''}`} role="alertdialog" aria-label={isZh ? '工具审批' : 'Tool approval'}>
      <div className="atl-approve__line">
        <span className="atl-approve__icon" aria-hidden>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 1.8 13 3.6v4.2c0 3-2.1 5.2-5 6.4-2.9-1.2-5-3.4-5-6.4V3.6L8 1.8Z" />
            <path d="M5.9 7.9 7.4 9.4l2.9-3" />
          </svg>
        </span>
        <span className="atl-approve__action">{actionName}</span>
        {summary && (() => {
          const { head, tail } = splitApprovalArg(summary);
          return (
            <span className="atl-approve__cmd" title={summary}>
              {head && <span className="atl-approve__cmd-head">{head}</span>}
              <span className="atl-approve__cmd-tail">{tail}</span>
            </span>
          );
        })()}
        <span className="atl-approve__spacer" />
        <button
          type="button"
          className={`atl-approve__toggle${open ? ' is-open' : ''}`}
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
          title={isZh ? (open ? '收起' : '看完整内容') : (open ? 'Collapse' : 'Show full request')}
        >
          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m3 4.5 3 3 3-3" /></svg>
        </button>
        <button
          type="button"
          className="atl-approve__btn atl-approve__btn--deny"
          onClick={() => void onReply(false, false)}
          title={isZh ? '本次拒绝' : 'Deny this call'}
        >{isZh ? '拒绝' : 'Deny'}</button>
        {request.allowRemember && (
          <button
            type="button"
            className="atl-approve__btn"
            onClick={() => void onReply(true, true)}
            title={isZh ? '本会话内同工具自动允许 (走 PermissionManager 内存记忆)' : 'Auto-allow this tool for the rest of the session (in-memory)'}
          >{isZh ? '一直允许' : 'Always'}</button>
        )}
        <button
          type="button"
          className="atl-approve__btn atl-approve__btn--approve"
          onClick={() => void onReply(true, false)}
          title={isZh ? '只批准这一次' : 'Approve this call only'}
        >{isZh ? '允许' : 'Allow'}</button>
      </div>
      <ApprovalProvenanceLine provenance={request.provenance} isZh={isZh} />
      {/* 展开层 = 放不下的东西: 参数原文 (完整路径/整条命令) + 这个工具会做什么。折叠时一个像素都不占。 */}
      {open && (
        <div className="atl-approve__detail">
          {computerSteps.length > 0 ? (
            <ol className="atl-approve__steps">
              {computerSteps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          ) : summary && <div className="atl-approve__full">{summary}</div>}
          {pageScripts.map((code, i) => (
            <pre key={i} className="atl-approve__code">{code.length > 600 ? `${code.slice(0, 600)}…` : code}</pre>
          ))}
          {reasonText && <div className="atl-approve__why">{reasonText}</div>}
        </div>
      )}
    </div>
  );
};

/* ============================================================
 * IconToolButton · 通用小 icon 按钮 (24x22)
 * ============================================================ */
const IconToolButton = React.forwardRef<HTMLButtonElement, {
  icon: React.ReactNode;
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
}>(({ icon, title, onClick, disabled, active }, ref) => (
  <button
    ref={ref}
    type="button"
    className={`atl-composer__iconbtn${active ? ' is-active' : ''}`}
    onClick={onClick}
    disabled={disabled}
    title={title}
    aria-label={title}
  >
    {icon}
  </button>
));
IconToolButton.displayName = 'IconToolButton';

/* ============================================================
 * CompactOverflowTools · 窄宽时把次要工具 (Skills/MCP/快捷键) 收到 ⋯ popover
 *
 *   - ⋯ 按钮固定显示
 *   - 点开后 portal 一个小弹窗, 里面平铺三个 IconToolButton (跟非 compact 一样的组件)
 *   - 用 portal + fixed 避开 .neox-shell__main { overflow: hidden } 裁剪
 *   - SkillsDropdown / McpDropdown 内嵌后, 它们自己的 menu 会从内部按钮位置弹,
 *     视觉上是"⋯弹出小托盘 → 选 Skills → 二级菜单"两层级, 但每层都看得见
 * ============================================================ */
const CompactOverflowTools: React.FC<{
  skillsOpen: boolean;
  onToggleSkills: () => void;
  onPickSkill: (s: SkillRow) => void;
  mcpOpen: boolean;
  onToggleMcp: () => void;
}> = ({ skillsOpen, onToggleSkills, onPickSkill, mcpOpen, onToggleMcp }) => {
  const { isZh } = useI18n();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [popStyle, setPopStyle] = useState<React.CSSProperties | null>(null);

  /* 内部 skill/mcp 子菜单也算"在 popover 内" — 点中它们时不关闭. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (anchorRef.current && anchorRef.current.contains(t)) return;
      if (popRef.current && popRef.current.contains(t)) return;
      /* skills/mcp 内部菜单也在 body 下 (portal/absolute), 不能误关 */
      const el = t as HTMLElement;
      if (el.closest?.('.atl-skills__menu, .atl-mcp__menu')) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onEsc as any, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onEsc as any, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const update = () => {
      const a = anchorRef.current;
      if (!a) return;
      const rect = a.getBoundingClientRect();
      const popWidth = 132;
      const measuredHeight = popRef.current?.getBoundingClientRect().height ?? 0;
      setPopStyle(getComposerOverlayStyle({
        anchor: rect,
        width: popWidth,
        estimatedHeight: measuredHeight > 0 ? measuredHeight : 48,
        placement: 'top-start',
      }));
    };
    update();
    const raf = window.requestAnimationFrame(update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`atl-composer__iconbtn${open ? ' is-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={isZh ? '更多工具 (Skills / MCP)' : 'More tools (Skills / MCP)'}
        aria-label={isZh ? '更多工具' : 'More tools'}
        aria-expanded={open}
      >
        <svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor" aria-hidden>
          <circle cx="2.5" cy="6" r="1.1" />
          <circle cx="6" cy="6" r="1.1" />
          <circle cx="9.5" cy="6" r="1.1" />
        </svg>
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          className="atl-composer__overflow"
          role="menu"
          style={popStyle ?? { position: 'fixed', left: -9999, top: -9999, width: 132, zIndex: COMPOSER_POPOVER_Z }}
        >
          <SkillsDropdown open={skillsOpen} onToggle={onToggleSkills} onPick={onPickSkill} />
          <McpDropdown open={mcpOpen} onToggle={onToggleMcp} />
        </div>,
        document.body,
      )}
    </>
  );
};

/* ============================================================
 * SkillsDropdown · 列 skills (IPC skillsList), 点击插入 prompt 引用
 * ============================================================ */
type SkillRow = {
  id: string;
  name: string;
  description: string;
  category?: string;
  source: 'builtin' | 'user' | 'workspace' | 'mcp';
};

const SkillsDropdown: React.FC<{
  open: boolean;
  onToggle: () => void;
  onPick: (s: SkillRow) => void;
  emphasized?: boolean;
  /** 简约态: 不渲触发按钮, 用外部锚点定位 (加号) */
  hideTrigger?: boolean;
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** 简约态更紧的浮层密度 */
  compact?: boolean;
}> = ({ open, onToggle, onPick, emphasized, hideTrigger, anchorRef, compact }) => {
  const { isZh } = useI18n();
  const modeVariant = useAgentModeVariant();
  const [items, setItems] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<{ left: number; width: number; bottom?: number; top?: number } | null>(null);
  useEffect(() => {
    const el = anchorRef?.current ?? btnRef.current;
    if (!open || !el) { setPos(null); return; }
    const r = el.getBoundingClientRect();
    const width = compact ? 280 : 380;
    let left = r.left;
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
    const spaceAbove = r.top;
    const spaceBelow = window.innerHeight - r.bottom;
    /* 优先上弹 (composer 在窗口底部, 上方空间大); 若上方 < 200 才下弹 */
    if (spaceAbove >= 200 || spaceAbove >= spaceBelow) {
      /* bottom = 距窗口底部的距离; 让 menu 底缘落在按钮上 6px */
      setPos({ left, width, bottom: window.innerHeight - r.top + 6 });
    } else {
      setPos({ left, width, top: r.bottom + 6 });
    }
  }, [open, anchorRef, compact]);

  useEffect(() => {
    if (!open) return;
    const api = (window as any).neox;
    if (typeof api?.skillsList !== 'function') {
      setItems([]);
      return;
    }
    /* P1-16: 加 cancelled 防 popover 已关 / open 切换时 stale promise resolve 触发
     *  React unmounted setState warning + loading 状态闪烁. 同时 setLoading 在
     *  try/finally 顺序固定避免同步抛漏 (虽然 .invoke 不会同步抛, 但加层防御无害). */
    let cancelled = false;
    setLoading(true);
    api.skillsList({ userInvocable: true })
      .then((list: any[]) => {
        if (cancelled) return;
        // description i18n: 英文 UI 优先 description_en, 缺失才回落 description.
        const rows: SkillRow[] = (list ?? [])
          .filter((s) => s.source !== 'builtin')   /* 只列用户自己的技能, 同斜杠菜单 */
          .filter((s) => modeVariant.isSkillVisibleForMode(s.metadata?.neox?.category))
          .map((s) => ({
          id: s.id,
          name: s.metadata?.name ?? s.id,
          description: isZh
            ? (s.metadata?.description ?? s.metadata?.description_en ?? '')
            : (s.metadata?.description_en ?? s.metadata?.description ?? ''),
          category: s.metadata?.neox?.category,
          source: s.source ?? 'builtin',
        }));
        setItems(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setItems([]);
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[Skills] list failed:', msg);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, modeVariant]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      /* portal 菜单在 body 下, 必须同时认 .atl-skills__menu; 加号本身也不算外点 */
      if (t.closest('.atl-skills, .atl-skills__menu, .atl-composer__plus')) return;
      onToggle();
    };
    const onEsc = (e: Event) => { if ((e as any).key === 'Escape') onToggle(); };
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onEsc);
    };
  }, [open, onToggle]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return items;
    return items.filter((s) =>
      s.name.toLowerCase().includes(query) ||
      s.description.toLowerCase().includes(query) ||
      s.id.toLowerCase().includes(query),
    );
  }, [q, items]);

  return (
    <div className="atl-skills">
      {!hideTrigger && (emphasized ? (
        <button
          ref={btnRef}
          type="button"
          className={`atl-skills__cta${open ? ' is-open' : ''}`}
          title={isZh ? '技能 — 旅行规划 / 写作辅助 / 生活工具等' : 'Skills — trip planning, writing help, life tools'}
          onClick={onToggle}
        >
          <IconZap size={12} />
          <span>{isZh ? '技能' : 'Skills'}</span>
        </button>
      ) : (
        <IconToolButton
          ref={btnRef}
          icon={<IconZap size={12} />}
          title="Skills"
          onClick={onToggle}
          active={open}
        />
      ))}
      {open && pos && createPortal(
        <div
          className={`atl-skills__menu atl-skills__menu--portal${compact ? ' is-compact' : ''}`}
          role="listbox"
          style={{
            left: pos.left,
            width: pos.width,
            ...(pos.bottom !== undefined ? { bottom: pos.bottom } : { top: pos.top }),
          }}
        >
          <input
            type="text"
            className="atl-skills__search"
            placeholder={isZh ? '搜 skill...' : 'Search skills...'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
          {loading && <div className="atl-skills__hint neox-text-shimmer">{isZh ? '加载中…' : 'Loading…'}</div>}
          {!loading && filtered.length === 0 && (
            <div className="atl-skills__hint">
              {items.length === 0
                ? (isZh ? '还没有自己的技能 · 去「技能」页创建' : 'No skills of your own yet — create one on the Skills page')
                : (isZh ? '无匹配' : 'No matches')}
            </div>
          )}
          <div className="atl-skills__list">
            {filtered.map((s) => (
              <button
                key={s.id}
                type="button"
                className="atl-skills__item"
                onClick={() => onPick(s)}
              >
                <span className="atl-skills__item-name">{s.name}</span>
                {s.category && <span className="atl-skills__item-cat">{s.category}</span>}
                <span className={`atl-skills__item-src atl-skills__item-src--${s.source}`}>
                  {s.source}
                </span>
                {s.description && (
                  <span className="atl-skills__item-desc">{s.description}</span>
                )}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

/* ============================================================
 * McpDropdown · 列 MCP 服务器 + 总开关 + 工具数
 * ============================================================ */
type McpServer = {
  id: string;
  name?: string;
  transport: string;
  enabled?: boolean;
  scope: string;
};

const McpDropdown: React.FC<{
  open: boolean;
  onToggle: () => void;
  hideTrigger?: boolean;
  anchorRef?: React.RefObject<HTMLElement | null>;
  compact?: boolean;
}> = ({ open, onToggle, hideTrigger, anchorRef, compact }) => {
  const { isZh } = useI18n();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [toolsMap, setToolsMap] = useState<Record<string, number>>({});
  const [enabled, setEnabled] = useState<boolean>(true);
  const [loading, setLoading] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<{ left: number; width: number; bottom?: number; top?: number } | null>(null);
  useEffect(() => {
    const el = anchorRef?.current ?? btnRef.current;
    if (!open || !el) { setPos(null); return; }
    const r = el.getBoundingClientRect();
    const width = compact ? 280 : 380;
    let left = r.left;
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
    const spaceAbove = r.top;
    const spaceBelow = window.innerHeight - r.bottom;
    if (spaceAbove >= 200 || spaceAbove >= spaceBelow) {
      setPos({ left, width, bottom: window.innerHeight - r.top + 6 });
    } else {
      setPos({ left, width, top: r.bottom + 6 });
    }
  }, [open, anchorRef, compact]);

  const refresh = useCallback(async () => {
    const api = (window as any).neox;
    if (typeof api?.mcpList !== 'function') return;
    setLoading(true);
    try {
      const [list, e] = await Promise.all([
        api.mcpList().catch(() => []),
        api.mcpGetEnabled?.().catch(() => true) ?? Promise.resolve(true),
      ]);
      setServers(list ?? []);
      setEnabled(!!e);
      /* 拉每个 server 的工具数 */
      const toolCounts: Record<string, number> = {};
      await Promise.all(
        (list ?? []).map(async (s: McpServer) => {
          try {
            /* 同上: mcpGetTools 回的是 {success, tools} 包装对象, 不是裸数组 */
            const res: any = await api.mcpGetTools?.(s.id);
            const tools = Array.isArray(res) ? res : (res?.tools ?? []);
            toolCounts[s.id] = Array.isArray(tools) ? tools.length : 0;
          } catch { toolCounts[s.id] = 0; }
        }),
      );
      setToolsMap(toolCounts);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.atl-mcp, .atl-mcp__menu, .atl-composer__plus')) return;
      onToggle();
    };
    const onEsc = (e: Event) => { if ((e as any).key === 'Escape') onToggle(); };
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onEsc);
    };
  }, [open, onToggle]);

  const handleToggleAll = async () => {
    const api = (window as any).neox;
    if (typeof api?.mcpSetEnabled !== 'function') return;
    const next = !enabled;
    await api.mcpSetEnabled(next);
    setEnabled(next);
  };

  const totalTools = Object.values(toolsMap).reduce((a, b) => a + b, 0);
  const connectedCount = servers.filter((s) => s.enabled !== false).length;

  return (
    <div className="atl-mcp">
      {!hideTrigger && (
        <IconToolButton
          ref={btnRef}
          icon={<IconTools size={12} />}
          title={isZh ? 'MCP 工具' : 'MCP tools'}
          onClick={onToggle}
          active={open}
        />
      )}
      {open && pos && createPortal(
        <div
          className={`atl-mcp__menu atl-mcp__menu--portal${compact ? ' is-compact' : ''}`}
          role="dialog"
          style={{
            left: pos.left,
            width: pos.width,
            ...(pos.bottom !== undefined ? { bottom: pos.bottom } : { top: pos.top }),
          }}
        >
          <div className="atl-mcp__head">
            <div className="atl-mcp__title">{isZh ? 'MCP 工具' : 'MCP tools'}</div>
            <label className="atl-mcp__switch">
              <input type="checkbox" checked={enabled} onChange={handleToggleAll} />
              <span>{enabled ? (isZh ? '已启用' : 'Enabled') : (isZh ? '已禁用' : 'Disabled')}</span>
            </label>
          </div>
          {loading && <div className="atl-mcp__hint neox-text-shimmer">{isZh ? '加载中…' : 'Loading…'}</div>}
          {!loading && servers.length === 0 && (
            <div className="atl-mcp__hint">{isZh ? '未配置 MCP server (设置 → MCP)' : 'No MCP servers configured (Settings → MCP)'}</div>
          )}
          {!loading && servers.length > 0 && (
            <>
              <div className="atl-mcp__summary">
                {isZh
                  ? `${connectedCount}/${servers.length} server · ${totalTools} 工具可用`
                  : `${connectedCount}/${servers.length} server${servers.length === 1 ? '' : 's'} · ${totalTools} tool${totalTools === 1 ? '' : 's'} available`}
              </div>
              <div className="atl-mcp__list">
                {servers.map((s) => (
                  <div key={s.id} className="atl-mcp__item">
                    <span
                      className="atl-mcp__dot"
                      data-enabled={s.enabled !== false ? '1' : '0'}
                      aria-hidden="true"
                    />
                    <span className="atl-mcp__name">{s.name || s.id}</span>
                    <span className="atl-mcp__transport">{s.transport}</span>
                    <span className="atl-mcp__toolcount">
                      {toolsMap[s.id] ?? 0} 工具
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
};

function useMentionPortalStyle(
  anchorRef: React.RefObject<HTMLElement | null>,
): React.CSSProperties {
  const [style, setStyle] = useState<React.CSSProperties>({
    position: 'fixed',
    left: 0,
    top: 0,
    width: 0,
    visibility: 'hidden',
  });
  useEffect(() => {
    function measure() {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setStyle({
        position: 'fixed',
        left: Math.round(rect.left),
        top: 'auto',
        right: 'auto',
        bottom: Math.round(window.innerHeight - rect.top + 6),
        width: Math.round(rect.width),
      });
    }
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [anchorRef]);
  return style;
}

export function mentionPathAddsInfo(name: string, pathOrDesc: string | undefined | null): boolean {
  const p = (pathOrDesc ?? '').trim();
  return p !== '' && p !== (name ?? '').trim();
}

/* ============================================================
 * AtPopover · @ 补全 (文件 / 文件夹 / 最近)
 * ============================================================ */
const AtPopover: React.FC<{
  items: AtItem[];
  activeIdx: number;
  onPick: (item: AtItem) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  /** 当前工作区 —— 路径去掉这个前缀再显示, 见下面 pathOrDesc 的说明 */
  workspacePath?: string;
}> = ({ items, activeIdx, onPick, onClose, anchorRef, workspacePath }) => {
  const portalStyle = useMentionPortalStyle(anchorRef);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest('.atl-mention');
      if (!el) onClose();
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [onClose]);
  return createPortal(
    <div className="atl-mention" role="listbox" style={portalStyle}>
      {items.map((it, i) => {
        const ext = it.path.match(/\.(\w+)$/)?.[1];
        const kindLabel =
          it.kind === 'recent' ? 'RECENT' :
          it.kind === 'folder' ? 'DIR' :
          it.kind === 'git' ? 'GIT' :
          it.kind === 'codebase' ? 'CODE' :
          it.kind === 'computer' ? 'CU' :
          it.kind === 'browser' ? 'WEB' :
          ext ? ext.toUpperCase() : '';
        const pathOrDesc = (it.kind === 'git' || it.kind === 'codebase' || it.kind === 'computer' || it.kind === 'browser')
          ? (it.description || it.path)
          : displayWorkspacePath(it.path, workspacePath, { max: 44, headSegments: 1, tailSegments: 2 });
        const showPath = mentionPathAddsInfo(it.name, pathOrDesc);
        return (
          <button
            key={`${it.kind}:${it.path}`}
            type="button"
            className={`atl-mention__item${i === activeIdx ? ' is-active' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); onPick(it); }}
            role="option"
            aria-selected={i === activeIdx}
          >
            <span className="atl-mention__name">
              {it.kind === 'folder' ? '📁 ' : it.kind === 'recent' ? '⟲ ' : it.kind === 'git' ? '⎇ ' : it.kind === 'codebase' ? '◈ ' : it.kind === 'computer' ? '🖥 ' : it.kind === 'browser' ? '🌐 ' : ''}
              {it.name}
            </span>
            {/* 这一列即使没内容也要留着: 行是 `auto 1fr auto` 的三列网格, 抽掉中间那格
              * 右边的 DIR / MD 角标会掉进 1fr 里, 从右缘跑到名字边上。 */}
            <span className="atl-mention__path">{showPath ? pathOrDesc : ''}</span>
            {kindLabel && <span className={`atl-mention__ext atl-mention__ext--${it.kind}`}>{kindLabel}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
};

/* ============================================================
 * SlashPopover · / 命令补全 (skills)
 * ============================================================ */
const SlashPopover: React.FC<{
  items: SlashItem[];
  activeIdx: number;
  onPick: (item: SlashItem) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLDivElement | null>;
}> = ({ items, activeIdx, onPick, onClose, anchorRef }) => {
  const portalStyle = useMentionPortalStyle(anchorRef);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest('.atl-mention');
      if (!el) onClose();
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [onClose]);
  return createPortal(
    <div className="atl-mention atl-mention--slash" role="listbox" style={portalStyle}>
      {items.map((it, i) => (
        <button
          key={it.id}
          type="button"
          className={`atl-mention__item atl-mention__item--slash${i === activeIdx ? ' is-active' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); onPick(it); }}
          role="option"
          aria-selected={i === activeIdx}
        >
          <span className="atl-mention__name">{it.builtin ? it.name : `/${it.id}`}</span>
          {it.category && <span className="atl-mention__ext">{it.category}</span>}
          {/* 单行省略 —— 描述本身写短 (见 buildBuiltinSlashItems), title 兜住完整文案 */}
          {it.description && (
            <span className="atl-mention__slash-desc" title={it.description}>{it.description}</span>
          )}
        </button>
      ))}
    </div>,
    document.body,
  );
};

/* ============================================================
 * HashPopover · # 编辑器引用 (当前 tab / 选中 / 所有 tab)
 * ============================================================ */
const HashPopover: React.FC<{
  items: HashItem[];
  activeIdx: number;
  onPick: (item: HashItem) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLDivElement | null>;
}> = ({ items, activeIdx, onPick, onClose, anchorRef }) => {
  const portalStyle = useMentionPortalStyle(anchorRef);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest('.atl-mention');
      if (!el) onClose();
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [onClose]);
  return createPortal(
    <div className="atl-mention atl-mention--hash" role="listbox" style={portalStyle}>
      {items.map((it, i) => {
        const key = it.kind === 'selection' ? 'sel' : (it.kind === 'tab' ? it.tabId : `active:${it.path}`);
        const ico = it.kind === 'selection' ? '✂' : it.kind === 'activeFile' ? '◉' : '⎘';
        const path = it.kind === 'selection' ? '' : it.path;
        return (
          <button
            key={key}
            type="button"
            className={`atl-mention__item${i === activeIdx ? ' is-active' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); onPick(it); }}
            role="option"
            aria-selected={i === activeIdx}
          >
            <span className="atl-mention__name">{ico} {it.name}</span>
            {path && <span className="atl-mention__path">{path}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
};


/* 小圆环 — 按钮里显进度 (14px). 通过外层 wrapper 强制 color=primary-700,
 * 让 currentColor 取主题色而不是 chip 文字色 (暖阳 chip 文字也是橘, 圆环融背景看不清). */
const CtxRingMini: React.FC<{ pct: number }> = ({ pct }) => {
  const r = 6, c = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(1, pct / 100)) * c;
  return (
    <span style={{ color: 'var(--neox-primary-700)', display: 'inline-flex' }}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
        <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity={0.22} strokeWidth={2} />
        <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth={2}
          strokeDasharray={`${dash} ${c - dash}`} strokeLinecap="round"
          transform="rotate(-90 8 8)" />
      </svg>
    </span>
  );
};

const ContextButton: React.FC<{
  used: number;
  max: number;
  totalTokens?: number;
  pending?: number;
  sessionId?: string;
  /** 简约态: 不渲染触发按钮, 由加号菜单控制弹层 */
  hideTrigger?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** hideTrigger 时用外部锚点定位弹层 (通常是加号按钮) */
  externalAnchorRef?: React.RefObject<HTMLElement | null>;
  /** 时间线里有进行中的压缩 (手动或自动) —— 量筒据此播压液动画 */
  compactionActive?: boolean;
  compactionPct?: number | null;
}> = ({
  used, max, totalTokens, pending, sessionId,
  hideTrigger = false, open: openProp, onOpenChange, externalAnchorRef,
  compactionActive, compactionPct,
}) => {
  const { isZh } = useI18n();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [openInner, setOpenInner] = useState(false);
  const open = openProp ?? openInner;
  const setOpen = useCallback((next: boolean | ((v: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(openProp ?? openInner) : next;
    if (onOpenChange) onOpenChange(value);
    else setOpenInner(value);
  }, [onOpenChange, openProp, openInner]);
  const { compactActiveSession, streaming } = useNeoxRuntime();
  const [compacting, setCompacting] = useState(false);
  const hasAnyContext = used > 0;
  const onCompact = useCallback(async () => {
    if (streaming || compacting || !hasAnyContext) return;
    setCompacting(true);
    try {
      await compactActiveSession();
    } catch (err) {
      console.warn('[ContextButton] compact failed', err);
    } finally {
      setCompacting(false);
    }
  }, [compactActiveSession, streaming, compacting, hasAnyContext]);

  /* 模型未配置 fallback — 仍然显示按钮但禁用百分比, pending 时给 ~tok 提示 */
  const hasMax = max > 0;
  const pct = hasMax ? Math.max(0, Math.min(100, (used / max) * 100)) : 0;
  const tone = pct >= 90 ? 'is-crit' : pct >= 70 ? 'is-warn' : '';

  const title = hasMax
    ? (isZh
        ? `上下文: ${fmtTok(used)} / ${fmtTok(max)} · ${pct.toFixed(1)}%${pending && pending > 0 ? ` · 本轮 +${fmtTok(pending)}` : ''}`
        : `Context: ${fmtTok(used)} / ${fmtTok(max)} · ${pct.toFixed(1)}%${pending && pending > 0 ? ` · +${fmtTok(pending)} this turn` : ''}`)
    : (pending && pending > 0
        ? (isZh ? `本轮发送预估 ~${fmtTok(pending)} tokens` : `~${fmtTok(pending)} tokens estimated for this send`)
        : (isZh ? '点击查看上下文详情' : 'Click to view context details'));

  const detailAnchor = (hideTrigger ? externalAnchorRef : null)
    ?? (anchorRef as unknown as React.RefObject<HTMLElement | null>);

  return (
    <>
      {!hideTrigger && (
        <button
          ref={anchorRef}
          type="button"
          className={`atl-ctx-btn ${tone}`}
          title={title}
          onClick={() => setOpen(v => !v)}
        >
          <span className="atl-ctx-btn__ring"><CtxRingMini pct={pct} /></span>
          <span className="atl-ctx-btn__label">{isZh ? '上下文' : 'Context'}</span>
          <span className="atl-ctx-btn__pct">{hasMax ? `${Math.round(pct)}%` : (pending && pending > 0 ? `~${fmtTok(pending)}` : '—')}</span>
        </button>
      )}
      {open && (
        <BatteryDetail
          used={used}
          max={max}
          totalTokens={totalTokens}
          sessionId={sessionId}
          onClose={() => setOpen(false)}
          anchorRef={detailAnchor as unknown as React.RefObject<HTMLDivElement | null>}
          compact={{
            onCompact,
            active: compacting || !!compactionActive,
            pct: compactionPct ?? null,
            disabledReason: !hasAnyContext
              ? (isZh ? '还没有上下文' : 'No context yet')
              : streaming && !compacting && !compactionActive
                ? (isZh ? '本轮结束后可压缩' : 'Available after this turn')
                : null,
          }}
        />
      )}
    </>
  );
};

/* ContextDetailPopup 的数据源桥: 从 contextSnapshot 模块 fallback memorySnapshot /
 * latestRequestUsage / sessionCache, 这些是 WorkspacePage 写入的全局快照;
 * NeoxShellHost 路径没有写入, 相应字段会是 null, popup 自己会 graceful degrade. */
const BatteryDetail: React.FC<{
  used: number;
  max: number;
  totalTokens?: number;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  sessionId?: string;
  compact?: ContextCompactControl;
}> = ({ used, max, totalTokens, onClose, anchorRef, sessionId, compact }) => {
  const snap = useContextSnapshot(sessionId);
  const effectiveUsed = (used && used > 0)
    ? used
    : Math.max(snap?.tokensUsed || 0, snap?.latestRequestUsage?.totalTokens || 0);
  const effectiveMax = max > 0 ? max : (snap?.contextWindow || 0);
  return (
    <ContextDetailPopup
      contextUsed={effectiveUsed}
      maxContext={effectiveMax}
      totalTokens={totalTokens}
      memorySnapshot={{
        tokensUsed: effectiveUsed,
        contextWindow: effectiveMax,
        breakdown: snap?.breakdown,
      }}
      latestRequestUsage={snap?.latestRequestUsage ?? null}
      sessionCache={snap?.sessionCache ?? null}
      sessionId={sessionId}
      onClose={onClose}
      anchorRef={anchorRef as React.RefObject<HTMLDivElement>}
      compact={compact}
    />
  );
};
function fmtTok(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/* ============================================================
 * AttachmentPreview · 点击 pill 后的预览浮层
 *   · image 用 lightbox (复用 .atl-lightbox)
 *   · file  用 内容预览框 (monospace + scroll)
 * ============================================================ */
const AttachmentPreview: React.FC<{
  att: Attachment;
  onClose: () => void;
}> = ({ att, onClose }) => {
  const { isZh } = useI18n();

  useEffect(() => {
    if (att.type === 'image') return; /* 图片的 Esc 由 Lightbox 自己管 */
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, att.type]);

  /* 图片跟消息里的看图同一个组件 (cells/attachments.tsx Lightbox): 双指开合 / 拖动 / 双击放大都在那 */
  if (att.type === 'image' && att.data) {
    return <Lightbox src={att.data} name={att.name} size={att.size} onClose={onClose} />;
  }
  const body = att.data || att.preview || (isZh ? '(内容为空 — 将在发送时由 agent 读取)' : '(empty — the agent will read this on send)');
  const sizeLabel = att.size ? formatSize(att.size) : `${body.length} chars`;
  return createPortal(
    <div className="atl-filepreview" onClick={onClose} role="dialog" aria-modal="true">
      <div className="atl-filepreview__box" onClick={(e) => e.stopPropagation()}>
        <div className="atl-filepreview__head">
          <div className="atl-filepreview__title">
            <span className="atl-filepreview__ico">📎</span>
            <span className="atl-filepreview__name">{att.name ?? att.path ?? (isZh ? '附件' : 'Attachment')}</span>
            {att.lineRange && (
              <span className="atl-filepreview__range">
                L{att.lineRange.start}-{att.lineRange.end}
              </span>
            )}
            {att.language && <span className="atl-filepreview__lang">{att.language}</span>}
          </div>
          <div className="atl-filepreview__meta">
            <span>{sizeLabel}</span>
            {att.path && <span className="atl-filepreview__path" title={att.path}>{att.path}</span>}
          </div>
          <button type="button" className="atl-filepreview__close" onClick={onClose} aria-label={isZh ? "关闭" : "Close"}>×</button>
        </div>
        <pre className="atl-filepreview__body">{body}</pre>
      </div>
    </div>,
    document.body,
  );
};

/* ============================================================
 * AttachmentChip / ModelPicker (不变, 从之前版本继承)
 * ============================================================ */
const AttachmentChip: React.FC<{ att: Attachment; onRemove: () => void }> = ({ att, onRemove }) => {
  const { isZh } = useI18n();
  const name = att.name || (att.type === 'image' ? (isZh ? '图片' : 'Image') : (isZh ? '附件' : 'Attachment'));
  const size = att.size ? formatSize(att.size) : '';
  return (
    <div className={`atl-att atl-att--${att.type}`}>
      {att.type === 'image' && att.data && <img src={att.data} alt={name} />}
      <div className="atl-att__body">
        <span className="atl-att__name">{name}</span>
        {size && <span className="atl-att__size">{size}</span>}
      </div>
      <button type="button" className="atl-att__remove" onClick={onRemove} aria-label={isZh ? '移除附件' : 'Remove attachment'}>×</button>
    </div>
  );
};
function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const IconCoin = (): React.ReactElement => (
  <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="8" cy="8" r="6" /><path d="M8 5v6M6 7h4M6 9h4" />
  </svg>
);

type ComposerModelPickerTab = 'subscription' | 'byok' | 'platform' | 'promo';

const isActivityPickerModel = (m: ModelInfo): boolean => /-event$/.test(m.name ?? '') || /-event$/.test(m.id ?? '');

const MODEL_PICKER_TAB_KEY = 'neox.model-selector.active-tab.v2';

const normalizePickerModelKey = (value?: string): string =>
  (value ?? '').replace(/-\d{8,}$/, '').trim().toLowerCase();

const extractPickerModelName = (model: ModelInfo): string => {
  if (model.name && model.name !== 'auto') return model.name;
  const separator = model.id?.indexOf(':') ?? -1;
  if (separator >= 0) return model.id.slice(separator + 1) || model.name || model.id;
  return model.id || model.name || '';
};

const pickerModelIdentityKey = (model: ModelInfo): string => normalizePickerModelKey(extractPickerModelName(model));

const scrollActivePickerModelIntoView = (menu: HTMLDivElement | null) => {
  if (!menu) return;
  const activeItem = menu.querySelector<HTMLElement>('.atl-model__item.is-active');
  if (!activeItem) return;
  const menuRect = menu.getBoundingClientRect();
  const itemRect = activeItem.getBoundingClientRect();
  const targetTop = menu.scrollTop + itemRect.top - menuRect.top
    - ((menu.clientHeight - activeItem.offsetHeight) / 2);
  menu.scrollTop = Math.max(0, targetTop);
};

/* auto 模型按 plan 派生展示名 — 跟 modelLabel useMemo 同款映射, 让菜单内 "auto" 行
 *  显示跟 composer 按钮一致的皮肤名 (Aurora Ultra / Vertex VIP 等). */
function getAutoDisplayName(_planSkinKey: string): string {
  return 'Auto';
}

const ModelPicker: React.FC<{
  label: string;
  isPlaceholder?: boolean;
  open: boolean;
  onToggle: () => void;
  models: ModelInfo[];
  selectedId?: string;
  onSelect: (m: ModelInfo) => void;
  byokPrefsVersion: number;
  /* 当前 plan id — 用来 gate "自动路由" section. free/trial 用户不显示, pro+ 才显示. */
  planId?: string;
  effortByModel?: Map<string, EffortLevel>; sentEffort?: EffortLevel;
  onEffortChange?: (modelId: string, level: EffortLevel) => void;
  hideEffortMenu?: boolean;
  /* 简约态胶囊: 只留品牌图标 + 折角, 不显模型名。
   * 胶囊本来就窄, 右栏一展开就更窄, 完整模型名 (deepseek-v4-flash 这种) 会把输入区挤掉一半,
   * placeholder 直接被截断。名字不丢 —— 收进 button 的 title/aria-label, 悬停即见。 */
  compact?: boolean;
}> = ({ label, isPlaceholder, open, onToggle, models: allModels, selectedId, onSelect, byokPrefsVersion, planId, effortByModel, sentEffort, onEffortChange, hideEffortMenu, compact }) => {
  const { isZh } = useI18n();
  const text = (zh: string, en: string) => (isZh ? zh : en);
  const { isAuthenticated } = useAuth();
  const membership = useMembership();
  const membershipStatus = useMembershipStatus();
  const isSubscriptionLoading = isAuthenticated && membershipStatus.loading && !membership;
  const subscriptionFetchFailed = isAuthenticated && !membership && !!membershipStatus.lastError;

  /* ---------- 分组 ----------
   *   订阅 (Neox Cloud) 和 BYOK 是两条独立来源; 自动路由是 BYOK 侧的虚拟模型, 挂在 BYOK 里。
   *   同名模型允许两边同时存在 (订阅走网关, BYOK 走用户自己的 key)。 */
  const autoRouted = allModels.filter((m) => m.isAutoRouted);
  const regular = allModels.filter((m) => !m.isAutoRouted);
  const subscription = regular.filter((m) => m.providerId === NEOX_CLOUD_PROVIDER_ID && !m.payAsYouGo);
  /* 按量组 = 整份平台目录 (开关打开后才有), 套餐里也有的 (DS 等) 也单独一条 ——
   * 挂在 neox-cloud-payg 下, 这一轮只扣平台余额; 按目录顺序排 */
  const platform = useEditionPlatformModels();
  const paygAll = regular
    .filter((m) => m.providerId === NEOX_CLOUD_PAYG_PROVIDER_ID)
    .sort((a, b) => (a.payAsYouGoRank ?? 0) - (b.payAsYouGoRank ?? 0));
  /* 限时活动单独一组 (*-event); 特惠款 (*-promo) 是按量商品, 照常留在按量组 */
  const promoList = paygAll.filter(isActivityPickerModel);
  const platformList = paygAll.filter((m) => !isActivityPickerModel(m));
  const promoCredit = membership?.promoCredit;
  const promoUsd = promoCredit && promoCredit.balanceMicros > 0 ? promoCredit.balanceMicros / 1_000_000 : 0;
  /* provider 级开关 + 模型级挑选 (设置·显示控制里按模型勾选) 双重过滤 */
  const pinnedByok = useMemo(() => {
    void byokPrefsVersion;
    const hiddenByProvider = new Map<string, Set<string> | null>();
    return allModels.filter((m) => {
      if (m.isAutoRouted || isNeoxCloudProviderId(m.providerId)) return false;
      let hidden = hiddenByProvider.get(m.providerId);
      if (hidden === undefined) {
        hidden = isByokPinned(m.providerId) ? getByokHiddenModels(m.providerId) : null;
        hiddenByProvider.set(m.providerId, hidden);
      }
      return hidden !== null && !hidden.has(m.name);
    });
  }, [allModels, byokPrefsVersion]);
  /* 兜底: 订阅/自动路由/勾选后的 BYOK 全空, 但 regular 还有 → 全放出来, 别让用户无模型可选 */
  const byokList = (subscription.length === 0 && pinnedByok.length === 0 && autoRouted.length === 0)
    ? regular
    : [...autoRouted, ...pinnedByok];

  const selectedModel = selectedId ? allModels.find((m) => m.id === selectedId) : undefined;
  const autoDisplayName = getAutoDisplayName(planId ?? '');
  const brand = inferProviderBrand({
    id: selectedModel?.id,
    name: selectedModel?.name ?? label,
    protocol: selectedModel?.protocol,
    providerId: selectedModel?.providerId,
  });
  const isSelectedModelActive = React.useCallback((model: ModelInfo) => {
    if (model.id === selectedId) return true;
    if (!selectedModel) return false;
    if (model.providerId !== selectedModel.providerId) return false;
    return pickerModelIdentityKey(model) === pickerModelIdentityKey(selectedModel);
  }, [selectedId, selectedModel]);

  const [submenu, setSubmenu] = React.useState<ComposerModelPickerTab | null>(null);
  const [submenuAnchor, setSubmenuAnchor] = React.useState<DOMRect | null>(null);
  const [modelQuery, setModelQuery] = useState('');
  const q = modelQuery.trim().toLowerCase();
  const matchQuery = useCallback((m: ModelInfo) => {
    if (!q) return true;
    return `${m.name ?? ''} ${(m as any).provider ?? ''} ${m.providerId ?? ''}`.toLowerCase().includes(q);
  }, [q]);
  const submenuModels = React.useMemo(() => {
    const base = submenu === 'subscription' ? subscription : submenu === 'platform' ? platformList : submenu === 'promo' ? promoList : byokList;
    return q ? base.filter(matchQuery) : base;
  }, [submenu, subscription, platformList, promoList, byokList, q, matchQuery]);

  const [schemaInfoMap, setSchemaInfoMap] = React.useState<Map<string, SchemaEffortInfo>>(() => new Map());
  React.useEffect(() => {
    if (!open) return;
    const fn = (window as any).neox?.getSchemaModelInfo;
    if (typeof fn !== 'function') {
      console.warn('[ModelPicker] getSchemaModelInfo IPC not bound — relying on hardcoded fallback');
      return;
    }
    let cancelled = false;
    const ids = allModels.map((m) => m.id);
    Promise.all(ids.map((id) => fn(id).catch((e: any) => { console.warn('[ModelPicker] schema fetch failed', id, e); return null; }))).then((infos: any[]) => {
      if (cancelled) return;
      const m = new Map<string, any>();
      for (let i = 0; i < ids.length; i++) if (infos[i]) m.set(ids[i], infos[i]);
      setSchemaInfoMap(m);
    });
    return () => { cancelled = true; };
  }, [open, allModels]);
  const fallbackHasEffort = React.useCallback((modelName: string): boolean => {
    const n = (modelName || '').toLowerCase();
    if (/claude-opus-4/.test(n)) return true;             /* claude-opus-4-7 / 4-8 有 native effort */
    if (/\bgpt\b.*5|^o\d|codex/.test(n)) return true;     /* gpt-5.x / o1/o3/o4 / codex 有 reasoning_effort */
    if (/gemini-3/.test(n)) return true;                  /* gemini-3.x 有 thinking_budget / thinking_level */
    if (/deepseek-v4|deepseek-r1|deepseek-reasoner/.test(n)) return true;
    return false;
  }, []);
  const selectedHasEffort = !!selectedModel && (
    !!schemaInfoMap.get(selectedModel.id)?.hasEffortMap || fallbackHasEffort(`${selectedModel.id} ${selectedModel.name}`)
  );
  const showEffort = !hideEffortMenu && !!onEffortChange && !!selectedModel && selectedHasEffort && open && !thinkChipVisible();

  const handleSelectModel = React.useCallback((m: ModelInfo) => {
    onSelect(m);
    setSubmenu(null);
    setSubmenuAnchor(null);
    onToggle();
  }, [onSelect, onToggle]);
  const handlePickEffort = React.useCallback((level: EffortLevel) => {
    if (!selectedModel || !onEffortChange) return;
    onEffortChange(selectedModel.id, level);
  }, [onEffortChange, selectedModel]);

  React.useEffect(() => {
    if (!open) { setSubmenu(null); setSubmenuAnchor(null); setModelQuery(''); }
  }, [open]);
  const toggleSubmenu = (kind: ComposerModelPickerTab, e: React.MouseEvent<HTMLButtonElement>) => {
    const row = (e.currentTarget.closest('.atl-model__source') ?? e.currentTarget).getBoundingClientRect();
    const menu = (e.currentTarget.closest('.atl-model__menu') ?? e.currentTarget).getBoundingClientRect();
    const rect = new DOMRect(menu.left, row.top, menu.width, row.height);
    setModelQuery('');
    if (submenu === kind) { setSubmenu(null); setSubmenuAnchor(null); return; }
    setSubmenu(kind);
    setSubmenuAnchor(rect);
    try { localStorage.setItem(MODEL_PICKER_TAB_KEY, kind); } catch { /* ignore */ }
  };
  /* ESC: 先收二级, 二级已关才由外层关整个 picker (外层 keydown 也监听 ESC, 这里 stop 掉) */
  React.useEffect(() => {
    if (!submenu) return;
    const onEsc = (e: Event) => {
      if ((e as unknown as { key?: string }).key !== 'Escape') return;
      e.stopPropagation();
      setSubmenu(null); setSubmenuAnchor(null);
    };
    document.addEventListener('keydown', onEsc, true);
    return () => document.removeEventListener('keydown', onEsc, true);
  }, [submenu]);

  /* "更多设置" → 跳设置 / 模型 profile tab. AppShell 接事件切 tab. */
  const openSettingsTab = (tab: 'modelprofile' | 'providers') => {
    setSubmenu(null);
    setSubmenuAnchor(null);
    if (open) onToggle();
    try { localStorage.setItem('neox-settings-initial-tab', tab); } catch { /* ignore */ }
    try {
      window.dispatchEvent(new CustomEvent('neox:open-settings', { detail: { tab } }));
    } catch { /* ignore */ }
  };
  const openMoreSettings = () => { openSettingsTab('modelprofile'); };
  const openProvidersSettings = () => { openSettingsTab('providers'); };

  /* ---------- 定位 ---------- */
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  /* 一级菜单的内容层 — 高度不被 inline maxHeight 钳住, 用它测真实内容高 + 挂 ResizeObserver。
   *   推理强度那段的档位是异步 schema 回来后才长出来的, 只靠 deps 重算会漏掉那一次增高。 */
  const menuBodyRef = React.useRef<HTMLDivElement>(null);
  const subListRef = React.useRef<HTMLDivElement>(null);
  /* 二级菜单容器 —— 要拿它的**真实高度**再夹一次 top, 见 submenuTopFix */
  const subMenuRef = React.useRef<HTMLDivElement>(null);
  const [submenuTopFix, setSubmenuTopFix] = React.useState<{ top: number; maxHeight: number | null } | null>(null);
  /* 搜索词一变列表就重排了, 旧的键盘高亮会落在错的行上 —— 清掉重来。 */
  React.useEffect(() => {
    subListRef.current?.querySelectorAll<HTMLElement>('[data-kb-active]')
      .forEach(el => { delete el.dataset.kbActive; });
  }, [modelQuery]);
  React.useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const rows = menuRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
      if (!rows || rows.length === 0) return;
      const checked = [...rows].find(el =>
        el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true');
      (checked ?? rows[0]).focus();
    }, 0);
    return () => {
      window.clearTimeout(t);
      if (!document.activeElement || document.activeElement === document.body) {
        btnRef.current?.focus();
      }
    };
  }, [open]);
  const [menuStyle, setMenuStyle] = React.useState<React.CSSProperties | null>(null);
  const lastMenuStyleKeyRef = React.useRef<string>('');
  /* updatePosition 提到 effect 外: ResizeObserver 要在 portal 真挂上 (menuStyle 有值) 之后
   *   才挂得到 body 节点, 所以定位逻辑得被两个 effect 共用。 */
  const updateMenuPosition = React.useCallback(() => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const measured = menuRef.current?.getBoundingClientRect();
      const menuWidth = measured && measured.width > 0
        ? clampNumber(Math.max(measured.width, 280), 260, 340)
        : 288;
      const body = menuBodyRef.current;
      const contentHeight = body ? body.scrollHeight + MODEL_MENU_PAD * 2 : 0;
      const menuHeight = contentHeight || measured?.height || 320;
      const next = getComposerOverlayStyle({
        anchor: r,
        width: menuWidth,
        estimatedHeight: menuHeight,
        placement: 'top-start',
        gap: 8,
        constrainHeight: true,
      });
      /* 同值不 setState — ResizeObserver 回调里改 state 再触发 observe 会自激成死循环 */
      const key = `${next.left}|${next.top}|${next.width}|${next.maxHeight}`;
      if (key === lastMenuStyleKeyRef.current) return;
      lastMenuStyleKeyRef.current = key;
      setMenuStyle(next);
  }, []);
  React.useLayoutEffect(() => {
    if (!open) { setMenuStyle(null); lastMenuStyleKeyRef.current = ''; return; }
    updateMenuPosition();
    const raf = window.requestAnimationFrame(updateMenuPosition);
    const updatePositionFromOuterScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      updateMenuPosition();
    };
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updatePositionFromOuterScroll, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updatePositionFromOuterScroll, true);
    };
  }, [open, showEffort, selectedId, subscription.length, byokList.length, updateMenuPosition]);
  /* 内容长高了就重算 (推理强度档位是异步 schema 回来后才渲染的) */
  React.useEffect(() => {
    if (!open || !menuStyle || typeof ResizeObserver === 'undefined') return;
    const body = menuBodyRef.current;
    if (!body) return;
    const ro = new ResizeObserver(() => updateMenuPosition());
    ro.observe(body);
    return () => ro.disconnect();
  }, [open, !!menuStyle, updateMenuPosition]);
  /* 二级菜单: 锚在来源行右侧, 右边放不下自动翻到左侧; 高度吃到视口 (不再被 340px 卡死) */
  const submenuStyle = React.useMemo<React.CSSProperties | null>(() => {
    if (!submenuAnchor) return null;
    return getComposerOverlayStyle({
      anchor: submenuAnchor,
      width: 300,
      estimatedHeight: Math.round(Math.min(window.innerHeight * 0.7, 520)),
      placement: 'right-start',
      gap: 10,
      margin: 12,
      zIndex: COMPOSER_FLYOUT_Z,
      constrainHeight: true,
    });
  }, [submenuAnchor]);
  React.useLayoutEffect(() => {
    if (!submenu || !submenuStyle || !submenuAnchor) { setSubmenuTopFix(null); return; }
    const el = subMenuRef.current;
    if (!el) return;
    const h = el.getBoundingClientRect().height;
    if (!h) return;
    const MARGIN = 12;
    const maxTop = Math.max(MARGIN, window.innerHeight - h - MARGIN);
    let want = Math.min(Math.max(submenuAnchor.top, MARGIN), maxTop);

    const parent = document.querySelector('.atl-model__menu--home');
    const pb = parent?.getBoundingClientRect().bottom;
    if (pb !== undefined && want + h > pb) {
      want = Math.max(MARGIN, Math.min(want, pb - h));
    }
    const topbarBottom = document.querySelector('.neox-topbar')?.getBoundingClientRect().bottom ?? 0;
    const minTop = Math.max(MARGIN, topbarBottom + 8);
    let maxH: number | null = null;
    if (want < minTop) {
      want = minTop;
      const floor = pb !== undefined ? pb : window.innerHeight - MARGIN;
      maxH = Math.max(160, floor - minTop);
    }
    setSubmenuTopFix((prev) => (prev !== null && Math.abs(prev.top - want) < 1 && prev.maxHeight === maxH ? prev : { top: want, maxHeight: maxH }));
  }, [submenu, submenuStyle, submenuAnchor, submenuModels.length]);

  React.useLayoutEffect(() => {
    if (!submenu || !submenuStyle) return;
    scrollActivePickerModelIntoView(subListRef.current);
  }, [submenu, submenuStyle]);

  const currentName = isPlaceholder
    ? text('尚未选择模型', 'No model selected')
    : (selectedModel
      ? (isAutoRoutedModelName(selectedModel.name) ? autoDisplayName : (selectedModel.name || selectedModel.id))
      : label);
  const currentSource = !selectedModel
    ? ''
    : isNeoxCloudProviderId(selectedModel.providerId)
      ? (selectedModel.payAsYouGo
        ? (isActivityPickerModel(selectedModel)
          ? text('云端模型 · 活动金', 'Cloud · promo credit')
          : text('云端模型 · 按量 (平台余额)', 'Cloud · pay-as-you-go (balance)'))
        : text('云端模型 · 订阅', 'Cloud · subscription'))
      : `${(selectedModel as any).provider || selectedModel.providerId} · ${text('BYOK', 'BYOK')}${selectedModel.isAutoRouted ? text(' · 自动路由', ' · auto routing') : ''}`;

  /* 当前模型属于哪一档 —— 一级菜单要能一眼看出"我现在在订阅还是 BYOK" */
  const currentKind: ComposerModelPickerTab | null = !selectedModel
    ? null
    : isNeoxCloudProviderId(selectedModel.providerId)
      ? (selectedModel.payAsYouGo ? (isActivityPickerModel(selectedModel) ? 'promo' : 'platform') : 'subscription')
      : 'byok';

  const sourceRow = (kind: ComposerModelPickerTab, name: string, count: number, hint: string) => (
    <button
      type="button"
      className={`atl-model__source${submenu === kind ? ' is-open' : ''}${currentKind === kind ? ' is-current' : ''}`}
      onClick={(e) => toggleSubmenu(kind, e)}
      aria-haspopup="listbox"
      aria-expanded={submenu === kind}
      title={hint}
    >
      <span className="atl-model__source-name">{name}</span>
      {currentKind === kind && (
        <span className="atl-model__source-current">{text('当前', 'current')}</span>
      )}
      <span className="atl-model__source-count">{count}</span>
      <svg className="atl-model__source-caret" viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m4.5 2.5 3 3.5-3 3.5" />
      </svg>
    </button>
  );

  return (
    <div className="atl-model" data-tour="model" onClick={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        className={`atl-composer__model${isPlaceholder ? ' is-placeholder' : ''}${compact ? ' atl-composer__model--compact' : ''}`}
        title={isPlaceholder
          ? text('尚未选择模型 · 点击选择', 'No model selected · Click to choose')
          : (compact ? `${label} · ${text('点击切换模型', 'Click to switch model')}` : text('切换模型', 'Switch model'))}
        aria-label={isPlaceholder
          ? text('尚未选择模型', 'No model selected')
          : `${text('当前模型', 'Current model')}: ${label}`}
        onClick={onToggle}
      >
        {/* generic 没有图标 — 不要留空 span, 否则模型名前挂一段无来由的空白 */}
        {brand !== 'generic' && (
          <span className={`atl-composer__model__brand atl-composer__model__brand--${brand}`} aria-hidden="true">
            <ProviderBrandIcon brand={brand} size={14} />
          </span>
        )}
        {!compact && <span className="atl-composer__model__label" title={label}>{label}</span>}
        <ContextModeBadge />
        <span className="atl-composer__model__caret" aria-hidden="true">
          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="m3 4.5 3 3 3-3" /></svg>
        </span>
      </button>
      {open && menuStyle && createPortal(
        <div ref={menuRef} className="atl-model__menu atl-model__menu--home" role="menu" style={menuStyle}>
         <div ref={menuBodyRef} className="atl-model__menu-body">
          {/* 一级: 当前模型 + 它的配置 */}
          <div className={`atl-model__current${isPlaceholder ? ' is-placeholder' : ''}`}>
            {brand !== 'generic' && (
              <span className={`atl-model__item-brand atl-model__item-brand--${brand}`} aria-hidden>
                <ProviderBrandIcon brand={brand} size={14} />
              </span>
            )}
            <span className="atl-model__current-copy">
              <span className="atl-model__current-name">{currentName}</span>
              {currentSource ? <span className="atl-model__current-sub">{currentSource}</span> : null}
            </span>
            {selectedModel ? <ModelInfoIcon model={selectedModel} /> : null}
          </div>
          {showEffort && selectedModel && isChatModelInfo(selectedModel) ? (
            <ThinkMenuSection modelId={selectedModel.id} sent={sentEffort ?? effortByModel?.get(selectedModel.id)}
              initialInfo={schemaInfoMap.get(selectedModel.id)} zh={getGlobalLanguage() === 'zh'} onPick={handlePickEffort} />
          ) : null}
          <div className="atl-model__section-divider" aria-hidden />
          {/* 一级: 两个来源入口, 各自弹二级清单 */}
          <div className="atl-model__section-label"><span>{text('切换模型', 'Switch model')}</span></div>
          <div className="atl-model__sources">
            {/* 未登录不展示订阅入口 — 点开只会是空列表 / "当前套餐没有可用云端模型", 误导。
              * 没有账号体系的构建连「登录使用云端」这一行也没有。 */}
            {isAuthenticated
              ? sourceRow('subscription', text('订阅', 'Subscription'), subscription.length, text('Neox Cloud 云端模型', 'Neox Cloud models'))
              : getEditionHook('hasAccount') && (
                <button
                  type="button"
                  className="atl-model__source"
                  onClick={() => {
                    if (open) onToggle();
                    try { localStorage.setItem('neox-settings-initial-tab', 'account'); } catch { /* ignore */ }
                    try { window.dispatchEvent(new CustomEvent('neox:open-settings', { detail: { tab: 'account' } })); } catch { /* ignore */ }
                  }}
                  title={text('登录后可使用 Neox Cloud 云端模型', 'Sign in to use Neox Cloud models')}
                >
                  <span className="atl-model__source-name">{text('登录使用云端', 'Sign in for cloud')}</span>
                  <svg className="atl-model__source-caret" viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m4.5 2.5 3 3.5-3 3.5" />
                  </svg>
                </button>
              )}
            {/* 按量模型 (平台余额): 开关默认关 —— 关着只是一行灰字, 不列模型; 打开后才能展开选。
              * 只卖订阅的用户不该被一长串按官方价扣费的贵模型打扰, 也避免误点把余额花掉。 */}
            {isAuthenticated && platform.supported && (
              <div
                className={`atl-model__source atl-model__source--platform${platform.enabled ? '' : ' is-off'}${submenu === 'platform' ? ' is-open' : ''}${currentKind === 'platform' ? ' is-current' : ''}`}
              >
                <button
                  type="button"
                  className="atl-model__source-main"
                  disabled={!platform.enabled}
                  onClick={(e) => toggleSubmenu('platform', e)}
                  aria-haspopup="listbox"
                  aria-expanded={submenu === 'platform'}
                  title={platform.enabled
                    ? text('订阅外的云端模型, 按官方价从平台余额扣费', 'Cloud models outside your plan, billed from your balance at list price')
                    : text('打开右侧开关后可选按量模型', 'Turn on the switch to use pay-as-you-go models')}
                >
                  <span className="atl-model__source-name">{text('按量模型', 'Pay-as-you-go')}</span>
                  {platform.enabled && (
                    <span className="atl-model__source-balance">{`$${platform.balanceUsd.toFixed(2)}`}</span>
                  )}
                  {currentKind === 'platform' && (
                    <span className="atl-model__source-current">{text('当前', 'current')}</span>
                  )}
                  {platform.enabled && <span className="atl-model__source-count">{platformList.length}</span>}
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={platform.enabled}
                  aria-label={text('按量模型', 'Pay-as-you-go models')}
                  /* QA: 开关开着、当前却是订阅模型, 看不懂 —— 它管的是「能不能选」, 不是「正在用」 */
                  title={platform.enabled
                    ? text('已允许选按量模型（不会改当前模型）。关掉后按量模型不再出现', 'Pay-as-you-go models can be picked (your current model is unchanged). Turn off to hide them')
                    : text('打开后可以选按量模型，从平台余额扣费', 'Turn on to pick pay-as-you-go models, billed from your balance')}
                  className={`atl-model__switch${platform.enabled ? ' is-on' : ''}`}
                  onClick={() => {
                    if (platform.enabled && submenu === 'platform') { setSubmenu(null); setSubmenuAnchor(null); }
                    platform.setEnabled(!platform.enabled);
                  }}
                >
                  <span className="atl-model__switch-knob" aria-hidden />
                </button>
              </div>
            )}
            {/* 限时活动: 单独一组, 不受按量开关管; 有活动金时写活动金, 没有就写美金余额 */}
            {isAuthenticated && promoList.length > 0 && (
              <button
                type="button"
                className={`atl-model__source${submenu === 'promo' ? ' is-open' : ''}${currentKind === 'promo' ? ' is-current' : ''}`}
                onClick={(e) => toggleSubmenu('promo', e)}
                aria-haspopup="listbox"
                aria-expanded={submenu === 'promo'}
                title={text('限时活动模型: 先扣活动金, 用完转扣美金余额', 'Limited-offer models: promo credit first, then your balance')}
              >
                <span className="atl-model__source-name">{text('限时活动', 'Limited offer')}</span>
                <span className="atl-model__source-balance">
                  {promoUsd > 0 ? `${text('活动金', 'Promo')} $${promoUsd.toFixed(2)}` : `$${platform.balanceUsd.toFixed(2)}`}
                </span>
                {currentKind === 'promo' && (
                  <span className="atl-model__source-current">{text('当前', 'current')}</span>
                )}
                <span className="atl-model__source-count">{promoList.length}</span>
                <svg className="atl-model__source-caret" viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m4.5 2.5 3 3.5-3 3.5" />
                </svg>
              </button>
            )}
            {sourceRow('byok', text('BYOK', 'BYOK'), byokList.length, text('用自己的 API Key 直连', 'Your own API keys'))}
          </div>
          <button type="button" className="atl-model__settings-link" onClick={openMoreSettings}>
            {text('模型设置 →', 'Model settings →')}
          </button>
         </div>
        </div>,
        document.body,
      )}
      {open && submenu && submenuStyle && createPortal(
        <div
          ref={subMenuRef}
          className="atl-model__menu atl-model__menu--list"
          role="listbox"
          style={submenuTopFix === null ? submenuStyle : {
            ...submenuStyle,
            top: submenuTopFix.top,
            ...(submenuTopFix.maxHeight !== null ? { maxHeight: submenuTopFix.maxHeight } : {}),
          }}
        >
          <div className="atl-model__search">
            <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
              <circle cx="6.2" cy="6.2" r="3.9" /><path d="m9.2 9.2 3 3" />
            </svg>
            <input
              type="text"
              value={modelQuery}
              onChange={(e) => setModelQuery(e.target.value)}
              placeholder={submenu === 'promo' ? text('搜索限时活动模型…', 'Search limited-offer models…') : text('搜索模型…', 'Search models…')}
              aria-label={text('搜索模型', 'Search models')}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Escape' && modelQuery) { e.stopPropagation(); setModelQuery(''); return; }
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(e.key)) return;
                const opts = [...(subListRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
                  .filter(el => el.offsetParent !== null);
                if (opts.length === 0) return;
                const cur = opts.findIndex(el => el.dataset.kbActive === '1');
                if (e.key === 'Enter') {
                  if (cur >= 0) { e.preventDefault(); opts[cur].click(); }
                  return;
                }
                e.preventDefault();
                const next = e.key === 'Home' ? 0
                  : e.key === 'End' ? opts.length - 1
                  : cur < 0 ? (e.key === 'ArrowDown' ? 0 : opts.length - 1)
                  : (cur + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
                opts.forEach(el => { delete el.dataset.kbActive; });
                opts[next].dataset.kbActive = '1';
                opts[next].scrollIntoView({ block: 'nearest' });
              }}
            />
            {modelQuery && (
              <button type="button" className="atl-model__search-clear" onClick={() => setModelQuery('')} aria-label={text('清空', 'Clear')}>×</button>
            )}
          </div>
          <div className="atl-model__list-scroll" ref={subListRef}>
            {submenuModels.length > 0 ? (
              submenuModels.map((m) => (
                <ModelMenuItem
                  key={m.id}
                  model={m}
                  active={isSelectedModelActive(m)}
                  onSelect={handleSelectModel}
                  hideProvider={submenu === 'subscription' || submenu === 'platform' || submenu === 'promo'}
                  displayName={isAutoRoutedModelName(m.name) ? autoDisplayName : (submenu === 'promo' ? m.name.replace(/-event$/, '') : undefined)}
                  disabled={(submenu === 'platform' && !platform.usable) || (submenu === 'promo' && promoUsd <= 0 && !platform.usable)}
                  platformPricing={submenu === 'platform' || submenu === 'promo'} paygPromoRatio={submenu === 'platform' ? paygPromoRatio(m, submenuModels) : undefined}
                  hidePromoTag={submenu === 'promo'}
                  hint={(submenu === 'platform' || submenu === 'promo') && m.payAsYouGoPrice
                    ? `$${formatPerMtok(m.payAsYouGoPrice.inputPerMtok)} / $${formatPerMtok(m.payAsYouGoPrice.outputPerMtok)} ${text('每百万 token', 'per 1M tokens')}`
                    : undefined}
                />
              ))
            ) : (
              <div className="atl-model__empty">
                {q
                  ? text('没有匹配的模型', 'No matching model')
                  : submenu === 'subscription'
                    ? (isSubscriptionLoading
                      ? text('正在获取云端模型…', 'Loading cloud models…')
                      : subscriptionFetchFailed
                        ? text('云端模型拉取失败', 'Cloud models failed to load')
                        : !isAuthenticated
                          ? text('登录后可使用云端模型', 'Sign in to use cloud models')
                          : text('当前套餐没有可用云端模型', 'No cloud models in your plan'))
                    : submenu === 'platform'
                      ? text('正在获取按量模型…', 'Loading pay-as-you-go models…')
                      : text('还没有 BYOK 模型，请先添加 API 服务商', 'No BYOK models. Add an API provider first.')}
              </div>
            )}
          </div>
          {submenu === 'promo' ? (
            promoUsd > 0 ? (
              <div className="atl-model__platform-note">
                {text(`先扣活动金 $${promoUsd.toFixed(2)}${promoCredit?.expiresAt ? `（${promoExpiryText(promoCredit.expiresAt, true)}）` : ''}，用完转扣美金余额`,
                  `Promo credit $${promoUsd.toFixed(2)} first${promoCredit?.expiresAt ? ` (${promoExpiryText(promoCredit.expiresAt, false)})` : ''}, then your balance`)}
              </div>
            ) : !platform.usable ? (
              <button
                type="button"
                className="atl-model__settings-link"
                onClick={() => { setSubmenu(null); setSubmenuAnchor(null); if (open) onToggle(); platform.openTopUp(); }}
              >
                {text('没有活动金, 美金余额为 0 · 充值后可用 ->', 'No promo credit or balance · Top up ->')}
              </button>
            ) : (
              <div className="atl-model__platform-note">
                {text('限时活动价, 从美金余额扣', 'Limited-offer price, billed from your balance')}
              </div>
            )
          ) : submenu === 'platform' ? (
            platform.blockedReason === 'extra_usage_off' ? (
              <button
                type="button"
                className="atl-model__settings-link"
                onClick={() => { void platform.enableExtraUsage().catch(() => { /* 失败保持灰态, 用户可重试 */ }); }}
              >
                {text('需要开启额外用量才能用平台余额 · 开启 ->', 'Extra usage is off · Turn on ->')}
              </button>
            ) : platform.blockedReason === 'no_balance' ? (
              <button
                type="button"
                className="atl-model__settings-link"
                onClick={() => { setSubmenu(null); setSubmenuAnchor(null); if (open) onToggle(); platform.openTopUp(); }}
              >
                {text('平台余额为 0 · 充值后可用 ->', 'No balance · Top up to use ->')}
              </button>
            ) : (
              <div className="atl-model__platform-note">
                {text('按官方价从平台余额扣费, 不占订阅额度', 'Billed from your balance at list price; does not use plan quota')}
              </div>
            )
          ) : submenu === 'byok' ? (
            <button type="button" className="atl-model__settings-link" onClick={openProvidersSettings}>
              {text('管理服务商 ->', 'Manage providers ->')}
            </button>
          ) : subscriptionFetchFailed ? (
            <button type="button" className="atl-model__settings-link" onClick={() => { void getEditionHook('refreshMembership')(); }}>
              {text('重试云端模型 ->', 'Retry cloud models ->')}
            </button>
          ) : submenu === 'subscription' && !q && !isSubscriptionLoading && subscription.length === 0 ? (
            <button
              type="button"
              className="atl-model__settings-link"
              onClick={() => {
                setSubmenu(null);
                setSubmenuAnchor(null);
                if (open) onToggle();
                if (!isAuthenticated) {
                  try { localStorage.setItem('neox-settings-initial-tab', 'account'); } catch { /* ignore */ }
                  try { window.dispatchEvent(new CustomEvent('neox:open-settings', { detail: { tab: 'account' } })); } catch { /* ignore */ }
                } else {
                  getEditionHook('openUpgradeUrl')('pricing');
                }
              }}
            >
              {!isAuthenticated
                ? text('去登录 ->', 'Sign in ->')
                : text('查看套餐 / 升级 ->', 'View plans / Upgrade ->')}
            </button>
          ) : null}
        </div>,
        document.body,
      )}
    </div>
  );
};

/* 档位只用于文案与配色深浅, 视觉是一条连续渐变条 (分段条太像信号灯) */
const BURN_LEVELS = [
  { max: 0.30, key: 'lowest',  zh: '极省', en: 'Very low'  },
  { max: 0.80, key: 'low',     zh: '省',   en: 'Low'       },
  { max: 2.00, key: 'mid',     zh: '适中', en: 'Moderate'  },
  { max: 4.00, key: 'high',    zh: '较快', en: 'High'      },
  { max: 8.00, key: 'highest', zh: '很快', en: 'Very high' },
  { max: Infinity, key: 'extreme', zh: '极快', en: 'Extreme' },
] as const;

/* 位置用**对数**尺度: 显示倍率从 0.08 (免费档) 到 ~16 (GPT-6 Astra 按量) 跨两百倍,
 * 线性的话便宜模型全挤在最左边两个像素里. 下限 12% 保证最省的模型也有可见的一小段, 不是空条. */
const BURN_MIN = 0.08;
const BURN_MAX = 20;

/** 0.11× / 2.8× / 16× —— <1 两位, 1~10 一位, ≥10 取整 */
function formatBurn(rc: number): string {
  const v = rc >= 10 ? Math.round(rc) : rc >= 1 ? Math.round(rc * 10) / 10 : Math.round(rc * 100) / 100;
  return `${v}×`;
}
function burnPercent(rc: number): number {
  const t = Math.log(Math.max(BURN_MIN, Math.min(BURN_MAX, rc)) / BURN_MIN) / Math.log(BURN_MAX / BURN_MIN);
  return Math.round(Math.max(0.12, Math.min(1, t)) * 100);
}

function burnLevelOf(rc: number) {
  const idx = BURN_LEVELS.findIndex(l => rc <= l.max);
  return BURN_LEVELS[idx < 0 ? BURN_LEVELS.length - 1 : idx];
}
function burnLevelLabel(rc: number, isZh: boolean): string {
  const l = burnLevelOf(rc);
  return isZh ? l.zh : l.en;
}

const ModelBurnBar: React.FC<{ relativeCost: number | null; size?: 'sm' | 'md' }> = ({ relativeCost, size = 'sm' }) => {
  const { isZh } = useI18n();
  if (relativeCost == null || !Number.isFinite(relativeCost) || relativeCost <= 0) return null;
  const lvl = burnLevelOf(relativeCost);
  const pct = burnPercent(relativeCost);
  const label = isZh ? lvl.zh : lvl.en;
  const title = isZh
    ? `额度消耗 ${formatBurn(relativeCost)} · ${label} (1× ≈ 每亿 token $20)`
    : `Quota burn ${formatBurn(relativeCost)} · ${label} (1× ≈ $20 per 100M tokens)`;
  return (
    <span className={`atl-burn atl-burn--${size}`} title={title} aria-label={title}>
      <span className="atl-burn__track">
        {/* 渐变画在**填充层内部**并按整条宽度铺开(background-size:计算出的倒数),
            这样填到哪里, 颜色就正好是那个位置该有的颜色 —— 不会出现"短条也是红色". */}
        <span
          className="atl-burn__fill"
          style={{ width: `${pct}%`, backgroundSize: `${(100 / pct) * 100}% 100%` }}
        />
      </span>
    </span>
  );
};

function renderModelPromoTag(ent: EntitledModelInfo['entitlement'] | undefined, isZh: boolean, modelId?: string): React.ReactElement | null {
  const promo = ent?.promo;
  const promoActive = !!promo && new Date(promo.endsAt).getTime() > Date.now();
  if (!promoActive && !/-promo$/.test(modelId ?? '')) return null;
  const title = promoActive ? `${isZh ? '限时特惠 · 至' : 'Limited offer · until'} ${new Date(promo!.endsAt).toLocaleDateString()}` : undefined;
  return <span className="atl-model__item-promo" title={title}>{isZh ? '限时特惠' : 'Limited offer'}</span>;
}

/** 「12 天后过期」/「今天过期」 */
function promoExpiryText(iso: string, zh: boolean): string {
  const days = Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
  if (!Number.isFinite(days)) return '';
  if (days <= 1) return zh ? '今天过期' : 'expires today';
  return zh ? `${days} 天后过期` : `expires in ${days} days`;
}

/** 美元 / 百万 token 的价格显示: ≥1 保留两位, 更小的保留到有效数字 (0.14 / 0.0028) */
function formatPerMtok(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v >= 1) return v.toFixed(2).replace(/\.?0+$/, '');
  return String(Number(v.toPrecision(2)));
}

const ModelMenuItem: React.FC<{
  model: ModelInfo;
  active: boolean;
  onSelect: (m: ModelInfo) => void;
  /* 订阅 / 自动路由组传 true: 不显示 vendor 名 ("Neox Cloud" 这种 admin 视角文字对终端无意义).
   * BYOK 组留 false, 用户需要看到自己配的 provider 是哪个. */
  hideProvider?: boolean;
  /* 显示名覆盖 — 当 model.name='auto' 时, 用 plan-skin 名 (e.g. "Aurora Ultra"). */
  displayName?: string;
  /* 灰掉不可选 (按量模型在没余额 / 额外用量关着时) */
  disabled?: boolean;
  /* 名字下面那行小字 (按量模型的价格); 给了就替代 provider 那行 */
  hint?: string;
  /* 在按量组里: 消耗条按平台价算 (套餐里也有的模型在订阅组按套餐倍率算, 两把尺子不混) */
  platformPricing?: boolean; paygPromoRatio?: number; /* 按量组 -promo 款相对原价的比例 (paygPromo.tsx) */
  /* 「限时活动」组里每一行都是特惠款, 不再挂「限时特惠」小标 */
  hidePromoTag?: boolean;
}> = ({ model, active, onSelect, hideProvider, displayName, disabled, hint, platformPricing, paygPromoRatio: paygRatio, hidePromoTag }) => {
  const ent = (model as EntitledModelInfo).entitlement;
  const { isZh } = useI18n();
  const promoTag = hidePromoTag ? null : !model.payAsYouGo && !platformPricing
    ? renderModelPromoTag(ent, isZh, String(model.id ?? model.name ?? ''))
    : renderPaygPromoTag(paygRatio, isZh);
  const isEcoModel = /-eco$/.test(model.name);
  const shownName = (displayName ?? ent?.displayName ?? model.name).replace(/-\d{8,}$/, '');
  const burn = model.payAsYouGo || platformPricing ? (model.payAsYouGoRelativeCost ?? null) : (ent?.relativeCost ?? null);
  /* 用 brand logo 替代 radio 圈圈 — 视觉信息密度更高, 用户一眼看出"这是 OpenAI 还是 Claude".
   * 选中态靠右侧的 check icon + .is-active 高亮底 表达, 不再用 radio dot. */

  const brand = inferProviderBrand({
    id: model.id,
    name: model.name,
    protocol: model.protocol,
    providerId: model.providerId,
  });
  const handleSelectClick = React.useCallback(() => {
    onSelect(model);
  }, [model, onSelect]);
  return (
    <div className={`atl-model__item${active ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`} role="option" aria-selected={active} aria-disabled={disabled || undefined}>
      <button
        type="button"
        className="atl-model__item-main"
        onClick={handleSelectClick}
        disabled={disabled}
      >
        <span className={`atl-model__item-brand atl-model__item-brand--${brand}`} aria-hidden>
          <ProviderBrandIcon brand={brand} size={14} />
        </span>
        <span className="atl-model__item-copy">
          <span className="atl-model__item-name">
            <span className="atl-model__item-name-text">
              {isEcoModel
                ? shownName.replace(/-eco$/, '').replace(/\s*(经济版|Eco)$/i, '')
                : promoTag
                  ? shownName.replace(/-promo$/, '').replace(/\s*(特惠版|Promo)$/i, '')
                  : shownName}
            </span>
            {promoTag}
            {isEcoModel ? (
              <span className="atl-model__item-eco" title={isZh ? '同一模型, 便宜 20%, 生成速度慢一些' : 'Same model, 20% cheaper, slower generation'}>
                {isZh ? '经济' : 'Eco'}
              </span>
            ) : null}
          </span>
          {hint ? (
            <span className="atl-model__item-provider">{hint}</span>
          ) : !hideProvider ? (
            <span className="atl-model__item-provider">{model.provider || model.providerId}</span>
          ) : null}
        </span>
      </button>
      <span className="atl-model__item-tags">
        {active ? <span className="atl-model__item-check" aria-hidden><IconCheck size={12} /></span> : null}
        {/* 消耗条 —— 展示的是"额度烧得多快", **不是倍率**。
         *   倍率是我们的定价策略, 既不该出网(拿它除以公开挂牌价能反推进价结构),
         *   对用户也没意义: 同样 1.5x 倍率, Opus 和 Haiku 烧额度差 5 倍。
         *   relativeCost 是"挂牌价 x 倍率"揉在一起相对基准模型的比值 —— 用户看得懂,
         *   又反推不出任何一方。 */}
        {/* 按量模型用平台价算的消耗速度 (同一把尺子才能横向比); 订阅模型用套餐倍率算的 */}
        <ModelBurnBar relativeCost={burn} />
      </span>
      {/* info (ⓘ) — hover 弹详情卡到 model dropdown popover 的右侧外 (portal + fixed),
       *   不再 absolute 内嵌否则被 popover 容器 overflow 裁剪 + 覆盖上下行不可读.
       *   倍率数字只在卡里出, 跟这一行的条子同一个数 (按量模型的 entitlement 里没有它). */}
      <ModelInfoIcon model={model} relativeCost={burn} />
    </div>
  );
};

/* unionRectOf —— 页面上所有匹配元素的并集矩形 (可见的才算).
 *   给浮层定位用: "别压住任何一个已经开着的面板", 而不是只躲开自己那一个. */
function unionRectOf(selector: string): DOMRect | null {
  const els = [...document.querySelectorAll<HTMLElement>(selector)]
    .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0);
  if (els.length === 0) return null;
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const el of els) {
    const q = el.getBoundingClientRect();
    l = Math.min(l, q.left); t = Math.min(t, q.top);
    r = Math.max(r, q.right); b = Math.max(b, q.bottom);
  }
  return new DOMRect(l, t, r - l, b - t);
}

const ModelInfoIcon: React.FC<{ model: ModelInfo; relativeCost?: number | null }> = ({ model, relativeCost }) => {
  const { isZh } = useI18n();
  const iconRef = React.useRef<HTMLSpanElement | null>(null);
  const tipRef = React.useRef<HTMLDivElement | null>(null);
  /* anchor: 初始锚点 (icon center + popover right edge). pos: 实际渲染坐标 (clamp 后). */
  const [anchor, setAnchor] = React.useState<{ iconRect: DOMRect; popRect: DOMRect | null; preferLeft: boolean; others: DOMRect | null } | null>(null);
  const [pos, setPos] = React.useState<{ top: number; left: number; transform: string } | null>(null);

  const open = React.useCallback(() => {
    const icon = iconRef.current;
    if (!icon) return;
    const iconRect = icon.getBoundingClientRect();
    const popRect = icon.closest('.atl-model__menu')?.getBoundingClientRect() ?? null;
    const others = unionRectOf('.atl-model__menu');
    const preferLeft = !!(popRect && others && others.right > popRect.right + 1);
    setAnchor({ iconRect, popRect, preferLeft, others });
    /* 给个 plausible 初始坐标避免第一帧闪屏右上角. layout effect 会立刻 override. */
    setPos({
      top: iconRect.top + iconRect.height / 2,
      left: (popRect?.right ?? iconRect.right) + 8,
      transform: 'translateY(-50%)',
    });
  }, []);
  const close = React.useCallback(() => { setAnchor(null); setPos(null); }, []);

  /* 卡片里的能力标签是异步拉回来的, 拉回来卡片变宽 —— 尺寸一变就重新定位, 否则会压住旁边的菜单 */
  const [tipSize, setTipSize] = React.useState('');
  React.useEffect(() => {
    const el = tipRef.current;
    if (!anchor || !el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setTipSize(`${Math.round(r.width)}x${Math.round(r.height)}`);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchor, !!pos]);

  /* tooltip 渲染后量真实尺寸, viewport clamp. anchor 变化 / 卡片尺寸变化都重算. */
  React.useLayoutEffect(() => {
    if (!anchor || !tipRef.current) return;
    const tipRect = tipRef.current.getBoundingClientRect();
    const { iconRect, popRect, preferLeft, others } = anchor;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const MARGIN = 8;

    const leftSide = (popRect?.left ?? iconRect.left) - tipRect.width - MARGIN;
    const rightSide = (popRect?.right ?? iconRect.right) + MARGIN;
    const fitsLeft = leftSide >= MARGIN;
    const fitsRight = rightSide + tipRect.width + MARGIN <= vw;
    const clearsOthers = (x: number) => !others || x + tipRect.width <= others.left || x >= others.right;
    const outerLeft = others ? others.left - tipRect.width - MARGIN : leftSide;
    const outerRight = others ? others.right + MARGIN : rightSide;
    let left: number;
    if (preferLeft && fitsLeft && clearsOthers(leftSide)) left = leftSide;
    else if (fitsRight && clearsOthers(rightSide)) left = rightSide;
    else if (fitsLeft && clearsOthers(leftSide)) left = leftSide;
    else if (outerRight + tipRect.width + MARGIN <= vw) left = outerRight;
    else if (outerLeft >= MARGIN) left = outerLeft;
    else if (preferLeft ? fitsLeft : !fitsRight && fitsLeft) left = leftSide;
    else if (fitsRight) left = rightSide;
    else left = Math.max(MARGIN, vw - tipRect.width - MARGIN);

    /* 垂直: icon 中线对齐, 但若 tooltip 高度让顶/底溢出, 调到不溢出的最近位置. */
    let top = iconRect.top + iconRect.height / 2;
    let transform = 'translateY(-50%)';
    const topAfter = top - tipRect.height / 2;
    const bottomAfter = top + tipRect.height / 2;
    if (topAfter < MARGIN) {
      /* 上溢出 — 顶部贴 MARGIN */
      top = MARGIN;
      transform = 'translateY(0)';
    } else if (bottomAfter > vh - MARGIN) {
      /* 下溢出 — 底部贴 MARGIN */
      top = vh - MARGIN;
      transform = 'translateY(-100%)';
    }

    setPos((prev) => (prev && prev.top === top && prev.left === left && prev.transform === transform ? prev : { top, left, transform }));
  }, [anchor, tipSize]);

  return (
    <span
      ref={iconRef}
      className="atl-model__item-info"
      tabIndex={0}
      aria-label={isZh ? '模型详情' : 'Model details'}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
    >
      <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="7" cy="7" r="5.5" />
        <path d="M7 6.2 V10" />
        <circle cx="7" cy="4.2" r=".7" fill="currentColor" stroke="none" />
      </svg>
      {pos && createPortal(
        <div
          ref={tipRef}
          className="atl-model__item-info-tip is-floating"
          role="tooltip"
          style={{ position: 'fixed', top: pos.top, left: pos.left, transform: pos.transform, zIndex: COMPOSER_TOOLTIP_Z }}
        >
          <ModelInfoCard model={model} relativeCost={relativeCost} />
        </div>,
        document.body,
      )}
    </span>
  );
};

/* ============================================================
 * ModelInfoCard · hover 时弹出的模型详情卡 (context / output / 能力 / 计费)
 * ============================================================ */
function humanizeTokens(n: number | undefined): string {
  if (!n || n <= 0) return '—';
  if (n >= 1_000_000) {
    const value = n / 1_000_000;
    const nearest = Math.round(value);
    if (nearest >= 1 && Math.abs(value - nearest) <= 0.11) return `${nearest}M`;
    return `${value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, '')}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/* CapChip —— 模型能力标记 (图标 + 文字). 只在**确认支持**时渲染, 见调用点的说明. */
const CAP_ICONS: Record<string, React.ReactNode> = {
  image: (
    <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.6" />
      <circle cx="5" cy="5.8" r="1.1" />
      <path d="M2 10l3.2-3 2.3 2.1L10 6.6l2.5 2.7" />
    </svg>
  ),
  audio: (
    <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="5" y="1.6" width="4" height="7" rx="2" />
      <path d="M3 6.6a4 4 0 0 0 8 0" />
      <path d="M7 10.6v1.8" />
    </svg>
  ),
  video: (
    <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="1.5" y="3.5" width="8" height="7" rx="1.6" />
      <path d="M9.5 6.4l3-1.6v4.4l-3-1.6z" />
    </svg>
  ),
  effort: (
    <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
      <path d="M2 4.2h10M2 9.8h10" />
      <circle cx="5" cy="4.2" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="9.4" cy="9.8" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  think: (
    <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 1.6c2.5 0 4.3 1.7 4.3 3.9 0 1.3-.6 2.3-1.4 3.1-.5.5-.8 1-.8 1.7v.3H4.9v-.3c0-.7-.3-1.2-.8-1.7-.8-.8-1.4-1.8-1.4-3.1 0-2.2 1.8-3.9 4.3-3.9Z" />
      <path d="M5.5 12.4h3" />
    </svg>
  ),
};

const CapChip: React.FC<{ icon: keyof typeof CAP_ICONS | string; label: string }> = ({ icon, label }) => (
  <span className="atl-cap is-on" title={label}>
    <span className="atl-cap__icon" aria-hidden>{CAP_ICONS[icon]}</span>
    <span className="atl-cap__label">{label}</span>
  </span>
);

const ModelInfoCard: React.FC<{ model: ModelInfo; relativeCost?: number | null }> = ({ model, relativeCost }) => {
  const { isZh } = useI18n();
  const ent = (model as EntitledModelInfo).entitlement;
  /* 跟列表那一行的条子同一个数; 没传 (别处复用) 才退回套餐倍率 */
  const burn = relativeCost !== undefined ? relativeCost : (ent?.allowed ? ent.relativeCost ?? null : null);
  /* 思考能力**不查 isThinkingSupported** —— 那是三条硬编码白名单串起来的
   * (Claude 停在 4.6 / Gemini 停在 2.5-preview / 豆包一张表), OpenAI 系压根没进去,
   * 于是 GPT-5.6 全部被判成"不支持思考", 而它右边的档位面板明明列着 Low~Max.
   *
   * 权威源就是那个档位面板的数据: schema 里有 effort_map / 多个档位 = 支持调推理.
   * 详情卡只在 hover 时渲染, 这里现拉一次不影响列表性能. */
  const [effort, setEffort] = React.useState<SchemaEffortInfo | null>(null);
  React.useEffect(() => {
    let alive = true;
    const fn = (window as any).neox?.getSchemaModelInfo;
    if (typeof fn !== 'function') return;
    Promise.resolve(fn(model.id)).then((info: SchemaEffortInfo) => {
      if (alive) setEffort(info ?? null);
    }).catch(() => { /* 拿不到就退回 model.supportsThinking, 不报错打扰用户 */ });
    return () => { alive = false; };
  }, [model.id]);
  const levels = isChatModelInfo(model) ? (effort?.effectiveLevels?.length ?? 0) : 0;
  const chatModel = isChatModelInfo(model);
  const supportsReasoning = chatModel && (effort?.capabilities?.reasoningEffortSupported === true || levels > 0);
  const supportsThinking = chatModel && (supportsReasoning || effort?.capabilities?.thinkingSupported === true || !!model.supportsThinking);
  /* 只有 schema 明确提供 off 才显示关闭思考; GPT-6.1 没有 off, 因此不会出现该选项. */
  const adjustableEffort = levels > 1;
  const ctxStr = humanizeTokens(model.contextWindow);
  const outStr = humanizeTokens(model.maxTokens);
  return (
    <div className="atl-model__info-card">
      <div className="atl-model__info-card-title">{(ent?.displayName ?? model.name).replace(/-\d{8,}$/, '')}</div>
      <div className="atl-model__info-card-row">
        <span className="atl-model__info-card-k">{isZh ? '上下文' : 'Context'}</span>
        <span className="atl-model__info-card-v">{ctxStr}</span>
      </div>
      <div className="atl-model__info-card-row">
        <span className="atl-model__info-card-k">{isZh ? '最大输出' : 'Max output'}</span>
        <span className="atl-model__info-card-v">{outStr}</span>
      </div>
      {(() => {
        const c = ent?.caps ?? null;
        /* 服务端没给能力位时退回本地推断, 但只认"确定为真"的那部分 */
        const vision = c?.vision ?? (model.supportsVision ? true : null);
        const reasoning = c?.reasoning ?? (supportsThinking ? true : null);
        const chips = [
          vision === true ? <CapChip key="v" icon="image" label={isZh ? '图片输入' : 'Image input'} /> : null,
          c?.audioInput === true ? <CapChip key="a" icon="audio" label={isZh ? '语音输入' : 'Audio input'} /> : null,
          c?.videoInput === true ? <CapChip key="vd" icon="video" label={isZh ? '视频输入' : 'Video input'} /> : null,
          reasoning === true ? <CapChip key="t" icon="think" label={isZh ? '深度思考' : 'Thinking'} /> : null,
          adjustableEffort ? <CapChip key="e" icon="effort" label={isZh ? '推理可调' : 'Adjustable'} /> : null,
        ].filter(Boolean);
        return chips.length ? <div className="atl-model__caps">{chips}</div> : null;
      })()}
      {/* "推理强度: 可调" 行已移除: 对应的 EffortPill 控件已下架(后端不读), 再标"可调"会误导。 */}
      {ent && ent.allowed ? (
        <>
          <div className="atl-model__info-card-row">
            <span className="atl-model__info-card-k">{isZh ? '计费' : 'Billing'}</span>
            <span className="atl-model__info-card-v">
              {ent.included
                ? (isZh ? '订阅内' : 'Included')
                : (isZh ? '按量' : 'Metered')}
            </span>
          </div>
          {ent.versionLabel ? (
            <div className="atl-model__info-card-row">
              <span className="atl-model__info-card-k">{isZh ? '版本' : 'Version'}</span>
              <span className="atl-model__info-card-v" title={ent.versionNote ?? undefined}>{ent.versionLabel}</span>
            </div>
          ) : null}
          {ent.promo ? (
            <div className="atl-model__info-card-row">
              <span className="atl-model__info-card-k">{isZh ? '活动' : 'Promotion'}</span>
              <span className="atl-model__info-card-v">
                {isZh ? '限时特惠 · 至 ' : 'Limited offer · until '}{new Date(ent.promo.endsAt).toLocaleDateString()}
              </span>
            </div>
          ) : null}
        </>
      ) : null}
      {!hideProviderForInfo(model) ? (
        <div className="atl-model__info-card-row">
          <span className="atl-model__info-card-k">{isZh ? '来源' : 'Source'}</span>
          <span className="atl-model__info-card-v">{model.provider}</span>
        </div>
      ) : null}
      {/* 额度消耗 —— 放最后且带整条渐变: 用户在这里才是"要决策"的时刻,
          比选择器行里那条 30px 的更需要看清楚. 档位文案跟条子同源, 不会打架. */}
      {burn != null && Number.isFinite(burn) && burn > 0 ? (
        <div className="atl-model__info-card-burn">
          <div className="atl-model__info-card-row">
            <span className="atl-model__info-card-k">{isZh ? '额度消耗' : 'Quota burn'}</span>
            <span className="atl-model__info-card-v">{formatBurn(burn)} · {burnLevelLabel(burn, isZh)}</span>
          </div>
          <ModelBurnBar relativeCost={burn} size="md" />
        </div>
      ) : null}
    </div>
  );
};

function hideProviderForInfo(m: ModelInfo): boolean {
  /* 订阅模型 + auto routed 的 "Neox Cloud" 字面对用户无意义, 隐. */
  return isNeoxCloudProviderId(m.providerId);
}

export default TimelineComposer;
