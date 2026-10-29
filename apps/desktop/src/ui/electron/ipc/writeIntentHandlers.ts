/**
 * IPC handlers for WriteIntent —— renderer 发起 write intent 的通道.
 *
 * Renderer 侧场景:
 *   - Apply agent edit 前 begin, 完成后 end
 *   - 批量保存前 begin
 *
 * Renderer 不直接操作 semantic 读, 所以不需要 registerRead 的 IPC ——
 * 所有 semantic read 都在 main 发生 (semanticHandlers), 本地调 registry.
 */
import { ipcMain } from './ipcMainBridged.js';
import { getWriteIntentRegistry } from '../services/writeIntentService.js';

export interface BeginWriteIntentRequest {
  label: string;
  files?: string[];
  timeoutMs?: number;
}

export interface BeginWriteIntentResponse {
  id: number;
}

export function registerWriteIntentIpcHandlers(): void {
  /**
   * Begin a write intent. Returns a token id; caller MUST call
   * write-intent:end with the id when done (finally block).
   *
   * 推荐总是传 timeoutMs (建议 60s) 做保险 —— renderer 崩溃 / 忘记 end
   * 时 main 侧自动回收, 不会永久卡住后台 read.
   */
  ipcMain.handle(
    'write-intent:begin',
    async (_event, request: BeginWriteIntentRequest): Promise<BeginWriteIntentResponse> => {
      const registry = getWriteIntentRegistry();
      const token = registry.begin({
        label: request.label,
        files: request.files,
        timeoutMs: request.timeoutMs ?? 60_000,
      });
      return { id: token.id };
    },
  );

  ipcMain.handle(
    'write-intent:end',
    async (_event, id: number): Promise<{ ended: boolean }> => {
      const registry = getWriteIntentRegistry();
      return { ended: registry.endById(id) };
    },
  );

  /** 诊断用 —— Settings 面板或 DevTools 里查当前锁状态. */
  ipcMain.handle(
    'write-intent:snapshot',
    async () => {
      return getWriteIntentRegistry().snapshot();
    },
  );
}
