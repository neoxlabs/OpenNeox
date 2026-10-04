
import { describe, it, expect } from 'vitest';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { wrapShellForGuardedMode, dangerousShellReason } from '../guardedShellGate.js';
import { getSandboxFloor } from '../sandboxFloor.js';

function shellStub(onCall: () => void = () => {}): Tool {
  return {
    name: 'execute_shell',
    description: 'run a command',
    group: 'agent',
    parameters: { type: 'object', properties: {} },
    function: async () => {
      onCall();
      return 'ran';
    },
  } as unknown as Tool;
}

describe('dangerousShellReason', () => {
  it('放行脚本执行与只读命令', () => {
    expect(dangerousShellReason('node deck.mjs')).toBeNull();
    expect(dangerousShellReason('node "$NEOX_PPTX_INSPECT" ./deck.pptx')).toBeNull();
    expect(dangerousShellReason('ls -la')).toBeNull();
    expect(dangerousShellReason('cd /tmp && node deck.mjs')).toBeNull();
    expect(dangerousShellReason('"$NEOX_NODE" deck.mjs')).toBeNull();
    expect(dangerousShellReason('"$NEOX_NODE" "$NEOX_PPTX_INSPECT" ./deck.pptx')).toBeNull();
    expect(dangerousShellReason('"$NEOX_NODE" deck.mjs && "$NEOX_NODE" "$NEOX_PPTX_RENDER" ./deck.pptx ./png/')).toBeNull();
  });

  it('拦危险与系统级命令', () => {
    expect(dangerousShellReason('rm -rf ~/Documents')).not.toBeNull();
    expect(dangerousShellReason('sudo launchctl load x')).not.toBeNull();
    expect(dangerousShellReason('scp deck.pptx user@host:/tmp')).not.toBeNull();
    expect(dangerousShellReason('ls && rm -rf ~/Desktop')).not.toBeNull();
  });

  it('拦重定向写文件 (write_file 是受控替代), 但放行 >/dev/null 与 2>&1', () => {
    expect(dangerousShellReason('node inspect.mjs > report.json')).not.toBeNull();
    expect(dangerousShellReason('node deck.mjs >/dev/null 2>&1')).toBeNull();
  });
});

describe('wrapShellForGuardedMode', () => {
  it('work 模式: 危险命令被拦, 且不会调到底层工具', async () => {
    let called = false;
    const tool = wrapShellForGuardedMode(shellStub(() => { called = true; }), 'work');
    const out = JSON.parse(await tool.function({ command: 'rm -rf ~/Documents' }, {} as never) as string);
    expect(out.blocked).toBe(true);
    expect(called).toBe(false);
    /* 工作模式没有「完全接管」开关, 文案不该教用户去找一个不存在的按钮 */
    expect(out.error).not.toContain('完全接管');
  });

  it('放行的命令不强制抬沙盒地板 —— 沙盒只看用户设置', async () => {
    for (const mode of ['work'] as const) {
      let floorSeen: string | undefined = 'unset';
      let ran = false;
      const tool = wrapShellForGuardedMode(
        shellStub(() => { floorSeen = getSandboxFloor()?.mode; ran = true; }),
        mode,
      );
      await tool.function({ command: 'node deck.mjs' }, {} as never);
      expect(ran, `${mode} 模式放行的命令要真的跑`).toBe(true);
      expect(floorSeen, `${mode} 模式不该偷偷打开沙盒`).toBeUndefined();
    }
  });

  it('描述里写清边界, 模型事前就知道', () => {
    const work = wrapShellForGuardedMode(shellStub(), 'work');
    expect(work.description).toContain('数据处理脚本');
    expect(work.description).not.toContain('NEOX_NODE');
    expect(work.description).not.toContain('OS 沙盒');
  });
});
