import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.resolve(HERE, rel), 'utf8');
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('ask_user 的会话隔离', () => {
  it('主视图的等待中 ask 必须取自过了会话闸的事件, 不能是 feed 原始数组', () => {
    const src = stripComments(read('../modules/agent-timeline/AgentTimelineView.tsx'));
    /* (?<!function ) —— 同名的**定义**就在这个文件里 (`function findWaitingAskUser(events: any[]…`),
     * 不排掉的话闸量到的是形参名, 永远绿。 */
    const call = src.match(/(?<!function )findWaitingAskUser\(([^,]+),/);
    expect(call, 'AgentTimelineView 里应当有 findWaitingAskUser 调用 (闸没空跑)').not.toBeNull();
    expect(
      call![1]!.trim(),
      'findWaitingAskUser 必须吃 eventsForActiveSession —— 吃 timelineEvents 就是'
      + '把别的会话的提问显示在底部药丸上 (2026-09-18 实拍)',
    ).toBe('eventsForActiveSession');
  });

  it('答复 ask 的归属认 entry 长在哪个会话, 不认当前打开的会话', () => {
    const src = stripComments(read('../app/NeoxRuntimeBridge.tsx'));
    const at = src.indexOf('const answerAskUser');
    expect(at, 'answerAskUser 应当存在').toBeGreaterThan(0);
    const body = src.slice(at, at + 2600);
    expect(
      /timelineMapRef\.current/.test(body),
      'answerAskUser 必须从 timelineMapRef 里按 entry id 反查归属 (requestId 全局唯一)',
    ).toBe(true);
    expect(
      /const sessionId = activeSession\?\.id/.test(body),
      '拿"当前打开的会话"当归属会把答复状态翻到别人的时间线上',
    ).toBe(false);
  });
});
