/**
 * Jev 预判工具包 —— 本轮开跑前问一次 Jev「这条请求要用到哪些工具包」, 命中的包提前
 * promote 进 liveTools, 省掉模型先调一次 tool_search 的那一整轮 LLM 往返。
 *
 * ## 为什么是「预解锁」而不是「裁工具」
 * 非常驻工具本来就是 deferred 的 (ToolTreeEngine), 固定开销里没有它们。真正贵的是
 * 模型发现手里没有 → tool_search → 下一轮才能用, 每次多一个往返 (几秒)。正则预解锁
 * (浏览器、connector) 已经在做同一件事, Jev 把它推广到全部工具包。
 *
 * ## 前缀缓存
 * 工具定义排在 system 和消息前面, 工具集一变, 后面整段前缀缓存全部失效。而
 * ToolTreeEngine 每轮新建, 上一轮解锁的工具下一轮就没了。如果 Jev 每轮各判各的,
 * 工具集会随消息来回跳, 每轮都打穿缓存。所以:
 *   - 预判结果按会话**只增不减**地记在账上 (JevPreloadLedger);
 *   - 每轮建工具树时先按账上顺序原样 promote; 本轮新判出的包等结果回来再 promote
 *     (不挡首字), 同时入账;
 *   - 恢复 / 续跑 / 无工具轮也照账 promote (不问 Jev), 工具集不因为轮次类型抖动。
 * 这样工具集只在「真出现新需要」时变一次, 跟 tool_search 解锁的代价一样, 之后稳定。
 *
 * ## 门槛
 * 多解锁一个包 = 多几份 schema 常驻本会话, 所以只收把握大的 (noul ≥ 0.8), 每轮最多 3 个包。
 */
import type { ToolPack } from '../../tools/packs/toolPack.js';
import type { JevQuestion, JevResult } from './jevClient.js';

export const PRELOAD_THRESHOLD = 0.8;
/** 第一名没过 0.8, 但 ≥0.7 且领先第二名 0.25 以上也算 —— 对的那个包常落在 0.72–0.79。 */
export const PRELOAD_TOP_THRESHOLD = 0.7;
export const PRELOAD_TOP_MARGIN = 0.25;
export const PRELOAD_MAX_PACKS_PER_TURN = 3;
/** 整个会话预判最多占的工具名额 (ToolTreeEngine.MAX_UNLOCKED=15, 给 tool_search 留 5 个)。 */
export const PRELOAD_MAX_TOOLS = 10;
/** 描述截到 140 字: 27 个包一问 p50 从 1149ms 降到 511ms, 命中率不降。 */
const PACK_DESC_MAX = 140;
const REQUEST_MAX = 6000;

/** 预判命中时解锁的工具名: 包自己声明的入口工具, 没声明就是 tool_search 解锁时给的那批。 */
export function packPreloadNames(pack: ToolPack): string[] {
  return pack.preloadToolNames ?? pack.unlockToolNames ?? pack.toolNames;
}

/**
 * 候选包: 不看本轮模式 (草稿预判时还不知道), 模式外的工具到 namesForPicks 再按 available 滤。
 * 去掉 hidden 层 (只给精确查询) 和一半以上已常驻的包 (search/readfile/shell 那类, 预判了也没东西可解锁,
 * 却会把「改代码」判成 file_ops 白白换掉工具集)。
 */
export function candidatePacks(packs: ToolPack[], alwaysActive: ReadonlySet<string>): ToolPack[] {
  return packs.filter((pack) => {
    if (pack.tier === 'hidden') return false;
    const names = packPreloadNames(pack);
    if (names.length === 0) return false;
    return names.filter((n) => alwaysActive.has(n)).length / names.length < 0.5;
  });
}

function shortDescription(desc: string): string {
  if (desc.length <= PACK_DESC_MAX) return desc;
  const cut = desc.slice(0, PACK_DESC_MAX);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '), cut.lastIndexOf(' — '));
  return `${end > 60 ? cut.slice(0, end) : cut}…`;
}

export function questionId(pack: ToolPack): string {
  return `pack:${pack.id}`;
}

/**
 * 每个包一道 noul。描述用包自己的英文 description —— Jev 英文最准。
 *
 * 问法必须是「这个包是不是干这类活的」、yes 写成「同一种文件 / App / 活动」(12 条中英文请求 ×
 * 28 个包: 11/12 命中、1 个误报)。不能问「要不要用到这个包」: 会把相关包都拉高
 * (跑测试 → quality/execute/terminal 全过线), 10/12 命中、3 个误报。
 * 包写了 useFor 就用它 (browser 用 description 时 12 条没写网址的网页任务只中 6 条, 用 useFor 10 条, 零误报)。
 */
export function buildPackQuestions(packs: ToolPack[]): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  for (const pack of packs) {
    questions[questionId(pack)] = {
      type: 'noul',
      instructions: {
        question: 'Is `tool_pack` the right tool for the task in `request`?',
        tool_pack: `${pack.label} — ${pack.useFor ?? shortDescription(pack.description)}`,
      },
      criteria: {
        yes: 'The task in `request` is exactly the kind of work `tool_pack` is built for (same file type, app or activity)',
        no: 'The task is a different kind of work',
      },
    };
  }
  return questions;
}

