#!/usr/bin/env tsx
/**
 * Neox Interactive Test Runner
 *
 * 交互式选择运行哪些测试模块
 * Usage: npm test
 */

import prompts from 'prompts';
import { execSync } from 'child_process';
import chalk from 'chalk';

// ─── 测试模块定义 ─── //

interface TestModule {
    title: string;
    description: string;
    file: string;
    category: string;
}

const TEST_MODULES: TestModule[] = [
    // ─── ARE (Adaptive Reasoning Engine) ─── //
    {
        title: 'TaskComplexityAnalyzer',
        description: '任务复杂度分析器 — 输入分类 (NONE/LIGHT/DEEP)',
        file: 'src/core/__tests__/taskComplexityAnalyzer.test.ts',
        category: 'ARE',
    },
    {
        title: 'ReasoningGate',
        description: '推理门控 — 5 条升级规则 + Prompt 注入',
        file: 'src/core/__tests__/reasoningGate.test.ts',
        category: 'ARE',
    },
    {
        title: 'PostActionReflector',
        description: '后置反射器 — 写失败反射/验证阈值/阶段检测',
        file: 'src/core/__tests__/postActionReflector.test.ts',
        category: 'ARE',
    },

    // ─── Profile System ─── //
    {
        title: 'ProfileResolution',
        description: 'Profile 匹配 — 8 种模型匹配 + deepMerge + ARE 差异化',
        file: 'src/core/__tests__/profileResolution.test.ts',
        category: 'Profile',
    },

    // ─── Core Runtime ─── //
    {
        title: 'MemorySession',
        description: '多轮对话/记忆 — 保序/Checkpoint/Rollback/内存压力',
        file: 'src/core/__tests__/memorySession.test.ts',
        category: 'Runtime',
    },
    {
        title: 'LoopDetector',
        description: '循环检测 — NONE→SOFT→MEDIUM→HARD 升级/哈希策略',
        file: 'src/core/__tests__/loopDetector.test.ts',
        category: 'Runtime',
    },
    {
        title: 'ToolArgsParser',
        description: '参数容错 — JSON 修复/Markdown提取/花括号提取',
        file: 'src/core/__tests__/toolArgsParser.test.ts',
        category: 'Runtime',
    },
    {
        title: 'SessionState',
        description: '状态防护 — 写入追踪/读缓存验证/幻觉编辑检测',
        file: 'src/core/__tests__/sessionState.test.ts',
        category: 'Runtime',
    },

    // ─── Tool System ─── //
    {
        title: 'ToolClassification',
        description: '工具分类 — EPHEMERAL/CONTEXTUAL/SUMMARIZED 映射',
        file: 'src/core/__tests__/toolClassification.test.ts',
        category: 'Tools',
    },
    {
        title: 'ToolFiltering',
        description: '权限过滤 — ASK 只读/AGENT 全开/模式 Prompt',
        file: 'src/core/__tests__/toolFiltering.test.ts',
        category: 'Tools',
    },
    {
        title: 'PlanManager',
        description: '计划管理 — 步骤推进/跳过/进度/完成检测',
        file: 'src/core/__tests__/planManager.test.ts',
        category: 'Tools',
    },
    {
        title: 'LedgerRebuild',
        description: '会话恢复重建读账本 — 文件变过一律不重建 (不许比事实更乐观)',
        file: 'src/tools/smart-read/__tests__/ledgerRebuild.test.ts',
        category: 'Tools',
    },
    {
        title: 'EvictedReadPaths',
        description: '压缩挤掉读内容 → 算出该作废的文件 (账本镜像上下文, 非磁盘)',
        file: 'src/core/__tests__/evictedReadPaths.test.ts',
        category: 'Tools',
    },
    {
        title: 'WritePathCoherence',
        description: '写路径一致性 — shell/docx 也要让缓存失效, 否则工具撒谎',
        file: 'src/tools/smart-read/__tests__/writePathCoherence.test.ts',
        category: 'Tools',
    },
    {
        title: 'ReadLedgerRefresh',
        description: '写后刷新读账本 — 整读可省重读, 局部读必须失效',
        file: 'src/tools/smart-read/__tests__/readLedgerRefresh.test.ts',
        category: 'Tools',
    },
    {
        title: 'ProseQuery',
        description: 'search 自然语言查询扩展 — 该扩展的扩展, 正则/标识符不碰',
        file: 'src/tools/search/__tests__/proseQuery.test.ts',
        category: 'Tools',
    },
    {
        title: 'FuzzyRecover',
        description: 'edit 容错恢复 — 空行/注释漂移/省略号可救, 歧义必拒 (安全边界)',
        file: 'src/tools/files/__tests__/fuzzyRecover.test.ts',
        category: 'Tools',
    },

    // ─── CLI ─── //
    {
        title: 'CLI Args',
        description: '命令行参数解析 — 会话/模型/Provider/目录/Debug',
        file: 'src/core/__tests__/cliArgs.test.ts',
        category: 'CLI',
    },

    // ─── CLI UI (3 层) ─── //
    {
        title: 'L1: Components',
        description: 'Ink 组件 — Theme/StatusDisplay/ApprovalDialog',
        file: 'src/cli/__tests__/layer1-components.test.ts',
        category: 'CLI UI',
    },
    {
        title: 'L2: Snapshots',
        description: '输出快照 — 格式化/时间/文件大小/参数组合',
        file: 'src/cli/__tests__/layer2-snapshots.test.ts',
        category: 'CLI UI',
    },
    {
        title: 'L3: Integration',
        description: '进程级 — --help/--version/ASCII Art/错误处理',
        file: 'src/cli/__tests__/layer3-integration.test.ts',
        category: 'CLI UI',
    },
    {
        title: 'L1+: Real Render',
        description: '真实渲染 — CLI输出布局/帮助文档/ASCII Art自适应',
        file: 'src/cli/__tests__/layer1-ink-render.test.ts',
        category: 'CLI UI',
    },

    // ─── Utils ─── //
    {
        title: 'ErrorFormatter',
        description: '错误格式化 — HTML解析/SSE提取/错误建议',
        file: 'src/core/__tests__/errorFormatter.test.ts',
        category: 'Utils',
    },
    {
        title: 'ToolTruncation',
        description: '输出截断 — Codex式中间截断/40-40策略',
        file: 'src/core/__tests__/toolOutputTruncation.test.ts',
        category: 'Utils',
    },
    {
        title: 'MessageUtils',
        description: '消息处理 — 多模态解析/Thinking Block/内容规范化',
        file: 'src/core/__tests__/messageUtils.test.ts',
        category: 'Utils',
    },

    // ─── E2E (需要 API) ─── //
    {
        title: 'E2E Capability',
        description: '真实 API 测试 — 对话/工具调用/多轮记忆/中文/流式',
        file: 'src/core/__tests__/e2e-capability.test.ts',
        category: 'E2E (API)',
    },
];

