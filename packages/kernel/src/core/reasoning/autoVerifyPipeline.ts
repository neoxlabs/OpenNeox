/**
 * AutoVerifyPipeline — 写文件后自动编译/lint 验证
 *
 * 核心设计考量：
 *
 * 1. 不是所有项目都有 tsconfig / go.mod — 只在检测到时才启用
 * 2. 预存在的编译错误 — 只报告**被修改文件**相关的错误，不报告无关错误
 * 3. 超时保护 — 最多等 8 秒，超时直接跳过（不阻塞主循环）
 * 4. 资源节约 — 相同文件 10 秒内不重复验证
 * 5. 只在 mutation 工具成功后触发 — 失败的 edit_file 不验证
 *
 * 为什么不用 LSP：
 * - LSP 需要启动和维护 language server 进程（重量级）
 * - tsc --noEmit 等命令是一次性的，开销可控
 * - 90% 的价值在于"有没有编译错误"，不需要完整的 IDE 功能
 */

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { cliLogger } from '../../platform/cliLogger.js';

/** 验证结果 */
export interface VerifyResult {
    passed: boolean;
    summary: string;     // 一行摘要
    errors?: string;     // 错误详情（截断到 500 字符）
    skipped?: boolean;   // 是否跳过（不支持的文件类型等）
    skipReason?: string;
}

/** 支持的语言检测器 */
interface LanguageVerifier {
    extensions: string[];
    /** 检测项目是否有该语言的编译配置 */
    detect: (workDir: string) => boolean;
    /** 构建验证命令 */
    buildCommand: (filePath: string, workDir: string) => string;
    /** 从命令输出中过滤只和目标文件相关的错误 */
    filterErrors: (output: string, filePath: string) => string;
}

const VERIFIERS: LanguageVerifier[] = [
    {
        // TypeScript / JavaScript with TypeScript config
        extensions: ['.ts', '.tsx', '.js', '.jsx'],
        detect: (workDir) => {
            // 先检查项目根目录
            if (fs.existsSync(path.join(workDir, 'tsconfig.json'))) return true;
            // 再检查是否在 monorepo 子包中
            if (fs.existsSync(path.join(workDir, 'tsconfig.build.json'))) return true;
            return false;
        },
        buildCommand: (filePath, workDir) => {
            // 注意：tsc --noEmit 检查的是整个项目
            // 但我们只过滤目标文件的错误，避免被预存在的错误淹没
            return `cd "${workDir}" && npx tsc --noEmit --pretty false 2>&1 | head -30`;
        },
        filterErrors: (output, filePath) => {
            const basename = path.basename(filePath);
            const lines = output.split('\n');
            const relevant = lines.filter(line =>
                line.includes(basename) || line.includes(filePath)
            );
            if (relevant.length === 0) return ''; // 没有和此文件相关的错误
            return relevant.slice(0, 5).join('\n'); // 最多 5 行
        },
    },
    {
        // Python
        extensions: ['.py'],
        detect: (workDir) => {
            // Python 不需要项目配置，py_compile 始终可用
            try {
                execSync('python3 --version', { timeout: 3000, stdio: 'pipe' });
                return true;
            } catch {
                return false;
            }
        },
        buildCommand: (filePath, _workDir) => {
            // py_compile 只做语法检查，不做类型检查
            return `python3 -c "import py_compile; py_compile.compile('${filePath}', doraise=True)" 2>&1`;
        },
        filterErrors: (output, _filePath) => {
            // Python 编译错误直接就是针对该文件的
            if (output.includes('SyntaxError') || output.includes('Error')) {
                return output.trim().slice(0, 500);
            }
            return '';
        },
    },
    {
        // Go
        extensions: ['.go'],
        detect: (workDir) => {
            return fs.existsSync(path.join(workDir, 'go.mod'));
        },
        buildCommand: (filePath, workDir) => {
            return `cd "${workDir}" && go vet ./... 2>&1 | head -15`;
        },
        filterErrors: (output, filePath) => {
            const basename = path.basename(filePath);
            const lines = output.split('\n');
            const relevant = lines.filter(line => line.includes(basename));
            return relevant.slice(0, 5).join('\n');
        },
    },
    {
        // Rust
        extensions: ['.rs'],
        detect: (workDir) => {
            return fs.existsSync(path.join(workDir, 'Cargo.toml'));
        },
        buildCommand: (filePath, workDir) => {
            return `cd "${workDir}" && cargo check --message-format short 2>&1 | head -15`;
        },
        filterErrors: (output, filePath) => {
            const basename = path.basename(filePath);
            const lines = output.split('\n');
            const relevant = lines.filter(line =>
                line.includes(basename) && line.includes('error')
            );
            return relevant.slice(0, 5).join('\n');
        },
    },
];

