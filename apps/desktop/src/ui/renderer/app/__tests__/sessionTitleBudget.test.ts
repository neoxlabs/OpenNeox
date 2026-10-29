import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, '../NeoxRuntimeBridge.tsx'), 'utf8');

/** 复刻源码里的截断。下面第一条测试校验它没跟源码跑偏。 */
function makeTitle(cleaned: string): string {
  const cjkCount = (cleaned.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
  const budget = cjkCount * 2 >= cleaned.length ? 20 : 44;
  let title = cleaned;
  if (cleaned.length > budget) {
    let cut = cleaned.slice(0, budget);
    if (budget > 20) {
      const sp = cut.lastIndexOf(' ');
      if (sp >= budget - 14) cut = cut.slice(0, sp);
    }
    title = cut.trimEnd() + '…';
  }
  return title;
}

describe('复刻件跟源码一致', () => {
  it('源码里就是这两档预算 + 词边界回退', () => {
    expect(SRC).toMatch(/const budget = cjkCount \* 2 >= cleaned\.length \? 20 : 44;/);
    expect(SRC).toMatch(/cut\.lastIndexOf\(' '\)/);
    expect(SRC).toMatch(/sp >= budget - 14/);
  });

  it('拍过板的那条没被动 —— 仍然是第一句话直接截, 没引入模型润色', () => {
    const i = SRC.indexOf('isDefaultSessionName(session.name)');
    expect(i).toBeGreaterThan(0);
    const block = SRC.slice(i, i + 1800);
    expect(block).not.toMatch(/await |generateTitle|summariz/i);
  });
});

describe('两种文字都要读得出在说什么', () => {
  it('中文维持 20 字 —— 行为不变', () => {
    expect(makeTitle('帮我把登录页的按钮改成蓝色，并且加一个 loading 状态'))
      .toBe('帮我把登录页的按钮改成蓝色，并且加一个…');
  });

  it('英文拿到 44 字符, 能看出是在说哪件事', () => {
    const t = makeTitle('Can you help me fix the login button so it shows a loading state');
    expect(t).toContain('login button');
    expect(t.length).toBeLessThanOrEqual(45);
  });

  it('英文不从单词中间切', () => {
    const t = makeTitle('why does the build fail on windows but not on mac');
    expect(t.endsWith('…')).toBe(true);
    const body = t.slice(0, -1).trimEnd();
    expect('why does the build fail on windows but not on mac').toContain(body);
    expect(body.endsWith(' ')).toBe(false);
  });

  it('短句原样返回, 不加省略号', () => {
    expect(makeTitle('short one')).toBe('short one');
    expect(makeTitle('重构 timelineStore 的缓存逻辑')).toBe('重构 timelineStore 的缓存逻辑');
  });

  it('中英混排按主体语言判 —— 中文为主时仍走 20 字', () => {
    /* 这条防的是"混一个英文单词进去就被当成拉丁文、标题突然变长一倍"。 */
    const s = '把这个组件的 loading 状态改成骨架屏并且补上错误态的处理';
    expect(makeTitle(s).length).toBeLessThanOrEqual(21);
  });
});
