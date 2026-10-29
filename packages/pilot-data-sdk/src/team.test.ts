import { describe, expect, it } from 'vitest';
import { dueTeamJobs, factInScope, inScope, nextRun, specialistOf, specialistPrompt } from './team.js';
import type { Insight } from './insights.js';

describe('Pilot 团队', () => {
  const finance = specialistOf('finance')!;
  const health = specialistOf('health')!;

  it('范围: 财务管家看不到体检, 健康教练看不到账户', () => {
    expect(inScope(finance, 'finance.expense@1')).toBe(true);
    expect(inScope(finance, 'asset.snapshot')).toBe(true);
    expect(inScope(finance, 'health.report')).toBe(false);
    expect(inScope(health, 'health.report@1')).toBe(true);
    expect(inScope(health, 'asset.snapshot')).toBe(false);
    expect(factInScope(specialistOf('social')!, 'person.妈妈.likes')).toBe(true);
    expect(factInScope(finance, 'person.妈妈.likes')).toBe(false);
  });

  it('定时: 1 号 9 点后派财务月报, 周日 20 点后派健康周计划; 关掉的不派; 改过钟点按新的', () => {
    const jobs = dueTeamJobs({}, { day: '2026-11-01', time: '20:30' });
    expect(jobs.map((j) => j.specialist).sort()).toEqual(['finance', 'health']);
    expect(jobs.find((j) => j.specialist === 'finance')!.key).toBe('team:finance|2026-11-01');
    expect(dueTeamJobs({}, { day: '2026-11-01', time: '08:59' })).toEqual([]);
    expect(dueTeamJobs({ 'team.finance': 'off' }, { day: '2026-11-01', time: '20:30' }).map((j) => j.specialist)).toEqual(['health']);
    expect(dueTeamJobs({ 'team.health.time': '21:00' }, { day: '2026-11-01', time: '20:30' }).map((j) => j.specialist)).toEqual(['finance']);
  });

  it('下次时间', () => {
    expect(nextRun(finance, {}, { day: '2026-10-11', time: '12:00' })).toBe('2026-11-01 09:00');
    expect(nextRun(health, {}, { day: '2026-10-11', time: '12:00' })).toBe('2026-10-11 20:00');
    expect(nextRun(health, {}, { day: '2026-10-11', time: '21:00' })).toBe('2026-10-18 20:00');
    expect(nextRun(specialistOf('travel')!, {}, { day: '2026-10-11', time: '12:00' })).toBeNull();
  });

  it('提示词只放它范围内的洞察和档案', () => {
    const ins: Insight[] = [
      { id: 'a', domain: 'money', tone: 'watch', score: 0.8, title: '花得快', detail: '¥9,547' },
      { id: 'b', domain: 'body', tone: 'watch', score: 0.8, title: '睡得少', detail: '5.8 小时' },
    ];
    const p = specialistPrompt(finance, '月报', { today: '2026-11-01', insights: ins, records: ['- 10-31 [finance.expense] 午饭 35'], facts: { 'goal.save': '每月 3000', 'person.妈妈.likes': '桂花糕' } });
    expect(p.system).toContain('财务管家');
    expect(p.user).toContain('花得快');
    expect(p.user).not.toContain('睡得少');
    expect(p.user).toContain('goal.save = 每月 3000');
    expect(p.user).not.toContain('桂花糕');
  });
});