/* ==================== 项目级验证命令 (P2-7,) ====================
 *
 * 内置验证器只做"单文件相关的编译错误"; 项目自己声明的验证命令覆盖它 —
 * <workspace>/.neox/settings.json:
 *
 *   { "verify": "npm run typecheck" }                          // 简写
 *   { "verify": { "commands": [
 *       { "command": "npm run typecheck", "matcher": "\\.(ts|tsx)$", "timeout": 60 },
 *       { "command": "cargo check", "matcher": "\\.rs$" } ] } }
 *
 * matcher = 对被修改文件路径的正则 (缺省匹配所有); timeout 秒 (默认 60, 用户显式 opt-in
 * 所以比内置 8s 宽)。命令非零退出 → 输出尾部回注模型。命令级 10s 防抖 (连续多文件
 * 编辑只跑一次全量 typecheck)。
 */
export interface ProjectVerifyCommand {
    command: string;
    matcher?: string;
    /** 秒 */
    timeout?: number;
}

const PROJECT_VERIFY_TIMEOUT_DEFAULT_S = 60;
const PROJECT_VERIFY_OUTPUT_LIMIT = 1500;

export function parseProjectVerifyConfig(raw: unknown): ProjectVerifyCommand[] {
    if (typeof raw === 'string' && raw.trim()) {
        return [{ command: raw.trim() }];
    }
    const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray((raw as any).commands) ? (raw as any).commands : null);
    if (!list) return [];
    return list
        .filter((c: any) => c && typeof c.command === 'string' && c.command.trim())
        .map((c: any) => ({
            command: c.command.trim(),
            matcher: typeof c.matcher === 'string' ? c.matcher : undefined,
            timeout: typeof c.timeout === 'number' && c.timeout > 0 ? c.timeout : undefined,
        }));
}

function projectCommandMatches(cmd: ProjectVerifyCommand, filePath: string): boolean {
    if (!cmd.matcher) return true;
    try {
        return new RegExp(cmd.matcher, 'i').test(filePath);
    } catch {
        return true; // 非法正则 → 宁跑勿漏
    }
}

/** Mutation 工具名称集合 */
const MUTATION_TOOLS = new Set([
    'edit', 'edit_file', 'write_file', 'Edit', 'Write',
    'rename_file', 'create_file',
]);

/** 验证间隔防抖：同一文件 10 秒内不重复验证 */
const VERIFY_DEBOUNCE_MS = 10_000;

/** 验证超时 */
const VERIFY_TIMEOUT_MS = 8_000;

export class AutoVerifyPipeline {
    private workDir: string;
    private verifierCache: Map<string, LanguageVerifier | null> = new Map();
    private lastVerifyTime: Map<string, number> = new Map();
    private enabled: boolean = true;
    private projectDetectionDone: boolean = false;
    private availableVerifiers: LanguageVerifier[] = [];
    /** P2-7: 项目声明的验证命令 (.neox/settings.json "verify"); 非空时对匹配文件替代内置验证 */
    private projectCommands: ProjectVerifyCommand[] = [];
    private lastProjectRunTime: Map<string, number> = new Map();

    constructor(workDir: string) {
        this.workDir = workDir;
    }

    /**
     * 延迟初始化：首次调用时检测项目中可用的验证器
     * 只做一次，结果缓存
     */
    private ensureDetection(): void {
        if (this.projectDetectionDone) return;
        this.projectDetectionDone = true;

        for (const verifier of VERIFIERS) {
            try {
                if (verifier.detect(this.workDir)) {
                    this.availableVerifiers.push(verifier);
                    cliLogger.debug('AUTO_VERIFY', `Verifier available for: ${verifier.extensions.join(', ')}`);
                }
            } catch {
                // 检测失败，跳过该验证器
            }
        }

        /* P2-7: 项目声明的验证命令 — 存在时优先于内置验证器, 且允许在无内置验证器的项目启用 */
        try {
            const settingsPath = path.join(this.workDir, '.neox', 'settings.json');
            if (fs.existsSync(settingsPath)) {
                const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
                this.projectCommands = parseProjectVerifyConfig(parsed?.verify);
                if (this.projectCommands.length > 0) {
                    cliLogger.info('AUTO_VERIFY', `Project verify commands declared: ${this.projectCommands.map(c => c.command).join(' · ')}`);
                }
            }
        } catch (err: any) {
            cliLogger.warn('AUTO_VERIFY', `Failed to load project verify config: ${err?.message}`);
        }

        if (this.availableVerifiers.length === 0 && this.projectCommands.length === 0) {
            this.enabled = false;
            cliLogger.debug('AUTO_VERIFY', 'No verifiers available, pipeline disabled');
        }
    }

    /**
     * 判断是否应该验证此工具调用
     */
    shouldVerify(toolName: string, success: boolean): boolean {
        if (!this.enabled) return false;
        if (!success) return false;
        return MUTATION_TOOLS.has(toolName);
    }

