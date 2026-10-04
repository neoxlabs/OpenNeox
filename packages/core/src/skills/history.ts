/**
 * SkillHistoryTracker - 技能执行历史记录
 *
 * 使用 ~/.neox/skill-history.json 持久化存储执行记录
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

export interface SkillHistoryEntry {
  id: string;
  skillId: string;
  timestamp: number;
  status: 'success' | 'error';
  duration: number;
  args?: string;
  error?: string;
}

const MAX_HISTORY_ENTRIES = 200;

function getHistoryPath(): string {
  return path.join(os.homedir(), NEOX_HOME_DIRNAME, 'skill-history.json');
}

/**
 * 读取执行历史
 */
export function readHistory(): SkillHistoryEntry[] {
  try {
    const filePath = getHistoryPath();
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * 写入执行历史（截断到最近 MAX_HISTORY_ENTRIES 条）
 */
function writeHistory(entries: SkillHistoryEntry[]): void {
  try {
    const filePath = getHistoryPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const trimmed = entries.slice(-MAX_HISTORY_ENTRIES);
    fs.writeFileSync(filePath, JSON.stringify(trimmed, null, 2), 'utf-8');
  } catch {
    // 静默失败 — 历史记录不是关键功能
  }
}

/**
 * 记录一次技能执行
 */
export function recordExecution(entry: Omit<SkillHistoryEntry, 'id'>): void {
  const history = readHistory();
  const id = `${entry.skillId}-${entry.timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  history.push({ ...entry, id });
  writeHistory(history);
}

/**
 * 清空执行历史
 */
export function clearHistory(): void {
  writeHistory([]);
}