// ─── UI 渲染 ─── //

function printBanner() {
    console.log();
    console.log(chalk.cyan.bold('  ╔══════════════════════════════════════════╗'));
    console.log(chalk.cyan.bold('  ║') + chalk.white.bold('     🧪 Neox Test Runner                 ') + chalk.cyan.bold('║'));
    console.log(chalk.cyan.bold('  ╚══════════════════════════════════════════╝'));
    console.log();
}

function printSummary(modules: TestModule[]) {
    const categories = [...new Set(modules.map(m => m.category))];

    for (const cat of categories) {
        const items = modules.filter(m => m.category === cat);
        const isE2E = cat.includes('E2E');

        if (isE2E) {
            // 读取 test.config.json 显示 provider 状态
            let providerStatus = '';
            try {
                const fs = require('fs');
                const path = require('path');
                const configPath = path.resolve(process.cwd(), 'test.config.json');
                if (fs.existsSync(configPath)) {
                    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                    const providers = cfg.providers || {};
                    const statuses = Object.entries(providers).map(([name, p]: [string, any]) => {
                        const ok = p.enabled && p.apiKey;
                        return ok ? chalk.green(`✓${name}`) : chalk.gray(`✗${name}`);
                    });
                    providerStatus = `  [${statuses.join(' ')}]`;
                } else {
                    providerStatus = chalk.yellow('  ⚠ test.config.json 不存在');
                }
            } catch { /* ignore */ }

            console.log(chalk.yellow.bold(`  📦 ${cat}`) + providerStatus);
        } else {
            console.log(chalk.yellow.bold(`  📦 ${cat}`));
        }

        for (const item of items) {
            console.log(chalk.gray(`     • ${item.title}: ${item.description}`));
        }
        console.log();
    }

    // 提示
    console.log(chalk.gray('  💡 E2E 测试: 编辑 test.config.json → 填 apiKey + 设 enabled: true'));
    console.log();
}

// ─── 运行测试 ─── //

/**
 * files 为空数组 = **不传文件参数**, 让 vitest 按 vitest.config.ts 的 include/exclude
 * 自己发现全部测试。这是 --ci / 全量运行该走的路 (见下方 --ci 分支的说明)。
 */
function runTests(files: string[], verbose: boolean): boolean {
    const discoverAll = files.length === 0;
    const fileArgs = discoverAll ? '' : files.join(' ');
    const reporterFlag = verbose ? '--reporter=verbose' : '';

    console.log();
    console.log(chalk.cyan.bold(discoverAll
        ? '  ▶ Running ALL discovered test files (vitest.config include/exclude)...\n'
        : `  ▶ Running ${files.length} test file(s)...\n`));

    try {
        execSync(
            `npx vitest run ${fileArgs} ${reporterFlag}`,
            { stdio: 'inherit', cwd: process.cwd() },
        );
        return true;
    } catch {
        return false;
    }
}

// ─── 主流程 ─── //

