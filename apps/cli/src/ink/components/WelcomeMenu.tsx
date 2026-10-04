import React, { useState } from 'react';
import { Box, Text, useInput } from '../../../vendor/ink/src/index.js';

export type WelcomeMenuChoice = 'login' | 'byok' | 'exit';

export interface WelcomeMenuProps {
  onSelect: (choice: WelcomeMenuChoice) => void;
  /** false = 不出 "登录 NeoxCloud" (公开版没有账号体系)。缺省 true。 */
  showLogin?: boolean;
}

interface MenuItem {
  value: WelcomeMenuChoice;
  title: string;
  hint: string;
  recommended?: boolean;
}

const MENU: MenuItem[] = [
  {
    value: 'login',
    title: '登录 NeoxCloud',
    hint: '多模型零配置',
    recommended: true,
  },
  {
    value: 'byok',
    title: '自带 API key',
    hint: 'OpenAI / Anthropic / DeepSeek / Kimi / GLM',
  },
  {
    value: 'exit',
    title: '跳过',
    hint: '',
  },
];

const NEOX_LOGO_ANSI = [
  '███╗   ██╗███████╗ ██████╗ ██╗  ██╗',
  '████╗  ██║██╔════╝██╔═══██╗╚██╗██╔╝',
  '██╔██╗ ██║█████╗  ██║   ██║ ╚███╔╝ ',
  '██║╚██╗██║██╔══╝  ██║   ██║ ██╔██╗ ',
  '██║ ╚████║███████╗╚██████╔╝██╔╝ ██╗',
  '╚═╝  ╚═══╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝',
];

const NEOX_LOGO_SMALL = [
  ' _   _ ___ _____  __',
  '| \\ | | __|  _  \\ \\/ /',
  '|  \\| | _|| |_| |>  < ',
  '|_|\\__|___|_____/_/\\_\\',
];

const GRADIENT = [
  '#00E5D9',
  '#00B5E6',
  '#5478E6',
  '#9966FF',
  '#D946C9',
  '#FF3B9A',
  '#FF6FB5',
];

function colorAt(progress: number): string {
  const n = GRADIENT.length - 1;
  const idx = Math.min(n, Math.max(0, Math.round(progress * n)));
  return GRADIENT[idx];
}

export const WelcomeMenu: React.FC<WelcomeMenuProps> = ({ onSelect, showLogin = true }) => {
  const [idx, setIdx] = useState(0);
  const items = showLogin ? MENU : MENU.filter((item) => item.value !== 'login');

  useInput((input, key) => {
    if (key.upArrow) {
      setIdx((p) => (p > 0 ? p - 1 : items.length - 1));
      return;
    }
    if (key.downArrow) {
      setIdx((p) => (p < items.length - 1 ? p + 1 : 0));
      return;
    }
    if (key.return) {
      onSelect(items[idx].value);
      return;
    }
    if (key.escape || input === 'q' || input === 'Q') {
      onSelect('exit');
      return;
    }
    /* 数字直选 = 显示的序号 (1-based) */
    const n = Number.parseInt(input, 10);
    if (n >= 1 && n <= items.length && String(n) === input) { onSelect(items[n - 1].value); return; }
  });

  const width = process.stdout.columns || 80;
  const isLegacyWindows = process.platform === 'win32' && !process.env.WT_SESSION;
  const logo = width < 60 || isLegacyWindows ? NEOX_LOGO_SMALL : NEOX_LOGO_ANSI;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      {/* Logo */}
      <Box flexDirection="column">
        {logo.map((line, i) => (
          <Text key={i} color={colorAt(i / Math.max(logo.length - 1, 1))} bold>{line}</Text>
        ))}
      </Box>

      {/* 菜单 — 紧凑单行, 选中只【高亮反白】不悬浮 (无 padding 变化) */}
      <Box flexDirection="column" marginTop={1}>
        {items.map((item, i) => {
          const sel = i === idx;
          /* 选中: backgroundColor cyan + 黑字反白. 未选中: 默认颜色, indent 留空白对齐 */
          return (
            <Box key={item.value}>
              <Text backgroundColor={sel ? 'cyan' : undefined} color={sel ? 'black' : 'white'} bold={sel}>
                {' '}{i + 1}. {item.title}{' '}
              </Text>
              {item.recommended && (
                <Text color="green" bold>  ★</Text>
              )}
              {item.hint && (
                <>
                  <Text>   </Text>
                  <Text dimColor>{item.hint}</Text>
                </>
              )}
            </Box>
          );
        })}
      </Box>

      {/* 底部 hint — 精简 */}
      <Box marginTop={1}>
        <Text dimColor>↑↓ 选择 · enter 确认 · esc 跳过</Text>
      </Box>
    </Box>
  );
};
