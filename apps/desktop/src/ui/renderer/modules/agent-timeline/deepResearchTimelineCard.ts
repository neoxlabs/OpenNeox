
import type { StepContent } from './types';

/** 卡上要显示的东西 —— 跟 neox-core 的 research/cardPayload.ts 是同一份形状。
 *  那边负责**控量**(整段 metadata 超 12000 字符会被宿主截断, 截断的 JSON parse 不出来,
 *  整张卡就静默消失), 这边只负责读。 */
interface DisputeItem {
  cid: string;
  text: string;
  support: { sid: string; host: string; quote: string };
  contradict: { sid: string; host: string; quote: string };
  lean?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function readDisputes(raw: unknown): DisputeItem[] {
  if (!Array.isArray(raw)) return [];
  const out: DisputeItem[] = [];
  for (const item of raw) {
    const d = (item ?? {}) as Record<string, unknown>;
    const sup = (d.support ?? {}) as Record<string, unknown>;
    const con = (d.contradict ?? {}) as Record<string, unknown>;
    const text = str(d.text);
    if (!text) continue;
    out.push({
      cid: str(d.cid),
      text,
      support: { sid: str(sup.sid), host: str(sup.host), quote: str(sup.quote) },
      contradict: { sid: str(con.sid), host: str(con.host), quote: str(con.quote) },
      ...(typeof d.crossSource === 'boolean' ? { crossSource: d.crossSource } : {}),
      ...(str(d.lean) ? { lean: str(d.lean) } : {}),
    });
  }
  return out;
}

export function deepResearchToolTitle(
  toolKey: string,
  args: Record<string, unknown> | undefined,
  isZh: boolean,
): string | undefined {
  if (toolKey.toLowerCase() !== 'deep_research') return undefined;
  const head = isZh ? '深度调研' : 'Deep research';
  const topic = str(args?.topic).trim();
  if (!topic) return head;
  const clipped = topic.length > 60 ? `${topic.slice(0, 59)}…` : topic;
  return `${head} · ${clipped}`;
}

export function deepResearchLiveContent(entry: unknown): StepContent | undefined {
  const e = (entry ?? {}) as Record<string, unknown>;
  const phase = e.deepResearchPhase;
  if (phase !== 'running' && phase !== 'done') return undefined;

  const settled = e.pending === false;
  const interrupted = phase === 'running' && settled;

  const stats = (e.deepResearchStats ?? {}) as Record<string, unknown>;
  const rawWorkers = Array.isArray(e.deepResearchWorkers) ? e.deepResearchWorkers : [];
  const workers = rawWorkers.map((w) => {
    const r = (w ?? {}) as Record<string, unknown>;
    const status = str(r.status);
    return {
      id: str(r.id),
      question: str(r.question),
      status: (status === 'running' || status === 'done' || status === 'failed' ? status : 'queued') as
        'queued' | 'running' | 'done' | 'failed',
      ...(str(r.summary) ? { summary: str(r.summary) } : {}),
      ...(num(r.toolCount) ? { toolCount: num(r.toolCount) } : {}),
      ...(num(r.tokens) ? { tokens: num(r.tokens) } : {}),
      ...(str(r.currentTool) ? { currentTool: str(r.currentTool) } : {}),
    };
  });

  return {
    type: 'deep_research',
    phase: phase === 'done' || settled ? 'done' : 'running',
    ...(interrupted ? { interrupted: true } : {}),
    topic: str(e.deepResearchTopic),
    scale: str(e.deepResearchScale),
    startedAt: num(e.deepResearchStartedAt) || undefined,
    /* 中断时这是用户唯一的去处 —— 报告是随手增量落盘的, 盘上一定有一份 */
    ...(str(e.deepResearchReportPath) ? { reportPath: str(e.deepResearchReportPath) } : {}),
    dispatched: num(stats.dispatched),
    workers,
    totalTokens: workers.reduce((sum, w) => sum + (w.tokens || 0), 0),
    stats: {
      sources: num(stats.sources),
      domains: num(stats.domains),
      claims: num(stats.claims),
      singleSource: num(stats.singleSource),
      disputed: num(stats.disputed),
    },
    domains: [],
    disputes: [],
    unexplored: [],
  };
}

export function deepResearchCardContent(
  metadata: Record<string, unknown> | undefined,
  _isZh: boolean,
): StepContent | undefined {
  const md = (metadata ?? {}).deep_research as Record<string, unknown> | undefined;
  if (!md) return undefined;

  const stats = (md.stats ?? {}) as Record<string, unknown>;
  const claims = num(stats.claims);
  const sources = num(stats.sources);

  if (claims === 0 && sources === 0) return undefined;

  return {
    type: 'deep_research',
    phase: 'done',
    topic: str(md.topic),
    scale: str(md.scale),
    stopReason: str(md.stopReason),
    dispatched: num(md.dispatched),
    leaderModel: str(md.leaderModel),
    workerModel: str(md.workerModel),
    modelKind: str(md.modelKind),
    reportPath: str(md.reportPath),
    stats: {
      sources,
      domains: num(stats.domains),
      claims,
      supported: num(stats.supported),
      singleSource: num(stats.singleSource),
      disputed: num(stats.disputed),
      unverified: num(stats.unverified),
      archivedChars: num(stats.archivedChars),
    },
    domains: Array.isArray(md.domains) ? md.domains.filter((d): d is string => typeof d === 'string') : [],
    disputes: readDisputes(md.disputes),
    unexplored: Array.isArray(md.unexplored) ? md.unexplored.filter((d): d is string => typeof d === 'string') : [],
  };
}
