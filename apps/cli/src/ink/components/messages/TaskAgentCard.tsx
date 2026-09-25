/**
 * TaskAgentCard — 子 agent 的一步。跟时间线其它步骤同一套 "● 标题 / ⎿ 结果" 语法。
 *
 * 单个, 运行中 (只滚动最近 3 个动作, 旧的更暗):
 *   ● Explore(找登录逻辑)  8 tools · 27.7K tokens · 25s
 *     ⎿ Read package.json
 *       Search "config-store|provider"
 *       ⠹ Read public/app.js
 *
 * 单个, 完成 (收成两行, 说它干了什么而不是工具名链):
 *   ● Explore(找登录逻辑)  8 tools · 25s
 *     ⎿ Read 5 files, searched 3 patterns
 *
 * 并行一组 (每个成员一行, 左边是它的身份色):
 *   ● 3 Explore agents  24 tools · 41s
 *     ⎿ ⠹ 找登录逻辑    Read auth.ts        12s
 *       ✓ 查测试覆盖    5 tools              8s
 *       ⠹ 拆步骤        thinking             4s
 *
 * 身份色只用在"这是哪个 agent"上 (成员行的状态符); 圆点仍然只表达状态。
 */
import React from 'react';
import { Box, Text, useStdout } from '../../../../vendor/ink/src/index.js';
import { getLanguage } from '../../../i18n/index.js';
import stringWidth from 'string-width';
import { NeoxTheme } from '../../theme.js';
import { describeGroup, type ToolCategory } from '../../utils/describeTool.js';
import { Step, StepResult } from './step.js';

export interface TaskAgentToolRecord {
  name: string;
  args?: string;
  status: 'running' | 'done' | 'error';
  duration?: number;
  resultHint?: string;
}

export interface TaskAgentGroupMember {
  agentId: string;
  task: string;
  status: 'running' | 'completed' | 'error';
  toolCount: number;
  tokens: number;
  elapsed: number;
  toolRecords?: TaskAgentToolRecord[];
}

export interface TaskAgentCardProps {
  agentId: string;
  role: string;
  task: string;
  status: 'running' | 'completed' | 'error';
  toolCount: number;
  tokens: number;
  elapsed: number;
  toolRecords?: TaskAgentToolRecord[];
  timestamp?: Date;
  sourceLabel?: string;
  groupMembers?: TaskAgentGroupMember[];
}

const formatK = (n: number): string => {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
};

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** running 卡只滚动显示最近 N 个动作 —— 固定高度, 并行几个 agent 也不会把屏幕撑爆 */
const SCROLL_WINDOW = 3;
const GROUP_MEMBER_WINDOW = 5;

/** 成员身份色: 跟品牌色同一明度档, 深浅底都看得清; 按成员顺序循环 */
const IDENTITY_COLORS = ['#8A6CFF', '#3C9BFF', '#2FB39A', '#D9A441', '#D9669A', '#8E9AAF'];
export const identityColor = (i: number): string => IDENTITY_COLORS[i % IDENTITY_COLORS.length]!;

/** 工具名 → 动词 (跟主时间线同一套说法: Read / Search / Glob / List / Edit / Bash) */
function toolVerb(name: string): string {
  const n = name.toLowerCase();
  if (n === 'readfile' || n === 'read' || n === 'read_file' || n === 'smart_read') return 'Read';
  if (n === 'search' || n === 'grep') return 'Search';
  if (n === 'search_files' || n === 'glob' || n === 'find_files') return 'Glob';
  if (n === 'show_tree' || n === 'smart_tree' || n === 'list_directory' || n === 'ls') return 'List';
  if (n === 'edit' || n === 'edit_file' || n === 'file_update') return 'Edit';
  if (n === 'write' || n === 'write_file') return 'Write';
  if (n === 'bash' || n === 'execute_bash' || n === 'command_exec' || n === 'execute_command'
    || n === 'execute_shell' || n === 'shell' || n === 'run_command') return 'Bash';
  if (n === 'web_search' || n === 'websearch') return 'Web Search';
  if (n === 'web_fetch' || n === 'webfetch') return 'Fetch';
  if (n.startsWith('git_')) return 'Git ' + n.slice(4);
  return name;
}

function toolCategory(name: string): ToolCategory {
  const v = toolVerb(name);
  if (v === 'Read') return 'read';
  if (v === 'Search' || v === 'Glob') return 'search';
  if (v === 'List') return 'list';
  if (v === 'Web Search') return 'web';
  if (v === 'Fetch') return 'fetch';
  return 'other';
}

/** 完成态的一句话: "Read 5 files, searched 3 patterns, ran 2 tools" */
function summarizeRecords(records: TaskAgentToolRecord[]): string {
  if (records.length === 0) return '';
  return describeGroup(records.map(r => ({ category: toolCategory(r.name), count: 1 })));
}

const isZh = () => { try { return getLanguage() === 'zh'; } catch { return false; } };

function stats(toolCount: number, tokens: number, elapsed: number, withTokens = true): string {
  const parts: string[] = [];
  if (toolCount > 0) parts.push(isZh() ? `${toolCount} 次工具` : `${toolCount} tool${toolCount === 1 ? '' : 's'}`);
  if (withTokens && tokens > 0) parts.push(`${formatK(tokens)} tokens`);
  if (elapsed > 0) parts.push(`${elapsed}s`);
  return parts.join(' · ');
}

