/**
 * BackgroundAgentBar — 后台 agent 可导航面板 (输入框下方的内联浮层, 不走 alt-screen)。
 *
 *   折叠 (未聚焦): 不渲染 (底部 HintLine 已有 "● N background agents running" 计数)。
 *   聚焦 (Tab): 列出每个后台 agent 一行摘要; ↑↓ 选择; 选中那个在其下展开"最近 N 条工具记录"。
 *
 *    严格限高防残影:
 *     · 最多显示 AGENT_WINDOW 个 agent (超出折叠 "↑ M more")
 *     · 只有"选中"那个展开工具记录, 且只显最近 TOOL_WINDOW 条 (超出 "+K more")
 *     · 因此整个面板高度 ≈ AGENT_WINDOW + TOOL_WINDOW + 表头 ≈ 固定十几行, 永不超屏。
 */
import React from 'react';
import { Box, Text } from '../../../vendor/ink/src/index.js';
import Spinner from 'ink-spinner';
import { NeoxTheme } from '../theme.js';
import type { SidebarAgent } from './AgentBar.js';

const AGENT_WINDOW = 6;  // 最多列几个 agent
const TOOL_WINDOW = 6;   // 选中 agent 最多展开几条工具记录

export interface BackgroundAgentBarProps {
  agents: SidebarAgent[];
  /** 聚焦态 (Tab 进来) 才展开列表; 否则不渲染 (计数在 HintLine) */
  focused: boolean;
  /** 选中的 agent 下标 (聚焦态有效) */
  selectedIndex: number;
}

function toolVerb(name: string): string {
  const n = (name || '').toLowerCase();
  if (n.includes('read')) return 'Read';
  if (n === 'search' || n === 'grep') return 'Grep';
  if (n.includes('search_files') || n === 'glob' || n.includes('find')) return 'Find';
  if (n.includes('edit') || n.includes('update')) return 'Edit';
  if (n.includes('write')) return 'Write';
  if (n.includes('shell') || n.includes('bash') || n.includes('command') || n.includes('run')) return 'Run';
  if (n.includes('tree') || n.includes('list') || n === 'ls') return 'List';
  return name;
}

const BackgroundAgentBarComponent: React.FC<BackgroundAgentBarProps> = ({ agents, focused, selectedIndex }) => {
  const running = agents.filter(a => a.status === 'running');
  if (!focused || running.length === 0) return null;

  const sel = Math.max(0, Math.min(selectedIndex, running.length - 1));
  const shown = running.slice(0, AGENT_WINDOW);
  const hiddenAgents = running.length - shown.length;

  const dim = NeoxTheme.text.dim;
  return (
    <Box flexDirection="column" marginTop={0}>
      <Box>
        <Text bold>子 agent</Text>
        <Text color={dim}>{` · ${running.length} 个运行中  ·  ↑↓ 选择 · esc 收起`}</Text>
      </Box>
      {hiddenAgents > 0 && <Text color={dim}>{`  ↑ 还有 ${hiddenAgents} 个`}</Text>}
      {shown.map((a, i) => {
        const isSel = i === sel;
        const task = (a.task || '').length > 48 ? a.task.slice(0, 47) + '…' : (a.task || '');
        const stats = [a.toolCount > 0 ? `${a.toolCount} 次工具` : '', a.elapsed > 0 ? `${a.elapsed}s` : '']
          .filter(Boolean).join(' · ');
        const records = a.toolRecords ?? [];
        const tail = records.slice(-TOOL_WINDOW);
        const hiddenTools = records.length - tail.length;
        return (
          <Box key={a.id} flexDirection="column">
            <Box>
              <Text color={NeoxTheme.brand.purple}>{isSel ? '› ' : '  '}</Text>
              <Text color={NeoxTheme.brand.purple}><Spinner type="dots" /></Text>
              <Text bold={isSel} color={isSel ? undefined : NeoxTheme.text.secondary}>{` ${a.role || a.id}`}</Text>
              {task ? <Text color={dim}>{`  ${task}`}</Text> : null}
              {stats ? <Text color={dim}>{`  · ${stats}`}</Text> : null}
            </Box>
            {/* 只展开"选中"那个的工具记录 — 严格限高 */}
            {isSel && tail.length > 0 && (
              <Box flexDirection="column" marginLeft={5}>
                {hiddenTools > 0 && <Text color={dim}>{`… 前面还有 ${hiddenTools} 条`}</Text>}
                {tail.map((r, j) => {
                  const icon = r.status === 'running' ? '·' : r.status === 'error' ? '✗' : '✓';
                  const iconColor = r.status === 'error' ? NeoxTheme.functional.error : r.status === 'running' ? NeoxTheme.brand.purple : NeoxTheme.functional.success;
                  const arg = r.args ? (r.args.length > 60 ? r.args.slice(0, 59) + '…' : r.args) : '';
                  return (
                    <Text key={j} wrap="truncate-end">
                      <Text color={iconColor}>{icon} </Text>
                      <Text color={NeoxTheme.text.secondary}>{toolVerb(r.name)}</Text>
                      {arg ? <Text color={dim}>{` ${arg}`}</Text> : null}
                    </Text>
                  );
                })}
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
};

export const BackgroundAgentBar = React.memo(BackgroundAgentBarComponent);
