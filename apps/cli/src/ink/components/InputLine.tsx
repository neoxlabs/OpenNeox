import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from '../../../vendor/ink/src/index.js';
import { cliLogger, debugLog } from '@neoxlabs/kernel/platform/cliLogger.js';
import { pasteImageAsBase64, imageFileToBase64Data } from '../../utils/clipboardImage.js';
import { t, formatMessage } from '../../i18n/index.js';
import { NeoxTheme } from '../theme.js';
import { shouldEnableAggressiveInputCompat } from '../../../vendor/ink/src/terminal/TerminalAdapter.js';
import { isTranscriptOpen } from '../transcriptViewer.js';

const AGGRESSIVE_INPUT_COMPAT = shouldEnableAggressiveInputCompat();

// Filter terminal control/escape sequences that may leak from IME
const ANSI_ESCAPE_REGEX = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
const CONTROL_CHAR_REGEX = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

function sanitizeInputChunk(input: string): string {
  if (!input || !AGGRESSIVE_INPUT_COMPAT) return input;
  return input
    .replace(ANSI_ESCAPE_REGEX, '')
    .replace(CONTROL_CHAR_REGEX, '');
}

export interface InputLineProps {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  mask?: boolean;
  multiline?: boolean;
  completions?: string[];
  menuActive?: boolean;
  panelFocused?: boolean;
  slashMenuActive?: boolean;
  imageCount?: number;
  onCompletionStateChange?: (state: CompletionState | null) => void;
  onRemoveLastAttachment?: () => void;
  onChange: (value: string) => void;
  onSubmit: (overrideValue?: string) => void;
  onHistoryUp: () => void;
  onHistoryDown: () => void;
  onTabComplete?: (currentValue: string) => string | null;
  onPasteImage?: (imageData: { mediaType: string; data: string; name: string }) => number | null | void;
}

export interface CompletionState {
  completions: string[];
  selectedIndex: number;
  scrollOffset: number;
}

export interface CompletionMenuProps {
  state: CompletionState;
  maxVisible?: number;
}

export const CompletionMenu: React.FC<CompletionMenuProps> = ({
  state,
  maxVisible = 8,
}) => {
  const { completions, selectedIndex, scrollOffset } = state;
  if (completions.length === 0) return null;

  return (
    <Box paddingLeft={2} flexDirection="column">
      <Text color="yellow">
        {formatMessage(t().slashMenu.commandCount, { count: completions.length })}
        {completions.length > maxVisible && (
          <Text dimColor> - ↑↓ {t().ui.scrollHint}</Text>
        )}
      </Text>
      {scrollOffset > 0 && (
        <Text dimColor>  ↑ {t().ui.moreAbove}</Text>
      )}
      {completions
        .slice(scrollOffset, scrollOffset + maxVisible)
        .map((comp, i) => {
          const actualIndex = scrollOffset + i;
          const isSelected = actualIndex === selectedIndex;
          return (
            <Text key={actualIndex} color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
              {isSelected ? '❯ ' : '  '}
              {comp}
            </Text>
          );
        })}
      {scrollOffset + maxVisible < completions.length && (
        <Text dimColor>  ↓ {t().ui.moreBelow}</Text>
      )}
    </Box>
  );
};

