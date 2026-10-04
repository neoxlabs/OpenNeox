/**
 * Layer 1: Ink 组件单元测试
 *
 * 使用 ink-testing-library 测试 Ink React 组件的渲染输出
 * 不需要 API / 不需要启动真实终端
 *
 * 测试目标:
 * - Theme 颜色系统
 * - StatusDisplay 状态显示
 * - ApprovalDialog 审批对话
 * - Format 格式化工具
 */

import { describe, it, expect } from 'vitest';

// ─── Theme ─── //
import { NeoxTheme, getColor } from '../ink/theme.js';

describe('Layer 1: Ink Component Tests', () => {
    // ========================================================================
    // 1. Theme 主题系统
    // ========================================================================
    describe('Theme System', () => {
        /* 断言从"写死具体色值"改为"结构 + 合法 hex" —
         * theme.ts 已改为可切换配色 (slate/warm/mono/nord/neon) + 亮暗自适应,
         * 具体色值随 NEOX_THEME 变, 写死值让测试常年红 (发布审计存量失败). */
        const HEX = /^#[0-9a-fA-F]{6}$/;

        it('should have complete brand colors', () => {
            expect(NeoxTheme.brand.cyan).toMatch(HEX);
            expect(NeoxTheme.brand.blue).toMatch(HEX);
            expect(NeoxTheme.brand.purple).toMatch(HEX);
            expect(NeoxTheme.brand.magenta).toMatch(HEX);
            expect(NeoxTheme.brand.pink).toMatch(HEX);
        });

        it('should have functional colors', () => {
            expect(NeoxTheme.functional.success).toBeTruthy();
            expect(NeoxTheme.functional.warning).toBeTruthy();
            expect(NeoxTheme.functional.error).toBeTruthy();
            expect(NeoxTheme.functional.info).toBeTruthy();
        });

        it('should have text hierarchy', () => {
            /* text.primary 现在有意为 undefined = 用终端前景色 (亮/暗底都清晰) */
            expect(NeoxTheme.text.primary).toBeUndefined();
            expect(NeoxTheme.text.secondary).toBeTruthy();
            expect(NeoxTheme.text.dim).toBeTruthy();
            expect(NeoxTheme.text.highlight).toBeTruthy();
        });

        it('getColor should resolve paths', () => {
            expect(getColor('brand.cyan')).toMatch(HEX);
            expect(getColor('functional.error')).toMatch(HEX);
        });

        it('getColor should fallback to accent for invalid paths', () => {
            /* fallback 现在是主题 accent (不再是写死的白色) */
            expect(getColor('nonexistent.path')).toMatch(HEX);
        });

        it('should have all required UI sections', () => {
            // 确保主题没有缺失的 section
            const sections = ['brand', 'functional', 'text', 'bg', 'border', 'ui'];
            for (const section of sections) {
                expect(NeoxTheme).toHaveProperty(section);
                expect(typeof (NeoxTheme as any)[section]).toBe('object');
            }
        });
    });

    // ========================================================================
    // 2. StatusDisplay 状态显示器
    // ========================================================================
    describe('StatusDisplay', () => {
        // 延迟 import 避免 readline 副作用
        let StatusDisplay: any;

        it('should construct without error', async () => {
            const mod = await import('../statusDisplay.js');
            StatusDisplay = mod.StatusDisplay;
            const display = new StatusDisplay({ isDarkBackground: true });
            expect(display).toBeTruthy();
        });

        it('should update status', async () => {
            const mod = await import('../statusDisplay.js');
            StatusDisplay = mod.StatusDisplay;
            const display = new StatusDisplay({ isDarkBackground: true });
            // should not throw
            display.updateStatus('Testing...', 'thinking');
            display.updateStatus('Reading file', 'tool_call');
            display.updateStatus('Done', 'complete');
        });

        it('should track tool calls', async () => {
            const mod = await import('../statusDisplay.js');
            StatusDisplay = mod.StatusDisplay;
            const display = new StatusDisplay({ isDarkBackground: true });
            display.addToolCall({
                name: 'readfile',
                args: { file_path: '/test.ts' },
                timestamp: new Date(),
            });
            // addToolCall 后 history 有记录
        });

        it('should track file operations', async () => {
            const mod = await import('../statusDisplay.js');
            StatusDisplay = mod.StatusDisplay;
            const display = new StatusDisplay({ isDarkBackground: true });
            display.addFileOperation({
                type: 'read',
                path: '/src/main.ts',
                lines: 100,
            });
        });

        it('should handle tool results and errors', async () => {
            const mod = await import('../statusDisplay.js');
            StatusDisplay = mod.StatusDisplay;
            const display = new StatusDisplay({ isDarkBackground: true });
            display.addToolCall({
                name: 'readfile',
                args: {},
                timestamp: new Date(),
            });
            display.updateToolResult('readfile', 'file content...', 150);
            display.updateToolError('readfile', 'File not found');
        });
    });

    // ========================================================================
    // 3. ApprovalDialog 审批对话框
    // ========================================================================
    describe('ApprovalDialog', () => {
        it('should throw without prompt configured', async () => {
            const mod = await import('../approvalDialog.js');
            // 未配置 prompt 时应该抛错
            await expect(
                mod.showApprovalDialog({
                    toolName: 'edit_file',
                    toolCategory: 'write' as any,
                    args: { file_path: '/test.ts' },
                }),
            ).rejects.toThrow('Approval prompt is not configured');
        });

        it('should return allow_once with mock prompt', async () => {
            const mod = await import('../approvalDialog.js');
            // 注入 mock prompt
            mod.setApprovalPrompt(async () => 'allow_once');

            const result = await mod.showApprovalDialog({
                toolName: 'edit_file',
                toolCategory: 'write' as any,
                args: { file_path: '/test.ts' },
            });
            expect(result.approved).toBe(true);
            expect(result.remember).toBe(false);

            // 清理
            mod.setApprovalPrompt(null);
        });

        it('should return always_allow with remember', async () => {
            const mod = await import('../approvalDialog.js');
            mod.setApprovalPrompt(async () => 'always_allow');

            const result = await mod.showApprovalDialog({
                toolName: 'edit_file',
                toolCategory: 'write' as any,
                args: {},
                allowRemember: true,
            });
            expect(result.approved).toBe(true);
            expect(result.remember).toBe(true);

            mod.setApprovalPrompt(null);
        });

        it('should return deny', async () => {
            const mod = await import('../approvalDialog.js');
            mod.setApprovalPrompt(async () => 'deny');

            const result = await mod.showApprovalDialog({
                toolName: 'delete_file',
                toolCategory: 'destructive' as any,
                args: { file_path: '/important.ts' },
            });
            expect(result.approved).toBe(false);

            mod.setApprovalPrompt(null);
        });
    });

    // ========================================================================
    // 4. LineUtils
    // ========================================================================
    describe('lineUtils', () => {
        it('should trim empty edge lines', async () => {
            const mod = await import('../ink/components/messages/lineUtils.js');
            expect(mod.trimEmptyEdgeLines(['', 'hello', 'world', ''])).toEqual(['hello', 'world']);
        });

        it('should handle all-empty lines', async () => {
            const mod = await import('../ink/components/messages/lineUtils.js');
            expect(mod.trimEmptyEdgeLines(['', '', ''])).toEqual([]);
        });

        it('should handle no-empty lines', async () => {
            const mod = await import('../ink/components/messages/lineUtils.js');
            expect(mod.trimEmptyEdgeLines(['hello', 'world'])).toEqual(['hello', 'world']);
        });
    });
});
