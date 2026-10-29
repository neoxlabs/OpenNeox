import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assessCheckpointWorkspace,
  describeUnsafeWorkspace,
} from '../checkpoint/workspaceGuard.js';
import { ShadowGitCheckpoint } from '../checkpoint/ShadowGitCheckpoint.js';

describe('checkpoint workspace guard', () => {
  it('用户主目录本身被拒绝', () => {
    const result = assessCheckpointWorkspace(os.homedir());
    expect(result.unsafe).toBe(true);
    if (result.unsafe) {
      expect(result.reason).toBe('home');
      expect(describeUnsafeWorkspace(result)).toContain(os.homedir());
    }
  });

  it('磁盘根目录被拒绝', () => {
    const root = path.parse(path.resolve(os.homedir())).root;
    const result = assessCheckpointWorkspace(root);
    expect(result.unsafe).toBe(true);
    if (result.unsafe) expect(result.reason).toBe('filesystem-root');
  });

  it('普通项目目录允许', () => {
    const project = path.join(os.homedir(), 'code', 'demo-project');
    expect(assessCheckpointWorkspace(project).unsafe).toBe(false);
  });

  it('init(主目录) 不建仓库, 并给出拦截原因', async () => {
    const cp = new ShadowGitCheckpoint();
    await cp.init(os.homedir());
    expect(cp.isInitialized()).toBe(false);
    expect(cp.getBlockedReason()).toBeTruthy();
    // 所有入口都必须 no-op, 不能抛错或返回可用的 checkpoint
    await expect(cp.startWatching('s1')).resolves.toBeNull();
    await expect(cp.getCheckpoints()).resolves.toEqual([]);
    const meta = await cp.createCheckpoint('x');
    expect(meta.id).toBe('no-changes');
    expect(meta.changes).toEqual([]);
  });

  it('系统目录被拒绝 (按平台取一个真实存在的)', () => {
    const systemDir = process.platform === 'win32'
      ? (process.env.WINDIR || 'C:\\Windows')
      : '/usr';
    const result = assessCheckpointWorkspace(systemDir);
    expect(result.unsafe).toBe(true);
    if (result.unsafe) expect(result.reason).toBe('system-directory');
  });
});
