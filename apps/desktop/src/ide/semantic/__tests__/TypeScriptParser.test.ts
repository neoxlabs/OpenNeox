/**
 * TypeScriptParser 单测 —— 验证 tree-sitter 驱动的符号抽取。
 *
 * 注意：这个文件依赖 native 模块 `tree-sitter` + `tree-sitter-typescript`。
 * 在没有 `npm install` 相应依赖的环境下会跳过整组测试。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { TypeScriptParser } from '../parsers/TypeScriptParser.js';
import type { SymbolInput } from '../symbolStore/SymbolStore.js';

let parser: TypeScriptParser;
let available = true;

beforeAll(async () => {
  parser = new TypeScriptParser();
  try {
    await parser.init();
  } catch {
    available = false;
  }
});

describe.skipIf(!available)('TypeScriptParser', () => {
  async function parse(code: string, language: string = 'typescript'): Promise<SymbolInput[]> {
    const r = await parser.parse({ path: 'test.ts', content: code, language });
    return r.symbols;
  }

  function findByName(symbols: SymbolInput[], name: string): SymbolInput | undefined {
    return symbols.find((s) => s.name === name);
  }

  describe('top-level declarations', () => {
    it('extracts a class with methods and fields', async () => {
      const symbols = await parse(`
        export class EditorService {
          private tabs: string[] = [];
          public active: string | null = null;
          async save(): Promise<void> { return; }
          static build() {}
        }
      `);

      const cls = findByName(symbols, 'EditorService');
      expect(cls).toBeDefined();
      expect(cls?.kind).toBe('class');
      expect(cls?.exported).toBe(true);

      const save = findByName(symbols, 'save');
      expect(save?.kind).toBe('method');
      expect(save?.modifiers?.includes('async')).toBe(true);

      const build = findByName(symbols, 'build');
      expect(build?.kind).toBe('method');
      expect(build?.modifiers?.includes('static')).toBe(true);

      const tabs = findByName(symbols, 'tabs');
      expect(tabs?.kind).toBe('field');

      // parent 关系：method / field 的 parentIndex 应指向 class
      const classIndex = symbols.indexOf(cls!);
      expect(save?.parentIndex).toBe(classIndex);
      expect(tabs?.parentIndex).toBe(classIndex);
    });

    it('extracts interfaces with properties and methods', async () => {
      const symbols = await parse(`
        export interface Config {
          debug: boolean;
          name: string;
          load(): void;
        }
      `);
      const iface = findByName(symbols, 'Config');
      expect(iface?.kind).toBe('interface');
      expect(iface?.exported).toBe(true);

      const debug = findByName(symbols, 'debug');
      expect(debug?.kind).toBe('property');
      expect(debug?.parentIndex).toBe(symbols.indexOf(iface!));

      const load = findByName(symbols, 'load');
      expect(load?.kind).toBe('method');
    });

    it('extracts enums and enum members', async () => {
      const symbols = await parse(`
        export enum Color {
          Red,
          Green = 'green',
          Blue = 2,
        }
      `);
      const en = findByName(symbols, 'Color');
      expect(en?.kind).toBe('enum');
      expect(en?.exported).toBe(true);

      expect(findByName(symbols, 'Red')?.kind).toBe('enum-member');
      expect(findByName(symbols, 'Green')?.kind).toBe('enum-member');
      expect(findByName(symbols, 'Blue')?.kind).toBe('enum-member');
    });

    it('extracts top-level functions', async () => {
      const symbols = await parse(`
        export function openTab(id: string): number { return 0; }
        async function loadFile(path: string) {}
      `);
      const openTab = findByName(symbols, 'openTab');
      expect(openTab?.kind).toBe('function');
      expect(openTab?.exported).toBe(true);

      const loadFile = findByName(symbols, 'loadFile');
      expect(loadFile?.kind).toBe('function');
      expect(loadFile?.exported).toBe(false);
    });

    it('extracts type aliases', async () => {
      const symbols = await parse(`export type ID = string | number;`);
      const t = findByName(symbols, 'ID');
      expect(t?.kind).toBe('type-alias');
      expect(t?.exported).toBe(true);
    });

    it('distinguishes const from let from var', async () => {
      const symbols = await parse(`
        export const MAX_SIZE = 100;
        export const lowercase = 'x';
        let mutable = 1;
      `);
      expect(findByName(symbols, 'MAX_SIZE')?.kind).toBe('constant');
      expect(findByName(symbols, 'lowercase')?.kind).toBe('variable');
      expect(findByName(symbols, 'mutable')?.kind).toBe('variable');

      expect(findByName(symbols, 'MAX_SIZE')?.exported).toBe(true);
      expect(findByName(symbols, 'mutable')?.exported).toBe(false);
    });
  });

  describe('range accuracy', () => {
    it('reports zero-based line/column ranges', async () => {
      const symbols = await parse(`export function foo() {}\nexport function bar() {}`);
      const foo = findByName(symbols, 'foo')!;
      const bar = findByName(symbols, 'bar')!;
      expect(foo.range.start.line).toBe(0);
      expect(bar.range.start.line).toBe(1);
    });

    it('nameRange is narrower than range', async () => {
      const symbols = await parse(`export class Foo { bar() { return 1; } }`);
      const foo = findByName(symbols, 'Foo')!;
      expect(foo.nameRange).toBeDefined();
      // name range 的长度应该等于 "Foo"
      const nameLen =
        (foo.nameRange!.end.column - foo.nameRange!.start.column) +
        Math.max(0, foo.nameRange!.end.line - foo.nameRange!.start.line);
      expect(nameLen).toBe(3);
    });
  });

  describe('nested structures', () => {
    it('does NOT extract local variables inside function bodies', async () => {
      const symbols = await parse(`
        function outer() {
          const localThing = 1;
          function nestedFn() {}
        }
      `);
      // outer 应该被抽
      expect(findByName(symbols, 'outer')).toBeDefined();
      // localThing / nestedFn 都是 function body 内部的，本阶段不抽（避免噪音）
      expect(findByName(symbols, 'localThing')).toBeUndefined();
      expect(findByName(symbols, 'nestedFn')).toBeUndefined();
    });

    it('handles namespace containing classes and functions', async () => {
      const symbols = await parse(`
        export namespace Utils {
          export class Helper {}
          export function compute() {}
        }
      `);
      const ns = findByName(symbols, 'Utils');
      expect(ns?.kind).toBe('namespace');
      const helper = findByName(symbols, 'Helper');
      const compute = findByName(symbols, 'compute');
      expect(helper?.parentIndex).toBe(symbols.indexOf(ns!));
      expect(compute?.parentIndex).toBe(symbols.indexOf(ns!));
    });
  });

  describe('error resilience', () => {
    it('parses files with syntax errors and still extracts valid symbols', async () => {
      const symbols = await parse(`
        export class Foo {
          broken method(
        }
        export function working() {}
      `);
      // working 应该仍然被抽到
      expect(findByName(symbols, 'working')).toBeDefined();
    });
  });
});