function clipW(s: string, max: number): string {
  if (stringWidth(s) <= max) return s;
  let out = '';
  for (const ch of s) {
    if (stringWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return out + '…';
}

function padW(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - stringWidth(s)));
}

const recordLine = (r: TaskAgentToolRecord): string => {
  const args = r.args ? ' ' + clipW(r.args, 56) : '';
  return `${toolVerb(r.name)}${args}`;
};

export const TaskAgentCard: React.FC<TaskAgentCardProps> = ({
  role,
  task,
  status,
  toolCount,
  tokens,
  elapsed,
  toolRecords = [],
  groupMembers,
}) => {
  const { columns = 80 } = useStdout();
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    if (status !== 'running') return;
    const timer = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 100);
    return () => clearInterval(timer);
  }, [status]);
  const spin = SPINNER_FRAMES[frame]!;
  const tone = status === 'completed' ? 'success' : status === 'error' ? 'error' : 'running';
  const dim = NeoxTheme.text.dim;

  // ==================== 并行一组 ====================
  if (groupMembers && groupMembers.length > 0) {
    const done = status !== 'running';
    const zh = isZh();
    const title = (
      <Text wrap="truncate-end">
        <Text bold>{zh ? `${groupMembers.length} 个 ${role} 子 agent` : `${groupMembers.length} ${role} agents`}</Text>
        {done ? <Text color={NeoxTheme.text.secondary}>{status === 'error' ? (zh ? ' 失败' : ' failed') : (zh ? ' 已完成' : ' finished')}</Text> : null}
        <Text color={dim}>{'  ' + stats(toolCount, tokens, elapsed, !done)}</Text>
      </Text>
    );
    const members = groupMembers.filter(m => m.task || m.toolCount > 0 || m.status !== 'running');
    /* 运行中: 在跑的排前面; 完成后按原顺序 */
    const ordered = done ? members : [...members.filter(m => m.status === 'running'), ...members.filter(m => m.status !== 'running')];
    const shown = ordered.slice(0, GROUP_MEMBER_WINDOW);
    const reserve = done ? 16 : 36;
    const taskCap = Math.max(12, columns - 2 - 3 - 2 - reserve - 6);
    const taskW = Math.min(taskCap, Math.max(10, ...shown.map(m => stringWidth(m.task))));
    const lines: React.ReactNode[] = shown.map((m) => {
      const idx = groupMembers.indexOf(m);
      const icon = m.status === 'completed' ? '✓' : m.status === 'error' ? '✗' : spin;
      const iconColor = m.status === 'completed' ? NeoxTheme.functional.success
        : m.status === 'error' ? NeoxTheme.functional.error : identityColor(idx);
      const last = m.status === 'running' && m.toolRecords?.length ? m.toolRecords[m.toolRecords.length - 1]! : null;
      const doing = m.status === 'running'
        ? (last ? recordLine(last) : (zh ? '思考中' : 'thinking'))
        : stats(m.toolCount, 0, 0);
      return (
        <Text wrap="truncate-end">
          <Text color={iconColor}>{icon} </Text>
          <Text color={NeoxTheme.text.secondary}>{padW(clipW(m.task || m.agentId, taskW), taskW)}</Text>
          <Text color={dim}>{'  ' + clipW(doing, reserve - 2)}</Text>
          {m.elapsed > 0 ? <Text color={dim}>{`  ${m.elapsed}s`}</Text> : null}
        </Text>
      );
    });
    if (ordered.length > shown.length) lines.push(zh ? `… 还有 ${ordered.length - shown.length} 个` : `… +${ordered.length - shown.length} more`);
    return (
      <Step tone={tone} title={title}>
        <StepResult lines={lines} />
      </Step>
    );
  }

  // ==================== 单个 ====================
  const title = (
    <Text wrap="truncate-end">
      <Text bold>{role}</Text>
      {task ? <Text color={NeoxTheme.text.secondary}>{`(${clipW(task, 60)})`}</Text> : null}
      <Text color={dim}>{'  ' + stats(toolCount, tokens, elapsed, status === 'running')}</Text>
    </Text>
  );

  if (status !== 'running') {
    const summary = summarizeRecords(toolRecords);
    return (
      <Step tone={tone} title={title}>
        {summary ? <StepResult lines={[summary]} /> : null}
      </Step>
    );
  }

  /* 运行中: 最近 SCROLL_WINDOW 个动作, 越旧越暗; 正在跑的那个带 spinner、次要色 */
  const FADE = [NeoxTheme.text.dim, NeoxTheme.text.dim, NeoxTheme.text.secondary];
  const visible = toolRecords.slice(-SCROLL_WINDOW);
  const lines: React.ReactNode[] = visible.map((r, i) => {
    const isLast = i === visible.length - 1;
    if (r.status === 'running') {
      return (
        <Text wrap="truncate-end">
          <Text color={NeoxTheme.brand.purple}>{spin} </Text>
          <Text color={NeoxTheme.text.secondary}>{recordLine(r)}</Text>
        </Text>
      );
    }
    const color = r.status === 'error' ? NeoxTheme.functional.error : FADE[FADE.length - visible.length + i] ?? dim;
    return <Text wrap="truncate-end" color={isLast ? NeoxTheme.text.secondary : color}>{recordLine(r)}</Text>;
  });
  return (
    <Step tone={tone} title={title}>
      {lines.length > 0 ? <StepResult lines={lines} /> : <Box marginLeft={3}><Text color={dim}>{`${spin} starting`}</Text></Box>}
    </Step>
  );
};
