import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { isWSL, wslToWindowsPath } from '@neoxlabs/platform/platform/platformDetect.js';
import {
  MACOS_SYSTEM_SOUNDS_DIR,
  listSoundFiles,
  listMacOSSystemSounds,
  getMacOSSystemSoundsDir,
} from '@neoxlabs/platform/platform/sound.js';
import { SOUNDS_DIR, type CompletionAlertConfig, type NeoxConfig, type UserLanguage } from '@neoxlabs/platform/utils/config.js';
import { t } from '../i18n/index.js';

// 对外 re-export · 保持历史 import 路径向后兼容
export { listSoundFiles, listMacOSSystemSounds, getMacOSSystemSoundsDir };

export const DEFAULT_COMPLETION_SOUND = 'complete.wav';
const MACOS_DEFAULT_SOUND = 'Glass.aiff'; // 清脆的提示音

export function getCompletionAlertConfig(config: NeoxConfig): Required<CompletionAlertConfig> {
  return {
    soundEnabled: config.completionAlerts?.soundEnabled ?? false,
    soundFile: config.completionAlerts?.soundFile ?? '',
    notifyEnabled: config.completionAlerts?.notifyEnabled ?? false,
  };
}

export function resolveSoundPath(soundFile?: string): string | null {
  if (soundFile) {
    const candidate = path.isAbsolute(soundFile) ? soundFile : path.join(SOUNDS_DIR, soundFile);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  const defaultPath = path.join(SOUNDS_DIR, DEFAULT_COMPLETION_SOUND);
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }
  const available = listSoundFiles();
  if (available.length > 0) {
    return path.join(SOUNDS_DIR, available[0]);
  }
  // macOS: 使用系统声音作为回退
  if (process.platform === 'darwin') {
    const macDefaultPath = path.join(MACOS_SYSTEM_SOUNDS_DIR, MACOS_DEFAULT_SOUND);
    if (fs.existsSync(macDefaultPath)) {
      return macDefaultPath;
    }
  }
  return null;
}

export function triggerCompletionAlerts(
  config: CompletionAlertConfig,
  options?: { language?: UserLanguage; summary?: { durationMs?: number } }
): void {
  const title = 'Neox CLI';
  const messageBase = t().notify.taskComplete;
  const durationMs = options?.summary?.durationMs;
  const message = durationMs ? `${messageBase} - ${(durationMs / 1000).toFixed(1)}s` : messageBase;

  if (config.notifyEnabled) {
    sendNotification(title, message);
  }

  if (config.soundEnabled) {
    const soundPath = resolveSoundPath(config.soundFile);
    playSound(soundPath);
  }
}

function spawnDetached(command: string, args: string[], onError?: () => void): void {
  try {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', (error) => {
      if (process.env.CLI_DEBUG) {
        cliLogger.debug('ALERT', `Failed to spawn ${command}`, { error });
      }
      if (onError) {
        onError();
      }
    });
    child.unref();
  } catch (error) {
    if (process.env.CLI_DEBUG) {
      cliLogger.debug('ALERT', `Failed to execute ${command}`, { error });
    }
    if (onError) {
      onError();
    }
  }
}

function terminalBell(): void {
  try {
    process.stdout.write('\u0007');
  } catch {
    // Ignore terminal bell failures
  }
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapePowerShellString(value: string): string {
  return value.replace(/'/g, "''");
}

function playSound(soundPath: string | null): void {
  if (!soundPath || !fs.existsSync(soundPath)) {
    terminalBell();
    return;
  }

  if (process.platform === 'darwin') {
    spawnDetached('afplay', [soundPath], terminalBell);
    return;
  }

  // WSL: Use Windows PowerShell to play sound
  if (isWSL()) {
    const ext = path.extname(soundPath).toLowerCase();
    if (ext !== '.wav' && ext !== '.wave') {
      terminalBell();
      return;
    }
    const windowsPath = wslToWindowsPath(soundPath);
    const escapedPath = escapePowerShellString(windowsPath);
    const command = `(New-Object Media.SoundPlayer '${escapedPath}').PlaySync()`;
    spawnDetached('powershell.exe', ['-NoProfile', '-Command', command], terminalBell);
    return;
  }

  if (process.platform === 'linux') {
    spawnDetached('paplay', [soundPath], () => {
      spawnDetached('aplay', [soundPath], terminalBell);
    });
    return;
  }

  if (process.platform === 'win32') {
    const ext = path.extname(soundPath).toLowerCase();
    if (ext !== '.wav' && ext !== '.wave') {
      terminalBell();
      return;
    }
    const escapedPath = escapePowerShellString(soundPath);
    const command = `(New-Object Media.SoundPlayer '${escapedPath}').PlaySync()`;
    spawnDetached('powershell', ['-NoProfile', '-Command', command], terminalBell);
    return;
  }

  terminalBell();
}

function sendNotification(title: string, message: string): void {
  if (process.platform === 'darwin') {
    const script = `display notification "${escapeAppleScriptString(message)}" with title "${escapeAppleScriptString(title)}"`;
    spawnDetached('osascript', ['-e', script]);
    return;
  }

  // WSL: Use PowerShell toast notification or wsl-notify-send
  if (isWSL()) {
    // Try wsl-notify-send first (if installed), fallback to PowerShell toast
    const escapedTitle = escapePowerShellString(title);
    const escapedMessage = escapePowerShellString(message);
    // PowerShell toast notification (requires Windows 10+)
    const toastScript = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$template = '<toast><visual><binding template="ToastText02"><text id="1">${escapedTitle}</text><text id="2">${escapedMessage}</text></binding></visual></toast>'
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Neox CLI').Show($toast)
`;
    spawnDetached('powershell.exe', ['-NoProfile', '-Command', toastScript]);
    return;
  }

  if (process.platform === 'linux') {
    spawnDetached('notify-send', [title, message]);
    return;
  }

  if (process.platform === 'win32') {
    if (process.env.CLI_DEBUG) {
      cliLogger.debug('ALERT', 'Notification not supported on Windows without extra tools');
    }
  }
}
