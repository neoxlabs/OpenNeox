/**
 * petHandlers — main 进程的桌宠相关 IPC handler 注册
 *
 * 通道分两类:
 *
 *   1. 主窗口 → main: 管理生命周期
 *      pet:spawn               启用桌宠 (从 PetTab 切换 enabled=true 触发)
 *      pet:destroy             关闭桌宠
 *      pet:update-config       PetTab 改了 cfg, 同步告诉 pet window
 *      pet:forward-agent-event 主窗口 NeoxRuntime 过滤后转发 agent 事件给 pet window
 *
 *   2. pet 窗口 → main: 拖拽 + dismiss
 *      pet:get-config          启动时拉一次
 *      pet:start-drag / pet:drag / pet:end-drag    拖拽
 *      pet:dismiss             右键关闭 (跟 cfg.enabled=false 等价)
 *      pet:recenter            debug
 *
 * 配置存内存里 (last known config), 主窗口推一次 cfg 后 main 缓存, pet window
 * 拉的时候直接给. 真持久化在 renderer localStorage (petConfig.ts), main 不操心.
 */

import { ipcMain, BrowserWindow, dialog } from 'electron';
import { join } from 'node:path';
import {
  spawnPetWindow,
  destroyPetWindow,
  getPetWindow,
  petStartDrag,
  petDrag,
  petEndDrag,
  getPetPosition,
  recenterPet,
} from '../services/petWindowFactory.js';
import {
  ensureRendererPlugin,
  removeRendererPlugin,
} from '../services/petRendererPlugins.js';
import {
  listCustomSkins,
  importGlbFile,
  deleteCustomSkin,
  listCustomSprites,
  importSpriteFile,
  importPetBundle,
  discoverInstalledPacks,
  importDiscoveredPack,
  deleteCustomSprite,
} from '../services/petStorage.js';

export interface PetWindowConfigSnapshot {
  enabled: boolean;
  mode: 'svg' | '3d' | '2d' | 'sprite';
  svgVariant?: string;
  skin: string;
  size: 'sm' | 'md' | 'lg';
  corner: 'br' | 'bl' | 'tr' | 'tl';
  speechBubble: boolean;
  showPlanProgress: boolean;
  reactOnTaskComplete: boolean;
  reactOnError: boolean;
  idleAnimations: boolean;
  customSkins?: Array<{ id: string; fileName: string; name: string }>;
  active2DSpec?: unknown;
  activeSpriteId?: string | null;
  customSprites?: Array<{ id: string; fileName: string; name: string; cellWidth?: number; cellHeight?: number }>;
}

const DEFAULT_CONFIG: PetWindowConfigSnapshot = {
  enabled: false,
  mode: 'svg',
  svgVariant: 'aurora',
  skin: 'robo-orange',
  size: 'md',
  corner: 'br',
  speechBubble: true,
  showPlanProgress: true,
  reactOnTaskComplete: true,
  reactOnError: true,
  idleAnimations: true,
  customSkins: [],
};

let lastConfig: PetWindowConfigSnapshot = { ...DEFAULT_CONFIG };
let lastPosition: { x: number; y: number } | null = null;

interface RegisterPetIpcHandlersOpts {
  isDev: boolean;
  dirname: string;
}

