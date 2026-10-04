import React from 'react';
import { Box, Text, useStdout } from '../../../vendor/ink/src/index.js';
import stringWidth from 'string-width';
import type { AgentContextStats } from '@neoxlabs/kernel/types/agent.js';
import { NeoxTheme } from '../theme.js';
import { useContextUsage, type ContextCategories } from '../contextUsageStore.js';
import { getLanguage } from '../../i18n/index.js';

export interface ContextMenuProps {
  contextWindow: number;
  tokensUsed: number;
  systemTokens?: number;
  userTokens?: number;
  assistantTokens?: number;
  toolCallTokens?: number;
  toolResultTokens?: number;
  compactionThreshold?: number;
  compressionMode?: 'sync' | 'async';
  agentContextStats?: AgentContextStats[];
  runMode?: 'agentic';
  onClose: () => void;
}

const formatK = (n: number): string => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.max(0, Math.round(n)));
};
const pctOf = (v: number, total: number): string => {
  if (total <= 0) return '';
  const p = (v / total) * 100;
  if (p > 0 && p < 0.1) return '<0.1%';
  return p >= 10 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`;
};
const padW = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - stringWidth(s)));

const hexToRgb = (h: string) => (h.replace('#', '').match(/\w\w/g) || ['0', '0', '0']).map(x => parseInt(x, 16));
const rgbToHex = (c: number[]) => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
function gradientAt(t: number): string {
  const g = NeoxTheme.logoGradient;
  const x = Math.max(0, Math.min(1, t)) * (g.length - 1);
  const i = Math.min(g.length - 2, Math.floor(x));
  const a = hexToRgb(g[i]!), b = hexToRgb(g[i + 1]!);
  return rgbToHex(a.map((v, k) => v + (b[k]! - v) * (x - i)));
}

const GRID_COLS = 20;
const GRID_ROWS = 5;   // 20 × 5 = 100 格, 一格 1%

type Seg = { key: string; label: string; value: number; color: string };

function segmentsFor(cat: ContextCategories | undefined, used: number, zh: boolean): Seg[] {
  if (!cat) return [{ key: 'used', label: zh ? '已用' : 'Used', value: used, color: gradientAt(0.2) }];
  return [
    { key: 'sys', label: zh ? '系统提示词' : 'System prompt', value: cat.systemPrompt, color: gradientAt(0) },
    { key: 'tools', label: zh ? '工具定义' : 'Tool definitions', value: cat.toolDefinitions, color: gradientAt(0.35) },
    { key: 'user', label: zh ? '你的消息' : 'Your messages', value: cat.user, color: NeoxTheme.functional.success },
    { key: 'asst', label: zh ? '模型回复' : 'Replies', value: cat.assistant, color: gradientAt(1) },
    { key: 'call', label: zh ? '工具调用' : 'Tool calls', value: cat.toolCalls, color: NeoxTheme.functional.warning },
    { key: 'result', label: zh ? '工具结果' : 'Tool results', value: cat.toolResults, color: gradientAt(0.7) },
  ].filter(s => s.value > 0);
}

/** 100 格: 每个分类按占比分格 (有内容至少 1 格), 其余是空闲; 压缩阈值之后的空格画成预留 */
function buildCells(segs: Seg[], window: number, threshold: number): Array<{ color: string; ch: string }> {
  const total = GRID_COLS * GRID_ROWS;
  const cells: Array<{ color: string; ch: string }> = [];
  for (const s of segs) {
    const n = Math.max(1, Math.round((s.value / window) * total));
    for (let i = 0; i < n && cells.length < total; i++) cells.push({ color: s.color, ch: '█' });
  }
  const bufferStart = Math.round(threshold * total);
  while (cells.length < total) {
    cells.push(cells.length >= bufferStart
      ? { color: NeoxTheme.text.dim, ch: '░' }
      : { color: NeoxTheme.border.primary, ch: '█' });
  }
  return cells;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  contextWindow,
  tokensUsed,
  compactionThreshold = 0.8,
  agentContextStats = [],
}) => {
  const { columns = 80 } = useStdout();
  const usage = useContextUsage();
  let zh = true;
  try { zh = getLanguage() === 'zh'; } catch { /* */ }
  const dim = NeoxTheme.text.dim;
  const sec = NeoxTheme.text.secondary;
  const close = zh ? 'Esc 关闭' : 'Esc to close';
  const title = zh ? '上下文' : 'Context';

  if (!contextWindow) {
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1} paddingX={2}>
        <Box width={Math.min(60, columns - 4)} justifyContent="space-between">
          <Text bold>{title}</Text>
          <Text color={dim}>{close}</Text>
        </Box>
        <Text color={dim}>{zh ? '还没有用量数据 —— 发一条消息后再看' : 'No usage yet — send a message first'}</Text>
      </Box>
    );
  }

  /* 总量以状态行那份为准 (压缩后会刷新); 分类取最近一轮 */
  const used = tokensUsed || usage?.contextTokens || 0;
  const pressure = used / contextWindow;
  const pctColor = pressure > compactionThreshold ? NeoxTheme.functional.error : pressure > 0.6 ? NeoxTheme.functional.warning : sec;
  const segs = segmentsFor(usage?.categories, used, zh);
  const cells = buildCells(segs, contextWindow, compactionThreshold);
  const free = Math.max(0, Math.floor(contextWindow * compactionThreshold) - used);
  const buffer = Math.max(0, contextWindow - Math.max(used, Math.floor(contextWindow * compactionThreshold)));

  const gridW = GRID_COLS * 2 - 1;
  const legendW = 38;
  const sideBySide = columns - 4 >= gridW + 4 + legendW;
  const panelW = sideBySide ? gridW + 4 + legendW : Math.max(gridW, Math.min(legendW, columns - 4));

  const LabelRow: React.FC<{ swatch: React.ReactNode; label: string; value: number; note?: string }> = ({ swatch, label, value, note }) => (
    <Text>
      {swatch}
      <Text color={sec}>{' ' + padW(label, zh ? 11 : 17)}</Text>
      <Text>{formatK(value).padStart(7)}</Text>
      <Text color={dim}>{'  ' + (note ?? pctOf(value, contextWindow))}</Text>
    </Text>
  );

  const legend = (
    <Box flexDirection="column">
      {segs.map(s => <LabelRow key={s.key} swatch={<Text color={s.color}>█</Text>} label={s.label} value={s.value} />)}
      <LabelRow swatch={<Text color={NeoxTheme.border.primary}>█</Text>} label={zh ? '空闲' : 'Free'} value={free} />
      <LabelRow swatch={<Text color={dim}>░</Text>} label={zh ? '压缩预留' : 'Compact buffer'} value={buffer}
        note={zh ? `到 ${Math.round(compactionThreshold * 100)}% 自动压缩` : `auto-compact at ${Math.round(compactionThreshold * 100)}%`} />
    </Box>
  );

  const grid = (
    <Box flexDirection="column" flexShrink={0}>
      {Array.from({ length: GRID_ROWS }, (_, r) => (
        <Text key={r}>
          {cells.slice(r * GRID_COLS, (r + 1) * GRID_COLS).map((c, i) => (
            <Text key={i} color={c.color}>{c.ch + (i < GRID_COLS - 1 ? ' ' : '')}</Text>
          ))}
        </Text>
      ))}
    </Box>
  );

  /* 本轮: 输入 (没命中缓存的部分) · 缓存命中 (占比) · 写入缓存 · 输出 */
  const turn = usage && usage.contextTokens > 0 ? (
    <Text>
      <Text color={sec}>{zh ? '本轮  ' : 'Last turn  '}</Text>
      <Text>{`${zh ? '输入' : 'input'} ${formatK(usage.input)}`}</Text>
      <Text color={dim}>{' · '}</Text>
      <Text>{`${zh ? '缓存命中' : 'cache hit'} ${formatK(usage.cacheRead)}`}</Text>
      <Text color={dim}>{` (${pctOf(usage.cacheRead, usage.contextTokens) || '0%'})`}</Text>
      <Text color={dim}>{' · '}</Text>
      <Text>{`${zh ? '写入缓存' : 'cache write'} ${formatK(usage.cacheWrite)}`}</Text>
      <Text color={dim}>{' · '}</Text>
      <Text>{`${zh ? '输出' : 'output'} ${formatK(usage.output)}`}</Text>
    </Text>
  ) : null;

  const workers = agentContextStats.filter(s => s.agentId !== 'Main' && (s.tokensUsedForContext || 0) > 0);

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} paddingX={2}>
      <Box width={panelW} justifyContent="space-between">
        <Text>
          <Text bold>{title}</Text>
          <Text>{'  ' + formatK(used)}</Text>
          <Text color={dim}>{` / ${formatK(contextWindow)} · `}</Text>
          <Text color={pctColor}>{`${Math.round(pressure * 100)}%`}</Text>
        </Text>
        <Text color={dim}>{close}</Text>
      </Box>
      <Box marginTop={1} flexDirection={sideBySide ? 'row' : 'column'}>
        {grid}
        <Box marginLeft={sideBySide ? 4 : 0} marginTop={sideBySide ? 0 : 1}>{legend}</Box>
      </Box>
      {turn ? <Box marginTop={1}>{turn}</Box> : null}
      {!usage?.categories ? (
        <Text color={dim}>{zh ? '分类在下一轮回答后出现' : 'Breakdown appears after the next reply'}</Text>
      ) : null}
      {workers.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={sec}>{zh ? '子 agent' : 'Sub-agents'}</Text>
          {workers.map(s => {
            const win = s.contextWindow || 0;
            const p = win > 0 ? Math.round(((s.tokensUsedForContext || 0) / win) * 100) : 0;
            return (
              <Text key={s.agentId}>
                <Text color={sec}>{padW((s.agentLabel || s.agentId).slice(0, 16), 18)}</Text>
                <Text>{formatK(s.tokensUsedForContext || 0).padStart(7)}</Text>
                <Text color={dim}>{`  ${p}%`}</Text>
              </Text>
            );
          })}
        </Box>
      )}
    </Box>
  );
};
