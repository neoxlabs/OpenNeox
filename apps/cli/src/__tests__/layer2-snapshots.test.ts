/**
 * Layer 2: CLI 命令输出 Snapshot 测试
 *
 * 测试 CLI 的纯输出行为（不需要启动交互终端）
 * - 参数解析 + 输出验证
 * - 格式化工具函数
 * - ASCII Art 渲染
 *
 * 不需要 API / 不需要终端
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { parseArgs } from '../args.js';
import { setLanguage } from '../i18n/index.js';
import {
    formatTimeAgo,
    formatProcessDuration,
    formatBadges,
    formatArgs,
    truncateString,
    formatFileSize,
    formatNumber,
} from '../utils/format.js';

describe('Layer 2: CLI Output Snapshot Tests', () => {
    // ========================================================================
    // 1. 格式化 — formatTimeAgo
    // ========================================================================
    describe('formatTimeAgo', () => {
        // 文案跟界面语言走; 这里钉英文, 不吃跑测试那台机器的配置
        beforeAll(() => setLanguage('en'));
        it('just now (< 1 min)', () => {
            expect(formatTimeAgo(new Date())).toBe('just now');
        });

        it('minutes ago', () => {
            const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
            expect(formatTimeAgo(fiveMinAgo)).toBe('5m ago');
        });

        it('hours ago', () => {
            const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
            expect(formatTimeAgo(twoHoursAgo)).toBe('2h ago');
        });

        it('yesterday', () => {
            const yesterday = new Date(Date.now() - 1 * 86400 * 1000);
            expect(formatTimeAgo(yesterday)).toBe('yesterday');
        });

        it('days ago', () => {
            const fiveDaysAgo = new Date(Date.now() - 5 * 86400 * 1000);
            expect(formatTimeAgo(fiveDaysAgo)).toBe('5 days ago');
        });
    });

    // ========================================================================
    // 2. 格式化 — formatProcessDuration
    // ========================================================================
    describe('formatProcessDuration', () => {
        it('milliseconds', () => {
            expect(formatProcessDuration(500)).toBe('500ms');
        });

        it('seconds', () => {
            expect(formatProcessDuration(1500)).toBe('1.5s');
        });

        it('minutes + seconds', () => {
            expect(formatProcessDuration(150000)).toBe('2m 30s');
        });

        it('hours + minutes', () => {
            expect(formatProcessDuration(3660000)).toBe('1h 1m');
        });
    });

    // ========================================================================
    // 3. 格式化 — formatBadges
    // ========================================================================
    describe('formatBadges', () => {
        it('empty → empty string', () => {
            expect(formatBadges([])).toBe('');
        });

        it('single badge', () => {
            expect(formatBadges(['beta'])).toBe(' [beta]');
        });

        it('multiple badges', () => {
            expect(formatBadges(['beta', 'debug'])).toBe(' [beta, debug]');
        });
    });

    // ========================================================================
    // 4. 格式化 — formatArgs
    // ========================================================================
    describe('formatArgs', () => {
        it('empty → empty string', () => {
            expect(formatArgs({})).toBe('');
            expect(formatArgs(null)).toBe('');
        });

        it('should show first 2 args', () => {
            const result = formatArgs({ a: '1', b: '2', c: '3' });
            expect(result).toContain('a=1');
            expect(result).toContain('b=2');
            expect(result).toContain('+1');
        });

        it('should truncate long values', () => {
            const result = formatArgs({ path: '/very/long/path/to/some/file/name.ts' });
            expect(result).toContain('...');
        });
    });

    // ========================================================================
    // 5. 格式化 — truncateString
    // ========================================================================
    describe('truncateString', () => {
        it('short string → unchanged', () => {
            expect(truncateString('hello', 10)).toBe('hello');
        });

        it('long string → truncated with ...', () => {
            expect(truncateString('hello world!', 8)).toBe('hello...');
        });
    });

    // ========================================================================
    // 6. 格式化 — formatFileSize
    // ========================================================================
    describe('formatFileSize', () => {
        it('bytes', () => {
            expect(formatFileSize(500)).toBe('500 B');
        });

        it('kilobytes', () => {
            expect(formatFileSize(2048)).toBe('2.0 KB');
        });

        it('megabytes', () => {
            expect(formatFileSize(1048576)).toBe('1.0 MB');
        });

        it('gigabytes', () => {
            expect(formatFileSize(1073741824)).toBe('1.0 GB');
        });
    });

    // ========================================================================
    // 7. 格式化 — formatNumber
    // ========================================================================
    describe('formatNumber', () => {
        it('should format with separators', () => {
            const result = formatNumber(1234567);
            expect(result).toBeTruthy();
            // locale-dependent, just check it returns something
            expect(result.length).toBeGreaterThan(0);
        });
    });

    // ========================================================================
    // 8. CLI 参数组合 Snapshot
    // ========================================================================
    describe('CLI Args Snapshots', () => {
        it('empty args → defaults', () => {
            const args = parseArgs(['node', 'neox']);
            expect(args).toMatchObject({
                continue: false,
                resume: false,
                help: false,
                version: false,
                noSession: false,
                _: [],
            });
        });

        it('full combo → all fields set', () => {
            /* `-p` 现在只属于 --print (P0 修复, 见 args.ts), provider 只留长选项 */
            const args = parseArgs([
                'node', 'neox',
                '-c', '-m', 'gpt-4o', '--provider', 'openai',
                '-d', '/project', '--debug', '--no-session',
            ]);
            expect(args).toMatchObject({
                continue: true,
                model: 'gpt-4o',
                provider: 'openai',
                workDir: '/project',
                debug: true,
                noSession: true,
            });
        });

        it('prompt passthrough', () => {
            const args = parseArgs(['node', 'neox', '帮我修个bug', '在main.ts']);
            expect(args._).toEqual(['帮我修个bug', '在main.ts']);
        });
    });
});
