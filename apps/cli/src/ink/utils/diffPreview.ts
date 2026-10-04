/**
 * CLI Diff 预览
 *
 * Render a colored unified diff after edit and write operations so file
 * changes remain inspectable in the terminal.
 */

import chalk from 'chalk';

// ==================== 类型定义 ====================

export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header';
  content: string;
}

export interface DiffPreviewOptions {
  /** 最大显示行数 */
  maxLines?: number;
  /** 上下文行数 */
  contextLines?: number;
  /** 是否显示行号 */
  showLineNumbers?: boolean;
  /** 是否为新文件创建 */
  isNewFile?: boolean;
}

// ==================== Unified Diff 生成 ====================

/**
 * 从旧/新内容生成 unified diff 行
 *
 * 轻量实现，不依赖外部 diff 库。
 * 使用 LCS（最长公共子序列）算法做行级 diff。
 */
export function generateDiffLines(
  oldContent: string,
  newContent: string,
  filePath: string,
  options: DiffPreviewOptions = {},
): DiffLine[] {
  const { contextLines = 3, maxLines = 40, isNewFile = false } = options;

  if (isNewFile) {
    return generateNewFileDiff(newContent, filePath, maxLines);
  }

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // LCS-based diff
  const edits = computeEdits(oldLines, newLines);

  if (edits.length === 0) {
    return [{ type: 'header', content: `No changes in ${filePath}` }];
  }

  // 生成 unified diff 格式
  const result: DiffLine[] = [];
  result.push({ type: 'header', content: `--- a/${filePath}` });
  result.push({ type: 'header', content: `+++ b/${filePath}` });

  // 按 hunk 分组
  const hunks = groupIntoHunks(edits, oldLines, newLines, contextLines);

  for (const hunk of hunks) {
    if (result.length >= maxLines) {
      result.push({ type: 'header', content: `... (${hunks.length - hunks.indexOf(hunk)} more hunks truncated)` });
      break;
    }

    result.push({
      type: 'header',
      content: `@@ -${hunk.oldStart + 1},${hunk.oldCount} +${hunk.newStart + 1},${hunk.newCount} @@`,
    });

    for (const line of hunk.lines) {
      if (result.length >= maxLines) break;
      result.push(line);
    }
  }

  return result;
}

/**
 * 新文件 diff — 全部是 add
 */
function generateNewFileDiff(content: string, filePath: string, maxLines: number): DiffLine[] {
  const lines = content.split('\n');
  const result: DiffLine[] = [
    { type: 'header', content: `+++ b/${filePath} (new file)` },
  ];

  const showLines = Math.min(lines.length, maxLines - 2);
  for (let i = 0; i < showLines; i++) {
    result.push({ type: 'add', content: lines[i] });
  }

  if (lines.length > showLines) {
    result.push({ type: 'header', content: `... (${lines.length - showLines} more lines)` });
  }

  return result;
}

// ==================== 终端渲染 ====================

/**
 * Word-level 行内高亮：找出 remove/add 行对中变化的部分
 * 返回带有 chalk 高亮的字符串
 */
