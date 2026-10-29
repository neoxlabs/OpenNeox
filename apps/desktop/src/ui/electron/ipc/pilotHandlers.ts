
import { ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';
import { DEFAULT_QUIET_HOURS } from '@neoxlabs/pilot-data-sdk';
import {
  setHostCapabilities, setCallUserExecutor, type CallUserRequest,
  readPilotProfiles, savePilotProfile, type PilotProfile, setReportExecutor,
} from '@neoxlabs/core';
import {
  acceptCall, configurePilotCalls, declineCall, getCurrentCall, hangupCall, readCallLog, relayLiveReport,
  ringUser, setCallMuted, shutdownPilotCalls, snoozeCall, startOutgoingCall, type CallLiveReport,
} from '../services/pilotCallService.js';
import { getCallWindow } from '../services/pilotCallWindow.js';
import { addReport, answerReport, bootPilotReports, markReportsRead, readReports, type PilotReport } from '../services/pilotReports.js';
import { isCloudPilotSession, pilotCloud, pilotCloudSlot } from '../services/pilotCloudSlot.js';
import { syncPilotHistory } from '../services/pilotHistorySync.js';
import { fetchWeather, landPilotFile, searchPlaces } from '../services/pilotBoardData.js';
import {
  disconnectPilotTelegram, pilotTelegramStatus, setPilotTelegramToken, startPilotTelegramPairing,
} from '../services/pilotTelegram.js';

export interface RegisterPilotIpcHandlersOpts {
  isDev: boolean;
  dirname: string;
}

type CallAction = 'accept' | 'decline' | 'snooze' | 'hangup' | 'mute' | 'unmute';

interface PilotSettings {
  pilot: {
    callOn?: { reminders?: boolean; decisions?: boolean; alerts?: boolean; agent?: boolean };
    maxUnaskedPerHour?: number;
    ringSeconds?: number;
  };
  quietHours: { enabled: boolean; start: string; end: string };
}

export function registerPilotIpcHandlers(opts: RegisterPilotIpcHandlersOpts): void {
  configurePilotCalls({ isDev: opts.isDev, dirname: opts.dirname });

  const ring = (req: CallUserRequest) => ringUser(req, 'agent');
  setCallUserExecutor(ring);
  setReportExecutor(addReport);
  setHostCapabilities({ callUser: ring, pilotReport: addReport });
  bootPilotReports();

  /* ── 汇报账本 ── */
  /* 住在云端的 Pilot (cloud-session/cloudPilot.ts): 汇报在云端账本里, 跟电脑本机的拼成一张板 */
  ipcMain.handle('pilot:reports', async () => {
    const local = readReports().filter((r) => !isCloudPilotSession(r.sessionId));
    const cloud = pilotCloud();
    if (!cloud) return local;
    const boards = await Promise.all(cloud.ids().map(async (pid) => {
      try {
        return (await cloud.board(pid)).reports.map((r): PilotReport => ({
          id: r.id, sessionId: pid, status: r.status as PilotReport['status'], title: r.title, summary: r.summary,
          options: r.options, urgency: (r.urgency as PilotReport['urgency']) || 'fyi', at: r.at,
          readAt: r.read ? r.at : undefined, answer: r.answer ?? undefined, repeats: Math.max(0, r.times - 1),
        }));
      } catch { return []; }
    }));
    return [...local, ...boards.flat()].sort((a, b) => b.at - a.at);
  });
  ipcMain.handle('pilot:reports-read', async (_e, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId) return { ok: true };
    const cloud = pilotCloud();
    if (cloud && isCloudPilotSession(sessionId)) await cloud.reportsRead(sessionId).catch(() => undefined);
    else markReportsRead(sessionId);
    return { ok: true };
  });
  ipcMain.handle('pilot:report-answer', async (_e, id: string, answer: string) => {
    if (typeof id !== 'string' || typeof answer !== 'string') return { ok: true };
    /* 电脑本机账里没有的 = 云端账本的 (id pr_ 开头, 或搬家时按原 id 导入的) */
    const cloud = pilotCloud();
    if (cloud && !readReports().some((r) => r.id === id && !isCloudPilotSession(r.sessionId))) {
      await cloud.answer(id, answer).catch(() => undefined);
    } else {
      answerReport(id, answer);
    }
    return { ok: true };
  });

  /* ── 动作卡: 它要用你的名义发的 (等你点的 + 批了正在办的), 摆在对话输入框上方 ── */
  ipcMain.handle('pilot:actions', async (_e, sessionId: string) => {
    const cloud = pilotCloud();
    if (!cloud || typeof sessionId !== 'string' || !isCloudPilotSession(sessionId)) return [];
    try {
      const [pending, approved] = await Promise.all([cloud.actions(sessionId, 'pending'), cloud.actions(sessionId, 'approved')]);
      return [...pending, ...approved];
    } catch {
      return [];
    }
  });

  /* ── 到点提醒: 云端 Pilot 的提醒在云端账本里 (本机提醒库里没有), 任务板「到点」一栏以前对它们永远是空的 ──
   * 不是云端 Pilot → { cloud: false }, 界面照旧读本机提醒库 */
  ipcMain.handle('pilot:reminders', async (_e, sessionId: string) => {
    const cloud = pilotCloud();
    if (!cloud || typeof sessionId !== 'string' || !isCloudPilotSession(sessionId)) return { cloud: false, reminders: [] };
    try {
      const b = await cloud.board(sessionId);
      return { cloud: true, reminders: b.reminders.map((r) => ({ id: r.id, title: r.title, scheduledAt: r.at, status: 'scheduled', ring: !!r.ring })) };
    } catch {
      return { cloud: true, reminders: [] };
    }
  });
  /* 任务板直接动账本 (新建 / 改时间 / 记忆) —— 不经模型, 点了就成; 它下一轮从账本里看得到 */
  ipcMain.handle('pilot:add-reminder', async (_e, sessionId: string, r: { title?: string; at?: number; ring?: boolean }) => {
    const cloud = pilotCloud();
    const title = String(r?.title ?? '').trim();
    if (!cloud || !isCloudPilotSession(sessionId) || !title || !Number.isFinite(r?.at)) return { ok: false };
    try { await cloud.addReminder(sessionId, { title, at: Number(r.at), ring: !!r.ring }); return { ok: true }; }
    catch (err) { return { ok: false, error: (err as Error)?.message ?? String(err) }; }
  });
  ipcMain.handle('pilot:memories', async (_e, sessionId: string) => {
    const cloud = pilotCloud();
    if (!cloud || !isCloudPilotSession(sessionId)) return { cloud: false, memories: [] };
    try { return { cloud: true, memories: await cloud.memories(sessionId) }; } catch { return { cloud: true, memories: [] }; }
  });
  ipcMain.handle('pilot:add-memory', async (_e, sessionId: string, text: string) => {
    const cloud = pilotCloud();
    const t = String(text ?? '').trim();
    if (!cloud || !isCloudPilotSession(sessionId) || !t) return { ok: false };
    try { await cloud.addMemory(sessionId, t); return { ok: true }; } catch (err) { return { ok: false, error: (err as Error)?.message ?? String(err) }; }
  });
  ipcMain.handle('pilot:forget-memory', async (_e, memoryId: string) => {
    const cloud = pilotCloud();
    if (!cloud || typeof memoryId !== 'string' || !memoryId) return { ok: false };
    try { await cloud.forgetMemory(memoryId); return { ok: true }; } catch { return { ok: false }; }
  });
  /* ── 小组件: 文件柜 / 天气 (见 services/pilotBoardData.ts) ── */
  ipcMain.handle('pilot:files', async (_e, sessionId: string, path?: string) => {
    const cloud = pilotCloud();
    if (!cloud || !isCloudPilotSession(sessionId)) return { ok: false, error: 'not a cloud pilot' };
    try { return { ok: true, items: await cloud.listFiles(sessionId, String(path ?? '.')) }; }
    catch (err) { return { ok: false, error: (err as Error)?.message ?? String(err) }; }
  });
  ipcMain.handle('pilot:open-file', async (_e, sessionId: string, path: string, mode?: 'open' | 'save') => {
    /* 它的手有两只: 云端容器 (/workspace/…) 和这台电脑 (它用电脑工具写的, 比如桌面上的 todo.md)。
     * 这台电脑上有这个绝对路径 = 电脑上写的, 就地打开; 否则去它容器里取。 */
    if (typeof path === 'string' && isAbsolute(path) && path.startsWith(homedir()) ) {
      if (!existsSync(path)) return { ok: false, error: '这个文件已经不在了 (被移走或删掉)' };
      if (mode === 'save') { shell.showItemInFolder(path); return { ok: true, local: path }; }
      const err = await shell.openPath(path);
      return err ? { ok: false, error: err } : { ok: true, local: path };
    }
    const cloud = pilotCloud();
    if (!cloud || !isCloudPilotSession(sessionId) || !path) return { ok: false, error: 'not a cloud pilot' };
    try {
      const f = await cloud.readFile(sessionId, path);
      return { ok: true, local: await landPilotFile(sessionId, path, f, mode === 'save' ? 'save' : 'open') };
    } catch (err) { return { ok: false, error: (err as Error)?.message ?? String(err) }; }
  });
  ipcMain.handle('pilot:places', async (_e, q: string, lang?: string) => {
    try { return { ok: true, places: await searchPlaces(String(q ?? ''), String(lang ?? 'zh')) }; }
    catch (err) { return { ok: false, error: (err as Error)?.message ?? String(err), places: [] }; }
  });
  ipcMain.handle('pilot:weather', async (_e, lat: number, lng: number) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, error: 'bad coords' };
    try { return { ok: true, weather: await fetchWeather(lat, lng) }; }
    catch (err) { return { ok: false, error: (err as Error)?.message ?? String(err) }; }
  });
  ipcMain.handle('pilot:cancel-reminder', async (_e, reminderId: string) => {
    const cloud = pilotCloud();
    if (!cloud || typeof reminderId !== 'string' || !reminderId) return { ok: false };
    await cloud.cancelReminder(reminderId).catch(() => undefined);
    return { ok: true };
  });

  /* ── 对话: 云端账本为准, 本地缺的补进时间线 (见 pilotHistorySync.ts) ── */
  ipcMain.handle('pilot:sync-history', async (_e, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, added: 0 };
    try {
      return { ok: true, ...(await syncPilotHistory(sessionId)) };
    } catch (err) {
      return { ok: false, added: 0, error: (err as Error)?.message ?? String(err) };
    }
  });

  /* ── 来电小窗 ── */
  const fromCallWindow = (senderId: number) => getCallWindow()?.webContents.id === senderId;
  ipcMain.on('pilot-call:hello', (e) => {
    if (!fromCallWindow(e.sender.id)) return;
    e.sender.send('pilot-call:state', getCurrentCall());
  });
  ipcMain.on('pilot-call:action', (e, action: CallAction) => {
    if (!fromCallWindow(e.sender.id)) return;
    runAction(action);
  });

  /* ── 主窗口 ── */
  ipcMain.handle('pilot-call:current', () => getCurrentCall());
  ipcMain.handle('pilot-call:action', (_e, action: CallAction) => { runAction(action); return { ok: true }; });
  ipcMain.handle('pilot-call:start-outgoing', async (_e, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'sessionId required' };
    const call = await startOutgoingCall(sessionId);
    return call ? { ok: true, call } : { ok: false, error: 'already in a call' };
  });
  ipcMain.on('pilot-call:report', (_e, report: CallLiveReport) => {
    if (report && typeof report.callId === 'string') relayLiveReport(report);
  });
  ipcMain.handle('pilot-call:log', () => readCallLog());
  /* 设置页「试一下来电」, 也是端到端验证的入口 */
  ipcMain.handle('pilot-call:test-ring', async (_e, req: { sessionId?: string; reason?: string; opening?: string; device?: 'phone' }) => {
    return ringUser({
      sessionId: req?.sessionId,
      reason: req?.reason || '试一下来电',
      opening: req?.opening || '喂, 听得到吗? 这是一次试打, 你说句话我听听。',
      urgency: 'asked',
    }, 'user', { device: req?.device === 'phone' ? 'phone' : undefined });
  });

  /* ── 来电设置 (config.pilot + 勿扰时段 lifeQuietHours) ── */
  ipcMain.handle('pilot:get-settings', () => {
    const cfg = loadConfig() as { pilot?: PilotSettings['pilot'] & { telegram?: unknown }; lifeQuietHours?: PilotSettings['quietHours'] };
    /* bot token 不出主进程 —— Telegram 那块走下面自己的状态接口 */
    const { telegram: _secret, ...pilot } = cfg.pilot ?? {};
    /* 没存过就是统一口径 22:30–07:30 (pilot:P-03) */
    return { pilot, quietHours: cfg.lifeQuietHours ?? { ...DEFAULT_QUIET_HOURS } };
  });
  ipcMain.handle('pilot:save-settings', (_e, next: Partial<PilotSettings>) => {
    const cfg = loadConfig() as Record<string, unknown> & { pilot?: PilotSettings['pilot'] };
    const merged = { ...cfg };
    if (next?.pilot) {
      const { telegram: _ignored, ...incoming } = next.pilot as PilotSettings['pilot'] & { telegram?: unknown };
      merged.pilot = { ...(cfg.pilot ?? {}), ...incoming, callOn: { ...(cfg.pilot?.callOn ?? {}), ...(incoming.callOn ?? {}) } };
    }
    if (next?.quietHours) merged.lifeQuietHours = next.quietHours;
    saveConfig(merged as never);
    return { ok: true };
  });

  /* ── Telegram: 不在电脑前找 Pilot ── */
  ipcMain.handle('pilot:telegram-status', () => pilotTelegramStatus());
  ipcMain.handle('pilot:telegram-set-token', async (_e, token: string) => {
    try {
      return { ok: true, status: await setPilotTelegramToken(typeof token === 'string' ? token : '') };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
  });
  ipcMain.handle('pilot:telegram-pair', () => startPilotTelegramPairing());
  ipcMain.handle('pilot:telegram-disconnect', () => { disconnectPilotTelegram(); return pilotTelegramStatus(); });

  /* ── 开通状态: Pilot 只住云端, 没开通的账号不显示 Pilot 模式 ── */
  ipcMain.handle('pilot:available', async () => {
    const slot = pilotCloudSlot();
    if (!slot) return false;
    await slot.refresh().catch(() => undefined);
    return slot.enabled();
  });

  /* ── 联系人档案: 电脑上留一份 (界面用), 账本里同步一份 (它的家) ── */
  ipcMain.handle('pilot:profiles', () => readPilotProfiles());
  ipcMain.handle('pilot:save-profile', async (_e, sessionId: string, patch: Partial<PilotProfile>) => {
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'sessionId required' };
    const profile = savePilotProfile(sessionId, patch ?? {});
    const cloud = pilotCloud();
    if (cloud) {
      try {
        await cloud.saveProfile(sessionId, {
          name: profile.name, avatar: profile.avatar, persona: profile.persona, patrolMinutes: profile.patrolMinutes,
        });
      } catch (err) {
        return { ok: false, profile, error: `没存到云端: ${(err as Error)?.message ?? err}` };
      }
    }
    return { ok: true, profile };
  });
}

function runAction(action: CallAction): void {
  switch (action) {
    case 'accept': acceptCall(); break;
    case 'decline': declineCall(); break;
    case 'snooze': snoozeCall(); break;
    case 'hangup': hangupCall('user'); break;
    case 'mute': setCallMuted(true); break;
    case 'unmute': setCallMuted(false); break;
  }
}

export { shutdownPilotCalls };
