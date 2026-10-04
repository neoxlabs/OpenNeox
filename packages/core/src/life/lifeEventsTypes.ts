/**
 * Life Events — 状态机与类型定义
 *
 * 三种 kind 共享一张表: outcome / reminder / brief_hint
 *   - outcome    (agent 帮用户办完的事沉淀卡)
 *   - reminder   (定时/循环提醒)
 *   - brief_hint (Daily Brief 首屏候选素材)
 *
 * 状态迁移显式声明 (见 ALLOWED_TRANSITIONS) — Store 层强制校验,
 * 非法迁移直接抛错. 所有迁移写入 life_event_transitions 审计表.
 */

import type { BriefHintParams } from './briefHintText.js';

export type LifeEventKind = 'outcome' | 'reminder' | 'brief_hint';

/** outcome 状态机 */
export type OutcomeStatus = 'pending' | 'done' | 'dismissed' | 'archived';

/** reminder 状态机 (scheduled → fired → done | dismissed).
 * 精简: 无 snoozed 状态 —— snooze = update(scheduledAt = 新时间), status 保持 scheduled.
 * 循环 (weekly/daily) = fired→done 后 JobRunner 立刻建新一条 scheduled event, 不循环旧 event. */
export type ReminderStatus = 'scheduled' | 'fired' | 'done' | 'dismissed';

/** brief_hint 状态机 (系统内部, 用户看不到) */
export type BriefHintStatus = 'candidate' | 'surfaced' | 'clicked' | 'dismissed' | 'expired';

export type LifeEventStatus = OutcomeStatus | ReminderStatus | BriefHintStatus;

/**
 * 状态迁移白名单 — 唯一权威.
 *   - 空数组 = 终态 (不能再迁出);
 *   - Store.transition() 严格按此表校验, 非法迁移抛错;
 *   - 加/改状态在这里改, 其它地方零耦合.
 */
export const ALLOWED_TRANSITIONS: Record<LifeEventKind, Record<string, string[]>> = {
  outcome: {
    pending:   ['done', 'dismissed'],
    done:      ['archived'],
    dismissed: [],
    archived:  [],
  },
  reminder: {
    scheduled: ['fired', 'dismissed'],
    fired:     ['done', 'dismissed'],
    done:      [],
    dismissed: [],
  },
  brief_hint: {
    candidate: ['surfaced', 'expired'],
    surfaced:  ['clicked', 'dismissed', 'expired'],
    clicked:   [],
    dismissed: [],
    expired:   [],
  },
};

/** kind 首次创建时的默认状态 */
export const INITIAL_STATUS: Record<LifeEventKind, LifeEventStatus> = {
  outcome:    'pending',
  reminder:   'scheduled',
  brief_hint: 'candidate',
};

/** kind + status 校验 (非法组合直接拒) */
export function isValidKindStatus(kind: LifeEventKind, status: string): boolean {
  return status in ALLOWED_TRANSITIONS[kind];
}

/** 状态迁移合法性 (Store.transition 使用) */
export function isAllowedTransition(kind: LifeEventKind, from: string, to: string): boolean {
  const nexts = ALLOWED_TRANSITIONS[kind]?.[from];
  return Array.isArray(nexts) && nexts.includes(to);
}

/** 关联富卡快照 (outcome 收藏 news/booking/recipe 时用) */
export interface RelatedCard {
  kind: string;          // 'news' | 'booking' | 'recipe' | 'restaurant' | 'weather' | 'todo' | 'compare'
  snapshot: unknown;     // 原始 JSON payload (用户点开时按 kind 重新渲染)
  emittedAt: number;
}

/** reminder 循环规则 */
export interface ReminderRecurrence {
  /** 'once' | 'daily' | 'weekly' | 'monthly' | 'cron' */
  kind: 'once' | 'daily' | 'weekly' | 'monthly' | 'cron';
  /** cron 表达式 (kind='cron' 时用), 或 weekly 时 [0-6] 星期几数组 */
  spec?: string | number[];
  /** 结束时间 (ms). undefined = 永不结束. */
  endsAt?: number;
}

/** payload_json 里按 kind 分派 */
export interface OutcomePayload {
  /** 用户后续可执行的 action, 展示在 outcome 卡底部 */
  next_actions?: Array<{ label: string; hint?: string }>;
}
export interface ReminderPayload {
  recurrence?: ReminderRecurrence;
  /** 触发时给 agent 的上下文 prompt hint */
  context?: string;
}
export interface BriefHintPayload {
  /** 产出这条提示的规则 id (lifeBackgroundAgent RULES) — 展示侧据此重渲文案 */
  ruleId?: string;
  /** 规则的插值参数 (只有数据没有文案) — 见 briefHintText.ts.
   *   起新写入的 hint 都带; 之前的老数据靠 recoverBriefHintParams 反解. */
  i18nParams?: BriefHintParams;
  /** 用户点击卡片时填进 composer 的 prompt */
  suggestedPrompt?: string;
  /** 触发时机: 'morning' | 'evening' | 'weekend' | 'always' */
  timeWindow?: string;
  /** 命中 profile 的哪个偏好 */
  profileMatch?: string;
}

/** Life Event 主体 (库里存的 row 反序列化) */
export interface LifeEvent {
  id: string;
  kind: LifeEventKind;
  status: LifeEventStatus;
  sessionId: string | null;
  title: string;
  summary: string | null;
  payload: OutcomePayload | ReminderPayload | BriefHintPayload | null;
  relatedCards: RelatedCard[];
  /** 用户/agent 打的标签, 用于长期聚合 (e.g. "妈妈"/"台北游"/"健康"). 大小写敏感, 建议 lowercase. */
  tags: string[];
  scheduledAt: number | null;
  firedAt: number | null;
  doneAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 创建 event 的输入 (id/status/timestamps 由 store 填) */
export interface LifeEventCreate {
  kind: LifeEventKind;
  sessionId?: string | null;
  title: string;
  summary?: string;
  payload?: LifeEvent['payload'];
  relatedCards?: RelatedCard[];
  tags?: string[];
  scheduledAt?: number | null;
}

/** 状态迁移审计条目 */
export interface LifeEventTransition {
  id: number;
  eventId: string;
  fromStatus: string | null;
  toStatus: string;
  timestamp: number;
  reason: string | null;
}
