/**
 * ProjectContextDetector — 零成本项目上下文探测
 *
 * 设计考量：
 *
 * 1. 不用 LLM — 纯文件系统检测，<50ms 完成
 * 2. 不替代 project.md — 这是**兜底**方案
 *    - 如果用户已经 /init 生成了 .neox/project.md → 那个更详细，这里不生成
 *    - 如果用户没 /init → 这里提供最小化但有价值的项目上下文
 * 3. 只读取小配置文件的关键字段 — 不读 lock 文件，不读 node_modules
 * 4. 结果缓存 — 同一 workDir 只检测一次
 * 5. 不影响主流程 — 任何检测失败都静默跳过
 *
 * 注入位置：buildLayeredPrompt 的 Layer 1（环境信息）之后
 */

import fs from 'fs';
import path from 'path';
import { cliLogger } from '../../platform/cliLogger.js';

/** 项目上下文信息 */
export interface ProjectContext {
    /** 主要语言 */
    language: string;
    /** 框架 */
    framework?: string;
    /** 测试框架 */
    testFramework?: string;
    /** 构建命令 */
    buildCommand?: string;
    /** 测试命令 */
    testCommand?: string;
    /** lint 命令 */
    lintCommand?: string;
    /** 包管理器 */
    packageManager?: string;
    /** 主要源代码目录 */
    srcDir?: string;
    /** 项目名 */
    name?: string;
    /** 目录结构摘要（depth 2，排除 node_modules 等） */
    directoryTree?: string[];
    /** 入口文件列表 */
    entryFiles?: string[];
}

/** 缓存 */
const detectionCache = new Map<string, ProjectContext | null>();

function debugIgnoredDetectorError(scope: string, error: unknown, extra?: Record<string, unknown>): void {
    if (process.env.CLI_DEBUG !== '1') return;
    cliLogger.debug('PROJECT_DETECT', `${scope} ignored`, {
        error: error instanceof Error ? error.message : String(error),
        ...extra,
    });
}

/**
 * 检测项目上下文（零 LLM 成本）
 *
 * @returns ProjectContext 或 null（未检测到任何已知项目结构）
 */
export function detectProjectContext(workDir: string): ProjectContext | null {
    if (detectionCache.has(workDir)) {
        return detectionCache.get(workDir) || null;
    }

    try {
        let result = doDetect(workDir);

        //  FIX: 如果当前目录不是项目根（常见于用户 cd 到上层目录），
        // 往下扫一层子目录寻找项目
        if (!result) {
            const subProjects = findSubProjects(workDir);
            if (subProjects.length > 0) {
                // 多个子项目：生成仓库级别的摘要
                result = {
                    language: 'Multi-project workspace',
                    name: path.basename(workDir),
                    directoryTree: scanDirectoryStructure(workDir),
                    entryFiles: [],
                };
                // 列出各子项目的基本信息
                const subInfos: string[] = subProjects.map(sub => {
                    const subCtx = doDetect(sub.path);
                    const lang = subCtx?.language || 'unknown';
                    const framework = subCtx?.framework ? ` + ${subCtx.framework}` : '';
                    return `${sub.name}: ${lang}${framework}`;
                });
                result.framework = subInfos.join(', ');
            }
        }

        if (result) {
            // 附加目录结构扫描（轻量，<50ms）
            if (!result.directoryTree?.length) {
                result.directoryTree = scanDirectoryStructure(workDir);
            }
            if (!result.entryFiles?.length) {
                result.entryFiles = findEntryFiles(workDir);
            }
        }
        detectionCache.set(workDir, result);
        return result;
    } catch (e: any) {
        cliLogger.debug('PROJECT_DETECT', `Detection failed: ${e.message}`);
        detectionCache.set(workDir, null);
        return null;
    }
}

/**
 * 扫描子目录寻找项目（depth 1）
 * 返回包含项目特征文件的子目录
 */
