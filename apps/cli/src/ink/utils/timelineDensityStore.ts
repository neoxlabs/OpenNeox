/**
 * Timeline density 持久化 —— 存 ~/.neox/cli-prefs.json
 *
 * 单文件只放 CLI 渲染偏好,不污染 ~/.neox/config.json(那是 provider/model 等配置)。
 * 读写 fire-and-forget,任何错误都不影响当前 session 使用默认值 'medium'。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

export type TimelineDensity = 'full' | 'medium' | 'compact';

const PREFS_DIR = path.join(os.homedir(), NEOX_HOME_DIRNAME);
const PREFS_PATH = path.join(PREFS_DIR, 'cli-prefs.json');
const DEFAULT_DENSITY: TimelineDensity = 'medium';

function readPrefs(): Record<string, any> {
  try {
    if (!fs.existsSync(PREFS_PATH)) return {};
    const raw = fs.readFileSync(PREFS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function writePrefs(prefs: Record<string, any>): void {
  try {
    if (!fs.existsSync(PREFS_DIR)) fs.mkdirSync(PREFS_DIR, { recursive: true });
    fs.writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2), 'utf8');
  } catch {
    // 忽略 — 持久化失败不影响 session 使用
  }
}

export function loadTimelineDensity(): TimelineDensity {
  const prefs = readPrefs();
  const d = prefs.timelineDensity;
  if (d === 'full' || d === 'medium' || d === 'compact') return d;
  return DEFAULT_DENSITY;
}

export function persistTimelineDensity(density: TimelineDensity): void {
  const prefs = readPrefs();
  prefs.timelineDensity = density;
  writePrefs(prefs);
}
