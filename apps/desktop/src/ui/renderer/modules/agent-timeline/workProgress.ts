import type { Row, RowStep } from './timelineRows';
import {
  isThinkingRow,
  rowHasActive,
  rowStepContentTypeHint,
  rowStepIsAskWaiting,
  rowStepIsBlocked,
  rowStepIsCompaction,
  rowStepIsDestructiveOp,
  rowStepIsPlan,
  rowStepIsRichCard,
  rowStepIsTargetContinue,
  rowStepIsTurnSummary,
  rowStepStartedAtMs,
  rowStepStatus,
  rowStepTitle,
} from './timelineRows';
import { isPlainInternalTitle } from './workPlainPresentation';

export type WorkLineState = 'done' | 'now' | 'warn';

export interface WorkLine {
  /** 动作 (「做一页幻灯片」「上网查」) */
  verb: string;
  /** 对象们 (「封面」「必带装备」), 已去重 */
  objs: string[];
  count: number;
  state: WorkLineState;
}

export type WorkArtKind = 'slides' | 'doc' | 'sheet' | 'image' | 'web' | 'life' | 'none';

export interface WorkProgress {
  lines: WorkLine[];
  /** 不出行的: 思考次数 / 内部步骤次数 */
  thinkCount: number;
  internalCount: number;
  /** 正在想 (没有工具在跑, 但最后一步是还没完的思考) */
  thinkingNow: boolean;
  art: WorkArtKind;
  /** 成品名 (演示稿标题 / 文件名), 推不出来为空 */
  name: string;
  /** 最早一步的开始时间 */
  startedAtMs?: number;
  /** 合并前的真实步数 (折叠头「N 步」用) */
  stepCount: number;
}

/* ── 哪些行留在卡外 ─────────────────────────────────────────────── */
/** 自带结果或自带进度的内容: 出的图、子 Agent / 团队 / 外部 Agent 卡、深度调研卡 —— 收进卡里就看不见了 */
const OWN_CARD_CONTENT = new Set(['image', 'delegation', 'worker', 'external_agent', 'deep_research', 'dag']);
function contentTypeOf(s: RowStep): string | undefined {
  const legacy = (s as { legacyContent?: { type?: string } }).legacyContent?.type;
  return legacy ?? rowStepContentTypeHint(s);
}
function stepStaysOut(s: RowStep): boolean {
  const st = rowStepStatus(s);
  const ct = contentTypeOf(s);
  return (!!ct && OWN_CARD_CONTENT.has(ct))
    || rowStepIsRichCard(s) || rowStepIsAskWaiting(s) || rowStepIsBlocked(s) || rowStepIsDestructiveOp(s)
    || rowStepIsTurnSummary(s) || rowStepIsCompaction(s) || rowStepIsTargetContinue(s)
    || st === 'awaiting';
}

/** 这一行要不要收进进度卡。message 一律不收; 一组里有一个要留在外面, 整组留外面。 */
export function rowGoesIntoCard(r: Row): boolean {
  if (r.kind === 'single') return !stepStaysOut(r.step);
  if (r.kind === 'group' || r.kind === 'cluster') return !r.items.some(stepStaysOut);
  if (r.kind === 'activity') return r.rows.every(rowGoesIntoCard);
  return false;
}

/* ── 标题 → 动作 + 对象 ──────────────────────────────────────────
 * plainWorkTitle 的写法是 `动作「对象」`; 没翻过的旧标题是 `动作 · 对象`。 */
export function splitPlainTitle(title: string): { verb: string; obj: string } {
  const t = title.trim();
  const q = /^(.*?)「(.+)」$/.exec(t);
  if (q) return { verb: q[1]!.trim(), obj: q[2]!.trim() };
  const en = /^(.*?) "(.+)"$/.exec(t);
  if (en) return { verb: en[1]!.trim(), obj: en[2]!.trim() };
  const sep = t.indexOf(' · ');
  if (sep > 0) return { verb: t.slice(0, sep).trim(), obj: t.slice(sep + 3).trim() };
  return { verb: t, obj: '' };
}

function flatSteps(rows: readonly Row[], out: Array<{ step: RowStep; thinking: boolean }>): void {
  for (const r of rows) {
    if (r.kind === 'single') out.push({ step: r.step, thinking: isThinkingRow(r) });
    else if (r.kind === 'group' || r.kind === 'cluster') r.items.forEach((s) => out.push({ step: s, thinking: false }));
    else if (r.kind === 'activity' || r.kind === 'turn_fold') flatSteps(r.rows, out);
  }
}

