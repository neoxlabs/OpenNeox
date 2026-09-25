/**
 * Project Memory - 项目级记忆文件（类似 Claude Code 的 CLAUDE.md）
 *
 * 查找顺序：
 * 1. {workDir}/.neox/project.md
 * 2. {workDir}/NEOX.md
 *
 * 内容会注入到 system prompt 中，让 agent 了解项目约定。
 */

import fs from 'fs/promises';
import path from 'path';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

const CANDIDATES = [
  '.neox/project.md',
  'NEOX.md',
];

const MAX_CHARS = 6000;

/**
 * 读取项目记忆文件，返回格式化后的内容（或 null）
 */
export async function loadProjectMemory(workDir: string): Promise<string | null> {
  for (const candidate of CANDIDATES) {
    const filePath = path.join(workDir, candidate);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      if (!content.trim()) continue;

      const trimmed = content.length > MAX_CHARS
        ? content.slice(0, MAX_CHARS) + '\n...(truncated)'
        : content;

      cliLogger.info('PROJECT_MEMORY', `Loaded from ${candidate}`, {
        chars: content.length,
      });

      return `\n## 项目记忆 (${candidate})\n${trimmed}`;
    } catch {
      // file not found, try next
    }
  }
  return null;
}
