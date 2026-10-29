/**
 * Whether the agent's Chrome starts with the user's everyday Chrome sign-ins.
 *
 * The choice lives in ~/.neox/config.json browserUse: reuseDailyLogins (the settings switch)
 * plus dailyLoginsDecided. Switch on → sync silently every launch, never ask again. Decided
 * "no" → never ask. Never decided → the first launch asks through the renderer's confirm
 * dialog and the answer is saved, so it is asked once.
 *
 * Handshake (renderer side: DailyLoginsAskHost.tsx), same shape as the update prompt:
 *   main → browser:daily-logins-ask { id }
 *   renderer → browser:daily-logins-ack-<id>   within 1.5s, or no dialog is up
 *   renderer → browser:daily-logins-answer { id, allow }
 * No window, no ack, or no answer in time → launch without sign-ins and save nothing, so the
 * question comes back next launch instead of being decided for the user.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { configService } from '@neoxlabs/platform/platform/configService.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

const ACK_MS = 1500;
const ANSWER_MS = 3 * 60_000;
let seq = 0;

function ask(): Promise<boolean | null> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.webContents.isDestroyed());
  if (!win) return Promise.resolve(null);
  const id = ++seq;
  return new Promise((resolve) => {
    const ackChannel = `browser:daily-logins-ack-${id}`;
    let settled = false;
    const finish = (value: boolean | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(ackTimer);
      clearTimeout(answerTimer);
      ipcMain.removeAllListeners(ackChannel);
      ipcMain.removeListener('browser:daily-logins-answer', onAnswer);
      resolve(value);
    };
    const onAnswer = (_e: unknown, payload: { id?: number; allow?: boolean }) => {
      if (payload?.id === id) finish(payload.allow === true);
    };
    const ackTimer = setTimeout(() => finish(null), ACK_MS);
    const answerTimer = setTimeout(() => finish(null), ANSWER_MS);
    ipcMain.once(ackChannel, () => clearTimeout(ackTimer));
    ipcMain.on('browser:daily-logins-answer', onAnswer);
    try {
      win.webContents.send('browser:daily-logins-ask', { id });
    } catch {
      finish(null);
    }
  });
}

let pending: Promise<boolean> | null = null;

/** true = sync everyday sign-ins before this launch. */
export function resolveDailyLoginsChoice(): Promise<boolean> {
  const cfg = configService.getBrowserUseConfig();
  if (cfg.reuseDailyLogins) return Promise.resolve(true);
  if (cfg.dailyLoginsDecided) return Promise.resolve(false);
  if (pending) return pending;
  pending = ask().then((answer) => {
    if (answer === null) {
      cliLogger.info('EXTERNAL_CHROME', 'daily sign-ins: not answered, launching without and asking next time');
      return false;
    }
    configService.setBrowserUseConfig({ reuseDailyLogins: answer });
    cliLogger.info('EXTERNAL_CHROME', `daily sign-ins: user chose ${answer ? 'reuse' : 'separate'}`);
    return answer;
  }).finally(() => { pending = null; });
  return pending;
}
