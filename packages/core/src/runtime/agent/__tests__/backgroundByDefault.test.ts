/**
 * 子 agent 默认后台
 *
 *   需求： 「尽可能后台, 前台就失去了子 agent 意义了是不是」——
 *   前台子 agent 阻塞主 agent 干等它跑完, 除了上下文隔离, 跟主 agent 自己做没区别,
 *   还多一次模型往返。并行才是派子 agent 的意义。
 *
 *    判据必须是 `!== false` 而不是 `=== true`: schema 里的 `default: true` 只是给模型
 *   看的提示词, 模型不传这个字段时**运行时拿到的是 undefined**。只改 schema 不改这里,
 *   界面上一点变化都不会有 —— 同"改了一半"那类坑。
 */
import { describe, expect, it } from 'vitest';

/** 复刻 agentTool 的调度判据。真实实现改了这里要一起改。 */
function decideBackground(
  runInBackgroundArg: boolean | undefined,
  backgroundAllowed: boolean,
): boolean {
  return runInBackgroundArg !== false && backgroundAllowed;
}

describe('省略即后台', () => {
  it('模型不传 run_in_background → 后台 (老行为是前台)', () => {
    expect(decideBackground(undefined, true)).toBe(true);
  });

  it('显式 true → 后台', () => {
    expect(decideBackground(true, true)).toBe(true);
  });

  it('显式 false → 前台 (下一步严格依赖它的产出时用)', () => {
    expect(decideBackground(false, true)).toBe(false);
  });
});

describe('⚠️ 一次性宿主一律降级前台', () => {
  /* neox -p 这类宿主: turn 一结束进程就退, 后台 agent 会被杀、产出全丢且退出码 0。
   * 降级只影响调度方式, 工作照做, 对模型透明。 */
  it('不允许后台时, 省略也走前台', () => {
    expect(decideBackground(undefined, false)).toBe(false);
  });

  it('不允许后台时, 显式 true 也走前台', () => {
    expect(decideBackground(true, false)).toBe(false);
  });

  it('不允许后台时, 显式 false 当然还是前台', () => {
    expect(decideBackground(false, false)).toBe(false);
  });
});
