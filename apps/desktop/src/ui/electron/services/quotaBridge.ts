
import { BrowserWindow } from 'electron';

export type QuotaReason = 'window5h' | 'windowWeekly' | 'plan' | 'unknown';

export interface QuotaExhaustedPayload {
  reason: QuotaReason;
  message?: string;
  /** 来源描述, 仅日志: 'cloud-relay' / 'consumer:session.subscribe' / etc */
  source?: string;
}

export function forwardQuotaExhausted(payload: QuotaExhaustedPayload): void {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.webContents.send('quota:exhausted', payload);
      }
    }
  } catch (e: any) {
    console.warn('[quotaBridge] forward failed:', e?.message ?? e);
  }
}

/** 启发式: 把任意 HTTP status / error message 归类成 QuotaReason. */
export function classifyQuotaError(status: number | undefined, messageOrCode: string | undefined): QuotaReason | null {
  if (status !== 402 && !messageOrCode) return null;
  const m = String(messageOrCode ?? '').toLowerCase();
  if (status === 402 && !m) return 'unknown';
  if (m.includes('model_denied') || m.includes('model_not_found') || m.includes('套餐')) return 'plan';
  /* 窗口种类能判出来就给准的, 判不出就 'unknown' —— modal 那档文案本来就是
   * 给"只知道额度没了但不知道是哪个窗口"写的。积分不足也归 unknown:
   * modal 会读 useQuota() 自己算 creditsMicros, 比这里瞎猜准。 */
  if (m.includes('window.5h') || m.includes('5h_exhausted') || m.includes('5 小时')) return 'window5h';
  if (m.includes('window.weekly') || m.includes('weekly_exhausted') || m.includes('本周')) return 'windowWeekly';
  if (m.includes('points_insufficient') || m.includes('积分')) return 'unknown';
  if (m.includes('quota_exceeded') || m.includes('额度') || m.includes('用尽')) return 'unknown';
  if (status === 402) return 'unknown';
  return null;
}
