import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { formatForegroundSteered } from '../executeShellMessages.js';

const here = dirname(fileURLToPath(import.meta.url));
const shellDir = resolve(here, '..');

describe('前台命令的插话让出 (steering)', () => {
  it('被打断的返回文案明确区分于"命令自己失败"', () => {
    const out = formatForegroundSteered({ workspaceRoot: '/ws', command: 'ping -n 60 127.0.0.1' }, 'partial stdout', 'partial stderr');
    expect(out).toContain('Interrupted by user (steering)');
    expect(out).toContain('partial stdout');
    expect(out).toContain('[stderr]');
    expect(out).toContain('partial stderr');
    // 不能长得像普通失败: 否则模型会去解读半截输出、以为命令跑完了
    expect(out.startsWith('Failed:')).toBe(false);
  });

  it('foregroundShellExecution 接上了让出判据: 有看门狗、真的杀树、并按 steered 提前返回', () => {
    const src = readFileSync(resolve(shellDir, 'foregroundShellExecution.ts'), 'utf8');
    expect(src, '参数里应当有 shouldYieldToSteering').toContain('shouldYieldToSteering');
    expect(src, '应当有轮询让出的看门狗').toMatch(/startSteeringWatch/);
    expect(src, '让出时必须真的杀进程树 (与 signal 那条同源)').toMatch(/steered = true;\s*kill\(\);/);
    /* 两个分支 (OS 沙箱 / direct execa) 都要在场: 只改一个分支会留一半缺口 */
    const killCallSites = src.match(/startSteeringWatch\(/g) ?? [];
    expect(killCallSites.length, '沙箱分支 + direct 分支各挂一处看门狗').toBe(2);
    const steeredReturns = src.match(/\.steered\(\)/g) ?? [];
    expect(steeredReturns.length, '两个分支各有一处 steered 提前返回').toBe(2);
  });

  it('execute_shell 把 runner 的让出判据透传给前台执行', () => {
    const src = readFileSync(resolve(shellDir, 'executeShellTool.ts'), 'utf8');
    const passThrough = src.match(/shouldYieldToSteering: context\?\.shouldYieldToSteering/g) ?? [];
    expect(passThrough.length, '两个前台调用点都要透传').toBe(2);
  });
});
