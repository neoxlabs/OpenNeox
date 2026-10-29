/**
 * readfile System - Utility Functions
 * 智能读取系统工具函数
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';

/**
 * 计算文件内容的哈希值
 */
export function computeHash(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

/**
 * 检查文件是否存在
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 确保目录存在
 */
export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error: any) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

/** Split text into lines while treating one terminal newline as a terminator.
 * Interior empty lines and repeated terminal newlines remain represented. */
export function splitContentLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 读取文件的指定行范围
 */
export async function readLines(
  filePath: string,
  startLine: number,
  endLine: number
): Promise<{ lines: string[]; totalLines: number }> {
  const content = await fs.readFile(filePath, 'utf-8');
  const allLines = splitContentLines(content);
  const totalLines = allLines.length;

  // 转换为 0-indexed
  const start = Math.max(0, startLine - 1);
  const end = Math.min(allLines.length, endLine);

  return {
    lines: allLines.slice(start, end),
    totalLines,
  };
}

/**
 * 格式化行内容 (带行号)
 */
export function formatLinesWithNumbers(
  lines: string[],
  startLine: number
): string {
  return lines
    .map((line, i) => `${String(startLine + i).padStart(6)} │ ${line}`)
    .join('\n');
}

/**
 * 提取模块名称
 */
export function extractModule(filePath: string, workspacePath: string): string {
  const relPath = path.relative(workspacePath, filePath);
  const parts = relPath.split(path.sep);

  // 寻找源码目录后的第一个目录作为模块名
  const srcIndex = parts.findIndex(p =>
    ['src', 'lib', 'app', 'core', 'packages', 'modules'].includes(p)
  );

  if (srcIndex >= 0 && srcIndex + 1 < parts.length) {
    return parts[srcIndex + 1];
  }

  // 如果没有源码目录，返回第一个目录
  return parts[0] || 'root';
}

/**
 * 获取文件语言类型
 */
export function getLanguageFromPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();

  const langMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.java': 'java',
    '.go': 'go',
    '.rs': 'rust',
    '.c': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.scala': 'scala',
    '.vue': 'vue',
    '.svelte': 'svelte',
  };

  return langMap[ext] || null;
}

/**
 * 智能括号匹配 - 找到代码块的结束位置
 */
export function findBlockEnd(
  lines: string[],
  startIdx: number,
  openChars = '{([',
  closeChars = '})]'
): number {
  const stack: string[] = [];
  let started = false;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];

    for (const char of line) {
      const openIndex = openChars.indexOf(char);
      const closeIndex = closeChars.indexOf(char);

      if (openIndex !== -1) {
        stack.push(closeChars[openIndex]);
        started = true;
      } else if (closeIndex !== -1) {
        if (stack.length > 0 && stack[stack.length - 1] === char) {
          stack.pop();
        }
      }
    }

    // 如果已经开始且栈为空，说明找到了匹配的结束位置
    if (started && stack.length === 0) {
      return i + 1; // 返回 1-indexed 行号
    }
  }

  // 没找到匹配的结束，返回合理的默认值（扩大到 500 行）
  return Math.min(startIdx + 500, lines.length);
}

/**
 * 向上查找代码块的开始位置 (找到函数/类定义的开头)
 */
export function findBlockStart(
  lines: string[],
  matchIdx: number,
  patterns: string[] = [
    '^\\s*(export\\s+)?(async\\s+)?function\\s+',
    '^\\s*(export\\s+)?class\\s+',
    '^\\s*(export\\s+)?(const|let|var)\\s+\\w+\\s*=\\s*(async\\s+)?\\(',
    '^\\s*(export\\s+)?(const|let|var)\\s+\\w+\\s*=\\s*(async\\s+)?function',
    '^\\s*(public|private|protected|static|async)*\\s*\\w+\\s*\\(',
    '^\\s*def\\s+',  // Python
    '^\\s*class\\s+', // Python
    '^\\s*func\\s+',  // Go
    '^\\s*fn\\s+',    // Rust
  ]
): number {
  const regexes = patterns.map(p => new RegExp(p));

  // 从匹配行向上搜索
  for (let i = matchIdx; i >= 0; i--) {
    const line = lines[i];

    // 检查是否是定义的开头
    for (const regex of regexes) {
      if (regex.test(line)) {
        return i;
      }
    }

    // 如果遇到空行或顶层语句，停止搜索
    if (i < matchIdx && line.trim() === '') {
      // 检查空行之前是否有装饰器或注释
      const prevNonEmpty = lines.slice(0, i).reverse().findIndex(l => l.trim() !== '');
      if (prevNonEmpty >= 0) {
        const prevLine = lines[i - 1 - prevNonEmpty];
        if (!prevLine.trim().startsWith('@') && !prevLine.trim().startsWith('#') && !prevLine.trim().startsWith('//') && !prevLine.trim().startsWith('/*')) {
          break;
        }
      }
    }
  }

  // 默认返回匹配行上面几行
  return Math.max(0, matchIdx - 5);
}

/**
 * 计算两个字符串的相似度 (用于模糊匹配)
 */
export function similarity(s1: string, s2: string): number {
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;

  if (longer.length === 0) return 1.0;

  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

/**
 * 计算编辑距离
 */
function levenshteinDistance(s1: string, s2: string): number {
  const m = s1.length;
  const n = s2.length;

  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,     // 删除
          dp[i][j - 1] + 1,     // 插入
          dp[i - 1][j - 1] + 1  // 替换
        );
      }
    }
  }

  return dp[m][n];
}

/**
 * 清理 JSON 字符串中的非法字符
 */
export function sanitizeForJson(content: string): string {
  // 移除 null 字符和其他控制字符 (保留换行和制表符)
  return content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * 防抖函数
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      func(...args);
    }, wait);
  };
}

/**
 * 节流函数
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;

  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
  };
}

/**
 * formatLinesWithNumbers 的确定性逆运算 —— 拿回无行号原文。
 * 格式: `<padStart(6)> │ <line>` (跟 formatLinesWithNumbers 严格对应, 改一处必须改另一处)。
 *
 * 供会话恢复重建读账本用 (ledgerRebuild): 要把"当时展示给模型的带行号输出"跟磁盘原文比对,
 * 必须先把行号剥掉。tools.ts 里另有一份同名私有实现, 保持一致。
 */
export function stripLineNumbersForLedger(numbered: string): string {
  return numbered.split('\n').map((l) => l.replace(/^ *\d+ │ /, '')).join('\n');
}
