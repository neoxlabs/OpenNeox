import React, { useState, useEffect } from 'react';
import { Box, Text, useStdout } from '../../../vendor/ink/src/index.js';
import Spinner from 'ink-spinner';
import stringWidth from 'string-width';
import type { AgentContextStats } from '@neoxlabs/kernel/types/agent.js';
import { sym } from '../utils/winSymbols.js';
import { NeoxTheme } from '../theme.js';
import { VortexSpinner } from '../brand/VortexSpinner.js';
import {
  getTargetStatus,
  getCurrentTargetPlan,
} from '@neoxlabs/core/tools/targetModeTools.js';

export interface NetworkStats {
  teamSize: number;           // 团队 Agent 数量
  activeAgents: number;       // 当前活跃的 Agent 数量
  currentPhase?: 'analyzing' | 'bidding' | 'negotiating' | 'executing' | 'reviewing' | 'complete';
  currentAgent?: string;      // 当前正在执行的 Agent 名称
  totalInputTokens: number;   // 所有 Agent 总输入 token
  totalOutputTokens: number;  // 所有 Agent 总输出 token
  completedTasks?: number;    // 已完成任务数
  totalTasks?: number;        // 总任务数
}

export interface CooperateStats {
  /** 使用的模型列表（简称） */
  models: Array<{
    shortName: string;  // 如 'claude', 'gpt', 'gemini', 'haiku'
    fullName?: string;  // 完整模型名
    status: 'idle' | 'running' | 'completed';
  }>;
  /** 当前阶段 */
  phase?: 'analyzing' | 'ccb_review' | 'dag_planning' | 'executing' | 'complete';
  /** 总输入 token */
  totalInputTokens: number;
  /** 总输出 token */
  totalOutputTokens: number;
  /** CCB 评审结果 */
  ccbResult?: {
    approved: boolean;
    approveCount: number;
    totalCount: number;
  };
  /** DAG 执行进度 */
  dagProgress?: {
    completedNodes: number;
    totalNodes: number;
  };
}

export interface ResearchProgress {
  topic: string;
  scale: string;
  /** 开局拆了几个角度 */
  seeds?: number;
  dispatched: number;
  completed: number;
  failed: number;
  inFlight: number;
  queued: number;
  sources: number;
  domains: number;
  claims: number;
  disputed: number;
}

export interface StatusLineProps {
  isRunning: boolean;
  statusText?: string;
  tokenStats?: {
    input: number;
    output: number;
    total: number;
    contextWindow?: number;
    tokensUsedForContext?: number;
    pressure?: number;
    toolTokens?: number;      // Tokens used by tool definitions
    messageTokens?: number;   // Tokens used by messages
    systemTokens?: number;    // Tokens used by system prompt
    cacheCreationTokens?: number;  // Tokens used for cache creation
    cacheReadTokens?: number;      // Tokens used for cache reading
  };
  streamingTokens?: number;
  streamingStartTime?: number | null;
  provider?: string;
  model?: string;
  onContextMenuToggle?: () => void;
  agentContextStats?: AgentContextStats[];
  runMode?: 'agentic';
  /** 深度调研聚合进度 — null/undefined = 当前没有调研在跑, 这一行不出现 */
  researchProgress?: ResearchProgress | null;
}