/* 头部图标按这一轮出现过的动作挑, 排在前面的优先: 做了文档又查了资料, 头上是文档 (成品) 不是放大镜 */
const ART_RULES: Array<[RegExp, WorkArtKind]> = [
  [/演示稿|幻灯片|slides?|版式|layout/i, 'slides'],
  [/表格|spreadsheet/i, 'sheet'],
  [/文档|PDF|读文件|document/i, 'doc'],
  [/画图|视频|image|video/i, 'image'],
  [/上网|网页|调研|资料库|search|research|page|browser/i, 'web'],
  [/日程|提醒|定时|联系人|消息|手机|地图|天气|calendar|reminder|schedule|message|phone|map|weather/i, 'life'],
];
const artRank = (k: WorkArtKind): number => {
  const i = ART_RULES.findIndex(([, kind]) => kind === k);
  return i < 0 ? ART_RULES.length : i;
};
/** 成品名从这些动作的对象里取 (开始做演示稿「X」/ 新建表格「X」/ 新建文档「X」/ 写好「X.docx」) */
const NAME_VERBS = /^(开始做演示稿|新建表格|新建文档|生成演示稿|保存表格|保存文档|Start the slides|Create spreadsheet|Create document)$/;

export function buildWorkProgress(rows: readonly Row[]): WorkProgress {
  const steps: Array<{ step: RowStep; thinking: boolean }> = [];
  flatSteps(rows, steps);
  const lines: WorkLine[] = [];
  let thinkCount = 0;
  let internalCount = 0;
  let thinkingNow = false;
  let art: WorkArtKind = 'none';
  let name = '';
  let startedAtMs: number | undefined;
  let stepCount = 0;

  for (const { step, thinking } of steps) {
    if (rowStepIsPlan(step)) continue;
    const st = rowStepStatus(step);
    const live = st === 'running' || st === 'pending';
    const t0 = rowStepStartedAtMs(step);
    if (typeof t0 === 'number' && t0 > 0 && (startedAtMs === undefined || t0 < startedAtMs)) startedAtMs = t0;
    if (thinking) {
      thinkCount += 1;
      thinkingNow = live;
      continue;
    }
    const title = rowStepTitle(step);
    if (!title.trim()) continue;
    if (isPlainInternalTitle(title)) {
      internalCount += 1;
      thinkingNow = false;
      continue;
    }
    thinkingNow = false;
    stepCount += 1;
    const { verb, obj } = splitPlainTitle(title);
    const stepArt = ART_RULES.find(([re]) => re.test(verb))?.[1] ?? 'none';
    if (artRank(stepArt) < artRank(art)) art = stepArt;
    if (!name && obj && NAME_VERBS.test(verb)) name = obj;
    const state: WorkLineState = st === 'failed' ? 'warn' : live ? 'now' : 'done';
    const prev = lines[lines.length - 1];
    /* 连着的同一动作合一行; 正在跑的那一下单独成行 (它要扫光, 前面做完的是绿勾) */
    if (prev && prev.verb === verb && prev.state === 'done' && state === 'done') {
      prev.count += 1;
      if (obj && !prev.objs.includes(obj)) prev.objs.push(obj);
    } else {
      lines.push({ verb, objs: obj ? [obj] : [], count: 1, state });
    }
  }
  return { lines, thinkCount, internalCount, thinkingNow, art, name, startedAtMs, stepCount };
}

/**
 * Work 正在跑的这一轮: 把卡里的行换成一行 work_progress。
 * 只动最后一个用户消息之后、还没折起来的那段; 跑完 (没有 turn_fold 且不在跑) 原样返回。
 */
export function withWorkProgressCard(rows: Row[], streaming: boolean): Row[] {
  let u = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === 'turn_fold' || r.kind === 'work_progress') return rows;
    if (r.kind === 'message' && r.message.role === 'user') { u = i; break; }
  }
  if (u < 0) return rows;
  const tail = rows.slice(u + 1);
  if (!streaming && !tail.some(rowHasActive)) return rows;
  const inCard: Row[] = [];
  const before: Row[] = [];
  const after: Row[] = [];
  for (const r of tail) {
    if (rowGoesIntoCard(r)) inCard.push(r);
    else (inCard.length === 0 ? before : after).push(r);
  }
  if (inCard.length === 0) return rows;
  const userRow = rows[u] as Extract<Row, { kind: 'message' }>;
  return [
    ...rows.slice(0, u + 1),
    ...before,
    {
      kind: 'work_progress',
      id: `workprogress-${userRow.message.id}`,
      rows: inCard,
      ask: (userRow.message.text ?? '').replace(/\s+/g, ' ').trim(),
    },
    ...after,
  ];
}
