export interface PilotCloudSlot {
  /** 这个账号开通了 Pilot (用缓存) */
  enabled(): boolean;
  /** 重新问一次开通状态和名单 */
  refresh(): Promise<void>;
  /** 新建 / 改档案: 写进云端账本 (id = 电脑上的会话 id) */
  saveProfile(pilotId: string, p: { name?: string; avatar?: string; persona?: string; patrolMinutes?: number }): Promise<void>;
  /** 这个会话是住在云端的 Pilot (同步, 用缓存) */
  isCloudPilot(sessionId: string | null | undefined): boolean;
  ids(): string[];
  board(pilotId: string): Promise<{
    reports: Array<{ id: string; status: string; title: string; summary: string; options: string[]; urgency: string; times: number; answer: string | null; read: boolean; at: number }>;
    reminders: Array<{ id: string; title: string; at: number; ring?: boolean }>;
  }>;
  /** 任务板直接建提醒 (不经模型); ring = 到点打电话, 否则推送 */
  addReminder(pilotId: string, r: { title: string; at: number; ring?: boolean }): Promise<unknown>;
  /** 它记得的事 */
  memories(pilotId: string): Promise<Array<{ id: string; text: string; at: number }>>;
  addMemory(pilotId: string, text: string): Promise<unknown>;
  forgetMemory(memoryId: string): Promise<unknown>;
  reportsRead(pilotId: string): Promise<void>;
  answer(reportId: string, answer: string): Promise<unknown>;
  /** 动作卡 (它要替你对外发的东西): pending = 等你点, approved = 批了正在办 */
  actions(pilotId: string, state: 'pending' | 'approved' | 'done' | 'failed' | 'rejected'): Promise<PilotActionCard[]>;
  cancelReminder(reminderId: string): Promise<void>;
  /** 它工作区里的文件 (文件柜): 列目录 / 读文件 (读之前会先叫醒它, 文件在它的容器里) */
  listFiles(pilotId: string, path: string): Promise<Array<{ name: string; path: string; type: string; size: number; mtime: number }>>;
  readFile(pilotId: string, path: string): Promise<{ size: number; truncated: boolean; encoding: 'utf8' | 'base64'; content: string }>;
  /** 对话账本 (云端为准, 旧 → 新)。after = 只要这条消息 id 之后的 */
  messages(pilotId: string, opts: { after?: number; limit?: number }): Promise<PilotLedgerMessage[]>;
}

export interface PilotActionCard {
  id: string; title: string; summary: string; options: string[]; at: number; answer: string | null;
  action: { tool: 'computer' | 'phone'; action: string; args: Record<string, unknown>; preview: string } | null;
  actionState: string | null; actionResult: string | null;
}

export interface PilotLedgerMessage { id: number; role: string; text: string; device: string | null; at: number }

let slot: PilotCloudSlot | null = null;

export function setPilotCloudSlot(s: PilotCloudSlot | null): void { slot = s; }

/** 接上的口子 (不管开没开通) —— 问开通状态用 */
export function pilotCloudSlot(): PilotCloudSlot | null { return slot; }

export function pilotCloud(): PilotCloudSlot | null {
  return slot && slot.enabled() ? slot : null;
}

export function isCloudPilotSession(sessionId: string | null | undefined): boolean {
  return !!slot && slot.isCloudPilot(sessionId);
}
