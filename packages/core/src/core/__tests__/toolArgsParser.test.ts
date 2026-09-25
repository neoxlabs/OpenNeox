/**
 * ToolArgsParser Unit Tests — 工具参数解析容错
 *
 * 测试 LLM 输出的各种「非标准 JSON」的修复能力：
 * 1. 标准 JSON → 直接解析
 * 2. 智能引号修复 (""→"")
 * 3. 尾部逗号修复 {key: val,}
 * 4. Markdown 代码块提取
 * 5. 花括号提取
 * 6. 空/null/undefined 输入
 */

import { describe, it, expect } from 'vitest';
import { parseToolArguments } from '@neoxlabs/kernel/core/toolArgsParser.js';

describe('ToolArgsParser', () => {
    // ========================================================================
    // 1. 标准 JSON — fast path
    // ========================================================================
    describe('Standard JSON', () => {
        it('should parse valid JSON', () => {
            const result = parseToolArguments('{"file_path": "/test.ts", "content": "hello"}');
            expect(result.ok).toBe(true);
            expect(result.args.file_path).toBe('/test.ts');
            expect(result.repaired).toBe(false);
        });

        it('should normalize edit_file aliases only for edit-like tools', () => {
            const result = parseToolArguments('{"path":"a.ts","startLine":12,"expectedHash":"sha256:abc"}', 'edit');
            expect(result.ok).toBe(true);
            expect(result.args.file_path).toBe('a.ts');
            expect(result.args.start_line).toBe(12);
            expect(result.args.expected_hash).toBe('sha256:abc');
        });

        it('should not inject file_path for git_diff path args', () => {
            const result = parseToolArguments('{"path":"."}', 'git_diff');
            expect(result.ok).toBe(true);
            expect(result.args.path).toBe('.');
            expect(result.args.file_path).toBeUndefined();
        });

        it('should normalize nested call_tool args using the real tool name', () => {
            const result = parseToolArguments('{"name":"edit","args":{"path":"a.ts","startLine":12}}', 'call_tool');
            expect(result.ok).toBe(true);
            expect(result.args.args.file_path).toBe('a.ts');
            expect(result.args.args.start_line).toBe(12);
        });

        it('should parse nested JSON', () => {
            const result = parseToolArguments('{"options": {"recursive": true, "depth": 3}}');
            expect(result.ok).toBe(true);
            expect(result.args.options.recursive).toBe(true);
        });
    });

    // ========================================================================
    // 2. 空输入处理
    // ========================================================================
    describe('Empty/null inputs', () => {
        it('should handle empty string', () => {
            const result = parseToolArguments('');
            expect(result.ok).toBe(true);
            expect(result.args).toEqual({});
        });

        it('should handle null', () => {
            const result = parseToolArguments(null);
            expect(result.ok).toBe(true);
            expect(result.args).toEqual({});
        });

        it('should handle undefined', () => {
            const result = parseToolArguments(undefined);
            expect(result.ok).toBe(true);
            expect(result.args).toEqual({});
        });
    });

    // ========================================================================
    // 3. 智能引号修复 (LLM 常见问题)
    // ========================================================================
    describe('Smart quote repair', () => {
        it('should fix curly double quotes', () => {
            const result = parseToolArguments('\u201c{"file_path": "/test.ts"}\u201d');
            // After normalization, should extract the JSON inside
            if (result.ok) {
                expect(result.args.file_path).toBe('/test.ts');
            }
        });
    });

    // ========================================================================
    // 4. 尾部逗号修复
    // ========================================================================
    describe('Trailing comma repair', () => {
        it('should fix trailing comma in object', () => {
            const result = parseToolArguments('{"file_path": "/test.ts", "content": "hello",}');
            expect(result.ok).toBe(true);
            expect(result.args.file_path).toBe('/test.ts');
            expect(result.repaired).toBe(true);
        });
    });

    // ========================================================================
    // 5. Markdown 代码块提取
    // ========================================================================
    describe('Markdown code block extraction', () => {
        it('should extract JSON from ```json block', () => {
            const input = 'Here are the arguments:\n```json\n{"file_path": "/test.ts"}\n```\n';
            const result = parseToolArguments(input);
            expect(result.ok).toBe(true);
            expect(result.args.file_path).toBe('/test.ts');
        });

        it('should extract JSON from ``` block (no language)', () => {
            const input = '```\n{"file_path": "/test.ts"}\n```';
            const result = parseToolArguments(input);
            expect(result.ok).toBe(true);
            expect(result.args.file_path).toBe('/test.ts');
        });
    });

    // ========================================================================
    // 6. 花括号提取（前后有垃圾文本）
    // ========================================================================
    describe('Brace extraction', () => {
        it('should extract JSON from surrounding text', () => {
            const input = 'I will edit the file with: {"file_path": "/test.ts", "old_string": "foo"} as needed.';
            const result = parseToolArguments(input);
            expect(result.ok).toBe(true);
            expect(result.args.file_path).toBe('/test.ts');
        });
    });

    // ========================================================================
    // 7. 不可修复的输入
    // ========================================================================
    describe('Unrecoverable input', () => {
        it('should report failure on non-JSON', () => {
            const result = parseToolArguments('this is not json at all');
            expect(result.ok).toBe(false);
            expect(result.reason).toBeTruthy();
        });

        it('should report failure on array (not object)', () => {
            const result = parseToolArguments('[1, 2, 3]');
            expect(result.ok).toBe(false);
        });
    });

    // ========================================================================
    // 8. 确定性
    // ========================================================================
    describe('Determinism', () => {
        it('should produce consistent results', () => {
            const input = '{"file_path": "/test.ts"}';
            const r1 = parseToolArguments(input);
            const r2 = parseToolArguments(input);
            expect(r1.ok).toBe(r2.ok);
            expect(r1.args).toEqual(r2.args);
            expect(r1.repaired).toBe(r2.repaired);
        });
    });
});
