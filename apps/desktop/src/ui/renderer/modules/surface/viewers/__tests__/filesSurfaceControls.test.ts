
import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CSS = fs.readFileSync(
  path.resolve(__dirname, '../../surface.css'), 'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');   // 剥注释: 上面那段说明里就引着旧规则原文

/** 找出所有"在文件预览区里把 X 设成 display:none"的选择器 */
function hiddenInFilesPreview(): string[] {
  const out: string[] = [];
  const re = /([^{}]*\.sfc-files__preview-body[^{}]*)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(CSS))) {
    if (/display\s*:\s*none/.test(m[2])) out.push(m[1].replace(/\s+/g, ' ').trim());
  }
  return out;
}

describe('文件模块的代码控制栏', () => {
  const hidden = hiddenInFilesPreview();

  test('不许无条件把整条 .sfc-code-diffbar 隐藏掉 (开关曾经就死在这上面)', () => {
    /* 允许 `:not(.sfc-code-diffbar--hasdiff)` 这种**有条件**的隐藏 —— 没有 diff 时
     * 这条栏是真的空的 (开关已 portal 到面包屑行), 空栏不该占一行。
     * 禁止的是不带任何条件的一刀切。 */
    const killsWholeBar = hidden.some((sel) =>
      sel.split(',').some((one) => /\.sfc-code-diffbar\s*$/.test(one.trim())));
    expect(killsWholeBar, `这些选择器无条件藏了控制栏: ${hidden.join(' / ')}`).toBe(false);
  });

  test('与外层重复的标题仍要隐藏', () => {
    expect(hidden.join(' ')).toMatch(/\.sfc-code-diffbar__label\b/);
  });

  test('栏里自带的文件树按钮仍要隐藏 (文件模块自己就是一棵树)', () => {
    expect(hidden.join(' ')).toMatch(/\.sfc-code-diffbar__treebtn\b/);
  });

  test('也不许无条件用 --sfc-code-diffbar-h: 0 把它压没 (等价于隐藏)', () => {
    const re = /([^{}]*\.sfc-files__preview-body[^{}]*)\{[^}]*--sfc-code-diffbar-h\s*:\s*0/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(CSS))) {
      expect(m[1], '压高度必须带条件, 否则等于把开关也压没了').toMatch(/:not\(/);
    }
  });


  test('落在面包屑行里的开关不许再带壳 (底色/描边) —— 同行已经有两个按钮了', () => {
    const m = /\.sfc-code-diffbar__modes\.sfc-code-diffbar__modes--inbar\s*\{([^}]*)\}/.exec(CSS);
    expect(m, '找不到 --inbar 的样式覆盖').toBeTruthy();
    expect(m![1]).toMatch(/background:\s*transparent/);
    expect(m![1]).toMatch(/border:\s*0/);
  });
});