export const InputLine: React.FC<InputLineProps> = ({
  value,
  placeholder = 'Type a message... (? for help)',
  disabled = false,
  mask = false,
  multiline = false,
  completions = [],
  menuActive = false,
  panelFocused = false,
  slashMenuActive = false,
  imageCount = 0,
  onCompletionStateChange,
  onRemoveLastAttachment,
  onChange,
  onSubmit,
  onHistoryUp,
  onHistoryDown,
  onTabComplete,
  onPasteImage,
}) => {
  const [cursorOffset, setCursorOffset] = useState(0);
  const [showCompletions, setShowCompletions] = useState(false);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [completionScrollOffset, setCompletionScrollOffset] = useState(0);
  const [cursorLine, setCursorLine] = useState(0);
  const lastInputEventAtRef = useRef(Date.now());
  const lastDropLogAtRef = useRef(0);

  let _termRows = 24;
  try {
    const so: any = process.stdout;
    if (so && so.isTTY && typeof so.rows === 'number' && so.rows > 0) _termRows = so.rows;
  } catch { /* noop */ }
  const MAX_VISIBLE_COMPLETIONS = Math.max(3, Math.min(8, _termRows - 9));

  // Calculate actual cursor position (from end)
  const cursorPosition = value.length - cursorOffset;

  const isPastingRef = useRef(false);
  const pasteBufferRef = useRef('');
  const lastPasteCheckRef = useRef(0); // 防止重复检查

  const valueRef = useRef(value);
  const cursorPositionRef = useRef(cursorPosition);

  useEffect(() => {
    valueRef.current = value;
    cursorPositionRef.current = cursorPosition;
  }, [value, cursorPosition]);

  const lines = value.split('\n');
  const isMultilineContent = lines.length > 1;

  // 计算光标所在行和列
  let charCount = 0;
  let currentLine = 0;
  let currentCol = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLength = lines[i].length + 1; // +1 for newline
    if (charCount + lineLength > cursorPosition) {
      currentLine = i;
      currentCol = cursorPosition - charCount;
      break;
    }
    charCount += lineLength;
    currentLine = i;
    currentCol = lines[i].length;
  }

  // If we set isActive=false, it will remove stdin 'readable' listener
  // This causes stdin buffer to fill up when user types during task execution
  // Leading to stdin auto-pause and freeze
  //
  // Solution: Always keep listener active, but ignore input in handler when disabled
  const inputIsActive = true;

  // Track disabled state in ref for handler to check
  const disabledRef = useRef(disabled);
  const menuActiveRef = useRef(menuActive);
  const panelFocusedRef = useRef(panelFocused);
  const slashMenuActiveRef = useRef(slashMenuActive);

  useEffect(() => {
    disabledRef.current = disabled;
    menuActiveRef.current = menuActive;
    panelFocusedRef.current = panelFocused;
    slashMenuActiveRef.current = slashMenuActive;
  }, [disabled, menuActive, panelFocused, slashMenuActive]);

  useEffect(() => {
    if (value.startsWith('/') && completions.length > 0) {
      setShowCompletions(true);
      // 重置选择和滚动
      setCompletionIndex(0);
      setCompletionScrollOffset(0);
    } else {
      setShowCompletions(false);
    }
  }, [value, completions]);

  useEffect(() => {
    if (!showCompletions || completions.length <= MAX_VISIBLE_COMPLETIONS) {
      setCompletionScrollOffset(0);
      return;
    }

    // 如果选中项在可见范围上方
    if (completionIndex < completionScrollOffset) {
      setCompletionScrollOffset(completionIndex);
    }
    // 如果选中项在可见范围下方
    else if (completionIndex >= completionScrollOffset + MAX_VISIBLE_COMPLETIONS) {
      setCompletionScrollOffset(completionIndex - MAX_VISIBLE_COMPLETIONS + 1);
    }
  }, [completionIndex, showCompletions, completions.length]);

  useEffect(() => {
    if (onCompletionStateChange) {
      if (showCompletions && completions.length > 0) {
        onCompletionStateChange({
          completions,
          selectedIndex: completionIndex,
          scrollOffset: completionScrollOffset,
        });
      } else {
        onCompletionStateChange(null);
      }
    }
  }, [showCompletions, completions, completionIndex, completionScrollOffset, onCompletionStateChange]);

  useEffect(() => {
    if (process.env.CLI_DEBUG !== '1') {
      return;
    }
    const timer = setInterval(() => {
      const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
      const idleMs = Date.now() - lastInputEventAtRef.current;
      if (idleMs < 15000) {
        return;
      }
      debugLog('INPUT_WATCH', 'No useInput events for 15s+', {
        idleMs,
        inputLength: valueRef.current.length,
        cursorPosition: cursorPositionRef.current,
        disabled: disabledRef.current,
        menuActive: menuActiveRef.current,
        slashMenuActive: slashMenuActiveRef.current,
        stdinPaused: stdin.isPaused?.(),
        stdinIsRaw: stdin.isRaw,
        stdinDestroyed: stdin.destroyed,
      });
    }, 5000);

    return () => clearInterval(timer);
  }, []);

  const insertImageTokenAtPaste = (
    imageData: { mediaType: string; data: string; name: string },
    baseValue: string,
    insertAt: number,
  ): void => {
    if (!onPasteImage) return;
    const seq = onPasteImage(imageData);
    if (typeof seq === 'number' && seq > 0) {
      const token = `[图片 #${seq}]`;
      onChange(baseValue.slice(0, insertAt) + token + baseValue.slice(insertAt));
      cliLogger.info('INPUT_LINE', `📎 inserted ${token} at cursor (${Math.round(imageData.data.length / 1024)}KB)`);
    }
  };

  useInput(
    (input, key) => {
      if (isTranscriptOpen()) return; // ctrl+o 完整记录打开时 j/k/q 不能打进输入框
      lastInputEventAtRef.current = Date.now();


      // This prevents stdin buffer from filling up and causing auto-pause
      // We MUST read stdin data even if we don't process it
      if (disabledRef.current || menuActiveRef.current || panelFocusedRef.current) {
        if (process.env.CLI_DEBUG === '1') {
          const now = Date.now();
          if (now - lastDropLogAtRef.current > 1000) {
            debugLog('INPUT_DROP', 'Input ignored due disabled/menu active', {
              disabled: disabledRef.current,
              menuActive: menuActiveRef.current,
              keyInfo: key,
              keyRaw: input,
            });
            lastDropLogAtRef.current = now;
          }
        }
        return; // Discard input, but stdin data is consumed
      }

      if (slashMenuActiveRef.current) {
        if (key.upArrow || key.downArrow || key.return || key.tab) {
          return; // 让 SlashCommandMenu 处理
        }
      }

      const isBracketedPaste = !!key.paste
        || !!(input && (input.includes('[200~') || input.includes('[201~')));
      if (isBracketedPaste) {
        const cleaned = key.paste
          ? input
          : input
            .replace(/\x1b\[200~/g, '')
            .replace(/\x1b\[201~/g, '')
            .replace(/\[200~/g, '')
            .replace(/\[201~/g, '');

        if (!cleaned) {
          /* 空粘贴 = 截图/图片 (终端只发空的 \x1b[200~\x1b[201~ 序列, 不送图片数据进 stdin) →
           * 主动读系统剪贴板的图片。这是 macOS 截图 Cmd+V 的路径 (跟 Claude Code 一致)。 */
          cliLogger.info('INPUT_LINE', 'Empty paste — reading clipboard for image');
          if (onPasteImage) {
            const insertAt = cursorPosition; const baseValue = value;
            pasteImageAsBase64().then(imageData => {
              if (imageData) insertImageTokenAtPaste(imageData, baseValue, insertAt);
            }).catch(err => cliLogger.error('INPUT_LINE', 'paste image read failed', { error: err }));
          }
          return;
        }

        const pasteLines = cleaned
          .split(/ (?=\/|[A-Za-z]:\\)/)
          .flatMap(part => part.split(/\r?\n/))
          .map(s => s.trim().replace(/\\(.)/g, '$1'))
          .filter(Boolean);
        const allImagePaths = pasteLines.length > 0
          && pasteLines.every(p => /\.(png|jpe?g|gif|webp|bmp|tiff?|svg)$/i.test(p));
        if (allImagePaths && onPasteImage) {
          let baseValue = value;
          let insertAt = cursorPosition;
          let anyOk = false;
          let needClipboardFallback = false;
          for (const p of pasteLines) {
            const data = imageFileToBase64Data(p);
            if (!data) {
              /* mac 截图临时文件 (clipboard 截图) 可能已被系统清掉读不到 → 回退读剪贴板 (跟 Claude Code 一致)。 */
              if (/\/TemporaryItems\/.*screencaptureui.*\/Screenshot/i.test(p)) needClipboardFallback = true;
              continue;
            }
            const name = p.split('/').pop() || 'image';
            const seq = onPasteImage({ ...data, name });
            if (typeof seq === 'number' && seq > 0) {
              const token = `[图片 #${seq}]`;
              baseValue = baseValue.slice(0, insertAt) + token + baseValue.slice(insertAt);
              insertAt += token.length;
              anyOk = true;
              cliLogger.info('INPUT_LINE', `📎 file-path paste → ${token} (${name})`);
            }
          }
          if (anyOk) { onChange(baseValue); return; }
          if (needClipboardFallback) {
            /* 临时截图文件没了 → 读系统剪贴板的图片数据 */
            const insertAt2 = cursorPosition; const baseValue2 = value;
            pasteImageAsBase64().then(img => { if (img) insertImageTokenAtPaste(img, baseValue2, insertAt2); })
              .catch(err => cliLogger.error('INPUT_LINE', 'temp-screenshot clipboard fallback failed', { error: err }));
            return;
          }
        }

        input = cleaned;
      }

      // ESC should trigger interrupt/clear, not input operations
      if (key.escape) {
        return; // Pass through to BottomBar
      }

      // Tab completion - 联想菜单显示时选择当前项，否则用旧逻辑
      if (key.tab) {
        if (showCompletions && completions.length > 0) {
          // 联想菜单显示时，Tab 选择当前高亮项（不执行）
          const selectedCompletion = completions[completionIndex];
          onChange(selectedCompletion);
          setCursorOffset(0);
          setShowCompletions(false);
          return;
        }
        // 旧的 Tab 补全逻辑（联想菜单未显示时）
        if (onTabComplete) {
          const completion = onTabComplete(value);
          if (completion) {
            onChange(completion);
            setCursorOffset(0);
          }
        }
        return;
      }

      const isPasteKey =
        ((key.meta || key.ctrl) && (input === 'v' || input === 'V'))
        || input === '\x16'; /* raw Ctrl+V (SYN) */
      if (isPasteKey) {
        if (onPasteImage) {
          cliLogger.info('INPUT_LINE', '🎯 Ctrl+V/Cmd+V detected - reading clipboard for image...');
          const insertAt = cursorPosition; const baseValue = value;
          pasteImageAsBase64().then(imageData => {
            if (imageData) insertImageTokenAtPaste(imageData, baseValue, insertAt);
          }).catch(err => {
            cliLogger.error('INPUT_LINE', 'Failed to paste image', { error: err });
          });
          return;
        }
      }

      // 该逻辑会误判中文输入法的多字符输入为粘贴事件
      // 图片粘贴现在只通过 Cmd+V / Ctrl+V 快捷键触发（上面的逻辑）

      if (key.return && key.shift) {
        // Shift+Enter: 插入换行
        const newValue = value.slice(0, cursorPosition) + '\n' + value.slice(cursorPosition);
        onChange(newValue);
        return;
      }

      // Submit on Enter
      if (key.return) {
        if (showCompletions && completions.length > 0) {
          const selectedCompletion = completions[completionIndex];
          setCursorOffset(0);
          setShowCompletions(false);
          // 直接提交选中的命令（传递值避免异步问题）
          onSubmit(selectedCompletion);
          return;
        }
        // 普通提交
        if (process.env.CLI_DEBUG === '1') {
          cliLogger.debug('INPUT_LINE', 'Enter pressed - submitting', {
            valueLength: value.length,
            value: value.substring(0, 50),
            disabled
          });
        }
        onSubmit();
        setCursorOffset(0);
        setShowCompletions(false);
        return;
      }

      if (showCompletions && completions.length > 0) {
        if (key.upArrow) {
          setCompletionIndex((prev) => (prev > 0 ? prev - 1 : completions.length - 1));
          return;
        }
        if (key.downArrow) {
          setCompletionIndex((prev) => (prev < completions.length - 1 ? prev + 1 : 0));
          return;
        }
        // Tab 已在上面统一处理
      }

      // History navigation (only when on first/last line)
      if (key.upArrow) {
        if (currentLine === 0) {
          // 在第一行，触发历史记录
          onHistoryUp();
          setCursorOffset(0);
        } else {
          const prevLineStart = value.lastIndexOf('\n', cursorPosition - currentCol - 2) + 1;
          const prevLineLength = lines[currentLine - 1].length;
          const newCol = Math.min(currentCol, prevLineLength);
          const newPosition = prevLineStart + newCol;
          setCursorOffset(value.length - newPosition);
        }
        return;
      }

      if (key.downArrow) {
        if (currentLine === lines.length - 1) {
          // 在最后一行，触发历史记录
          onHistoryDown();
          setCursorOffset(0);
        } else {
          const currentLineStart = value.lastIndexOf('\n', cursorPosition - 1) + 1;
          const nextLineStart = value.indexOf('\n', cursorPosition) + 1;
          const nextLineLength = lines[currentLine + 1].length;
          const newCol = Math.min(currentCol, nextLineLength);
          const newPosition = nextLineStart + newCol;
          setCursorOffset(value.length - newPosition);
        }
        return;
      }

      // Cursor movement
      if (key.leftArrow && !key.meta && !key.ctrl) {
        setCursorOffset(Math.min(cursorOffset + 1, value.length));
        return;
      }

      if (key.rightArrow && !key.meta && !key.ctrl) {
        setCursorOffset(Math.max(cursorOffset - 1, 0));
        return;
      }

      /* audit P1-2: Ctrl+A+Shift 在 App.tsx 是 ScrollToTop, 这里之前不区分 shift
       *   导致同时触发"光标行首"+"滚屏顶部". 加 !key.shift 让组合键专给 App 用. */
      if (key.home || (key.ctrl && input === 'a' && !key.shift)) {
        setCursorOffset(value.length);
        return;
      }

      if (key.end || (key.ctrl && input === 'e' && !key.shift)) {
        setCursorOffset(0);
        return;
      }

      const lineStart = value.lastIndexOf('\n', cursorPosition - 1) + 1;
      const nextNl = value.indexOf('\n', cursorPosition);
      const lineEnd = nextNl === -1 ? value.length : nextNl;
      const wordStartBefore = (pos: number) => {
        let i = pos;
        while (i > lineStart && /\s/.test(value[i - 1]!)) i--;
        while (i > lineStart && !/\s/.test(value[i - 1]!)) i--;
        return i;
      };
      const wordEndAfter = (pos: number) => {
        let i = pos;
        while (i < lineEnd && /\s/.test(value[i]!)) i++;
        while (i < lineEnd && !/\s/.test(value[i]!)) i++;
        return i;
      };
      if (key.ctrl && input === 'u') {
        onChange(value.slice(0, lineStart) + value.slice(cursorPosition));
        setCursorOffset(value.length - cursorPosition);
        return;
      }
      if (key.ctrl && input === 'k') {
        onChange(value.slice(0, cursorPosition) + value.slice(lineEnd));
        setCursorOffset(value.length - lineEnd);
        return;
      }
      if ((key.ctrl && input === 'w') || (key.meta && (key.backspace || key.delete))) {
        const from = wordStartBefore(cursorPosition);
        onChange(value.slice(0, from) + value.slice(cursorPosition));
        return;
      }
      /* Option+←/→ (多数终端发 ESC b / ESC f, 解析成 meta+b/f) 按词跳 */
      if ((key.meta && (key.leftArrow || input === 'b')) || (key.ctrl && key.leftArrow)) {
        setCursorOffset(value.length - wordStartBefore(cursorPosition));
        return;
      }
      if ((key.meta && (key.rightArrow || input === 'f')) || (key.ctrl && key.rightArrow)) {
        setCursorOffset(value.length - wordEndAfter(cursorPosition));
        return;
      }

      // Delete character
      if (key.backspace || key.delete) {
        if (cursorOffset === value.length) {
          if (value.length === 0 && imageCount > 0 && onRemoveLastAttachment) {
            onRemoveLastAttachment();
          }
          return; // At beginning
        }
        const before = value.slice(0, cursorPosition);
        const chipMatch = before.match(/\[图片 #\d+\]$/);
        if (chipMatch) {
          const chipLen = chipMatch[0].length;
          onChange(value.slice(0, cursorPosition - chipLen) + value.slice(cursorPosition));
          return;
        }
        const deletePos = cursorPosition - 1;
        const newValue = value.slice(0, deletePos) + value.slice(deletePos + 1);
        onChange(newValue);
        return;
      }

      // Insert character(s) - 支持多字符输入（粘贴）
      if (!key.ctrl && !key.meta && input) {
        const sanitizedInput = sanitizeInputChunk(input);
        if (!sanitizedInput) {
          if (process.env.CLI_DEBUG === '1') {
            cliLogger.debug('INPUT_LINE', 'Dropped control/escape-only input chunk');
          }
          return;
        }

        const newValue = value.slice(0, cursorPosition) + sanitizedInput + value.slice(cursorPosition);
        onChange(newValue);
        return;
      }
    },
    { isActive: inputIsActive }
  );

  const isEmpty = !value;

  const maskDisplay = (text: string) => (mask ? '•'.repeat(text.length) : text);

  // 计算每行的光标位置
  const renderLines = () => {
    if (isEmpty) {
      return (
        <Box>
          <Text color={NeoxTheme.brand.purple} bold>{'› '}</Text>
          <Text inverse> </Text>
          <Text dimColor>{placeholder}</Text>
        </Box>
      );
    }

    return lines.map((line, lineIndex) => {
      const isCurrentLine = lineIndex === currentLine;
      const lineStart = lines.slice(0, lineIndex).reduce((acc, l) => acc + l.length + 1, 0);
      const lineEnd = lineStart + line.length;

      // 计算这一行的光标位置
      let lineCursorPos = -1;
      if (isCurrentLine) {
        lineCursorPos = cursorPosition - lineStart;
      }

      /* 跟时间线上用户消息同一个 › —— 发出去以后长得一样 */
      const prefix = lineIndex === 0 ? '› ' : '  ';
      const prefixColor = NeoxTheme.brand.purple;

      if (disabled) {
        return (
          <Box key={lineIndex}>
            <Text color={prefixColor} bold>{prefix}</Text>
            <Text dimColor>{maskDisplay(line)}</Text>
          </Box>
        );
      }

      // 渲染带光标的行
      if (isCurrentLine && lineCursorPos >= 0) {
        const beforeCursor = maskDisplay(line.slice(0, lineCursorPos));
        const rawCursorChar = line[lineCursorPos];
        const cursorChar = rawCursorChar ? maskDisplay(rawCursorChar) : ' ';
        const afterCursor = maskDisplay(line.slice(lineCursorPos + 1));

        return (
          <Box key={lineIndex}>
            <Text color={prefixColor} bold>{prefix}</Text>
            <Text>
              {beforeCursor}
              <Text inverse>{cursorChar}</Text>
              {afterCursor}
            </Text>
          </Box>
        );
      }

      // 普通行
      return (
        <Box key={lineIndex}>
          <Text color={prefixColor} bold>{prefix}</Text>
          <Text>{maskDisplay(line)}</Text>
        </Box>
      );
    });
  };

  return (
    <Box flexDirection="column">
      {isMultilineContent && !disabled && (
        <Box marginBottom={0}>
          <Text dimColor>  ↵ {t().ui.shiftEnterNewline} │ Enter {t().ui.enterToSend} │ {formatMessage(t().ui.lineCount, { count: lines.length })}</Text>
        </Box>
      )}

      {/* Input line(s) */}
      <Box flexDirection="column">
        {renderLines()}
      </Box>

    </Box>
  );
};
