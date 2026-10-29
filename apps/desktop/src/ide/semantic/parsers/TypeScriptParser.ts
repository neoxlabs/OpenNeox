/**
 * TypeScriptParser —— 基于 tree-sitter 的 TypeScript / JavaScript 符号抽取器。
 *
 * 支持的符号 kind
 * ---------------
 * - class / interface / enum / type-alias / namespace
 * - function / method / constructor / property / field
 * - variable (const/let/var) / constant (const ALL_CAPS)
 * - enum-member
 *
 * 嵌套关系
 * --------
 * 通过 `parentIndex` 让 SymbolStore 能恢复父子关系：
 *   - class 里的 method / field → parent = class
 *   - interface 里的 property  → parent = interface
 *   - enum 里的 member         → parent = enum
 *   - namespace 里的 function / class → parent = namespace
 *
 * 导出判定
 * --------
 * 通过检测 `export_statement` 包装节点识别：
 *   - `export class Foo {}` → 符号 exported = true
 *   - `export default function bar() {}` → bar 的 exported = true
 *   - `class Foo {}`（内部） → exported = false
 *
 * 性能
 * ----
 * - tree-sitter 本身解析速度 ~20MB/s，一个 500 行文件的 parse ~2ms
 * - 走 walker 抽符号的开销跟节点数成正比，一个中等文件 <1ms
 * - 故意不做"符号去重 / 引用解析 / 类型推断"—— 那是 LSP 的活
 *
 * 依赖
 * ----
 * - `tree-sitter`（native binding，已装）
 * - `tree-sitter-typescript`（已装，内含 TS + TSX 两套 grammar）
 *
 * 这两个都是 runtime 必需的 native 模块，在 Electron 环境下需要
 * `electron-rebuild` 之后才能在 renderer 使用。服务器 / CLI / 测试环境
 * 直接 `require` 即可。
 */

import type { LanguageParser, ParseInput, ParseResult } from './Parser.js';
import type { SymbolInput, IdentifierUsageInput } from '../symbolStore/SymbolStore.js';
import type { SymbolKind, Range } from '../types.js';

// tree-sitter 的 node 类型 —— 这个 native 模块没附 .d.ts，用 any 包一层
// 我们自己的 helpers 保证类型安全。
type TSNode = any;
type TSParser = any;
type TSLanguage = any;

export class TypeScriptParser implements LanguageParser {
  readonly languages = [
    'typescript',
    'typescriptreact',
    'javascript',
    'javascriptreact',
  ] as const;

  private parser: TSParser | null = null;
  private tsLanguage: TSLanguage | null = null;
  private tsxLanguage: TSLanguage | null = null;

  async init(): Promise<void> {
    if (this.parser) return; // 幂等

    // 动态 import —— ESM 环境下 require 不可用
    const ParserMod = await import('tree-sitter');
    const Parser = (ParserMod as any).default ?? ParserMod;
    const tsModule = await import('tree-sitter-typescript');

    this.parser = new Parser();
    this.tsLanguage = (tsModule as any).typescript ?? (tsModule as any).default?.typescript;
    this.tsxLanguage = (tsModule as any).tsx ?? (tsModule as any).default?.tsx;
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    if (!this.parser || !this.tsLanguage || !this.tsxLanguage) {
      throw new Error('TypeScriptParser not initialized; call init() first');
    }

    // JSX / TSX 用独立 grammar
    const lang =
      input.language === 'typescriptreact' || input.language === 'javascriptreact'
        ? this.tsxLanguage
        : this.tsLanguage;

    this.parser.setLanguage(lang);
    // tree-sitter 的 string 参数有 ~32KB 限制，大文件用 callback 方式
    const content = input.content;
    const tree = content.length > 30000
      ? this.parser.parse((index: number) => content.slice(index, index + 4096))
      : this.parser.parse(content);

    const symbols: SymbolInput[] = [];
    this.visitChildren(tree.rootNode, symbols, undefined, false);

    // 第二遍遍历：抽所有 identifier 出现点（Find Usages 的原料）
    // 跟符号抽取分开 —— 符号只关心声明，usages 关心所有出现
    const usages: IdentifierUsageInput[] = [];
    const sourceLines = input.content.split('\n');
    collectIdentifierUsages(tree.rootNode, usages, sourceLines);

    return {
      symbols,
      usages,
      hasErrors: tree.rootNode.hasError ?? false,
    };
  }

