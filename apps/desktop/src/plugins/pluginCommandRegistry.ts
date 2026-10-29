/**
 * Plugin Command Registry — 插件贡献的斜杠命令
 *
 * 定义一个与内置 SLASH_COMMANDS 对等但可动态扩展的注册表.
 * 插件通过 `.md` 文件 (frontmatter + body) 声明命令:
 *
 *   ---
 *   name: /summarize
 *   description: 总结当前文件
 *   category: Plugin
 *   usage: "/summarize [file-path]"
 *   allowed-tools: [readfile, grep]
 *   ---
 *   请总结以下文件的核心逻辑, 控制在 10 句话内:
 *
 *   文件路径: $1
 *
 *   内容:
 *   $ARGUMENTS
 *
 * 执行时:
 *   - prompt body 做变量替换 ($1/$2/... 位置参数, $ARGUMENTS 全量)
 *   - 替换后的 prompt 作为用户消息送给 LLM
 *
 * CLI (InputLine) 和 UI (CommandPalette) 通过 list() / find() 查询.
 */

import * as fs from 'fs';
import * as path from 'path';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export interface PluginCommandDefinition {
  /** 命令名, 带 `/` 前缀 (约定小写连字符, 如 `/summarize-file`) */
  name: string;
  /** 一句话描述 (命令菜单显示) */
  description: string;
  /** 分类 (默认 'plugin') */
  category?: string;
  /** 用法示例 (如 `/summarize <path>`) */
  usage?: string;
  /** 允许使用的工具白名单 (未来做权限用, 当前仅保留) */
  allowedTools?: string[];
  /** prompt 模板 (frontmatter 下方 body, 支持 $1 $2 $ARGUMENTS) */
  promptTemplate: string;
  /** 来源插件名 */
  pluginName: string;
}

export interface PluginCommandInvocation {
  command: PluginCommandDefinition;
  /** 展开变量后的最终 prompt (送给 LLM 的用户消息) */
  prompt: string;
  /** 原始参数字符串 ($ARGUMENTS) */
  argumentsRaw: string;
  /** 位置参数数组 ($1, $2, ...) */
  argumentsList: string[];
}

export class PluginCommandRegistry {
  private commands = new Map<string, PluginCommandDefinition>();

  /** 注册单个命令 */
  register(def: PluginCommandDefinition): void {
    const key = normalizeName(def.name);
    if (this.commands.has(key)) {
      cliLogger.warn('PLUGIN_CMD', `Command ${key} already registered, overwriting (owner ${def.pluginName})`);
    }
    this.commands.set(key, { ...def, name: key });
  }

  /** 从目录加载 `.md` 命令 — 用于 pluginIntegration. */
  async loadFromPath(dirOrFile: string, pluginName: string): Promise<number> {
    if (!fs.existsSync(dirOrFile)) return 0;
    const stat = fs.statSync(dirOrFile);
    const files: string[] = [];
    if (stat.isFile()) {
      files.push(dirOrFile);
    } else {
      for (const entry of fs.readdirSync(dirOrFile, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push(path.join(dirOrFile, entry.name));
        }
      }
    }

    let count = 0;
    for (const file of files) {
      try {
        const def = parseMdCommand(file, pluginName);
        this.register(def);
        count++;
      } catch (err: any) {
        cliLogger.warn('PLUGIN_CMD', `[${pluginName}] Failed to load ${file}: ${err?.message}`);
      }
    }
    return count;
  }

  /** 移除某插件贡献的所有命令 */
  unregisterPlugin(pluginName: string): number {
    let removed = 0;
    for (const [name, def] of [...this.commands.entries()]) {
      if (def.pluginName === pluginName) {
        this.commands.delete(name);
        removed++;
      }
    }
    return removed;
  }

  /** 列出所有命令 (供命令菜单合并) */
  list(): PluginCommandDefinition[] {
    return [...this.commands.values()];
  }

  /** 精确查找 */
  find(name: string): PluginCommandDefinition | undefined {
    return this.commands.get(normalizeName(name));
  }

  /**
   * 解析用户输入. 例如 `/summarize a b c`:
   *   - command = /summarize
   *   - argumentsRaw = 'a b c'
   *   - argumentsList = ['a', 'b', 'c']
   *   - prompt = template 替换后的文本
   *
   * 未匹配返回 null.
   */
  parseAndExpand(input: string): PluginCommandInvocation | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return null;
    const spaceIdx = trimmed.indexOf(' ');
    const cmdName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const argsRaw = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

    const def = this.find(cmdName);
    if (!def) return null;

    const argsList = argsRaw === '' ? [] : argsRaw.split(/\s+/);
    const prompt = expandPromptTemplate(def.promptTemplate, argsList, argsRaw);

    return {
      command: def,
      prompt,
      argumentsRaw: argsRaw,
      argumentsList: argsList,
    };
  }
}

export const pluginCommandRegistry = new PluginCommandRegistry();

// ==================== Helpers ====================

function normalizeName(name: string): string {
  let n = name.trim();
  if (!n.startsWith('/')) n = '/' + n;
  return n.toLowerCase();
}

function expandPromptTemplate(
  template: string,
  argsList: string[],
  argsRaw: string,
): string {
  let out = template;
  // $ARGUMENTS 整串替换
  out = out.replace(/\$ARGUMENTS\b/g, argsRaw);
  // $1..$9 按位替换
  out = out.replace(/\$(\d+)/g, (_, idx) => {
    const i = parseInt(idx, 10) - 1;
    return argsList[i] ?? '';
  });
  return out;
}

function parseMdCommand(filePath: string, pluginName: string): PluginCommandDefinition {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);

  let name = '';
  let description = '';
  let category: string | undefined;
  let usage: string | undefined;
  let allowedTools: string[] | undefined;
  let body = raw;

  if (match) {
    body = match[2];
    for (const line of match[1].split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const colonIdx = t.indexOf(':');
      if (colonIdx === -1) continue;
      const key = t.slice(0, colonIdx).trim().toLowerCase();
      const val = t.slice(colonIdx + 1).trim();
      switch (key) {
        case 'name': name = stripQuotes(val); break;
        case 'description': description = stripQuotes(val); break;
        case 'category': category = stripQuotes(val); break;
        case 'usage': usage = stripQuotes(val); break;
        case 'allowed-tools':
        case 'allowedtools': {
          if (val.startsWith('[') && val.endsWith(']')) {
            const inner = val.slice(1, -1).trim();
            allowedTools = inner === '' ? [] : inner.split(',').map(s => stripQuotes(s.trim()));
          }
          break;
        }
      }
    }
  }

  if (!name) {
    // Fallback: 用文件名作为命令名
    name = '/' + path.basename(filePath, '.md');
  }
  if (!description) {
    description = `[${pluginName}] plugin command`;
  }

  return {
    name,
    description,
    category: category ?? 'plugin',
    usage,
    allowedTools,
    promptTemplate: body.trim(),
    pluginName,
  };
}

function stripQuotes(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}
