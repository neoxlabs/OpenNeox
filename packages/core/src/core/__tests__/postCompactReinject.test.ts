import { describe, it, expect, beforeEach } from 'vitest';
import {
  trackFileAccess,
  trackSkillInvocation,
  trackWorkState,
  trackToolFailure,
  resetFileAccessTracker,
  resetSkillTracker,
  resetWorkStateTracker,
  peekWorkState,
  generatePostCompactReinjectMessages,
} from '@neoxlabs/kernel/core/postCompactReinject.js';

const textOf = (m: { content: unknown }) =>
  typeof m.content === 'string' ? m.content : JSON.stringify(m.content);

describe('postCompactReinject', () => {
  beforeEach(() => {
    resetFileAccessTracker();
    resetSkillTracker();
    resetWorkStateTracker();
  });

  it('三个 tracker 都空时不产出消息 (且不抛)', () => {
    const r = generatePostCompactReinjectMessages([]);
    expect(r.messages).toHaveLength(0);
    expect(r.workStateInjected).toBe(false);
    expect(r.filesInjected).toBe(0);
  });

  /* 连续性的核心: 计划必须被原样带过压缩 */
  it('回灌当前计划, 含每一步的状态与进度分子分母', () => {
    trackWorkState('plan', [
      { content: 'schema.ts 加列', status: 'completed' },
      { content: '删除 fileDB.ts', status: 'in_progress' },
      { content: 'typecheck 验证', status: 'pending' },
    ]);
    const r = generatePostCompactReinjectMessages([]);
    expect(r.workStateInjected).toBe(true);
    const t = textOf(r.messages[0]!);
    expect(t).toContain('(1/3)');
    expect(t).toContain('- [x] schema.ts 加列');
    expect(t).toContain('- [>] 删除 fileDB.ts');
    expect(t).toContain('- [ ] typecheck 验证');
  });

  it('失败过的尝试会被带过去, 并明确要求不要原样重试', () => {
    trackToolFailure('run_tests', 'exit 1: 3 failing in db.spec.ts');
    const t = textOf(generatePostCompactReinjectMessages([]).messages[0]!);
    expect(t).toContain('已经失败过的尝试');
    expect(t).toContain('run_tests: exit 1: 3 failing in db.spec.ts');
    expect(t).toContain('不要原样重试');
  });

  it('同一个失败重复记录只留一条 (否则回灌全是重复行)', () => {
    for (let i = 0; i < 5; i++) trackToolFailure('edit', 'old_string 未命中');
    expect(peekWorkState().failures).toBe(1);
  });

  /* 空清单 = 计划已清空, 不能回灌一段空壳误导模型 */
  it('传空步骤数组 → 视为计划已清空, 不产出工作状态', () => {
    trackWorkState('plan', [{ content: 'x', status: 'pending' }]);
    trackWorkState('todo', []);
    expect(peekWorkState().steps).toBe(0);
    expect(generatePostCompactReinjectMessages([]).workStateInjected).toBe(false);
  });

  it('回灌最近读过的文件内容', () => {
    trackFileAccess('/repo/src/a.ts', 'export const a = 1;');
    const r = generatePostCompactReinjectMessages([]);
    expect(r.filesInjected).toBe(1);
    expect(r.messages.map(textOf).join('\n')).toContain('export const a = 1;');
  });

  it('回灌用过的技能', () => {
    trackSkillInvocation('commit', 'SKILL: how to commit');
    const r = generatePostCompactReinjectMessages([]);
    expect(r.skillsInjected).toBe(1);
    expect(r.messages.map(textOf).join('\n')).toContain('SKILL: how to commit');
  });

  /* 顺序即优先级: 预算耗尽时先保住最不可替代的那份 */
  it('工作状态排在文件与技能之前 —— 预算耗尽时先保住它', () => {
    trackFileAccess('/repo/src/a.ts', 'x'.repeat(500));
    trackSkillInvocation('commit', 'y'.repeat(500));
    trackWorkState('plan', [{ content: '第一步', status: 'in_progress' }]);
    const msgs = generatePostCompactReinjectMessages([]);
    expect(msgs.messages[0]!.name).toBe('PostCompactWorkState');
  });

  /* peekWorkState 必须能报出四个 tracker —— 上一轮排查只报 steps/failures,
   * 结果"文件那条通没通"从日志上看不出来, 白白多烧一个重建周期。 */
  it('peekWorkState 报全四个 tracker 的计数', () => {
    trackWorkState('todo', [{ content: 'a' }]);
    trackToolFailure('t', 'boom');
    trackFileAccess('/x.ts', 'c');
    trackSkillInvocation('s', 'body');
    expect(peekWorkState()).toEqual({ steps: 1, failures: 1, files: 1, skills: 1 });
  });

  it('已在保留消息里的文件不重复注入', () => {
    trackFileAccess('/repo/src/a.ts', 'export const a = 1;');
    const preserved = [
      { role: 'tool', name: 'readfile', content: 'reading /repo/src/a.ts ok' } as any,
    ];
    expect(generatePostCompactReinjectMessages(preserved).filesInjected).toBe(0);
  });

  it('预算外的热文件以路径清单形式回灌 (file map)', () => {
    /* 8 个大文件, 8K 预算只装得下前 2 个全文 */
    for (let i = 0; i < 8; i++) {
      trackFileAccess(`/repo/src/f${i}.ts`, 'x'.repeat(20_000));
    }
    const r = generatePostCompactReinjectMessages([]);
    expect(r.filesInjected).toBeLessThan(8);
    expect(r.pathsListed).toBe(8 - r.filesInjected);
    const mapMsg = r.messages.find((m) => m.name === 'PostCompactFileMap');
    expect(mapMsg).toBeTruthy();
    const t = textOf(mapMsg!);
    expect(t).toContain('readfile');
    /* 全文注入过的不重复出现在地图里 */
    const restored = r.messages.find((m) => m.name === 'PostCompactFileRestore');
    expect(restored).toBeTruthy();
  });

  it('文件不多时全部装进全文, 地图为空', () => {
    trackFileAccess('/repo/src/only.ts', 'tiny');
    const r = generatePostCompactReinjectMessages([]);
    expect(r.filesInjected).toBe(1);
    expect(r.pathsListed).toBe(0);
    expect(r.messages.find((m) => m.name === 'PostCompactFileMap')).toBeUndefined();
  });
});