  // --------------------------------------------------------------------------
  // 遍历
  // --------------------------------------------------------------------------

  /**
   * 访问 node 的所有"直接声明型子节点"，忽略 statement / expression 等非声明。
   *
   * 这里不做递归到任意深度 —— 只递归到容器内部的声明层（class body / interface
   * body / namespace 内的 statement_block），拒绝走进 function body / method body。
   */
  private visitChildren(
    node: TSNode,
    symbols: SymbolInput[],
    parentIndex: number | undefined,
    defaultExported: boolean,
  ): void {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      this.visitNode(child, symbols, parentIndex, defaultExported);
    }
  }

  private visitNode(
    node: TSNode,
    symbols: SymbolInput[],
    parentIndex: number | undefined,
    exported: boolean,
  ): void {
    switch (node.type) {
      // ----- export 包装 -----
      case 'export_statement': {
        // export_statement 可能包裹各种 declaration；继续走进去并带上 exported=true
        // 也可能是 "export { foo }" 或 "export * from ..." —— 这两种里没有自己的符号
        // 定义（只是 re-export），忽略即可。
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (!child) continue;
          // declaration 子节点才是我们关心的
          if (isDeclarationNode(child.type)) {
            this.visitNode(child, symbols, parentIndex, true);
          }
        }
        return;
      }

      // ----- 类 / 抽象类 -----
      case 'class_declaration':
      case 'abstract_class_declaration': {
        const idx = addSymbolFromNamedNode(
          node,
          'class',
          symbols,
          parentIndex,
          exported,
          extractClassModifiers(node),
        );
        // 进入类体，抽取 method / field
        const body = node.childForFieldName('body');
        if (body && idx >= 0) {
          this.visitClassBody(body, symbols, idx);
        }
        return;
      }

      // ----- interface -----
      case 'interface_declaration': {
        const idx = addSymbolFromNamedNode(node, 'interface', symbols, parentIndex, exported);
        const body = node.childForFieldName('body');
        if (body && idx >= 0) {
          this.visitInterfaceBody(body, symbols, idx);
        }
        return;
      }

      // ----- enum -----
      case 'enum_declaration': {
        const idx = addSymbolFromNamedNode(node, 'enum', symbols, parentIndex, exported);
        const body = node.childForFieldName('body');
        if (body && idx >= 0) {
          this.visitEnumBody(body, symbols, idx);
        }
        return;
      }

      // ----- 函数 -----
      case 'function_declaration':
      case 'generator_function_declaration': {
        addSymbolFromNamedNode(node, 'function', symbols, parentIndex, exported);
        return;
      }

      // ----- type alias -----
      case 'type_alias_declaration': {
        addSymbolFromNamedNode(node, 'type-alias', symbols, parentIndex, exported);
        return;
      }

      // ----- namespace / module -----
      case 'internal_module':
      case 'module': {
        const idx = addSymbolFromNamedNode(node, 'namespace', symbols, parentIndex, exported);
        // namespace 内部可能还有 class / function / namespace
        const body = node.childForFieldName('body');
        if (body && idx >= 0) {
          this.visitChildren(body, symbols, idx, false);
        }
        return;
      }

      // ----- const / let / var 声明 -----
      case 'lexical_declaration':
      case 'variable_declaration': {
        // lexical_declaration 下会有一个或多个 variable_declarator
        // 判断 kind 是 const/let/var
        const isConst =
          node.type === 'lexical_declaration' &&
          firstChildOfType(node, 'const') !== null;
        for (let i = 0; i < node.namedChildCount; i++) {
          const decl = node.namedChild(i);
          if (!decl || decl.type !== 'variable_declarator') continue;
          const nameNode = decl.childForFieldName('name');
          if (!nameNode) continue;
          // 只抓简单标识符；解构（{a, b} = ...）暂不拆
          if (nameNode.type !== 'identifier') continue;
          const name = nameNode.text;
          // 全大写常量视作 constant；否则 variable
          const kind: SymbolKind = isConst && /^[A-Z0-9_]+$/.test(name) ? 'constant' : 'variable';
          symbols.push({
            name,
            kind,
            range: nodeRange(decl),
            nameRange: nodeRange(nameNode),
            exported,
          });
        }
        return;
      }

      // 其他节点（如 statement_block 里的 if/for/return）不产生符号
      default:
        return;
    }
  }

  // --------------------------------------------------------------------------
  // 容器内部遍历
  // --------------------------------------------------------------------------

  private visitClassBody(body: TSNode, symbols: SymbolInput[], classIndex: number): void {
    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i);
      if (!member) continue;
      switch (member.type) {
        case 'method_definition': {
          const nameNode = member.childForFieldName('name');
          if (!nameNode) continue;
          // 构造函数
          const kind: SymbolKind = nameNode.text === 'constructor' ? 'constructor' : 'method';
          symbols.push({
            name: nameNode.text,
            kind,
            range: nodeRange(member),
            nameRange: nodeRange(nameNode),
            parentIndex: classIndex,
            modifiers: extractMemberModifiers(member),
          });
          break;
        }
        case 'public_field_definition': {
          const nameNode = member.childForFieldName('name');
          if (!nameNode) continue;
          symbols.push({
            name: nameNode.text,
            kind: 'field',
            range: nodeRange(member),
            nameRange: nodeRange(nameNode),
            parentIndex: classIndex,
            modifiers: extractMemberModifiers(member),
          });
          break;
        }
        default:
          break;
      }
    }
  }

  private visitInterfaceBody(
    body: TSNode,
    symbols: SymbolInput[],
    interfaceIndex: number,
  ): void {
    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i);
      if (!member) continue;
      // property_signature / method_signature
      if (member.type === 'property_signature' || member.type === 'method_signature') {
        const nameNode = member.childForFieldName('name');
        if (!nameNode) continue;
        const kind: SymbolKind = member.type === 'method_signature' ? 'method' : 'property';
        symbols.push({
          name: nameNode.text,
          kind,
          range: nodeRange(member),
          nameRange: nodeRange(nameNode),
          parentIndex: interfaceIndex,
        });
      }
    }
  }

  private visitEnumBody(body: TSNode, symbols: SymbolInput[], enumIndex: number): void {
    // enum_body 里每一项可能是 property_identifier 或 enum_assignment
    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i);
      if (!member) continue;
      if (member.type === 'property_identifier') {
        symbols.push({
          name: member.text,
          kind: 'enum-member',
          range: nodeRange(member),
          nameRange: nodeRange(member),
          parentIndex: enumIndex,
        });
      } else if (member.type === 'enum_assignment') {
        const nameNode = member.childForFieldName('name');
        if (!nameNode) continue;
        symbols.push({
          name: nameNode.text,
          kind: 'enum-member',
          range: nodeRange(member),
          nameRange: nodeRange(nameNode),
          parentIndex: enumIndex,
        });
      }
    }
  }
}

