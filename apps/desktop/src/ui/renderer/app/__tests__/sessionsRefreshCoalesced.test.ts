import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createSessionsRefresher } from '../sessionsRefresher';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, '../NeoxRuntimeBridge.tsx'), 'utf8');

describe('三条高频路径都走节流器', () => {
  it.each([
    ['发完消息', /只是为了让 sidebar 那一行的 updatedAt 变新[\s\S]{0,120}scheduleSessionsRefresh\(\)/],
    ['子 Agent done/aborted', /action === 'done' \|\| data\.action === 'aborted'[\s\S]{0,200}scheduleSessionsRefresh\(\)/],
    ['子 Agent 新建 session', /sub_agent_session_created[\s\S]{0,300}scheduleSessionsRefresh\(\)/],
  ])('%s', (_n, re) => { expect(src).toMatch(re); });

  it('这三处不再各自全量拉', () => {
    /* 剩下的 getSessions() 都在低频路径 (bootstrap / 切 workspace / 登录态变化), 不受影响 */
    const hot = src.slice(src.indexOf('发送完成后刷新 sessions'), src.indexOf('发送完成后刷新 sessions') + 400);
    expect(hot).not.toMatch(/window\.neox\.getSessions\(\)/);
  });
});

describe('节流器本身', () => {
  it('400ms 内连打 10 次只发一次', async () => {
    vi.useFakeTimers();
    let calls = 0;
    (globalThis as any).window = { neox: { getSessions: async () => { calls += 1; return []; } } };
    const schedule = createSessionsRefresher(() => { /* apply */ }, (x) => x);
    for (let i = 0; i < 10; i += 1) schedule();
    await vi.advanceTimersByTimeAsync(600);
    expect(calls).toBe(1);
    vi.useRealTimers();
  });

  it('隔开的两次触发各发一次 —— 不是把后面的吞掉', async () => {
    vi.useFakeTimers();
    let calls = 0;
    (globalThis as any).window = { neox: { getSessions: async () => { calls += 1; return []; } } };
    const schedule = createSessionsRefresher(() => { /* apply */ }, (x) => x);
    schedule();
    await vi.advanceTimersByTimeAsync(600);
    schedule();
    await vi.advanceTimersByTimeAsync(600);
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  it('拉取失败不抛出去 —— 它挂在流事件回调上, 抛了会打断那条链', async () => {
    vi.useFakeTimers();
    (globalThis as any).window = { neox: { getSessions: async () => { throw new Error('boom'); } } };
    const schedule = createSessionsRefresher(() => { /* apply */ }, (x) => x);
    expect(() => schedule()).not.toThrow();
    await expect(vi.advanceTimersByTimeAsync(600)).resolves.not.toThrow();
    vi.useRealTimers();
  });
});
