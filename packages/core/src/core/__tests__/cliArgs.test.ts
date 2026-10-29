/**
 * CLI Args Parser Tests — 命令行参数解析
 *
 * 不需要 API — 纯字符串解析
 */

import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../cli/args.js';

// 辅助: 模拟 argv (前两个是 node 路径和脚本路径)
function argv(...args: string[]): string[] {
    return ['node', 'neox', ...args];
}

describe('CLI Args Parser', () => {
    // ========================================================================
    // 1. 默认值
    // ========================================================================
    describe('Defaults', () => {
        it('should return defaults with no args', () => {
            const result = parseArgs(argv());
            expect(result.continue).toBe(false);
            expect(result.resume).toBe(false);
            expect(result.help).toBe(false);
            expect(result.version).toBe(false);
            expect(result.noSession).toBe(false);
            expect(result._).toEqual([]);
        });
    });

    // ========================================================================
    // 2. 会话选项
    // ========================================================================
    describe('Session options', () => {
        it('-c → continue', () => {
            expect(parseArgs(argv('-c')).continue).toBe(true);
        });

        it('--continue → continue', () => {
            expect(parseArgs(argv('--continue')).continue).toBe(true);
        });

        it('-r → resume (selector)', () => {
            expect(parseArgs(argv('-r')).resume).toBe(true);
        });

        it('-r session_123 → resume with ID', () => {
            expect(parseArgs(argv('-r', 'session_123')).resume).toBe('session_123');
        });

        it('--resume session_abc → resume with ID', () => {
            expect(parseArgs(argv('--resume', 'session_abc')).resume).toBe('session_abc');
        });

        it('--no-session → noSession', () => {
            expect(parseArgs(argv('--no-session')).noSession).toBe(true);
        });
    });

    // ========================================================================
    // 3. 模型和 Provider
    // ========================================================================
    describe('Model & Provider', () => {
        it('-m gpt-4o → model', () => {
            expect(parseArgs(argv('-m', 'gpt-4o')).model).toBe('gpt-4o');
        });

        it('--model claude-sonnet-4-20250514 → model', () => {
            expect(parseArgs(argv('--model', 'claude-sonnet-4-20250514')).model).toBe('claude-sonnet-4-20250514');
        });

        it('-p anthropic → provider', () => {
            expect(parseArgs(argv('-p', 'anthropic')).provider).toBe('anthropic');
        });

        it('--provider openai → provider', () => {
            expect(parseArgs(argv('--provider', 'openai')).provider).toBe('openai');
        });
    });

    // ========================================================================
    // 4. 工作目录
    // ========================================================================
    describe('Working directory', () => {
        it('-d /path → workDir', () => {
            expect(parseArgs(argv('-d', '/path')).workDir).toBe('/path');
        });

        it('--dir ./src → workDir', () => {
            expect(parseArgs(argv('--dir', './src')).workDir).toBe('./src');
        });

        it('--workdir ~/project → workDir', () => {
            expect(parseArgs(argv('--workdir', '~/project')).workDir).toBe('~/project');
        });
    });

    // ========================================================================
    // 5. 帮助和版本
    // ========================================================================
    describe('Help & Version', () => {
        it.each(['-h', '--help', '-help'])('%s → help', (flag) => {
            expect(parseArgs(argv(flag)).help).toBe(true);
        });

        it.each(['-v', '-V', '--version', '-version'])('%s → version', (flag) => {
            expect(parseArgs(argv(flag)).version).toBe(true);
        });
    });

    // ========================================================================
    // 6. Debug
    // ========================================================================
    describe('Debug flags', () => {
        it('--debug → debug', () => {
            expect(parseArgs(argv('--debug')).debug).toBe(true);
        });

        it('--debug-console → debug + debugConsole', () => {
            const result = parseArgs(argv('--debug-console'));
            expect(result.debug).toBe(true);
            expect(result.debugConsole).toBe(true);
        });
    });

    // ========================================================================
    // 7. 位置参数
    // ========================================================================
    describe('Positional arguments', () => {
        it('should capture positional args', () => {
            const result = parseArgs(argv('帮我写个排序'));
            expect(result._).toEqual(['帮我写个排序']);
        });

        it('should handle mixed args', () => {
            const result = parseArgs(argv('-m', 'gpt-4o', '你好', '世界'));
            expect(result.model).toBe('gpt-4o');
            expect(result._).toEqual(['你好', '世界']);
        });
    });

    // ========================================================================
    // 8. 未知参数
    // ========================================================================
    describe('Unknown args', () => {
        it('should collect unknown flags', () => {
            const result = parseArgs(argv('--unknown-flag', '--another'));
            expect(result.unknownArgs).toBeTruthy();
            expect(result.unknownArgs).toContain('--unknown-flag');
            expect(result.unknownArgs).toContain('--another');
        });
    });

    // ========================================================================
    // 9. 组合使用
    // ========================================================================
    describe('Combined usage', () => {
        it('should handle full combo', () => {
            const result = parseArgs(argv(
                '-c', '-m', 'gpt-4o', '-p', 'openai', '-d', '/project', '--debug',
            ));
            expect(result.continue).toBe(true);
            expect(result.model).toBe('gpt-4o');
            expect(result.provider).toBe('openai');
            expect(result.workDir).toBe('/project');
            expect(result.debug).toBe(true);
        });
    });
});
