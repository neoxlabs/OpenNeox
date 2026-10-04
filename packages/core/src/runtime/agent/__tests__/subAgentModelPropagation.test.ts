/**
 * 子 agent 模型透传闸。
 *
 * 【背景】agent 工具的 `model` 参数一直支持按模型派活, 解析也一直是对的 —— 但结果
 * **只进了一行 cliLogger**: task 不存、事件不带、store 没有字段, 于是 UI 从来无从显示
 * "这个子 agent 到底用的是谁"。更糟的是 server 建子会话时落的是 `parent.modelId`,
 * 子 agent 换了模型的话侧栏显示的是**错的**模型 —— 不是缺失, 是错误。
 *
 * 这条测试钉住链路的第一段 (register → task → listActive → lifecycle)。这一段断了,
 * 后面的事件/UI 全都拿不到东西。
 */

import { describe, it, expect } from 'vitest';
import { BackgroundAgentManager, type BackgroundAgentTask } from '../backgroundAgent.js';

describe('子 agent 模型透传', () => {
  it('register 传入的模型进 task, 并出现在 listActive 里', () => {
    const mgr = new BackgroundAgentManager();
    mgr.register('Agent-1', '审计权限模块', 'prompt', 'sess-1', 'auditor', {
      model: 'gpt-5.6',
      providerId: 'openai',
      modelInherited: false,
    });

    const [info] = mgr.listActive('sess-1');
    expect(info.model).toBe('gpt-5.6');
    expect(info.providerId).toBe('openai');
    expect(info.modelInherited).toBe(false);
  });

  it('lifecycle 回调拿得到模型 —— UI 事件桥的唯一数据源', () => {
    const seen: Array<{ kind: string; task: BackgroundAgentTask }> = [];
    const mgr = new BackgroundAgentManager({
      onLifecycle: (kind, task) => { seen.push({ kind, task }); },
    });

    mgr.register('Agent-1', '规划架构', 'prompt', 'sess-1', 'planner', {
      model: 'claude-opus-5',
      providerId: 'anthropic',
      modelInherited: false,
    });

    const started = seen.find((e) => e.kind === 'started');
    expect(started, 'register 应触发 started lifecycle').toBeTruthy();
    expect(started!.task.model).toBe('claude-opus-5');
    expect(started!.task.providerId).toBe('anthropic');
    expect(started!.task.modelInherited).toBe(false);
  });

  it('没传模型时字段为空 —— 调用方据此判定"继承主 agent"', () => {
    /* 继承的场景 UI 不挂标签。这里断言"不传就是 undefined", 防止有人给它加个
     * 想当然的默认值 (比如硬写主模型名), 那会让 UI 分不清继承和显式指定。 */
    const mgr = new BackgroundAgentManager();
    mgr.register('Agent-1', '随手改个字', 'prompt', 'sess-1');
    const [info] = mgr.listActive('sess-1');
    expect(info.model).toBeUndefined();
    expect(info.modelInherited).toBeUndefined();
  });
});
