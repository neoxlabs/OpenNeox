import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const BRIDGE = strip(fs.readFileSync(path.join(ROOT, 'app/NeoxRuntimeBridge.tsx'), 'utf8'));
const HOST = strip(fs.readFileSync(
  path.resolve(ROOT, '../../../../../packages/core/src/runtime/agentRuntimeHost.ts'), 'utf8'));

function errorHandlerBlock(): string {
  const i = BRIDGE.indexOf("if (data?.type !== 'error') return;");
  expect(i, '找不到处理 runtime error 事件的 onStream 分支').toBeGreaterThan(0);
  const end = BRIDGE.indexOf('return () => { unsub', i);
  expect(end, '找不到这个 effect 的 cleanup 边界').toBeGreaterThan(i);
  return BRIDGE.slice(i, end);
}

describe('运行时错误要上时间线', () => {
  test('host 仍然发这个事件 —— 链路上游别被删掉', () => {
    expect(HOST).toMatch(/emitEvent\(\{ type: 'error', message:/);
  });

  test('renderer 有一条分支把它变成 runner_error 卡片', () => {
    const block = errorHandlerBlock();
    expect(block).toMatch(/type: 'runner_error'/);
    expect(block).toMatch(/errorMessage: raw/);
    /* 必须给下一步动作 —— 只报错不给出路等于把用户扔在原地 */
    expect(block).toMatch(/errorAction: \{ kind: 'retry'/);
  });

  test('事件必须认自己的会话归属, 不许猜', () => {
    const block = errorHandlerBlock();
    expect(block).toMatch(/requireStreamEventSession\(data,/);
    expect(block).not.toMatch(/activeSession\?\.id/);
  });

  test('用户自己按停不算中断 —— 不弹红卡', () => {
    expect(errorHandlerBlock()).toMatch(/interrupted by user/i);
  });
});
