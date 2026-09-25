/**
 * 暂停 —— 从"类写好了没人调"到真能挂起再唤醒 (接线)。
 *
 * 语义上跟"停止"完全是两回事, 这份测试主要钉的就是这个区别:
 *   停止 = 这一轮作废, 要接着干得重新发一遍
 *   暂停 = 进程还在, 恢复即从下一轮继续, 什么都不丢
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  getPauseController, peekPauseController, pauseSession, resumeSession,
  isSessionPaused, disposePauseController, toPauseGate, clearSessionPause,
} from '../pauseController.js';
describe('暂停着按停止 (2026-09-13 卡死回归)', () => {
  it('toPauseGate.cancel: 唤醒挂着的 waitForResume 并清标志', async () => {
    const c = getPauseController(S);
    pauseSession(S);
    const gate = toPauseGate(c);
    const waiting = gate.waitForResume({ sessionId: S, iteration: 1, toolCalls: 0 });
    gate.cancel?.();
    await expect(waiting).resolves.toBeUndefined();
    expect(isSessionPaused(S)).toBe(false);
  });

  it('clearSessionPause: 唤醒等待者、清标志, 但保留控制器', async () => {
    const c = getPauseController(S);
    pauseSession(S);
    const waiting = toPauseGate(c).waitForResume({ sessionId: S, iteration: 0, toolCalls: 0 });
    clearSessionPause(S);
    await expect(waiting).resolves.toBeUndefined();
    expect(isSessionPaused(S)).toBe(false);
    expect(peekPauseController(S)).toBe(c);
  });
});

const S = 'sess-pause-test';
afterEach(() => { disposePauseController(S); });

describe('按会话的控制器', () => {
  it('同一个会话拿到同一个控制器', () => {
    expect(getPauseController(S)).toBe(getPauseController(S));
  });

  it('peek 不会凭空建一个 —— 查状态不该有副作用', () => {
    expect(peekPauseController('never-seen')).toBeUndefined();
  });

  it('没在跑的会话 pause 返回 false —— 调用方要如实说, 不能显示成"已暂停"', () => {
    expect(pauseSession('never-seen')).toBe(false);
    expect(isSessionPaused('never-seen')).toBe(false);
  });

  it('暂停 → 恢复 的状态流转', () => {
    getPauseController(S);
    expect(pauseSession(S)).toBe(true);
    expect(isSessionPaused(S)).toBe(true);
    /* 重复暂停不算数, 免得建出第二个永远没人 resolve 的 Promise */
    expect(pauseSession(S)).toBe(false);
    expect(resumeSession(S)).toBe(true);
    expect(isSessionPaused(S)).toBe(false);
    expect(resumeSession(S)).toBe(false);
  });
});

describe('挂起 / 唤醒', () => {
  it('waitForResume 真的挂住, resume 之后才继续', async () => {
    const gate = toPauseGate(getPauseController(S));
    pauseSession(S);
    let resumed = false;
    const waiting = gate.waitForResume({ sessionId: S, iteration: 3, toolCalls: 7 })
      .then(() => { resumed = true; });
    /* 让出一拍: 没 resume 就不该往下走 */
    await new Promise((r) => setTimeout(r, 20));
    expect(resumed).toBe(false);
    resumeSession(S);
    await waiting;
    expect(resumed).toBe(true);
  });

  it('**dispose 会先 reset 再删** —— 否则挂着的 Promise 永远没人 resolve, runner 卡死且日志无线索', async () => {
    const gate = toPauseGate(getPauseController(S));
    pauseSession(S);
    let done = false;
    const waiting = gate.waitForResume({ sessionId: S, iteration: 1, toolCalls: 0 }).then(() => { done = true; });
    disposePauseController(S);
    await waiting;
    expect(done).toBe(true);
  });

  it('没暂停时 isPaused 为假, runner 那一句判断直接过去', () => {
    const gate = toPauseGate(getPauseController(S));
    expect(gate.isPaused()).toBe(false);
  });

  it('快照只填 runner 真的知道的字段, 不编一份假的对话历史', async () => {
    const c = getPauseController(S);
    const gate = toPauseGate(c);
    pauseSession(S);
    const waiting = gate.waitForResume({ sessionId: S, iteration: 5, toolCalls: 9 });
    await new Promise((r) => setTimeout(r, 10));
    expect(c.snapshot).toMatchObject({
      sessionId: S, llmCallCount: 5, totalToolCalls: 9, messages: [],
    });
    resumeSession(S);
    await waiting;
  });
});
