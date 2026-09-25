/**
 * SlashCommandMenu - 斜杠命令交互菜单
 * 当用户输入单独的 / 时显示可滚动的命令菜单
 * 风格参考截图中的协作模式配置菜单
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from '../../../vendor/ink/src/index.js';
import { t, getLanguage, formatMessage, type UserLanguage } from '../../i18n/index.js';
import { NeoxTheme } from '../theme.js';
import { getCliEdition } from '../../edition/index.js';

export interface SlashCommand {
  name: string;           // 命令名称，如 /help
  description: string;    // 命令描述
  category: string;       // 分类
  hasSubMenu?: boolean;   // 是否有子菜单
}

/**
 * 获取国际化的命令列表 (含插件贡献的命令)
 */
export function getSlashCommands(): SlashCommand[] {
  const tr = t();
  const cat = tr.slashMenu.categories;
  const cmd = tr.slashMenu.commands;

  const builtin: SlashCommand[] = [
    // 基础命令
    { name: '/setup', description: cmd.setup, category: cat.basic, hasSubMenu: true },
    { name: '/help', description: cmd.help, category: cat.basic },
    { name: '/clear', description: cmd.clear, category: cat.basic },
    { name: '/exit', description: cmd.exit, category: cat.basic },

    // 账号 / 订阅 (NeoxCloud) — 发行版插槽提供 (公开版没有), 见 edition/index.ts
    ...getCliEdition().slashMenuItems.filter((item) => {
      try { return item.visible ? item.visible() : true; } catch { return true; }
    }).map((item) => ({
      name: item.name,
      description: item.description(),
      category: cat.account,
      ...(item.hasSubMenu ? { hasSubMenu: true } : {}),
    })),

    // 模式设置
    { name: '/mode', description: cmd.mode, category: cat.mode, hasSubMenu: true },
    { name: '/thinking', description: cmd.thinking, category: cat.mode, hasSubMenu: true },
    { name: '/approval', description: cmd.approval, category: cat.mode, hasSubMenu: true },
    { name: '/sandbox', description: cmd.sandbox, category: cat.mode, hasSubMenu: true },
    { name: '/theme', description: cmd.theme, category: cat.mode },

    // Provider 和 Model
    { name: '/provider', description: cmd.provider, category: cat.ai, hasSubMenu: true },
    { name: '/model', description: cmd.model, category: cat.ai, hasSubMenu: true },
    { name: '/effort', description: getLanguage() === 'zh' ? '推理强度 (low / medium / high …)' : 'Reasoning effort (low / medium / high …)', category: cat.ai, hasSubMenu: true },
    { name: '/model-profile', description: cmd.modelProfile, category: cat.ai, hasSubMenu: true },

    // 会话管理 (session-* 子动作统一收进 /session <ls|new|info|export|clear>)
    { name: '/resume', description: getLanguage() === 'zh' ? '接着之前的会话聊' : 'Continue a previous session', category: cat.session },
    { name: '/session', description: cmd.session, category: cat.session, hasSubMenu: true },
    { name: '/checkpoint', description: cmd.checkpoint, category: cat.session },
    { name: '/rollback', description: cmd.rollback, category: cat.session, hasSubMenu: true },
    { name: '/undo', description: cmd.undo, category: cat.session },
    { name: '/compact', description: cmd.compact, category: cat.session },

    // 进程管理
    { name: '/ps', description: cmd.ps, category: cat.process },
    { name: '/kill', description: cmd.kill, category: cat.process },

    // Skills
    { name: '/skills', description: cmd.skills, category: cat.skills },

    // 工具和配置
    { name: '/workspace', description: cmd.workspace, category: cat.tools, hasSubMenu: true },
    { name: '/websearch', description: cmd.websearch, category: cat.tools, hasSubMenu: true },
    { name: '/mcp', description: cmd.mcp, category: cat.tools, hasSubMenu: true },
    { name: '/context', description: cmd.context, category: cat.tools, hasSubMenu: true },
    { name: '/memory', description: cmd.memory, category: cat.tools, hasSubMenu: true },
    { name: '/init', description: cmd.init, category: cat.tools, hasSubMenu: true },
    { name: '/attach', description: cmd.attach, category: cat.tools },
    { name: '/attachments', description: cmd.attachments, category: cat.tools, hasSubMenu: true },
    { name: '/remote', description: cmd.remote, category: cat.tools, hasSubMenu: true },
    { name: '/index', description: cmd.index, category: cat.tools, hasSubMenu: true },
    { name: '/cleanup', description: cmd.cleanup, category: cat.tools },

    // 统计
    { name: '/statistic', description: cmd.tokenStats, category: cat.stats },
    { name: '/stats', description: cmd.sessionStatus, category: cat.stats },

    // 配置
    { name: '/language', description: cmd.language, category: cat.config, hasSubMenu: true },
    { name: '/pricing', description: cmd.pricingConfig, category: cat.config },
    { name: '/config-clear', description: cmd.configClear, category: cat.config },
    { name: '/notify', description: cmd.notify, category: cat.config, hasSubMenu: true },
    { name: '/tts', description: cmd.tts, category: cat.config, hasSubMenu: true },
    { name: '/experimental', description: cmd.experimental, category: cat.config, hasSubMenu: true },
    { name: '/update', description: cmd.update, category: cat.config },
  ];

  /* /undo: 当前架构下没有按轮回退的通道, 敲了只会说"暂不可用" —— 不该出现在菜单里 (用 /rollback) */
  const HIDDEN = new Set([
    '/undo',
    '/checkpoint', '/statistic', '/kill', '/attachments', '/whoami', '/model-profile',
    '/cleanup', '/index', '/config-clear', '/pricing', '/experimental', '/tts',
  ]);
  return builtin.filter(c => !HIDDEN.has(c.name));
}

