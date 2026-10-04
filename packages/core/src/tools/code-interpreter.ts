/**
 * Code Interpreter Tool - Execute code in multiple languages
 * Supports: Python, JavaScript, TypeScript, Bash/Shell
 */

import { execa } from 'execa';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { getShellEnv } from '@neoxlabs/platform/platform/shellEnv.js';
import type {
  CodeExecutionConfig,
  CodeExecutionResult,
  SupportedLanguage,
  LanguageRuntime,
} from './types.js';

/**
 * Language runtime configurations
 */
const LANGUAGE_RUNTIMES: Record<SupportedLanguage, LanguageRuntime> = {
  python: {
    command: 'python3',
    args: ['{file}'],
    extension: '.py',
    useTempFile: true,
  },
  javascript: {
    command: 'node',
    args: ['{file}'],
    extension: '.js',
    useTempFile: true,
  },
  typescript: {
    command: 'npx',
    args: ['tsx', '{file}'],
    extension: '.ts',
    useTempFile: true,
  },
  bash: {
    command: 'bash',
    args: ['{file}'],
    extension: '.sh',
    useTempFile: true,
  },
  shell: {
    command: 'sh',
    args: ['{file}'],
    extension: '.sh',
    useTempFile: true,
  },
};

/**
 * 运行时候选命令（win 平台映射 + 常见安装路径回退）。
 * 顺序即优先级：resolveRuntime 逐个探测 --version，取第一个可用者。
 * - win 无裸 `python3`（多为 Store stub）→ 回退 `python` / `py`
 * - win 无裸 `bash` → 回退 git-bash 常见安装路径
 * - node / npx 不在进程 PATH 时回退默认安装目录（Electron 启动 PATH 可能精简）
 */
