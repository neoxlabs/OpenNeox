import type { Scenario } from '../../../types.js';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../../../..');

async function importCliSource<T>(rel: string): Promise<T> {
  return import(pathToFileURL(resolve(REPO_ROOT, rel)).href) as Promise<T>;
}

export const compact: Scenario[] = [
  {
    id: 'cli.compact.no-double-prefix',
    module: 'cli.compact',
    surface: 'cli',
    tier: 'smoke',
    priority: 'P1',
    title: 'Status/Card 无 Compact Compact / 压缩 压缩',
    why: '回归: 双前缀文案',
    mode: 'unit',
    codeHint: 'apps/cli/src/ink/utils/compactProgress.ts',
    steps: [
      { action: '触发 compacting 进度', expect: 'StatusLine 单前缀 + 进度条' },
      { action: '看卡片正文', expect: '不重复「压缩/Compact」前缀' },
    ],
    async run() {
      const mod = await importCliSource<{
        buildCompactStatusLine: (t: string, d?: string) => string;
        buildCompactCardText: (t: string, d?: string) => string;
        isCompactTerminalMessage: (t: string) => boolean;
      }>('apps/cli/src/ink/utils/compactProgress.ts');
      const line = mod.buildCompactStatusLine('⚡ 生成摘要 1/3 组', 'model x');
      const card = mod.buildCompactCardText('ℹ️ 压缩未获收益', '56K');
      const lineOk =
        /^(压缩|Compact) \[/.test(line) && (line.match(/压缩|Compact/g) || []).length === 1;
      const cardOk = !/^压缩/.test(card) && /未获收益/.test(card);
      const termOk = mod.isCompactTerminalMessage('ℹ 无需压缩');
      const ok = lineOk && cardOk && termOk;
      return { ok, detail: { line, card }, note: ok ? undefined : 'prefix/card assert failed' };
    },
  },
  {
    id: 'cli.compact.ctx-refreshes',
    module: 'cli.compact',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    title: '压缩完成后 StatusLine ctx 同步下降',
    why: '回归: 卡片 24K→9K 但 ctx 表盘不动',
    mode: 'manual',
    codeHint: 'runtimeEvents context_compaction → setTokenStats',
    steps: [
      { action: '会话 ctx 拉高后 /compact', expect: '出现压缩卡片 xxK→yyK' },
      { action: '看底部 StatusLine ctx', expect: '数值降到接近 finalTokens' },
      { action: '再发一句短消息', expect: 'ctx 从新基线累加，不跳回压缩前高位' },
    ],
  },
  {
    id: 'cli.compact.manual-llm',
    module: 'cli.compact',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    title: '手动 /compact 走 LLM 摘要（非秒级 snip）',
    why: '回归: force 被 budget/tail-protect 跳过',
    mode: 'manual',
    codeHint: 'kernel compression force repartition keepTail=2',
    steps: [
      { action: '造 ~20–60K 上下文（多轮 tool 输出）', expect: 'StatusLine ctx 明显高于空会话' },
      { action: '执行 /compact', expect: '有「生成摘要」类进度，耗时明显 >1s' },
      { action: '看结果卡', expect: '有摘要收益或明确「未获收益」，非秒关无过程' },
    ],
  },
  {
    id: 'cli.compact.noop-clears-busy',
    module: 'cli.compact',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    title: '无需压缩时不卡 spinner / interrupt 提示',
    why: '回归: 终端「无需压缩」但 StatusLine 仍 busy',
    mode: 'manual',
    codeHint: 'compactionOwnsRunning + terminal compact msgs',
    steps: [
      { action: '短会话执行 /compact', expect: '提示无需压缩或未获收益' },
      { action: '立刻看 StatusLine', expect: '无压缩中 spinner，无「Enter to interrupt」残留' },
    ],
  },
  {
    id: 'cli.compact.progress-battery',
    module: 'cli.compact',
    surface: 'cli',
    tier: 'core',
    priority: 'P1',
    title: '压缩进度条/分组文案可读（中英）',
    why: 'CLI 应对齐桌面「有在压」的体感',
    mode: 'manual',
    codeHint: 'compactProgress.ts + StatusLine magenta',
    steps: [
      { action: '大上下文 /compact', expect: 'StatusLine 出现压缩进度条或分组进度' },
      { action: '切语言若支持', expect: 'Compact/压缩 标签与语言一致，无混杂双前缀' },
    ],
  },
  {
    id: 'cli.compact.auto-vs-manual',
    module: 'cli.compact',
    surface: 'cli',
    tier: 'nightly',
    priority: 'P1',
    title: '自动压缩与手动 /compact 都不弄坏会话',
    why: '两条路径事件/ctx 一致性',
    mode: 'manual',
    steps: [
      { action: '撑满触发自动压缩', expect: '有压缩卡，之后对话可续' },
      { action: '再手动 /compact', expect: '不 crash，ctx 合理' },
    ],
  },
];
