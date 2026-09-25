/**
 * Help Command Text
 * Contains all help text for CLI commands
 */

import { colors } from '../constants.js';
import { cliPrintln } from '../utils/output.js';
import { getLanguage } from '../i18n/index.js';
import { getSlashCommands, type SlashCommand } from '../ink/components/SlashCommandMenu.js';

const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

/**
 * Help category for interactive menu
 */
export interface HelpCategory {
  id: string;
  title: string;
  description: string;
}

export function getHelpCategories(): HelpCategory[] {
  const zh = getLanguage() === 'zh';
  const skip = new Set(['/help', '/exit']);
  return [
    { id: 'help-text', title: zh ? '全部命令和快捷键' : 'All commands & shortcuts', description: '' },
    ...getSlashCommands()
      .filter(c => !skip.has(c.name))
      .map(c => ({ id: c.name, title: c.name, description: c.description })),
  ];
}

/**
 * Output function type for flexible output handling
 */
type OutputFn = (message: string, details?: string) => void;

/**
 * Default output function using cliPrintln
 */
function defaultOutput(message: string, _details?: string): void {
  cliPrintln(message);
}

/**
 * Pad a command name to a fixed column width (accounting for the leading 4-space indent
 * being applied by the caller). Keeps the description column aligned.
 */
function padCommandName(name: string): string {
  const COL = 16;
  return name.length >= COL ? name + ' ' : name.padEnd(COL, ' ');
}

function getBasicCommandsHelpLines(): string[] {
  const lines: string[] = [];
  const zh = getLanguage() === 'zh';
  lines.push('');
  lines.push(bold(zh ? '  命令' : '  Commands') + colors.dim(zh ? '  输入 / 可以边打边筛' : '  type / to filter as you go'));

  const commands = getSlashCommands();

  // 按 category 分组, 保留首次出现顺序 (getSlashCommands 已按分类排好)
  const groups: Array<{ category: string; items: SlashCommand[] }> = [];
  const byCategory = new Map<string, SlashCommand[]>();
  for (const c of commands) {
    let bucket = byCategory.get(c.category);
    if (!bucket) {
      bucket = [];
      byCategory.set(c.category, bucket);
      groups.push({ category: c.category, items: bucket });
    }
    bucket.push(c);
  }

  for (const group of groups) {
    lines.push('');
    lines.push(colors.dim(`  ${group.category}:`));
    for (const c of group.items) {
      lines.push(colors.primary(`    ${padCommandName(c.name)}`) + colors.dim(c.description));
    }
  }

  return lines;
}

/**
 * Print basic commands help
 */
export function printBasicCommandsHelp(output: OutputFn = defaultOutput): void {
  for (const line of getBasicCommandsHelpLines()) {
    output(line);
  }
}

/**
 * Get session commands help lines.
 *
 * 会话相关命令 (/session /checkpoint /rollback /undo /compact /cleanup) 现已统一从
 * getSlashCommands() 派生进 getBasicCommandsHelpLines() 的分组列表, 这里不再重复维护
 * (旧实现引用了已删除的 /sessions /session-new /session-info /checkpoints /session-clear
 * /session-export, 是漂移的主要来源). 保留导出名做向后兼容, 仅补一条会话子命令用法说明.
 */
function getSessionCommandsHelpLines(): string[] {
  const zh = getLanguage() === 'zh';
  return [
    '',
    colors.dim(zh
      ? '  会话: /session <ls|new|info|export|clear>  ·  /rollback <id>'
      : '  Sessions: /session <ls|new|info|export|clear>  ·  /rollback <id>'),
  ];
}

/**
 * Print session commands help
 */
export function printSessionCommandsHelp(output: OutputFn = defaultOutput): void {
  for (const line of getSessionCommandsHelpLines()) {
    output(line);
  }
}

/**
 * Get process management commands help lines.
 *
 * /ps /kill 现从 getSlashCommands() 派生进基本命令列表, 这里只补充直接参数用法.
 */
function getProcessCommandsHelpLines(): string[] {
  const zh = getLanguage() === 'zh';
  return [
    colors.dim(zh
      ? '  后台命令: /ps 查看  ·  /kill <pid> 结束一个  ·  /kill all 全部结束'
      : '  Background: /ps to list  ·  /kill <pid>  ·  /kill all'),
  ];
}

/**
 * Print process management commands help
 */
export function printProcessCommandsHelp(output: OutputFn = defaultOutput): void {
  for (const line of getProcessCommandsHelpLines()) {
    output(line);
  }
}

/**
 * Get keyboard shortcuts help lines
 */
function getKeyboardShortcutsHelpLines(): string[] {
  const zh = getLanguage() === 'zh';
  const row = (key: string, desc: string) => colors.primary(`    ${key.padEnd(10)}`) + colors.dim(desc);
  return [
    '',
    bold(zh ? '  快捷键' : '  Shortcuts'),
    row('esc', zh ? '打断当前回答; 还没开始回答时消息退回输入框' : 'interrupt; an unanswered message goes back to the input'),
    row('tab', zh ? '看后台命令和子 agent' : 'background commands & sub-agents'),
    row('ctrl+o', zh ? '完整对话记录' : 'full transcript'),
    row('↑ / ↓', zh ? '翻历史输入 · 菜单里上下选' : 'input history · move in menus'),
    row('ctrl+c', zh ? '退出' : 'quit'),
    '',
  ];
}

/**
 * Print keyboard shortcuts help
 */
export function printKeyboardShortcutsHelp(output: OutputFn = defaultOutput): void {
  for (const line of getKeyboardShortcutsHelpLines()) {
    output(line);
  }
}

/**
 * Print full help text
 * @param output Optional output function (defaults to cliPrintln)
 */
export function printFullHelp(output: OutputFn = defaultOutput): void {
  printBasicCommandsHelp(output);
  printSessionCommandsHelp(output);
  printProcessCommandsHelp(output);
  printKeyboardShortcutsHelp(output);
}

/**
 * Print help for a specific category
 * @param categoryId The category ID to print
 * @param output Optional output function
 */
export function printCategoryHelp(
  categoryId: string,
  output: OutputFn = defaultOutput
): void {
  switch (categoryId) {
    case 'basic':
      printBasicCommandsHelp(output);
      break;
    case 'session':
      printSessionCommandsHelp(output);
      break;
    case 'process':
      printProcessCommandsHelp(output);
      break;
    case 'shortcuts':
      printKeyboardShortcutsHelp(output);
      break;
    case 'all':
    default:
      printFullHelp(output);
      break;
  }
}

/**
 * Get help categories as selection choices
 */
export function getHelpCategoryChoices(): Array<{ title: string; value: string; description?: string }> {
  return getHelpCategories().map(cat => ({
    title: cat.title,
    value: cat.id,
    description: cat.description,
  }));
}
