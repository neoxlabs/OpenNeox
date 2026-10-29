import type { TimelineRow } from '../modules/agent-timeline/types';
import type { StepIconKind, StepStatus } from '../modules/agent-timeline/types';
import type { TimelinePanelSummary } from './timelinePanelSummaryStore';

function firstWord(title: string): string {
  const i = title.indexOf(' · ');
  return i > 0 ? title.slice(0, i) : title;
}

function isMessageCell(row: TimelineRow): boolean {
  return row.kind === 'cell' && (row.cell.kind === 'user' || row.cell.kind === 'assistant_text');
}

type ToolLike = {
  title: string;
  desc?: string;
  iconKind: StepIconKind;
  status: StepStatus;
};

function toolLikeFromRow(row: TimelineRow): ToolLike | null {
  if (isMessageCell(row)) return null;
  if (row.kind === 'cell') {
    return {
      title: row.title,
      desc: row.desc,
      iconKind: row.iconKind,
      status: row.status,
    };
  }
  if (row.kind === 'legacy_step') {
    const s = row.step;
    return {
      title: s.title,
      desc: s.desc,
      iconKind: s.iconKind,
      status: s.status,
    };
  }
  return null;
}

/** 从主时间线已 map 的 rows 抽右栏摘要 — O(n) 轻扫描, 无第二次 mapTimeline */
export function buildTimelinePanelSummary(
  sessionId: string,
  rows: TimelineRow[],
): TimelinePanelSummary {
  let total = 0;
  let done = 0;
  let running = 0;
  let pending = 0;
  let failed = 0;
  let runningStep: TimelinePanelSummary['running'] = null;
  const recentTools: TimelinePanelSummary['recentTools'] = [];
  const seen = new Set<string>();

  for (let i = rows.length - 1; i >= 0; i--) {
    const tool = toolLikeFromRow(rows[i]!);
    if (!tool) continue;
    total += 1;
    if (tool.status === 'done') done += 1;
    else if (tool.status === 'running') {
      running += 1;
      if (!runningStep) {
        runningStep = {
          title: tool.title,
          desc: tool.desc,
          iconKind: tool.iconKind,
        };
      }
    } else if (tool.status === 'failed') failed += 1;
    else pending += 1;

    if (recentTools.length < 5) {
      const key = `${tool.iconKind}:${firstWord(tool.title)}`;
      if (!seen.has(key)) {
        seen.add(key);
        recentTools.push({ kind: tool.iconKind, title: firstWord(tool.title) });
      }
    }
  }

  /* 上面倒序扫, total/done 计数是对的; recentTools 已是最新优先 */
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return {
    sessionId,
    running: runningStep,
    recentTools,
    stats: { total, done, running, pending, failed, pct },
  };
}