function highlightInlineChanges(removeLine: string, addLine: string): { remove: string; add: string } {
  // 找公共前缀
  let prefixLen = 0;
  while (prefixLen < removeLine.length && prefixLen < addLine.length && removeLine[prefixLen] === addLine[prefixLen]) {
    prefixLen++;
  }
  // 找公共后缀
  let suffixLen = 0;
  while (
    suffixLen < removeLine.length - prefixLen &&
    suffixLen < addLine.length - prefixLen &&
    removeLine[removeLine.length - 1 - suffixLen] === addLine[addLine.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const removeChanged = removeLine.slice(prefixLen, removeLine.length - suffixLen);
  const addChanged = addLine.slice(prefixLen, addLine.length - suffixLen);
  const prefix = removeLine.slice(0, prefixLen);
  const removeSuffix = removeLine.slice(removeLine.length - suffixLen);
  const addSuffix = addLine.slice(addLine.length - suffixLen);

  // 只有在变化部分足够短时才高亮（避免整行高亮没意义）
  if (removeChanged.length > removeLine.length * 0.8 && addChanged.length > addLine.length * 0.8) {
    return {
      remove: chalk.red(`- ${removeLine}`),
      add: chalk.green(`+ ${addLine}`),
    };
  }

  return {
    remove: chalk.red('- ') + chalk.red(prefix) + chalk.red.bold.underline(removeChanged) + chalk.red(removeSuffix),
    add: chalk.green('+ ') + chalk.green(prefix) + chalk.green.bold.underline(addChanged) + chalk.green(addSuffix),
  };
}

/**
 * 将 diff 行渲染为彩色终端文本
 */
export function renderDiffToTerminal(diffLines: DiffLine[], options?: {
  compact?: boolean;
  /** P1: 启用 word-level 行内高亮 */
  inlineHighlight?: boolean;
}): string {
  if (diffLines.length === 0) return '';

  const useInline = options?.inlineHighlight ?? true;
  const lines: string[] = [];

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];

    switch (line.type) {
      case 'add': {
        // 尝试 word-level 高亮：找前一行是否是 remove（形成 remove/add 对）
        if (useInline && i > 0 && diffLines[i - 1].type === 'remove') {
          const removeLine = diffLines[i - 1].content;
          const addLine = line.content;
          const { add } = highlightInlineChanges(removeLine, addLine);
          // 替换上一行的 remove 渲染
          const { remove } = highlightInlineChanges(removeLine, addLine);
          lines[lines.length - 1] = remove;
          lines.push(add);
        } else {
          lines.push(chalk.green(`+ ${line.content}`));
        }
        break;
      }
      case 'remove':
        lines.push(chalk.red(`- ${line.content}`));
        break;
      case 'context':
        if (!options?.compact) {
          lines.push(chalk.gray(`  ${line.content}`));
        }
        break;
      case 'header':
        lines.push(chalk.cyan(line.content));
        break;
    }
  }

  return lines.join('\n');
}

/**
 * 生成紧凑的 diff 摘要（用于 StatusLine 或日志）
 */
export function diffSummary(diffLines: DiffLine[]): string {
  let adds = 0;
  let removes = 0;
  for (const line of diffLines) {
    if (line.type === 'add') adds++;
    if (line.type === 'remove') removes++;
  }

  if (adds === 0 && removes === 0) return 'no changes';

  const parts: string[] = [];
  if (adds > 0) parts.push(chalk.green(`+${adds}`));
  if (removes > 0) parts.push(chalk.red(`-${removes}`));
  return parts.join(' ');
}

// ==================== Diff 算法 ====================

interface Edit {
  type: 'add' | 'remove' | 'equal';
  oldIndex: number;
  newIndex: number;
  line: string;
}

/**
 * 计算两个行数组的编辑序列
 * Myers diff 简化版 — O(ND) 复杂度，N=行数，D=差异数
 */
