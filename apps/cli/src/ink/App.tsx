import React, { useEffect, useMemo, useState, useContext } from 'react';
import { Box, Text, Static, useInput, useStdout } from '../../vendor/ink/src/index.js';
import stringWidth from 'string-width';
import { useHeightLock } from './hooks/useHeightLock.js';
import StdinContext from '../../vendor/ink/src/components/StdinContext.js';
import { Header } from './components/Header.js';
import { EntryRenderer } from './components/EntryRenderer.js';
import { ThinkingBlock } from './components/messages/ThinkingBlock.js';
import { BottomBar } from './components/BottomBar.js';
import { SelectMenu } from './components/SelectMenu.js';
import { InterruptInputBox } from './components/InterruptInputBox.js';
import { AgentContextScreen } from './components/AgentContextScreen.js';
import { QueuedMessagesBar, type QueuedMessage } from './components/QueuedMessagesBar.js';
import { NextStepBar, type PlanStep } from './components/NextStepBar.js';
import { type SidebarAgent } from './components/AgentBar.js';
import { VERSION } from '@neoxlabs/kernel/version.js';
import { debugLog } from '@neoxlabs/kernel/platform/cliLogger.js';
import { sym } from './utils/winSymbols.js';

import type { TimelineEntry, SelectMenuOptions, TextPromptOptions, AttachedImage, TimelineDensity } from './InkRuntime.js';
import { aggregateToolCalls } from './utils/aggregateToolCalls.js';

// 间距规则：所有节点前统一 1 行空行
import type { Message } from '@neoxlabs/kernel/types/index.js';
import type { AgentContextStats } from '@neoxlabs/kernel/types/agent.js';
import type { NetworkStats, CooperateStats, ResearchProgress } from './components/StatusLine.js';
import { isTranscriptOpen } from './transcriptViewer.js';
import { onInputPrefill } from './inputPrefill.js';
import { useWizardHeader } from './wizardHeader.js';
import { BottomPanel } from './components/BottomPanel.js';
import { closeBottomPanel } from './bottomPanel.js';
import { NeoxTheme } from './theme.js';
import { takeTtyTypeahead } from '../bootstrap/earlyInputCapture.js';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];

const safeDebugStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (key, val) => {
      if (typeof val === 'bigint') {
        return val.toString();
      }
      if (val instanceof Error) {
        return {
          name: val.name,
          message: val.message,
          stack: val.stack,
        };
      }
      if (typeof val === 'function') {
        return '[Function]';
      }
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      return val;
    });
  } catch {
    try {
      return String(value);
    } catch {
      return '[Unserializable]';
    }
  }
};

function isImagePath(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();

  // Check for common image file extensions
  const lowerPath = trimmed.toLowerCase();
  const hasImageExtension = IMAGE_EXTENSIONS.some(ext => lowerPath.endsWith(ext));

  // Also check if it looks like a file path (starts with / or ./ or ~/ or contains /)
  const looksLikePath = trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('~/') ||
    (trimmed.includes('/') && hasImageExtension);

  return hasImageExtension && looksLikePath;
}