export function registerPetIpcHandlers(opts: RegisterPetIpcHandlersOpts): void {
  /* ---------- 主窗口 → main ---------- */

  ipcMain.handle('pet:spawn', async (_e, cfg?: Partial<PetWindowConfigSnapshot>) => {
    if (cfg) lastConfig = { ...lastConfig, ...cfg };
    try {
      const win = await spawnPetWindow({
        isDev: opts.isDev,
        dirname: opts.dirname,
        size: lastConfig.size,
        corner: lastConfig.corner,
        lastPosition: lastPosition ?? undefined,
        mode: lastConfig.mode,
      });
      return { ok: true, windowId: win.id };
    } catch (err: any) {
      console.error('[petHandlers] spawn failed:', err);
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('pet:destroy', async () => {
    /* 保存最后位置, 下次启动还原 */
    const pos = getPetPosition();
    if (pos) lastPosition = pos;
    destroyPetWindow();
    return { ok: true };
  });

  ipcMain.handle('pet:update-config', async (_e, cfg: Partial<PetWindowConfigSnapshot>) => {
    lastConfig = { ...lastConfig, ...cfg };
    /* 推给 pet window 让它更新视觉 */
    const petWin = getPetWindow();
    if (petWin) petWin.webContents.send('pet:config-changed', lastConfig);
    return { ok: true };
  });

  ipcMain.handle('pet:forward-agent-event', async (_e, event: unknown) => {
    const petWin = getPetWindow();
    if (petWin) petWin.webContents.send('pet:agent-event', event);
    return { ok: true };
  });

  /* ---------- pet 窗口 → main ---------- */

  ipcMain.handle('pet:get-config', () => lastConfig);

  ipcMain.on('pet:start-drag', (e) => {
    /* 校验: 调用方必须是 pet window 本身, 防外部进程乱拖 */
    if (!isFromPetWindow(e.sender.id)) return;
    petStartDrag();
  });

  ipcMain.on('pet:drag', (e, payload: { dx: number; dy: number }) => {
    if (!isFromPetWindow(e.sender.id)) return;
    petDrag(payload.dx | 0, payload.dy | 0);
  });

  ipcMain.on('pet:end-drag', (e) => {
    if (!isFromPetWindow(e.sender.id)) return;
    petEndDrag({ snapToCorner: false });
    /* 保存拖完的位置 — 下次启动 / 重开桌宠时还原 */
    const pos = getPetPosition();
    if (pos) lastPosition = pos;
  });

  ipcMain.on('pet:dismiss', (e) => {
    if (!isFromPetWindow(e.sender.id)) return;
    /* 跟 PetTab 那侧的 enabled=false 等价 — 推个事件让主窗口同步 UI */
    const pos = getPetPosition();
    if (pos) lastPosition = pos;
    destroyPetWindow();
    /* 给所有主窗口发个 "pet 被关了" 信号, 让 PetTab 把 toggle 切回 off */
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.id !== getPetWindow()?.id) {
        win.webContents.send('pet:dismissed-by-user');
      }
    }
  });

  ipcMain.on('pet:recenter', (e) => {
    if (!isFromPetWindow(e.sender.id)) return;
    recenterPet();
  });

  /* ---------- 用户 .glb 导入 / 列表 / 删除 ---------- */

  ipcMain.handle('pet:list-custom-skins', async () => {
    try {
      return { ok: true, skins: await listCustomSkins() };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('pet:import-glb', async (e) => {
    /* 来源校验 — pet 窗口本身不应该有这个能力 (避免 .glb 文件里塞恶意脚本调用),
     * 只允许主窗口走. 不过我们也不强卡 — preload-pet.cjs 本来就没暴露这个通道. */
    const senderWin = BrowserWindow.fromWebContents(e.sender);
    if (!senderWin || senderWin.isDestroyed()) {
      return { ok: false, error: 'no sender window' };
    }
    /* 文件选择 dialog — 同步走 showOpenDialog (返回 Promise) */
    const result = await dialog.showOpenDialog(senderWin, {
      title: '导入 .glb 桌宠模型',
      filters: [{ name: 'glTF Binary', extensions: ['glb'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: 'cancelled' };
    }
    const srcPath = result.filePaths[0];
    return importGlbFile(srcPath);
  });

  ipcMain.handle('pet:delete-custom-skin', async (_e, id: string) => {
    if (typeof id !== 'string' || !id.startsWith('custom-')) {
      return { ok: false, error: 'invalid skin id' };
    }
    return deleteCustomSkin(id);
  });

  /* ---------- 用户 sprite sheet (.webp/.png) 导入 ---------- */

  ipcMain.handle('pet:list-custom-sprites', async () => {
    try {
      return { ok: true, sprites: await listCustomSprites() };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('pet:import-sprite', async (e) => {
    const senderWin = BrowserWindow.fromWebContents(e.sender);
    if (!senderWin || senderWin.isDestroyed()) {
      return { ok: false, error: 'no sender window' };
    }
    const result = await dialog.showOpenDialog(senderWin, {
      title: '导入 sprite sheet (.webp / .png)',
      filters: [{ name: 'Sprite Sheet', extensions: ['webp', 'png'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: 'cancelled' };
    }
    return importSpriteFile(result.filePaths[0]);
  });

  /* ---------- Codex Pets / OpenPets bundle 导入 (pet.json + spritesheet, 目录或 .zip) ---------- */

  ipcMain.handle('pet:import-pet-bundle', async (e) => {
    const senderWin = BrowserWindow.fromWebContents(e.sender);
    if (!senderWin || senderWin.isDestroyed()) {
      return { ok: false, error: 'no sender window' };
    }
    const result = await dialog.showOpenDialog(senderWin, {
      title: '导入宠物包 (.zip 或文件夹)',
      filters: [{ name: 'Pet Pack', extensions: ['zip'] }],
      /* openDirectory + openFile 同时允许: macOS 用户可选 .zip 或解压后的文件夹 */
      properties: ['openFile', 'openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: 'cancelled' };
    }
    return importPetBundle(result.filePaths[0]);
  });

  /* ---------- 发现 / 一键导入已安装的社区桌宠 (PetDex CLI 等) ---------- */

  ipcMain.handle('pet:discover-packs', async () => {
    try {
      return { ok: true, packs: await discoverInstalledPacks() };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('pet:import-discovered', async (_e, dir: string) => {
    if (typeof dir !== 'string' || !dir) return { ok: false, error: 'invalid dir' };
    return importDiscoveredPack(dir);
  });

  /* ---------- 渲染器插件 (3D 等) 按需下载 / 卸载 — 走统一商店 ---------- */

  ipcMain.handle('pet:ensure-renderer', async (_e, mode: string) => {
    try {
      const bundledRendererDir = join(opts.dirname, '../renderer');
      return await ensureRendererPlugin(mode, bundledRendererDir);
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('pet:remove-renderer', async (_e, mode: string) => {
    try {
      await removeRendererPlugin(mode);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('pet:delete-custom-sprite', async (_e, id: string) => {
    if (typeof id !== 'string' || !id.startsWith('sprite-')) {
      return { ok: false, error: 'invalid sprite id' };
    }
    return deleteCustomSprite(id);
  });
}

function isFromPetWindow(senderId: number): boolean {
  const petWin = getPetWindow();
  return petWin !== null && petWin.webContents.id === senderId;
}