// 保留静态导出用于向后兼容（但建议使用 getSlashCommands()）
export const SLASH_COMMANDS: SlashCommand[] = getSlashCommands();

export interface SlashCommandMenuProps {
  isVisible: boolean;
  filter?: string;  // 可选的过滤字符串（如 /he 过滤出 /help）
  onSelect: (command: string) => void;
  onCancel: () => void;
}

const SlashCommandMenuComponent: React.FC<SlashCommandMenuProps> = ({
  isVisible,
  filter = '',
  onSelect,
  onCancel,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  // 自适应高度: 弹出菜单不能超出终端高度 (否则溢出 + 与上方内容重叠).
  // 预留 ~17 行给 输入行 / 状态行 / 菜单标题+提示+滚动指示+分隔+页码 / 底部状态栏.
  // 短终端进一步压缩, 始终分页保持紧凑 (像 checkpoint 菜单那样)。
  let termRows = 24;
  try {
    const so: any = process.stdout;
    if (so && so.isTTY && typeof so.rows === 'number' && so.rows > 0) termRows = so.rows;
  } catch { /* noop */ }
  const PAGE_SIZE = Math.max(4, Math.min(12, termRows - 17));

  // 动态获取命令列表 (国际化 + 按登录态过滤, 见 getSlashCommands);
  //   每次菜单显示 (filter 变) 重算 → 菜单实时反映最新登录态.
  const allCommands = React.useMemo(() => getSlashCommands(), [filter, isVisible]);
  const tr = t();

  // 过滤命令
  const filteredCommands = filter && filter !== '/'
    ? allCommands.filter(cmd =>
      cmd.name.toLowerCase().includes(filter.toLowerCase()) ||
      cmd.description.toLowerCase().includes(filter.toLowerCase())
    )
    : allCommands;

  // 重置选择当过滤条件变化时
  useEffect(() => {
    setSelectedIndex(0);
    setScrollOffset(0);
  }, [filter]);

  // 保持选中项在可见范围内
  useEffect(() => {
    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex);
    } else if (selectedIndex >= scrollOffset + PAGE_SIZE) {
      setScrollOffset(selectedIndex - PAGE_SIZE + 1);
    }
  }, [selectedIndex]);

  useInput(
    (input, key) => {
      if (!isVisible) return;

      if (key.escape) {
        onCancel();
        return;
      }

      if (key.upArrow) {
        setSelectedIndex(prev =>
          prev > 0 ? prev - 1 : filteredCommands.length - 1
        );
        return;
      }

      if (key.downArrow) {
        setSelectedIndex(prev =>
          prev < filteredCommands.length - 1 ? prev + 1 : 0
        );
        return;
      }

      // Page Up
      if (key.pageUp || (key.ctrl && input === 'u')) {
        setSelectedIndex(prev => Math.max(0, prev - PAGE_SIZE));
        return;
      }

      // Page Down
      if (key.pageDown || (key.ctrl && input === 'd')) {
        setSelectedIndex(prev =>
          Math.min(filteredCommands.length - 1, prev + PAGE_SIZE)
        );
        return;
      }

      if (key.return) {
        onSelect(filteredCommands.length > 0 ? filteredCommands[selectedIndex].name : filter.trim());
        return;
      }

      // Tab 只填充不执行
      if (key.tab) {
        if (filteredCommands.length > 0) {
          // 只填充命令名，不执行
          onSelect(filteredCommands[selectedIndex].name + ' ');
        }
        return;
      }
    },
    { isActive: isVisible }
  );

  const visibleCommands = filteredCommands.slice(
    scrollOffset,
    scrollOffset + PAGE_SIZE
  );

  const nameCol = Math.min(18, Math.max(8, ...visibleCommands.map(c => c.name.length))) + 2;
  const commandListItems = React.useMemo(() => {
    return visibleCommands.map((cmd, i) => {
      const actualIndex = scrollOffset + i;
      const isSelected = actualIndex === selectedIndex;
      return (
        <Box key={cmd.name}>
          <Text color={NeoxTheme.brand.purple}>{isSelected ? '› ' : '  '}</Text>
          <Text color={isSelected ? NeoxTheme.brand.purple : NeoxTheme.text.secondary} bold={isSelected}>
            {cmd.name.padEnd(nameCol)}
          </Text>
          <Text color={isSelected ? NeoxTheme.text.secondary : NeoxTheme.text.dim} wrap="truncate-end">
            {cmd.description}
          </Text>
        </Box>
      );
    });
  }, [visibleCommands, scrollOffset, selectedIndex, nameCol]);

  // 条件渲染必须在所有 hooks 之后
  if (!isVisible || filteredCommands.length === 0) {
    return null;
  }

  const below = filteredCommands.length - (scrollOffset + PAGE_SIZE);
  return (
    <Box flexDirection="column" paddingLeft={0}>
      {scrollOffset > 0 && <Text color={NeoxTheme.text.dim}>{`  ↑ ${scrollOffset} more`}</Text>}
      {commandListItems}
      {below > 0 && <Text color={NeoxTheme.text.dim}>{`  ↓ ${below} more`}</Text>}
      <Text color={NeoxTheme.text.dim}>
        {'  '}{tr.common.selectHint} · {formatMessage(tr.slashMenu.commandCount, { count: filteredCommands.length })}
      </Text>
    </Box>
  );
};

// This allows re-render when skillCommands array reference changes
export const SlashCommandMenu = React.memo(SlashCommandMenuComponent);
