/**
 * Terminal Service - Electron 主进程端的终端管理服务
 * 使用 node-pty 创建伪终端，支持完整的 shell 交互
 */

import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import { getShellEnv } from '@neoxlabs/platform/platform/shellEnv.js';

export interface TerminalSession {
  id: string;
  pty: pty.IPty;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  createdAt: number;
}

export interface TerminalOptions {
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export class TerminalService extends EventEmitter {
  private sessions: Map<string, TerminalSession> = new Map();
  private sessionCounter = 0;

  /**
   * 获取默认 shell
   */
  private getDefaultShell(): string {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'cmd.exe';
    }
    return process.env.SHELL || '/bin/bash';
  }

  private getSpawnArgs(shell: string): string[] {
    if (process.platform !== 'win32') return [];
    if (/(^|[\\/])cmd(\.exe)?$/i.test(shell)) return ['/k', 'chcp 65001>nul'];
    return [];
  }

  /**
   * 创建新的终端会话
   */
  createSession(options: TerminalOptions = {}): string {
    const id = `terminal-${++this.sessionCounter}-${Date.now()}`;
    const shell = options.shell || this.getDefaultShell();
    const cwd = options.cwd || process.cwd();
    const cols = options.cols || 120;
    const rows = options.rows || 30;

    // 合并环境变量：使用完整的 shell 环境 + 用户传入的环境
    //
    // PROMPT_EOL_MARK='' — zsh 默认在 stdout 没以换行结尾时显示一个反白 "%" 标记 (历史 BSD csh
    //   兼容). xterm 启动时若 shell 上来就 print 了部分 output 没换行, 用户首行会看到孤零零的 "%",
    //   非常常见的"为啥终端有个 %"困惑. 把这个 env var 设空字符串可以完全禁用此标记.
    //   bash 不受影响 (没这个变量).
    const env = {
      ...getShellEnv(),
      ...options.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PROMPT_EOL_MARK: '',
    } as Record<string, string>;

    try {
      const ptyProcess = pty.spawn(shell, this.getSpawnArgs(shell), {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      });

      const session: TerminalSession = {
        id,
        pty: ptyProcess,
        cwd,
        shell,
        cols,
        rows,
        createdAt: Date.now(),
      };

      // 监听数据输出
      ptyProcess.onData((data: string) => {
        this.emit('data', { sessionId: id, data });
      });

      // 监听退出
      ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
        this.emit('exit', { sessionId: id, exitCode, signal });
        this.sessions.delete(id);
      });

      this.sessions.set(id, session);
      this.emit('created', { sessionId: id, cwd, shell });

      console.log(`[TerminalService] Created session ${id} with shell ${shell} in ${cwd}`);
      return id;
    } catch (error) {
      console.error('[TerminalService] Failed to create session:', error);
      throw error;
    }
  }

  /**
   * 向终端写入数据
   */
  write(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(`[TerminalService] Session ${sessionId} not found`);
      return false;
    }
    session.pty.write(data);
    return true;
  }

  /**
   * 调整终端大小
   */
  resize(sessionId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
    return true;
  }

  /**
   * 销毁终端会话
   */
  destroy(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    session.pty.kill();
    this.sessions.delete(sessionId);
    this.emit('destroyed', { sessionId });
    console.log(`[TerminalService] Destroyed session ${sessionId}`);
    return true;
  }

  /**
   * 获取会话信息
   */
  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 获取所有会话
   */
  getAllSessions(): TerminalSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * 执行命令并等待完成（用于 LLM 调用）
   */
  async executeCommand(
    sessionId: string,
    command: string,
    timeout: number = 30000
  ): Promise<{ output: string; exitCode?: number }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    return new Promise((resolve, reject) => {
      let output = '';
      const startMarker = `__CMD_START_${Date.now()}__`;
      const endMarker = `__CMD_END_${Date.now()}__`;

      const dataHandler = ({ sessionId: sid, data }: { sessionId: string; data: string }) => {
        if (sid !== sessionId) return;
        output += data;

        // 检查是否完成
        if (output.includes(endMarker)) {
          cleanup();
          // 提取命令输出
          const startIdx = output.indexOf(startMarker);
          const endIdx = output.indexOf(endMarker);
          if (startIdx !== -1 && endIdx !== -1) {
            const cmdOutput = output
              .slice(startIdx + startMarker.length, endIdx)
              .trim()
              .replace(/\r\n/g, '\n')
              .replace(/\r/g, '\n');
            resolve({ output: cmdOutput });
          } else {
            resolve({ output: output.trim() });
          }
        }
      };

      const cleanup = () => {
        this.off('data', dataHandler);
        clearTimeout(timer);
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Command timeout after ${timeout}ms`));
      }, timeout);

      this.on('data', dataHandler);

      // 发送命令，使用标记来识别输出边界
      const wrappedCommand = `echo "${startMarker}" && ${command} ; echo "${endMarker}"\n`;
      session.pty.write(wrappedCommand);
    });
  }

  /**
   * 清理所有会话
   */
  destroyAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.destroy(sessionId);
    }
  }
}

// 单例
let terminalServiceInstance: TerminalService | null = null;

export function getTerminalService(): TerminalService {
  if (!terminalServiceInstance) {
    terminalServiceInstance = new TerminalService();
  }
  return terminalServiceInstance;
}
