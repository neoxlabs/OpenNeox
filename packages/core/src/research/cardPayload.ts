/**
 * 卡片载荷 —— 为界面提供受预算约束的摘要数据。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 工具结果的 metadata 与 output 一起传输，宿主对 output 有固定预览上限。
 * 卡片只保留能支持下一步决策的摘要，完整报告通过 reportPath 读取；enforceBudget
 * 确保序列化结果始终可解析。
 */

import type { ResearchLedger, ClaimStatus } from './ledger.js';
import type { LedgerStats } from './ledger.js';

/* 单项上限 —— 都按"一眼能看完"定, 不按"塞得下" */
const MAX_DISPUTES = 3;
const MAX_QUOTE_CHARS = 110;
const MAX_CLAIM_CHARS = 90;
const MAX_DOMAINS = 8;
const MAX_UNEXPLORED = 3;
const MAX_UNEXPLORED_CHARS = 60;
/** 整个载荷的字符预算 —— 远低于宿主 12000 的闸, 给 content/summary 留足余量 */
const PAYLOAD_BUDGET = 5200;

const clip = (s: string, n: number): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export interface DisputeCardItem {
  cid: string;
  /** 有分歧的那条结论 */
  text: string;
  support: { sid: string; host: string; quote: string };
  contradict: { sid: string; host: string; quote: string };
  lean?: string;
  /** false = 同一来源内部的自我限定, 不是两家说法不一 (见 ResearchClaim.crossSource) */
  crossSource?: boolean;
}

export interface DeepResearchCardPayload {
  topic: string;
  scale: string;
  stats: LedgerStats;
  stopReason: string;
  dispatched: number;
  leaderModel: string;
  workerModel: string;
  modelKind: string;
  reportPath: string;
  /** 站点名, 用来让人一眼看出"证据是不是都来自同一家" */
  domains: string[];
  /** 有分歧的条目 —— 卡上最该先看到的东西 */
  disputes: DisputeCardItem[];
  /** 排队没查完的 */
  unexplored: string[];
}

export interface BuildCardPayloadInput {
  topic: string;
  scale: string;
  stats: LedgerStats;
  ledger: ResearchLedger;
  stopReason: string;
  dispatched: number;
  leaderModel: string;
  workerModel: string;
  modelKind: string;
  reportPath: string;
  unexplored: string[];
}

/**
 * 超预算就按"最不该占地方的先砍"的顺序削, 而不是整块丢掉。
 *
 * 正常情况下**这个函数不该被触发** —— 上面那几条单项上限已经把载荷压到 2~3K。
 * 它是兜底: 哪天有人放宽了上限、或者加了新字段, 由它保证最坏情况也只是"卡上少几行",
 * 而不是"整张卡消失"。导出是为了能直接测裁剪顺序 (走 buildCardPayload 进不来这里)。
 */
export function enforceBudget(payload: DeepResearchCardPayload): DeepResearchCardPayload {
  const size = () => JSON.stringify(payload).length;
  if (size() <= PAYLOAD_BUDGET) return payload;

  /* 1. 先砍没查完的线索 (信息量最低) */
  payload.unexplored = [];
  if (size() <= PAYLOAD_BUDGET) return payload;

  /* 2. 再砍站点名单 (统计里的 domains 数字还在) */
  payload.domains = [];
  if (size() <= PAYLOAD_BUDGET) return payload;

  /* 3. 最后逐条砍分歧 —— 至少留一条, 因为"有分歧"这件事本身最该被看见 */
  while (payload.disputes.length > 1 && size() > PAYLOAD_BUDGET) {
    payload.disputes.pop();
  }
  /* 还超就把引句再削短 */
  if (size() > PAYLOAD_BUDGET) {
    payload.disputes = payload.disputes.map((d) => ({
      ...d,
      support: { ...d.support, quote: clip(d.support.quote, 60) },
      contradict: { ...d.contradict, quote: clip(d.contradict.quote, 60) },
      lean: d.lean ? clip(d.lean, 60) : undefined,
    }));
  }
  return payload;
}

export function buildCardPayload(input: BuildCardPayloadInput): DeepResearchCardPayload {
  const { ledger } = input;
  const hostOf = (sid: string) => ledger.sources.find((s) => s.sid === sid)?.hostname ?? '';

  const disputes: DisputeCardItem[] = ledger.claims
    .filter((c) => c.status === ('disputed' satisfies ClaimStatus))
    .slice(0, MAX_DISPUTES)
    .map((c) => {
      const sup = c.support[0];
      const con = c.contradict[0];
      return {
        cid: c.cid,
        text: clip(c.text, MAX_CLAIM_CHARS),
        support: { sid: sup?.sid ?? '', host: hostOf(sup?.sid ?? ''), quote: clip(sup?.quote ?? '', MAX_QUOTE_CHARS) },
        contradict: { sid: con?.sid ?? '', host: hostOf(con?.sid ?? ''), quote: clip(con?.quote ?? '', MAX_QUOTE_CHARS) },
        ...(c.crossSource === undefined ? {} : { crossSource: c.crossSource }),
        ...(c.lean ? { lean: clip(c.lean, MAX_QUOTE_CHARS) } : {}),
      };
    });

  const payload: DeepResearchCardPayload = {
    topic: clip(input.topic, 80),
    scale: input.scale,
    stats: input.stats,
    stopReason: input.stopReason,
    dispatched: input.dispatched,
    leaderModel: input.leaderModel,
    workerModel: input.workerModel,
    modelKind: input.modelKind,
    reportPath: input.reportPath,
    domains: [...new Set(ledger.sources.map((s) => s.hostname).filter(Boolean))].slice(0, MAX_DOMAINS),
    disputes,
    unexplored: input.unexplored.slice(0, MAX_UNEXPLORED).map((q) => clip(q, MAX_UNEXPLORED_CHARS)),
  };

  return enforceBudget(payload);
}
