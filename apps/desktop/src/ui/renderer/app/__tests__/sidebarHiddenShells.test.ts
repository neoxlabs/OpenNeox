import { describe, expect, it } from 'vitest';
import { isOrphanSubAgentPlaceholder, isNeverRunCloudShell } from '../sessionItemMapping';

describe('子 Agent 占位行', () => {
  it('无父、无模型、占位名 → 藏', () => {
    expect(isOrphanSubAgentPlaceholder({ name: '子 Agent Explorer', parentSessionId: null, modelId: '' })).toBe(true);
  });
  it('有父 → 嵌在父下面照常显示', () => {
    expect(isOrphanSubAgentPlaceholder({ name: '子 Agent Explorer', parentSessionId: 'p1', modelId: '' })).toBe(false);
  });
  it('有模型 (正规建的) 或用户自己起的名字 → 不藏', () => {
    expect(isOrphanSubAgentPlaceholder({ name: '子 Agent Explorer', modelId: 'gpt-5' })).toBe(false);
    expect(isOrphanSubAgentPlaceholder({ name: '查一下子 Agent 的问题', modelId: '' })).toBe(false);
  });
});

describe('没跑过的云端空壳', () => {
  it('没标题且服务端记的运行时长为 0 → 藏', () => {
    expect(isNeverRunCloudShell({ title: null, totalActiveSecs: 0 })).toBe(true);
    expect(isNeverRunCloudShell({ title: '  ', totalActiveSecs: 0 })).toBe(true);
  });
  it('有标题 / 跑过 / 时长未知 → 不藏', () => {
    expect(isNeverRunCloudShell({ title: '部署检查', totalActiveSecs: 0 })).toBe(false);
    expect(isNeverRunCloudShell({ title: null, totalActiveSecs: 12 })).toBe(false);
    expect(isNeverRunCloudShell({ title: null, totalActiveSecs: null })).toBe(false);
  });
});
