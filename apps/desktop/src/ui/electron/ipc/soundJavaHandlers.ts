import { ipcMain } from './ipcMainBridged.js';
import { lazyElectron } from '../lazyElectron.js';

/* electron 走运行时取 —— 顶层静态 import 会让整个 bundle 在纯 Node 里加载失败,
 * 连累同包所有 handler (见 lazyElectron.ts, 方法必须 bind 回宿主)。ipcMain 走桥的替身。 */
const Notification = lazyElectron<typeof import('electron').Notification>('Notification');
const app = lazyElectron<typeof import('electron').app>('app');
import { spawn } from 'child_process';
import { extname } from 'path';
import { configService } from '@neoxlabs/platform/platform/configService.js';
import { listMacOSSystemSounds, getMacOSSystemSoundsDir, listSoundFiles } from '@neoxlabs/platform/platform/sound.js';
import { SOUNDS_DIR } from '@neoxlabs/platform/utils/config.js';

export function registerSoundJavaIpcHandlers(): void {
  ipcMain.handle('sound:list-available', () => {
    const sounds: Array<{ id: string; name: string; path: string; type: 'system' | 'custom' }> = [];
    sounds.push({ id: 'none', name: 'None', path: '', type: 'custom' });
    sounds.push({ id: 'default', name: 'Default', path: '', type: 'custom' });

    if (process.platform === 'darwin') {
      const systemSounds = listMacOSSystemSounds();
      const systemDir = getMacOSSystemSoundsDir();
      for (const sound of systemSounds) {
        const name = sound.replace(/\.(aiff|aif|wav|mp3|m4a|ogg)$/i, '');
        sounds.push({
          id: `system:${sound}`,
          name: `🔔 ${name}`,
          path: `${systemDir}/${sound}`,
          type: 'system',
        });
      }
    }

    const customSounds = listSoundFiles();
    for (const sound of customSounds) {
      const name = sound.replace(/\.(aiff|aif|wav|mp3|m4a|ogg)$/i, '');
      sounds.push({
        id: `custom:${sound}`,
        name: `🎵 ${name}`,
        path: `${SOUNDS_DIR}/${sound}`,
        type: 'custom',
      });
    }

    return sounds;
  });

  ipcMain.handle('sound:play', (_event, soundId: string) => {
    if (!soundId || soundId === 'none') return { success: true };

    const safeSegment = (v: string): string | null =>
      (!v || v.includes('/') || v.includes('\\') || v.includes('..')) ? null : v;

    let soundPath = '';
    if (soundId === 'default') {
      if (process.platform === 'darwin') {
        soundPath = `${getMacOSSystemSoundsDir()}/Glass.aiff`;
      }
    } else if (soundId.startsWith('system:')) {
      const fileName = safeSegment(soundId.replace('system:', ''));
      if (!fileName) return { success: false, error: 'Invalid sound' };
      soundPath = `${getMacOSSystemSoundsDir()}/${fileName}`;
    } else if (soundId.startsWith('custom:')) {
      const fileName = safeSegment(soundId.replace('custom:', ''));
      if (!fileName) return { success: false, error: 'Invalid sound' };
      soundPath = `${SOUNDS_DIR}/${fileName}`;
    }

    if (!soundPath) return { success: false, error: 'Invalid sound' };
    try {
      if (process.platform === 'darwin') {
        const child = spawn('afplay', [soundPath], { stdio: 'ignore' });
        child.unref();
        return { success: true };
      } else if (process.platform === 'win32') {
        const ext = extname(soundPath).toLowerCase();
        if (ext === '.wav' || ext === '.wave') {
          const escapedPath = soundPath.replace(/'/g, "''");
          const child = spawn('powershell', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${escapedPath}').PlaySync()`], { stdio: 'ignore', windowsHide: true });
          child.unref();
          return { success: true };
        }
        return { success: false, error: 'Only .wav files supported on Windows' };
      } else {
        // Linux: try paplay, fallback to aplay
        const child = spawn('paplay', [soundPath], { stdio: 'ignore' });
        child.on('error', () => {
          const fallback = spawn('aplay', [soundPath], { stdio: 'ignore' });
          fallback.unref();
        });
        child.unref();
        return { success: true };
      }
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  /** notify:show — 主进程发送系统通知, 跟 app identity 绑定. */
  ipcMain.handle('notify:show', (_event, opts: { title?: string; body?: string; silent?: boolean }) => {
    if (!Notification.isSupported()) {
      return { ok: false, error: 'Notification not supported on this platform' };
    }
    try {
      const title = opts.title || app.getName() || 'Neox';
      const body = opts.body || '';
      const n = new Notification({
        title,
        body,
        silent: opts.silent !== false,  /* 默认 silent — 我们自己用 playSound 出声, 不走系统铃避免双重 */
      });
      n.show();
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('config:get-java-debug-status', async () => {
    return await configService.getJavaDebugStatus();
  });

  ipcMain.handle('config:download-java-debug-jar', async () => {
    return await configService.downloadJavaDebugJar();
  });
}
