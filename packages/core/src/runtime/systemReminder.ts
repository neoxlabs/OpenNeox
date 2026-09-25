/**
 * System Reminder — 每轮 `<system-reminder>` 注入通道
 *
 * 设计目标:
 *
 *   把"运行时动态指令"通过 `<system-reminder>` 标签**注入到消息流** (user message 前),
 *   而不是改 system prompt. 这样:
 *     1. system prompt prefix cache 保持热 — 任何动态状态变化都不破 cache
 *     2. 位置靠近当前输入, 模型会把 reminder 当成本轮的强指令读
 *     3. 一轮 only — consume 后即失效 (oneshot) 或按 ttl 倒数 (persistent)
 *
 * 用途举例:
 *   - plan mode 切换 / 解除      pushSystemReminder(sess, '现在是 plan mode...', { oneshot:true, priority:'critical' })
 *   - 当前 active surface         pushSystemReminder(sess, '用户正在看 doc surface "X"', { ttl: 1 })
 *   - 紧急 override               pushSystemReminder(sess, '用户刚 ask_user 中断, 不要继续旧任务', { priority:'critical', oneshot:true })
 *   - 重试反思 push (runner)      pushSystemReminder(sess, '第 3 次重试前必须写一句反思...', { oneshot:true })
 *
 * 接入侧 (后续 PR):
 *   - agenticRuntime 在 LLM 调用前调 consumeSystemReminders(sessionId), 把返回的 reminder
 *     用 formatRemindersForMessage 序列化, prepend 到当前 user message 前
 *   - mode 切换 / ask_user 中断 / runner failure 探测时调 pushSystemReminder
 *
 * 本模块设计原则:
 *   - 不依赖 sessionId 类型 — scope 是 string, 调用方决定怎么 key (sess id / 'global' / 自定义)
 *   - 不依赖具体 message 模式 — 只输出格式化字符串, 注入由调用方做
 *   - 同 scope 多次 push 累积; consume 按 priority + 注册顺序输出, oneshot 消费后清, ttl 倒数
 *
 * NOT 在本模块管的事:
 *   - 持久化跨进程的 reminder (这是 in-memory only). 跨 process 用 IPC / persistent store
 *   - 模型对 reminder 的实际服从行为 — 那是 prompt design 责任, 见 universal-constraints 等
 *   - 自动检测什么时候该 push — 由调用方业务逻辑决定
 */

// ============================================================================
// 类型
// ============================================================================

export type SystemReminderPriority = 'critical' | 'normal';

export interface SystemReminderOptions {
  /**
   * 紧急程度. 'critical' 在 consume 输出时排在 'normal' 之前.
   * 默认 'normal'.
   */
  priority?: SystemReminderPriority;
  /**
   * 是否一次性: 消费后即从队列删除. 默认 false (持续注入直到显式 clear 或 ttl 到期).
   */
  oneshot?: boolean;
  /**
   * 存活轮数 (turn). undefined = 不过期 (除非 oneshot).
   * 每次 consumeSystemReminders 算一轮, ttl 倒数. 倒到 0 后下次 consume 不再输出.
   *
   * 典型用法: ttl=3 注入"当前 active surface", 三轮后自然清掉.
   */
  ttl?: number;
  /**
   * 调试用标签 — 标识 reminder 来源 (如 'plan-mode-toggle' / 'ask-user-interrupt'),
   * 便于日志排查. 不影响输出内容.
   */
  source?: string;
}

/**
 * Reminder 实例 — consumeSystemReminders / peekSystemReminders 返回的对象.
 *
 * 注: content / priority / source 是不可变的, ttl 是 mutable 倒数计数.
 */
export interface SystemReminder {
  readonly id: number;
  readonly content: string;
  readonly priority: SystemReminderPriority;
  readonly oneshot: boolean;
  readonly ttl?: number;
  readonly source?: string;
  readonly pushedAtNs: bigint;
}

// ============================================================================
// 内部状态
// ============================================================================

/* scope (任意 string, 通常是 sessionId) → reminder 队列. 进程内 in-memory. */
const REMINDERS = new Map<string, SystemReminder[]>();
let NEXT_ID = 1;

// ============================================================================
// API
// ============================================================================

/**
 * 推入一个 system reminder 到 scope 的队列尾部.
 *
 * - content 会被 trim. 空字符串 → no-op (不入队).
 * - 同 scope 多次 push 累积; consume 时按 priority + push 顺序 (id 升序) 输出.
 * - 同 scope 中可以有多个 reminder, **不去重** — 同样内容 push 两次会输出两次.
 *
 * @returns reminder id (调用方可用于精确撤销, 见 removeSystemReminderById)
 */
export function pushSystemReminder(
  scope: string,
  content: string,
  options?: SystemReminderOptions,
): number {
  const trimmed = content.trim();
  if (!trimmed) return 0;
  if (!scope) throw new Error('pushSystemReminder: scope is required');

  const id = NEXT_ID++;
  const reminder: SystemReminder = {
    id,
    content: trimmed,
    priority: options?.priority ?? 'normal',
    oneshot: options?.oneshot ?? false,
    ttl: options?.ttl,
    source: options?.source,
    pushedAtNs: process.hrtime.bigint(),
  };

  const list = REMINDERS.get(scope);
  if (list) {
    list.push(reminder);
  } else {
    REMINDERS.set(scope, [reminder]);
  }
  return id;
}

