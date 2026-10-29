import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { persistedAnchorMissing, shouldRestoreLiveSessionToBottom } from '../hooks/timelineScrollStatePersist';

const SRC = readFileSync(
  join(__dirname, '..', 'hooks', 'useTimelineScrollController.ts'), 'utf8');
/* 注释换成等量换行 —— 源码注释里正当地引用了这些标识符 */
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, m => '\n'.repeat((m.match(/\n/g) ?? []).length))
  .replace(/^\s*\/\/.*$/gm, '');

/** 取 onScroll 的函数体 —— 从 `const onScroll = () => {` 到配对的 `};` */
function onScrollBody(): string {
  const at = CODE.indexOf('const onScroll = () => {');
  if (at < 0) return '';
  let i = CODE.indexOf('{', at), depth = 0;
  for (; i < CODE.length; i++) {
    if (CODE[i] === '{') depth++;
    else if (CODE[i] === '}') { depth--; if (depth === 0) break; }
  }
  return CODE.slice(at, i + 1);
}

describe('timeline 滚动位置落盘', () => {
  it('测试指着的确实是滚动控制器 (路径自检)', () => {
    expect(CODE).toContain('rememberCurrentScrollState');
    expect(CODE).toContain('timelineScrollState');
    expect(onScrollBody().length).toBeGreaterThan(200);
  });

  it('滚动停下来之后要真的记一次 (防抖回调里必须调记录函数)', () => {
    /* onScroll 里**本来就有**一处 rememberCurrentScrollState, 但它被
     *   `if (!scrollingFlagRef.current || nearEdge)` 挡着 ——
     * 注释写的是"滚动中不每帧持久化, idle 后再记", 可这个判断只在 scroll 事件处理器
     * 内部; 滚动一停就不再有 scroll 事件, "idle 后再记"这一步**永远等不到**。
     * 所以闸不能只断言"onScroll 里出现过这个函数名"(第一版就是这样, 变异后照绿),
     * 必须断言**防抖回调里**调了它。 */
    const body = onScrollBody();
    const at = body.indexOf('scrollStatePersistTimerRef.current = window.setTimeout');
    expect(at, '找不到防抖排程, 闸失效了').toBeGreaterThan(0);
    expect(body.slice(at, at + 260),
      '防抖回调里必须调 rememberCurrentScrollState —— 否则滚动停下后存档仍停在旧值, '
      + '用户翻完历史切走再回来位置全丢')
      .toMatch(/rememberCurrentScrollState\(\)/);
  });

  it('记录是防抖的 —— 每个 scroll 事件都落盘会砸性能', () => {
    const body = onScrollBody();
    expect(body).toMatch(/scrollStatePersistTimerRef/);
    expect(body, '要先清掉上一个计时器再排新的').toMatch(/clearTimeout\(scrollStatePersistTimerRef\.current\)/);
    expect(body).toMatch(/setTimeout\(/);
  });

  it('解绑监听时要清掉计时器, 免得回调打在已卸载的组件上', () => {
    const at = CODE.indexOf('el.removeEventListener("scroll", onScroll)');
    expect(at, '找不到监听清理处, 闸失效了').toBeGreaterThan(0);
    expect(CODE.slice(Math.max(0, at - 320), at)).toMatch(/scrollStatePersistTimerRef/);
  });

  it('运行中切回走钉底判定, 不能只按存档把末行 align:start 顶出一片空白', () => {
    expect(CODE).toContain('shouldRestoreLiveSessionToBottom');
  });
});

describe('persistedAnchorMissing', () => {
  it('冷加载只有尾页时, 历史锚点不在当前 keys 里就要回捞', () => {
    expect(
      persistedAnchorMissing(
        {
          scrollTop: 800,
          scrollHeight: 40000,
          clientHeight: 700,
          maxScroll: 39300,
          gapToBottom: 38000,
          anchorKey: 'row-old',
          atBottom: false,
          userScrolledAway: true,
          bottomStickIntent: false,
          rowsLength: 200,
          updatedAt: 1,
        },
        ['row-new-a', 'row-new-b'],
      ),
    ).toBe(true);
    expect(
      persistedAnchorMissing(
        {
          scrollTop: 0,
          scrollHeight: 800,
          clientHeight: 700,
          maxScroll: 100,
          gapToBottom: 0,
          atBottom: true,
          userScrolledAway: false,
          bottomStickIntent: true,
          rowsLength: 12,
          updatedAt: 1,
        },
        ['row-a'],
      ),
    ).toBe(false);
  });
});

describe('shouldRestoreLiveSessionToBottom', () => {
  const awayOnLast = {
    atBottom: false,
    userScrolledAway: true,
    anchorKey: 'm-latest',
  };

  it('没在跑就按历史位置恢复, 不强制钉底', () => {
    expect(shouldRestoreLiveSessionToBottom({
      sessionStreaming: false,
      saved: awayOnLast,
      lastRowKey: 'm-latest',
    })).toBe(false);
  });

  it('运行中且锚的就是末行 → 钉底 (尾部留白会被误判成离底)', () => {
    expect(shouldRestoreLiveSessionToBottom({
      sessionStreaming: true,
      saved: awayOnLast,
      lastRowKey: 'm-latest',
    })).toBe(true);
  });

  it('运行中但人在翻更早的历史 → 保住那个位置', () => {
    expect(shouldRestoreLiveSessionToBottom({
      sessionStreaming: true,
      saved: { atBottom: false, userScrolledAway: true, anchorKey: 'm-old' },
      lastRowKey: 'm-latest',
    })).toBe(false);
  });

  it('运行中存档本来说在底 → 钉底', () => {
    expect(shouldRestoreLiveSessionToBottom({
      sessionStreaming: true,
      saved: { atBottom: true, userScrolledAway: false, anchorKey: 'm-latest' },
      lastRowKey: 'm-latest',
    })).toBe(true);
  });
});
