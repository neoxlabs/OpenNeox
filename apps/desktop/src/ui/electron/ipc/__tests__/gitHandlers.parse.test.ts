
import { describe, it, expect } from 'vitest';
import { parseNumstat, unquoteGitPath } from '../gitHandlers';

describe('parseNumstat · git diff --numstat', () => {
  it('常规行', () => {
    const m = parseNumstat('12\t3\tsrc/a.ts\n0\t7\tsrc/b.ts');
    expect(m.get('src/a.ts')).toEqual({ add: 12, del: 3 });
    expect(m.get('src/b.ts')).toEqual({ add: 0, del: 7 });
  });

  it('二进制文件的 `-` 计为 0, 不能变 NaN', () => {
    const m = parseNumstat('-\t-\tassets/logo.png');
    expect(m.get('assets/logo.png')).toEqual({ add: 0, del: 0 });
  });

  it('rename 简单形式: 统一落到新路径', () => {
    const m = parseNumstat('1\t1\tsrc/old.ts => src/new.ts');
    expect(m.has('src/new.ts')).toBe(true);
    expect(m.has('src/old.ts')).toBe(false);
  });

  it('rename 大括号带前缀 (最常见形式)', () => {
    const m = parseNumstat('2\t0\tsrc/{old => new}/file.ts');
    expect([...m.keys()]).toEqual(['src/new/file.ts']);
  });

  it('rename 大括号在行首', () => {
    const m = parseNumstat('1\t1\t{old => new}/file.ts');
    expect([...m.keys()]).toEqual(['new/file.ts']);
  });

  it('rename 大括号在末尾 (没有后缀段)', () => {
    const m = parseNumstat('1\t1\tsrc/{old.ts => new.ts}');
    expect([...m.keys()]).toEqual(['src/new.ts']);
  });

  it('rename 只改目录层级 (新段为空时不留双斜杠)', () => {
    const m = parseNumstat('1\t1\tsrc/{legacy => }/file.ts');
    expect([...m.keys()]).toEqual(['src/file.ts']);
  });

  it('结果里绝不残留大括号', () => {
    for (const line of [
      '1\t1\tsrc/{old => new}/file.ts',
      '1\t1\t{a => b}/c.ts',
      '1\t1\tp/{x => y}',
    ]) {
      for (const k of parseNumstat(line).keys()) {
        expect(k, line).not.toMatch(/[{}]/);
        expect(k, line).not.toContain(' => ');
      }
    }
  });

  it('空行 / 残缺行被跳过, 不抛', () => {
    const m = parseNumstat('\n\n5\t5\tok.ts\ngarbage\n1\t2\n');
    expect(m.size).toBe(1);
    expect(m.get('ok.ts')).toEqual({ add: 5, del: 5 });
  });

  it('路径里含 tab 时不被截断 (slice(2).join 保住后半段)', () => {
    const m = parseNumstat('1\t1\tweird\tname.ts');
    expect(m.get('weird\tname.ts')).toEqual({ add: 1, del: 1 });
  });

  it('空输入返回空 map', () => {
    expect(parseNumstat('').size).toBe(0);
  });

  it('同一路径出现多次时以最后一条为准', () => {
    const m = parseNumstat('1\t1\ta.ts\n9\t9\ta.ts');
    expect(m.get('a.ts')).toEqual({ add: 9, del: 9 });
  });
});

describe('unquoteGitPath · core.quotepath 的 C 风格转义', () => {
  it('没引号的原样返回', () => {
    expect(unquoteGitPath('src/a.ts')).toBe('src/a.ts');
  });

  it('太短 / 单边引号不当作转义', () => {
    expect(unquoteGitPath('"')).toBe('"');
    expect(unquoteGitPath('"abc')).toBe('"abc');
    expect(unquoteGitPath('abc"')).toBe('abc"');
  });

  it('转义的引号与反斜杠', () => {
    expect(unquoteGitPath('"a\\"b.ts"')).toBe('a"b.ts');
    expect(unquoteGitPath('"a\\\\b.ts"')).toBe('a\\b.ts');
  });

  it('八进制转义还原成 UTF-8 中文', () => {
    /* git 对非 ASCII 路径按字节发八进制: 中 = E4 B8 AD = \344\270\255 */
    expect(unquoteGitPath('"\\344\\270\\255.txt"')).toBe('中.txt');
  });

  it('控制字符转义', () => {
    expect(unquoteGitPath('"a\\tb"')).toBe('a\tb');
    expect(unquoteGitPath('"a\\nb"')).toBe('a\nb');
  });

  it('parseNumstat 串起来: 引号路径能正确解引号', () => {
    const m = parseNumstat('3\t1\t"\\344\\270\\255.txt"');
    expect(m.get('中.txt')).toEqual({ add: 3, del: 1 });
  });
});
