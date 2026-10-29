/**
 * notifyStore — 任务完成通知偏好 + 通知触发逻辑
 *
 *   原先 GeneralTab 的"通知设置" section 三个 toggle 全是装饰性 useState, 没人读.
 *   这里补上完整闭环:
 *     1. localStorage 持久化 (跟 byokPickerPrefs 同范式)
 *     2. useNotifyConfig() hook — 订阅变化跨组件同步
 *     3. maybeNotifyTaskComplete() — task done 时唯一入口决策是否弹通知
 *
 *   核心策略:
 *     · 窗口前台时不打扰 — 用户已经在看 Neox, 不需要通知
 *     · 窗口失焦 + enabled + (sound or systemNotification) 才触发
 *     · systemNotification → 主进程通知 IPC
 *     · sound → window.neox.playSound(soundId)
 *     · 0.5s 内重复 fire 去抖 (避免一连串 turn 完成各响一次)
 */

import { displaySessionName } from './sessionDisplayName';

import { DEFAULT_QUIET_HOURS, inQuietWindow } from '@neoxlabs/pilot-data-sdk';
import { useEffect, useState } from 'react';

export type NotifySoundId = 'none' | 'default' | string;

/* 免打扰时段 (P1#9, pilot:P-03 统一): "HH:MM" 24h 制. start=end 视为全天开.
 * 默认 22:30–07:30 跟 Pilot 来电 / 手机通知 / 触发引擎同一个口径 —— 常量在
 * @neoxlabs/pilot-data-sdk 的 quietHours.ts, 别在这里另写一份。 */
export interface QuietHoursConfig {
  enabled: boolean;
  start: string; // "22:30"
  end: string;   // "07:30"
}

export interface NotifyConfig {
  /** 总开关. 关 = 后面所有都不响应. */
  enabled: boolean;
  /** 系统通知弹窗 — Notification API */
  systemNotification: boolean;
  /** 声音 id; 'none' 不响; 'default' 走系统默认; 其它走 window.neox.playSound */
  sound: NotifySoundId;
  /** 免打扰时段 — 时段内 quietHours enabled 时: 完成通知 / 提醒到点弹窗全部不弹, 声音也不响. */
  quietHours: QuietHoursConfig;
}

const STORAGE_KEY = 'neox.notify-config-v1';
const DEFAULT_CONFIG: NotifyConfig = {
  /* 完成通知默认开是**对的**, 别改: 用户主动发起了一个要跑几分钟的任务, 跑完告诉他
   * 正是这个功能存在的意义 —— 默认关掉等于让人盯着屏幕等。 */
  enabled: true,
  systemNotification: true,
  sound: 'default',
  quietHours: { ...DEFAULT_QUIET_HOURS },
};

/* 统一钟点之前存下的旧默认 (22:00–07:00) 跟着新口径走; 用户自己改过的时间不动。 */
const LEGACY_QUIET_DEFAULT = { start: '22:00', end: '07:00' };

function migrateQuietHours(q: QuietHoursConfig): QuietHoursConfig {
  if (q.start !== LEGACY_QUIET_DEFAULT.start || q.end !== LEGACY_QUIET_DEFAULT.end) return q;
  return { ...DEFAULT_QUIET_HOURS };
}