export interface AppProps {
  // 'all' = legacy single-container mode (renders everything)
  // 'static' = only Static section (Header + committed entries)
  // 'dynamic' = only Dynamic section (pending entries + thinking)
  // 'bottom' = only Bottom section (StatusLine + InputLine + menus)
  zone?: 'all' | 'static' | 'dynamic' | 'bottom';
  staticEntries?: TimelineEntry[];
  /** 整屏重画的代数 (改终端宽度后 +1), 用作 <Static> 的 key */
  staticEpoch?: number;
  pendingEntries?: TimelineEntry[];
  isRunning: boolean;
  statusText?: string;
  tokenStats?: {
    input: number;
    output: number;
    total: number;
    contextWindow?: number;
    tokensUsedForContext?: number;
    pressure?: number;
    systemTokens?: number;
    userTokens?: number;
    assistantTokens?: number;
    toolCallTokens?: number;
    toolResultTokens?: number;
    // Legacy fields
    toolTokens?: number;
    messageTokens?: number;
  };
  streamingTokens?: number;
  streamingStartTime?: number | null;
  accumulatedRunTime?: number;
  version?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  workDir?: string;
  showHeader?: boolean;
  thinkingEnabled?: boolean;
  selectMenuOptions?: SelectMenuOptions | null;
  textPromptOptions?: TextPromptOptions | null;
  contextMenuActive?: boolean;
  agentContextScreenActive?: boolean;
  compressionMode?: 'sync' | 'async';
  compactionThreshold?: number;
  agentContextStats?: AgentContextStats[];
  researchProgress?: ResearchProgress | null;
  runMode?: 'agentic';
  commandOutput?: string[];
  attachedImages?: AttachedImage[];
  interruptInputActive?: boolean;
  queuedMessages?: QueuedMessage[];
  currentPlanSteps?: PlanStep[];
  sidebarAgents?: SidebarAgent[];
  // Background tasks (agentic mode)
  backgroundTasks?: Array<{
    id: number;
    command: string;
    pid: number;
    status: 'running' | 'done' | 'error' | 'killed';
    startTime: number;
    exitCode?: number;
    output: string[];
    expanded?: boolean;
  }>;
  bgSelectedIndex?: number;
  onBgKill?: (id: number) => void;
  onBgRemove?: (id: number) => void;
  onBgNavigate?: (direction: 'up' | 'down') => void;
  onBgToggleExpand?: () => void;
  onScrollUp?: () => void;
  onScrollDown?: () => void;
  onPageUp?: () => void;
  onPageDown?: () => void;
  onScrollToTop?: () => void;
  onScrollToBottom?: () => void;
  getCompletions?: (value: string) => string[];
  onStaticRendered?: () => void;
  onSubmit: (text: string, images?: AttachedImage[]) => void;
  onInterrupt: () => void;
  /** 运行中按 ↑ 撤回最后一条排队消息 → 返回其文本放回输入框 (空/失败 null) */
  onPullbackQueued?: () => Promise<string | null>;
  onExit: () => void;
  onContextMenuToggle?: () => void;
  onAgentContextScreenToggle?: () => void;
  onClearCommandOutput?: () => void;
  onAttachImage?: (imageData: string | AttachedImage) => number | null | void; // 返回图片编号 seq
  onClearImages?: () => void;
  onInterruptInputSubmit?: (text: string) => void;
  onInterruptInputCancel?: () => void;
  onShowInterruptInput?: () => void;
  // Thinking expand/collapse — controlled from InkRuntime so all zones share state
  thinkingCollapsedProp?: boolean;
  onToggleThinking?: () => void;
  timelineDensity?: TimelineDensity;
  expandedToolGroupIds?: Set<number>;
  onCycleDensity?: () => void;
  onToggleToolGroupExpanded?: (id: number) => void;
  account?: string;
  accountTone?: 'cyan' | 'green' | 'gray';
}

