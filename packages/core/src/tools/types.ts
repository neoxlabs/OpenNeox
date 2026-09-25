/**
 * Tool Types and Configurations
 */

/**
 * Code execution environment configuration
 */
export interface CodeExecutionConfig {
  /**
   * Maximum execution time in milliseconds
   * @default 30000 (30 seconds)
   */
  timeout?: number;

  /**
   * Maximum memory usage in MB (only works with Docker)
   * @default undefined (no limit)
   */
  maxMemoryMB?: number;

  /**
   * Maximum CPU usage percentage (only works with Docker)
   * @default undefined (no limit)
   */
  maxCPUPercent?: number;

  /**
   * Allow network access
   * @default true
   */
  allowNetwork?: boolean;

  /**
   * Allow file system access (read/write)
   * @default true
   */
  allowFileSystem?: boolean;

  /**
   * Working directory for code execution
   * @default process.cwd()
   */
  workingDirectory?: string;

  /**
   * Environment variables
   * @default process.env
   */
  env?: Record<string, string>;

  /**
   * Capture images/plots generated during execution
   * @default false
   */
  captureImages?: boolean;

  /**
   * Maximum output size in characters
   * @default 10000
   */
  maxOutputSize?: number;
}

/**
 * Code execution result
 */
export interface CodeExecutionResult {
  /**
   * Whether execution was successful
   */
  success: boolean;

  /**
   * 解释器本身没装 —— 这是**前置条件不具备**, 不是代码跑挂了。
   * 工具包装层据此出 `precondition: true` 的信封, 界面不弹红卡。
   */
  runtimeMissing?: boolean;

  /**
   * Standard output
   */
  stdout: string;

  /**
   * Standard error
   */
  stderr: string;

  /**
   * Exit code (0 = success)
   */
  exitCode: number;

  /**
   * Execution time in milliseconds
   */
  executionTime: number;

  /**
   * Error message if execution failed
   */
  error?: string;

  /**
   * Generated images (base64 or file paths)
   */
  images?: Array<{
    type: 'base64' | 'file';
    data: string;
    filename?: string;
  }>;

 /**
  * Whether execution timed out
  */
  timedOut?: boolean;

  /**
   * Full command line used to execute the code (for logging/debugging)
   */
  command?: string;

  /**
   * Working directory used when executing the command
   */
  workingDirectory?: string;
}

/**
 * Supported programming languages
 */
export type SupportedLanguage = 'python' | 'javascript' | 'typescript' | 'bash' | 'shell';

/**
 * Language runtime configuration
 */
export interface LanguageRuntime {
  /**
   * Command to execute the code
   */
  command: string;

  /**
   * Arguments template (use {file} placeholder)
   */
  args: string[];

  /**
   * File extension
   */
  extension: string;

  /**
   * Whether to use temp file or stdin
   */
  useTempFile: boolean;
}
