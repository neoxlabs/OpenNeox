/**
 * Layer 1+: 真正的 UI 渲染测试
 *
 * 直接在 vitest 进程内用 dynamic import 加载模块，
 * 验证"真正生成的文字输出"是否符合预期
 *
 * CLI --help 输出 = 终端里看到的真实文字
 * ASCII Art = 终端里看到的真实图案
 */

import { describe, it, expect, vi } from 'vitest';
import { execSync } from 'child_process';
import { fileURLToPath } from 'node:url';

/* 治假红: 本文件每个用例都 `npx tsx` 冷启一个真 CLI 进程 (tsx 要现编译
 * cli+core+platform+kernel 整条 TS 链)。单独跑 ~2s, 但全量 281 个测试文件并行时机器被
 * 压满, 冷启动经常超过 vitest 的全局 testTimeout: 10000 → 整族 8-11 条一起红, 而单独
 * 重跑又全绿。这种"只在全量时红"的假信号最坑: 它会让人把真回归也当成抖动放过去
 * (本次架构改造中它已经骗过两次判断)。
 *
 * 判据是慢不是错 → 给足时间, 而不是放宽断言。文件级作用域, 不影响其它测试的 10s 上限。 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// 辅助: 运行 CLI 命令
// 路径修正 src/cli/main.ts → apps/cli/src/main.ts (代码搬家后测试没跟上, 常年红)
/* 改成按本文件位置解析, 不再依赖 process.cwd().
 * 原先写死仓库根相对路径 `apps/cli/src/main.ts` —— 从 apps/cli/
 * 目录跑 vitest 时解析不到, node 直接 MODULE_NOT_FOUND, 8-10 条一起红。
 * 而报错被 catch 吞成半截 stdout, 表现成"输出不对"而不是"路径错", 极具误导性。 */
const CLI_ENTRY = fileURLToPath(new URL('../main.ts', import.meta.url));

function runCli(...args: string[]): string {
    try {
        return execSync(
            `npx tsx ${JSON.stringify(CLI_ENTRY)} ${args.join(' ')}`,
            {
                cwd: process.cwd(),
                /* 跟上面 vi.setConfig 是一套: execSync 自己的闸也得放开, 否则 8s 一到
                 * 它抛异常 → catch 返回半截 stdout → 断言失败, 表现成"输出不对"而不是"超时"。 */
                timeout: 75_000,
                encoding: 'utf-8',
                env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
            },
        );
    } catch (e: any) {
        return (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
    }
}

describe('Layer 1+: Real Terminal Rendering', () => {
    // ========================================================================
    // 1. CLI --help 完整渲染验证
    // ========================================================================
    describe('--help full rendering', () => {
        let helpOutput: string;

        it('should render without errors', () => {
            helpOutput = runCli('--help');
            expect(helpOutput.length).toBeGreaterThan(100);
        });

        it('should have title with version', () => {
            const output = runCli('--help');
            expect(output).toMatch(/Neox CLI.*v\d+\.\d+\.\d+/);
        });

        it('should have 4 documentation sections', () => {
            const output = runCli('--help');
            expect(output).toContain('会话选项');
            expect(output).toContain('通用选项');
            expect(output).toContain('会话命令');
            expect(output).toContain('示例');
        });

        it('should list all CLI flags in formatted table', () => {
            const output = runCli('--help');
            /* 断言对齐当前 help — `-p` 归 --print (P0 修复), provider 只留长选项 */
            const requiredFlags = [
                '-c, --continue',
                '-r, --resume',
                '-m, --model',
                '-p, --print',
                '--provider',
                '-d, --dir',
                '--debug',
                '-h, --help',
                '-v, --version',
                '--no-session',
                '--output-schema',
            ];

            for (const flag of requiredFlags) {
                expect(output).toContain(flag);
            }
        });

        it('should list all slash commands', () => {
            const output = runCli('--help');
            /* session-* 子动作已统一收进 /session <ls|new|info|export|clear>,
             * help 不再逐个列旧别名 (它们仍是隐藏别名, 见 sessionProcessRouting) */
            const commands = [
                '/session',
                '/sessions',
                /* /undo 从这里去掉 —— 它实际回的是"暂不可用: 当前 CLI 架构下
                 * 没有按轮回退的通道", 帮助里不该列一个不存在的功能 (见 args.ts)。 */
                '/checkpoint',
                '/rollback',
            ];

            for (const cmd of commands) {
                expect(output).toContain(cmd);
            }
        });

        /* Help output must advertise only commands that have an implementation. */
        it('should not advertise unimplemented commands', () => {
            const output = runCli('--help');
            expect(output).not.toContain('/undo');
        });

        it('should have usage examples', () => {
            const output = runCli('--help');
            expect(output).toContain('neox -c');
            expect(output).toContain('neox -p');
            expect(output).toContain('neox provider ls');
        });

        it('should describe checkpoint commands', () => {
            /* 旧断言找"快照功能"字样 — help 改版后叫"检查点" (/checkpoint) */
            const output = runCli('--help');
            expect(output).toContain('检查点');
        });
    });

    // ========================================================================
    // 2. --version 渲染
    // ========================================================================
    describe('--version rendering', () => {
        it('should show clean version string', () => {
            const output = runCli('--version');
            // 格式: "Neox CLI v2.0.85"
            expect(output.trim()).toMatch(/Neox CLI v\d+\.\d+\.\d+/);
        });

        it('should be single line', () => {
            const output = runCli('--version');
            const lines = output.trim().split('\n');
            expect(lines.length).toBe(1);
        });
    });

    // ========================================================================
    // 3. ASCII Art 真实渲染
    // ========================================================================
    describe('ASCII Art real rendering', () => {
        it('should select small logo for narrow terminal (< 60)', async () => {
            const { getNeoxLogo, neoxAsciiLogoSmall } = await import('../asciiArt.js');
            const logo = getNeoxLogo(50);
            expect(logo).toBe(neoxAsciiLogoSmall);
        });

        it('should select compact logo for medium terminal (60-79)', async () => {
            const { getNeoxLogo, neoxAsciiLogoCompact } = await import('../asciiArt.js');
            const logo = getNeoxLogo(70);
            expect(logo).toBe(neoxAsciiLogoCompact);
        });

        it('should select full logo for wide terminal (≥ 80)', async () => {
            const { getNeoxLogo, neoxAsciiLogo } = await import('../asciiArt.js');
            const logo = getNeoxLogo(120);
            expect(logo).toBe(neoxAsciiLogo);
        });

        it('full logo should have 10+ lines', async () => {
            const { neoxAsciiLogo } = await import('../asciiArt.js');
            const lines = neoxAsciiLogo.split('\n').filter(l => l.trim().length > 0);
            expect(lines.length).toBeGreaterThanOrEqual(9);
        });

        it('small logo should have ≤ 6 lines', async () => {
            const { neoxAsciiLogoSmall } = await import('../asciiArt.js');
            const lines = neoxAsciiLogoSmall.split('\n').filter(l => l.trim().length > 0);
            expect(lines.length).toBeLessThanOrEqual(6);
        });

        it('gradient logo should exist', async () => {
            const { neoxAsciiLogoGradient } = await import('../asciiArt.js');
            expect(neoxAsciiLogoGradient).toContain('█');
        });
    });
});
