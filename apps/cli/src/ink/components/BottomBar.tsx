import React from 'react';
import { Box, Text, useInput, useStdout } from '../../../vendor/ink/src/index.js';
import { InputLine } from './InputLine.js';
import { StatusLine } from './StatusLine.js';
import type { ResearchProgress } from './StatusLine.js';
import { HintLine } from './HintLine.js';
import { AttachmentBar, type Attachment } from './AttachmentBar.js';
import { NextStepBar, type PlanStep } from './NextStepBar.js';
import { ContextMenu } from './ContextMenu.js';
import { SlashCommandMenu, type SlashCommand } from './SlashCommandMenu.js';
import { FileMentionMenu } from './FileMentionMenu.js';
import { BackgroundTaskBar, type BackgroundTask } from './BackgroundTaskBar.js';
import { BackgroundAgentBar } from './BackgroundAgentBar.js';
import { AgentStatusRow } from './AgentStatusRow.js';
import { AgentBar, type SidebarAgent } from './AgentBar.js';
import { SearchBar } from './SearchBar.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getKeybindingsManager } from '@neoxlabs/platform/platform/keybindings.js';
import type { AgentContextStats } from '@neoxlabs/kernel/types/agent.js';
import type { TimelineEntry } from '../InkRuntime.js';
import { NeoxTheme } from '../theme.js';
import { useHeightLock } from '../hooks/useHeightLock.js';
import { isTranscriptOpen } from '../transcriptViewer.js';
import { getLanguage } from '../../i18n/index.js';

const isZhUi = () => { try { return getLanguage() === 'zh'; } catch { return false; } };

export interface BottomBarProps {
  inputValue: string;
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
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  customHints?: string;
  attachments?: Attachment[];
  multiline?: boolean;
  completions?: string[];
  menuActive?: boolean;
  promptActive?: boolean;
  promptMessage?: string;
  promptHint?: string;
  promptPassword?: boolean;
  promptOnCancel?: () => void;
  thinkingEnabled?: boolean;
  timelineDensity?: 'full' | 'medium' | 'compact';
  onCycleDensity?: () => void;
  contextMenuActive?: boolean;
  compressionMode?: 'sync' | 'async';
  compactionThreshold?: number;
  agentContextStats?: AgentContextStats[];
  researchProgress?: ResearchProgress | null;
  runMode?: 'agentic';
  currentPlanSteps?: PlanStep[];
  onInputChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onInterrupt: () => void;
  onExit: () => void;
  onHistoryUp: () => void;
  onHistoryDown: () => void;
  onTabComplete?: (currentValue: string) => string | null;
  onRemoveAttachment?: (index: number) => void;
  onContextMenuToggle?: () => void;
  onAgentContextScreenToggle?: () => void;
  onPasteImage?: (imageData: { mediaType: string; data: string; name: string }) => number | null | void; // 返回图片编号 seq (用于在输入框插 [图片 #seq] token)
  onShowInterruptInput?: () => void;
  // Background tasks (agentic mode)
  backgroundTasks?: BackgroundTask[];
  bgSelectedIndex?: number;
  onBgKill?: (id: number) => void;
  onBgRemove?: (id: number) => void;
  onBgNavigate?: (direction: 'up' | 'down') => void;
  onBgToggleExpand?: () => void;
  workDir?: string;
  searchableEntries?: TimelineEntry[];
  sidebarAgents?: SidebarAgent[];
}

