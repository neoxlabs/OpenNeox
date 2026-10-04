/**
 * OS Notifier — 跨平台系统通知中心推送。
 *
 * 场景:agent 离开 UI 后,后台 bash 完成 / task-agent 完成 / context near limit
 * 可以推一条系统通知,用户就算在别的窗口也能立即察觉。
 *
 * 实现:
 *   · macOS: osascript(内建,无依赖)
 *   · Linux: notify-send(大多数发行版预装)
 *   · Windows: PowerShell BurntToast 或 msg(粗糙降级)
 *
 * 设计原则:
 *   · 失败静默 — 没有通知权限 / 命令缺失不报错,log warn 就好
 *   · 节流 — 同 title 短时间重复合并(防"20 个 bash 一起完成"刷屏)
 *   · Opt-in — NEOX_OS_NOTIFICATIONS=off 关闭(默认开,quiet mode 下也关)
 */

import { spawn } from 'child_process';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { isOsNotificationsEnabled } from '../runtime/agentRuntimeConfig.js';

export interface OsNotification {
  title: string;
  body: string;
  /** 'info' | 'success' | 'warning' | 'error' — 仅 Linux / Win 使用 */
  urgency?: 'info' | 'success' | 'warning' | 'error';
  /** 触发声音(macOS 'Glass' / 'Purr' 等;Linux/Win 忽略)*/
  sound?: string;
}

const NOTIFICATION_DEDUP_WINDOW_MS = 2_000;
const recentTitles = new Map<string, number>();

function isEnabled(): boolean {
  // 走 agentRuntimeConfig 统一决策(env / config / default)
  return isOsNotificationsEnabled();
}

function isDeduped(title: string): boolean {
  const now = Date.now();
  const last = recentTitles.get(title);
  if (last && now - last < NOTIFICATION_DEDUP_WINDOW_MS) return true;
  recentTitles.set(title, now);
  // GC 陈旧项
  if (recentTitles.size > 50) {
    for (const [k, t] of recentTitles) {
      if (now - t > NOTIFICATION_DEDUP_WINDOW_MS * 5) recentTitles.delete(k);
    }
  }
  return false;
}

/** AppleScript 字符串转义 — `"` + `\` 双重转义 */
function escAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** shell-argv 友好转义(不走 shell) */
function stripControlChars(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 500);
}

async function notifyMacOS(n: OsNotification): Promise<void> {
  const title = escAppleScript(stripControlChars(n.title));
  const body = escAppleScript(stripControlChars(n.body));
  const soundClause = n.sound ? ` sound name "${escAppleScript(n.sound)}"` : '';
  const script = `display notification "${body}" with title "${title}"${soundClause}`;
  return new Promise((resolve) => {
    const proc = spawn('osascript', ['-e', script], { stdio: 'ignore' });
    proc.on('error', () => resolve());
    proc.on('exit', () => resolve());
  });
}

async function notifyLinux(n: OsNotification): Promise<void> {
  const urgencyMap: Record<string, string> = {
    info: 'low',
    success: 'normal',
    warning: 'normal',
    error: 'critical',
  };
  const urgency = urgencyMap[n.urgency ?? 'info'] ?? 'normal';
  return new Promise((resolve) => {
    const proc = spawn(
      'notify-send',
      ['--urgency', urgency, '--app-name=Neox', stripControlChars(n.title), stripControlChars(n.body)],
      { stdio: 'ignore' },
    );
    proc.on('error', () => resolve());
    proc.on('exit', () => resolve());
  });
}

async function notifyWindows(n: OsNotification): Promise<void> {
  // 优先 BurntToast(PowerShell 模块);缺失时 fallback 到简单 msg
  // 为避免拖慢 + 依赖安装,我们只做最小 fallback — 用 PowerShell Toast API(Win10+)
  const title = stripControlChars(n.title).replace(/'/g, "''");
  const body = stripControlChars(n.body).replace(/'/g, "''");
  const script = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;` +
    `$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);` +
    `$template.GetElementsByTagName('text').Item(0).InnerText = '${title}';` +
    `$template.GetElementsByTagName('text').Item(1).InnerText = '${body}';` +
    `$toast = [Windows.UI.Notifications.ToastNotification]::new($template);` +
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Neox').Show($toast);`;
  return new Promise((resolve) => {
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
    proc.on('error', () => resolve());
    proc.on('exit', () => resolve());
  });
}

/**
 * 发送一条 OS 通知。失败静默不抛错。
 */
export async function sendOsNotification(n: OsNotification): Promise<void> {
  if (!isEnabled()) return;
  if (isDeduped(n.title)) return;
  try {
    if (process.platform === 'darwin') await notifyMacOS(n);
    else if (process.platform === 'linux') await notifyLinux(n);
    else if (process.platform === 'win32') await notifyWindows(n);
    // other: silent no-op
  } catch (err: any) {
    cliLogger.debug('OS_NOTIFY', `Send failed: ${err?.message ?? err}`);
  }
}
