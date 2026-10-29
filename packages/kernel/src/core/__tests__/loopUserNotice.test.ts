/**
 * 循环护栏同时维护模型指令和用户可见提示。
 *
 *   模型指令和用户提示用途不同；用户提示需要包含重复目标，避免时间线只显示抽象次数。
 *
 *   测试同时覆盖两种文案均由 generateIntervention 生成。
 */
import { describe, it, expect } from 'vitest';
import { LoopDetector, LoopLevel } from '../loopDetector';

describe('循环拦截的用户文案', () => {
  it('给用户的那句是中文人话, 且带上重复的目标', () => {
    const d = new LoopDetector();
    const args = { file_path: 'apps/desktop/src/ui/electron/services/mainWindowFactory.ts' };
    for (let i = 0; i < 4; i++) d.record('readfile', args, 'success');
    const iv = d.generateIntervention(LoopLevel.HARD, 'readfile', args);
    expect(iv.userNotice).toBeTruthy();
    expect(iv.userNotice).toContain('mainWindowFactory.ts');
    expect(iv.userNotice).not.toContain('LOOP WARNING');
    expect(iv.userNotice).not.toMatch(/You MUST|Do NOT/);
  });

  it('给模型的那份原样保留 —— 拦截要能真的改变模型行为', () => {
    const d = new LoopDetector();
    const args = { file_path: 'a.ts' };
    for (let i = 0; i < 4; i++) d.record('readfile', args, 'success');
    const iv = d.generateIntervention(LoopLevel.HARD, 'readfile', args);
    expect(iv.message).toContain('[LOOP WARNING - HARD]');
    expect(iv.message).toMatch(/You MUST/);
  });
});
