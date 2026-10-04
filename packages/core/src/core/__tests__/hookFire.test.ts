/**
 * hook 真的被跑起来了吗 —— 端到端: 写一个真脚本, 让 fire() 去跑它。
 *
 * 光测 parseHookOutcome 是不够的: 那只证明"解析对", 不证明"跑起来了"。
 * hook 最典型的失效方式恰恰是**从没被调用过** —— 用户以为脚本在跑, 其实没有,
 * 而且不报任何错。所以这里用真文件、真 settings.json、真子进程。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserHookRunner } from '../userHooks.js';

let dir: string;

/** 在临时工作区里写一个 .neox/settings.json + 一个可执行脚本 */
function setup(event: string, script: string, matcher?: string): UserHookRunner {
  const hookPath = join(dir, 'h.sh');
  writeFileSync(hookPath, `#!/bin/sh\n${script}\n`);
  chmodSync(hookPath, 0o755);
  mkdirSync(join(dir, '.neox'), { recursive: true });
  writeFileSync(join(dir, '.neox', 'settings.json'), JSON.stringify({
    hooks: { [event]: [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: hookPath }] }] },
  }));
  return new UserHookRunner(dir);
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'neox-hook-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('fire() 端到端', () => {
  it('真的把脚本跑起来了 (exit 0 放行)', async () => {
    const r = setup('PreToolUse', 'exit 0');
    const out = await r.fire('PreToolUse', { toolName: 'Edit' });
    expect(out.allow).toBe(true);
  });

  it('exit 2 真的拦得住, 理由从 stderr 出来', async () => {
    const r = setup('PreToolUse', 'echo "不许改生产配置" >&2; exit 2');
    const out = await r.fire('PreToolUse', { toolName: 'Edit' });
    expect(out.allow).toBe(false);
    expect(out.reason).toContain('不许改生产配置');
  });

  it('stdout JSON 的 updatedInput 能带回来', async () => {
    const r = setup('PreToolUse', `echo '{"updatedInput":{"path":"/safe/x"}}'`);
    const out = await r.fire('PreToolUse', { toolName: 'Edit', toolArgs: { path: '/etc/passwd' } });
    expect(out.updatedInput).toEqual({ path: '/safe/x' });
  });

  it('permissionDecision:allow 能让 skipsApproval 成立', async () => {
    const r = setup('PermissionRequest', `echo '{"permissionDecision":"allow"}'`);
    const out = await r.fire('PermissionRequest', { toolName: 'execute_shell' });
    expect(out.decision).toBe('allow');
    expect(out.allow).toBe(true);
  });

  it('**通知式事件的拒绝不生效** —— 脚本写 exit 2 也只当它抱怨', async () => {
    const r = setup('PostToolUse', 'echo boom >&2; exit 2');
    const out = await r.fire('PostToolUse', { toolName: 'Edit' });
    expect(out.allow).toBe(true);
  });

  it('matcher 不命中就不跑 —— 一条 hook 不该管别的工具', async () => {
    /* 脚本一跑就拦; 只要结果是放行, 就说明它压根没被调用 */
    const r = setup('PreToolUse', 'exit 2', 'Write');
    expect((await r.fire('PreToolUse', { toolName: 'Edit' })).allow).toBe(true);
    expect((await r.fire('PreToolUse', { toolName: 'Write' })).allow).toBe(false);
  });

  it('载荷里能拿到事件名和自定义字段 (脚本按它们判断)', async () => {
    /* 脚本读 stdin 的 JSON, 命中就拦 —— 拦住了就证明字段真的传进去了 */
    const r = setup('SubagentStart', `
      payload=$(cat)
      case "$payload" in
        *'"hook_event":"SubagentStart"'*'"agent_id":"a-7"'*) echo "命中" >&2; exit 2 ;;
      esac
      exit 0`);
    const out = await r.fire('SubagentStart', { payload: { agent_id: 'a-7' } });
    expect(out.allow).toBe(false);
  });

  it('没有配置该事件时零开销 (hasHooksFor 为假, 不起子进程)', async () => {
    const r = setup('PreToolUse', 'exit 2');
    await r.initialize();
    expect(r.hasHooksFor('PreToolUse')).toBe(true);
    expect(r.hasHooksFor('SessionEnd')).toBe(false);
    expect((await r.fire('SessionEnd', {})).allow).toBe(true);
  });
});
