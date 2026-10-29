/**
 * Life Events IPC — 独立库 (life_events.db) 的 CRUD + 状态迁移 + 组合查询.
 *
 * 命名空间: 'life-events:*'
 * preload 侧统一收口成 window.neox.lifeEvents.*
 * 通知: main → renderer 用 webContents.send('life-events:changed'),
 *       renderer store 收到就 re-list; 不带 payload (变更种类多, 一律拉最新).
 */

import { ipcMain, BrowserWindow } from 'electron';
import {
  getLifeEventsStore,
  type LifeEventCreate,
  type LifeEventKind,
  type LifeEventStatus,
} from '@neoxlabs/core/life/index.js';

let _wired = false;

export function registerLifeEventsIpcHandlers(): void {
  if (_wired) return;
  _wired = true;

  const store = getLifeEventsStore();

  /* 变更通知: 单进程内订阅 store, 广播到所有 renderer. */
  store.subscribe(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send('life-events:changed'); } catch { /* ignore */ }
    }
  });

  ipcMain.handle('life-events:create', (_e, input: LifeEventCreate) => {
    try {
      const ev = store.create(input);
      return { success: true, event: ev };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('life-events:transition', (_e, id: string, toStatus: LifeEventStatus, reason?: string) => {
    try {
      const ev = store.transition(id, toStatus, reason);
      return { success: true, event: ev };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('life-events:update', (_e, id: string, patch: Partial<Omit<LifeEventCreate, 'kind'>>) => {
    try {
      const ev = store.update(id, patch);
      return { success: true, event: ev };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('life-events:delete', (_e, id: string) => {
    try {
      const ok = store.delete(id);
      return { success: ok };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('life-events:get', (_e, id: string) => {
    try { return { success: true, event: store.get(id) }; }
    catch (e: any) { return { success: false, error: e?.message ?? String(e) }; }
  });

  ipcMain.handle('life-events:list-by-kind', (_e, kind: LifeEventKind, opts?: { status?: LifeEventStatus; limit?: number }) => {
    try { return { success: true, events: store.listByKind(kind, opts) }; }
    catch (e: any) { return { success: false, error: e?.message ?? String(e) }; }
  });

  ipcMain.handle('life-events:list-due-reminders', (_e, before?: number) => {
    try { return { success: true, events: store.listDueReminders(before) }; }
    catch (e: any) { return { success: false, error: e?.message ?? String(e) }; }
  });

  ipcMain.handle('life-events:list-for-brief', (_e, now?: number) => {
    try { return { success: true, ...store.listForDailyBrief(now) }; }
    catch (e: any) { return { success: false, error: e?.message ?? String(e) }; }
  });

  ipcMain.handle('life-events:list-for-session', (_e, sessionId: string) => {
    try { return { success: true, events: store.listRelatedForSession(sessionId) }; }
    catch (e: any) { return { success: false, error: e?.message ?? String(e) }; }
  });

  ipcMain.handle('life-events:transitions', (_e, id: string) => {
    try { return { success: true, transitions: store.transitions(id) }; }
    catch (e: any) { return { success: false, error: e?.message ?? String(e) }; }
  });
}