// ============================================================================
// 辅助
// ============================================================================

function nodeRange(node: TSNode): Range {
  return {
    start: { line: node.startPosition.row, column: node.startPosition.column },
    end: { line: node.endPosition.row, column: node.endPosition.column },
  };
}

/**
 * 抽取所有 identifier / property_identifier / type_identifier / shorthand 使用点。
 *
 * 策略
 * ----
 * - 深度优先遍历整棵 tree
 * - 对每个 "identifier-like" 节点：
 *    · 判断是不是"名字定义位置"（父节点的 name 字段就是它）
 *    · 保留所有 —— 定义也记一份，但标记 is_declaration=true
 * - 为每行准备一个 preview 字符串（UI 显示匹配上下文）
 *
 * 哪些节点算 identifier-like
 * ---------------------------
 * - `identifier` —— 最常见
 * - `property_identifier` —— 成员访问 a.foo 里的 foo / 类成员名
 * - `type_identifier` —— 类型名
 * - `shorthand_property_identifier` —— { foo } 简写
 *
 * 排除
 * ----
 * - 字符串 / 注释里的东西（tree-sitter 不会把它们解析成 identifier 节点）
 * - 关键字（不是 identifier 节点）
 */
function collectIdentifierUsages(
  root: TSNode,
  out: IdentifierUsageInput[],
  sourceLines: string[],
): void {
  const IDENTIFIER_TYPES = new Set([
    'identifier',
    'property_identifier',
    'type_identifier',
    'shorthand_property_identifier',
    'shorthand_property_identifier_pattern',
  ]);

  // 迭代式 DFS，避免超深栈
  const stack: TSNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;

    if (IDENTIFIER_TYPES.has(node.type)) {
      const name = node.text;
      // 简单过滤：太短的单字符 identifier 噪声大（`i` `j` `x`），
      // 且 Find Usages 按名字精确匹配，意义有限；先全量保留，后续再看要不要滤
      if (name && name.length > 0) {
        const isDeclaration = isNameField(node);
        const line = node.startPosition.row;
        const preview = getLinePreview(sourceLines, line);
        out.push({
          name,
          line,
          column: node.startPosition.column,
          endColumn: node.endPosition.column,
          preview,
          isDeclaration,
        });
      }
    }

    // 继续深入所有 named children
    // （不进 statement_block 之类的非 named 节点会漏掉函数体里的 identifier，
    // 所以这里走的是全 children，不是 namedChildren）
    for (let i = node.childCount - 1; i >= 0; i--) {
      const c = node.child(i);
      if (c) stack.push(c);
    }
  }
}

