/**
 * Life 子系统对外入口 — 只导 types + store 单例访问.
 * 具体实现细节 (schema/rowMapper/transaction) 收在实现文件内, 不对外.
 */

export {
  type LifeEvent,
  type LifeEventCreate,
  type LifeEventKind,
  type LifeEventStatus,
  type LifeEventTransition,
  type OutcomeStatus,
  type ReminderStatus,
  type BriefHintStatus,
  type OutcomePayload,
  type ReminderPayload,
  type BriefHintPayload,
  type ReminderRecurrence,
  type RelatedCard,
  ALLOWED_TRANSITIONS,
  INITIAL_STATUS,
  isAllowedTransition,
  isValidKindStatus,
} from './lifeEventsTypes.js';

export {
  LifeEventsStore,
  getLifeEventsStore,
} from './lifeEventsStore.js';

export {
  computeNextFire,
  parseWhen,
  classifyOverdue,
  OVERDUE_GRACE_MS,
} from './reminderScheduling.js';

export {
  type BriefHintLang,
  type BriefHintParams,
  type BriefHintText,
  renderBriefHint,
  recoverBriefHintParams,
  localizeBriefHint,
} from './briefHintText.js';
