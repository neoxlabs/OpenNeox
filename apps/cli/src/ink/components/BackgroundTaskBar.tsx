import React, { useState, useEffect } from 'react';
import { Box, Text, useStdout } from '../../../vendor/ink/src/index.js';
import Spinner from 'ink-spinner';
import { NeoxTheme } from '../theme.js';

export interface BackgroundTask {
  id: number;
  command: string;
  pid: number;
  status: 'running' | 'done' | 'error' | 'killed';
  startTime: number;
  exitCode?: number;
  output: string[];  // last N lines
  expanded?: boolean;
}

export interface BackgroundTaskBarProps {
  tasks: BackgroundTask[];
  selectedIndex: number;
  onKill?: (id: number) => void;
  onToggleExpand?: (id: number) => void;
  /** 折叠态 (未聚焦): 只显示一行计数摘要, 不展开每个任务。Tab 聚焦后展开为可导航列表。 */
  collapsed?: boolean;
}

const BackgroundTaskBarComponent: React.FC<BackgroundTaskBarProps> = ({
  tasks,
  selectedIndex,
  onKill,
  onToggleExpand,
  collapsed = false,
}) => {
  const { columns: terminalWidth = 80 } = useStdout();

  // Elapsed time ticking for running tasks
  const [now, setNow] = useState(Date.now());
  const hasRunning = tasks.some(t => t.status === 'running');

  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  if (tasks.length === 0) return null;

  const formatElapsed = (startTime: number): string => {
    const seconds = Math.floor((now - startTime) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m${s}s`;
  };

  const truncateCmd = (cmd: string, max: number): string => {
    if (cmd.length <= max) return cmd;
    return cmd.slice(0, max - 3) + '...';
  };

  // Max command width adapts to terminal
  const cmdMaxWidth = Math.max(20, terminalWidth - 45);

  const renderTask = (task: BackgroundTask, index: number): React.ReactNode => {
    const isSelected = index === selectedIndex;

    /* 颜色只在状态符号上; 选中 = 品牌色 › + 命令加粗 (不再铺 #3A3A5C 底色、写死白字 —— 浅色终端看不见) */
    const statusIcon = task.status === 'running' ? (
      <Text color={NeoxTheme.brand.purple}><Spinner type="dots" /></Text>
    ) : task.status === 'done' ? (
      <Text color={NeoxTheme.functional.success}>✓</Text>
    ) : task.status === 'error' ? (
      <Text color={NeoxTheme.functional.error}>✗</Text>
    ) : (
      <Text color={NeoxTheme.functional.warning}>⊘</Text>
    );

    const statusColor = task.status === 'error' ? NeoxTheme.functional.error : NeoxTheme.text.dim;
    const statusLabel = task.status === 'done'
      ? (task.exitCode ? `退出 ${task.exitCode}` : '完成')
      : task.status === 'running' ? '运行中' : task.status === 'error' ? '失败' : '已结束';

    return (
      <Box key={task.id} flexDirection="column">
        <Box>
          <Text color={NeoxTheme.brand.purple}>{isSelected ? '› ' : '  '}</Text>
          {statusIcon}
          <Text color={NeoxTheme.text.dim}> #{task.id}  </Text>
          <Text color={isSelected ? NeoxTheme.text.primary : NeoxTheme.text.secondary} bold={isSelected}>
            {truncateCmd(task.command, cmdMaxWidth)}
          </Text>
          <Text color={statusColor}>{`  ${statusLabel}`}</Text>
          <Text color={NeoxTheme.text.dim}>{`  ${formatElapsed(task.startTime)}`}</Text>
        </Box>
        {/* Expanded output preview */}
        {task.expanded && task.output.length > 0 && (
          <Box flexDirection="column" marginLeft={6}>
            {task.output.slice(-5).map((line, i) => (
              <Text key={i} dimColor>{line}</Text>
            ))}
          </Box>
        )}
      </Box>
    );
  };

  // 折叠态只显示一行计数摘要，避免后台任务持续占用终端空间。
  if (collapsed) {
    const running = tasks.filter(t => t.status === 'running').length;
    const errored = tasks.filter(t => t.status === 'error').length;
    return (
      <Box marginTop={0}>
        <Text color={NeoxTheme.text.secondary}>Background</Text>
        <Text color={NeoxTheme.text.dim}>{` · ${tasks.length} task${tasks.length === 1 ? '' : 's'}`}</Text>
        {running > 0 && (<><Text color={NeoxTheme.text.dim}> · </Text><Text color={NeoxTheme.brand.purple}><Spinner type="dots" /></Text><Text color={NeoxTheme.text.dim}>{` ${running} running`}</Text></>)}
        {errored > 0 && <Text color={NeoxTheme.functional.error}>{` · ${errored} failed`}</Text>}
        <Text color={NeoxTheme.text.dim}>  · tab 展开</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={0}>
      <Box>
        <Text bold>后台命令</Text>
        <Text color={NeoxTheme.text.dim}>{` · ${tasks.length} 个  ·  ↑↓ 选择 · ↵ 看输出 · del 结束 · esc 收起`}</Text>
      </Box>
      {tasks.map((task, i) => renderTask(task, i))}
    </Box>
  );
};

export const BackgroundTaskBar = React.memo(BackgroundTaskBarComponent);
