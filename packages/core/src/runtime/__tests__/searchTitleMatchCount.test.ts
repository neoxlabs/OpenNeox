import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../agentRuntimeHost.ts'), 'utf8',
);
/* 剥注释 —— 上面的说明和被测文件的注释里都逐字引着那行旧代码 */
const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const searchCase = /case 'search':\s*\{([\s\S]*?)\n      \}/.exec(code)?.[1] ?? '';

describe('search 标题的匹配数来源', () => {
  it('自检: 抓到了 search 那个 case 分支', () => {
    expect(searchCase).toMatch(/short\(pattern/);
  });

  it('不许再用 output 的换行数当匹配数 —— output 是单行 JSON, 恒为 0', () => {
    expect(searchCase).not.toMatch(/output\.match\(\/\\n\/g\)/);
  });

  it('优先取工具自己报的数 (summary 里的 "(N matches)")', () => {
    expect(searchCase).toMatch(/parsedSummary/);
    expect(searchCase).toMatch(/matches\?/);
  });

  it('回落也只能数 parsedContent (真正的结果文本), 不能数 raw output', () => {
    const fallback = /parsedContent[\s\S]*?match\(\/\\n\/g\)/.test(searchCase);
    expect(fallback, '回落分支应当数 parsedContent 的换行').toBe(true);
  });
});
