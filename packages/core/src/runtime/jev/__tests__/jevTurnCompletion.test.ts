import { describe, expect, it } from 'vitest';
import { isUnfinished, shouldAskUnfinished } from '../jevTurnCompletion.js';

/* 典型收尾句: 没做完的必须都送去问 (漏了就等于没这个闸), 做完的尽量不问 (省一次请求) */
const announced = [
  '我先看一下 config.ts 的内容。', '接下来我会修改 router 文件并补上测试。', '好的, 让我搜索一下相关代码。',
  'Let me check the logs next.', '现在去改 `src/api/client.ts` 里的超时逻辑。',
  '问题定位到了: 缓存 key 没带版本号。接下来改 `cache.ts`。', '测试挂了 2 个, 我去看看失败原因。',
  "I'll now update the README with the new flags.", '依赖装好了, 下一步运行构建。', '看完了, 一共两段。接下来我去把第一段改成标题。',
];
const done = [
  '已经改好了, 测试全部通过, 提交 hash 是 a1b2c3。', '根本原因是缓存 key 没带版本号, 已修复并验证。', '以上就是全部的分析。',
  'Done — the build is green and the PR is up.', '`hello.py` 已改为打印 hello world, 运行输出 `hello world`。',
  '华东三个月合计 **440**。', '定时任务已创建: 每天 09:00 执行 `echo hello`, ID 9245。', '两处「猫」都已替换成「狗」, 文件已保存。',
];

describe('shouldAskUnfinished', () => {
  it('宣布下一步的收尾句全部送去问', () => {
    for (const t of announced) expect(shouldAskUnfinished(t, 3), t).toBe(true);
  });

  it('交结果的收尾句不问, 不给结束加延迟', () => {
    for (const t of done) expect(shouldAskUnfinished(t, 3), t).toBe(false);
  });

  it('没调过工具 / 太长 / 在问用户 → 不问', () => {
    expect(shouldAskUnfinished(announced[0], 0)).toBe(false);
    expect(shouldAskUnfinished(`${'结果'.repeat(250)}接下来我去改。`, 3)).toBe(false);
    expect(shouldAskUnfinished('接下来改 A 还是 B?', 3)).toBe(false);
  });
});

describe('isUnfinished', () => {
  it('宣布了下一步且用户没让它停 → 拦; 用户只要计划 → 不拦', () => {
    expect(isUnfinished({ announced: 0.97, hold: 0.05, ms: 1 })).toBe(true);
    expect(isUnfinished({ announced: 0.97, hold: 0.9, ms: 1 })).toBe(false);
    expect(isUnfinished({ announced: 0.7, hold: 0.05, ms: 1 })).toBe(false);
  });
});