const RUNTIME_CANDIDATES: Record<SupportedLanguage, string[]> = {
  python: process.platform === 'win32'
    ? ['python3', 'python', 'py', 'C:\\Windows\\py.exe']
    : ['python3', 'python'],
  javascript: process.platform === 'win32'
    ? ['node', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe']
    : ['node'],
  typescript: process.platform === 'win32' ? ['npx', 'npx.cmd'] : ['npx'],
  bash: process.platform === 'win32'
    ? [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        // 兜底: system32\bash.exe 是 WSL launcher, 不认 Windows 路径, 只放最后
        'bash',
      ]
    : ['bash'],
  shell: process.platform === 'win32'
    ? [
        'C:\\Program Files\\Git\\bin\\sh.exe',
        'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
        'C:\\Program Files (x86)\\Git\\bin\\sh.exe',
        'sh',
      ]
    : ['sh'],
};

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<CodeExecutionConfig> = {
  timeout: 30000, // 30 seconds
  maxMemoryMB: 512,
  maxCPUPercent: 50,
  allowNetwork: true,
  allowFileSystem: true,
  workingDirectory: process.cwd(),
  env: {},
  captureImages: false,
  maxOutputSize: 10000,
};

/**
 * Code Interpreter - Execute code safely with configurable restrictions
 */
export class CodeInterpreter {
  private config: Required<CodeExecutionConfig>;

  constructor(config: CodeExecutionConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute code in the specified language
   */
  async execute(code: string, language: SupportedLanguage): Promise<CodeExecutionResult> {
    const startTime = Date.now();
    const runtime = LANGUAGE_RUNTIMES[language];

    if (!runtime) {
      return {
        success: false,
        stdout: '',
        stderr: '',
        exitCode: 1,
        executionTime: 0,
        error: `Unsupported language: ${language}`,
      };
    }

    // Resolve runtime: win 平台映射 + 常见安装路径回退, 取第一个可用候选命令
    const runtimeCommand = await this.resolveRuntime(language, runtime.command);
    if (!runtimeCommand) {
      /* 诊断: runtime 找不到时给用户具体的 PATH 信息, 让 he/she 知道是装了
       * 但 desktop spawn 找不到, 还是真没装. macOS Electron 经典 PATH 缺失问题. */
      /* 探测用的是登录 shell 快照 (见 checkRuntimeAvailable), 所以走到这里基本就是
       * **真没装**。仍然把当时用的 PATH 报出来, 万一是快照本身出了问题好一眼看出。 */
      const pathDiag = getShellEnv().PATH ?? '<unset>';
      const candidates = (RUNTIME_CANDIDATES[language] ?? [runtime.command]).join(' / ');
      return {
        success: false,
        runtimeMissing: true,
        stdout: '',
        stderr: '',
        exitCode: 1,
        executionTime: 0,
        error: `${runtime.command} is not installed on this machine — install it to run ${language} code.`
          + `\n(looked for: ${candidates}; PATH=${pathDiag.substring(0, 300)}${pathDiag.length > 300 ? '…' : ''})`,
      };
    }

    let tempFile: string | null = null;

    try {
      // Create temp file
      if (runtime.useTempFile) {
        tempFile = await this.createTempFile(code, runtime.extension);
      }

      // Build command
      const args = runtime.args.map(arg => arg.replace('{file}', tempFile || ''));
      const cwd = this.config.workingDirectory;
      const commandLine = [runtimeCommand, ...args].join(' ');

      const env: Record<string, string> = {
        ...getShellEnv(),
        ...this.config.env,
      };

      // Add Python-specific env vars for image capture
      if (language === 'python' && this.config.captureImages) {
        env.MPLBACKEND = 'Agg'; // Non-interactive backend for matplotlib
      }

      // Execute code
      const result = await this.executeCommand(
        runtimeCommand,
        args,
        env,
        cwd
      );

      // Capture images if enabled
      let images: Array<{ type: 'base64' | 'file'; data: string; filename?: string }> = [];
      if (this.config.captureImages && tempFile) {
        images = await this.captureGeneratedImages(path.dirname(tempFile));
      }

      const executionTime = Date.now() - startTime;

      return {
        ...result,
        executionTime,
        command: commandLine,
        workingDirectory: cwd,
        images: images && images.length > 0 ? images : undefined,
      };
    } catch (error: any) {
      const executionTime = Date.now() - startTime;

      return {
        success: false,
        stdout: error.stdout || '',
        stderr: error.stderr || '',
        exitCode: error.exitCode || 1,
        executionTime,
        error: error.message,
        timedOut: error.timedOut || false,
      };
    } finally {
      // Cleanup temp file
      if (tempFile) {
        await this.cleanupTempFile(tempFile);
      }
    }
  }

  /**
   * Resolve the first available runtime command from candidates.
   * Win 上 python3/bash 常不可用（Store stub / 无裸 bash），逐个候选探测取可用者。
   */
  private async resolveRuntime(
    language: SupportedLanguage,
    fallback: string,
  ): Promise<string | null> {
    const candidates = RUNTIME_CANDIDATES[language] ?? [fallback];
    for (const candidate of candidates) {
      if (await this.checkRuntimeAvailable(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Check if runtime is available
   */
  private async checkRuntimeAvailable(command: string): Promise<boolean> {
    try {
      await execa(command, ['--version'], { timeout: 5000, env: getShellEnv() });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create temporary file with code
   */
  private async createTempFile(code: string, extension: string): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-code-'));
    const tempFile = path.join(tempDir, `script${extension}`);
    await fs.writeFile(tempFile, code, 'utf-8');
    return tempFile;
  }

  /**
   * Execute command with proper configuration
   */
  private async executeCommand(
    command: string,
    args: string[],
    env: Record<string, string>,
    cwd: string
  ): Promise<Omit<CodeExecutionResult, 'executionTime'>> {
    try {
      const { stdout, stderr, exitCode } = await execa(command, args, {
        timeout: this.config.timeout,
        cwd,
        env,
        all: true,
        reject: false, // Don't throw on non-zero exit code
      });

      // Truncate output if too large
      const truncatedStdout = this.truncateOutput(stdout);
      const truncatedStderr = this.truncateOutput(stderr);

      return {
        success: exitCode === 0,
        stdout: truncatedStdout,
        stderr: truncatedStderr,
        exitCode: exitCode || 0,
      };
    } catch (error: any) {
      if (error.timedOut) {
        throw {
          stdout: error.stdout || '',
          stderr: error.stderr || '',
          exitCode: -1,
          message: `Execution timed out after ${this.config.timeout}ms`,
          timedOut: true,
        };
      }

      throw {
        stdout: error.stdout || '',
        stderr: error.stderr || '',
        exitCode: error.exitCode || 1,
        message: error.message,
      };
    }
  }

  /**
   * Truncate output if it exceeds max size
   */
  private truncateOutput(output: string): string {
    if (output.length <= this.config.maxOutputSize) {
      return output;
    }

    const half = Math.floor(this.config.maxOutputSize / 2);
    const truncated = output.slice(0, half) +
      `\n\n... [Truncated ${output.length - this.config.maxOutputSize} characters] ...\n\n` +
      output.slice(-half);

    return truncated;
  }

  /**
   * Capture images generated during execution (PNG, JPG, SVG)
   */
  private async captureGeneratedImages(
    directory: string
  ): Promise<Array<{ type: 'base64' | 'file'; data: string; filename?: string }>> {
    try {
      const files = await fs.readdir(directory);
      const imageFiles = files.filter(f =>
        /\.(png|jpg|jpeg|svg)$/i.test(f)
      );

      const images: Array<{ type: 'base64' | 'file'; data: string; filename?: string }> = [];

      for (const file of imageFiles) {
        const filePath = path.join(directory, file);
        const data = await fs.readFile(filePath);
        const base64 = data.toString('base64');

        images.push({
          type: 'base64',
          data: base64,
          filename: file,
        });
      }

      return images;
    } catch {
      return [];
    }
  }

  /**
   * Cleanup temporary file and directory
   */
  private async cleanupTempFile(tempFile: string): Promise<void> {
    try {
      const tempDir = path.dirname(tempFile);
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Format execution result as string for LLM
   */
  static formatResult(result: CodeExecutionResult): string {
    const lines: string[] = [];

    if (result.success) {
      lines.push('✅ Code executed successfully\n');
    } else {
      lines.push('❌ Code execution failed\n');
    }

    lines.push(`⏱️  Execution time: ${result.executionTime}ms`);
    lines.push(`🔢 Exit code: ${result.exitCode}`);

    if (result.command || result.workingDirectory) {
      lines.push('\n🛠️  Command:');
      if (result.command) {
        lines.push(`$ ${result.command}`);
      }
      if (result.workingDirectory) {
        lines.push(`CWD: ${result.workingDirectory}`);
      }
    }

    if (result.timedOut) {
      lines.push('⏰ Execution timed out');
    }

    if (result.stdout) {
      lines.push('\n📤 Output:');
      lines.push('```');
      lines.push(result.stdout);
      lines.push('```');
    }

    if (result.stderr) {
      lines.push('\n⚠️  Errors/Warnings:');
      lines.push('```');
      lines.push(result.stderr);
      lines.push('```');
    }

    if (result.error) {
      lines.push('\n❌ Error:');
      lines.push(result.error);
    }

    if (result.images && result.images.length > 0) {
      lines.push(`\n🖼️  Generated ${result.images.length} image(s):`);
      result.images.forEach((img, i) => {
        lines.push(`  ${i + 1}. ${img.filename || 'image'} (${img.type})`);
      });
    }

    return lines.join('\n');
  }
}

/**
 * Create a singleton instance with default config
 */
export const defaultInterpreter = new CodeInterpreter();

/**
 * Convenience function to execute code
 */
export async function executeCode(
  code: string,
  language: SupportedLanguage,
  config?: CodeExecutionConfig
): Promise<CodeExecutionResult> {
  const interpreter = config ? new CodeInterpreter(config) : defaultInterpreter;
  return interpreter.execute(code, language);
}
