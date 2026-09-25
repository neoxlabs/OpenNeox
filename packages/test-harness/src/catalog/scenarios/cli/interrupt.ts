import type { Scenario } from '../../../types.js';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../../../..');

async function importCliSource<T>(rel: string): Promise<T> {
  return import(pathToFileURL(resolve(REPO_ROOT, rel)).href) as Promise<T>;
}

export const interrupt: Scenario[] = [
  {
    id: 'cli.interrupt.enter-aborts',
    module: 'cli.interrupt',
    surface: 'cli',
    tier: 'smoke',
    priority: 'P0',
    title: '运行中 Enter = 中断并开新 turn（非静默排队）',
    why: '回归: Enter 只 inject 排队，与「Enter to interrupt」提示矛盾',
    mode: 'unit',
    codeHint: 'apps/cli/src/utils/runningTaskInput.ts',
    steps: [
      { action: '主 agent 运行中（含 Explore）输入新消息 Enter', expect: '立刻 interrupt，不静默排队' },
      { action: '观察底部 status', expect: '进入新 turn 或 agents 清零，非「已排队」假象' },
    ],
    async run() {
      const { handleRunningTaskInput } = await importCliSource<{
        handleRunningTaskInput: (o: Record<string, unknown>) => boolean;
      }>('apps/cli/src/utils/runningTaskInput.ts');
      let interrupted = false;
      let injected = false;
      const handled = handleRunningTaskInput({
        isTaskRunning: true,
        source: 'local',
        rawInput: 'stop explore',
        debugEnabled: false,
        enqueueRemoteInput: () => {},
        logDebug: () => {},
        injectMessage: () => {
          injected = true;
        },
        addUserMessage: () => {},
        interruptRunningTask: () => {
          interrupted = true;
        },
      });
      const ok = handled === false && interrupted && !injected;
      return {
        ok,
        note: ok ? 'interrupt path ok' : `handled=${handled} interrupted=${interrupted} injected=${injected}`,
      };
    },
  },
  {
    id: 'cli.interrupt.esc-clears-explore',
    module: 'cli.interrupt',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    title: 'Esc 中断后 Explore 卡与 N agents 清掉',
    why: '回归: sticky background agents',
    mode: 'manual',
    codeHint: 'abortRunningTaskAgents + taskAgentsSuspended',
    steps: [
      { action: '让主 agent 开 2+ Explore', expect: '底部显示 N agents，sidebar/卡可见' },
      { action: '按 Esc', expect: 'Explore 卡收掉，N→0，输入框可打字' },
      { action: '立刻再发「继续探索」', expect: '可再建 Explore，不被 suspended 永久挡' },
    ],
  },
  {
    id: 'cli.interrupt.esc-mid-stream',
    module: 'cli.interrupt',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    title: '流式输出中 Esc，下一轮干净',
    why: '半截 stream / thinking 污染下一轮',
    mode: 'manual',
    codeHint: 'finalizeStreamingState',
    steps: [
      { action: '发「写一首很长的诗」等流式任务', expect: 'StatusLine 显示 Writing/Thinking' },
      { action: '中途 Esc', expect: '流停止，无永久 spinner' },
      { action: '再发短问「1+1」', expect: '正常回复，无旧流残片混进' },
    ],
  },
  {
    id: 'cli.interrupt.double-esc',
    module: 'cli.interrupt',
    surface: 'cli',
    tier: 'core',
    priority: 'P1',
    title: '已空闲时再 Esc 不炸 / 不误清历史',
    why: '重复中断边界',
    mode: 'manual',
    steps: [
      { action: '空闲会话连按 Esc', expect: '无 crash，timeline 历史保留' },
    ],
  },
];
