/**
 * Smart Notification Rules Engine — 智能通知规则引擎
 *
 * 事件驱动的通知系统：
 * - 长任务完成 → 桌面通知 + 声音
 * - 错误 → terminal bell
 * - Rate limit 接近 → toast 警告
 * - Budget 超限 → 桌面通知 + 暂停
 *
 * 多 Provider 通用：通过统一的事件接口触发，不依赖特定 provider。
 */

// ==================== Types ====================

export type NotificationEvent =
  | 'task_complete'
  | 'error'
  | 'rate_limit_warning'
  | 'rate_limit_hit'
  | 'budget_warning'
  | 'budget_exceeded'
  | 'idle_timeout'
  | 'model_switch'
  | 'context_pressure';

export type NotificationChannel = 'sound' | 'desktop' | 'toast' | 'bell' | 'none';

export interface NotificationRule {
  id: string;
  event: NotificationEvent;
  channel: NotificationChannel;
  /** Optional condition — return true to fire */
  condition?: (ctx: NotificationContext) => boolean;
  /** Cooldown in ms to prevent spamming */
  cooldownMs: number;
  /** Whether this rule is enabled */
  enabled: boolean;
  /** Human-readable description */
  description: string;
}

export interface NotificationContext {
  /** Task duration in seconds (for task_complete) */
  durationSeconds?: number;
  /** Error message (for error events) */
  errorMessage?: string;
  /** Rate limit usage ratio 0-1 (for rate_limit events) */
  rateLimitUsage?: number;
  /** Budget usage in USD (for budget events) */
  budgetUsedUsd?: number;
  budgetLimitUsd?: number;
  /** Context pressure 0-1 (for context_pressure) */
  contextPressure?: number;
  /** Provider/model info */
  provider?: string;
  model?: string;
}

export interface NotificationPayload {
  title: string;
  body: string;
  channel: NotificationChannel;
  event: NotificationEvent;
  urgency: 'low' | 'normal' | 'high';
}

// ==================== Default Rules ====================

const DEFAULT_RULES: NotificationRule[] = [
  {
    id: 'task_complete_long',
    event: 'task_complete',
    channel: 'desktop',
    condition: (ctx) => (ctx.durationSeconds || 0) > 30,
    cooldownMs: 5_000,
    enabled: true,
    description: '长任务完成（>30s）→ 桌面通知',
  },
  {
    id: 'task_complete_sound',
    event: 'task_complete',
    channel: 'sound',
    condition: (ctx) => (ctx.durationSeconds || 0) > 30,
    cooldownMs: 5_000,
    enabled: true,
    description: '长任务完成（>30s）→ 声音提醒',
  },
  {
    id: 'error_bell',
    event: 'error',
    channel: 'bell',
    cooldownMs: 2_000,
    enabled: true,
    description: '错误 → terminal bell',
  },
  {
    id: 'rate_limit_warning',
    event: 'rate_limit_warning',
    channel: 'toast',
    condition: (ctx) => (ctx.rateLimitUsage || 0) >= 0.8,
    cooldownMs: 60_000,
    enabled: true,
    description: 'Rate limit 接近（≥80%）→ toast 警告',
  },
  {
    id: 'rate_limit_hit',
    event: 'rate_limit_hit',
    channel: 'desktop',
    cooldownMs: 30_000,
    enabled: true,
    description: 'Rate limit 触发 → 桌面通知',
  },
  {
    id: 'budget_warning',
    event: 'budget_warning',
    channel: 'toast',
    cooldownMs: 60_000,
    enabled: true,
    description: 'Budget 接近限额 → toast 警告',
  },
  {
    id: 'budget_exceeded',
    event: 'budget_exceeded',
    channel: 'desktop',
    cooldownMs: 0, // Always fire
    enabled: true,
    description: 'Budget 超限 → 桌面通知',
  },
  {
    id: 'context_pressure_high',
    event: 'context_pressure',
    channel: 'toast',
    condition: (ctx) => (ctx.contextPressure || 0) >= 0.85,
    cooldownMs: 120_000,
    enabled: true,
    description: 'Context 压力高（≥85%）→ toast 警告',
  },
];

// ==================== Engine ====================

type NotificationHandler = (payload: NotificationPayload) => void;

class NotificationRulesEngine {
  private rules: NotificationRule[];
  private lastFired = new Map<string, number>();
  private handlers = new Map<NotificationChannel, NotificationHandler>();
  private globalEnabled = true;

  constructor(rules?: NotificationRule[]) {
    this.rules = rules || [...DEFAULT_RULES];
  }

  /** Register a handler for a notification channel */
  registerHandler(channel: NotificationChannel, handler: NotificationHandler): void {
    this.handlers.set(channel, handler);
  }

  /** Enable/disable all notifications */
  setEnabled(enabled: boolean): void {
    this.globalEnabled = enabled;
  }