    /**
     * 对指定文件执行自动验证
     *
     * @returns VerifyResult 或 null（不支持/跳过）
     */
    async verify(filePath: string): Promise<VerifyResult | null> {
        this.ensureDetection();

        if (!this.enabled || !filePath) return null;

        // 防抖：10 秒内不重复验证同一文件
        const lastTime = this.lastVerifyTime.get(filePath);
        if (lastTime && Date.now() - lastTime < VERIFY_DEBOUNCE_MS) {
            return null;
        }

        /* P2-7: 项目声明的验证命令优先 — 匹配文件时替代内置单文件检查 (项目最懂自己怎么验) */
        const matchedProjectCommands = this.projectCommands.filter(c => projectCommandMatches(c, filePath));
        if (matchedProjectCommands.length > 0) {
            this.lastVerifyTime.set(filePath, Date.now());
            return this.runProjectCommands(matchedProjectCommands, filePath);
        }

        // 查找匹配的验证器
        const ext = path.extname(filePath).toLowerCase();
        const verifier = this.findVerifier(ext);
        if (!verifier) {
            return { passed: true, skipped: true, summary: '', skipReason: `unsupported extension: ${ext}` };
        }

        this.lastVerifyTime.set(filePath, Date.now());

        try {
            const command = verifier.buildCommand(filePath, this.workDir);
            let output: string;

            try {
                output = execSync(command, {
                    timeout: VERIFY_TIMEOUT_MS,
                    encoding: 'utf-8',
                    cwd: this.workDir,
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
            } catch (execError: any) {
                // execSync 在非零退出码时抛出异常，但 stderr/stdout 在 execError 中
                output = (execError.stdout || '') + (execError.stderr || '');
            }

            // 只过滤和目标文件相关的错误
            const relevantErrors = verifier.filterErrors(output, filePath);

            if (!relevantErrors || relevantErrors.trim() === '') {
                return {
                    passed: true,
                    summary: '✅ No compilation errors in modified file.',
                };
            }

            return {
                passed: false,
                summary: `❌ Compilation errors detected in ${path.basename(filePath)}:`,
                errors: relevantErrors.slice(0, 500),
            };
        } catch (error: any) {
            // 超时或其他异常 → 静默跳过
            cliLogger.debug('AUTO_VERIFY', `Verification failed for ${filePath}: ${error.message}`);
            return {
                passed: true,
                skipped: true,
                summary: '',
                skipReason: error.message?.includes('TIMEOUT') ? 'timeout' : error.message,
            };
        }
    }

    /** P2-7: 执行项目声明的验证命令 (命令级防抖 — 连续多文件编辑只跑一次全量检查) */
    private runProjectCommands(commands: ProjectVerifyCommand[], filePath: string): VerifyResult | null {
        const failures: string[] = [];
        let ranAny = false;

        for (const cmd of commands) {
            const lastRun = this.lastProjectRunTime.get(cmd.command);
            if (lastRun && Date.now() - lastRun < VERIFY_DEBOUNCE_MS) continue;
            this.lastProjectRunTime.set(cmd.command, Date.now());
            ranAny = true;

            const timeoutMs = (cmd.timeout ?? PROJECT_VERIFY_TIMEOUT_DEFAULT_S) * 1000;
            try {
                execSync(cmd.command, {
                    timeout: timeoutMs,
                    encoding: 'utf-8',
                    cwd: this.workDir,
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
            } catch (execError: any) {
                if (execError?.killed || String(execError?.message || '').includes('ETIMEDOUT')) {
                    cliLogger.warn('AUTO_VERIFY', `Project verify timed out (${timeoutMs}ms): ${cmd.command}`);
                    continue; // 超时 → 跳过, 不当失败报 (避免误导模型)
                }
                const output = ((execError?.stdout || '') + (execError?.stderr || '')).trim();
                const tail = output.split('\n').slice(-30).join('\n').slice(-PROJECT_VERIFY_OUTPUT_LIMIT);
                failures.push(`$ ${cmd.command}\n${tail || `(exit ${execError?.status ?? 'nonzero'}, no output)`}`);
            }
        }

        if (!ranAny) return null; // 全部还在防抖窗口内
        if (failures.length === 0) {
            return { passed: true, summary: '✅ Project verification passed.' };
        }
        return {
            passed: false,
            summary: `❌ Project verification failed after modifying ${path.basename(filePath)}:`,
            errors: failures.join('\n\n').slice(0, PROJECT_VERIFY_OUTPUT_LIMIT),
        };
    }

    /**
     * 格式化验证结果为追加到 tool result 的字符串
     */
    formatForToolResult(result: VerifyResult): string {
        if (result.skipped || !result.summary) return '';

        if (result.passed) {
            return `\n\n[Auto-Verify] ${result.summary}`;
        }

        return `\n\n[Auto-Verify] ${result.summary}\n${result.errors || ''}`;
    }

    /**
     * 从工具参数中提取文件路径
     */
    static extractFilePath(toolName: string, args?: Record<string, unknown>): string | undefined {
        if (!args) return undefined;
        return (args.path || args.file_path || args.filePath || args.file || args.target) as string | undefined;
    }

    private findVerifier(ext: string): LanguageVerifier | null {
        if (this.verifierCache.has(ext)) {
            return this.verifierCache.get(ext) || null;
        }

        const found = this.availableVerifiers.find(v => v.extensions.includes(ext)) || null;
        this.verifierCache.set(ext, found);
        return found;
    }

    reset(): void {
        this.lastVerifyTime.clear();
    }
}
