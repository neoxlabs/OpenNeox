/**
 * ToolClassification Unit Tests — 工具结果分类
 *
 * 测试工具 → 结果类型映射：
 * - EPHEMERAL: 写操作 (write_file, edit_file, git_commit) → 不进入上下文
 * - CONTEXTUAL: 读操作 (readfile, grep, search) → 进入上下文
 * - SUMMARIZED: 执行操作 (bash, execute_shell) → 摘要后进入
 *
 * 没有 API 依赖，纯映射测试
 */

import { describe, it, expect } from 'vitest';
import {
    getToolResultType,
    isWriteTool,
    isReadTool,
    isCommandTool,
} from '@neoxlabs/kernel/core/toolClassification.js';
import { ToolResultType } from '@neoxlabs/kernel/core/types/toolResult.js';

describe('ToolClassification', () => {
    // ========================================================================
    // 1. EPHEMERAL — 写操作
    // ========================================================================
    describe('EPHEMERAL (write tools)', () => {
        const ephemeralTools = [
            'write_file', 'Write',
            'edit_file', 'Edit',
            'delete_file', 'rename_file',
            'git_commit', 'git_add', 'git_push',
            'npm_install',
        ];

        it.each(ephemeralTools)('%s → EPHEMERAL', (tool) => {
            expect(getToolResultType(tool)).toBe(ToolResultType.EPHEMERAL);
            expect(isWriteTool(tool)).toBe(true);
        });
    });

    // ========================================================================
    // 2. CONTEXTUAL — 读操作
    // ========================================================================
    describe('CONTEXTUAL (read tools)', () => {
        const contextualTools = [
            'readfile',
            'search', 'grep', 'Grep', 'glob', 'Glob',
            'search_files', 'list_directory',
            'git_diff', 'git_status', 'git_log',
            'web_search', 'WebSearch',
        ];

        it.each(contextualTools)('%s → CONTEXTUAL', (tool) => {
            expect(getToolResultType(tool)).toBe(ToolResultType.CONTEXTUAL);
            expect(isReadTool(tool)).toBe(true);
        });
    });

    // ========================================================================
    // 3. SUMMARIZED — 执行操作
    // ========================================================================
    describe('SUMMARIZED (command tools)', () => {
        const summarizedTools = [
            'execute_shell', 'bash', 'Bash', 'shell',
            'run_tests', 'run_lint',
            'code_interpreter', 'python_exec',
        ];

        it.each(summarizedTools)('%s → SUMMARIZED', (tool) => {
            expect(getToolResultType(tool)).toBe(ToolResultType.SUMMARIZED);
            expect(isCommandTool(tool)).toBe(true);
        });
    });

    // ========================================================================
    // 4. MCP 工具默认 SUMMARIZED
    // ========================================================================
    describe('MCP tools', () => {
        it('mcp__ prefixed tools → SUMMARIZED', () => {
            expect(getToolResultType('mcp__my_custom_tool')).toBe(ToolResultType.SUMMARIZED);
            expect(getToolResultType('mcp__anything')).toBe(ToolResultType.SUMMARIZED);
        });
    });

    // ========================================================================
    // 5. 未知工具 → 保守策略 CONTEXTUAL
    // ========================================================================
    describe('Unknown tools → fallback', () => {
        it('should default to CONTEXTUAL (conservative)', () => {
            expect(getToolResultType('some_unknown_tool')).toBe(ToolResultType.CONTEXTUAL);
        });
    });

    // ========================================================================
    // 6. 大小写不敏感匹配
    // ========================================================================
    describe('Case insensitive matching', () => {
        it('should match case-insensitively', () => {
            expect(getToolResultType('READFILE')).toBe(ToolResultType.CONTEXTUAL);
            expect(getToolResultType('WRITE_FILE')).toBe(ToolResultType.EPHEMERAL);
        });
    });
});
