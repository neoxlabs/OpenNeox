import { describe, expect, it } from 'vitest';
import { DEFAULT_SHADOW_GIT_CONFIG } from '../checkpoint/types.js';
import { CheckpointManager } from '../checkpoint/CheckpointManager.js';

/** 验证 checkpoint 默认关闭，并具备目录过滤、数量上限、大文件保护和可重复的 git 检测。 */
describe('checkpoint safety guarantees', () => {
  it('默认关闭 — 不打扰没主动开的用户', () => {
    expect(DEFAULT_SHADOW_GIT_CONFIG.enabled).toBe(false);
  });

  it('忽略重量级目录 — 防全盘扫描卡死 + 存储起飞', () => {
    const patterns = DEFAULT_SHADOW_GIT_CONFIG.ignoredPatterns;
    // 这几个是存储/性能的命脉, 少一个都可能让 checkpoint 把几十万文件吞进去
    expect(patterns).toContain('**/node_modules/**');
    expect(patterns).toContain('**/.git/**');
    expect(patterns).toContain('**/dist/**');
    expect(patterns).toContain('**/build/**');
    expect(patterns).toContain('**/.next/**');
    expect(patterns).toContain('**/target/**');
  });

  it('存储封顶 — checkpoint 数量上限 + 大文件跳过', () => {
    // 数量上限 (配合 git gc) 防 commit 无限增长
    expect(DEFAULT_SHADOW_GIT_CONFIG.maxCheckpoints).toBeGreaterThan(0);
    expect(DEFAULT_SHADOW_GIT_CONFIG.maxCheckpoints).toBeLessThanOrEqual(200);
    // 超过 veryLargeFileThreshold 的文件跳过同步, 防单个大文件撑爆仓库
    expect(DEFAULT_SHADOW_GIT_CONFIG.veryLargeFileThreshold).toBeGreaterThan(0);
    expect(DEFAULT_SHADOW_GIT_CONFIG.largeFileThreshold).toBeGreaterThan(0);
    expect(DEFAULT_SHADOW_GIT_CONFIG.veryLargeFileThreshold)
      .toBeGreaterThanOrEqual(DEFAULT_SHADOW_GIT_CONFIG.largeFileThreshold);
    // TTL 存在 — 过期 checkpoint 可被清理
    expect(DEFAULT_SHADOW_GIT_CONFIG.checkpointTTL).toBeGreaterThan(0);
  });

  it('git 可用性检测可重复调用且结果一致 (缓存)', async () => {
    // git 没装时各操作优雅 no-op 的守卫; 缓存后多次调用同值, 不重复 spawn git
    const first = await CheckpointManager.isGitAvailable();
    const second = await CheckpointManager.isGitAvailable();
    expect(typeof first).toBe('boolean');
    expect(second).toBe(first);
  });
});
