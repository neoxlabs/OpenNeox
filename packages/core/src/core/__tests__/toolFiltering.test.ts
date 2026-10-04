/**
 * ToolFiltering Unit Tests — 工具权限过滤
 *
 * 测试不同模式下的工具可用性：
 * - AGENT: 全部可用
 * - ASK: 只读工具
 * - AUTO: 全部可用
 *
 * 不需要 API — 纯过滤规则测试
 */

import { describe, it, expect } from 'vitest';
import {
    isReadOnlyTool,
    filterToolsByMode,
    getModeSystemPrompt,
    isToolAllowedInMode,
} from '../toolFiltering.js';
import { AgentMode, ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';

// ─── 测试用 mock 工具 ─── //
function mockTool(name: string, overrides?: Partial<Tool>): Tool {
    return { name, ...overrides } as Tool;
}

describe('ToolFiltering', () => {
    // ========================================================================
    // 1. 只读工具判断
    // ========================================================================
    describe('isReadOnlyTool', () => {
        it('read tools → true', () => {
            expect(isReadOnlyTool('readfile')).toBe(true);
            expect(isReadOnlyTool('grep')).toBe(true);
            expect(isReadOnlyTool('search_files')).toBe(true);
            expect(isReadOnlyTool('list_directory')).toBe(true);
            expect(isReadOnlyTool('show_tree')).toBe(true);
        });

        it('write tools → false', () => {
            expect(isReadOnlyTool('write_file')).toBe(false);
            expect(isReadOnlyTool('edit_file')).toBe(false);
            expect(isReadOnlyTool('delete_file')).toBe(false);
            expect(isReadOnlyTool('execute_shell')).toBe(false);
        });

        it('should respect explicit permission metadata', () => {
            const tool = mockTool('custom_tool', {
                permission: { category: ToolCategory.READ },
            } as any);
            expect(isReadOnlyTool('custom_tool', tool)).toBe(true);
        });
    });

    // ========================================================================
    // 2. ASK 模式过滤
    // ========================================================================
    describe('ASK mode filtering', () => {
        it('should filter out write tools in ASK mode', () => {
            const tools = [
                mockTool('readfile'),
                mockTool('write_file'),
                mockTool('grep'),
                mockTool('edit_file'),
                mockTool('search_files'),
            ];

            const filtered = filterToolsByMode(tools, AgentMode.ASK);
            const names = filtered.map(t => t.name);

            expect(names).toContain('readfile');
            expect(names).toContain('grep');
            expect(names).toContain('search_files');
            expect(names).not.toContain('write_file');
            expect(names).not.toContain('edit_file');
        });

        it('should respect explicit allowInAskMode flag', () => {
            const tools = [
                mockTool('dangerous_but_allowed', {
                    permission: { allowInAskMode: true },
                } as any),
            ];

            const filtered = filterToolsByMode(tools, AgentMode.ASK);
            expect(filtered.length).toBe(1);
        });
    });

    // ========================================================================
    // 3. AGENT/AUTO 模式 → 全部可用
    // ========================================================================
    describe('AGENT/AUTO mode', () => {
        it('AGENT → all tools available', () => {
            const tools = [mockTool('readfile'), mockTool('write_file'), mockTool('bash')];
            const filtered = filterToolsByMode(tools, AgentMode.AGENT);
            expect(filtered.length).toBe(3);
        });

        it('AUTO → all tools available', () => {
            const tools = [mockTool('readfile'), mockTool('write_file'), mockTool('bash')];
            const filtered = filterToolsByMode(tools, AgentMode.AUTO);
            expect(filtered.length).toBe(3);
        });
    });

    // ========================================================================
    // 4. 模式 Prompt
    // ========================================================================
    describe('Mode system prompts', () => {
        it('ASK → contains read-only message', () => {
            const prompt = getModeSystemPrompt(AgentMode.ASK);
            expect(prompt).toContain('ASK');
            expect(prompt).toContain('read-only');
        });

        it('AGENT → contains standard message', () => {
            const prompt = getModeSystemPrompt(AgentMode.AGENT);
            expect(prompt).toContain('AGENT');
        });

        it('AUTO → contains automatic message', () => {
            const prompt = getModeSystemPrompt(AgentMode.AUTO);
            expect(prompt).toContain('AUTO');
        });
    });

    // ========================================================================
    // 5. isToolAllowedInMode
    // ========================================================================
    describe('isToolAllowedInMode', () => {
        it('read tool in ASK mode → allowed', () => {
            expect(isToolAllowedInMode(mockTool('readfile'), AgentMode.ASK)).toBe(true);
        });

        it('write tool in ASK mode → not allowed', () => {
            expect(isToolAllowedInMode(mockTool('write_file'), AgentMode.ASK)).toBe(false);
        });

        it('any tool in AGENT mode → allowed', () => {
            expect(isToolAllowedInMode(mockTool('write_file'), AgentMode.AGENT)).toBe(true);
        });
    });
});
