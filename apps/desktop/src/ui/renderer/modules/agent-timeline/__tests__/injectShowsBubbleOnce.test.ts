/* 插话: 点「插入」就是气泡进去, 而且只有一个.。 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.resolve(HERE, rel), 'utf8');
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('插话: 插入即气泡, 只有一个', () => {
  it('输入框里不再渲染已交给引擎的那些消息', () => {
    const src = stripComments(read('../TimelineComposer.tsx'));
    /* 只认**渲染** —— `queuedLocal.map(q => q.text).join('\n')` 是把残留文字拼回输入框的。 */
    const renders = /queuedLocal\.map\(\s*\([^)]*\)\s*=>\s*\(/.test(src);
    expect(
      renders,
      '输入框里又把 queuedLocal 渲染出来了 —— 那就是"插入之后文字还在输入框"的那一层',
    ).toBe(false);
    /* 消息文本只该被渲染一次 —— 待发送药丸里那一处。删掉的那块也用 queued-text,
     * 所以数量从 2 变 1; 变回 2 就是那一层又回来了。
     * (不去断言 .atl-composer__queued 这个 class 不存在: "消息已放回输入框"那条提示
     * 复用了同一个 class, 它是安全网本身, 不是重复显示 —— 上一版就误伤了它。) */
    const textRenders = (src.match(/className="atl-composer__queued-text"/g) ?? []).length;
    expect(textRenders, '插话消息的文本只该出现在待发送药丸里那一处').toBe(1);
  });

  it('但 queuedLocal 这个 state 必须留着 (引擎拒收要把文字放回输入框)', () => {
    const src = stripComments(read('../TimelineComposer.tsx'));
    expect(src, 'setQueuedLocal 没了 = 引擎拒收/超时时消息会凭空消失').toMatch(/setQueuedLocal\(/);
    expect(src).toMatch(/queuedLocal/);
  });

  it('同一件事不许在三个地方说 —— 药丸下面那行说明已删', () => {
    const src = read('../TimelineComposer.tsx');
    /* 注释里会引用这句话解释历史, 所以只看是不是还被渲染 (className 在不在) */
    expect(
      /className="atl-composer__queued-hint"/.test(src),
      '药丸已经带「插入」按钮, 占位符里也有那半句, 再加一行字就是用户说的"不合理"',
    ).toBe(false);
  });

  it('插话按下就抛乐观气泡, 且排不上时要撤掉', () => {
    const src = stripComments(read('../AgentTimelineView.tsx'));
    const at = src.indexOf('onInject={');
    expect(at, 'AgentTimelineView 里应当有 onInject (闸没空跑)').toBeGreaterThan(0);
    const body = src.slice(at, at + 4000);
    expect(body, '按下插话必须立刻落气泡 —— 否则又要靠输入框顶着那段空档')
      .toMatch(/emitOptimisticInject\(/);
    /* injectMessage 的回执是三岔, 只有明确被拒那一岔撤气泡:
     *   queued === true      → 排上了, 气泡留着等引擎认领;
     *   queued === false     → 明确被拒, 撤气泡 + 文字退回, 否则留一条用户没说过的假记录;
     *   queued === undefined → 送达情况不明, **故意不撤**: 消息可能已经送到, 撤掉等于
     *     把用户刚说的话从界面上抹了, 而系统又不会自动重发, 他连查都无从查起。
     * 所以断言是"恰好一处", 不是"至少一处" —— 多出来的那处只可能长在 undefined 那岔上。 */
    const drops = body.match(/dropOptimistic\(\)/g) ?? [];
    expect(drops.length, '明确被拒那一岔必须撤掉乐观气泡').toBe(1);
    expect(body, 'queued === false 才是撤气泡的那一岔').toMatch(/queued === false/);
  });

  it('引擎那条事件必须认领已有气泡, 不是无条件 append', () => {
    const src = stripComments(read('../../../pages/workspace/hooks/useStreamHandler.ts'));
    const at = src.indexOf("event.type === 'user_message_injected'");
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, at + 2600);
    expect(body, '不走 settleInjectedMessage 就是无条件 append = 同一句话两个气泡')
      .toMatch(/settleInjectedMessage\(/);
    /* 落气泡这件事只许有一条路: 这里再出现裸 appendTimelineEntry 就说明绕过了认领 */
    expect(
      /appendTimelineEntry\(/.test(body),
      'user_message_injected 分支里不该再有裸 appendTimelineEntry',
    ).toBe(false);
  });

  it('认领规则只有一处定义, 且认领不到时才新建', () => {
    const src = stripComments(read('../injectOptimisticBubble.ts'));
    expect(src).toMatch(/OPTIMISTIC_INJECT_ID_PREFIX = 'msg-injected-local-'/);
    /* 认领到就 return, 绝不能两个都做 —— 那就是两个气泡 */
    const at = src.indexOf('export function settleInjectedMessage');
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, at + 1400);
    expect(body).toMatch(/if \(claimed\) return;/);
  });
});