export const CHAT_ONLY_QUESTION_ID = 'chat_only';
export const CHAT_ONLY_THRESHOLD = 0.9;

export function buildChatOnlyQuestion(): JevQuestion {
  return {
    type: 'noul',
    instructions: {
      question: 'Can `request` be fully answered by just talking, without reading or changing any files, running commands, browsing or using any tools?',
    },
    criteria: {
      yes: 'Chit-chat, opinions, explanations of general knowledge, translation or writing from text given in the message',
      no: 'Needs to look at the user\'s files/project/computer, run or change something, search the web or fetch live data',
    },
  };
}

/** 判成纯聊天的概率; 没这道题的答案返回 null。 */
export function chatOnlyProbability(result: Pick<JevResult, 'answers'>): number | null {
  const a = result.answers[CHAT_ONLY_QUESTION_ID];
  return a?.type === 'noul' && Number.isFinite(a.noul) ? a.noul : null;
}

export function buildPreloadState(prompt: string): { request: string } {
  return { request: prompt.length > REQUEST_MAX ? prompt.slice(0, REQUEST_MAX) : prompt };
}

export interface PackPick {
  packId: string;
  p: number;
}

/** 过门槛的包 (或明显领先的第一名), 按概率从高到低, 最多 max 个。 */
export function pickPacks(
  result: Pick<JevResult, 'answers'>,
  packs: ToolPack[],
  opts: { threshold?: number; max?: number } = {},
): PackPick[] {
  const threshold = opts.threshold ?? PRELOAD_THRESHOLD;
  const max = opts.max ?? PRELOAD_MAX_PACKS_PER_TURN;
  const scored: PackPick[] = [];
  for (const pack of packs) {
    const a = result.answers[questionId(pack)];
    if (a?.type === 'noul' && Number.isFinite(a.noul)) scored.push({ packId: pack.id, p: a.noul });
  }
  scored.sort((x, y) => y.p - x.p);
  const picks = scored.filter((s) => s.p >= threshold);
  const [first, second] = scored;
  if (picks.length === 0 && first && first.p >= PRELOAD_TOP_THRESHOLD
    && first.p - (second?.p ?? 0) >= PRELOAD_TOP_MARGIN) {
    picks.push(first);
  }
  return picks.slice(0, max);
}

/** 日志用: 概率最高的几个包。 */
export function topScores(result: Pick<JevResult, 'answers'>, n = 5): string[] {
  return Object.entries(result.answers)
    .flatMap(([id, a]) => (a.type === 'noul' && id.startsWith('pack:') ? [[id.replace(/^pack:/, ''), a.noul] as const] : []))
    .sort((x, y) => y[1] - x[1])
    .slice(0, n)
    .map(([id, p]) => `${id}=${p.toFixed(2)}`);
}

/**
 * 选中包 → 要解锁的工具名。整包放不下名额的跳过 (不拆包: 半个包模型拿到也用不顺)。
 * 名额要给 tool_search 留位子 —— ToolTreeEngine.MAX_UNLOCKED 是 15, 预判最多占 10。
 */
export function namesForPicks(
  picks: PackPick[],
  packs: ToolPack[],
  alreadyHave: readonly string[],
  available?: ReadonlySet<string>,
  maxTools = PRELOAD_MAX_TOOLS,
): string[] {
  const byId = new Map(packs.map((p) => [p.id, p]));
  const out: string[] = [];
  for (const pick of picks) {
    const pack = byId.get(pick.packId);
    if (!pack) continue;
    const fresh = packPreloadNames(pack).filter((n) =>
      (!available || available.has(n)) && !alreadyHave.includes(n) && !out.includes(n));
    if (alreadyHave.length + out.length + fresh.length > maxTools) continue;
    out.push(...fresh);
  }
  return out;
}

/**
 * 会话 → 已预解锁的工具名 (按首次解锁顺序)。只增不减, 见文件头「前缀缓存」。
 * 会话数有上限, 按最久没用淘汰; 会话被 host 淘汰时显式 delete。
 */
export class JevPreloadLedger {
  private readonly bySession = new Map<string, string[]>();

  constructor(private readonly maxSessions = 200) {}

  get(sessionId: string): readonly string[] {
    const names = this.bySession.get(sessionId);
    if (!names) return [];
    /* 刷新 LRU 位置 */
    this.bySession.delete(sessionId);
    this.bySession.set(sessionId, names);
    return names;
  }

  /** 追加, 返回真正新加的名字 (保持原有顺序, 新的排在后面)。 */
  add(sessionId: string, names: readonly string[]): string[] {
    const cur = this.bySession.get(sessionId) ?? [];
    const added = names.filter((n, i) => !cur.includes(n) && names.indexOf(n) === i);
    if (added.length === 0) return [];
    this.bySession.delete(sessionId);
    this.bySession.set(sessionId, [...cur, ...added]);
    while (this.bySession.size > this.maxSessions) {
      const oldest = this.bySession.keys().next().value;
      if (oldest === undefined) break;
      this.bySession.delete(oldest);
    }
    return added;
  }

  delete(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
