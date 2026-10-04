/**
 * Layer 3: CLI 集成测试 — 进程级别
 *
 * 测试真实 CLI 进程的行为（spawn 子进程）
 * - --help 输出
 * - --version 输出
 * - ASCII Art 自适应
 * - 错误参数处理
 *
 * 不需要 API — 只测 CLI 启动和参数处理
 */

import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { execSync } from 'child_process';
import { resolve } from 'path';

/* 治假红 —— 同 layer1-ink-render.test.ts 的理由 (那边有完整说明):
 * `npx tsx` 冷启真 CLI, 全量并行时超过 vitest 全局 testTimeout: 10000 → 假红。 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// 工具: 运行 CLI 命令并收集 stdout + stderr
// 路径修正 src/cli/main.ts → apps/cli/src/main.ts (代码搬家后测试没跟上)
function runCli(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
    /* 按本文件位置解析, 不依赖 process.cwd() —— 见 layer1 同款注释 */
const cliPath = fileURLToPath(new URL('../main.ts', import.meta.url));
    const cmd = `npx tsx ${cliPath} ${args.join(' ')}`;

    try {
        const stdout = execSync(cmd, {
            env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
            timeout: 75_000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { stdout, stderr: '', exitCode: 0 };
    } catch (e: any) {
        return {
            stdout: e.stdout?.toString() || '',
            stderr: e.stderr?.toString() || '',
            exitCode: e.status || 1,
        };
    }
}

describe('Layer 3: CLI Integration Tests', () => {
    // ========================================================================
    // 1. --version
    // ========================================================================
    describe('--version', () => {
        it('should show version number', () => {
            const result = runCli('--version');
            const combined = result.stdout + result.stderr;
            // 应包含版本号格式 (v1.2.3 or Neox CLI v...)
            expect(combined).toMatch(/v?\d+\.\d+\.\d+/);
        });
    });

    // ========================================================================
    // 2. --help
    // ========================================================================
    describe('--help', () => {
        it('should show help text', () => {
            const result = runCli('--help');
            const combined = result.stdout + result.stderr;
            expect(combined).toContain('Neox');
            // 应包含关键选项
            expect(combined).toContain('--model');
            expect(combined).toContain('--provider');
            expect(combined).toContain('--continue');
        });

        it('should show session commands', () => {
            const result = runCli('--help');
            const combined = result.stdout + result.stderr;
            expect(combined).toContain('/sessions');
        });
    });

    // ========================================================================
    // 3. ASCII Art Logo
    // ========================================================================
    describe('ASCII Art', () => {
        it('should return small logo for narrow terminals', async () => {
            const { getNeoxLogo } = await import('../asciiArt.js');
            const logo = getNeoxLogo(50);
            expect(logo).toBeTruthy();
            // 小 logo 应该比大 logo 短
            const smallLines = logo.split('\n').filter(l => l.trim().length > 0);
            expect(smallLines.length).toBeLessThanOrEqual(6);
        });

        it('should return full logo for wide terminals', async () => {
            const { getNeoxLogo } = await import('../asciiArt.js');
            const logo = getNeoxLogo(120);
            expect(logo).toBeTruthy();
            expect(logo).toContain('███');
        });

        it('should contain Neox branding', async () => {
            const { neoxAsciiLogo } = await import('../asciiArt.js');
            // Logo 应该包含 █ 字符（像素块）
            expect(neoxAsciiLogo).toContain('█');
        });
    });

    // ========================================================================
    // 4. 未知参数
    // ========================================================================
    describe('Unknown arguments', () => {
        it('should detect unknown flags', async () => {
            const { parseArgs } = await import('../args.js');
            const result = parseArgs(['node', 'neox', '--totally-unknown']);
            expect(result.unknownArgs).toContain('--totally-unknown');
        });
    });
});