/**
 * 判断一个 identifier 节点是否处于父节点的 "name" 位置 —— 即它是一个声明名。
 */
function isNameField(node: TSNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  const nameField = parent.childForFieldName?.('name');
  return nameField !== null && nameField !== undefined && nameField.id === node.id;
}

/**
 * 取一行的 preview，去掉前导空格 + 截断到 200 字符。
 */
function getLinePreview(lines: string[], lineIdx: number): string {
  const raw = lines[lineIdx] ?? '';
  const trimmed = raw.trimStart();
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}…` : trimmed;
}

/**
 * 从一个带 `name` field 的声明节点抽出符号，push 到数组里，返回新符号在数组里的下标。
 * 返回 -1 表示没抽到（没有 name 节点）。
 */
function addSymbolFromNamedNode(
  node: TSNode,
  kind: SymbolKind,
  symbols: SymbolInput[],
  parentIndex: number | undefined,
  exported: boolean,
  modifiers?: string,
): number {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return -1;
  symbols.push({
    name: nameNode.text,
    kind,
    range: nodeRange(node),
    nameRange: nodeRange(nameNode),
    parentIndex,
    exported,
    modifiers,
  });
  return symbols.length - 1;
}

function isDeclarationNode(type: string): boolean {
  return (
    type === 'class_declaration' ||
    type === 'abstract_class_declaration' ||
    type === 'interface_declaration' ||
    type === 'enum_declaration' ||
    type === 'function_declaration' ||
    type === 'generator_function_declaration' ||
    type === 'type_alias_declaration' ||
    type === 'internal_module' ||
    type === 'module' ||
    type === 'lexical_declaration' ||
    type === 'variable_declaration'
  );
}

function firstChildOfType(node: TSNode, type: string): TSNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === type) return c;
  }
  return null;
}

/**
 * 从 class_declaration / abstract_class_declaration 抽修饰符（abstract）。
 * 导出修饰符在 `exported` 字段里表达，不重复。
 */
function extractClassModifiers(node: TSNode): string | undefined {
  if (node.type === 'abstract_class_declaration') return 'abstract';
  return undefined;
}

/**
 * 从 class 成员节点（method_definition / public_field_definition）抽修饰符。
 * 返回值是空格分隔的字符串，例如 "static async private"。
 */
function extractMemberModifiers(node: TSNode): string | undefined {
  const mods: string[] = [];
  // tree-sitter TS grammar 里 modifier 是 unnamed children —— 直接遍历 child
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    switch (c.type) {
      case 'static':
      case 'async':
      case 'readonly':
      case 'override':
        mods.push(c.type);
        break;
      case 'accessibility_modifier':
        mods.push(c.text);
        break;
      default:
        break;
    }
  }
  return mods.length > 0 ? mods.join(' ') : undefined;
}