const BottomBarComponent: React.FC<BottomBarProps> = ({
  inputValue,
  isRunning,
  statusText = '',
  tokenStats,
  streamingTokens = 0,
  streamingStartTime = null,
  accumulatedRunTime = 0,
  provider,
  model,
  reasoningEffort,
  customHints,
  attachments = [],
  multiline = false,
  completions = [],
  menuActive = false,
  promptActive = false,
  promptMessage,
  promptHint,
  promptPassword = false,
  promptOnCancel,
  thinkingEnabled = true,
  timelineDensity = 'medium',
  onCycleDensity,
  contextMenuActive = false,
  compressionMode = 'sync',
  compactionThreshold = 0.85,
  agentContextStats = [],
  researchProgress = null, // 深度调研聚合进度
  runMode = 'agentic',
  currentPlanSteps = [],
  onInputChange,
  onSubmit,
  onInterrupt,
  onExit,
  onHistoryUp,
  onHistoryDown,
  onTabComplete,
  onRemoveAttachment,
  onContextMenuToggle,
  onAgentContextScreenToggle,
  onPasteImage,
  onShowInterruptInput,
  backgroundTasks = [],
  bgSelectedIndex = -1,
  onBgKill,
  onBgRemove,
  onBgNavigate,
  onBgToggleExpand,
  workDir,
  searchableEntries = [],
  sidebarAgents = [],
}) => {
  //   多容器 bottom 区可能 stale (跟 header static 区同病)。配合 resize 时 forceUpdateBottom 重渲。
  const ctxStdout = useStdout();
  const terminalWidth = process.stdout.columns || ctxStdout.columns || 80;

  // Background task panel focus state
  const [bgFocused, setBgFocused] = React.useState(false);
  const [agentFocused, setAgentFocused] = React.useState(false);
  const [agentSelIdx, setAgentSelIdx] = React.useState(0);
  const runningAgents = sidebarAgents.filter(a => a.status === 'running');

  const [searchActive, setSearchActive] = React.useState(false);

  // Treat active task-agents as running for keyboard + height-lock (same uiBusy as App)
  const hasActiveWorkers = agentContextStats.some(
    stat => stat.agentId !== 'Main' && (stat.status === 'running' || stat.status === 'waiting')
  );
  const uiBusy = isRunning || hasActiveWorkers;
  const effectiveIsRunning = uiBusy;

  const termRows = Math.max(10, process.stdout.rows || ctxStdout.rows || 24);
  void termRows;
  const topLock = useHeightLock(uiBusy, 3);
  const botLock = useHeightLock(uiBusy, 3);

  // Auto-unfocus when no tasks left
  React.useEffect(() => {
    if (backgroundTasks.length === 0 && bgFocused) {
      setBgFocused(false);
    }
  }, [backgroundTasks.length, bgFocused]);

  // Auto-unfocus when user starts typing
  React.useEffect(() => {
    if (inputValue && bgFocused) {
      setBgFocused(false);
    }
  }, [inputValue, bgFocused]);

  // 后台 agent 面板: 无 agent / 开始打字 → 自动失焦; 选中下标越界 → clamp
  React.useEffect(() => {
    if ((runningAgents.length === 0 || inputValue) && agentFocused) setAgentFocused(false);
    if (agentSelIdx >= runningAgents.length && runningAgents.length > 0) setAgentSelIdx(runningAgents.length - 1);
  }, [runningAgents.length, inputValue, agentFocused, agentSelIdx]);

  // 当用户输入单独的 / 或 /xxx 时显示交互菜单
  const showSlashMenu = inputValue === '/' || (inputValue.startsWith('/') && !inputValue.includes(' '));

  /* "@xxx" (输入末尾那个词) → 文件候选菜单。Esc 关掉后这段输入不再弹, 输入一变就恢复。 */
  const mention = /(?:^|\s)@([^\s@]*)$/.exec(inputValue);
  const [mentionDismissedAt, setMentionDismissedAt] = React.useState<string | null>(null);
  const showFileMenu = !!mention && !showSlashMenu && !menuActive && !promptActive && mentionDismissedAt !== inputValue;
  const handleMentionSelect = React.useCallback((path: string) => {
    if (!mention) return;
    const at = inputValue.length - mention[1]!.length - 1;
    onInputChange(`${inputValue.slice(0, at)}@${path} `);
  }, [inputValue, mention, onInputChange]);
  const handleMentionCancel = React.useCallback(() => setMentionDismissedAt(inputValue), [inputValue]);

  const handleSlashMenuSelect = React.useCallback((command: string) => {
    // 如果命令末尾有空格，说明是 Tab 填充，只填充不执行
    if (command.endsWith(' ')) {
      /* 保留末尾空格 — showSlashMenu 用 !inputValue.includes(' ') 判定; 不保留空格
       * 则 inputValue='/help' 仍触发菜单, 用户得 ESC 才能输入下个 token, 体验差.
       * 留个空格 → showSlashMenu=false, 菜单自然关, 光标后接续输入. */
      onInputChange(command);
    } else {
      // 直接执行命令 - 使用 setTimeout 确保状态更新后再执行
      onInputChange('');
      setTimeout(() => {
        onSubmit(command);
      }, 0);
    }
  }, [onInputChange, onSubmit]);

  const handleSlashMenuCancel = React.useCallback(() => {
    onInputChange('');
  }, [onInputChange]);

  const lastCtrlCAtRef = React.useRef(0);
  const lastEscAtRef = React.useRef(0);
  const lastEscLogAtRef = React.useRef(0);
  const CTRL_C_EXIT_WINDOW_MS = 1200;
  const ESC_DEBOUNCE_WINDOW_MS = 200;

  // Handle global shortcuts (ESC for interrupt/clear, Ctrl+C for exit)
  useInput((input, key) => {
    if (isTranscriptOpen()) return; // ctrl+o 完整记录打开时按键归它
    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('INK_INPUT', 'BottomBar useInput', {
        key,
        input,
        menuActive,
        promptActive,
        isRunning,
        inputValue: inputValue.substring(0, 20)
      });
    }

    const kb = getKeybindingsManager();
    const ctx = effectiveIsRunning ? 'running' : 'idle';

    if (kb.matches('search', input, key, ctx) && !searchActive) {
      setSearchActive(true);
      return;
    }

    // Skip when search is active (SearchBar handles its own input)
    if (searchActive) {
      return;
    }

    // Skip when menu is active (let SelectMenu handle)
    if (menuActive) {
      return;
    }

    if (kb.matches('interruptInput', input, key, ctx) && onShowInterruptInput) {
      cliLogger.debug('INK_INPUT', 'Interrupt input triggered');
      onShowInterruptInput();
      return;
    }

    if (kb.matches('toggleAgentScreen', input, key, ctx) && onAgentContextScreenToggle) {
      onAgentContextScreenToggle();
      return;
    }

    // Ctrl+Z triggers SIGTSTP which can suspend the process
    // We ignore it completely to prevent accidental suspension
    if (key.ctrl && input === 'z') {
      if (process.env.CLI_DEBUG === '1') {
        cliLogger.debug('INK_INPUT', 'Ctrl+Z blocked (prevents suspension)');
      }
      return; // Silently ignore Ctrl+Z
    }

    if (key.ctrl && input === 't' && onCycleDensity) {
      onCycleDensity();
      return;
    }

    // Tab: 在 输入框 → tasks面板 → agents面板 → 输入框 间循环聚焦。
    //   用 !isRunning (主 agent 空闲) 而非 !effectiveIsRunning —— 后者含"后台 agent 在跑",
    //   而查看后台 agent 正是在它们跑、主 agent 空闲时, 不能因此被挡。
    if (key.tab && !showSlashMenu && !showFileMenu) {
      const hasTasks = backgroundTasks.length > 0;
      const hasAgents = runningAgents.length > 0;
      if (!hasTasks && !hasAgents) { /* 啥都没有, 不拦 tab */ }
      else if (bgFocused) {
        // tasks → agents (有的话) 否则回输入框
        setBgFocused(false);
        if (hasAgents) { setAgentFocused(true); setAgentSelIdx(0); }
        return;
      } else if (agentFocused) {
        // agents → 输入框
        setAgentFocused(false);
        return;
      } else {
        // 输入框 → tasks (优先) 否则 agents
        if (hasTasks) setBgFocused(true);
        else if (hasAgents) { setAgentFocused(true); setAgentSelIdx(0); }
        return;
      }
    }

    if (agentFocused && runningAgents.length > 0) {
      if (key.upArrow) {
        if (agentSelIdx <= 0) { setAgentFocused(false); return; }
        setAgentSelIdx(i => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setAgentSelIdx(i => Math.min(runningAgents.length - 1, i + 1));
        return;
      }
      if (key.escape) { setAgentFocused(false); return; }
    }

    if (key.downArrow && !bgFocused && !effectiveIsRunning && !showSlashMenu
      && !inputValue && backgroundTasks.length > 0) {
      setBgFocused(true);
      return;
    }

    // Background task panel has focus: ↑↓ navigate, Enter expand, Delete kill
    if (bgFocused && backgroundTasks.length > 0) {
      if (key.upArrow) {
        if (bgSelectedIndex <= 0) {
          setBgFocused(false);
          return;
        }
        onBgNavigate?.('up');
        return;
      }
      if (key.downArrow) {
        onBgNavigate?.('down');
        return;
      }
      if (key.return && bgSelectedIndex >= 0) {
        onBgToggleExpand?.();
        return;
      }
      if ((key.delete || key.backspace) && bgSelectedIndex >= 0 && bgSelectedIndex < backgroundTasks.length) {
        const selectedTask = backgroundTasks[bgSelectedIndex];
        if (selectedTask.status === 'running') {
          onBgKill?.(selectedTask.id);
        } else {
          onBgRemove?.(selectedTask.id);
        }
        return;
      }
    }

    if (key.escape && showFileMenu) return; /* 文件候选菜单自己关 (FileMentionMenu), 别当成清输入 / 中断 */
    if (key.escape) {
      const now = Date.now();
      if (now - lastEscAtRef.current < ESC_DEBOUNCE_WINDOW_MS) {
        return;
      }
      lastEscAtRef.current = now;

      // 真正的 ESC 键按下时 input 应该是空的或者是 '\x1b'
      // 如果 input 包含其他字符，可能是 escape 序列（如方向键、功能键等）
      const isRealEscape = !input || input === '\x1b' || input === '';

      if (process.env.CLI_DEBUG === '1' && now - lastEscLogAtRef.current > 500) {
        lastEscLogAtRef.current = now;
        cliLogger.debug('INK_INPUT', `ESC detected: isRealEscape=${isRealEscape}, input=${JSON.stringify(input)}, isRunning=${effectiveIsRunning}`);
      }

      if (!isRealEscape) {
        // 这可能是 escape 序列的一部分，不是真正的 ESC 键
        cliLogger.debug('INK_INPUT', 'Ignoring escape sequence (not real ESC key)');
        return;
      }

      if (contextMenuActive && onContextMenuToggle) {
        // Close context menu
        onContextMenuToggle();
        return;
      }

      // Then handle prompt cancellation
      if (promptActive && promptOnCancel) {
        // Cancel prompt
        promptOnCancel();
        onInputChange(''); // Clear input
        return;
      }

      // Background tasks: ESC when panel focused kills/removes selected task
      if (bgFocused && backgroundTasks.length > 0 && bgSelectedIndex >= 0 && bgSelectedIndex < backgroundTasks.length) {
        const selectedTask = backgroundTasks[bgSelectedIndex];
        if (selectedTask.status === 'running') {
          onBgKill?.(selectedTask.id);
        } else {
          onBgRemove?.(selectedTask.id);
        }
        return;
      }

      // ESC unfocuses bg panel if focused but nothing selected
      if (bgFocused) {
        setBgFocused(false);
        return;
      }

      // Then handle interrupt or clear
      if (effectiveIsRunning) {
        // Interrupt running task
        cliLogger.debug('INK_INPUT', '🛑 User pressed ESC to interrupt task');
        onInterrupt();
      } else if (inputValue) {
        // Clear input
        onInputChange('');
      }
      // This ensures ESC only interrupts/clears, never exits
      return;
    }

    if (key.ctrl && input === 'c') {
      const now = Date.now();
      const isSecondPress = now - lastCtrlCAtRef.current <= CTRL_C_EXIT_WINDOW_MS;
      lastCtrlCAtRef.current = now;

      if (process.env.CLI_DEBUG === '1') {
        cliLogger.debug('INK_INPUT', 'Ctrl+C pressed', { isRunning: effectiveIsRunning, isSecondPress });
      }

      if (isSecondPress) {
        cliLogger.info('INK_INPUT', '⚠️  Ctrl+C double-press - force exiting');
        onExit();
        return;
      }

      if (effectiveIsRunning) {
        onInterrupt();
        return;
      }

      cliLogger.info('INK_INPUT', '⚠️  Ctrl+C pressed - exiting');
      onExit();
    }
  }, { isActive: true });

  return (
    <Box flexDirection="column">
      {/* Prompt message when in prompt mode */}
      {/* 文本提问: 只一行问题 (正文色加粗); 提示放进输入框的占位文字, 不再单独占一行 (原来两处重复) */}
      {promptActive && promptMessage && (
        <Box paddingX={2} marginTop={1}>
          <Text bold>{promptMessage}</Text>
        </Box>
      )}

      {/* 输入框上方区块 — 高度锁住, 里面任何一行进出都不再推动输入框 */}
      <Box ref={topLock.ref} flexDirection="column" width="100%" {...topLock.props}>
        {/* Status Line - hidden when prompt or menu is active */}
        {!promptActive && !menuActive && (
          <Box marginTop={1} width="100%">
            <StatusLine
              isRunning={effectiveIsRunning}
              statusText={statusText}
              tokenStats={tokenStats}
              streamingTokens={streamingTokens}
              streamingStartTime={streamingStartTime}
              provider={provider}
              model={model}
              onContextMenuToggle={onContextMenuToggle}
              agentContextStats={agentContextStats}
              researchProgress={researchProgress}
              runMode={runMode}
            />
          </Box>
        )}

        {!promptActive && !menuActive && (
          <NextStepBar planSteps={currentPlanSteps} isRunning={effectiveIsRunning} />
        )}
      </Box>


      {searchActive && (
        <Box flexDirection="column">
          <Text color={NeoxTheme.border.primary}>{'─'.repeat(terminalWidth)}</Text>
          <SearchBar
            entries={searchableEntries}
            onClose={() => setSearchActive(false)}
          />
          <Text color={NeoxTheme.border.primary}>{'─'.repeat(terminalWidth)}</Text>
        </Box>
      )}

      {/* Input Line - hidden when menu or search is active */}
      {!menuActive && !searchActive && (
        <Box flexDirection="column">
          <Text color={NeoxTheme.border.primary}>{'─'.repeat(terminalWidth)}</Text>
          <InputLine
            value={inputValue}
            mask={promptActive && promptPassword}
            placeholder={promptActive
              ? (promptHint || (isZhUi() ? '输入回答…' : 'Type your answer…'))
              : effectiveIsRunning
                ? (isZhUi() ? '回车打断并发送…' : 'Enter to interrupt and send…')
                : (isZhUi() ? '输入消息, / 看命令' : 'Type a message, / for commands')
            }
            disabled={menuActive}
            panelFocused={bgFocused || agentFocused}
            multiline={multiline}
            completions={[]}
            menuActive={menuActive}
            slashMenuActive={showSlashMenu || showFileMenu} // 菜单开着时 ↑↓/回车/Tab 交给菜单
            imageCount={attachments.length}
            onChange={onInputChange}
            onSubmit={(overrideValue) => onSubmit(overrideValue ?? inputValue)}
            onHistoryUp={onHistoryUp}
            onHistoryDown={onHistoryDown}
            onTabComplete={onTabComplete}
            onPasteImage={onPasteImage}
            onRemoveLastAttachment={onRemoveAttachment ? () => onRemoveAttachment(attachments.length - 1) : undefined}
          />
          <Text color={NeoxTheme.border.primary}>{'─'.repeat(terminalWidth)}</Text>
        </Box>
      )}

      {showSlashMenu && !menuActive && !effectiveIsRunning && (
        <SlashCommandMenu
          isVisible={true}
          filter={inputValue}
          onSelect={handleSlashMenuSelect}
          onCancel={handleSlashMenuCancel}
        />
      )}

      {showFileMenu && mention && (
        <FileMentionMenu
          query={mention[1]!}
          workDir={workDir || process.cwd()}
          onSelect={handleMentionSelect}
          onCancel={handleMentionCancel}
          onSubmitInput={() => onSubmit(inputValue)}
        />
      )}

      {/* 输入框下方区块 — 同样锁高: 它不推输入框, 但改帧总高就会把"帧尾贴屏底"来回切 */}
      <Box ref={botLock.ref} flexDirection="column" {...botLock.props}>
        {/* Hint Line - no border, only show when not in prompt mode */}
        {!promptActive && (
          <HintLine
            isRunning={effectiveIsRunning}
            hasInput={inputValue.length > 0}
            customHints={customHints}
            menuActive={menuActive}
            thinkingEnabled={thinkingEnabled}
            accumulatedRunTime={accumulatedRunTime}
            provider={provider}
            model={model}
            reasoningEffort={reasoningEffort}
            runMode={runMode}
            hasBgTasks={backgroundTasks.length > 0}
            bgRunning={backgroundTasks.filter(t => t.status === 'running').length}
            bgFailed={backgroundTasks.filter(t => t.status === 'error').length}
            workDir={workDir}
            sidebarAgents={sidebarAgents}
            timelineDensity={timelineDensity}
            contextPressure={tokenStats?.contextWindow ? tokenStats?.pressure : undefined}
          />
        )}

        {/* 后台命令列表: 只在 Tab 聚焦时展开; 平时的计数在 HintLine 左侧那句里 (不再单占一行) */}
        {backgroundTasks.length > 0 && bgFocused && (
          <BackgroundTaskBar
            tasks={backgroundTasks}
            selectedIndex={bgFocused ? bgSelectedIndex : -1}
            collapsed={!bgFocused}
            onKill={onBgKill}
            onToggleExpand={onBgToggleExpand}
          />
        )}

        <BackgroundAgentBar
          agents={sidebarAgents}
          focused={agentFocused}
          selectedIndex={agentSelIdx}
        />

        {!promptActive && !menuActive && <AgentStatusRow />}
      </Box>

      {/* Context Menu - show when toggled */}
      {/* 还没有窗口数据 (新会话没发过消息) 也要打开 —— 面板自己说"还没有数据", 不能静默不开 */}
      {contextMenuActive && onContextMenuToggle && (
        <ContextMenu
          contextWindow={tokenStats?.contextWindow || 0}
          tokensUsed={tokenStats?.tokensUsedForContext || tokenStats?.total || 0}
          systemTokens={tokenStats?.systemTokens}
          userTokens={tokenStats?.userTokens}
          assistantTokens={tokenStats?.assistantTokens}
          toolCallTokens={tokenStats?.toolCallTokens}
          toolResultTokens={tokenStats?.toolResultTokens}
          compressionMode={compressionMode}
          compactionThreshold={compactionThreshold}
          agentContextStats={agentContextStats}
          runMode={runMode}
          onClose={onContextMenuToggle}
        />
      )}
    </Box>
  );
};

// BottomBar should NEVER re-render when Static entries change
export const BottomBar = React.memo(BottomBarComponent);