function readConfig(): NotifyConfig {
  if (typeof localStorage === 'undefined') return DEFAULT_CONFIG;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<NotifyConfig>;
    const parsedQuiet = (parsed as { quietHours?: Partial<QuietHoursConfig> }).quietHours;
    const quietHours: QuietHoursConfig = migrateQuietHours({
      enabled: parsedQuiet?.enabled ?? DEFAULT_CONFIG.quietHours.enabled,
      start: parsedQuiet?.start ?? DEFAULT_CONFIG.quietHours.start,
      end: parsedQuiet?.end ?? DEFAULT_CONFIG.quietHours.end,
    });
    return {
      enabled: parsed.enabled ?? DEFAULT_CONFIG.enabled,
      systemNotification: parsed.systemNotification ?? DEFAULT_CONFIG.systemNotification,
      sound: parsed.sound ?? DEFAULT_CONFIG.sound,
      quietHours,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/* 判断时段是否包含当前时刻 (跨零点 / start=end 全天): 口径在 SDK, 这里只叠加 enabled。 */
export function isInQuietHours(cfg: QuietHoursConfig = readConfig().quietHours, now: Date = new Date()): boolean {
  if (!cfg.enabled) return false;
  return inQuietWindow(now, cfg);
}

export function getNotifyConfig(): NotifyConfig {
  return readConfig();
}

export function setNotifyConfig(next: Partial<NotifyConfig>): void {
  if (typeof localStorage === 'undefined') return;
  const merged = { ...readConfig(), ...next };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(merged)); } catch { /* ignore */ }
  /* 跨组件同步: 触发自定义 event, 同 byokPickerPrefs 范式 */
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('neox-notify-prefs-changed'));
    try {
      const api = (window as unknown as { neox?: { notifySetLifePrefs?: (p: unknown) => Promise<unknown> } }).neox;
      if (typeof api?.notifySetLifePrefs === 'function') {
        void api.notifySetLifePrefs({ quietHours: merged.quietHours });
      }
    } catch { /* ignore */ }
  }
}

/** React hook — 订阅 notifyConfig 变化, 任意组件改完都会重渲染. */
export function useNotifyConfig(): [NotifyConfig, (next: Partial<NotifyConfig>) => void] {
  const [cfg, setCfg] = useState<NotifyConfig>(() => readConfig());
  useEffect(() => {
    const onChange = () => setCfg(readConfig());
    window.addEventListener('neox-notify-prefs-changed', onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener('neox-notify-prefs-changed', onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);
  return [cfg, setNotifyConfig];
}

/* 去抖 — 连续多个 turn complete 不要每个都弹 / 响 */
let lastFireAt = 0;
const DEBOUNCE_MS = 500;

export function maybeNotifyTaskComplete(opts: { sessionTitle?: string; sessionId?: string | null } = {}): void {
  /* 前台时跳过. 实际场景: 用户在 Neox 里看 streaming, 自己看到完成了, 不需要通知. */
  try {
    if (typeof document !== 'undefined' && document.hasFocus()) return;
  } catch { /* 某些环境 hasFocus 抛, 保险 fallthrough */ }

  const cfg = readConfig();
  if (!cfg.enabled) return;
  /* 免打扰时段: enabled 且当前落在区间内 → 完成通知不弹不响 (与 lifeBackgroundAgent 共享同一策略). */
  if (isInQuietHours(cfg.quietHours)) return;

  const now = Date.now();
  if (now - lastFireAt < DEBOUNCE_MS) return;
  lastFireAt = now;

  /* 系统通知 — 走 main 进程 IPC (notify:show), 跟 app identity 绑定. */
  if (cfg.systemNotification) {
    try {
      const api = (window as any).neox;
      if (typeof api?.notifyShow === 'function') {
        const title = '任务完成';
        const show = (name?: string) => {
          /* displaySessionName 会把 core 的默认名 / 裸 id 反解成"新会话 · 22:18";
             它认不出的空值退回"会话已就绪", 绝不把半截 id 顶到通知里。 */
          const pretty = name ? displaySessionName(name, undefined, true) : '';
          const body = pretty ? `「${pretty}」已就绪` : '会话已就绪';
          void api.notifyShow({ title, body, silent: true });
        };
        if (opts.sessionTitle) {
          show(opts.sessionTitle);
        } else if (opts.sessionId && typeof api?.getSession === 'function') {
          Promise.resolve(api.getSession(opts.sessionId))
            .then((s: any) => show(typeof s?.name === 'string' ? s.name : undefined))
            .catch(() => show(undefined));
        } else {
          show(undefined);
        }
      }
    } catch (e) {
      console.warn('[notifyStore] notifyShow failed:', e);
    }
  }

  /* 声音 — 'none' 跳过. 'default' / 其它都走 IPC. */
  if (cfg.sound && cfg.sound !== 'none') {
    try {
      const api = (window as any).neox;
      if (typeof api?.playSound === 'function') {
        api.playSound(cfg.sound);
      }
    } catch (e) {
      console.warn('[notifyStore] playSound failed:', e);
    }
  }
}
