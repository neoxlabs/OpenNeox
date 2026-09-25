import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useStdout } from '../../../vendor/ink/src/index.js';
import stringWidth from 'string-width';
import { NeoxTheme } from '../theme.js';
import { getLanguage } from '../../i18n/index.js';

const padW = (s: string, w: number) => {
  if (stringWidth(s) > w) {
    let out = '';
    for (const ch of s) {
      if (stringWidth(out + ch) > w - 1) break;
      out += ch;
    }
    s = out + '…';
  }
  return s + ' '.repeat(Math.max(0, w - stringWidth(s)));
};
const LABEL_META = /^(.*\S)\s+\(([^()]+)\)$/;

function parseLabel(label: string): { name: string; value: string; meta: string } {
  let s = label.replace(/^(?:[○●◉◯✓✔✗✘×>]|x(?=\s)|⚙️?|🔧|📁|🧠)\s+/u, '');
  let meta = '';
  const m = LABEL_META.exec(s);
  if (m) { s = m[1]!; meta = m[2]!; }
  let value = '';
  const d = /^(.+?)\s+[—–]\s+(.+)$/.exec(s);
  if (d) { s = d[1]!; value = d[2]!; }
  return { name: s, value, meta };
}

/** 调用方传的 hint 里, 去掉按键说明后还剩的那部分 (没有就空) */
function extraHint(hint?: string): string {
  if (!hint) return '';
  const rest = hint.split(/\s*[·,，|]\s*/).filter(p => p && !/↑|↓|enter|esc|回车|确认|取消|返回|选择|navigate|select|cancel|confirm|back/i.test(p));
  return rest.join(' · ');
}

const isZhLocale = (): boolean => {
  try { return getLanguage() === 'zh'; } catch { return false; }
};

export interface SelectMenuItem {
  label: string;
  value: string;
  description?: string;
  /** If true, this item is a separator and cannot be selected */
  isSeparator?: boolean;
  /** Currently applied value — stays colored while the cursor moves to other rows */
  isCurrent?: boolean;
}

export interface SelectMenuProps {
  message: string;
  choices: SelectMenuItem[];
  initialIndex?: number;
  hint?: string;
  header?: string;
  maxVisible?: number;
  /** Enable "Type something." and "Chat about this" extra options */
  allowTextInput?: boolean;
  /** Accent color for selected items (default: magenta) */
  accentColor?: string;
  /** Enable multi-select with space bar */
  multiSelect?: boolean;
  onSelect: (value: string) => void;
  onCancel?: () => void;
  onExit?: () => void;
}

// Special values for extra options
const TYPE_SOMETHING = '__type_something__';
const CHAT_ABOUT = '__chat_about__';
const SEPARATOR = '__separator__';
/** 超过这么多项的单选菜单才开打字筛选 */
const FILTER_MIN_ITEMS = 15;

/** 钉在列表两端、不参与编号的入口项 (返回 / 新增 / 删除 / 完成)。
 *  编号 (getNumber) 和渲染 (renderPinnedChoice) 必须共用这一个判据 —— 两处名单
 *  一旦分叉就会出现重复编号, 见 getNumber 处注释。 */
const PINNED_VALUES = new Set(['__back__', '__add__', '__add_provider__', '__delete__', 'done', 'back']);
const isPinnedValue = (value: string): boolean => PINNED_VALUES.has(value);

/**
 * SelectMenu - Premium interactive selection menu
 */
