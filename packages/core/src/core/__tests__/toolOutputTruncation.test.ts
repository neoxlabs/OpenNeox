/**
 * ToolOutputTruncation Tests — 工具输出截断
 *
 * Codex 风格的中间截断策略
 * 不需要 API
 */

import { describe, it, expect } from 'vitest';
import {
    truncateToolOutput,
    needsTruncation,
    getTruncationStats,
    estimateObjectSize,
    TOOL_OUTPUT_MAX_BYTES,
} from '@neoxlabs/platform/utils/toolOutputTruncation.js';

describe('ToolOutputTruncation', () => {
    // ========================================================================
    // 1. 短内容不截断
    // ========================================================================
    describe('Short content', () => {
        it('should not truncate short content', () => {
            const short = 'hello world';
            expect(truncateToolOutput(short)).toBe(short);
            expect(needsTruncation(short)).toBe(false);
        });

        it('should handle empty/null', () => {
            expect(truncateToolOutput('')).toBe('');
            expect(truncateToolOutput(null as any)).toBeFalsy();
        });
    });

    // ========================================================================
    // 2. 长内容截断
    // ========================================================================
    describe('Long content truncation', () => {
        it('should truncate long content', () => {
            const long = 'x'.repeat(20000);
            const result = truncateToolOutput(long);
            expect(result.length).toBeLessThan(long.length);
            expect(result).toContain('chars truncated');
        });

        it('should preserve beginning and end (40/40 strategy)', () => {
            // 创建有明确头尾标记的文本
            const head = 'HEAD_MARKER_' + 'a'.repeat(7000);
            const mid = 'b'.repeat(10000);
            const tail = 'c'.repeat(7000) + '_TAIL_MARKER';
            const long = head + mid + tail;

            const result = truncateToolOutput(long);
            expect(result).toContain('HEAD_MARKER_');
            expect(result).toContain('_TAIL_MARKER');
        });

        it('should include stats in truncation marker', () => {
            const long = 'line\n'.repeat(5000);
            const result = truncateToolOutput(long);
            expect(result).toContain('truncated');
            expect(result).toContain('lines');
        });
    });

    // ========================================================================
    // 3. 自定义 maxBytes
    // ========================================================================
    describe('Custom maxBytes', () => {
        it('should respect custom limit', () => {
            const content = 'x'.repeat(1000);
            const result = truncateToolOutput(content, 200);
            expect(result.length).toBeLessThan(500);
        });
    });

    // ========================================================================
    // 4. needsTruncation
    // ========================================================================
    describe('needsTruncation', () => {
        it('should return true for long content', () => {
            expect(needsTruncation('x'.repeat(20000))).toBe(true);
        });

        it('should return false for short content', () => {
            expect(needsTruncation('short')).toBe(false);
        });

        it('should support custom threshold', () => {
            expect(needsTruncation('hello', 3)).toBe(true);
            expect(needsTruncation('hi', 3)).toBe(false);
        });
    });

    // ========================================================================
    // 5. getTruncationStats
    // ========================================================================
    describe('getTruncationStats', () => {
        it('should return correct stats', () => {
            const original = 'x'.repeat(20000);
            const truncated = truncateToolOutput(original);
            const stats = getTruncationStats(original, truncated);

            expect(stats.originalSize).toBe(20000);
            expect(stats.truncatedSize).toBeLessThan(20000);
            expect(stats.savedBytes).toBeGreaterThan(0);
            expect(stats.wasTruncated).toBe(true);
            expect(stats.compressionRatio).toBeLessThan(1);
        });

        it('should report no truncation for short content', () => {
            const content = 'short';
            const stats = getTruncationStats(content, content);
            expect(stats.wasTruncated).toBe(false);
            expect(stats.savedBytes).toBe(0);
        });
    });

    // ========================================================================
    // 6. estimateObjectSize
    // ========================================================================
    describe('estimateObjectSize', () => {
        it('should estimate object size', () => {
            const size = estimateObjectSize({ key: 'value', num: 42 });
            expect(size).toBeGreaterThan(0);
        });

        it('should handle circular references gracefully', () => {
            const obj: any = {};
            obj.self = obj;
            expect(estimateObjectSize(obj)).toBe(0);
        });
    });
});
