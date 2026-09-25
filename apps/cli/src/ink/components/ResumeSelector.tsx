import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from '../../../vendor/ink/src/index.js';
import { formatTimeAgo } from '../../utils/format.js';

export interface ResumeSessionRow {
  sessionId: string;
  createdAt: Date;
  updatedAt: Date;
  itemCount: number;
  workspaceName: string;
  branch: string;
  summary: string;
}

export interface ResumeSelectorProps {
  sessions: ResumeSessionRow[];
  onResume: (sessionId: string) => void;
  onNew: () => void;
}

/** 定宽列填充/截断 (按显示宽度近似, 中文按 1 处理够用) */
function pad(s: string, width: number): string {
  const str = s ?? '';
  if (str.length > width) return str.slice(0, width - 1) + '…';
  return str + ' '.repeat(width - str.length);
}

/**
 * Resume 会话选择器 — 采用 兼容格式/兼容格式 的恢复界面。
 *   多列 (Updated / Msgs / Branch / Conversation 摘要) + 输入即搜索 + ↑↓ 浏览 + Enter 恢复 + Esc 新建。
 */
export const ResumeSelector: React.FC<ResumeSelectorProps> = ({ sessions, onResume, onNew }) => {
  const termWidth = Math.max(60, process.stdout.columns ?? 80);
  const termRows = Math.max(8, process.stdout.rows ?? 24);

  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);

  // 过滤 (摘要/workspace/branch/id)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      s.summary.toLowerCase().includes(q) ||
      s.workspaceName.toLowerCase().includes(q) ||
      s.branch.toLowerCase().includes(q) ||
      s.sessionId.toLowerCase().includes(q),
    );
  }, [sessions, query]);

  // index 越界纠正
  const safeIndex = filtered.length === 0 ? 0 : Math.min(index, filtered.length - 1);

  // 可见窗口 (留出标题/表头/提示约 7 行)
  const maxVisible = Math.max(3, termRows - 7);
  const scrollOffset = Math.max(0, Math.min(safeIndex - Math.floor(maxVisible / 2), Math.max(0, filtered.length - maxVisible)));
  const visible = filtered.slice(scrollOffset, scrollOffset + maxVisible);

  // 列宽
  const W_TIME = 12;
  const W_MSGS = 5;
  const W_BRANCH = 14;
  const W_FIXED = 2 /*指针*/ + W_TIME + 1 + W_MSGS + 1 + W_BRANCH + 1;
  const W_SUMMARY = Math.max(20, termWidth - W_FIXED - 2);

  useInput((input, key) => {
    if (key.escape) { onNew(); return; }
    if (key.return) {
      if (filtered.length > 0) onResume(filtered[safeIndex].sessionId);
      else onNew();
      return;
    }
    if (key.upArrow) { setIndex((i) => Math.max(0, Math.min(i, filtered.length - 1) - 1)); return; }
    if (key.downArrow) { setIndex((i) => Math.min(filtered.length - 1, i + 1)); return; }
    if (key.backspace || key.delete) { setQuery((q) => q.slice(0, -1)); setIndex(0); return; }
    // 普通可打印字符 → 加入搜索
    if (input && !key.ctrl && !key.meta && input >= ' ') { setQuery((q) => q + input); setIndex(0); return; }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* 标题 */}
      <Box>
        <Text color="cyan" bold>Resume a previous session</Text>
        <Text dimColor>{`   ${filtered.length}/${sessions.length}`}</Text>
      </Box>
      {/* 搜索行 */}
      <Box>
        <Text dimColor>Search: </Text>
        <Text>{query}</Text>
        <Text inverse> </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{'  ' + pad('Updated', W_TIME) + ' ' + pad('Msgs', W_MSGS) + ' ' + pad('Branch', W_BRANCH) + ' ' + 'Conversation'}</Text>
      </Box>

      {/* 列表 */}
      {filtered.length === 0 ? (
        <Box marginTop={1}><Text dimColor>  无匹配会话 — Enter/Esc 新建会话</Text></Box>
      ) : (
        visible.map((s, i) => {
          const actualIndex = scrollOffset + i;
          const selected = actualIndex === safeIndex;
          const time = pad(formatTimeAgo(s.updatedAt), W_TIME);
          const msgs = pad(String(s.itemCount), W_MSGS);
          const branch = pad(s.branch || '-', W_BRANCH);
          const summary = pad(s.summary || `(${s.sessionId.slice(0, 8)})`, W_SUMMARY);
          return (
            <Box key={s.sessionId}>
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {selected ? '❯ ' : '  '}
                <Text dimColor={!selected}>{time} </Text>
                <Text dimColor={!selected}>{msgs} </Text>
                <Text color={selected ? 'cyan' : 'magenta'}>{branch} </Text>
                <Text>{summary}</Text>
              </Text>
            </Box>
          );
        })
      )}

      {/* 底部提示 */}
      <Box marginTop={1}>
        <Text dimColor>  ↑↓ browse · enter resume · esc 新建 · 输入即搜索</Text>
      </Box>
    </Box>
  );
};
