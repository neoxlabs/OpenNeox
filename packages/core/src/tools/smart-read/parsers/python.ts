/**
 * Python Parser - 使用正则表达式解析 Python 代码
 */

import { LanguageParser, SymbolInfo, SymbolKind } from '../types.js';
import { splitContentLines } from '../utils.js';

export class PythonParser implements LanguageParser {
  languageId = 'python';
  extensions = ['.py', '.pyw'];

  async parse(content: string, filePath: string): Promise<SymbolInfo[]> {
    const lines = splitContentLines(content);
    const symbols: SymbolInfo[] = [];

    const patterns = {
      // class ClassName: or class ClassName(Parent):
      class: /^(\s*)class\s+(\w+)(\s*\([^)]*\))?\s*:/,
      // def function_name(or async def function_name(
      function: /^(\s*)(async\s+)?def\s+(\w+)\s*\(/,
      // 变量赋值 (顶层)
      variable: /^([A-Z][A-Z0-9_]*)\s*[=:]/,
    };

    let currentClass: SymbolInfo | null = null;
    let classIndent = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // 计算当前行的缩进
      const currentIndent = line.match(/^(\s*)/)?.[1].length || 0;

      // 检查是否退出了当前类
      if (currentClass && line.trim() && currentIndent <= classIndent) {
        currentClass.endLine = i;
        symbols.push(currentClass);
        currentClass = null;
        classIndent = -1;
      }

      // 跳过注释和空行
      if (line.trim().startsWith('#') || !line.trim()) {
        continue;
      }

      // 匹配类
      const classMatch = line.match(patterns.class);
      if (classMatch) {
        // 保存之前的类
        if (currentClass) {
          currentClass.endLine = i;
          symbols.push(currentClass);
        }

        classIndent = classMatch[1].length;
        currentClass = {
          name: classMatch[2],
          kind: 'class',
          startLine: lineNum,
          endLine: this.findClassEnd(lines, i, classIndent),
          children: [],
          docstring: this.extractDocstring(lines, i + 1),
        };
        continue;
      }

      // 匹配函数/方法
      const funcMatch = line.match(patterns.function);
      if (funcMatch) {
        const funcIndent = funcMatch[1].length;
        const funcName = funcMatch[3];
        const isMethod = currentClass && funcIndent > classIndent;

        const func: SymbolInfo = {
          name: funcName,
          kind: isMethod ? 'method' : 'function',
          startLine: lineNum,
          endLine: this.findFunctionEnd(lines, i, funcIndent),
          docstring: this.extractDocstring(lines, i + 1),
        };

        if (isMethod && currentClass) {
          func.parent = currentClass.name;
          currentClass.children!.push(func);
        } else {
          symbols.push(func);
        }
        continue;
      }

      // 匹配顶层常量 (全大写)
      if (!currentClass && line.match(patterns.variable)) {
        const varMatch = line.match(patterns.variable);
        if (varMatch) {
          symbols.push({
            name: varMatch[1],
            kind: 'constant',
            startLine: lineNum,
            endLine: lineNum,
          });
        }
      }
    }

    // 保存最后一个类
    if (currentClass) {
      currentClass.endLine = lines.length;
      symbols.push(currentClass);
    }

    return symbols;
  }

  /**
   * 查找类结束位置 (通过缩进)
   */
  private findClassEnd(lines: string[], startIdx: number, classIndent: number): number {
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue; // 跳过空行

      const currentIndent = line.match(/^(\s*)/)?.[1].length || 0;
      // 遇到更小或相等缩进的非空行，类结束
      if (currentIndent <= classIndent) {
        return i;
      }
    }
    return lines.length;
  }

  /**
   * 查找函数结束位置 (通过缩进)
   */
  private findFunctionEnd(lines: string[], startIdx: number, funcIndent: number): number {
    let foundBody = false;

    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i];

      // 跳过空行和纯注释行（在函数内部）
      if (!line.trim()) {
        continue;
      }

      const currentIndent = line.match(/^(\s*)/)?.[1].length || 0;

      // 函数体必须有更大的缩进
      if (currentIndent > funcIndent) {
        foundBody = true;
        continue;
      }

      // 遇到更小或相等缩进的非空行
      if (foundBody && currentIndent <= funcIndent) {
        return i;
      }
    }

    return lines.length;
  }

  /**
   * 提取文档字符串
   */
  private extractDocstring(lines: string[], startIdx: number): string | undefined {
    if (startIdx >= lines.length) return undefined;

    const line = lines[startIdx].trim();

    // 检查是否是文档字符串开始
    if (line.startsWith('"""') || line.startsWith("'''")) {
      const quote = line.startsWith('"""') ? '"""' : "'''";

      // 单行文档字符串
      if (line.endsWith(quote) && line.length > 6) {
        return line.slice(3, -3);
      }

      // 多行文档字符串
      const docLines: string[] = [line.slice(3)];
      for (let i = startIdx + 1; i < lines.length; i++) {
        const docLine = lines[i].trim();
        if (docLine.endsWith(quote)) {
          docLines.push(docLine.slice(0, -3));
          break;
        }
        docLines.push(docLine);
      }

      return docLines.join('\n').trim();
    }

    return undefined;
  }

  buildSymbolPattern(name: string, kind?: SymbolKind): string {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    switch (kind) {
      case 'function':
      case 'method':
        return `(async\\s+)?def\\s+${escapedName}\\s*\\(`;
      case 'class':
        return `class\\s+${escapedName}(\\s*\\(|\\s*:)`;
      case 'variable':
      case 'constant':
        return `^${escapedName}\\s*[=:]`;
      default:
        return `(def|class)\\s+${escapedName}|^${escapedName}\\s*[=:]`;
    }
  }
}
