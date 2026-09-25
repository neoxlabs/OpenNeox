/**
 * 审计 F05: 旧 Client-Agent 接口没有执行却回成功 —— sendCommand 回 queued:true, 宿主没有 interrupt 也回 interrupted:true。
 */
import { describe, expect, it } from 'vitest';
import { HostContext } from '../client-agent/hostContext.js';

const make = (runtimeHost: unknown) =>
  new HostContext({ runtimeHost: runtimeHost as any, sessionManager: {} as any, version: 't', workingDirectory: '/tmp' });

describe('HostContext 如实报告', () => {
  it('sendCommand: 没有命令队列 → queued:false 并说明不支持', async () => {
    const res = await make(null).sendCommand('do something');
    expect(res.queued).toBe(false);
    expect(res.error).toMatch(/unsupported/);
  });

  it('interrupt: 宿主没有 interrupt 方法 → interrupted:false', async () => {
    const res = await make({ getCurrentTaskId: () => 't1' }).interrupt();
    expect(res.interrupted).toBe(false);
  });

  it('interrupt: 宿主有 interrupt → 调到并报 true', async () => {
    let called = 0;
    const res = await make({ getCurrentTaskId: () => 't1', interrupt: () => { called++; } }).interrupt();
    expect(res).toEqual({ interrupted: true, taskId: 't1' });
    expect(called).toBe(1);
  });
});
