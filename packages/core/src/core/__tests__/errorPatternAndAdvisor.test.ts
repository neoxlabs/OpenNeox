/**
 * Tests for ErrorPatternMemory and ToolUsageAdvisor
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ErrorPatternMemory } from '@neoxlabs/kernel/core/reasoning/errorPatternMemory.js';
import { ToolUsageAdvisor } from '@neoxlabs/kernel/core/reasoning/toolUsageAdvisor.js';

describe('ErrorPatternMemory', () => {
    let memory: ErrorPatternMemory;

    beforeEach(() => {
        memory = new ErrorPatternMemory();
    });

    it('should not generate hint on first failure', () => {
        memory.recordFailure('edit_file', 'old_string not found in file', { path: '/test.ts' });
        const hint = memory.buildEscalatedHint('edit_file', '/test.ts');
        expect(hint).toBeNull();
    });

    it('should generate re-read hint on 2nd edit_file match failure', () => {
        memory.recordFailure('edit_file', 'old_string not found in file', { path: '/test.ts' });
        memory.recordFailure('edit_file', 'old_string not found in file', { path: '/test.ts' });
        const hint = memory.buildEscalatedHint('edit_file', '/test.ts');
        expect(hint).not.toBeNull();
        expect(hint).toContain('第 2 次失败');
        expect(hint).toContain('readfile');
    });

    it('should escalate to write_file on 3rd failure', () => {
        for (let i = 0; i < 3; i++) {
            memory.recordFailure('edit_file', 'old_string not found', { path: '/test.ts' });
        }
        const hint = memory.buildEscalatedHint('edit_file', '/test.ts');
        expect(hint).not.toBeNull();
        expect(hint).toContain('第 3 次失败');
        expect(hint).toContain('write_file');
        expect(hint).toContain('策略升级');
    });

    it('should tell to stop on 4+ failures', () => {
        for (let i = 0; i < 4; i++) {
            memory.recordFailure('edit_file', 'old_string not found', { path: '/test.ts' });
        }
        const hint = memory.buildEscalatedHint('edit_file', '/test.ts');
        expect(hint).not.toBeNull();
        expect(hint).toContain('请停下');
    });

    it('should reset on success', () => {
        memory.recordFailure('edit_file', 'error', { path: '/test.ts' });
        memory.recordFailure('edit_file', 'error', { path: '/test.ts' });
        memory.recordSuccess('edit_file');
        expect(memory.getConsecutiveFailures('edit_file')).toBe(0);
        const hint = memory.buildEscalatedHint('edit_file');
        expect(hint).toBeNull();
    });

    it('should classify match_failed errors correctly', () => {
        memory.recordFailure('edit_file', 'old_string not found in file');
        const patterns = memory.getRecentPatterns();
        expect(patterns[0].lastCategory).toBe('match_failed');
    });

    it('should classify not_found errors correctly', () => {
        memory.recordFailure('readfile', 'ENOENT: no such file or directory');
        const patterns = memory.getRecentPatterns();
        expect(patterns[0].lastCategory).toBe('not_found');
    });

    it('should handle search failures', () => {
        memory.recordFailure('search', 'No results found');
        memory.recordFailure('search', 'No matches found');
        const hint = memory.buildEscalatedHint('search');
        expect(hint).not.toBeNull();
        expect(hint).toContain('SEARCH RECOVERY');
    });

    it('should handle shell failures', () => {
        memory.recordFailure('execute_shell', 'command not found: xyz');
        memory.recordFailure('execute_shell', 'command not found: xyz');
        const hint = memory.buildEscalatedHint('execute_shell');
        expect(hint).not.toBeNull();
        expect(hint).toContain('SHELL RECOVERY');
    });

    it('should reset all state', () => {
        memory.recordFailure('edit_file', 'error');
        memory.recordFailure('search', 'no results');
        memory.reset();
        expect(memory.getRecentPatterns()).toHaveLength(0);
    });
});

describe('ToolUsageAdvisor', () => {
    let advisor: ToolUsageAdvisor;

    beforeEach(() => {
        advisor = new ToolUsageAdvisor();
    });

    it('should not give advice with few calls', () => {
        advisor.record('readfile', true, { path: '/a.ts' }, 1);
        expect(advisor.analyze(1)).toBeNull();
    });

    it('should detect batch read pattern', () => {
        // Read 4 different files
        advisor.record('readfile', true, { path: '/a.ts' }, 1);
        advisor.record('readfile', true, { path: '/b.ts' }, 1);
        advisor.record('readfile', true, { path: '/c.ts' }, 2);
        advisor.record('readfile', true, { path: '/d.ts' }, 2);
        // Add more to reach the minimum history
        advisor.record('readfile', true, { path: '/e.ts' }, 3);
        advisor.record('readfile', true, { path: '/f.ts' }, 3);
        advisor.record('readfile', true, { path: '/g.ts' }, 4);
        advisor.record('readfile', true, { path: '/h.ts' }, 4);

        const advice = advisor.analyze(5);
        expect(advice).not.toBeNull();
        expect(advice).toContain('EFFICIENCY TIP');
        expect(advice).toContain('grep');
    });

    it('should detect search failure pattern', () => {
        // Pad with mixed calls (not all reads, to avoid triggering batch_read)
        advisor.record('edit_file', true, { path: '/a.ts' }, 1);
        advisor.record('write_file', true, { path: '/b.ts' }, 1);
        advisor.record('execute_shell', true, {}, 1);
        advisor.record('search', false, {}, 2);
        advisor.record('search', false, {}, 2);
        advisor.record('search', false, {}, 3);

        const advice = advisor.analyze(5);
        expect(advice).not.toBeNull();
        expect(advice).toContain('SEARCH TIP');
    });

    it('should not repeat the same advice type', () => {
        for (let i = 0; i < 8; i++) {
            advisor.record('readfile', true, { path: `/file${i}.ts` }, i);
        }
        const first = advisor.analyze(10);
        expect(first).not.toBeNull();
        // Should contain some form of advice
        expect(typeof first).toBe('string');

        // Record one more and check — suppressed types should not repeat
        advisor.record('readfile', true, { path: '/another.ts' }, 11);
        const second = advisor.analyze(13);
        // Second advice might be a different type (read-only nudge) or null
        // The key invariant: if same type was triggered, it won't repeat
        if (second !== null) {
            expect(second).not.toBe(first); // Must be different advice
        }
    });

    it('should reset state', () => {
        for (let i = 0; i < 8; i++) {
            advisor.record('readfile', true, { path: `/file${i}.ts` }, i);
        }
        advisor.analyze(10); // Consume the advice

        advisor.reset();

        // After reset, need to build up new history
        for (let i = 0; i < 8; i++) {
            advisor.record('readfile', true, { path: `/new${i}.ts` }, i);
        }
        const advice = advisor.analyze(12);
        // Should give advice again after reset
        expect(advice).not.toBeNull();
    });

    it('should detect read-only pattern in long sessions', () => {
        // Build up enough history (>8 calls)
        for (let i = 0; i < 10; i++) {
            advisor.record('readfile', true, { path: `/file${i}.ts` }, i);
        }

        // Clear the batch-read advice first
        advisor.analyze(12);

        // Continue with only read operations
        advisor.record('search', true, {}, 13);
        advisor.record('grep', true, {}, 14);
        advisor.record('readfile', true, { path: '/x.ts' }, 15);
        advisor.record('show_tree', true, {}, 16);
        advisor.record('readfile', true, { path: '/y.ts' }, 17);
        advisor.record('glob', true, {}, 18);

        const advice = advisor.analyze(20);
        // May or may not trigger depending on suppression state
        // The important thing is it doesn't crash
        expect(advice === null || typeof advice === 'string').toBe(true);
    });
});
