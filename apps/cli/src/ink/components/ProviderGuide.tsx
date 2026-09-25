/**
 * ProviderGuide — Provider 配置引导 (v4 重设计):
 *   · 风格跟 WelcomeMenu 完全统一: NEOX 渐变 logo + 圆边框 cyan + 反白高亮选中
 *   · detected providers 每行带 checkbox [✓]/[ ], 用户可【多选】要创建哪几个 (不再一键全建)
 *   · 主菜单 footer: "创建选中的 (N) · 手动配置 · 退出"
 *   · ↑↓ 在 detected + actions 之间无缝 navigate
 *   · 空格 toggle 当前 detected; enter 在 action 行确认
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from '../../../vendor/ink/src/index.js';
import { getLanguage } from '../../i18n/index.js';

/* Read the current language when rendering so provider setup remains usable
 * for both locales and responds immediately to `/lang` changes. */
const isZhLocale = (): boolean => {
  try { return getLanguage() === 'zh'; } catch { return false; }
};

export interface DetectedProvider {
  name: string;
  protocol: string;
  apiKey: string;
  baseUrl?: string;
  models: string[];
  envKeyHint?: string;
}

export interface ProviderGuideProps {
  onContinue: () => void;
  onManualEdit?: () => void;
  onExit?: () => void;
  onAutoCreate?: (selectedIndices?: number[]) => void;
  detectedProviders?: DetectedProvider[];
}

/* NEOX 渐变 logo — 跟 WelcomeMenu.tsx 同步 */
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
const GRADIENT = ['#00E5D9', '#00B5E6', '#5478E6', '#9966FF', '#D946C9', '#FF3B9A', '#FF6FB5'];
function colorAt(progress: number): string {
  const n = GRADIENT.length - 1;
  const idx = Math.min(n, Math.max(0, Math.round(progress * n)));
  return GRADIENT[idx];
}

interface Action {
  value: 'auto' | 'setup' | 'manual' | 'exit';
  label: string;
  hint: string;
}

