/**
 * TypeScript/JavaScript Parser - 使用正则表达式解析
 *
 * 注意: 这是一个简化的解析器，使用正则表达式而非完整的 AST 解析。
 * 对于大多数常见的代码模式已经足够，但可能无法处理所有边缘情况。
 */

import { LanguageParser, SymbolInfo, SymbolKind } from '../types.js';
import { findBlockEnd, splitContentLines} from '../utils.js';

export class TypeScriptParser implements LanguageParser {
  languageId = 'typescript';
  extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

  async parse(content: string, filePath: string): Promise<SymbolInfo[]> {
    const lines = splitContentLines(content);
    const symbols: SymbolInfo[] = [];

    // 匹配模式
    const patterns = {
      // export class ClassName { or class ClassName {
      class: /^(\s*)(export\s+)?(abstract\s+)?class\s+(\w+)(\s+extends\s+\w+)?(\s+implements\s+[\w,\s]+)?/,
      // export interface InterfaceName { or interface InterfaceName {
      interface: /^(\s*)(export\s+)?interface\s+(\w+)(\s+extends\s+[\w,\s]+)?/,
      // export type TypeName = or type TypeName =
      type: /^(\s*)(export\s+)?type\s+(\w+)\s*[=<]/,
      // export enum EnumName { or enum EnumName {
      enum: /^(\s*)(export\s+)?enum\s+(\w+)/,
      // export function functionName(or function functionName(or async function
      function: /^(\s*)(export\s+)?(async\s+)?function\s+(\w+)\s*[<(]/,
      // export const/let/var name = function or arrow function
      constFunction: /^(\s*)(export\s+)?(const|let|var)\s+(\w+)\s*[=:]\s*(async\s+)?(\([^)]*\)|[a-zA-Z_]\w*)\s*(=>|:.*=>)/,
      // export const/let/var name = (不是函数的情况)
      variable: /^(\s*)(export\s+)?(const|let|var)\s+(\w+)\s*[=:]/,
      // 类方法: methodName(...) { or async methodName(
      method: /^(\s+)(public\s+|private\s+|protected\s+)?(static\s+)?(async\s+)?(\w+)\s*[<(]/,
      // 类属性: propertyName: Type or propertyName = value
      property: /^(\s+)(public\s+|private\s+|protected\s+)?(static\s+)?(readonly\s+)?(\w+)\s*[=:?]/,
    };

    let currentClass: SymbolInfo | null = null;
    let classIndent = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // 检查是否退出了当前类
      if (currentClass) {
        const indent = line.match(/^(\s*)/)?.[1].length || 0;
        // 如果遇到更小缩进的非空行，说明类结束了
        if (line.trim() && indent <= classIndent && !line.match(/^\s*[})\]]/)) {
          // 计算类的结束行
          currentClass.endLine = i;
          symbols.push(currentClass);
          currentClass = null;
        }
      }

      // 跳过注释和空行
      if (line.trim().startsWith('//') || line.trim().startsWith('/*') || !line.trim()) {
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
          name: classMatch[4],
          kind: 'class',
          startLine: lineNum,
          endLine: this.findSymbolEnd(lines, i),
          children: [],
        };

        // 提取可能的 docstring (上一行的注释)
        if (i > 0) {
          const prevLine = lines[i - 1].trim();
          if (prevLine.startsWith('/**') || prevLine.startsWith('/*')) {
            currentClass.docstring = this.extractDocstring(lines, i - 1);
          } else if (prevLine.startsWith('//')) {
            currentClass.docstring = prevLine.replace(/^\/\/\s*/, '');
          }
        }

        continue;
      }

      // 匹配接口
      const interfaceMatch = line.match(patterns.interface);
      if (interfaceMatch) {
        symbols.push({
          name: interfaceMatch[3],
          kind: 'interface',
          startLine: lineNum,
          endLine: this.findSymbolEnd(lines, i),
        });
        continue;
      }

      // 匹配类型
      const typeMatch = line.match(patterns.type);
      if (typeMatch) {
        symbols.push({
          name: typeMatch[3],
          kind: 'type',
          startLine: lineNum,
          endLine: this.findTypeEnd(lines, i),
        });
        continue;
      }

      // 匹配枚举
      const enumMatch = line.match(patterns.enum);
      if (enumMatch) {
        symbols.push({
          name: enumMatch[3],
          kind: 'enum',
          startLine: lineNum,
          endLine: this.findSymbolEnd(lines, i),
        });
        continue;
      }

      // 匹配函数 (非类内)
      if (!currentClass) {
        const funcMatch = line.match(patterns.function);
        if (funcMatch) {
          symbols.push({
            name: funcMatch[4],
            kind: 'function',
            startLine: lineNum,
            endLine: this.findSymbolEnd(lines, i),
          });
          continue;
        }

        // 匹配 const 函数
        const constFuncMatch = line.match(patterns.constFunction);
        if (constFuncMatch) {
          symbols.push({
            name: constFuncMatch[4],
            kind: 'function',
            startLine: lineNum,
            endLine: this.findSymbolEnd(lines, i),
          });
          continue;
        }

        // 匹配变量
        const varMatch = line.match(patterns.variable);
        if (varMatch && !patterns.constFunction.test(line)) {
          symbols.push({
            name: varMatch[4],
            kind: 'variable',
            startLine: lineNum,
            endLine: lineNum,
          });
          continue;
        }
      }

      // 类内部的方法和属性
      if (currentClass) {
        // 匹配方法
        const methodMatch = line.match(patterns.method);
        if (methodMatch && !['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(methodMatch[5])) {
          const method: SymbolInfo = {
            name: methodMatch[5],
            kind: methodMatch[5] === 'constructor' ? 'method' : 'method',
            startLine: lineNum,
            endLine: this.findSymbolEnd(lines, i),
            parent: currentClass.name,
          };
          currentClass.children!.push(method);
          continue;
        }

        // 匹配属性 (只匹配明显的属性定义)
        const propMatch = line.match(patterns.property);
        if (propMatch && !['if', 'for', 'while', 'switch', 'catch', 'return', 'const', 'let', 'var'].includes(propMatch[5])) {
          const prop: SymbolInfo = {
            name: propMatch[5],
            kind: 'variable',
            startLine: lineNum,
            endLine: lineNum,
            parent: currentClass.name,
          };
          currentClass.children!.push(prop);
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
   * 查找符号结束位置 (括号匹配)
   */
  private findSymbolEnd(lines: string[], startIdx: number): number {
    return findBlockEnd(lines, startIdx);
  }

  /**
   * 查找类型定义结束位置
   */
  private findTypeEnd(lines: string[], startIdx: number): number {
    // 类型可能跨多行
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      // 遇到分号或下一个定义
      if (line.includes(';') || (i > startIdx && /^(export|type|interface|class|function|const|let|var)/.test(line.trim()))) {
        return i + 1;
      }
    }
    return startIdx + 1;
  }

  /**
   * 提取文档注释
   */
  private extractDocstring(lines: string[], startIdx: number): string {
    const docLines: string[] = [];

    // 向上查找注释开始
    let i = startIdx;
    while (i >= 0) {
      const line = lines[i].trim();
      if (line.startsWith('/**') || line.startsWith('/*')) {
        break;
      }
      i--;
    }

    // 收集注释内容
    for (let j = i; j <= startIdx; j++) {
      let line = lines[j].trim();
      // 移除注释标记
      line = line.replace(/^\/\*\*?\s*/, '').replace(/\*\/\s*$/, '').replace(/^\*\s?/, '');
      if (line) {
        docLines.push(line);
      }
    }

    return docLines.join('\n');
  }

  buildSymbolPattern(name: string, kind?: SymbolKind): string {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    switch (kind) {
      case 'function':
        return `(function|async\\s+function|const|let|var)\\s+${escapedName}\\s*[=(<]`;
      case 'class':
        return `class\\s+${escapedName}(\\s+extends|\\s+implements|\\s*\\{)`;
      case 'interface':
        return `interface\\s+${escapedName}(\\s+extends|\\s*\\{)`;
      case 'type':
        return `type\\s+${escapedName}\\s*[=<]`;
      case 'enum':
        return `enum\\s+${escapedName}\\s*\\{`;
      case 'method':
        return `(async\\s+)?${escapedName}\\s*\\(`;
      case 'variable':
        return `(const|let|var)\\s+${escapedName}\\s*[=:]`;
      default:
        return `(function|class|interface|type|enum|const|let|var)\\s+${escapedName}|${escapedName}\\s*(=|\\()`;
    }
  }
}
