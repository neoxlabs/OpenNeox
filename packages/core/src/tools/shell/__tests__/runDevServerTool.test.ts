/**
 * runDevServerTool — 核心分支单测
 *
 * 覆盖:
 *  1. 空 command → status:'error'
 *  2. 已有同命令 bg 进程 + port 已知 → status:'reused' + url
 *  3. 已有同命令 bg 进程 + port 未知 → status:'port_pending'
 *
 * 不测真 spawn 路径 — 那是 runBackgroundShellCommand 自己的领地, 它已经有
 * smokeE2E + autoBackgroundPolicy 等测覆盖. 这里只验"复用判定"与"输出契约".
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

/* ---------- mock 模块: 在 import 工具前装好 ---------- */

const mockProcessManager = {
  background: [] as Array<{ pid: number; command: string; startTime: Date; port?: number; status: string; outputBuffer?: string; exitCode?: number }>,
  getBackgroundRunning() { return this.background.filter(p => p.status === 'running'); },
  get(pid: number) { return this.background.find(p => p.pid === pid); },
  setPort(pid: number, port: number) { const p = this.get(pid); if (p) p.port = port; },
  markAdoptable() { /* noop */ },
  register() { /* noop */ },
};

vi.mock('../../runtimeToolServices.js', () => ({
  getToolServices: () => ({
    processManager: mockProcessManager,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    shellEnv: { getShellEnv: () => ({}), preloadShellEnv: async () => {} },
  }),
  getToolLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock('@neoxlabs/kernel/tools/workspaceContext.js', () => ({
  getWorkspaceRootFromContext: () => '/tmp/fake-workspace',
}));

vi.mock('@neoxlabs/platform/platform/portProbe.js', () => ({
  probeListeningPort: vi.fn(async (_pid: number) => undefined),
  isLikelyLongRunningCommand: vi.fn((_cmd: string) => true),
}));

/* 不 mock backgroundShellExecution — 复用分支根本不会调它. spawn 分支这里不测. */

import { runDevServerTool } from '../runDevServerTool.js';

interface ToolResult {
  status: string;
  pid?: number;
  port?: number;
  url?: string;
  command: string;
  message: string;
  next: string;
}

const callTool = async (args: any): Promise<ToolResult> => {
  const raw = await runDevServerTool.function(args, { signal: undefined });
  return JSON.parse(typeof raw === 'string' ? raw : await raw);
};

describe('runDevServerTool', () => {
  beforeEach(() => {
    mockProcessManager.background = [];
  });

  it('空 command 返回 status:error', async () => {
    const r = await callTool({ command: '   ' });
    expect(r.status).toBe('error');
    expect(r.message).toMatch(/command/);
    expect(r.next).toBeTruthy();
  });

  it('已有同命令进程 + port 已知 → reused + url', async () => {
    mockProcessManager.background.push({
      pid: 9001,
      command: 'npm run dev',
      startTime: new Date(),
      port: 5173,
      status: 'running',
    });
    const r = await callTool({ command: 'npm run dev' });
    expect(r.status).toBe('reused');
    expect(r.pid).toBe(9001);
    expect(r.port).toBe(5173);
    expect(r.url).toBe('http://localhost:5173');
    expect(r.next).toMatch(/browser_navigate/);
  });

  it('已有同命令进程 + port 未知 → port_pending', async () => {
    mockProcessManager.background.push({
      pid: 9002,
      command: 'pnpm dev',
      startTime: new Date(),
      status: 'running',
    });
    const r = await callTool({ command: 'pnpm dev' });
    expect(r.status).toBe('port_pending');
    expect(r.pid).toBe(9002);
    expect(r.port).toBeUndefined();
    expect(r.url).toBeUndefined();
    /* port_pending 的 next 指引"再来一次或换路径", 不应该硬塞 browser_navigate */
    expect(r.next).toMatch(/没探到/);
  });

  it('已有同命令 + port_hint 兜底 → reused + url 用 hint', async () => {
    mockProcessManager.background.push({
      pid: 9003,
      command: 'vite',
      startTime: new Date(),
      status: 'running',
    });
    const r = await callTool({ command: 'vite', port_hint: 5173 });
    expect(r.status).toBe('reused');
    expect(r.url).toBe('http://localhost:5173');
  });

  it('command 不同 → 不复用 (留给 spawn 分支 — 测试中不真 spawn)', async () => {
    mockProcessManager.background.push({
      pid: 9004,
      command: 'npm run dev',
      startTime: new Date(),
      port: 5173,
      status: 'running',
    });
    /* 复用判定靠 normalized 命令比对 — "next dev" ≠ "npm run dev", 不应该复用 9004.
     * 测试不真 spawn (会真跑命令), 这里只确认它不会被错误 reuse. */
    const promise = callTool({ command: 'next dev', wait_seconds: 1 });
    /* 5s 内一定能 resolve (走 spawn 路径会真跑 next dev, 大概率秒退 exited).
     * 我们只确认 status 不是 'reused' 即可. */
    const r = await promise;
    expect(r.status).not.toBe('reused');
  });
});
