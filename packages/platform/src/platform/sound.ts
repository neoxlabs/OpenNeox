/**
 * Sound file enumeration · 平台级声音资源探测
 *
 * 只负责"列出声音文件"的平台查询职能,被 CLI completionAlerts 和
 * Desktop soundJavaHandlers 共用。不涉及播放逻辑(平台差异播放在各端自处理)。
 */

import fs from 'fs';
import path from 'path';

import { SOUNDS_DIR } from '../utils/config.js';

export const SUPPORTED_SOUND_EXTENSIONS = new Set([
  '.wav',
  '.mp3',
  '.m4a',
  '.aiff',
  '.aif',
  '.ogg',
]);

/** macOS 系统声音目录 */
export const MACOS_SYSTEM_SOUNDS_DIR = '/System/Library/Sounds';

/** 列出用户配置的声音目录(Neox config 指定的 SOUNDS_DIR) */
export function listSoundFiles(): string[] {
  try {
    if (!fs.existsSync(SOUNDS_DIR)) {
      return [];
    }
    return fs
      .readdirSync(SOUNDS_DIR)
      .filter((entry) => SUPPORTED_SOUND_EXTENSIONS.has(path.extname(entry).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** 列出 macOS 系统声音(仅 darwin 平台返回结果) */
export function listMacOSSystemSounds(): string[] {
  if (process.platform !== 'darwin') {
    return [];
  }
  try {
    if (!fs.existsSync(MACOS_SYSTEM_SOUNDS_DIR)) {
      return [];
    }
    return fs
      .readdirSync(MACOS_SYSTEM_SOUNDS_DIR)
      .filter((entry) => SUPPORTED_SOUND_EXTENSIONS.has(path.extname(entry).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** 获取 macOS 系统声音目录常量 */
export function getMacOSSystemSoundsDir(): string {
  return MACOS_SYSTEM_SOUNDS_DIR;
}