export const App: React.FC<AppProps> = ({
  zone = 'all',
  account,
  accountTone,
  staticEntries = [],
  staticEpoch = 0,
  pendingEntries = [],
  isRunning,
  statusText = '',
  tokenStats,
  streamingTokens = 0,
  streamingStartTime = null,
  accumulatedRunTime = 0,
  version = VERSION,
  provider = 'OpenAI',
  model = 'gpt-4',
  reasoningEffort = '',
  workDir = process.cwd(),
  showHeader = true,
  thinkingEnabled = true,
  selectMenuOptions = null,
  textPromptOptions = null,
  contextMenuActive = false,
  agentContextScreenActive = false,
  compressionMode = 'sync',
  compactionThreshold = 0.85,
  agentContextStats = [],
  researchProgress = null, // 深度调研聚合进度
  runMode = 'agentic',
  commandOutput = [],
  attachedImages = [],
  interruptInputActive = false,
  queuedMessages = [],
  currentPlanSteps = [],
  sidebarAgents = [],
  backgroundTasks = [],
  bgSelectedIndex = -1,
  onBgKill,
  onBgRemove,
  onBgNavigate,
  onBgToggleExpand,
  getCompletions,
  onStaticRendered,
  onSubmit,
  onInterrupt,
  onPullbackQueued,
  onExit,
  onContextMenuToggle,
  onAgentContextScreenToggle,
  onClearCommandOutput,
  onAttachImage,
  onClearImages,
  onInterruptInputSubmit,
  onInterruptInputCancel,
  onShowInterruptInput,
  onScrollUp,
  onScrollDown,
  onPageUp,
  onPageDown,
  onScrollToTop,
  onScrollToBottom,
  thinkingCollapsedProp,
  onToggleThinking,
  timelineDensity = 'medium',
  expandedToolGroupIds,
  onCycleDensity,
  onToggleToolGroupExpanded,
}) => {
  const effectiveRunMode = 'agentic';
  /* 初值 = 启动那两秒里用户已经敲的字 (见 earlyInputCapture 的 typeahead) */
  /* 只有画输入框的那个实例取 (static/dynamic/bottom 三个 App 各自 mount, 先 mount 的会把它取空) */
  const [inputValue, setInputValue] = useState(() => (zone === 'all' || zone === 'bottom' ? takeTtyTypeahead() : ''));
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [completionMenuOptions, setCompletionMenuOptions] = useState<SelectMenuOptions | null>(null);
  const [_thinkingCollapsedLocal, setThinkingCollapsedLocal] = useState(true);
  // If InkRuntime passes the prop, use it (cross-zone shared state); otherwise use local state
  const thinkingCollapsed = thinkingCollapsedProp !== undefined ? thinkingCollapsedProp : _thinkingCollapsedLocal;

  const currentCompletions = useMemo(() => {
    if (!getCompletions || !inputValue.startsWith('/')) {
      return [];
    }
    return getCompletions(inputValue);
  }, [inputValue, getCompletions]);

  const stdinContext = useContext(StdinContext);

  useEffect(() => {
    if (!stdinContext?.internal_eventEmitter || !onAttachImage) {
      return;
    }

    const handleImagePaste = (imageData: AttachedImage) => {
      debugLog('CLI_APP', `📎 Received image-paste event from vendor Ink: ${imageData.name}`);
      /* 这条事件路径(若 vendor Ink 某终端下真发)拿不到光标位置, 把 [图片 #seq] token 追加到末尾,
       * 保持与 InputLine 内联 token 模型一致 (否则附了图却无 token → 提交时被 resolveImagesFromText 丢弃)。 */
      const seq = onAttachImage?.(imageData);
      if (typeof seq === 'number' && seq > 0) setInputValue(v => v + `[图片 #${seq}]`);
    };

    stdinContext.internal_eventEmitter.on('image-paste', handleImagePaste);

    return () => {
      stdinContext.internal_eventEmitter.off('image-paste', handleImagePaste);
    };
  }, [stdinContext, onAttachImage]);


  const wizardHeader = useWizardHeader();
  /* 底部信息面板 (/usage 等) 是"看一眼"的: 开始干活就收起 */
  useEffect(() => { if (isRunning) closeBottomPanel(); }, [isRunning]);

  /* esc 中断且模型还没开口: main 把刚发的消息放回输入框 (输入框里已有字就不动) */
  useEffect(() => onInputPrefill(text => setInputValue(v => (v ? v : text))), []);

  useEffect(() => {
    if (textPromptOptions?.defaultValue) {
      setInputValue(textPromptOptions.defaultValue);
    }
  }, [textPromptOptions?.defaultValue]);

  const inputShortcutsActive =
    (zone === 'all' || zone === 'bottom') &&
    !selectMenuOptions &&
    !completionMenuOptions;

  useInput((input, key) => {
    if (isTranscriptOpen()) return; // ctrl+o 完整记录打开时按键归它
    if (key.escape) {
      if (agentContextScreenActive) {
        return;
      }
      // Priority: Close completion menu first, then clear command output
      if (completionMenuOptions) {
        setCompletionMenuOptions(null);
      } else if (commandOutput.length > 0 && onClearCommandOutput) {
        onClearCommandOutput();
      }
    }

    // PageUp/PageDown - 翻页
    if (key.pageUp && onPageUp) {
      onPageUp();
    }
    if (key.pageDown && onPageDown) {
      onPageDown();
    }
    // Ctrl+↑/↓ - 滚动几行（避免与输入框历史冲突）
    if (key.upArrow && key.ctrl && onScrollUp) {
      onScrollUp();
    }
    if (key.downArrow && key.ctrl && onScrollDown) {
      onScrollDown();
    }
    // Ctrl+Home (Ctrl+A) 滚动到顶部
    if (key.ctrl && input === 'a' && key.shift && onScrollToTop) {
      onScrollToTop();
    }
    // Ctrl+End (Ctrl+Z) 滚动到底部
    if (key.ctrl && input === 'z' && key.shift && onScrollToBottom) {
      onScrollToBottom();
    }
    // Ctrl+O 切换思考内容展开/折叠
    if (key.ctrl && input === 'o') {
      if (onToggleThinking) {
        onToggleThinking(); // cross-zone: InkRuntime handles state + forces update on all zones
      } else {
        setThinkingCollapsedLocal(prev => !prev); // legacy zone="all" path
      }
    }
  }, { isActive: inputShortcutsActive });

  // Reasoning/thinking blocks should NOT be shown during streaming
  // They should only appear after commit (when added to staticEntries)
  const dynamicEntries: TimelineEntry[] = pendingEntries.filter(entry =>
    entry.type !== 'thinking' && entry.type !== 'reasoning'
    //   从根上消除"后台卡片乱序" —— 没有卡片就没有顺序问题 (桌面端同款)。
    && !(entry.type === 'task_agent_progress' && (entry as any).taskAgentKind === 'background')
  );
  const hasRenderableMessage = (message?: Message): boolean => {
    if (!message) return false;
    const { content } = message;
    if (typeof content === 'string') {
      return content.trim().length > 0;
    }
    if (Array.isArray(content)) {
      return content.some((block) => {
        if (!block || typeof block !== 'object' || !('type' in block)) {
          return false;
        }
        switch (block.type) {
          case 'text':
            return typeof block.text === 'string' && block.text.trim().length > 0;
          case 'image_url':
            return true;
          case 'tool_use':
            return true;
          case 'tool_result':
            return block.content !== null && block.content !== undefined && String(block.content).trim().length > 0;
          case 'thinking':
            return typeof block.thinking === 'string' && block.thinking.trim().length > 0;
          case 'redacted_thinking':
            return typeof block.data === 'string' && block.data.trim().length > 0;
          default:
            return true;
        }
      });
    }
    return false;
  };
  const isRenderableEntry = (entry: TimelineEntry): boolean => {
    if (entry.message) {
      const result = hasRenderableMessage(entry.message);
      if (entry.type === 'user' && !result) {
        if (process.env.CLI_DEBUG === '1') {
          const contentPreview = safeDebugStringify(entry.message.content).slice(0, 100);
          debugLog('APP', `User message filtered out! entry.id=${entry.id}, message.role=${entry.message.role}, content=${contentPreview}`);
        }
      }
      return result;
    }
    const hasText = typeof entry.text === 'string' && entry.text.trim().length > 0;
    const hasPlan = entry.type === 'plan' && !!entry.planSteps && entry.planSteps.length > 0;
    const hasPipelineNode = (
      entry.type === 'pipeline_node_start' ||
      entry.type === 'pipeline_node_complete' ||
      entry.type === 'pipeline_node_fail' ||
      entry.type === 'pipeline_node_retry'
    ) && (entry.pipelineNode || entry.pipelineNodeRetry);
    const hasNetworkNode = (
      entry.type === 'network_node_start' ||
      entry.type === 'network_node_complete' ||
      entry.type === 'network_node_fail'
    ) && entry.networkNode;
    const hasCCBData = (
      entry.type === 'ccb_review' ||
      entry.type === 'ccb_agent_review' ||
      entry.type === 'ccb_retry' ||
      entry.type === 'ccb_failed'
    ) && !!(entry.ccbReview || entry.ccbAgentReview || entry.ccbRetry || entry.ccbFailed);
    const hasDAGData = entry.type === 'pipeline_dag' && !!entry.pipelineDAG;
    //   否则被这里过滤掉, addEntry 加了也永不渲染 (resize 不自适应的真凶)。
    const hasHeaderSnapshot = entry.type === 'header_reemit' && !!entry.headerSnapshot;
    return !!(hasText || hasPlan || hasPipelineNode || hasNetworkNode || hasCCBData || hasDAGData || hasHeaderSnapshot);
  };
  const visibleDynamicEntries = useMemo(
    () => dynamicEntries.filter(isRenderableEntry),
    [dynamicEntries]
  );
  const visibleStaticEntries = useMemo(
    () => {
      const result = staticEntries.filter(isRenderableEntry);
      if (process.env.CLI_DEBUG === '1') {
        debugLog('APP', `visibleStaticEntries: staticEntries=${staticEntries.length}, visible=${result.length}, types=${result.map(e => e.type).join(',')}`);
      }
      return result;
    },
    [staticEntries]
  );
  const expandedIds = expandedToolGroupIds || new Set<number>();
  const aggregatedStaticEntries = useMemo(
    () => aggregateToolCalls(visibleStaticEntries, timelineDensity, expandedIds),
    [visibleStaticEntries, timelineDensity, expandedIds]
  );
  const aggregatedDynamicEntries = useMemo(
    () => aggregateToolCalls(visibleDynamicEntries, timelineDensity, expandedIds),
    [visibleDynamicEntries, timelineDensity, expandedIds]
  );

  //   Ink 的非 Static 区每帧靠"光标上移 + 清行"重绘, 一旦它高过终端可视行数, 屏幕外的旧行清不掉
  //   做法: 只渲染"从最新往回数能塞进预算高度"的 entries, 更早的折叠成一行提示 (完整内容已/将在
  //   Static 滚动历史里, 不丢)。预算 = 终端行数 - 给 status/input/hint/header 留的余量。
  const { rows: termRows = 38 } = useStdout() as { rows?: number };
  // 动态区里单条长文本(流式 assistant 等)只显示尾部这么多行 (其余在 static 滚动历史里可见)
  const MAX_DYNAMIC_TEXT_LINES = 14;
  const termCols = Math.max(20, (process.stdout && process.stdout.columns) || 80);
  const wrappedLineCount = (text: string, width: number): number => {
    let n = 0;
    for (const line of text.split('\n')) {
      n += Math.max(1, Math.ceil(stringWidth(line) / width));
    }
    return n;
  };
  const estimateEntryHeight = (e: TimelineEntry): number => {
    let h = 1; // 卡片标题/基础行
    // 卡片正文普遍有 2-4 列缩进/前缀, 宽度按此折减, 宁可高估不可低估
    if (e.text) h += Math.min(wrappedLineCount(e.text, Math.max(10, termCols - 4)), MAX_DYNAMIC_TEXT_LINES);
    const tr = (e as any).taskAgentToolRecords;
    if (Array.isArray(tr)) h += Math.min(tr.length, 4); // TaskAgentCard running 窗口=3
    if ((e as any).toolGroupItems?.length) h += Math.min((e as any).toolGroupItems.length, 8);
    if ((e as any).planSteps?.length) h += Math.min((e as any).planSteps.length, 10); // PlanUpdateCard 窗口=8(+前后折叠)
    return h + 1; // marginTop
  };
  const clampDynamicEntry = (e: TimelineEntry): TimelineEntry => {
    if (!e.text) return e;
    const width = Math.max(10, termCols - 4);
    if (wrappedLineCount(e.text, width) <= MAX_DYNAMIC_TEXT_LINES) return e;
    const lines = e.text.split('\n');
    const tail: string[] = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const h = Math.max(1, Math.ceil(stringWidth(lines[i]) / width));
      if (used + h > MAX_DYNAMIC_TEXT_LINES && tail.length > 0) break;
      used += h;
      tail.unshift(lines[i]);
    }
    return { ...e, text: `… (上滚查看完整内容)\n${tail.join('\n')}` };
  };
  const { cappedDynamicEntries, droppedDynamicCount } = useMemo(() => {
    const budget = Math.max(6, termRows - 12); // 给 status+input+hint+spacer 留 ~12 行
    const capped: TimelineEntry[] = [];
    let used = 0;
    for (let i = aggregatedDynamicEntries.length - 1; i >= 0; i--) {
      const h = estimateEntryHeight(aggregatedDynamicEntries[i]);
      if (used + h > budget && capped.length > 0) break; // 至少渲最新一条
      used += h;
      capped.unshift(aggregatedDynamicEntries[i]);
    }
    return { cappedDynamicEntries: capped, droppedDynamicCount: aggregatedDynamicEntries.length - capped.length };
  }, [aggregatedDynamicEntries, termRows, termCols]);

  const hasActiveWorkers = agentContextStats.some(
    (stat) => stat.agentId !== 'Main' && (stat.status === 'running' || stat.status === 'waiting'),
  );
  const uiBusy = isRunning || hasActiveWorkers;
  const dynLock = useHeightLock(false);
  /* 排队消息条在输入框**上方**: 运行中被消费掉会把输入框往上拽 —— 只吸收小抖, 封顶 2 行 */
  const queuedLock = useHeightLock(uiBusy, 2);

  const renderStaticItem = React.useCallback((item: React.ReactNode, _index: number) => {
    // Static.tsx will pass each item and index
    // Just return the item as-is since we already created the elements with proper keys
    return item;
  }, []);

  const staticItems = useMemo(() => {
    const items: React.ReactNode[] = [];

    // Keep header as the first static item so it always stays on top.
    //   非空 (resolve 完, setProvider → forceUpdateStatic 触发重渲) 再首次打印, 值就齐了。
    if (showHeader && provider && model) {
      items.push(
        <Header
          key="static-header"
          version={version}
          provider={provider}
          model={model}
          reasoningEffort={reasoningEffort}
          workDir={workDir}
          account={account}
          accountTone={accountTone}
          forceColumns={process.stdout.columns || 80}
        />
      );
    }

    // All committed entries - each gets a unique key
    // 间距规则：所有节点前统一 1 行空行（通过 marginTop 控制）
    // tool_group entry 之间不加空行,让聚合块内部紧凑
    aggregatedStaticEntries.forEach((entry, index) => {
      const prev = aggregatedStaticEntries[index - 1];
      /* "⎿ 已中断" 挂在上一条正下方, 不隔空行 */
      const tightSpacing = (entry.type === 'tool_group' && prev?.type === 'tool_group') || (entry.type as string) === 'interrupted';
      items.push(
        <Box key={`static-entry-${entry.id}`} flexDirection="column" marginTop={(index > 0 || showHeader) && !tightSpacing ? 1 : 0}>
          <EntryRenderer entry={entry} thinkingCollapsed={thinkingCollapsed} density={timelineDensity} />
        </Box>
      );
    });

    return items;
    // staticEpoch: 重画时 Header 要拿新的 process.stdout.columns, 元素必须重建
  }, [showHeader, version, provider, model, reasoningEffort, workDir, account, accountTone, aggregatedStaticEntries, timelineDensity, staticEpoch]);

  useEffect(() => {
    if (!showHeader && staticEntries.length === 0) {
      return;
    }

    onStaticRendered?.();
  }, [showHeader, staticEntries.length, onStaticRendered]);

  if (agentContextScreenActive) {
    return (
      <AgentContextScreen
        agentContextStats={agentContextStats}
        onClose={() => onAgentContextScreenToggle?.()}
      />
    );
  }

  const handleSubmit = React.useCallback((value: string) => {
    if (textPromptOptions) {
      // Don't allow empty submission unless explicitly allowed
      if (!value.trim() && !textPromptOptions.allowEmpty) {
        return;
      }
      textPromptOptions.onSubmit(value);
      setInputValue('');
      return;
    }

    const hasImages = attachedImages.length > 0;
    const hasText = value.trim().length > 0;

    /* 防空 Enter 误触: 没文字也没图就忽略 (流式输出中用户偶尔敲 Enter, 不能把空消息发给 LLM). */
    if (!hasText && !hasImages) {
      return;
    }

    // Normal message submission (allow if has text OR images)
    if (hasText || hasImages) {
      /* 新提交一律先清掉旧 commandOutput, 避免和后续 menu/output 重叠.
       * 命令自己有输出 (如 /usage) 会通过 captureStdout sink 重新 set. */
      if (commandOutput.length > 0 && onClearCommandOutput) {
        onClearCommandOutput();
      }
      if (hasText) {
        setInputHistory((prev) => [...prev, value]);
      }
      setHistoryIndex(-1);
      setInputValue('');
      onSubmit(value, hasImages ? attachedImages : undefined);
    }
  }, [textPromptOptions, attachedImages, commandOutput, onClearCommandOutput, onSubmit]);

  // Handle history navigation
  const handleHistoryUp = React.useCallback(() => {
    //    否则走正常历史导航。
    if (isRunning && inputValue.length === 0 && queuedMessages.length > 0 && onPullbackQueued) {
      void onPullbackQueued().then((text) => {
        if (text) {
          setInputValue(text);
          setHistoryIndex(-1);
        }
      });
      return;
    }
    if (inputHistory.length === 0) return;
    const newIndex = historyIndex + 1;
    if (newIndex < inputHistory.length) {
      setHistoryIndex(newIndex);
      setInputValue(inputHistory[inputHistory.length - 1 - newIndex]);
    }
  }, [inputHistory, historyIndex, isRunning, inputValue, queuedMessages, onPullbackQueued]);

  const handleHistoryDown = React.useCallback(() => {
    if (historyIndex <= 0) {
      setHistoryIndex(-1);
      setInputValue('');
      return;
    }
    const newIndex = historyIndex - 1;
    setHistoryIndex(newIndex);
    setInputValue(inputHistory[inputHistory.length - 1 - newIndex]);
  }, [inputHistory, historyIndex]);

  // Handle tab completion
  const handleTabComplete = React.useCallback((currentValue: string): string | null => {
    if (!getCompletions) return null;

    const completions = getCompletions(currentValue);
    if (completions.length === 0) return null;

    // If only one completion, return it directly
    if (completions.length === 1) {
      return completions[0];
    }

    // If multiple completions, show completion menu
    const choices = completions.map(completion => ({
      label: completion,
      value: completion,
      description: undefined,
    }));

    setCompletionMenuOptions({
      message: 'Select completion:',
      choices,
      initialIndex: 0,
      onSelect: (value: string) => {
        setInputValue(value);
        setCompletionMenuOptions(null);
      },
      onCancel: () => {
        setCompletionMenuOptions(null);
      },
    });

    return null; // Don't auto-complete, wait for user selection
  }, [getCompletions]);

  const onInputChangeStable = React.useCallback((value: string) => {
    if (onAttachImage && isImagePath(value)) {
      onAttachImage(value.trim());
      return;
    }
    setInputValue(value);
  }, [onAttachImage]);

  const onRemoveAttachmentStable = React.useMemo(
    () => onClearImages ? (_index: number) => { onClearImages(); } : undefined,
    [onClearImages]
  );

  const showStatic = zone === 'all' || zone === 'static';
  const showDynamic = zone === 'all' || zone === 'dynamic';
  const showBottom = zone === 'all' || zone === 'bottom';

  return (
    <Box flexDirection="column" width="100%">
      {/* === Static zone: Header + committed entries === */}
      {showStatic && (
        <>
          {/* key = 重画代数: 改宽度后清屏, 换 key 让 Static 重新挂载, 整段记录按新宽度再写一遍 */}
          <Static key={staticEpoch} items={staticItems} style={{ width: '100%' }}>
            {renderStaticItem}
          </Static>
        </>
      )}

      {/* === Dynamic zone: pending/streaming entries + thinking === */}
      {showDynamic && (
        <>
          <Box ref={dynLock.ref} flexDirection="column" width="100%" {...dynLock.props}>
            {droppedDynamicCount > 0 && (
              <Text dimColor>{`  ↑ ${droppedDynamicCount} 条进行中条目已上滚 (完成后进历史)`}</Text>
            )}
            {cappedDynamicEntries.map((entry, index) => {
              const prev = cappedDynamicEntries[index - 1];
              const tightSpacing = entry.type === 'tool_group' && prev?.type === 'tool_group';
              return (
                <Box key={`pending-wrapper-${entry.id}`} flexDirection="column" marginTop={tightSpacing ? 0 : 1}>
                  <EntryRenderer entry={clampDynamicEntry(entry)} thinkingCollapsed={thinkingCollapsed} density={timelineDensity} />
                </Box>
              );
            })}

            {/* Thinking expanded overlay */}
            {!thinkingCollapsed && (() => {
              const latestStreamingThinkingEntry = [...pendingEntries]
                .reverse()
                .find(e => (e.type === 'thinking' || e.type === 'reasoning') && e.text);
              if (!latestStreamingThinkingEntry) return null;

              return (
                <Box flexDirection="column" marginTop={1}>
                  <Text color="cyan" bold>{sym('●')} Thinking (latest, ctrl+o to collapse)</Text>
                  <Box key={`thinking-expanded-${latestStreamingThinkingEntry.id}`} flexDirection="column" marginTop={1}>
                    <ThinkingBlock
                      content={latestStreamingThinkingEntry.text!}
                      collapsed={false}
                      type={latestStreamingThinkingEntry.type as 'thinking' | 'reasoning'}
                      timestamp={latestStreamingThinkingEntry.timestamp}
                      sourceLabel={latestStreamingThinkingEntry.sourceLabel}
                    />
                  </Box>
                </Box>
              );
            })()}
          </Box>


        </>
      )}

      {/* === Bottom zone: StatusLine + InputLine + menus === */}
      {showBottom && (
        <>
          {/* 这里原来也有 <Text>{'\n'}</Text> (= 2 空行), 加上状态行的 marginTop 共 3 行空白 ——
            * 分区渲染时每个回答和 "Done in Ns" 之间都空 3 行。间隔统一只留状态行那 1 行。 */}

          {/* 最小宽度提示: 终端过窄时给出明确指引, 而非让 UI 无限劣化 (消息本身保持极短以适配窄屏) */}
          {(() => {
            const cols = (process.stdout && process.stdout.isTTY && process.stdout.columns) || 80;
            if (cols >= 60) return null;
            const hard = cols < 40;
            return (
              <Box>
                <Text color={hard ? 'yellow' : 'gray'}>
                  {hard ? `↔ 加宽终端 ≥ 40 列` : `↔ 建议 ≥ 60 列`}
                </Text>
              </Box>
            );
          })()}

          {/* Interrupt Input Box - shown as overlay, replaces BottomBar when active */}
          {interruptInputActive && onInterruptInputSubmit && onInterruptInputCancel ? (
            <Box flexShrink={0} flexDirection="column">
              <InterruptInputBox
                onSubmit={onInterruptInputSubmit}
                onCancel={onInterruptInputCancel}
              />
            </Box>
          ) : (
            <Box flexShrink={0} flexDirection="column">
              <Box ref={queuedLock.ref} flexDirection="column" {...queuedLock.props}>
                {queuedMessages.length > 0 && (
                  <QueuedMessagesBar messages={queuedMessages} />
                )}
              </Box>

              {commandOutput.length > 0
                && !selectMenuOptions
                && !completionMenuOptions
                && !textPromptOptions
                && !inputValue.startsWith('/') && (
                <Box flexDirection="column" marginBottom={1}>
                  {commandOutput.map((line, index) => (
                    <Text key={index}>{line}</Text>
                  ))}
                </Box>
              )}

              {wizardHeader && (selectMenuOptions || textPromptOptions) && (
                <Box flexDirection="column" marginTop={1} paddingX={2}>
                  <Text>
                    <Text bold>{wizardHeader.title}</Text>
                    {wizardHeader.step ? <Text color={NeoxTheme.text.dim}>{'  ' + wizardHeader.step}</Text> : null}
                  </Text>
                  {(wizardHeader.lines || []).map((l, i) => (
                    <Text key={i} color={NeoxTheme.text.secondary}>{l}</Text>
                  ))}
                </Box>
              )}

              <BottomBar
                inputValue={inputValue}
                isRunning={isRunning}
                statusText={statusText}
                tokenStats={tokenStats}
                streamingTokens={streamingTokens}
                streamingStartTime={streamingStartTime}
                accumulatedRunTime={accumulatedRunTime}
                provider={provider}
                model={model}
                reasoningEffort={reasoningEffort}
                menuActive={!!selectMenuOptions || !!completionMenuOptions}
                promptActive={!!textPromptOptions}
                promptMessage={textPromptOptions?.message}
                promptHint={textPromptOptions?.hint}
                promptPassword={!!textPromptOptions?.password}
                promptOnCancel={textPromptOptions?.onCancel}
                thinkingEnabled={thinkingEnabled}
                timelineDensity={timelineDensity}
                onCycleDensity={onCycleDensity}
                contextMenuActive={contextMenuActive}
                compressionMode={compressionMode}
                compactionThreshold={compactionThreshold}
                agentContextStats={agentContextStats}
                researchProgress={researchProgress}
                runMode={effectiveRunMode}
                currentPlanSteps={currentPlanSteps}
                workDir={workDir}
                attachments={attachedImages}
                completions={currentCompletions}
                onInputChange={onInputChangeStable}
                onSubmit={handleSubmit}
                onInterrupt={onInterrupt}
                onExit={onExit}
                onHistoryUp={handleHistoryUp}
                onHistoryDown={handleHistoryDown}
                onTabComplete={handleTabComplete}
                onContextMenuToggle={onContextMenuToggle}
                onAgentContextScreenToggle={onAgentContextScreenToggle}
                onRemoveAttachment={onRemoveAttachmentStable}
                onPasteImage={onAttachImage}
                onShowInterruptInput={onShowInterruptInput}
                backgroundTasks={backgroundTasks}
                bgSelectedIndex={bgSelectedIndex}
                onBgKill={onBgKill}
                onBgRemove={onBgRemove}
                onBgNavigate={onBgNavigate}
                onBgToggleExpand={onBgToggleExpand}
                searchableEntries={staticEntries}
                sidebarAgents={sidebarAgents}
              />

              {/* 底部信息面板 (/usage …) 跟选择菜单一样出在输入框下方 */}
              {!selectMenuOptions && !textPromptOptions && <BottomPanel />}

              {selectMenuOptions && (
                <SelectMenu
                  message={selectMenuOptions.message}
                  choices={selectMenuOptions.choices}
                  initialIndex={selectMenuOptions.initialIndex}
                  hint={selectMenuOptions.hint}
                  header={selectMenuOptions.header}
                  allowTextInput={selectMenuOptions.allowTextInput}
                  accentColor={selectMenuOptions.accentColor}
                  multiSelect={selectMenuOptions.multiSelect}
                  onSelect={selectMenuOptions.onSelect}
                  onCancel={selectMenuOptions.onCancel}
                  onExit={onExit}
                />
              )}

              {completionMenuOptions && (
                <SelectMenu
                  message={completionMenuOptions.message}
                  choices={completionMenuOptions.choices}
                  initialIndex={completionMenuOptions.initialIndex}
                  hint={completionMenuOptions.hint}
                  onSelect={completionMenuOptions.onSelect}
                  onCancel={completionMenuOptions.onCancel}
                  onExit={onExit}
                />
              )}

            </Box>
          )}
        </>
      )}
    </Box>
  );
};
