/**
 * Language Parser Registry - 语言解析器注册表
 */

import { LanguageParser, SymbolInfo, SymbolKind } from '../types.js';
import { TypeScriptParser } from './typescript.js';
import { PythonParser } from './python.js';
import { GenericParser } from './generic.js';

/**
 * 语言解析器注册表
 */
export class LanguageParserRegistry {
  private parsers: Map<string, LanguageParser> = new Map();

  constructor() {
    // 注册内置解析器
    this.register(new TypeScriptParser());
    this.register(new PythonParser());
    this.register(new GenericParser());
  }

  /**
   * 注册解析器
   */
  register(parser: LanguageParser): void {
    this.parsers.set(parser.languageId, parser);

    // 也为扩展名建立映射
    for (const ext of parser.extensions) {
      const extLang = this.getLanguageFromExtension(ext);
      if (extLang && !this.parsers.has(extLang)) {
        // 使用扩展名作为别名
      }
    }
  }

  /**
   * 获取解析器
   */
  getParser(language: string): LanguageParser | null {
    // 直接匹配
    if (this.parsers.has(language)) {
      return this.parsers.get(language)!;
    }

    // JavaScript 使用 TypeScript 解析器
    if (language === 'javascript') {
      return this.parsers.get('typescript') || null;
    }

    // 回退到通用解析器
    return this.parsers.get('generic') || null;
  }

  /**
   * 从扩展名获取语言
   */
  private getLanguageFromExtension(ext: string): string | null {
    const extMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.py': 'python',
      '.java': 'java',
      '.go': 'go',
      '.rs': 'rust',
    };
    return extMap[ext] || null;
  }

  /**
   * 获取所有支持的语言
   */
  getSupportedLanguages(): string[] {
    return Array.from(this.parsers.keys()).filter(lang => lang !== 'generic');
  }
}
