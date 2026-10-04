import React from 'react';
import { Box, Text, useStdout } from '../../../vendor/ink/src/index.js';
import stringWidth from 'string-width';
import { NeoxTheme } from '../theme.js';
import { getGlobalCostTracker } from '@neoxlabs/platform/platform/costTracker.js';
import { formatCost } from '@neoxlabs/platform/platform/modelPricingTable.js';
import { t, formatMessage, getLanguage } from '../../i18n/index.js';
import type { SidebarAgent } from './AgentBar.js';

export interface HintLineProps {
  isRunning: boolean;
  hasInput: boolean;
  customHints?: string;
  menuActive?: boolean;
  thinkingEnabled?: boolean;
  accumulatedRunTime?: number;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  runMode?: 'agentic';
  hasBgTasks?: boolean;
  /** 后台命令: 运行中 / 失败 的个数 (合进左侧那句后台活动) */
  bgRunning?: number;
  bgFailed?: number;
  /** 当前工作目录（显示在左侧） */
  workDir?: string;
  /** 运行中的任务 Agents */
  sidebarAgents?: SidebarAgent[];
  timelineDensity?: 'full' | 'medium' | 'compact';
  /** 上下文占用 0..1; 没有窗口信息时不传 */
  contextPressure?: number;
}

export function shortenPath(fullPath: string, maxLen: number): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const p = home && fullPath.startsWith(home) ? '~' + fullPath.slice(home.length) : fullPath;
  if (stringWidth(p) <= maxLen) return p;
  const parts = p.split('/').filter(Boolean);
  const head = p.startsWith('~') ? '~/…/' : '…/';
  for (let keep = Math.min(3, parts.length - 1); keep >= 1; keep--) {
    const cand = head + parts.slice(-keep).join('/');
    if (stringWidth(cand) <= maxLen) return cand;
  }
  const last = parts[parts.length - 1] || p;
  return '…' + last.slice(-(Math.max(3, maxLen - 1)));
}

export const HintLine: React.FC<HintLineProps> = ({
  customHints,
  menuActive = false,
  thinkingEnabled = true,
  provider,
  model,
  reasoningEffort,
  hasBgTasks = false,
  bgRunning = 0,
  bgFailed = 0,
  workDir,
  sidebarAgents = [],
  contextPressure,
}) => {
  const { columns: ctxCols = 80 } = useStdout();
  let termCols = (typeof ctxCols === 'number' && ctxCols > 0) ? ctxCols : 80;
  try {
    const so: any = process.stdout;
    if (so && so.isTTY && typeof so.columns === 'number' && so.columns > 0) termCols = so.columns;
  } catch { /* noop */ }

  const dim = NeoxTheme.text.dim;

  if (customHints) {
    return <Box><Text color={NeoxTheme.functional.warning}>{customHints}</Text></Box>;
  }
  if (menuActive) return null;

  const SEP = ' · ';
  type Seg = { key: string; order: number; weight: number; text: string; color?: string };
  const segs: Seg[] = [];

  if (model) {
    const shortModel = model.length > 35 ? model.substring(0, 32) + '…' : model;
    segs.push({ key: 'model', order: 0, weight: 99, text: shortModel, color: NeoxTheme.text.secondary });
  }
  if (reasoningEffort) segs.push({ key: 'effort', order: 1, weight: 5, text: reasoningEffort, color: dim });
  if (!thinkingEnabled) segs.push({ key: 'think', order: 2, weight: 3, text: 'thinking off', color: dim });
  if (typeof contextPressure === 'number' && contextPressure > 0) {
    const pct = Math.round(contextPressure * 100);
    const color = contextPressure > 0.8 ? NeoxTheme.functional.error
      : contextPressure > 0.6 ? NeoxTheme.functional.warning : dim;
    segs.push({ key: 'ctx', order: 3, weight: 6, text: `ctx ${pct}%`, color });
  }
  {
    const cost = getGlobalCostTracker().getSnapshot().totalCostUsd;
    if (cost > 0.0001) segs.push({ key: 'cost', order: 4, weight: 2, text: formatCost(cost), color: dim });
  }
  /* provider 只在很宽时带上 (去掉协议后缀) —— 模型名已经够用 */
  if (provider) {
    let p = provider;
    const paren = p.indexOf(' (');
    if (paren > 0) p = p.substring(0, paren);
    segs.push({ key: 'provider', order: -1, weight: 1, text: p, color: dim });
  }

  // ---- 左侧: 目录 (+ 后台 agent) ----
  const leftCap = Math.max(8, Math.floor(termCols * (termCols < 70 ? 0.3 : 0.4)));
  const pathText = workDir ? shortenPath(workDir, leftCap) : '';
  const running = sidebarAgents.filter(a => a.status === 'running');
  void hasBgTasks; void t; void formatMessage;
  const zh = (() => { try { return getLanguage() === 'zh'; } catch { return false; } })();
  const bits: string[] = [];
  if (running.length > 0) bits.push(zh ? `${running.length} 个子 agent` : `${running.length} agent${running.length === 1 ? '' : 's'}`);
  if (bgRunning > 0) bits.push(zh ? `${bgRunning} 个后台命令` : `${bgRunning} shell${bgRunning === 1 ? '' : 's'}`);
  if (bgFailed > 0) bits.push(zh ? `${bgFailed} 个失败` : `${bgFailed} failed`);
  let agentsText = '';
  if (bits.length > 0) {
    agentsText = termCols >= 80
      ? `● ${bits.join(' · ')}${zh ? ' · tab 查看' : ' · tab to view'}`
      : `● ${running.length + bgRunning}`;
  }
  const leftW = stringWidth(pathText) + (agentsText ? stringWidth(SEP + agentsText) : 0);

  // ---- 右侧按权重试装 ----
  const budget = Math.max(8, termCols - leftW - 2);
  const byWeight = [...segs].sort((a, b) => b.weight - a.weight);
  const kept: Seg[] = [];
  let used = 0;
  for (const s of byWeight) {
    const w = stringWidth(s.text) + (kept.length > 0 ? SEP.length : 0);
    if (used + w <= budget || s.key === 'model') { kept.push(s); used += w; }
  }
  kept.sort((a, b) => a.order - b.order);

  return (
    <Box justifyContent="space-between">
      <Box>
        <Text color={dim}>{pathText}</Text>
        {agentsText ? <Text color={NeoxTheme.brand.purple}>{SEP + agentsText}</Text> : null}
      </Box>
      <Box>
        {kept.map((s, i) => (
          <React.Fragment key={s.key}>
            {i > 0 ? <Text color={dim}>{SEP}</Text> : null}
            <Text color={s.color}>{s.text}</Text>
          </React.Fragment>
        ))}
      </Box>
    </Box>
  );
};