function computeEdits(oldLines: string[], newLines: string[]): Edit[] {
  const n = oldLines.length;
  const m = newLines.length;

  // 优化：如果完全相同
  if (n === m && oldLines.every((line, i) => line === newLines[i])) {
    return [];
  }

  // 简化实现：逐行对比 + 贪心匹配
  // 对于代码 diff，这个简化版在绝大多数场景下足够准确
  const edits: Edit[] = [];
  let oldIdx = 0;
  let newIdx = 0;

  while (oldIdx < n && newIdx < m) {
    if (oldLines[oldIdx] === newLines[newIdx]) {
      edits.push({ type: 'equal', oldIndex: oldIdx, newIndex: newIdx, line: oldLines[oldIdx] });
      oldIdx++;
      newIdx++;
    } else {
      // 向前看：新内容中是否有当前旧行？
      const lookAhead = 5;
      let foundInNew = -1;
      let foundInOld = -1;

      for (let j = newIdx + 1; j < Math.min(newIdx + lookAhead, m); j++) {
        if (newLines[j] === oldLines[oldIdx]) { foundInNew = j; break; }
      }
      for (let j = oldIdx + 1; j < Math.min(oldIdx + lookAhead, n); j++) {
        if (oldLines[j] === newLines[newIdx]) { foundInOld = j; break; }
      }

      if (foundInNew >= 0 && (foundInOld < 0 || foundInNew - newIdx <= foundInOld - oldIdx)) {
        // 新内容有新增行
        for (let j = newIdx; j < foundInNew; j++) {
          edits.push({ type: 'add', oldIndex: oldIdx, newIndex: j, line: newLines[j] });
        }
        newIdx = foundInNew;
      } else if (foundInOld >= 0) {
        // 旧内容有被删除行
        for (let j = oldIdx; j < foundInOld; j++) {
          edits.push({ type: 'remove', oldIndex: j, newIndex: newIdx, line: oldLines[j] });
        }
        oldIdx = foundInOld;
      } else {
        // 替换：一删一加
        edits.push({ type: 'remove', oldIndex: oldIdx, newIndex: newIdx, line: oldLines[oldIdx] });
        edits.push({ type: 'add', oldIndex: oldIdx, newIndex: newIdx, line: newLines[newIdx] });
        oldIdx++;
        newIdx++;
      }
    }
  }

  // 剩余行
  while (oldIdx < n) {
    edits.push({ type: 'remove', oldIndex: oldIdx, newIndex: newIdx, line: oldLines[oldIdx] });
    oldIdx++;
  }
  while (newIdx < m) {
    edits.push({ type: 'add', oldIndex: oldIdx, newIndex: newIdx, line: newLines[newIdx] });
    newIdx++;
  }

  return edits;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

/**
 * 将编辑序列分组为 hunks（带上下文行）
 */
function groupIntoHunks(edits: Edit[], oldLines: string[], newLines: string[], contextLines: number): Hunk[] {
  // 找出所有变更位置
  const changeIndices: number[] = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i].type !== 'equal') {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return [];

  // 分组：相邻变更合并为一个 hunk
  const groups: Array<{ start: number; end: number }> = [];
  let groupStart = changeIndices[0];
  let groupEnd = changeIndices[0];

  for (let i = 1; i < changeIndices.length; i++) {
    if (changeIndices[i] - groupEnd <= contextLines * 2 + 1) {
      groupEnd = changeIndices[i];
    } else {
      groups.push({ start: groupStart, end: groupEnd });
      groupStart = changeIndices[i];
      groupEnd = changeIndices[i];
    }
  }
  groups.push({ start: groupStart, end: groupEnd });

  // 生成 hunks
  const hunks: Hunk[] = [];

  for (const group of groups) {
    const hunkStart = Math.max(0, group.start - contextLines);
    const hunkEnd = Math.min(edits.length - 1, group.end + contextLines);

    const lines: DiffLine[] = [];
    let oldCount = 0;
    let newCount = 0;
    let oldStart = 0;
    let newStart = 0;
    let firstSet = false;

    for (let i = hunkStart; i <= hunkEnd; i++) {
      const edit = edits[i];
      if (!firstSet) {
        oldStart = edit.oldIndex;
        newStart = edit.newIndex;
        firstSet = true;
      }

      switch (edit.type) {
        case 'equal':
          lines.push({ type: 'context', content: edit.line });
          oldCount++;
          newCount++;
          break;
        case 'remove':
          lines.push({ type: 'remove', content: edit.line });
          oldCount++;
          break;
        case 'add':
          lines.push({ type: 'add', content: edit.line });
          newCount++;
          break;
      }
    }

    hunks.push({ oldStart, oldCount, newStart, newCount, lines });
  }

  return hunks;
}
