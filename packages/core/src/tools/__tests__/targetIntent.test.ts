/**
 * target 授权使用确定性用户意图判据。
 * ═══════════════════════════════════════════════════════════════════════════
 * 长跑能力只能由用户明确要求开启。
 *
 * 判据使用正则匹配用户输入，不能交给模型自行判断。
 *
 * 这个用例固定两个方向:
 *   · 用户明确说要 → 必须认出来 (不能逼他去记斜杠命令)
 *   · 任务规模、复杂度或语气强度都不构成授权
 *
 * renderer 侧 TimelineComposer.tsx 使用同一正则，因为它持有用户输入原文。
 */
import { describe, expect, it } from 'vitest';
import { TARGET_INTENT_RE } from '../targetModeTools.js';

/* 正则带 /g? 没有。但 lastIndex 的坑值得防一手: 每次用新的 test 调用, 不共享状态 */
const asks = (s: string) => TARGET_INTENT_RE.test(s);

describe('用户明确要求长跑 → 算授权', () => {
  const yes = [
    '/target 从零做一个后台',
    '给我设定一个 target 长期跑：做电商后台',
    '设个target',
    '设置一个target',
    '开启 target 模式',
    '我要长期目标',
    '围绕这个目标一直跑',
    '按这个目标持续跑，别停',
    '开个长跑模式做这件事',
  ];
  for (const t of yes) it(`认出: ${t}`, () => expect(asks(t)).toBe(true));
});

describe('任务大 ≠ 授权 —— 这些一个都不许放进去', () => {
  const no = [
    '把这个目录做成一个完整的电商后台：商品/订单/库存/优惠券/结算/权限/报表七个模块，每个都要有测试',
    '这是个大工程，认真做完',
    '帮我把整个项目重构一遍',
    '修一下这个 bug',
    '帮我加个功能',
    '系统性地梳理一下这个代码库',
    '从头到尾做一遍',
    '解释下 target 是什么意思吧',      /* 提到 target 但不是要开它 */
    '这个 target 参数怎么传',           /* 同上: 在问代码里的 target */
  ];
  for (const t of no) it(`不误判: ${t.slice(0, 24)}…`, () => expect(asks(t)).toBe(false));
});

/* 实录: 需求说明「设定目标一直干」, 闸门没认出来, activate_target 被拒,
 * 只能退化成普通长任务。原因是 `一直干` 硬要求后缀 (到/下去), 而中文「设定目标」
 * 也没有分支 —— 那条要求出现英文单词 target。 */
describe('回归: 中文「设定目标」类说法', () => {
  const yes = [
    '设定目标一直干',
    '在不影响其他功能的情况下，你来把这个做细致，设定目标一直干',
    '设定目标一直做',
    '设置一下目标, 别问我了',
    '定个目标慢慢弄',
  ];
  for (const t of yes) it(`认出: ${t.slice(0, 24)}…`, () => expect(asks(t)).toBe(true));

  /* 放宽之后仍然不能把这些当授权 —— 它们只是"做久一点", 不是"你自己一直跑" */
  const no = [
    '一直改到好为止',      /* 没有"目标/target"语义, 只是形容词式的坚持 */
    '这个目标是什么',
    '目标用户是谁',
  ];
  for (const t of no) it(`不误判: ${t}`, () => expect(asks(t)).toBe(false));
});
