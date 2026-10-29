import { describe, expect, it } from 'vitest';
import { buildSimpleLivingMemoryContext } from '../living/simpleLivingMemory.js';

describe('buildSimpleLivingMemoryContext', () => {
  it('includes project summary and module/rule hits', async () => {
    const context = await buildSimpleLivingMemoryContext({
      workDir: '/repo',
      query: '帮我看看 src/runtime/assistantRuntime.ts 这块怎么改',
      projectMemory: {
        project: '这是一个 Electron + assistant runtime 项目。',
        projectSource: '.neox/project.md',
        modules: new Map([
          ['src-runtime', 'runtime 模块负责调度 assistant/session/worker。'],
        ]),
        rules: new Map([
          ['assistant', {
            globs: ['src/runtime/**'],
            content: '修改 runtime 时优先保持事件流和 UI 投影兼容。',
            sourcePath: '/repo/.neox/rules/assistant.md',
          }],
        ]),
      },
      maxChars: 1200,
    });

    expect(context).toContain('项目知识');
    expect(context).toContain('相关模块');
    expect(context).toContain('相关规则');
    expect(context).toContain('runtime 模块负责调度');
  });
});