// Animation state changes should NOT trigger App re-render
const StatusLineComponent: React.FC<StatusLineProps> = ({
  isRunning,
  statusText = '',
  tokenStats,
  streamingTokens = 0,
  streamingStartTime = null,
  provider,
  model,
  onContextMenuToggle,
  agentContextStats = [],
  runMode = 'agentic',
  researchProgress = null,
}) => {
  const toInkColor = (color?: string): React.ComponentProps<typeof Text>['color'] => color;
  const { columns: terminalWidth = 80 } = useStdout();

  const workerStats = agentContextStats.filter(s => s.agentId !== 'Main');
  const hasActiveWorkers = workerStats.some(s => s.status === 'running' || s.status === 'waiting');
  const effectiveIsRunning = isRunning || (runMode === 'agentic' && hasActiveWorkers);

  const idleOutcome = React.useMemo(() => {
    const s = (statusText || '').trim();
    const hasProduced = (tokenStats?.output || 0) > 0;

    if (/^(task failed|error|error occurred|something went wrong)/i.test(s)) {
      /* 错误原文时间线上已有一条红字, 这里只说结局 (跟成功时 "Done in 3s" 对称) —— 原来把整句错误再抄一遍, 紧贴在时间线那条下面 */
      return { symbol: '✗', label: 'Task failed', color: NeoxTheme.functional.error };
    }
    /* 中断 —— 由 main.ts 的中断路径显式置成 'Interrupted'。
     * 注意不能靠 "有产出却停在 Ready" 来推断: 中断会先 resetStreamingState(),
     * tokenStats 归零, 那个条件永远不成立 (试过, 是死代码)。 */
    if (/^interrupted$/i.test(s)) {
      return { symbol: '⚠', label: 'Interrupted', color: NeoxTheme.functional.warning };
    }
    if (hasProduced) {
      return { symbol: '■', label: s || 'Complete!', color: '#6FCF97' };
    }
    /* 没有产出时: 有状态文本就照实显示 (中断/取消等由上游写入的终态),
     * 完全没有才是真空闲 (刚启动 / 清屏后)。不再写死。 */
    if (s) return { symbol: '◉', label: s, color: NeoxTheme.text.secondary };
    return { symbol: '◉', label: 'Ready', color: NeoxTheme.text.secondary };
  }, [statusText, tokenStats?.output]);

  const [taskStartTime, setTaskStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);

  const [displayedTokens, setDisplayedTokens] = useState(0);

  const [animatedOutputTokens, setAnimatedOutputTokens] = useState(0);

  const [highlightPos, setHighlightPos] = useState(0);

  const wasRunningRef = React.useRef(false);
  const lastStopRef = React.useRef(0);
  useEffect(() => {
    if (effectiveIsRunning && !wasRunningRef.current) {
      if (Date.now() - lastStopRef.current > 3000 || taskStartTime === null) {
        setTaskStartTime(Date.now());
        setElapsedTime(0);
      }
    } else if (!effectiveIsRunning && wasRunningRef.current) {
      lastStopRef.current = Date.now();
      if (taskStartTime !== null) setElapsedTime(Math.floor((Date.now() - taskStartTime) / 1000));
    }
    wasRunningRef.current = effectiveIsRunning;
  }, [effectiveIsRunning]);

  useEffect(() => {
    if (!effectiveIsRunning || taskStartTime === null) {
      return;
    }

    const timer = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - taskStartTime) / 1000));
    }, 500);

    return () => clearInterval(timer);
  }, [effectiveIsRunning, taskStartTime]);

  useEffect(() => {
    if (!effectiveIsRunning || streamingTokens === 0) {
      setDisplayedTokens(0);
      return;
    }

    const targetTokens = Math.floor(streamingTokens);  // Already token count, no division needed

    // If target is same, no animation needed
    if (displayedTokens === targetTokens) {
      return;
    }

    // Calculate increment speed based on difference
    const diff = targetTokens - displayedTokens;
    const steps = Math.min(Math.abs(diff), 20); // Max 20 steps
    const increment = diff / steps;
    const intervalMs = 50; // 50ms per step = smooth animation

    const timer = setInterval(() => {
      setDisplayedTokens(current => {
        const next = current + increment;
        // Stop when close enough
        if (Math.abs(next - targetTokens) < 1) {
          return targetTokens;
        }
        return next;
      });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [streamingTokens, effectiveIsRunning, displayedTokens]);

  // This ensures the displayed number catches up quickly to the actual value
  useEffect(() => {
    const targetOutput = tokenStats?.output || 0;

    // If already at target, no animation needed
    if (animatedOutputTokens === targetOutput) {
      return;
    }

    // Fast catch-up animation
    const diff = targetOutput - animatedOutputTokens;

    // If difference is large (>100), jump immediately to avoid long animation
    if (Math.abs(diff) > 100) {
      setAnimatedOutputTokens(targetOutput);
      return;
    }

    const steps = Math.max(Math.ceil(Math.abs(diff) / 10), 3); // At least 3 steps
    const increment = diff / steps;
    const intervalMs = 50;

    const timer = setInterval(() => {
      setAnimatedOutputTokens(current => {
        const next = current + increment;
        // Stop when close enough
        if (Math.abs(next - targetOutput) < 1) {
          return targetOutput;
        }
        return next;
      });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [tokenStats?.output, animatedOutputTokens]);

  //    只在 target 激活时启动 timer, 无 target 时不消耗.
  const [targetTick, setTargetTick] = useState(0);
  const targetPlanForTick = getCurrentTargetPlan();
  const targetStatusForTick = getTargetStatus();
  const targetIsLive = (targetStatusForTick === 'active' || targetStatusForTick === 'satisfied') && !!targetPlanForTick;
  useEffect(() => {
    if (!targetIsLive) return;
    const id = setInterval(() => setTargetTick(t => (t + 1) % 1000000), 1000);
    return () => clearInterval(id);
  }, [targetIsLive]);
  void targetTick; // read to keep dep

  useEffect(() => {
    if (!effectiveIsRunning) {
      setHighlightPos(0);
      return;
    }

    const text = statusText || 'Thinking...';
    const stableLen = (() => {
      const m = text.match(/^Writing\s+(.+?)\s+[·(]/);
      if (m) return Math.min(48, `Writing ${m[1]}`.length);
      return text.length;
    })();

    const timer = setInterval(() => {
      setHighlightPos(p => (p + 1) % (stableLen + 3));
    }, 120);

    return () => clearInterval(timer);
  }, [effectiveIsRunning, statusText?.replace(/\d+\s*lines?/i, '#') ?? '']);

  // Format elapsed time
  const formatElapsedTime = (): string => {
    if (elapsedTime < 60) return `${elapsedTime}s`;
    const minutes = Math.floor(elapsedTime / 60);
    const seconds = elapsedTime % 60;
    return `${minutes}m ${seconds}s`;
  };

  const formatTargetElapsed = (fromMs: number): string => {
    const s = Math.max(0, Math.floor((Date.now() - fromMs) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
  };

  //    长跑期间用户始终能看到 "在追什么目标 / 已经跑多久 / 有几步".
  const renderTargetLine = (): React.ReactNode => {
    if (!targetIsLive || !targetPlanForTick) return null;
    const target = targetPlanForTick.target || '(unnamed target)';
    const isSat = targetStatusForTick === 'satisfied';
    const elapsed = formatTargetElapsed(targetPlanForTick.createdAt);
    const subTotal = targetPlanForTick.sub_missions?.length || 0;
    // 截断 target 文本以适应终端宽度. 保留能读的最大长度, 至少 20.
    const maxTargetLen = Math.max(20, Math.min(80, terminalWidth - 40));
    const truncatedTarget = target.length > maxTargetLen
      ? target.slice(0, maxTargetLen - 1) + '…'
      : target;
    return (
      <Box>
        <Text color={isSat ? '#6FCF97' : '#B19CD9'}>{sym('◈')}</Text>
        <Text> </Text>
        <Text color={isSat ? '#6FCF97' : '#9B8FD9'} bold>
          {isSat ? 'Target reached' : 'Pursuing'}
        </Text>
        <Text dimColor>: </Text>
        <Text color="#B19CD9">{truncatedTarget}</Text>
        <Text dimColor> · </Text>
        <Text color="yellow">{elapsed}</Text>
        {subTotal > 0 && !isVeryNarrow && (
          <>
            <Text dimColor> · </Text>
            <Text color="#B19CD9">{subTotal} step{subTotal === 1 ? '' : 's'}</Text>
          </>
        )}
      </Box>
    );
  };

  // Format number (with K/M suffix for large numbers)
  const formatNumber = (n: number): string => {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toString();
  };

  // Calculate percentage
  const contextWindow = tokenStats?.contextWindow || 0;
  const tokensUsedForContext = tokenStats?.tokensUsedForContext || tokenStats?.total || 0;
  const pressure = tokenStats?.pressure || 0;
  const percentage = Math.round(pressure * 100);
  const isResponsesProvider = (provider || '').toLowerCase().includes('responses');

  // Get pressure color
  const getPressureColor = (): string => {
    if (pressure > 0.8) return 'red';
    if (pressure > 0.5) return 'yellow';
    return '#B19CD9'; // 低压力时显示紫色
  };

  const renderSweepText = (text: string): React.ReactNode => {
    const chars = text.split('');
    return chars.map((char, i) => {
      // Highlight window: 2 chars bright, 1 char medium
      const dist = i - highlightPos;
      if (dist >= 0 && dist < 2) {
        return <Text key={i} color={NeoxTheme.text.primary} bold>{char}</Text>;
      } else if (dist >= -2 && dist < 0) {
        return <Text key={i} color={NeoxTheme.brand.purple}>{char}</Text>;
      } else {
        return <Text key={i} color={NeoxTheme.text.secondary}>{char}</Text>;
      }
    });
  };

  const truncateText = (text: string, maxWidth: number): string => {
    if (!text) return text;

    const width = stringWidth(text);
    if (width <= maxWidth) return text;

    // Binary search for the right length
    let left = 0;
    let right = text.length;
    let result = text;

    while (left < right) {
      const mid = Math.floor((left + right + 1) / 2);
      const truncated = text.slice(0, mid) + '...';
      const truncatedWidth = stringWidth(truncated);

      if (truncatedWidth <= maxWidth) {
        result = truncated;
        left = mid;
      } else {
        right = mid - 1;
      }
    }

    return result;
  };

  /** Writing 全路径 / 旧格式 → basename · N lines, 避免撑爆单行 */
  const normalizeStatusText = (raw: string): string => {
    if (!raw) return raw;
    /* 上游有的状态文案自带计时 ("Explore agents running... 10s" / "Shell running... 1m 3s"),
     * 跟后面的整轮用时并排就是两个时间。计时由这一行统一给, 文案里的去掉。 */
    let t = raw.trim().replace(/(\.\.\.|…)\s+\d+(?:m\s*\d+)?s$/, '$1');
    /* 共享运行时会轮换 Thinking/Processing/Analyzing/Pondering/Contemplating —— 同一个状态, 统一成一个词 */
    if (/^(thinking|processing|analyzing|pondering|contemplating)(\.\.\.|…)?$/i.test(t)) return 'Thinking…';
    if (/^generating response(\.\.\.|…)?$/i.test(t)) return 'Responding…';
    const m1 = t.match(/^Writing\s+(.+?)\s+\((\d+)\s+lines?\)\.\.\.$/i);
    if (m1) {
      const base = m1[1].split(/[\\/]/).pop() || m1[1];
      return `Writing ${base} · ${m1[2]} lines`;
    }
    const m2 = t.match(/^Writing\s+(.+?)\s+\((\d+)\s+lines?\)$/i);
    if (m2) {
      const base = m2[1].split(/[\\/]/).pop() || m2[1];
      return `Writing ${base} · ${m2[2]} lines`;
    }
    const m3 = t.match(/^Writing\s+(\/.+?|[A-Za-z]:\\.+?)\s+·\s+(\d+)\s+lines$/i);
    if (m3) {
      const base = m3[1].split(/[\\/]/).pop() || m3[1];
      return `Writing ${base} · ${m3[2]} lines`;
    }
    return t;
  };

  /** Compact 电量条 — 分色渲染, 像桌面 CompactionView rail */
  const renderCompactStatus = (text: string, maxWidth: number): React.ReactNode => {
    /* 进度条画在时间线的压缩卡片上, 状态行只写阶段 ("压缩 · 生成摘要…") —— 两处同一根条就重复了 */
    const m = text.match(/^((?:压缩|Compact))\s+\[[^\]]*\]\s*(?:\d+%\s*)?(?:\d+\/\d+\s*)?(.*)$/i);
    const plain = m ? `${m[1]}${m[2] ? ' · ' + m[2] : '…'}` : text;
    return <Text color={NeoxTheme.text.secondary}>{truncateText(plain, maxWidth)}</Text>;
  };

  const looksLikeCompactStatus = (text: string): boolean =>
    /^(压缩|Compact)\s+\[/i.test(text.trim())
    || /\bcompact(ing|ion)?\b/i.test(text)
    || /^压缩\b/.test(text.trim());

  const isStreaming = statusText && (
    statusText.includes('Streaming:') ||
    statusText.toLowerCase().includes('stream')
  );
  const isCompactingStatus = !!(
    statusText
    && !isStreaming
    && looksLikeCompactStatus(statusText)
  );

  const renderAdaptiveText = (text: string, maxWidth?: number): React.ReactNode => {
    const normalized = normalizeStatusText(text);
    if (looksLikeCompactStatus(normalized)) {
      return renderCompactStatus(normalized, maxWidth || 40);
    }
    if (!maxWidth || stringWidth(normalized) <= maxWidth) {
      return renderSweepText(normalized);
    }

    // Truncate and render without animation (to avoid complexity)
    const truncated = truncateText(normalized, maxWidth);
    return <Text color={NeoxTheme.text.secondary}>{truncated}</Text>;
  };

  /* ✦/✧ 是 U+2726/U+2727 四角星 — 比 ◆/◈ 实心 diamond 视觉更精致,
   * 跟 ✻ 状态指示一致, 整体给 "AI / 工程" 调性. Windows 无字体回退到 * (winSymbols). */
  const getRunModeLabel = (): { icon: string; label: string; color: string } => {
    switch (runMode) {
      case 'agentic':
        return { icon: sym('✦'), label: 'Agentic', color: 'cyan' };
      default:
        return { icon: sym('✦'), label: 'Agentic', color: 'cyan' };
    }
  };

  const runModeInfo = getRunModeLabel();

  const streamingToolMatch = statusText?.match(/Streaming:\s*(\w+)/);
  const streamingTool = streamingToolMatch ? streamingToolMatch[1] : null;

  const activeWorkerStat = workerStats.find(s => s.status === 'running')
    || workerStats.find(s => s.status === 'waiting');
  const runningWorkers = workerStats.filter(s => s.status === 'running');
  const activeWorkerStatusText = runningWorkers.length > 1
    ? `${runningWorkers.length} agents running: ${runningWorkers.map(w => `${w.agentLabel}→${w.currentTask || '...'}`).join(', ')}`
    : activeWorkerStat
      ? `${activeWorkerStat.agentLabel}: ${activeWorkerStat.currentTask || (activeWorkerStat.status === 'waiting' ? 'Waiting...' : 'Running...')}`
      : null;

  const renderCompactWorkerStats = (): React.ReactNode => {
    if (workerStats.length === 0) return null;

    return (
      <Box>
        <Text dimColor> │ </Text>
        <Text color="magenta">{workerStats.length}</Text>
        <Text dimColor> workers</Text>
      </Box>
    );
  };

  // 格式：├─ ⠋ @AgentName: activity description…  · 3 tool uses · 4.2K tokens · 12s
  const renderWorkerLine = (stat: AgentContextStats, isLast: boolean): React.ReactNode => {
    const status = stat.status || 'idle';
    const isWorkerRunning = status === 'running';

    /* 角色名用次要色 —— 颜色只表达状态 (spinner/✓/✗), 不再按角色配 青/紫/黄 */
    const roleColor = NeoxTheme.text.secondary;

    // 角色名
    const roleName = stat.workerRole
      ? stat.workerRole.charAt(0).toUpperCase() + stat.workerRole.slice(1)
      // agentLabel 缺失时回落 agentId (跟 ContextMenu 一致) —— 这里一抛异常整个 bottom zone
      // (status/输入框/hint) 全挂, 代价太大, 不值得为一个显示用的字段冒险
      : (stat.agentLabel || stat.agentId || '').replace(/-\d+$/, '');

    const identity = (stat.workerTask || '').replace(/^(调研|探索|任务)[:：]\s*/, '').trim();
    const acting = (stat.currentTask || '').trim();
    const activity = identity && acting && identity !== acting
      ? `${identity} · ${acting}`
      : (identity || acting);

    // 统计
    const toolCount = stat.toolUseCount || 0;
    const totalTokens = stat.input + stat.output;
    const elapsed = stat.elapsedMs ? Math.round(stat.elapsedMs / 1000) : 0;

    // 状态图标
    const statusIcon = isWorkerRunning ? (
      <Spinner type="dots" />
    ) : status === 'waiting' ? (
      <Text color="yellow">◐</Text>
    ) : status === 'completed' ? (
      <Text color="green">{sym('✓')}</Text>
    ) : status === 'error' ? (
      <Text color="red">{sym('✗')}</Text>
    ) : (
      <Text color="gray">○</Text>
    );

    // Stats 拼接
    const statParts: string[] = [];
    if (toolCount > 0) statParts.push(`${toolCount} tool ${toolCount === 1 ? 'use' : 'uses'}`);
    if (totalTokens > 0) statParts.push(`${formatNumber(totalTokens)} tokens`);
    if (elapsed > 0) statParts.push(`${elapsed}s`);
    const statsStr = statParts.join(' · ');

    // 在 flex 挤压不足时也没触发 → 溢出换行。这里直接用 truncateText 严格按宽度压。
    // prefix: "  └─ " (5) + icon (1) + " " (1) + roleName ≈ 5+1+1+stringWidth(roleName)
    const prefixWidth = 5 + 1 + 1 + stringWidth(roleName);
    const availableWidth = Math.max(10, terminalWidth - prefixWidth - 2);
    let tail = '';
    if (activity) tail += `: ${activity}`;
    if (statsStr) tail += `  · ${statsStr}`;
    const tailTruncated = truncateText(tail, availableWidth);

    return (
      <Box key={stat.agentId}>
        <Text dimColor>  {isLast ? '└─ ' : '├─ '}</Text>
        {statusIcon}
        <Text color={toInkColor(roleColor)} bold> {roleName}</Text>
        {tailTruncated ? <Text dimColor>{tailTruncated}</Text> : null}
      </Box>
    );
  };

  const renderResearchLine = (p: ResearchProgress): React.ReactNode => {
    const angles = p.seeds ? `${p.completed}/${Math.max(p.seeds, p.dispatched)} angles` : `${p.completed} done`;
    const parts = [angles];
    if (p.inFlight > 0) parts.push(`${p.inFlight} running`);
    if (p.sources > 0) parts.push(`${p.sources} sources/${p.domains} sites`);
    if (p.claims > 0) parts.push(`${p.claims} claims`);
    if (p.failed > 0) parts.push(`${p.failed} failed`);
    const head = 'Deep research';
    const tail = ` · ${parts.join(' · ')}`;
    const disputedStr = p.disputed > 0 ? ` · ${p.disputed} disputed` : '';
    /* 跟 worker 行同一套宽度算法: prefix "  ◇ " (4) + head */
    const avail = Math.max(10, terminalWidth - 4 - stringWidth(head) - stringWidth(disputedStr) - 2);
    return (
      <Box>
        <Text dimColor>  ◇ </Text>
        <Text color="cyan" bold>{head}</Text>
        <Text dimColor>{truncateText(tail, avail)}</Text>
        {disputedStr ? <Text color="yellow">{disputedStr}</Text> : null}
      </Box>
    );
  };

  const agenticModeHasWorkers = runMode === 'agentic' && workerStats.length > 0;

  const isVeryNarrow = terminalWidth < 100;
  const isExtremelyNarrow = terminalWidth < 80;

  /* 状态文案右边那截计时后缀 "  1m20s · esc to interrupt · ↓ 3.2K tokens" 的**实际**宽度。
   * 按跟下面 JSX 完全一致的条件算 —— 拍常数会让没在计时的时候白占列宽, 状态文案被截成 "Shell running..."。
   * (ctx% / 费用 / in·out 已挪去底栏或 /cost, 这一行不再有右栏。) */
  const metaSuffixWidth = (() => {
    if (!(elapsedTime > 0 && !isVeryNarrow)) return 0;
    let t = `  ${formatElapsedTime()}`;
    if (terminalWidth >= 90) t += ' · esc to interrupt';
    if (displayedTokens > 0 && terminalWidth >= 110) {
      t += ` · ↓ ${formatNumber(Math.floor(displayedTokens))} tokens`;
    }
    return stringWidth(t);
  })();

  /* 左边只有 spinner (2 列) + 空格, 剩下全给状态文案和计时后缀 */
  const statusTextMaxWidth = Math.max(isExtremelyNarrow ? 8 : 12, terminalWidth - 4 - metaSuffixWidth);
  const displayStatusText = normalizeStatusText(statusText || 'Thinking…');

  // 简约版 StatusLine（单 Agent 模式，支持 task-agent worker 行）
  return (
    <Box flexDirection="column" width={terminalWidth}>
      {renderTargetLine()}
      <Box width={terminalWidth} height={1} overflow="hidden">
        {effectiveIsRunning ? (
          <Box height={1} overflow="hidden">
            <VortexSpinner />
            <Text> </Text>
            {isStreaming && streamingTool
              ? renderAdaptiveText(`Streaming: ${streamingTool}`, statusTextMaxWidth)
              : renderAdaptiveText(
                  !isRunning && hasActiveWorkers
                    ? `Sub-agents running... (${workerStats.length})`
                    : displayStatusText,
                  statusTextMaxWidth,
                )}
            {elapsedTime > 0 && !isVeryNarrow && (
              <Text color={NeoxTheme.text.dim}>
                {`  ${formatElapsedTime()}`}
                {terminalWidth >= 90 ? ' · esc to interrupt' : ''}
                {displayedTokens > 0 && terminalWidth >= 110 ? ` · ↓ ${formatNumber(Math.floor(displayedTokens))} tokens` : ''}
              </Text>
            )}
          </Box>
        ) : idleOutcome.symbol === '✗' || idleOutcome.symbol === '⚠' ? (
          <Text color={toInkColor(idleOutcome.color)}>{`${sym(idleOutcome.symbol)} ${idleOutcome.label}`}</Text>
        ) : (tokenStats?.output || 0) > 0 && elapsedTime > 0 ? (
          <Text color={NeoxTheme.text.dim}>{`Done in ${formatElapsedTime()}`}</Text>
        ) : (
          <Text> </Text>
        )}
      </Box>

      {researchProgress && effectiveIsRunning ? renderResearchLine(researchProgress) : null}

      {agenticModeHasWorkers && effectiveIsRunning && (() => {
        const research = workerStats.filter(s => (s.workerRole || '').toLowerCase() === 'research');
        return research.map((stat, i) => renderWorkerLine(stat, i === research.length - 1));
      })()}
    </Box>
  );
};

// StatusLine's internal animation state should NOT trigger App re-render
const areAgentContextStatsEqual = (
  prev: AgentContextStats[] | undefined,
  next: AgentContextStats[] | undefined
): boolean => {
  if (!prev && !next) return true;
  if (!prev || !next) return false;
  if (prev.length !== next.length) return false;
  return prev.every((p, i) => {
    const n = next[i];
    return (
      p.agentId === n.agentId &&
      p.input === n.input &&
      p.output === n.output &&
      p.pressure === n.pressure &&
      p.tokensUsedForContext === n.tokensUsedForContext &&
      p.status === n.status &&
      p.currentTask === n.currentTask &&
      p.contextWindow === n.contextWindow &&
      p.cacheCreationTokens === n.cacheCreationTokens &&
      p.cacheReadTokens === n.cacheReadTokens
    );
  });
};

export const StatusLine = React.memo(StatusLineComponent, (prevProps, nextProps) => {
  // Only re-render if actual props changed, ignore internal state (elapsedTime, highlightPos)
  return (
    prevProps.isRunning === nextProps.isRunning &&
    prevProps.statusText === nextProps.statusText &&
    prevProps.streamingTokens === nextProps.streamingTokens &&
    prevProps.streamingStartTime === nextProps.streamingStartTime &&
    prevProps.tokenStats?.input === nextProps.tokenStats?.input &&
    prevProps.tokenStats?.output === nextProps.tokenStats?.output &&
    prevProps.tokenStats?.total === nextProps.tokenStats?.total &&
    prevProps.tokenStats?.pressure === nextProps.tokenStats?.pressure &&
    prevProps.tokenStats?.cacheCreationTokens === nextProps.tokenStats?.cacheCreationTokens &&
    prevProps.tokenStats?.cacheReadTokens === nextProps.tokenStats?.cacheReadTokens &&
    prevProps.runMode === nextProps.runMode &&
    areAgentContextStatsEqual(prevProps.agentContextStats, nextProps.agentContextStats)
  );
});
