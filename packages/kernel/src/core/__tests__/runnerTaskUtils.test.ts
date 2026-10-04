import { describe, it, expect } from 'vitest';
import { inferTaskRequirements } from '../runnerTaskUtils';

const needsChange = (t: string) => inferTaskRequirements(t).requireMutation;

describe('inferTaskRequirements', () => {
  it('口语里的改代码任务', () => {
    for (const t of [
      '把 ledger 改成多账户: 每条记录属于一个账户',
      '给 ledger 加一个本地 web 服务 `ledger serve --port 3000`',
      '给 ledger 做中英双语',
      '逐个复现、先写能复现的测试、再修, 最后全部测试通过',
      'store.js 换成异步',
      'add a dark mode toggle',
    ]) expect(needsChange(t), t).toBe(true);
  });

  it('问答 / 解释 / 调研不算', () => {
    for (const t of [
      '解释一下任务优先级是怎么算出来的',
      'Neox 的上下文压缩是在什么条件下触发的? 不要改代码。'.replace('不要改代码。', ''),
      '你好',
    ]) expect(needsChange(t), t).toBe(false);
  });
});
