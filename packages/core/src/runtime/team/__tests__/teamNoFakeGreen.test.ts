import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '..', 'teamExecutor.ts'), 'utf8');

describe('派活', () => {
  it('**必须显式传 run_in_background: false** —— 不传就是后台, 拿到的是派发回执不是产出', () => {
    expect(SRC).toContain('run_in_background: false');
  });

  it('它就在 agentTool.function 的入参里, 不是写在注释或别处', () => {
    const call = SRC.slice(SRC.indexOf('deps.agentTool.function('));
    const body = call.slice(0, call.indexOf('})'));
    expect(body).toContain('run_in_background: false');
    /* 目录钉死那条是同一个入参里的老约定, 一起确认没被顺手删掉 */
    expect(body).toContain('workDir');
  });
});

describe('收活', () => {
  it('收到 background_launched 信封要当失败 —— 那是活着的假绿, 不是产出', () => {
    /* 锚点用**那条正则本身**, 不是裸字符串 —— 裸字符串会命中上面解释这段历史的注释,
     * 于是测试对着注释断言"有 throw", 永远绿。(第一版就是这么写的, 当场自己踩了一次。) */
    const guard = /"\?status"\?\\s\*:\\s\*"background_launched"/;
    expect(SRC).toMatch(guard);
    const idx = SRC.search(guard);
    expect(SRC.slice(idx, idx + 300)).toContain('throw new Error');
  });

  it('[ERROR] 文本和空返回的老判据还在 (前两次的教训不能被这次覆盖掉)', () => {
    expect(SRC).toContain('looksFailed');
    /* 匹配代码里那个正则字面量 `^\[ERROR\]`, 不靠注释 (公开树会删注释) */
    expect(SRC).toContain('^\\[ERROR\\]');
    expect(SRC).toContain('没有任何产出');
  });
});