/**
 * 消费一个 scope 的所有 reminder.
 *
 * 行为:
 *   1. 返回当前队列的 reminder 列表, **按 priority (critical 在前) + id 升序排** (排序输出, 不改内部 storage 顺序)
 *   2. 内部 storage:
 *      - oneshot reminder 从队列删除
 *      - ttl !== undefined 的: ttl=ttl-1; ttl<=0 删除
 *      - 其他 (普通持久 reminder) 保留
 *   3. scope 队列空了就删 scope key
 *
 * 注意: 调用方拿到的列表是**排序后的副本**, 不应该 mutate. 多次 consume 同 scope 在同一轮
 * 内是危险的 (会让 ttl 倒数两次), 调用方自己保证单轮单次 consume.
 */
export function consumeSystemReminders(scope: string): SystemReminder[] {
  const list = REMINDERS.get(scope);
  if (!list || list.length === 0) return [];

  /* 输出: 排序副本 */
  const output = list.slice().sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority === 'critical' ? -1 : 1;
    }
    return a.id - b.id;
  });

  /* 内部清理: oneshot 删, ttl 倒数 */
  const remaining: SystemReminder[] = [];
  for (const r of list) {
    if (r.oneshot) continue;
    if (r.ttl !== undefined) {
      if (r.ttl <= 1) continue;
      /* SystemReminder 是 readonly, 但内部存储需要更新 ttl. 用 spread 重建. */
      remaining.push({ ...r, ttl: r.ttl - 1 });
    } else {
      remaining.push(r);
    }
  }

  if (remaining.length === 0) {
    REMINDERS.delete(scope);
  } else {
    REMINDERS.set(scope, remaining);
  }

  return output;
}

/**
 * 查看 scope 当前的 reminder, 不消费. 调试 / 测试用.
 * 返回副本, 但 reminder 对象本身是 frozen-ish (readonly fields).
 */
export function peekSystemReminders(scope: string): SystemReminder[] {
  const list = REMINDERS.get(scope);
  if (!list) return [];
  return list.slice();
}

/**
 * 按 id 删除一个 reminder. 通常用于"撤销之前 push 的 plan-mode reminder".
 * @returns true 如果找到并删除, false 没找到.
 */
export function removeSystemReminderById(scope: string, id: number): boolean {
  const list = REMINDERS.get(scope);
  if (!list) return false;
  const idx = list.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  if (list.length === 0) REMINDERS.delete(scope);
  return true;
}

/**
 * 清空 scope (或全部, 不传 scope) 的 reminder.
 *
 * 用途: 用户 /clear 或 session 结束 → clearSystemReminders(sessionId).
 */
export function clearSystemReminders(scope?: string): void {
  if (!scope) {
    REMINDERS.clear();
    return;
  }
  REMINDERS.delete(scope);
}

/**
 * 把 reminder 列表格式化成可注入到消息流的字符串.
 *
 * 输出形式:
 * ```
 * <system-reminder>
 * [authoritative directive · must follow even if it overrides normal behavior]
 * <content 1>
 * </system-reminder>
 *
 * <system-reminder>
 * [authoritative directive · must follow even if it overrides normal behavior]
 * <content 2>
 * </system-reminder>
 * ```
 *
 * 多个 reminder 用 \n\n 分隔. 空列表返 null (调用方据此决定不注入).
 *
 * 设计参考: Claude Code `<system-reminder>` + Kimi `<system-reminder>` MUST follow tag.
 * 模型被指示 (在 universal-constraints / general-assistant 里): 这是 authoritative,
 * 可压倒 system prompt 中的常规规则.
 */
export function formatRemindersForMessage(reminders: SystemReminder[]): string | null {
  if (!reminders || reminders.length === 0) return null;

  const parts = reminders.map((r) => {
    return [
      '<system-reminder>',
      '[authoritative directive · must follow even if it overrides normal behavior]',
      r.content,
      '</system-reminder>',
    ].join('\n');
  });

  return parts.join('\n\n');
}

/**
 * 调试用: 返回所有 scope 的 reminder 统计.
 */
export function getReminderDebugInfo(): Array<{
  scope: string;
  count: number;
  ids: number[];
  priorities: SystemReminderPriority[];
}> {
  const result: Array<{
    scope: string;
    count: number;
    ids: number[];
    priorities: SystemReminderPriority[];
  }> = [];
  for (const [scope, list] of REMINDERS.entries()) {
    result.push({
      scope,
      count: list.length,
      ids: list.map((r) => r.id),
      priorities: list.map((r) => r.priority),
    });
  }
  return result;
}

/**
 * 仅供测试: 完全重置.
 */
export function __resetSystemRemindersForTests(): void {
  REMINDERS.clear();
  NEXT_ID = 1;
}