export const SelectMenu: React.FC<SelectMenuProps> = ({
  message,
  choices: rawChoices,
  initialIndex = 0,
  hint,
  header,
  maxVisible = 12,
  allowTextInput = false,
  accentColor = NeoxTheme.brand.purple,
  multiSelect = false,
  onSelect,
  onCancel,
  onExit,
}) => {
  const accentInkColor: React.ComponentProps<typeof Text>['color'] = accentColor;
  const { columns: terminalWidth = 80, rows: terminalRows = 24 } = useStdout();
  const [textInputMode, setTextInputMode] = useState(false);
  const [textValue, setTextValue] = useState('');
  const [checkedSet, setCheckedSet] = useState<Set<string>>(new Set());
  const filterable = !multiSelect && !allowTextInput && rawChoices.length > FILTER_MIN_ITEMS;
  const [filter, setFilter] = useState('');
  const filteredChoices = useMemo(() => {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return rawChoices;
    return rawChoices.filter(c => {
      if (isPinnedValue(c.value)) return true;
      if (c.isSeparator || c.value === '' || c.value === SEPARATOR || c.value === '__noop__') return false;
      const hay = `${c.label} ${c.description ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '').toLowerCase();
      return terms.every(t => hay.includes(t));
    });
  }, [rawChoices, filter]);

  // Build full choices: original + separator + Type something + Chat about this
  const choices = useMemo(() => {
    if (!allowTextInput) return filteredChoices;
    return [
      ...rawChoices,
      { label: '', value: SEPARATOR, isSeparator: true },
      /* 中文界面下这两条原来是英文 ("Type something." / "Chat about this"),
       * 卡里其余全中文。 截图复盘。 */
      { label: isZhLocale() ? '自己输入…' : 'Type something.', value: TYPE_SOMETHING },
      { label: isZhLocale() ? '就这个聊聊' : 'Chat about this', value: CHAT_ABOUT },
    ];
  }, [rawChoices, filteredChoices, allowTextInput]);

  const isSeparatorItem = (item?: SelectMenuItem) => {
    if (!item) return false;
    return item.isSeparator || item.value === '' || item.value === SEPARATOR;
  };
  const isSeparator = (index: number) => isSeparatorItem(choices[index]);

  // Pin special action items (__back__, __add__) at top
  const pinnedTopCount = useMemo(() => {
    let count = 0;
    for (let i = 0; i < choices.length && i < 5; i++) {
      const val = choices[i].value;
      if ((isPinnedValue(val) && val !== 'back') || isSeparatorItem(choices[i])) {
        count = i + 1;
      } else {
        break;
      }
    }
    return count;
  }, [choices]);

  const adaptiveMax = useMemo(() => {
    const cap = Math.max(5, Math.min(12, terminalRows - 10));
    return Math.max(5, Math.min(maxVisible, cap));
  }, [maxVisible, terminalRows]);

  const scrollableChoices = choices.slice(pinnedTopCount);
  const visibleCount = Math.min(scrollableChoices.length, adaptiveMax);

  const findNext = (cur: number, dir: 1 | -1): number => {
    let n = cur;
    for (let i = 0; i < choices.length; i++) {
      n += dir;
      if (n < 0) n = choices.length - 1;
      if (n >= choices.length) n = 0;
      if (!isSeparator(n)) return n;
    }
    return cur;
  };

  const findFirst = (): number => {
    for (let i = 0; i < choices.length; i++) {
      if (!isSeparator(i)) return i;
    }
    return 0;
  };

  const [selectedIndex, setSelectedIndex] = useState(() =>
    isSeparator(initialIndex) ? findFirst() : initialIndex
  );
  const [scrollOffset, setScrollOffset] = useState(0);
  const [menuReady, setMenuReady] = useState(false);

  useEffect(() => {
    if (isSeparator(initialIndex)) setSelectedIndex(findFirst());
    else setSelectedIndex(initialIndex);
  }, [initialIndex, rawChoices]);

  /* 筛选词变了: 光标落到第一条匹配 (跳过钉住的入口项); 清空筛选回到初始项 */
  useEffect(() => {
    if (!filterable) return;
    setScrollOffset(0);
    if (!filter) { setSelectedIndex(isSeparator(initialIndex) ? findFirst() : initialIndex); return; }
    const first = choices.findIndex((c, i) => i >= pinnedTopCount && !isSeparatorItem(c));
    setSelectedIndex(first >= 0 ? first : findFirst());
  }, [filter]);

  useEffect(() => {
    const t = setTimeout(() => setMenuReady(true), 200);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (visibleCount <= 0) { if (scrollOffset !== 0) setScrollOffset(0); return; }
    const maxOff = Math.max(0, scrollableChoices.length - visibleCount);
    if (scrollOffset > maxOff) { setScrollOffset(maxOff); return; }
    if (selectedIndex < pinnedTopCount) return;
    const rel = selectedIndex - pinnedTopCount;
    if (rel < scrollOffset) setScrollOffset(rel);
    else if (rel >= scrollOffset + visibleCount) setScrollOffset(rel - visibleCount + 1);
  }, [selectedIndex, pinnedTopCount, scrollableChoices.length, visibleCount, scrollOffset]);

  // Text input mode handler
  useInput((input, key) => {
    if (!textInputMode) return;
    if (key.escape) { setTextInputMode(false); setTextValue(''); return; }
    if (key.return && textValue.trim()) { process.nextTick(() => onSelect(textValue.trim())); return; }
    if (key.backspace || key.delete) { setTextValue(prev => prev.slice(0, -1)); return; }
    if (input && !key.ctrl && !key.meta) { setTextValue(prev => prev + input); }
  }, { isActive: textInputMode });

  // Selection mode handler
  useInput((input, key) => {
    if (textInputMode) return;
    if (key.ctrl && input === 'c' && onExit) { process.nextTick(() => onExit()); return; }
    if (key.escape && filterable && filter) { setFilter(''); return; }
    if (key.escape && onCancel) { process.nextTick(() => onCancel()); return; }
    if (key.upArrow) { setSelectedIndex(prev => findNext(prev, -1)); return; }
    if (key.downArrow) { setSelectedIndex(prev => findNext(prev, 1)); return; }
    if (filterable && (key.backspace || key.delete)) { setFilter(prev => prev.slice(0, -1)); return; }
    if (filterable && input && !key.ctrl && !key.meta && !key.return && !key.tab && /^[^\x00-\x1f]+$/.test(input)) {
      setFilter(prev => prev + input);
      return;
    }

    // Space = toggle check in multi-select mode
    if (input === ' ' && multiSelect) {
      const val = choices[selectedIndex]?.value;
      if (val && !isSeparator(selectedIndex) && !val.startsWith('__')) {
        setCheckedSet(prev => {
          const next = new Set(prev);
          if (next.has(val)) next.delete(val);
          else next.add(val);
          return next;
        });
      }
      return;
    }

    if (key.return) {
      if (isSeparator(selectedIndex) || !menuReady || !choices[selectedIndex]) return;
      const val = choices[selectedIndex].value;
      if (val === TYPE_SOMETHING) { setTextInputMode(true); return; }
      if (multiSelect && checkedSet.size > 0) {
        process.nextTick(() => onSelect([...checkedSet].join(',')));
      } else {
        process.nextTick(() => onSelect(val));
      }
    }
  }, { isActive: !textInputMode });

  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + visibleCount < scrollableChoices.length;

  /* Numbering and rendering share one predicate so sentinel actions cannot
   * duplicate the preceding option number. `__noop__` is descriptive content,
   * not a selectable choice, and therefore remains unnumbered. */
  const isUnnumbered = (value: string): boolean =>
    isPinnedValue(value) || value === TYPE_SOMETHING || value === CHAT_ABOUT || value === '__noop__';

  const getNumber = (idx: number): number => {
    let n = 0;
    for (let i = 0; i <= idx; i++) {
      if (!isSeparator(i) && !isUnnumbered(choices[i].value)) n++;
    }
    return n;
  };

  // Layout widths
  const contentWidth = Math.min(terminalWidth - 2, 100);

  const currentColor = NeoxTheme.functional.success;
  /* 三栏对齐: 名称 | 当前值 (次要色) | 说明/元信息 (灰)。label 统一经 parseLabel 拆 (见文件头 parseLabel)。
   * 各命令原来各写各的 ("压缩阈值 — 85%" / "○ 查看所有技能" / "x 清除记忆" / "Agent — 自动调用工具  说明"),
   * 一屏里有的对齐有的不对齐。这里统一拆、统一排。 */
  const parsed = choices.map(c => parseLabel(c.label || ''));
  const columnar = choices.map((c, i) => !isSeparatorItem(c) && !isPinnedValue(c.value) && (parsed[i]!.value || parsed[i]!.meta || c.description));
  /* 名称栏上限随终端宽度走 (宽屏给到 36, 窄屏压到 40%), 超出的名称在 padW 里截断 */
  const nameCap = Math.max(16, Math.min(36, Math.floor(contentWidth * 0.4)));
  const nameCol = Math.min(nameCap, Math.max(0, ...parsed.filter((_, i) => columnar[i]).map(p => stringWidth(p.name))));
  const valueCol = Math.min(24, Math.max(0, ...parsed.filter((_, i) => columnar[i]).map(p => stringWidth(p.value))));
  const descInline = contentWidth >= 6 + nameCol + (valueCol ? valueCol + 2 : 0) + 2 + 16;

  const renderPinnedChoice = (choice: SelectMenuItem, idx: number) => {
    const isActive = idx === selectedIndex;
    const isCurrent = !!choice.isCurrent;
    const cursor = isActive ? '›' : isCurrent ? '●' : ' ';
    const rowColor = isActive ? accentInkColor : isCurrent ? currentColor : NeoxTheme.text.dim;
    /* 各命令的"返回"写法不一 (← Back / ← 返回 / < back) —— 统一按界面语言显示 */
    const label = /^←\s*(back|返回)$/i.test(choice.label.trim()) ? (isZhLocale() ? '← 返回' : '← Back') : choice.label;
    return (
      <Box key={`pinned-${idx}`}>
        <Text color={rowColor} bold={isActive || isCurrent}>{cursor} </Text>
        <Text color={rowColor} bold={isActive || isCurrent}>{label}</Text>
      </Box>
    );
  };

  const renderChoice = (choice: SelectMenuItem, idx: number) => {
    const isActive = idx === selectedIndex;
    const isCurrent = !!choice.isCurrent;
    const isChecked = checkedSet.has(choice.value);

    if (isSeparatorItem(choice)) {
      return (
        <Box key={`sep-${idx}`}>
          <Text dimColor>  {'─'.repeat(Math.min(contentWidth - 4, 60))}</Text>
        </Box>
      );
    }

    const isPinned = isPinnedValue(choice.value);
    const isExtra = choice.value === TYPE_SOMETHING || choice.value === CHAT_ABOUT;

    if (isPinned) return renderPinnedChoice(choice, idx);

    /* Use the same predicate for counting and displaying option numbers. */
    const num = isUnnumbered(choice.value) ? null : getNumber(idx);

    // Checkbox for multi-select
    let checkbox = '';
    if (multiSelect && !isExtra) {
      checkbox = isChecked ? '◉ ' : '○ ';
    }

    // Number padding
    const numStr = num !== null ? `${String(num).padStart(2)}. ` : '    ';

    /* Focus (cursor) = accent + bg; current applied value = green even when cursor moves away.
     * Focus wins when both apply so navigation stays obvious. */
    const labelColor = isActive
      ? accentColor
      : isCurrent
        ? currentColor
        : isChecked
          ? accentColor
          : undefined;
    const dimLabel = isChecked && !isActive && !isCurrent;
    const cursor = isActive ? '›' : isCurrent ? '●' : ' ';
    const numColor = isActive ? accentInkColor : NeoxTheme.text.dim;
    const { name, value, meta } = parsed[idx]!;
    const isColumnar = !!columnar[idx];

    /* 说明文字放右边灰色一栏 (跟斜杠菜单一样), 一项一行; 只有终端太窄才退回到下一行。 */
    const tail = [meta, choice.description].filter(Boolean).join('  ·  ');
    const inlineDesc = !!tail && descInline;
    return (
      <Box key={`${choice.value}-${idx}`} flexDirection="column">
        <Box>
          <Text color={isActive ? accentInkColor : isCurrent ? currentColor : undefined} bold={isActive || isCurrent}>{cursor} </Text>
          <Text color={numColor}>{numStr}</Text>
          <Text color={labelColor} bold={isActive || isCurrent} dimColor={dimLabel}>
            {checkbox}{isColumnar ? padW(name, nameCol) : name}
          </Text>
          {valueCol > 0 && isColumnar ? (
            <Text color={isActive ? accentInkColor : NeoxTheme.text.secondary}>{'  ' + padW(value, valueCol)}</Text>
          ) : null}
          {inlineDesc ? (
            <Text color={isActive ? NeoxTheme.text.secondary : NeoxTheme.text.dim} wrap="truncate-end">{'  ' + tail}</Text>
          ) : null}
        </Box>
        {tail && !inlineDesc && (
          <Box>
            <Text color={NeoxTheme.text.dim}>{'      '}{tail}</Text>
          </Box>
        )}
      </Box>
    );
  };

  // Multi-select summary
  const selectedCount = checkedSet.size;

  // Scroll position indicator
  const totalScrollable = scrollableChoices.length;
  const scrollPercent = totalScrollable > visibleCount
    ? Math.round(((scrollOffset + visibleCount) / totalScrollable) * 100)
    : 100;
  const posIndicator = totalScrollable > visibleCount
    ? ` ${scrollOffset + 1}-${Math.min(scrollOffset + visibleCount, totalScrollable)}/${totalScrollable}`
    : '';

  // Text input mode render
  if (textInputMode) {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        {header && <Box><Text color={accentInkColor} bold>{header}</Text></Box>}
        <Text>{' '}</Text>
        {message && <Box><Text bold>{message}</Text></Box>}
        <Text>{' '}</Text>
        <Box>
          <Text color={accentInkColor} bold>› </Text>
          <Text>{textValue}</Text>
          <Text color={accentInkColor}>█</Text>
        </Box>
        <Text>{' '}</Text>
        <Box><Text dimColor>{getLanguage() === 'zh' ? '回车确认 · esc 返回' : 'enter to submit · esc to go back'}</Text></Box>
      </Box>
    );
  }

  const zhHint = getLanguage() === 'zh';
  const defaultHint = multiSelect
    ? (zhHint ? '↑↓ 移动 · 空格 勾选 · Enter 确认 · Esc 取消' : '↑↓ navigate · Space select · Enter confirm · Esc cancel')
    : (zhHint ? '↑↓ 选择 · Enter 确认 · Esc 取消' : '↑↓ select · Enter confirm · Esc cancel');

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {/* Header badge */}
      {header && (
        <>
          <Box><Text color={accentInkColor} bold>{header}</Text></Box>
          <Text>{' '}</Text>
        </>
      )}

      {/* Title bar */}
      <Box>
        <Text bold>{message}</Text>
        {multiSelect && selectedCount > 0 && (
          <Text color={accentInkColor}> ({selectedCount} selected)</Text>
        )}
        {posIndicator && (
          <Text dimColor>{posIndicator}</Text>
        )}
      </Box>

      {/* 筛选框: 打字即筛, 没打字时只给一句提示 */}
      {filterable && (
        <Box>
          <Text color={accentInkColor}>{'⌕ '}</Text>
          {filter
            ? <Text>{filter}<Text color={accentInkColor}>█</Text></Text>
            : <Text dimColor>{zhHint ? '直接打字筛选' : 'type to filter'}</Text>}
          {filter && scrollableChoices.length === 0 && (
            <Text dimColor>{zhHint ? '   没有匹配项 · Esc 清空' : '   no matches · Esc to clear'}</Text>
          )}
        </Box>
      )}

      {/* Spacer */}
      <Text>{' '}</Text>

      {/* Pinned items */}
      {choices.slice(0, pinnedTopCount).map((c, i) => renderChoice(c, i))}

      {/* Divider between pinned and scrollable */}
      {pinnedTopCount > 0 && (
        <Box>
          <Text dimColor>  {'─'.repeat(Math.min(contentWidth - 4, 60))}</Text>
        </Box>
      )}

      {/* Scroll up indicator */}
      {hasScrollUp && (
        <Box>
          <Text dimColor>{zhHint ? '  ↑ 更多' : '  ↑ more'}</Text>
        </Box>
      )}

      {/* Scrollable items */}
      {scrollableChoices.slice(scrollOffset, scrollOffset + visibleCount).map((c, i) => {
        const ci = pinnedTopCount + scrollOffset + i;
        return renderChoice(c, ci);
      })}

      {/* Scroll down indicator */}
      {hasScrollDown && (
        <Box>
          <Text dimColor>{zhHint ? '  ↓ 更多' : '  ↓ more'}</Text>
        </Box>
      )}

      {/* Footer hint —— 按键说明统一一种写法; 调用方的 hint 只有在说了按键以外的事时才追加 (如 "背景明暗用 /theme light|dark") */}
      <Text>{' '}</Text>
      <Box>
        <Text dimColor>{extraHint(hint) ? `${defaultHint} · ${extraHint(hint)}` : defaultHint}</Text>
      </Box>
    </Box>
  );
};

/**
 * Helper function to create approval dialog choices
 */
export function createApprovalChoices(options: {
  allowRemember?: boolean;
  toolName?: string;
}): SelectMenuItem[] {
  const choices: SelectMenuItem[] = [
    { label: 'Allow Once', value: 'allow_once', description: 'Allow this tool call only this time' },
  ];
  if (options.allowRemember) {
    choices.push({
      label: 'Always Allow',
      value: 'always_allow',
      description: options.toolName ? `Don't ask again for "${options.toolName}"` : "Don't ask again",
    });
  }
  choices.push({ label: 'Deny', value: 'deny', description: 'Reject this tool call' });
  return choices;
}
