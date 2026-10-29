/**
 * Generic Parser - 通用代码解析器
 *
 * 使用通用的正则表达式匹配常见的代码模式，
 * 作为不支持语言的回退方案。
 */

import { LanguageParser, SymbolInfo, SymbolKind } from '../types.js';
import { findBlockEnd, splitContentLines} from '../utils.js';

export class GenericParser implements LanguageParser {
  languageId = 'generic';
  extensions = ['*'];

  async parse(content: string, filePath: string): Promise<SymbolInfo[]> {
    const lines = splitContentLines(content);
    const symbols: SymbolInfo[] = [];

    // 通用模式 - 尝试匹配多种语言
    const patterns = {
      // 函数定义 (多语言)
      function: [
        // TypeScript/JavaScript/Java/C#: function name(/ void name(/ public name(
        /^(\s*)(export\s+)?(public\s+|private\s+|protected\s+)?(static\s+)?(async\s+)?(function\s+)?(\w+)\s*\([^)]*\)\s*[:{]/,
        // Go: func name(
        /^(\s*)func\s+(\w+)\s*\(/,
        // Rust: fn name(
        /^(\s*)(pub\s+)?fn\s+(\w+)\s*[<(]/,
        // Python: def name(
        /^(\s*)(async\s+)?def\s+(\w+)\s*\(/,
        // Ruby: def name
        /^(\s*)def\s+(\w+)/,
      ],
      // 类定义 (多语言)
      class: [
        // 大多数语言: class Name
        /^(\s*)(export\s+)?(public\s+|abstract\s+)?(class|struct)\s+(\w+)/,
        // Go: type Name struct
        /^(\s*)type\s+(\w+)\s+struct/,
        // Rust: struct Name / impl Name
        /^(\s*)(pub\s+)?struct\s+(\w+)/,
        /^(\s*)impl\s+(\w+)/,
      ],
      // 接口定义
      interface: [
        /^(\s*)(export\s+)?interface\s+(\w+)/,
        /^(\s*)type\s+(\w+)\s+interface/,
        /^(\s*)(pub\s+)?trait\s+(\w+)/,
      ],
      // 常量定义
      constant: [
        /^(\s*)(export\s+)?(const|final|static\s+final)\s+([A-Z_][A-Z0-9_]*)\s*[=:]/,
      ],
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // 跳过注释
      if (this.isComment(line)) continue;

      // 尝试匹配函数
      for (const pattern of patterns.function) {
        const match = line.match(pattern);
        if (match) {
          const name = this.extractName(match);
          if (name && !this.isKeyword(name)) {
            symbols.push({
              name,
              kind: 'function',
              startLine: lineNum,
              endLine: findBlockEnd(lines, i),
            });
          }
          break;
        }
      }

      // 尝试匹配类
      for (const pattern of patterns.class) {
        const match = line.match(pattern);
        if (match) {
          const name = this.extractName(match);
          if (name) {
            symbols.push({
              name,
              kind: 'class',
              startLine: lineNum,
              endLine: findBlockEnd(lines, i),
            });
          }
          break;
        }
      }

      // 尝试匹配接口
      for (const pattern of patterns.interface) {
        const match = line.match(pattern);
        if (match) {
          const name = this.extractName(match);
          if (name) {
            symbols.push({
              name,
              kind: 'interface',
              startLine: lineNum,
              endLine: findBlockEnd(lines, i),
            });
          }
          break;
        }
      }

      // 尝试匹配常量
      for (const pattern of patterns.constant) {
        const match = line.match(pattern);
        if (match) {
          const name = this.extractName(match);
          if (name) {
            symbols.push({
              name,
              kind: 'constant',
              startLine: lineNum,
              endLine: lineNum,
            });
          }
          break;
        }
      }
    }

    return symbols;
  }

  /**
   * 从匹配结果中提取名称
   */
  private extractName(match: RegExpMatchArray): string | null {
    // 从后向前查找，跳过空组
    for (let i = match.length - 1; i > 0; i--) {
      const group = match[i];
      if (group && /^\w+$/.test(group) && !this.isModifier(group)) {
        return group;
      }
    }
    return null;
  }

  /**
   * 检查是否是修饰符
   */
  private isModifier(word: string): boolean {
    const modifiers = [
      'public', 'private', 'protected', 'static', 'final', 'abstract',
      'async', 'export', 'const', 'let', 'var', 'function', 'class',
      'interface', 'type', 'enum', 'struct', 'impl', 'fn', 'func',
      'def', 'pub', 'trait',
    ];
    return modifiers.includes(word.toLowerCase());
  }

  /**
   * 检查是否是关键字
   */
  private isKeyword(word: string): boolean {
    const keywords = [
      'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
      'continue', 'return', 'try', 'catch', 'finally', 'throw',
      'new', 'this', 'super', 'null', 'undefined', 'true', 'false',
      'import', 'from', 'as', 'default', 'with', 'in', 'of',
      'get', 'set', 'constructor',
    ];
    return keywords.includes(word);
  }

  /**
   * 检查是否是注释行
   */
  private isComment(line: string): boolean {
    const trimmed = line.trim();
    return (
      trimmed.startsWith('//') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('--')
    );
  }

  buildSymbolPattern(name: string, kind?: SymbolKind): string {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    switch (kind) {
      case 'function':
        return `(function|func|fn|def)\\s+${escapedName}|${escapedName}\\s*\\(`;
      case 'class':
        return `(class|struct|type)\\s+${escapedName}`;
      case 'interface':
        return `(interface|trait)\\s+${escapedName}`;
      default:
        return `(function|class|interface|struct|type|func|fn|def)\\s+${escapedName}|${escapedName}\\s*[=(]`;
    }
  }
}
