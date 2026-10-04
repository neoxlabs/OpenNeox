import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

let tmpHome = '';
let ws = '';
const realHome = process.env.HOME;

beforeAll(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-ckpt-home-'));
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-ckpt-ws-'));
  process.env.HOME = tmpHome;
  await fs.writeFile(path.join(ws, 'a.txt'), 'alpha\n');
});
afterAll(async () => {
  process.env.HOME = realHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(ws, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('收尾快照: 无变更零扫描, 有变更定点提交', () => {
  it('无变更 → 不跑 git status; 防抖中的写入 flush 后进 commit', async () => {
    const { ShadowGitCheckpoint } = await import('../ShadowGitCheckpoint.js');
    const cp = new ShadowGitCheckpoint() as any;
    await cp.init(ws);
    await cp.startWatching('s1', 0);

    const statusCalls: number[] = [];
    const origStatus = cp.git.status.bind(cp.git);
    cp.git.status = (...args: any[]) => { statusCalls.push(Date.now()); return origStatus(...args); };

    const empty = await cp.createCheckpoint('Message completed');
    expect(empty.stats.total).toBe(0);
    expect(statusCalls).toEqual([]);

    await fs.writeFile(path.join(ws, 'a.txt'), 'omega\n');
    cp.handleChange('modify', path.join(ws, 'a.txt'));   // 还在 100ms 防抖里
    const meta = await cp.createCheckpoint('Message completed');
    expect(statusCalls).toEqual([]);
    expect(meta.stats.total).toBe(1);
    const gitDir = cp.shadowGitDir as string;
    const shown = execFileSync('git', ['--git-dir', gitDir, 'show', `${meta.id}:a.txt`], { encoding: 'utf8' });
    expect(shown).toBe('omega\n');

    await cp.destroy();
  }, 30_000);
});

describe('finishMessageInBackground: 不挡回合, 但挡下一轮', () => {
  it('立刻返回; startMessage 与回滚等收尾落完', async () => {
    const { RuntimeCheckpointService } = await import('../runtimeCheckpointService.js');
    const { CheckpointManager } = await import('../CheckpointManager.js');
    (CheckpointManager as any).isGitAvailable = async () => true;
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const fakeManager = {
      createCheckpoint: async () => { order.push('finish:start'); await gate; order.push('finish:done'); return { id: 'c1' }; },
      stopWatching: async () => {},
      startWatching: async () => { order.push('start'); return 'base'; },
      rollbackTo: async () => { order.push('rollback'); return { success: true, restored: [], errors: [] }; },
    } as any;
    const svc = new RuntimeCheckpointService(fakeManager);
    svc.setWorkspace(ws);
    svc.isEnabled = () => true;

    const t0 = Date.now();
    svc.finishMessageInBackground('s1', 'Message completed');
    expect(Date.now() - t0).toBeLessThan(20);

    const next = svc.startMessage('s1');
    const rb = svc.rollbackToCheckpoint('c0');
    await new Promise(r => setTimeout(r, 30));
    expect(order).toEqual(['finish:start']);

    release();
    await Promise.all([next, rb]);
    expect(order.slice(0, 2)).toEqual(['finish:start', 'finish:done']);
    expect(order).toContain('start');
    expect(order).toContain('rollback');
  });
});