  isEnabled(): boolean {
    return this.globalEnabled;
  }

  /** Fire an event — matching rules will trigger notifications */
  fire(event: NotificationEvent, context: NotificationContext = {}): NotificationPayload[] {
    if (!this.globalEnabled) return [];

    const now = Date.now();
    const fired: NotificationPayload[] = [];

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.event !== event) continue;

      // Cooldown check
      const lastTime = this.lastFired.get(rule.id) || 0;
      if (rule.cooldownMs > 0 && (now - lastTime) < rule.cooldownMs) continue;

      // Condition check
      if (rule.condition && !rule.condition(context)) continue;

      // Build payload
      const payload = buildPayload(event, context, rule.channel);
      fired.push(payload);

      // Execute handler
      const handler = this.handlers.get(rule.channel);
      if (handler) {
        try {
          handler(payload);
        } catch {
          // Non-fatal
        }
      }

      this.lastFired.set(rule.id, now);
    }

    return fired;
  }

  /** Add a custom rule */
  addRule(rule: NotificationRule): void {
    // Replace if same id exists
    this.rules = this.rules.filter(r => r.id !== rule.id);
    this.rules.push(rule);
  }

  /** Remove a rule by id */
  removeRule(id: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter(r => r.id !== id);
    return this.rules.length < before;
  }

  /** Enable/disable a specific rule */
  setRuleEnabled(id: string, enabled: boolean): void {
    const rule = this.rules.find(r => r.id === id);
    if (rule) rule.enabled = enabled;
  }

  /** Get all rules */
  getRules(): readonly NotificationRule[] {
    return this.rules;
  }

  /** Reset to default rules */
  resetToDefaults(): void {
    this.rules = [...DEFAULT_RULES];
    this.lastFired.clear();
  }
}

// ==================== Payload Builder ====================

function buildPayload(
  event: NotificationEvent,
  ctx: NotificationContext,
  channel: NotificationChannel,
): NotificationPayload {
  switch (event) {
    case 'task_complete':
      return {
        title: 'Task Complete',
        body: ctx.durationSeconds
          ? `Task completed in ${ctx.durationSeconds}s`
          : 'Task completed',
        channel,
        event,
        urgency: 'normal',
      };
    case 'error':
      return {
        title: 'Error',
        body: ctx.errorMessage || 'An error occurred',
        channel,
        event,
        urgency: 'high',
      };
    case 'rate_limit_warning':
      return {
        title: 'Rate Limit Warning',
        body: `Usage at ${Math.round((ctx.rateLimitUsage || 0) * 100)}%`,
        channel,
        event,
        urgency: 'normal',
      };
    case 'rate_limit_hit':
      return {
        title: 'Rate Limited',
        body: `Rate limit reached${ctx.provider ? ` for ${ctx.provider}` : ''}`,
        channel,
        event,
        urgency: 'high',
      };
    case 'budget_warning':
      return {
        title: 'Budget Warning',
        body: ctx.budgetUsedUsd && ctx.budgetLimitUsd
          ? `$${ctx.budgetUsedUsd.toFixed(2)} / $${ctx.budgetLimitUsd.toFixed(2)}`
          : 'Approaching budget limit',
        channel,
        event,
        urgency: 'normal',
      };
    case 'budget_exceeded':
      return {
        title: 'Budget Exceeded',
        body: `Session budget exceeded${ctx.budgetUsedUsd ? ` ($${ctx.budgetUsedUsd.toFixed(2)})` : ''}`,
        channel,
        event,
        urgency: 'high',
      };
    case 'context_pressure':
      return {
        title: 'Context Pressure High',
        body: `Context at ${Math.round((ctx.contextPressure || 0) * 100)}%. Consider compacting.`,
        channel,
        event,
        urgency: 'normal',
      };
    case 'idle_timeout':
      return {
        title: 'Session Idle',
        body: 'Session has been idle for a while',
        channel,
        event,
        urgency: 'low',
      };
    case 'model_switch':
      return {
        title: 'Model Switched',
        body: ctx.model ? `Switched to ${ctx.model}` : 'Model changed',
        channel,
        event,
        urgency: 'low',
      };
    default:
      return {
        title: 'Notification',
        body: String(event),
        channel,
        event,
        urgency: 'low',
      };
  }
}

// ==================== Singleton ====================

let globalEngine: NotificationRulesEngine | null = null;

export function getGlobalNotificationEngine(): NotificationRulesEngine {
  if (!globalEngine) {
    globalEngine = new NotificationRulesEngine();
  }
  return globalEngine;
}

export function initGlobalNotificationEngine(rules?: NotificationRule[]): NotificationRulesEngine {
  globalEngine = new NotificationRulesEngine(rules);
  return globalEngine;
}

export { NotificationRulesEngine };