function findSubProjects(workDir: string): Array<{ name: string; path: string }> {
    const PROJECT_MARKERS = ['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'setup.py', 'pom.xml', 'build.gradle'];
    const results: Array<{ name: string; path: string }> = [];
    try {
        const entries = fs.readdirSync(workDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const subDir = path.join(workDir, entry.name);
            for (const marker of PROJECT_MARKERS) {
                if (fs.existsSync(path.join(subDir, marker))) {
                    results.push({ name: entry.name, path: subDir });
                    break;
                }
            }
        }
    } catch (error) {
        debugIgnoredDetectorError('findSubProjects', error, { workDir });
    }
    return results;
}

function doDetect(workDir: string): ProjectContext | null {
    // 按优先级尝试各语言检测

    // ─── Node.js / TypeScript / JavaScript ───
    const pkgPath = path.join(workDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
        return detectNodeProject(workDir, pkgPath);
    }

    // ─── Go ───
    const goModPath = path.join(workDir, 'go.mod');
    if (fs.existsSync(goModPath)) {
        return detectGoProject(workDir, goModPath);
    }

    // ─── Python ───
    const pyprojectPath = path.join(workDir, 'pyproject.toml');
    const setupPyPath = path.join(workDir, 'setup.py');
    const requirementsPath = path.join(workDir, 'requirements.txt');
    if (fs.existsSync(pyprojectPath) || fs.existsSync(setupPyPath) || fs.existsSync(requirementsPath)) {
        return detectPythonProject(workDir);
    }

    // ─── Rust ───
    const cargoPath = path.join(workDir, 'Cargo.toml');
    if (fs.existsSync(cargoPath)) {
        return detectRustProject(workDir, cargoPath);
    }

    // ─── Java / Kotlin ───
    const pomPath = path.join(workDir, 'pom.xml');
    const gradlePath = path.join(workDir, 'build.gradle');
    const gradleKtsPath = path.join(workDir, 'build.gradle.kts');
    if (fs.existsSync(pomPath) || fs.existsSync(gradlePath) || fs.existsSync(gradleKtsPath)) {
        return {
            language: fs.existsSync(gradleKtsPath) ? 'Kotlin/JVM' : 'Java',
            buildCommand: fs.existsSync(pomPath) ? 'mvn compile' : './gradlew build',
            testCommand: fs.existsSync(pomPath) ? 'mvn test' : './gradlew test',
        };
    }

    return null;
}

// ========================================================================
// 各语言检测器
// ========================================================================

function detectNodeProject(workDir: string, pkgPath: string): ProjectContext {
    let pkg: any = {};
    try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    } catch {
        return { language: 'JavaScript' };
    }

    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const scripts = pkg.scripts || {};

    // 语言检测
    const hasTsConfig = fs.existsSync(path.join(workDir, 'tsconfig.json'));
    const language = hasTsConfig || deps.typescript ? 'TypeScript' : 'JavaScript';

    // 框架检测
    let framework: string | undefined;
    if (deps.next) framework = `Next.js ${deps.next}`;
    else if (deps.nuxt) framework = `Nuxt ${deps.nuxt}`;
    else if (deps.react) framework = `React ${deps.react}`;
    else if (deps.vue) framework = `Vue ${deps.vue}`;
    else if (deps.svelte || deps['@sveltejs/kit']) framework = 'Svelte/SvelteKit';
    else if (deps.express) framework = 'Express.js';
    else if (deps.fastify) framework = 'Fastify';
    else if (deps['@nestjs/core']) framework = 'NestJS';
    else if (deps.electron) framework = 'Electron';

    // 测试框架检测
    let testFramework: string | undefined;
    if (deps.vitest) testFramework = 'vitest';
    else if (deps.jest || deps['@jest/core']) testFramework = 'jest';
    else if (deps.mocha) testFramework = 'mocha';
    else if (deps['@playwright/test']) testFramework = 'playwright';
    else if (deps.cypress) testFramework = 'cypress';

    // 包管理器检测
    let packageManager: string | undefined;
    if (fs.existsSync(path.join(workDir, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
    else if (fs.existsSync(path.join(workDir, 'yarn.lock'))) packageManager = 'yarn';
    else if (fs.existsSync(path.join(workDir, 'bun.lockb'))) packageManager = 'bun';
    else packageManager = 'npm';

    // 源目录检测
    let srcDir: string | undefined;
    if (fs.existsSync(path.join(workDir, 'src'))) srcDir = 'src/';
    else if (fs.existsSync(path.join(workDir, 'app'))) srcDir = 'app/';
    else if (fs.existsSync(path.join(workDir, 'lib'))) srcDir = 'lib/';

    return {
        language,
        framework,
        testFramework,
        buildCommand: scripts.build ? `${packageManager} run build` : undefined,
        testCommand: scripts.test ? `${packageManager} run test` : (testFramework ? `npx ${testFramework} run` : undefined),
        lintCommand: scripts.lint ? `${packageManager} run lint` : undefined,
        packageManager,
        srcDir,
        name: pkg.name,
    };
}

function detectGoProject(workDir: string, goModPath: string): ProjectContext {
    let moduleName: string | undefined;
    try {
        const content = fs.readFileSync(goModPath, 'utf-8');
        const match = content.match(/^module\s+(.+)$/m);
        if (match) moduleName = match[1];
    } catch (error) {
        debugIgnoredDetectorError('detectGoProject', error, { path: goModPath, workDir });
    }

    return {
        language: 'Go',
        name: moduleName,
        buildCommand: 'go build ./...',
        testCommand: 'go test ./...',
        lintCommand: 'go vet ./...',
    };
}

function detectPythonProject(workDir: string): ProjectContext {
    let framework: string | undefined;
    let testFramework: string | undefined;

    // 尝试从 pyproject.toml 检测
    const pyprojectPath = path.join(workDir, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
        try {
            const content = fs.readFileSync(pyprojectPath, 'utf-8');
            if (content.includes('django')) framework = 'Django';
            else if (content.includes('fastapi')) framework = 'FastAPI';
            else if (content.includes('flask')) framework = 'Flask';

            if (content.includes('pytest')) testFramework = 'pytest';
        } catch (error) {
            debugIgnoredDetectorError('detectPythonProject.pyproject', error, { path: pyprojectPath });
        }
    }

    // 从 requirements.txt 检测
    const reqPath = path.join(workDir, 'requirements.txt');
    if (!framework && fs.existsSync(reqPath)) {
        try {
            const content = fs.readFileSync(reqPath, 'utf-8');
            if (content.includes('django')) framework = 'Django';
            else if (content.includes('fastapi')) framework = 'FastAPI';
            else if (content.includes('flask')) framework = 'Flask';

            if (!testFramework && content.includes('pytest')) testFramework = 'pytest';
        } catch (error) {
            debugIgnoredDetectorError('detectPythonProject.requirements', error, { path: reqPath });
        }
    }

    return {
        language: 'Python',
        framework,
        testFramework: testFramework || 'pytest',
        testCommand: testFramework === 'pytest' || !testFramework ? 'pytest' : `python -m ${testFramework}`,
        lintCommand: 'ruff check .',
    };
}

function detectRustProject(workDir: string, cargoPath: string): ProjectContext {
    let name: string | undefined;
    try {
        const content = fs.readFileSync(cargoPath, 'utf-8');
        const match = content.match(/^name\s*=\s*"(.+)"/m);
        if (match) name = match[1];
    } catch (error) {
        debugIgnoredDetectorError('detectRustProject', error, { path: cargoPath });
    }

    return {
        language: 'Rust',
        name,
        buildCommand: 'cargo build',
        testCommand: 'cargo test',
        lintCommand: 'cargo clippy',
    };
}

// ========================================================================
// 格式化为 System Prompt 注入片段
// ========================================================================

/**
 * 将项目上下文格式化为简短的 system prompt 片段
 *
 * 设计原则：
 * - 不超过 10 行 — 最小化 token 消耗
 * - 只包含 Agent 需要的**操作性**信息 — 什么命令可以跑
 * - 不包含 Agent 可以自己发现的信息 — 具体文件内容
 */
export function formatProjectContextPrompt(ctx: ProjectContext, language: 'zh' | 'en' = 'zh'): string {
    const lines: string[] = [];

    if (language === 'zh') {
        lines.push('## 项目上下文（自动检测）');
        lines.push(`- 语言: ${ctx.language}${ctx.framework ? ` + ${ctx.framework}` : ''}`);
        if (ctx.name) lines.push(`- 项目名: ${ctx.name}`);
        if (ctx.testFramework) lines.push(`- 测试框架: ${ctx.testFramework}`);
        if (ctx.packageManager) lines.push(`- 包管理器: ${ctx.packageManager}`);
        if (ctx.srcDir) lines.push(`- 源码目录: ${ctx.srcDir}`);

        const cmds: string[] = [];
        if (ctx.buildCommand) cmds.push(`构建: \`${ctx.buildCommand}\``);
        if (ctx.testCommand) cmds.push(`测试: \`${ctx.testCommand}\``);
        if (ctx.lintCommand) cmds.push(`lint: \`${ctx.lintCommand}\``);
        if (cmds.length > 0) {
            lines.push(`- 可用命令: ${cmds.join(' | ')}`);
        }

        // 目录结构
        if (ctx.directoryTree?.length) {
            lines.push('');
            lines.push('### 目录结构');
            lines.push('```');
            lines.push(ctx.directoryTree.join('\n'));
            lines.push('```');
        }

        // 入口文件
        if (ctx.entryFiles?.length) {
            lines.push(`- 入口文件: ${ctx.entryFiles.join(', ')}`);
        }
    } else {
        lines.push('## Project Context (auto-detected)');
        lines.push(`- Language: ${ctx.language}${ctx.framework ? ` + ${ctx.framework}` : ''}`);
        if (ctx.name) lines.push(`- Project: ${ctx.name}`);
        if (ctx.testFramework) lines.push(`- Test framework: ${ctx.testFramework}`);
        if (ctx.packageManager) lines.push(`- Package manager: ${ctx.packageManager}`);
        if (ctx.srcDir) lines.push(`- Source dir: ${ctx.srcDir}`);

        const cmds: string[] = [];
        if (ctx.buildCommand) cmds.push(`build: \`${ctx.buildCommand}\``);
        if (ctx.testCommand) cmds.push(`test: \`${ctx.testCommand}\``);
        if (ctx.lintCommand) cmds.push(`lint: \`${ctx.lintCommand}\``);
        if (cmds.length > 0) {
            lines.push(`- Available commands: ${cmds.join(' | ')}`);
        }

        if (ctx.directoryTree?.length) {
            lines.push('');
            lines.push('### Directory Structure');
            lines.push('```');
            lines.push(ctx.directoryTree.join('\n'));
            lines.push('```');
        }

        if (ctx.entryFiles?.length) {
            lines.push(`- Entry files: ${ctx.entryFiles.join(', ')}`);
        }
    }

    return lines.join('\n');
}

// ========================================================================
// 目录结构扫描（轻量，<50ms）
// ========================================================================

/** 要忽略的目录 */
const IGNORE_DIRS = new Set([
    'node_modules', '.git', '.neox', '__pycache__', '.next', '.nuxt',
    'dist', 'build', 'out', '.cache', 'coverage', '.idea', '.vscode',
    'vendor', 'target', '.svelte-kit', '.output', '.turbo', 'venv',
    '.venv', 'env', '.env', '.tox', 'egg-info', '.eggs',
]);

/**
 * 扫描目录结构（depth 2），生成紧凑的树状行
 * 输出示例：['routes/ (5 files)', 'views/ (8 files)', 'models/ (2 files)']
 */
function scanDirectoryStructure(workDir: string, maxDepth: number = 2): string[] {
    const lines: string[] = [];
    try {
        scanDir(workDir, '', 0, maxDepth, lines);
    } catch (error) {
        debugIgnoredDetectorError('scanDirectoryStructure', error, { workDir, maxDepth });
    }
    return lines.slice(0, 40); // 最多 40 行
}

function scanDir(baseDir: string, relativePath: string, depth: number, maxDepth: number, lines: string[]): void {
    if (depth > maxDepth || lines.length >= 40) return;

    const fullPath = relativePath ? path.join(baseDir, relativePath) : baseDir;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(fullPath, { withFileTypes: true });
    } catch (error) {
        debugIgnoredDetectorError('scanDir.readdir', error, { fullPath, depth });
        return;
    }

    const dirs: string[] = [];
    const files: string[] = [];

    for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.env') continue;
        if (IGNORE_DIRS.has(entry.name)) continue;

        if (entry.isDirectory()) {
            dirs.push(entry.name);
        } else {
            files.push(entry.name);
        }
    }

    // 第一层：列出目录和文件
    const indent = '  '.repeat(depth);

    for (const dir of dirs.sort()) {
        const dirRelPath = relativePath ? `${relativePath}/${dir}` : dir;
        // 统计子文件数量
        let childCount = 0;
        try {
            const children = fs.readdirSync(path.join(baseDir, dirRelPath));
            childCount = children.filter(c => !c.startsWith('.')).length;
        } catch (error) {
            debugIgnoredDetectorError('scanDir.childCount', error, { dirRelPath });
        }
        lines.push(`${indent}${dir}/ (${childCount})`);
        // 递归下一层
        scanDir(baseDir, dirRelPath, depth + 1, maxDepth, lines);
    }

    // 顶层文件只列出关键的
    if (depth === 0 && files.length > 0) {
        const keyFiles = files.filter(f => isKeyFile(f)).sort();
        const otherCount = files.length - keyFiles.length;
        for (const f of keyFiles) {
            lines.push(`${indent}${f}`);
        }
        if (otherCount > 0) {
            lines.push(`${indent}... +${otherCount} other files`);
        }
    }
}

/** 判断是否是值得列出的关键文件 */
function isKeyFile(name: string): boolean {
    const KEY_PATTERNS = [
        /^(app|server|main|index|entry)\.(js|ts|py|go|rs)$/i,
        /^(package|tsconfig|Cargo|go\.mod|pyproject|Makefile|Dockerfile|docker-compose)/i,
        /\.config\.(js|ts|mjs|cjs)$/i,
        /^(README|CHANGELOG|LICENSE)/i,
    ];
    return KEY_PATTERNS.some(p => p.test(name));
}

/** 查找项目入口文件 */
function findEntryFiles(workDir: string): string[] {
    const ENTRY_CANDIDATES = [
        'app.js', 'app.ts', 'server.js', 'server.ts',
        'main.js', 'main.ts', 'main.py', 'main.go',
        'index.js', 'index.ts', 'index.html',
        'src/index.js', 'src/index.ts', 'src/main.ts', 'src/main.js',
        'src/app.ts', 'src/app.js',
        'cmd/main.go', 'src/main.rs', 'src/lib.rs',
    ];
    const found: string[] = [];
    for (const candidate of ENTRY_CANDIDATES) {
        if (fs.existsSync(path.join(workDir, candidate))) {
            found.push(candidate);
        }
    }
    return found;
}

/**
 * 清除缓存（测试用）
 */
export function clearProjectContextCache(): void {
    detectionCache.clear();
}
