import { describe, expect, it } from 'vitest';
import { fmtAgentElapsed, parseExternalAgentResult } from '../cells/externalAgentResult';

const DONE = [
  'Droid 完成（0.4 分钟）',
  '它执行了：Create×1、Read×2',
  '',
  '改动在独立分支 `neox/ext-droid-1a2b`（目录 /tmp/wt），**不在当前工作区**。',
  '涉及 2 个文件：hello.txt, src/a.ts',
  '复核后可以 `git merge` 或 `git cherry-pick` 合进来。',
  '',
  '--- Droid 的输出 ---',
  '已创建 hello.txt。',
].join('\n');

describe('parseExternalAgentResult', () => {
  it('完成: 用时 / 工具 / 分支 / 文件 / 只剩它自己的输出', () => {
    const r = parseExternalAgentResult(DONE);
    expect(r.elapsedMs).toBe(24_000);
    expect(r.tools).toEqual([{ name: 'Create', count: 1 }, { name: 'Read', count: 2 }]);
    expect(r.branch).toBe('neox/ext-droid-1a2b');
    expect(r.files).toEqual(['hello.txt', 'src/a.ts']);
    expect(r.output).toBe('已创建 hello.txt。');
    expect(r.output).not.toMatch(/完成（|\*\*|---/);
  });

  it('失败: 原因一行, 括号里的改法单独拿出来', () => {
    const r = parseExternalAgentResult('Droid 未完成（0.2 分钟）\n原因：405 Method Not Allowed（用的模型 custom:X 取自 ~/.factory/settings.json；换一个可用的自定义模型，或派活时点名模型）');
    expect(r.reason).toBe('405 Method Not Allowed');
    expect(r.hint).toMatch(/^用的模型 custom:X/);
    expect(r.elapsedMs).toBe(12_000);
  });

  it('没改文件 / 认不出结构的纯文本', () => {
    expect(parseExternalAgentResult('Codex 完成（1.0 分钟）\n（没有产生文件改动）').noChanges).toBe(true);
    expect(parseExternalAgentResult('just some text').output).toBe('just some text');
  });

  it('用时格式', () => {
    expect(fmtAgentElapsed(24_000)).toBe('24s');
    expect(fmtAgentElapsed(125_000)).toBe('2m 05s');
  });
});