export const ProviderGuide: React.FC<ProviderGuideProps> = ({
  onContinue,
  onManualEdit,
  onExit,
  onAutoCreate,
  detectedProviders = [],
}) => {
  const hasDetected = detectedProviders.length > 0;

  /* 默认勾选【有 key】的 detected; 没 key 的不勾 (需用户先 set env) */
  const [checked, setChecked] = useState<Set<number>>(
    new Set(
      detectedProviders
        .map((p, i) => (p.apiKey && p.apiKey.trim() ? i : -1))
        .filter((i) => i >= 0),
    ),
  );

  /* actions footer */
  const zh = isZhLocale();
  const actSetup: Action  = { value: 'setup',  label: zh ? '手动配置' : 'Configure', hint: zh ? '进入交互式向导' : 'interactive wizard' };
  const actManual: Action = { value: 'manual', label: zh ? '编辑文件' : 'Edit file', hint: zh ? '打开 config 手动改' : 'open the config yourself' };
  const actExit: Action   = { value: 'exit',   label: zh ? '退出' : 'Exit',          hint: zh ? '稍后再说' : 'maybe later' };
  const actions: Action[] = hasDetected
    ? [
        { value: 'auto', label: zh ? '创建选中的' : 'Create selected', hint: '' },
        { ...actSetup },
        { ...actManual },
        { ...actExit },
      ]
    : [
        { ...actSetup, label: zh ? '开始配置' : 'Get started' },
        { ...actManual },
        { ...actExit },
      ];

  const totalRows = detectedProviders.length + actions.length;
  const [row, setRow] = useState(hasDetected ? 0 : detectedProviders.length);

  useInput((input, key) => {
    if (key.upArrow) {
      setRow((p) => (p > 0 ? p - 1 : totalRows - 1));
      return;
    }
    if (key.downArrow) {
      setRow((p) => (p < totalRows - 1 ? p + 1 : 0));
      return;
    }
    if (input === ' ' && row < detectedProviders.length) {
      const p = detectedProviders[row];
      if (!p.apiKey || !p.apiKey.trim()) return; // 没 key 不能选
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(row)) next.delete(row); else next.add(row);
        return next;
      });
      return;
    }
    const n = parseInt(input, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= detectedProviders.length) {
      const idx = n - 1;
      const p = detectedProviders[idx];
      if (!p.apiKey || !p.apiKey.trim()) return; // 没 key 不能选
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(idx)) next.delete(idx); else next.add(idx);
        return next;
      });
      return;
    }
    if (key.return) {
      if (row < detectedProviders.length) {
        setChecked((prev) => {
          const next = new Set(prev);
          if (next.has(row)) next.delete(row); else next.add(row);
          return next;
        });
        return;
      }
      const action = actions[row - detectedProviders.length];
      switch (action.value) {
        case 'auto':
          onAutoCreate?.(Array.from(checked).sort((a, b) => a - b));
          break;
        case 'setup':
          onContinue();
          break;
        case 'manual':
          onManualEdit?.();
          break;
        case 'exit':
          onExit?.();
          break;
      }
      return;
    }
    if (key.escape) {
      onExit?.();
      return;
    }
  });

  const width = process.stdout.columns || 80;
  const isLegacyWindows = process.platform === 'win32' && !process.env.WT_SESSION;
  const logo = width < 60 || isLegacyWindows ? NEOX_LOGO_SMALL : NEOX_LOGO_ANSI;
  const checkedCount = checked.size;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      {/* Logo */}
      <Box flexDirection="column">
        {logo.map((line, i) => (
          <Text key={i} color={colorAt(i / Math.max(logo.length - 1, 1))} bold>{line}</Text>
        ))}
      </Box>

      {/* Detected providers — checkbox list (强制单行, 没 key 的标记不可选)
       *   wrap='truncate-end' 防终端窄时 url+hint 太长换行造成行高不齐. */}
      {hasDetected && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            {zh
              ? `检测到 ${detectedProviders.length} 个 · ⚠ = 缺 env key · 空格 / 数字键 选/不选`
              : `${detectedProviders.length} detected · ⚠ = env key missing · space / number keys to toggle`}
          </Text>
          {detectedProviders.map((p, i) => {
            const sel = row === i;
            const hasKey = !!(p.apiKey && p.apiKey.trim());
            const isChecked = checked.has(i);
            const mark = !hasKey ? '⚠' : (isChecked ? '✓' : ' ');
            const tail = !hasKey && p.envKeyHint ? `  · need ${p.envKeyHint}` : '';
            return (
              <Box key={i}>
                <Text
                  backgroundColor={sel ? 'cyan' : undefined}
                  color={sel ? 'black' : (hasKey ? 'white' : 'gray')}
                  bold={sel}
                  wrap="truncate-end"
                >
                  {' '}{mark} {i + 1}. {p.name.padEnd(22)}{' '}
                </Text>
                <Text>   </Text>
                <Text dimColor wrap="truncate-end">
                  {p.baseUrl ? p.baseUrl : p.protocol}{tail}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Action menu */}
      <Box flexDirection="column" marginTop={1}>
        {actions.map((a, i) => {
          const rowIdx = detectedProviders.length + i;
          const sel = row === rowIdx;
          const label = a.value === 'auto' ? `${a.label} (${checkedCount})` : a.label;
          return (
            <Box key={a.value}>
              <Text backgroundColor={sel ? 'cyan' : undefined} color={sel ? 'black' : 'white'} bold={sel}>
                {' '}{label}{' '}
              </Text>
              {a.hint && (
                <>
                  <Text>   </Text>
                  <Text dimColor>{a.hint}</Text>
                </>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Footer hint */}
      <Box marginTop={1}>
        <Text dimColor>{zh
          ? '↑↓ 切换 · space 选/不选 · enter 确认 · esc 退出'
          : '↑↓ move · space toggle · enter confirm · esc exit'}</Text>
      </Box>
    </Box>
  );
};
