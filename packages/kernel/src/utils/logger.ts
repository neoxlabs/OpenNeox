/**
 * File-based logger for debugging and monitoring
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import os from 'os';
import { NEOX_HOME_DIRNAME } from '../platform/neoxHome.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class Logger {
  private logDir: string;
  private enabled: boolean;
  private consoleEnabled: boolean;

  constructor() {
    // Determine log directory based on environment
    this.logDir = this.getLogDirectory();
    // Enable only when file logging is on
    this.enabled = process.env.MARKOR_TRACING === '1';
    // Console output only when explicitly requested (CLI_DEBUG_CONSOLE=1)
    // CLI_DEBUG=1 only enables file logging, not console output
    this.consoleEnabled = process.env.CLI_DEBUG_CONSOLE === '1';

    try {
      this.initLogDir();
      if (this.consoleEnabled) {
        console.log('[Logger] Initialized at:', this.logDir);
      }
    } catch (error: any) {
      console.error('[Logger] Failed to initialize:', error.message);
      this.enabled = false;
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  private getLogDirectory(): string {
    /* 统一写 ~/.neox/logs 跟 cliLogger / neoxLogger / runner.ts 等同口径.
     * 历史问题: dev 路径用 __dirname/../../logs 是仓库内 packages/core/logs,
     * 跟其它 logger 不一致; Bun --compile binary 里 __dirname 是 virtual $bunfs path,
     * '../../logs' 解析到根 '/logs' 写不进去 → EROFS. 统一 user-level 解决两边. */
    // Electron 走 ELECTRON_USER_DATA env (从 main process 注入)
    if (typeof process !== 'undefined' && (process as NodeJS.Process & { type?: string }).type === 'browser') {
      const electronUserData = process.env.ELECTRON_USER_DATA;
      if (electronUserData) {
        return path.join(electronUserData, 'logs');
      }
    }
    // 默认 (cli / binary / Node dev / Electron renderer): ~/.neox/logs
    return path.join(os.homedir(), NEOX_HOME_DIRNAME, 'logs');
  }

  private initLogDir(): void {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        // Silently disable logging if permission denied - don't block CLI
        this.enabled = false;
      } else {
        // Other errors - disable logging but log to console
        console.warn(`[Logger] Warning: Cannot create log directory: ${err.message}`);
        this.enabled = false;
      }
    }
  }

  private getLogFile(category: string): string {
    const date = new Date().toISOString().split('T')[0];
    return path.join(this.logDir, `${category}-${date}.log`);
  }

  private write(category: string, data: any): void {
    if (!this.enabled) return;

    const timestamp = new Date().toISOString();
    const payload = typeof data === 'string' ? { message: data } : data || {};

    // Safe JSON stringify with circular reference handling
    const logEntry = this.safeStringify({ timestamp, ...payload }) + '\n';

    // Write to file if enabled (no console output)
    if (this.enabled) {
      try {
        const logFile = this.getLogFile(category);
        fs.appendFileSync(logFile, logEntry, 'utf-8');
      } catch (error: any) {
        // Permission denied - disable logging to avoid repeated errors
        if (error.code === 'EACCES' || error.code === 'EPERM') {
          this.enabled = false;
        }
        // Silently fail - don't pollute CLI output
      }
    }
  }

  /**
   * Safe JSON stringify that handles circular references and buffers
   */
  private safeStringify(obj: any): string {
    const seen = new WeakSet();

    return JSON.stringify(obj, (key, value) => {
      // Handle circular references
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }

      // Skip problematic properties that cause circular references
      if (key === 'parser' || key === 'socket' || key === '_httpMessage' || key === 'req' || key === 'res') {
        return '[Omitted]';
      }

      // Handle Buffers
      if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
        return '[Buffer]';
      }

      // Handle functions
      if (typeof value === 'function') {
        return '[Function]';
      }

      return value;
    });
  }

  // LLM API logs - detailed request/response logging
  llmRequest(provider: string, model: string, data: any, url?: string, headers?: any): void {
    // Filter tools to remove function implementations (only keep schema)
    const sanitizedTools = data.tools?.map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));

    this.write('llm', {
      type: 'REQUEST',
      provider,
      model,
      url,
      headers,
      messagesCount: data.messages?.length || 0,
      messages: data.messages,
      toolsCount: data.tools?.length || 0,
      tools: sanitizedTools,
      temperature: data.temperature,
    });
  }

  llmResponse(provider: string, duration: number, usage: any, data: any): void {
    this.write('llm', {
      type: 'RESPONSE',
      provider,
      duration: `${duration}ms`,
      usage,
      finishReason: data.finish_reason,
      content: data.content,
      contentLength: data.content?.length || 0,
      toolCallsCount: data.tool_calls?.length || 0,
      toolCalls: data.tool_calls,
    });
  }

  llmError(provider: string, error: any): void {
    // Extract only serializable error info
    const errorInfo: any = {
      type: 'ERROR',
      provider,
      error: error.message,
      status: error.response?.status,
    };

    // Safely extract response data
    if (error.response?.data) {
      try {
        // If it's already an object/string, use it carefully
        const data = error.response.data;
        if (typeof data === 'string') {
          errorInfo.data = data;
        } else if (typeof data === 'object') {
          // Only extract simple properties, avoid circular refs
          errorInfo.data = {
            error: data.error,
            message: data.message,
            type: data.type,
            code: data.code,
          };
        }
      } catch (e) {
        errorInfo.data = '[Could not serialize response data]';
      }
    }

    this.write('llm', errorInfo);
  }

  // Agent logs
  agentStart(task: string): void {
    this.write('agent', {
      type: 'START',
      task,
    });
  }

  agentIteration(iteration: number, action: string): void {
    this.write('agent', {
      type: 'ITERATION',
      iteration,
      action,
    });
  }

  agentComplete(iterations: number, toolCalls: number, usage: any): void {
    this.write('agent', {
      type: 'COMPLETE',
      iterations,
      toolCalls,
      usage,
    });
  }

  agentError(error: string): void {
    this.write('agent', {
      type: 'ERROR',
      error,
    });
  }

  // Tool execution logs
  toolCall(name: string, args: any): void {
    this.write('tool', {
      type: 'CALL',
      tool: name,
      args,
    });
  }

  toolResult(name: string, success: boolean, resultLength: number, duration: number): void {
    this.write('tool', {
      type: 'RESULT',
      tool: name,
      success,
      resultLength,
      duration: `${duration}ms`,
    });
  }

  toolError(name: string, error: string): void {
    this.write('tool', {
      type: 'ERROR',
      tool: name,
      error,
    });
  }
}

export const logger = new Logger();
