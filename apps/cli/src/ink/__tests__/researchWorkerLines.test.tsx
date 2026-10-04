/**
 * CLI 并行 agent 行的离线渲染台
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 用户要的是"跟界面一样, 能看到这一行有几个 agent 在跑"。CLI 其实早就有这块
 * (StatusLine 的 worker 行; AgentBar 已经 no-op, 注释写着"渲染统一到 StatusLine 的
 * worker 行"), 所以先把**现状**渲出来看清楚, 再决定加什么 —— 免得造一个已经存在的东西。
 *
 * 写法照抄 bottomBarFit.test.tsx, 三个坑一个都不能少:
 *   · render 要 `debug:true` + `incrementalRendering:false`, 否则 stdout 上只有控制序列
 *   · StatusLine 直接读 `process.stdout.columns` (多容器下 context 会 stale), 测试里要覆盖
 *   · 取不到画面必须**抛错**。我第一版让它回落到最后一帧, 结果拿到 `\x1b[?2004h`,
 *     报错写着 expected '[?2004h' to contain 'Research' —— 完全不指向真因。
 *
 * 看画面: `DEBUG_FRAME=1 npx vitest run apps/cli/src/ink/__tests__/researchWorkerLines.test.tsx`
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import stringWidth from 'string-width';
import { render } from '../../../vendor/ink/src/index.js';
import { App } from '../App.js';

function createFakeStdout(cols: number, rows = 40) {
  const frames: string[] = [];
  const stream: any = new EventEmitter();
  stream.columns = cols;
  stream.rows = rows;
  stream.isTTY = true;
  stream.write = (c: string) => { frames.push(String(c)); return true; };
  stream.end = () => {};
  return { stream, frames };
}

function createFakeStdin() {
  const s: any = new EventEmitter();
  s.isTTY = true;
  s.setRawMode = () => s; s.setEncoding = () => s; s.resume = () => s;
  s.pause = () => s; s.read = () => null; s.ref = () => s; s.unref = () => s;
  return s;
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** 判据跟 bottomBarFit 一致: 帧里必须有输入框那条整行 '─' */
function lastUiFrame(frames: string[]): string {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = strip(frames[i]);
    if (f.split('\n').some(l => /^─{20,}$/.test(l.trim()))) return f;
  }
  throw new Error(`没有捕获到 UI 帧 (共 ${frames.length} 次 write) —— 断言会变成空跑, 先修取帧`);
}

/** 一个 research worker 的实况 —— 字段跟 runtimeEvents.updateTaskAgentContext 喂的一致 */
/* 每个 worker 查**不同的角度** —— 夹具第一版三个写成同一条, 画面上三行身份一模一样,
 * 等于没验到"看得出谁在查什么"这件事本身。 */
const ANGLES = [
  '磁盘占用与安装耗时的实测数据',
  '兼容性坑与从 npm workspaces 迁移的改动面',
  'CI 缓存命中率与 lambda 体积的影响',
];

const worker = (n: number, over: Record<string, any> = {}) => ({
  agentId: `Agent-${n}`,
  agentLabel: `Agent-${n}`,
  status: 'running' as const,
  currentTask: 'web_search',
  workerRole: 'research',
  workerTask: `调研: ${ANGLES[(n - 1) % ANGLES.length]}`,
  input: 8200, output: 1400,
  contextWindow: 200000, tokensUsedForContext: 8200, pressure: 0.041,
  toolUseCount: 3, elapsedMs: 12_000,
  ...over,
});

/** Aggregated progress fixture with representative in-progress values. */
const progress = (over: Record<string, any> = {}) => ({
  topic: 'pnpm 相比 npm 在 monorepo 项目里的实际取舍',
  scale: 'compare',
  seeds: 5,
  dispatched: 3, completed: 2, failed: 0, inFlight: 1, queued: 2,
  sources: 20, domains: 10, claims: 25, disputed: 2,
  ...over,
});

function renderBottom(stats: any[], cols = 120, researchProgress: any = null): string {
  const { stream, frames } = createFakeStdout(cols);
  const stdin = createFakeStdin();
  const realCols = process.stdout.columns;
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
  try {
    const instance = render(
      <App
        zone="bottom"
        isRunning
        showHeader={false}
        provider="deepseekmk"
        model="deepseek-v4-flash"
        statusText="Researching..."
        tokenStats={{ input: 988, output: 932, total: 140800, contextWindow: 272000, tokensUsedForContext: 140800, pressure: 0.52 }}
        runMode="agentic"
        staticEntries={[]}
        pendingEntries={[]}
        agentContextStats={stats as any}
        researchProgress={researchProgress}
        onSubmit={() => {}}
        onInterrupt={() => {}}
        onExit={() => {}}
      />,
      { stdout: stream, stdin, debug: true, patchConsole: false, exitOnCtrlC: false, incrementalRendering: false } as any,
    );
    const frame = lastUiFrame(frames);
    instance.unmount();
    instance.cleanup();
    /* 画面写**文件**而不是 console.log —— vitest 会吞掉测试里的 console 输出,
     * 第一次就是这么"跑绿了但什么都没看到"。DEBUG_FRAME 指向一个目录即可。 */
    const dumpDir = process.env.DEBUG_FRAME;
    if (dumpDir && dumpDir !== '1') {
      const n = stats.filter((s: any) => s.agentId !== 'Main').length;
      fs.mkdirSync(dumpDir, { recursive: true });
      fs.appendFileSync(
        `${dumpDir}/cli-worker-lines.txt`,
        `\n═════ ${cols} 列 · ${n} 个 worker ═════\n${frame}\n`,
        'utf-8',
      );
    }
    return frame;
  } finally {
    Object.defineProperty(process.stdout, 'columns', { value: realCols, configurable: true });
  }
}

describe('CLI 并行 agent 行 —— 现状', () => {
  it('三个 research worker 各占一行, 带角色和当前动作', () => {
    const frame = renderBottom([
      worker(1),
      worker(2, { currentTask: 'web_fetch' }),
      worker(3, { currentTask: 'research_record' }),
    ]);
    expect(frame).toContain('Research');
    expect((frame.match(/├─|└─/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('Main 不算 worker', () => {
    const frame = renderBottom([
      { agentId: 'Main', agentLabel: 'Main', status: 'running', input: 1, output: 1, contextWindow: 200000, tokensUsedForContext: 1, pressure: 0 },
      worker(1),
    ]);
    expect((frame.match(/├─|└─/g) ?? []).length).toBe(1);
  });

  it('聚合行: 说清整轮到哪了 (角度/在跑/来源/结论/分歧)', () => {
    const frame = renderBottom([worker(1), worker(2)], 120, progress());
    expect(frame).toContain('Deep research');
    expect(frame).toContain('2/5 angles');
    expect(frame).toContain('1 running');
    expect(frame).toContain('20 sources/10 sites');
    expect(frame).toContain('2 disputed');
    /* 聚合行在 worker 行**上面** —— 先说整体再说个体 */
    expect(frame.indexOf('Deep research')).toBeLessThan(frame.indexOf('├─'));
  });

  it('没有调研在跑时不占屏', () => {
    const frame = renderBottom([worker(1)], 120, null);
    expect(frame).not.toContain('Deep research');
  });

  it('任何宽度下都不超宽', () => {
    for (const cols of [80, 100, 120]) {
      const frame = renderBottom([worker(1), worker(2)], cols, progress());
      const over = frame.split('\n').map((l, i) => ({ i, w: stringWidth(l), l })).filter(x => x.w > cols);
      expect(over.map(x => `第${x.i}行 宽${x.w}>${cols}`).join('\n')).toBe('');
    }
  });
});
