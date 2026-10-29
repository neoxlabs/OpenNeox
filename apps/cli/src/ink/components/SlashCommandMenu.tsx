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
import { MenuPanel, MenuRow, Highlight } from './MenuPanel.js';

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
    { name: '/feedback', description: getLanguage() === 'zh' ? '反馈问题 / 报 bug' : 'Send feedback / report a bug', category: cat.basic },

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
    { name: '/output-style', description: getLanguage() === 'zh' ? '回复风格 (标准 / 简洁 / 详细 / 只要代码 / 自定义)' : 'Reply style (standard / concise / detailed / code only / custom)', category: cat.ai, hasSubMenu: true },
    { name: '/diagnostics', description: getLanguage() === 'zh' ? '请求诊断 (缓存命中 / 失效原因 / 侧路调用)' : 'Request diagnostics (cache hits, drop reasons, side calls)', category: cat.ai },
    { name: '/model-profile', description: cmd.modelProfile, category: cat.ai, hasSubMenu: true },

    // 会话管理 (session-* 子动作统一收进 /session <ls|new|info|export|clear>)
    { name: '/resume', description: getLanguage() === 'zh' ? '接着之前的会话聊' : 'Continue a previous session', category: cat.session },
    { name: '/session', description: cmd.session, category: cat.session, hasSubMenu: true },
    { name: '/checkpoint', description: cmd.checkpoint, category: cat.session },
    { name: '/rollback', description: cmd.rollback, category: cat.session, hasSubMenu: true },
    { name: '/changes', description: cmd.changes, category: cat.session },
    { name: '/undo', description: cmd.undo, category: cat.session },
    { name: '/compact', description: cmd.compact, category: cat.session },
    { name: '/target', description: getLanguage() === 'zh' ? '长跑目标: 一直干到做完 (status / pause / continue / refine / off)' : 'Long-run goal: keep working until done (status / pause / continue / refine / off)', category: cat.session },

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

  const HIDDEN = new Set([
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
  /* 多了一行抬头 (设计稿), 选项区少一行, 菜单总高不变 */
  const PAGE_SIZE = Math.max(4, Math.min(12, termRows - 18));

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

  type Row = { kind: 'group'; label: string } | { kind: 'cmd'; cmd: SlashCommand; index: number };
  const grouped = !(filter && filter !== '/');
  const rows: Row[] = React.useMemo(() => {
    const out: Row[] = [];
    let prev = '';
    filteredCommands.forEach((cmd, index) => {
      if (grouped && cmd.category !== prev) { out.push({ kind: 'group', label: cmd.category }); prev = cmd.category; }
      out.push({ kind: 'cmd', cmd, index });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredCommands.length, filter, grouped]);
  const selRow = Math.max(0, rows.findIndex(r => r.kind === 'cmd' && r.index === selectedIndex));

  // 保持选中项在可见范围内 (往上翻时把它头上的分组名一起带进来)
  useEffect(() => {
    const top = rows[selRow - 1]?.kind === 'group' ? selRow - 1 : selRow;
    if (top < scrollOffset) {
      setScrollOffset(top);
    } else if (selRow >= scrollOffset + PAGE_SIZE) {
      setScrollOffset(selRow - PAGE_SIZE + 1);
    }
  }, [selRow]);

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

  const visibleRows = rows.slice(scrollOffset, scrollOffset + PAGE_SIZE);
  if (visibleRows.length === PAGE_SIZE && visibleRows[visibleRows.length - 1]?.kind === 'group') {
    visibleRows[visibleRows.length - 1] = { kind: 'group', label: ' ' };
  }

  /* 两栏: 命令名一栏, 描述灰色一栏; 右侧 › 表示还有下一级菜单。选中 = 钴蓝 › + 钴蓝粗体名字。
   * 抬头「命令 ⇥ 打字筛选 · tab 补全」, 底栏「还有 N 个 · ↵ 执行 · esc 关闭」(设计稿)。 */
  const nameCol = Math.min(18, Math.max(8, ...filteredCommands.map(c => c.name.length))) + 2;
  /* 筛选命中的字标钴蓝 (打 "/co" → /compact 的 co 亮) */
  const q = filter && filter !== '/' ? filter.replace(/^\//, '') : '';
  const zhMenu = getLanguage() === 'zh';
  const commandListItems = React.useMemo(() => {
    return visibleRows.map((row, i) => {
      if (row.kind === 'group') {
        return <Box key={`g-${row.label}-${i}`} paddingX={2}><Text color={NeoxTheme.text.faint}>{row.label}</Text></Box>;
      }
      const { cmd, index } = row;
      const isSelected = index === selectedIndex;
      return (
        <MenuRow key={cmd.name} selected={isSelected} right={cmd.hasSubMenu ? '›' : undefined}>
          <Box width={nameCol} flexShrink={0}>
            <Highlight text={cmd.name} q={q} color={isSelected ? NeoxTheme.brand.purple : undefined} bold={isSelected} />
          </Box>
          <Text color={isSelected ? NeoxTheme.text.secondary : NeoxTheme.text.dim} wrap="truncate-end">
            {cmd.description}
          </Text>
        </MenuRow>
      );
    });
  }, [visibleRows, selectedIndex, nameCol, q]);

  // 条件渲染必须在所有 hooks 之后
  if (!isVisible || filteredCommands.length === 0) {
    return null;
  }

  const hiddenBelow = rows.slice(scrollOffset + PAGE_SIZE).filter(r => r.kind === 'cmd').length;
  const title = zhMenu ? '命令' : 'Commands';
  const hint = grouped
    ? (zhMenu ? '打字筛选 · tab 补全' : 'type to filter · tab to complete')
    : formatMessage(tr.slashMenu.commandCount, { count: filteredCommands.length });
  const footer = [
    hiddenBelow > 0 ? (zhMenu ? `↓ 还有 ${hiddenBelow} 个` : `↓ ${hiddenBelow} more`) : '',
    zhMenu ? '↑↓ 选 · ↵ 执行 · esc 关闭' : '↑↓ select · ↵ run · esc close',
  ].filter(Boolean).join(' · ');
  return (
    <MenuPanel title={title} hint={hint} footer={footer}>
      {commandListItems}
    </MenuPanel>
  );
};

// This allows re-render when skillCommands array reference changes
export const SlashCommandMenu = React.memo(SlashCommandMenuComponent);