async function main() {
    printBanner();

    // 快捷参数: npm test -- --all
    if (process.argv.includes('--all')) {
        console.log(chalk.green('  Running all tests...\n'));
        const ok = runTests([], true);   // [] = 全量自动发现, 见 runTests 注释
        process.exit(ok ? 0 : 1);
    }

    /* 快捷参数: npm test -- --ci (CI 模式，无交互)
     *
     * ⚠️ 2026-07-25 改成全量自动发现。原来传的是 TEST_MODULES 这份**手工清单**, 后果:
     *   全仓 286 个测试文件, 清单只列了 26 个 → test:ci 报 "288 passed" 全绿,
     *   而实际仓库里有 3117 个测例。**不在清单里的文件对 CI 完全隐身。**
     * 被这个漏洞藏起来的东西 (排查时一次性挖出来的):
     *   · runtimeFileTools.unifiedEdit — 被 7-24 的一致性诊断改动弄红了两天没人知道
     *   · errorPatternAndAdvisor       — 效率顾问冷却哨兵 bug (真 bug, 已修)
     *   · editFileTool                 — 14 个上一代 line-range API 的死测例
     *   · promptSize.probe             — 写死 2026-07-03 提示词原文的易碎断言
     *   · inProcessShell               — 固定 sleep 的并发 flake
     * 全量实测 270 文件 / 3117 测例 / 22 秒 —— 代价完全可以承受, 没有理由再用手工清单。
     * TEST_MODULES 保留给交互式**选择性**运行 (按类别/模块挑), 那才是它的用处。 */
    if (process.argv.includes('--ci')) {
        const ok = runTests([], false);
        process.exit(ok ? 0 : 1);
    }

    printSummary(TEST_MODULES);

    // ─── 选择模式 ─── //
    const { mode } = await prompts({
        type: 'select',
        name: 'mode',
        message: '选择测试模式',
        choices: [
            { title: '🚀 全部运行', description: `运行所有 ${TEST_MODULES.length} 个模块`, value: 'all' },
            { title: '⚡ 快速运行', description: '跳过 E2E (不需要 API)', value: 'quick' },
            { title: '📦 按类别运行', description: '选择一个类别', value: 'category' },
            { title: '📝 按模块选择', description: '多选具体模块', value: 'module' },
            { title: '👀 Watch 模式', description: '文件变更时自动重跑', value: 'watch' },
        ],
    });

    if (!mode) {
        console.log(chalk.gray('\n  已取消\n'));
        process.exit(0);
    }

    // ─── 全部运行 ─── //
    if (mode === 'all') {
        const ok = runTests(TEST_MODULES.map(m => m.file), true);
        process.exit(ok ? 0 : 1);
    }

    // ─── 快速运行 (跳过 E2E) ─── //
    if (mode === 'quick') {
        const files = TEST_MODULES
            .filter(m => !m.category.includes('E2E'))
            .map(m => m.file);
        console.log(chalk.green(`  ⚡ 跳过 E2E，运行 ${files.length} 个模块\n`));
        const ok = runTests(files, true);
        process.exit(ok ? 0 : 1);
    }

    // ─── Watch 模式 ─── //
    if (mode === 'watch') {
        console.log(chalk.cyan('\n  ▶ Starting watch mode... (press q to quit)\n'));
        try {
            execSync('npx vitest', { stdio: 'inherit', cwd: process.cwd() });
        } catch {
            // vitest watch exits with non-zero on Ctrl+C
        }
        process.exit(0);
    }

    // ─── 按类别 (单选，方向键+回车) ─── //
    if (mode === 'category') {
        const categories = [...new Set(TEST_MODULES.map(m => m.category))];
        const { selectedCategory } = await prompts({
            type: 'select',
            name: 'selectedCategory',
            message: '选择测试类别 (↑↓ 移动，回车确认)',
            choices: categories.map(cat => {
                const items = TEST_MODULES.filter(m => m.category === cat);
                const testNames = items.map(i => i.title).join(', ');
                return {
                    title: `📦 ${cat}`,
                    description: `${items.length} 个模块: ${testNames}`,
                    value: cat,
                };
            }),
        });

        if (!selectedCategory) {
            console.log(chalk.gray('\n  已取消\n'));
            process.exit(0);
        }

        const files = TEST_MODULES
            .filter(m => m.category === selectedCategory)
            .map(m => m.file);

        const ok = runTests(files, true);
        process.exit(ok ? 0 : 1);
    }

    // ─── 按模块 ─── //
    if (mode === 'module') {
        const { selectedModules } = await prompts({
            type: 'multiselect',
            name: 'selectedModules',
            message: '选择测试模块 (空格选择，回车确认)',
            choices: TEST_MODULES.map(m => ({
                title: `[${m.category}] ${m.title}`,
                description: m.description,
                value: m.file,
            })),
            min: 1,
        });

        if (!selectedModules || selectedModules.length === 0) {
            console.log(chalk.gray('\n  未选择任何模块\n'));
            process.exit(0);
        }

        const ok = runTests(selectedModules, true);
        process.exit(ok ? 0 : 1);
    }
}

main().catch(err => {
    console.error(chalk.red('Error:'), err);
    process.exit(1);
});
