/**
 * MessageUtils Tests — 消息内容处理
 *
 * 测试多模态消息解析 (string / content part array / thinking blocks)
 * 不需要 API
 */

import { describe, it, expect } from 'vitest';
import { getTextFromContent, normalizeMessageContent } from '@neoxlabs/kernel/utils/messageUtils.js';

describe('MessageUtils', () => {
    // ========================================================================
    // 1. getTextFromContent
    // ========================================================================
    describe('getTextFromContent', () => {
        it('should extract text from string', () => {
            expect(getTextFromContent('hello world')).toBe('hello world');
        });

        it('should handle null', () => {
            expect(getTextFromContent(null)).toBe('');
        });

        it('should extract text from content parts array', () => {
            const parts = [
                { type: 'text' as const, text: 'hello ' },
                { type: 'text' as const, text: 'world' },
            ];
            expect(getTextFromContent(parts)).toBe('hello world');
        });

        it('should ignore non-text parts', () => {
            const parts = [
                { type: 'thinking' as const, thinking: 'Let me think...' },
                { type: 'text' as const, text: 'answer' },
                { type: 'image_url' as const, image_url: { url: 'data:...' } },
            ] as any;
            expect(getTextFromContent(parts)).toBe('answer');
        });
    });

    // ========================================================================
    // 2. normalizeMessageContent
    // ========================================================================
    describe('normalizeMessageContent', () => {
        it('should pass through string content', () => {
            expect(normalizeMessageContent('hello')).toBe('hello');
        });

        it('should pass through null', () => {
            expect(normalizeMessageContent(null)).toBeNull();
        });

        it('should simplify text-only array to string', () => {
            const parts = [
                { type: 'text' as const, text: 'hello ' },
                { type: 'text' as const, text: 'world' },
            ];
            expect(normalizeMessageContent(parts)).toBe('hello world');
        });

        it('should preserve valid thinking block format', () => {
            const parts = [
                { type: 'thinking' as const, thinking: 'Let me think...' },
                { type: 'text' as const, text: 'answer' },
            ] as any;
            const result = normalizeMessageContent(parts);
            expect(Array.isArray(result)).toBe(true);
        });

        it('should fix invalid thinking block order', () => {
            const parts = [
                { type: 'text' as const, text: 'answer first' },
                { type: 'thinking' as const, thinking: 'thinking after' },
            ] as any;
            const result = normalizeMessageContent(parts);
            // 格式不正确时，应提取纯文本
            expect(typeof result).toBe('string');
            expect(result).toContain('answer first');
        });
    });
});
