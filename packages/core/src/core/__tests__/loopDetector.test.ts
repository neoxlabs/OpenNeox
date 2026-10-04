/**
 * LoopDetector Unit Tests — 工具循环检测
 *
 * detect() 规则 (基于 history 中 same hash count):
 *   >= 4: HARD (gate 层终止；LoopDetector 只生成干预文本)
 *   >= 3: MEDIUM
 *   >= 2: SOFT
 *   < 2:  NONE
 *
 * didSwitchTool() 规则:
 *   history.length < 2: 返回 true (无法判断，默认假设切换了)
 *   否则: lastTool !== currentTool
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LoopDetector, LoopLevel, createLoopDetector, buildOutputSignature } from '@neoxlabs/kernel/core/loopDetector.js';

describe('LoopDetector', () => {
    let detector: LoopDetector;

    beforeEach(() => {
        detector = createLoopDetector();
    });

    // ========================================================================
    // 1. 基础检测
    // ========================================================================
    describe('Basic detection', () => {
        it('should return NONE for first call (no history)', () => {
            const level = detector.detect('readfile', { file_path: '/test.ts' });
            expect(level).toBe(LoopLevel.NONE);
        });

        it('should return NONE for different args', () => {
            detector.record('readfile', { file_path: '/a.ts' });
            const level = detector.detect('readfile', { file_path: '/b.ts' });
            expect(level).toBe(LoopLevel.NONE);
        });

        it('should return NONE after only 1 record (need >= 2 for SOFT)', () => {
            const args = { file_path: '/test.ts' };
            detector.record('readfile', args);
            const level = detector.detect('readfile', args);
            // recentSame.length = 1, < 2 → NONE
            expect(level).toBe(LoopLevel.NONE);
        });
    });

    // ========================================================================
    // 2. 循环级别升级
    // ========================================================================
    describe('Loop level escalation', () => {
        it('should escalate: 2 records → SOFT, 3 → MEDIUM, 4 → HARD', () => {
            const args = { file_path: '/test.ts', old_string: 'foo', new_string: 'bar' };

            // record 2 次后 detect → SOFT
            detector.record('edit_file', args);
            detector.record('edit_file', args);
            expect(detector.detect('edit_file', args)).toBe(LoopLevel.SOFT);

            // record 3 次后 → MEDIUM
            detector.record('edit_file', args);
            expect(detector.detect('edit_file', args)).toBe(LoopLevel.MEDIUM);

            // record 4 次后 → HARD
            detector.record('edit_file', args);
            expect(detector.detect('edit_file', args)).toBe(LoopLevel.HARD);
        });
    });

    // ========================================================================
    // 3. 参数哈希策略
    // ========================================================================
    describe('Hash strategy per tool', () => {
        it('readfile: different offset = different operation', () => {
            detector.record('readfile', { file_path: '/test.ts', offset: 0 });
            detector.record('readfile', { file_path: '/test.ts', offset: 0 });
            // 相同 args 重复 2 次 → SOFT
            const level = detector.detect('readfile', { file_path: '/test.ts', offset: 100 });
            // 不同 offset → 不同 hash → NONE
            expect(level).toBe(LoopLevel.NONE);
        });

        it('readfile: reset duplicate count after edit on same file', () => {
            const args = { file_path: '/test.ts' };
            detector.record('readfile', args);
            detector.record('readfile', args);
            expect(detector.detect('readfile', args)).toBe(LoopLevel.SOFT);

            detector.record('edit_file', { file_path: '/test.ts', start_line: 1, end_line: 1, new_string: 'x' });
            expect(detector.detect('readfile', args)).toBe(LoopLevel.NONE);
        });

        it('write_file: 同路径不同内容 = 正当迭代, 不算循环 (2026-09-01 实拍: 探针脚本连写 4 版被拦)', () => {
            detector.record('write_file', { file_path: '/test.ts', content: 'v1' });
            detector.record('write_file', { file_path: '/test.ts', content: 'v2' });
            detector.record('write_file', { file_path: '/test.ts', content: 'v3' });
            const level = detector.detect('write_file', { file_path: '/test.ts', content: 'v4' });
            expect(level).toBe(LoopLevel.NONE);
        });

        it('write_file: 同路径同内容才是循环', () => {
            detector.record('write_file', { file_path: '/test.ts', content: 'same' });
            detector.record('write_file', { file_path: '/test.ts', content: 'same' });
            const level = detector.detect('write_file', { file_path: '/test.ts', content: 'same' });
            expect(level).toBe(LoopLevel.SOFT);
        });

        it('write_file: 同内容不同 mode (overwrite/append) 不同哈希', () => {
            detector.record('write_file', { file_path: '/test.ts', content: 'seg', mode: 'append' });
            detector.record('write_file', { file_path: '/test.ts', content: 'seg', mode: 'append' });
            expect(detector.detect('write_file', { file_path: '/test.ts', content: 'seg', mode: 'overwrite' })).toBe(LoopLevel.NONE);
        });

        it('edit_file (内容寻址): 换 old_string/new_string/start_line 都改哈希, 不算循环', () => {
            const base = {
                file_path: '/app.js',
                old_string: 'const a = 1;',
                new_string: 'const a = 2;',
            };
            detector.record('edit_file', base);
            detector.record('edit_file', base);

            // 改不同的原文 (old_string) = 改另一处, 不是循环。
            expect(detector.detect('edit_file', { ...base, old_string: 'const b = 3;', new_string: 'const b = 4;' }))
                .toBe(LoopLevel.NONE);
            // 改成不同的目标 (new_string) = 不同编辑, 不是循环。
            expect(detector.detect('edit_file', { ...base, new_string: 'const a = 99;' }))
                .toBe(LoopLevel.NONE);
            // 行号桥接路径: 同 old/new 但不同 start_line = 指向不同位置, 不是循环。
            expect(detector.detect('edit_file', { ...base, start_line: 20 }))
                .toBe(LoopLevel.NONE);
        });

        it('edit_file (内容寻址): 同 file+old+new 重复才算循环', () => {
            const same = {
                file_path: '/app.js',
                old_string: 'const a = 1;',
                new_string: 'const a = 2;',
            };
            detector.record('edit_file', same);
            detector.record('edit_file', same);
            // expected_hash 已下线: 即便带上也不进哈希, 同 old/new 仍判重复。
            expect(detector.detect('edit_file', { ...same, expected_hash: 'sha256:whatever' }))
                .toBe(LoopLevel.SOFT);
        });
    });

    // ========================================================================
    // 4. 干预消息
    // ========================================================================
    describe('Intervention generation', () => {
        it('SOFT → guidance (not terminate)', () => {
            const intervention = detector.generateIntervention(
                LoopLevel.SOFT, 'edit_file', { file_path: '/test.ts' },
            );
            expect(intervention.shouldTerminate).toBe(false);
            expect(intervention.message).toBeTruthy();
        });

        it('HARD → warning text (gate terminates)', () => {
            const intervention = detector.generateIntervention(
                LoopLevel.HARD, 'edit_file', { file_path: '/test.ts' },
            );
            expect(intervention.shouldTerminate).toBe(false);
            expect(intervention.message).toContain('[LOOP WARNING - HARD]');
        });
    });

    // ========================================================================
    // 5. 工具切换检测
    // ========================================================================
    describe('Tool switching detection', () => {
        it('should detect tool switch (different tool)', () => {
            detector.record('edit_file', { file_path: '/a.ts' });
            detector.record('readfile', { file_path: '/a.ts' });
            // lastTool = 'readfile', currentTool = 'edit_file' → switched
            expect(detector.didSwitchTool('edit_file')).toBe(true);
        });

        it('should detect no switch (same tool)', () => {
            detector.record('edit_file', { file_path: '/a.ts' });
            detector.record('edit_file', { file_path: '/b.ts' });
            // lastTool = 'edit_file', currentTool = 'edit_file' → not switched
            expect(detector.didSwitchTool('edit_file')).toBe(false);
        });

        it('should return true when history < 2 (cannot determine)', () => {
            detector.record('edit_file', { file_path: '/test.ts' });
            // history.length = 1 < 2 → default true
            expect(detector.didSwitchTool('edit_file')).toBe(true);
        });
    });

    // ========================================================================
    // 6. 状态管理
    // ========================================================================
    describe('State management', () => {
        it('should track call count', () => {
            const args = { file_path: '/test.ts' };
            detector.record('write_file', args);
            detector.record('write_file', args);
            detector.record('write_file', args);
            expect(detector.getCallCount('write_file', args)).toBe(3);
        });

        it('should reset all state', () => {
            detector.record('edit_file', { file_path: '/test.ts' });
            detector.record('edit_file', { file_path: '/test.ts' });
            detector.reset();

            expect(detector.detect('edit_file', { file_path: '/test.ts' })).toBe(LoopLevel.NONE);
            expect(detector.getHistory()).toEqual([]);
        });

        it('should update last status', () => {
            detector.record('edit_file', { file_path: '/test.ts' });
            detector.updateLastStatus('error');
            expect(detector.wasLastSuccessful('edit_file', { file_path: '/test.ts' })).toBe(false);
        });

        it('should get recent duplicates', () => {
            detector.record('edit_file', { file_path: '/a.ts' });
            detector.record('edit_file', { file_path: '/a.ts' });
            detector.record('write_file', { file_path: '/b.ts' });
            const dupes = detector.getRecentDuplicates();
            expect(dupes.size).toBeGreaterThan(0);
        });
    });

    // ========================================================================
    // 7. 验证/替代建议
    // ========================================================================
    describe('Suggestions', () => {
        it('should suggest verify command', () => {
            expect(detector.getVerifyCommand('edit_file', '/test.ts')).toBeTruthy();
        });

        it('should suggest alternative action', () => {
            expect(detector.getAlternativeAction('edit_file', '/test.ts')).toBeTruthy();
        });

        it('should give shell-specific alternative action', () => {
            const advice = detector.getAlternativeAction('execute_shell');
            expect(advice).toMatch(/stderr|exit code|root cause|different/i);
            expect(advice).not.toBe('Review the output from previous calls before retrying');
        });
    });

    // ========================================================================
    // 8. Shell-specific hash strategy
    // ========================================================================
    describe('Shell hash strategy', () => {
        it('hashes by command only - background/timeout variations do not split', () => {
            const a = { command: 'npm test', background: false };
            const b = { command: 'npm test', background: true, timeout: 5000 };
            // 3 次相同 command、不同 background/timeout,应同 hash 累积
            detector.record('execute_shell', a);
            detector.record('execute_shell', b);
            detector.record('execute_shell', a);
            // recentSame = 3 → shell SOFT
            expect(detector.detect('execute_shell', a)).toBe(LoopLevel.SOFT);
        });

        it('different commands do not collide', () => {
            // 用户报的 bug 复现:两条真正不同的命令不应被判成循环
            detector.record('execute_shell', { command: 'npm run check' });
            detector.record('execute_shell', { command: 'npm run check' });
            detector.record('execute_shell', { command: 'npm run check' });
            expect(detector.detect('execute_shell', { command: 'cd src-tauri && cargo check' }))
                .toBe(LoopLevel.NONE);
        });

        it('accepts cmd/script aliases', () => {
            detector.record('execute_shell', { cmd: 'ls' });
            detector.record('execute_shell', { cmd: 'ls' });
            detector.record('execute_shell', { cmd: 'ls' });
            expect(detector.detect('execute_shell', { cmd: 'ls' })).toBe(LoopLevel.SOFT);
        });
    });

    // ========================================================================
    // 9. Shell thresholds - 独立的、更宽松的阈值
    // ========================================================================
    describe('Shell thresholds (relaxed)', () => {
        it('<3 records = NONE (below SOFT threshold)', () => {
            const args = { command: 'npm test' };
            detector.record('execute_shell', args);
            expect(detector.detect('execute_shell', args)).toBe(LoopLevel.NONE);
            detector.record('execute_shell', args);
            expect(detector.detect('execute_shell', args)).toBe(LoopLevel.NONE);
        });

        it('3 records = SOFT, 4 = MEDIUM, 5 = HARD', () => {
            const args = { command: 'npm test' };
            detector.record('execute_shell', args);
            detector.record('execute_shell', args);
            detector.record('execute_shell', args);
            expect(detector.detect('execute_shell', args)).toBe(LoopLevel.SOFT);
            detector.record('execute_shell', args);
            expect(detector.detect('execute_shell', args)).toBe(LoopLevel.MEDIUM);
            detector.record('execute_shell', args);
            expect(detector.detect('execute_shell', args)).toBe(LoopLevel.HARD);
        });

        it('non-shell tools still use original thresholds (2=SOFT)', () => {
            const args = { file_path: '/a.ts' };
            detector.record('write_file', args);
            detector.record('write_file', args);
            // write_file: recentSame=2 → SOFT (shell 分支不影响)
            expect(detector.detect('write_file', args)).toBe(LoopLevel.SOFT);
        });
    });

    // ========================================================================
    // ========================================================================
    describe('Time window', () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it('excludes records older than 60s window', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
            const args = { command: 'npm test' };
            detector.record('execute_shell', args);
            detector.record('execute_shell', args);
            detector.record('execute_shell', args);
            // t0:累积 3 条,已达 SOFT
            expect(detector.detect('execute_shell', args)).toBe(LoopLevel.SOFT);

            // 时间前进 120s,3 条全部过期
            vi.setSystemTime(new Date('2025-01-01T00:02:00Z'));
            expect(detector.detect('execute_shell', args)).toBe(LoopLevel.NONE);
        });

        it('partially includes records within window', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
            const args = { command: 'npm test' };
            detector.record('execute_shell', args); // t=0
            detector.record('execute_shell', args); // t=0
            // 90s 后,前两条过期
            vi.setSystemTime(new Date('2025-01-01T00:01:30Z'));
            detector.record('execute_shell', args); // t=90
            // 只有最后一条在窗口内 → NONE
            expect(detector.detect('execute_shell', args)).toBe(LoopLevel.NONE);
        });
    });

    // ========================================================================
    // 11. Result divergence - shell 输出每次不同时豁免
    // ========================================================================
    describe('Result divergence exemption (shell)', () => {
        it('bypasses shell SOFT when output signatures differ', () => {
            const args = { command: 'npm test' };
            // 3 次同命令,但 stderr 每次不同(LLM 在追 bug)
            detector.record('execute_shell', args, 'error', 'sigA');
            detector.record('execute_shell', args, 'error', 'sigB');
            detector.record('execute_shell', args, 'error', 'sigC');
            expect(detector.detect('execute_shell', args)).toBe(LoopLevel.NONE);
        });

        it('still triggers SOFT when output is identical', () => {
            const args = { command: 'npm test' };
            detector.record('execute_shell', args, 'error', 'sigSame');
            detector.record('execute_shell', args, 'error', 'sigSame');
            detector.record('execute_shell', args, 'error', 'sigSame');
            expect(detector.detect('execute_shell', args)).toBe(LoopLevel.SOFT);
        });

        it('divergence does not apply when signatures are missing', () => {
            const args = { command: 'npm test' };
            detector.record('execute_shell', args); // 无 signature
            detector.record('execute_shell', args);
            detector.record('execute_shell', args);
            // 无签名 → 无法判定差异 → 走阈值 → SOFT
            expect(detector.detect('execute_shell', args)).toBe(LoopLevel.SOFT);
        });

        it('divergence exemption does not leak to non-shell tools', () => {
            const args = { file_path: '/a.ts' };
            detector.record('write_file', args, 'error', 'sigA');
            detector.record('write_file', args, 'error', 'sigB');
            // write_file 不走差异豁免分支 → recentSame=2 → SOFT
            expect(detector.detect('write_file', args)).toBe(LoopLevel.SOFT);
        });
    });

    // ========================================================================
    // 12.5 Defensive clone — args mutation 不污染历史
    // ========================================================================
    describe('Defensive args clone', () => {
        it('mutating args after record does not corrupt stored record', () => {
            const args: Record<string, any> = { file_path: '/a.ts' };
            detector.record('readfile', args);

            // 外部污染原 args
            args.file_path = '/b.ts';
            args.smuggled = 'evil';

            const snapshot = detector.getHistory();
            expect(snapshot.length).toBe(1);
            expect(snapshot[0].args?.file_path).toBe('/a.ts');
            expect(snapshot[0].args?.smuggled).toBeUndefined();
        });

        it('getHistorySnapshot returns frozen records', () => {
            const args = { file_path: '/a.ts' };
            detector.record('readfile', args);

            const snap = detector.getHistorySnapshot();
            expect(snap.length).toBe(1);
            expect(Object.isFrozen(snap)).toBe(true);
            expect(Object.isFrozen(snap[0])).toBe(true);
            if (snap[0].args) {
                expect(Object.isFrozen(snap[0].args)).toBe(true);
            }
        });
    });

    // ========================================================================
    // 13. Intervention message wording - similar → identical
    // ========================================================================
    describe('Intervention wording', () => {
        it('SOFT uses "identical arguments" (not "similar")', () => {
            const intervention = detector.generateIntervention(
                LoopLevel.SOFT,
                'execute_shell',
                { command: 'npm test' },
            );
            expect(intervention.message).toContain('identical');
            expect(intervention.message).not.toContain('similar arguments');
        });
    });
});

// ========================================================================
// buildOutputSignature helper
// ========================================================================
describe('buildOutputSignature', () => {
    it('returns undefined for empty/null/undefined input', () => {
        expect(buildOutputSignature('')).toBeUndefined();
        expect(buildOutputSignature(undefined)).toBeUndefined();
        expect(buildOutputSignature(null)).toBeUndefined();
    });

    it('returns stable hash for same input', () => {
        expect(buildOutputSignature('hello')).toEqual(buildOutputSignature('hello'));
    });

    it('yields different signatures for different inputs', () => {
        expect(buildOutputSignature('error A')).not.toEqual(buildOutputSignature('error B'));
    });

    it('samples only the tail of long outputs', () => {
        // 前缀相同、尾部不同 → 签名不同
        const prefix = 'x'.repeat(5000);
        expect(buildOutputSignature(prefix + 'tail-A')).not.toEqual(
            buildOutputSignature(prefix + 'tail-B'),
        );
        // 前缀不同、尾部相同(且 > OUTPUT_SIGNATURE_TAIL=400) → 签名相同
        const tail = 'y'.repeat(500);
        expect(buildOutputSignature('prefA' + tail)).toEqual(
            buildOutputSignature('prefB' + tail),
        );
    });
});

describe('变更豁免: 改完再看不算循环 (2026-07-25 真实场景)', () => {
    it('create_slides 重新生成后, open_surface 同路径预览不判 HARD', () => {
        const d = createLoopDetector();
        const surfaceArgs = { kind: 'pptx', source: { type: 'file', path: '/w/deck.pptx' } };
        /* 生成 → 预览 → 发现问题 → 重新生成 → 预览 …… 循环 4 轮 */
        for (let i = 0; i < 4; i++) {
            d.record('create_slides', { outputPath: '/w/deck.pptx' });
            d.record('open_surface', surfaceArgs);
        }
        /* 每次预览前文件都变过 ⇒ 不该升到 HARD */
        expect(d.detect('open_surface', surfaceArgs)).not.toBe(LoopLevel.HARD);
    });

    it('文件没变时, 重复 open_surface 仍然要判循环 (豁免不能变成免死金牌)', () => {
        const d = createLoopDetector();
        const surfaceArgs = { kind: 'pptx', source: { type: 'file', path: '/w/deck.pptx' } };
        for (let i = 0; i < 4; i++) d.record('open_surface', surfaceArgs);
        expect(d.detect('open_surface', surfaceArgs)).toBe(LoopLevel.HARD);
    });

    it('word 工具链同理: 改段落后再读不算循环', () => {
        const d = createLoopDetector();
        const readArgs = { path: '/w/report.docx' };
        for (let i = 0; i < 4; i++) {
            d.record('word_edit_paragraph', { path: '/w/report.docx', index: i });
            d.record('word_get_paragraphs', readArgs);
        }
        expect(d.detect('word_get_paragraphs', readArgs)).not.toBe(LoopLevel.HARD);
    });

    it('extractPath 认得嵌套 source.path 和 outputPath', () => {
        const d = createLoopDetector();
        /* 若 extractPath 取不到路径, 变更豁免会静默失效 —— 用行为反推它取到了 */
        const surfaceArgs = { source: { type: 'file', path: '/w/a.pptx' } };
        for (let i = 0; i < 4; i++) {
            d.record('create_slides', { outputPath: '/w/a.pptx' });
            d.record('open_surface', surfaceArgs);
        }
        expect(d.detect('open_surface', surfaceArgs)).not.toBe(LoopLevel.HARD);
        /* 改的是**别的**文件时, 豁免不该生效 */
        const d2 = createLoopDetector();
        const other = { source: { type: 'file', path: '/w/b.pptx' } };
        for (let i = 0; i < 4; i++) {
            d2.record('create_slides', { outputPath: '/w/UNRELATED.pptx' });
            d2.record('open_surface', other);
        }
        expect(d2.detect('open_surface', other)).toBe(LoopLevel.HARD);
    });
});
