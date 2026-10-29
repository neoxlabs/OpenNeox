import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../agent-timeline-context-rail.css'),
  'utf8',
);
/* 断言只看选择器, 注释里逐字引着这些选择器 —— 不剥注释就是假绿 */
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

const LAYOUT_GUARD = /:is\(\s*\[data-panel-layout='split'\]\s*,\s*\[data-panel-layout='swap'\]\s*\)/;

describe('row-clamp 两支必须同一条 lane', () => {
  it('自检: 扫到的确实是这个文件 (否则下面全是空集平凡通过)', () => {
    expect(code).toMatch(/\.atl-row-clamp/);
    expect(code).toMatch(/--atl-ctx-pad-left/);
  });

  it('给 diff / turn-summary 单独写死 padding 的规则, 必须限定 split/swap 布局', () => {
    /* 找每一条同时出现 `[data-atl-wide-content]` (渲染期行宽标记,
     * work:M-03 之后替代 `:has(...is-content-diff|turn-summary)`) 和写死 px padding 的规则块 */
    const offenders: string[] = [];
    for (const block of code.split('}')) {
      if (!/\.atl-row-clamp\[data-atl-wide-content\]/.test(block)) continue;
      /* 只关心把 padding 钉成常数 px 的 —— 用变量的那条本来就跟大伙一致 */
      if (!/padding-(left|right)\s*:\s*\d+px/.test(block)) continue;
      if (LAYOUT_GUARD.test(block)) continue;
      offenders.push(block.split('{')[0].trim().replace(/\s+/g, ' ').slice(0, 120));
    }
    expect(
      offenders,
      `这些规则给「本轮改动/diff」写死了 padding 却没限定布局, 会让它跟普通消息行分岔:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('非分屏态下, diff / turn-summary 仍有一条走 lane 变量的规则兜住', () => {
    const laneRule = code.split('}').find(b =>
      /\.atl-shell\.has-context-rail[\s\S]*\.atl-row-clamp\[data-atl-wide-content\]/.test(b)
      && /padding-left\s*:\s*var\(--atl-ctx-pad-left\)/.test(b));
    expect(laneRule, '少了这条, 收窄上面那条之后这两类行会掉回居中公式, 照样跟消息行分岔').toBeTruthy();
  });
});
