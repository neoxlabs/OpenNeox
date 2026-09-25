/**
 * Verify browser_eval input aliases and page-context execution.
 *
 * The wrapper accepts the browser-evaluation source forms used by the tool contract,
 * executes them in the page context, and preserves the final value for callers.
 * Compilation-based classification keeps expressions containing semicolons from
 * being mistaken for statement bodies.
 */
import { describe, it, expect } from 'vitest';
import { wrapEvalSource, explainEmptyResult } from '../browserEvalWrap.js';

const wrap = (src: string, arg?: unknown) =>
  wrapEvalSource(src, arg === undefined ? '' : JSON.stringify(arg));

/** 页面里真正会被求值的是这个字符串, 所以它必须是**表达式**而不是函数字面量 */
const isExpression = (code: string) => !/^\s*(async\s*)?(\(\s*[\w$,\s]*\)|[\w$]+)\s*=>/.test(code.trim());

/** 包出来的代码在 Node 里也能编译 —— 语法层面的自检 (不执行) */
const compilesAsExpression = (code: string) => {
  // eslint-disable-next-line no-new-func
  new Function(`return (${code})`);
  return true;
};

describe('包装成能在页面里求值的代码', () => {
  it('表达式', () => {
    const w = wrap('document.title');
    expect(w.form).toBe('expression');
    expect(w.code).toBe('(async (x) => (document.title))()');
  });

  it('箭头函数字面量 —— 要**调用**它, 不是把它本身丢过去', () => {
    const w = wrap('() => document.title');
    expect(w.code).toBe('(() => document.title)()');
    /* page.evaluate(字符串) 把字符串当表达式求值: 传函数字面量只会拿到函数本身,
     * 结果一律 undefined。第一版就是这么写的, 六种写法全 undefined。 */
    expect(isExpression(w.code)).toBe(true);
  });

  it('IIFE 原样 —— 它已经是表达式了, 再包一层反而多此一举', () => {
    const src = '(() => document.querySelectorAll("tr").length)()';
    expect(wrap(src).code).toBe(src);
  });

  it('语句块要包成函数体, 不能塞进括号', () => {
    const w = wrap('const n = 1; return n * 10');
    expect(w.form).toBe('statements');
    expect(w.code).toBe('(async (x) => { const n = 1; return n * 10 })()');
  });

  it('单行但带 return 的也算语句块', () => {
    expect(wrap('return document.title').form).toBe('statements');
  });

  it('function 字面量', () => {
    expect(wrap('function () { return 1 }').code).toBe('(function () { return 1 })()');
  });

  it('参数序列化进代码里 —— 传字符串给 evaluate 时没法再带 arg', () => {
    expect(wrap('(x) => document.title + x', '-s').code).toBe('((x) => document.title + x)("-s")');
    expect(wrap('document.title', 5).code).toBe('(async (x) => (document.title))(5)');
  });

  /* Expression classification remains stable for browser code containing semicolons. */

  it('字符串里的分号不能把表达式判成语句 (实拍: join(" ;; "))', () => {
    const src = `document.querySelectorAll('dialog[open]').length + ' | ' + [...document.querySelectorAll('[role=dialog] *')].map(e=>e.tagName).join(' ;; ')`;
    const w = wrap(src);
    expect(w.form).toBe('expression');
    expect(compilesAsExpression(w.code)).toBe(true);
  });

  it('内嵌箭头函数体里的 ;/return 不能把外面的表达式判成语句 (实拍: fetch().then(t => {...; return t}))', () => {
    const src = `fetch('/api/x').then(r=>r.text()).then(t=>{document.title='RESP:'+t;return t})`;
    const w = wrap(src);
    expect(w.form).toBe('expression');
  });

  it('多条语句没写 return: 最后一条表达式的值自动送回 (REPL 习惯)', () => {
    const w = wrap(`const btns=[...document.querySelectorAll('button.assign')]; btns.map((b,i)=>'['+i+'] '+b.outerHTML).join('\\n')`);
    expect(w.form).toBe('statements+autoreturn');
    expect(w.code).toContain('return (btns.map(');
    expect(compilesAsExpression(w.code)).toBe(true);
  });

  it('最后一条是声明/控制语句时不硬加 return', () => {
    expect(wrap('const a = 1;\nconst b = 2;').form).toBe('statements');
    expect(wrap('let n = 0; for (const x of [1,2]) n += x').form).toBe('statements');
  });

  it('顶层 await 能用 —— 包在 async 体里', () => {
    const w = wrap(`const r = await fetch('/api'); return r.status`);
    expect(w.form).toBe('statements');
    expect(w.code.startsWith('(async ')).toBe(true);
  });

  it('**包出来的一律是表达式** —— 这是"结果不是 undefined"的充要条件', () => {
    for (const src of [
      'document.title', '() => 1', 'x => x', 'function(){return 1}',
      '(() => 1)()', 'const a=1; return a', 'return 2', 'const a=1; a+1',
    ]) {
      const { code } = wrap(src);
      expect(isExpression(code), src).toBe(true);
      expect(compilesAsExpression(code), src).toBe(true);
    }
  });

  it('空结果要有一句解释, 而且按形态区分', () => {
    expect(explainEmptyResult('statements')).toMatch(/return/);
    expect(explainEmptyResult('expression')).toMatch(/undefined/);
  });
});
