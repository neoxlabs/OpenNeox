/**
 * SearchBar - Ctrl+F 搜索 Timeline 内容
 *
 * 在 BottomBar 中替代 InputLine 显示搜索框，
 * 搜索 staticEntries 的 text/details 内容。
 * n/N 跳转匹配项，ESC 退出搜索。
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput } from '../../../vendor/ink/src/index.js';
import type { TimelineEntry } from '../InkRuntime.js';

export interface SearchMatch {
  entryId: number;
  entryIndex: number;
  /** 匹配的文本片段（上下文） */
  snippet: string;
  /** entry 类型 */
  type: string;
}

export interface SearchBarProps {
  entries: TimelineEntry[];
  onClose: () => void;
  /** 跳转到匹配项时输出提示 */
  onJumpToMatch?: (match: SearchMatch) => void;
}

/**
 * 在 entries 中搜索关键词
 */
function searchEntries(entries: TimelineEntry[], query: string): SearchMatch[] {
  if (!query || query.length < 2) return [];

  const lowerQuery = query.toLowerCase();
  const matches: SearchMatch[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const searchableTexts: string[] = [];

    if (entry.text) searchableTexts.push(entry.text);
    if (entry.details) searchableTexts.push(entry.details);
    if (entry.message) {
      const content = entry.message.content;
      if (typeof content === 'string') {
        searchableTexts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if ('text' in block && typeof block.text === 'string') {
            searchableTexts.push(block.text);
          }
        }
      }
    }

    const fullText = searchableTexts.join('\n');
    const lowerText = fullText.toLowerCase();

    if (lowerText.includes(lowerQuery)) {
      // 提取匹配上下文（前后 30 字符）
      const idx = lowerText.indexOf(lowerQuery);
      const start = Math.max(0, idx - 30);
      const end = Math.min(fullText.length, idx + query.length + 30);
      let snippet = fullText.slice(start, end).replace(/\n/g, ' ');
      if (start > 0) snippet = '...' + snippet;
      if (end < fullText.length) snippet = snippet + '...';

      matches.push({
        entryId: entry.id,
        entryIndex: i,
        snippet,
        type: entry.type,
      });
    }
  }

  return matches;
}

const SearchBarComponent: React.FC<SearchBarProps> = ({ entries, onClose, onJumpToMatch }) => {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);

  // 搜索
  useEffect(() => {
    const results = searchEntries(entries, query);
    setMatches(results);
    setCurrentIndex(results.length > 0 ? 0 : -1);
  }, [query, entries]);

  // 跳转通知
  useEffect(() => {
    if (matches.length > 0 && currentIndex >= 0 && onJumpToMatch) {
      onJumpToMatch(matches[currentIndex]);
    }
  }, [currentIndex, matches, onJumpToMatch]);

  useInput((input, key) => {
    // ESC 退出搜索
    if (key.escape) {
      onClose();
      return;
    }

    // Enter / n → 下一个匹配
    if (key.return || (input === 'n' && !key.shift && !key.ctrl)) {
      if (matches.length > 0) {
        setCurrentIndex(prev => (prev + 1) % matches.length);
      }
      if (key.return) return;
    }

    // N (shift+n) → 上一个匹配
    if (input === 'N' || (input === 'n' && key.shift)) {
      if (matches.length > 0) {
        setCurrentIndex(prev => (prev - 1 + matches.length) % matches.length);
      }
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      setQuery(prev => prev.slice(0, -1));
      return;
    }

    // Ctrl+U → 清空
    if (input === 'u' && key.ctrl) {
      setQuery('');
      return;
    }

    // 普通字符输入
    if (input && !key.ctrl && !key.meta) {
      setQuery(prev => prev + input);
    }
  });

  const current = matches.length > 0 && currentIndex >= 0 ? matches[currentIndex] : null;

  return (
    <Box flexDirection="column">
      {/* 搜索输入行 */}
      <Box>
        <Text color="yellow" bold>/ </Text>
        <Text>{query}</Text>
        <Text dimColor>│</Text>
        {matches.length > 0 ? (
          <Text color="green"> {currentIndex + 1}/{matches.length} matches</Text>
        ) : query.length >= 2 ? (
          <Text color="red"> no matches</Text>
        ) : (
          <Text dimColor> type to search (min 2 chars)</Text>
        )}
        <Text dimColor>  [n/N: next/prev, ESC: close]</Text>
      </Box>

      {/* 当前匹配预览 */}
      {current && (
        <Box marginLeft={2}>
          <Text dimColor>[{current.type} #{current.entryId}] </Text>
          <Text wrap="truncate">{current.snippet}</Text>
        </Box>
      )}
    </Box>
  );
};

export const SearchBar = React.memo(SearchBarComponent);
