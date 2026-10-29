/**
 * Stdin Scheduler - 管理 stdin 的 raw mode 状态
 *
 * 解决的问题：
 * 1. 多个组件同时需要 stdin（InputLine、SelectMenu）
 * 2. 组件 cleanup 时调用 setRawMode(false) 会 pause stdin
 * 3. Raw mode 禁用复制粘贴功能
 *
 * 方案：
 * - 智能切换：只在真正需要输入时启用 raw mode
 * - 引用计数：track 有多少组件需要 stdin
 * - 优雅降级：支持复制粘贴时自动切换模式
 *
 * ⚠️ 架构不变式: 本文件诊断输出**只能**用 dlog (process.stderr.write 直写).
 *   不能用 console.*, 因为会被 patch-console (REPL 命令输出 capture) 偷走,
 *   导致 [STDIN_SCHEDULER] 行混进 /usage 等命令的输出卡片. 同 cliLogger.ts 不变式.
 */

/** infra 诊断输出 — 仅 CLI_DEBUG=1 时写 stderr, 绕过 console.* (防被 capture 偷). */
function dlog(msg: string, extra?: unknown): void {
  if (process.env.CLI_DEBUG !== '1') return;
  let tail = '';
  if (extra !== undefined) {
    try { tail = ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra, null, 0)); }
    catch { tail = ' [unserializable]'; }
  }
  process.stderr.write(msg + tail + '\n');
}

export interface StdinConsumer {
  id: string;
  needsRawMode: boolean; // 是否需要 raw mode
  active: boolean;       // 是否激活状态
}

export class StdinScheduler {
  private consumers = new Map<string, StdinConsumer>();
  private rawModeEnabled = false;
  private stdin: NodeJS.ReadStream & { setRawMode(mode: boolean): void };

  constructor(stdin: NodeJS.ReadStream & { setRawMode(mode: boolean): void }) {
    this.stdin = stdin;
  }

  /**
   * 注册一个 stdin 消费者
   */
  register(id: string, needsRawMode: boolean): void {
    this.consumers.set(id, {
      id,
      needsRawMode,
      active: false,
    });
    dlog(`[STDIN_SCHEDULER] 📝 Registered consumer: ${id} (needsRaw=${needsRawMode})`);
  }

  /**
   * 激活消费者（获得 stdin 控制权）
   */
  activate(id: string): void {
    const consumer = this.consumers.get(id);
    if (!consumer) {
      dlog(`[STDIN_SCHEDULER] ⚠️  Consumer ${id} not registered`);
      return;
    }

    consumer.active = true;
    this.updateRawMode();
    dlog(`[STDIN_SCHEDULER] ✅ Activated: ${id}`);
  }

  /**
   * 停用消费者（释放 stdin 控制权）
   */
  deactivate(id: string): void {
    const consumer = this.consumers.get(id);
    if (!consumer) return;

    consumer.active = false;
    this.updateRawMode();
    dlog(`[STDIN_SCHEDULER] 🔻 Deactivated: ${id}`);
  }

  /**
   * 注销消费者
   */
  unregister(id: string): void {
    this.consumers.delete(id);
    this.updateRawMode();
    dlog(`[STDIN_SCHEDULER] 🗑️  Unregistered: ${id}`);
  }

  /**
   * 根据当前激活的消费者更新 raw mode 状态
   */
  private updateRawMode(): void {
    // 检查是否有激活的消费者需要 raw mode
    let needRaw = false;
    for (const consumer of this.consumers.values()) {
      if (consumer.active && consumer.needsRawMode) {
        needRaw = true;
        break;
      }
    }

    // 状态无变化，不需要切换
    if (needRaw === this.rawModeEnabled) {
      return;
    }

    // 切换 raw mode
    try {
      if (needRaw) {
        dlog('[STDIN_SCHEDULER] 🔓 Enabling raw mode (input needs it)');
        this.stdin.setRawMode(true);
        this.stdin.resume(); // 确保 stdin 是活跃的
        this.rawModeEnabled = true;
      } else {
        dlog('[STDIN_SCHEDULER] 🔒 Disabling raw mode (no active consumers need it)');
        this.stdin.setRawMode(false);
        this.stdin.resume(); // 🔥 CRITICAL: 立即 resume，防止 pause
        this.rawModeEnabled = false;
      }

      dlog(`[STDIN_SCHEDULER] 📊 State: raw=${this.rawModeEnabled}, paused=${this.stdin.isPaused?.()}`);
    } catch (error) {
      dlog('[STDIN_SCHEDULER] ❌ Failed to update raw mode:', error);
    }
  }

  /**
   * 强制恢复 stdin（用于紧急情况）
   */
  forceRecover(): void {
    dlog('[STDIN_SCHEDULER] 🚑 Force recovering stdin');
    try {
      if (this.stdin.isPaused?.()) {
        this.stdin.resume();
      }
      if (!this.rawModeEnabled && this.stdin.isTTY) {
        // 如果没有激活的消费者需要 raw mode，保持关闭状态支持复制
        this.stdin.setRawMode(false);
      }
      dlog('[STDIN_SCHEDULER] ✅ Force recover complete');
    } catch (error) {
      dlog('[STDIN_SCHEDULER] ❌ Force recover failed:', error);
    }
  }

  /**
   * 获取当前状态（用于调试）
   */
  getStatus(): string {
    const activeConsumers = Array.from(this.consumers.values())
      .filter(c => c.active)
      .map(c => c.id)
      .join(', ');

    return `Raw: ${this.rawModeEnabled}, Paused: ${this.stdin.isPaused?.()}, Active: [${activeConsumers}]`;
  }
}

// 全局单例
let globalScheduler: StdinScheduler | null = null;

export function getStdinScheduler(stdin?: NodeJS.ReadStream & { setRawMode(mode: boolean): void }): StdinScheduler {
  if (!globalScheduler && stdin) {
    globalScheduler = new StdinScheduler(stdin);
  }
  if (!globalScheduler) {
    throw new Error('StdinScheduler not initialized. Call with stdin first.');
  }
  return globalScheduler;
}
