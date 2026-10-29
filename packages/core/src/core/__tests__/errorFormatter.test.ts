/**
 * ErrorFormatter Tests — 错误格式化
 *
 * 只测试 exported 的函数
 * 不需要 API
 */

import { describe, it, expect } from 'vitest';
import {
    isHTMLContent,
    formatErrorForUI,
    formatErrorForLog,
    getErrorSuggestion,
} from '@neoxlabs/kernel/utils/errorFormatter.js';

describe('ErrorFormatter', () => {
    // ========================================================================
    // 1. HTML 检测
    // ========================================================================
    describe('isHTMLContent', () => {
        it('should detect HTML', () => {
            expect(isHTMLContent('<html><body>error</body></html>')).toBe(true);
            expect(isHTMLContent('<!DOCTYPE html>')).toBe(true);
        });

        it('should reject non-HTML', () => {
            expect(isHTMLContent('{"error": "bad request"}')).toBe(false);
            expect(isHTMLContent('plain text error')).toBe(false);
        });
    });

    // ========================================================================
    // 2. formatErrorForUI
    // ========================================================================
    describe('formatErrorForUI', () => {
        it('should format simple error', () => {
            const result = formatErrorForUI('Connection refused', 500);
            expect(result.code).toBeTruthy();
            expect(result.message).toBeTruthy();
        });

        it('should handle HTML error page', () => {
            const html = '<html><head><title>429 Too Many Requests</title></head><body>Rate limited</body></html>';
            const result = formatErrorForUI(html, 429);
            expect(result.code).toBeTruthy();
        });

        it('should handle JSON error', () => {
            const json = '{"error": {"message": "Rate limit exceeded", "code": "rate_limit"}}';
            const result = formatErrorForUI(json, 429);
            expect(result.message).toBeTruthy();
        });

        it('should handle status code only', () => {
            const result = formatErrorForUI('unknown', 401);
            expect(result.code).toBeTruthy();
        });
    });

    // ========================================================================
    // 3. formatErrorForLog
    // ========================================================================
    describe('formatErrorForLog', () => {
        it('should format Error object', () => {
            const result = formatErrorForLog(new Error('test error'));
            expect(result).toContain('test error');
        });

        it('should format string error', () => {
            const result = formatErrorForLog('string error');
            expect(result).toContain('string error');
        });

        it('should handle null/undefined', () => {
            expect(formatErrorForLog(null)).toBeTruthy();
            expect(formatErrorForLog(undefined)).toBeTruthy();
        });
    });

    // ========================================================================
    // 4. 错误建议
    // ========================================================================
    describe('getErrorSuggestion', () => {
        it('401 → API key suggestion', () => {
            const suggestion = getErrorSuggestion('401');
            expect(suggestion.length).toBeGreaterThan(0);
        });

        it('429 → rate limit suggestion', () => {
            const suggestion = getErrorSuggestion('429');
            expect(suggestion.length).toBeGreaterThan(0);
        });

        it('500 → server error suggestion', () => {
            const suggestion = getErrorSuggestion('500');
            expect(suggestion.length).toBeGreaterThan(0);
        });

        it('unknown code → generic suggestion', () => {
            const suggestion = getErrorSuggestion('unknown');
            expect(typeof suggestion).toBe('string');
        });
    });
});
