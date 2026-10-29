/**
 * CLI-04: diff 卡默认折叠 12 行, 剩下的给一行提示并指出 ctrl+d 可全屏看。
 * (折叠行数由 utils/diffDisplay.ts 的 DIFF_PREVIEW_MAX_LINES 统一口径, 这里验证卡片真的照做)
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ToolCard } from '../ToolCard.js';

/** 造一条 30 行的 edit diff 明细 (type:lineNum:content 格式, 与 InkUIAdapter 一致) */
function buildDetails(count: number): string {
  const lines = ['H:0:--- a/src/big.ts', 'H:0:+++ b/src/big.ts', 'H:0:@@ -1,' + count + ' +1,' + count + ' @@'];
  for (let i = 1; i <= count; i++) lines.push(`+:${i}:const line${i} = ${i};`);
  return lines.join('\n');
}

describe('ToolCard · diff 折叠 (CLI-04)', () => {
  it('30 行 diff 只显示前 12 行, 其余折叠成提示并给出 ctrl+d', () => {
    const { lastFrame } = render(
      <ToolCard type={'file_update' as any} message="Edited src/big.ts +30 -0" details={buildDetails(30)} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('const line1 = 1;');
    expect(frame).toContain('const line12 = 12;');
    // 第 13 行起不显示
    expect(frame).not.toContain('const line13 = 13;');
    // 折叠提示: 30 - 12 = 18
    expect(frame).toContain('+18 lines');
    // 全屏入口
    expect(frame).toContain('ctrl+d');
  });

  it('不足 12 行时全部显示, 不出现折叠提示', () => {
    const { lastFrame } = render(
      <ToolCard type={'file_update' as any} message="Edited src/small.ts +3 -0" details={buildDetails(3)} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('const line3 = 3;');
    expect(frame).not.toContain('+0 lines');
    expect(frame).not.toContain('ctrl+d');
  });
});
