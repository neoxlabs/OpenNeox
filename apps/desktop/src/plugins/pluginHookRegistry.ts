/**
 * Plugin Hook Registry — 全局插件 hook 注册表
 *
 * 插件通过 manifest.hooks 或独立 JSON 文件声明 pre/post toolCall hooks,
 * 加载时进入本注册表. toolPipeline 运行时调 matchAndRun() 查匹配的 hook.
 *
 * Hook 语义 (对齐 Claude Code + 现有 userHooks):
 *   - 每个 hook = { toolPattern: glob, command: shell 命令 }
 *   - preToolCall: exit 1/2 可阻止工具执行 (exit 2 可带替代输出)
 *   - postToolCall: fire-and-forget, 不影响主流程
 *   - 执行超时 10s, 结果 stdout 限 1MB
 *
 * 与 userHooks 区别:
 *   userHooks = 用户 `.neox/hooks/` 下的脚本, 只有一种 (按类型)
 *   pluginHooks = 多个插件各自声明, 按 toolName glob 匹配多条, 互相独立
 */

import { execFile } from 'child_process';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { PluginHookConfig, PluginHookEntry } from '@neoxlabs/platform/shared/plugin-types.js';

// ==================== 类型 ====================

export type PluginHookPhase = 'preToolCall' | 'postToolCall';

export interface RegisteredPluginHook {
  pluginName: string;
  phase: PluginHookPhase;
  toolPattern: string;
  command: string;
}

export interface PluginHookRunResult {
  /** 匹配并执行的 hook 数 */
  executed: number;
  /** pre-hook 是否被阻止 (任一 hook exit 1/2 即阻止) */
  blocked: boolean;
  /** 阻止来源 (pluginName) */
  blockedBy?: string;
  /** 替代输出 (exit 2 时的 stdout, 首个非空者优先) */
  alternateResult?: string;
  /** 拒绝原因消息 (stderr) */
  reason?: string;
}

// ==================== Glob 匹配 ====================

function globToRegex(pattern: string): RegExp {
  // toolPattern 用 glob 形式匹配 toolName, 不涉及路径, 所以简化版:
  //   *  → 任意非空字符 (包含空字符串)
  //   **  → 任意 (同 *, 工具名里无分隔符)
  //   ?  → 单字符
  let escaped = '';
  for (const ch of pattern) {
    if (ch === '*') escaped += '.*';
    else if (ch === '?') escaped += '.';
    else if (/[.+^${}()|[\]\\]/.test(ch)) escaped += '\\' + ch;
    else escaped += ch;
  }
  return new RegExp(`^${escaped}$`);
}

function matchPattern(pattern: string, toolName: string): boolean {
  if (pattern === '*' || pattern === '**') return true;
  if (pattern === toolName) return true;
  try {
    return globToRegex(pattern).test(toolName);
  } catch {
    return false;
  }
}

// ==================== Registry ====================

const HOOK_TIMEOUT_MS = 10_000;
const HOOK_MAX_BUFFER = 1024 * 1024;

export class PluginHookRegistry {
  private hooks: RegisteredPluginHook[] = [];

  /** 注册一个插件的所有 hooks. 返回本次注册条数. */
  registerPluginHooks(pluginName: string, config: PluginHookConfig): number {
    let count = 0;

    const addPhase = (phase: PluginHookPhase, entries?: PluginHookEntry[]) => {
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        if (!entry?.toolPattern || !entry?.command) continue;
        this.hooks.push({
          pluginName,
          phase,
          toolPattern: entry.toolPattern,
          command: entry.command,
        });
        count++;
      }
    };

    addPhase('preToolCall', config.preToolCall);
    addPhase('postToolCall', config.postToolCall);

    return count;
  }

  /** 移除某插件的所有 hooks (卸载 / disable 时用). */
  unregisterPlugin(pluginName: string): number {
    const before = this.hooks.length;
    this.hooks = this.hooks.filter(h => h.pluginName !== pluginName);
    return before - this.hooks.length;
  }

  /** 列出所有已注册的 hooks (调试用). */
  list(): ReadonlyArray<RegisteredPluginHook> {
    return this.hooks;
  }

  /** 仅当有 hook 时才走匹配 — toolPipeline 用它做快速短路. */
  hasAny(phase?: PluginHookPhase): boolean {
    if (!phase) return this.hooks.length > 0;
    return this.hooks.some(h => h.phase === phase);
  }

  /**
   * 匹配并执行 hooks. 顺序: 注册顺序.
   * 任一 preToolCall exit 非 0 即 blocked, 后续不再执行.
   * postToolCall 全部 fire-and-forget.
   */
  async matchAndRun(
    phase: PluginHookPhase,
    toolName: string,
    toolArgs: any,
    workDir: string,
    toolResult?: string,
  ): Promise<PluginHookRunResult> {
    const matches = this.hooks.filter(
      h => h.phase === phase && matchPattern(h.toolPattern, toolName),
    );
    if (matches.length === 0) {
      return { executed: 0, blocked: false };
    }

    const stdinPayload = JSON.stringify({
      phase,
      tool_name: toolName,
      tool_args: toolArgs,
      tool_result: toolResult?.substring(0, 8000),
      workspace: workDir,
      timestamp: new Date().toISOString(),
    });

    let executed = 0;

    for (const hook of matches) {
      if (phase === 'postToolCall') {
        this.runCommand(hook, stdinPayload, workDir).catch(err => {
          cliLogger.debug('PLUGIN_HOOK', `[${hook.pluginName}] postToolCall failed: ${err?.message}`);
        });
        executed++;
        continue;
      }

      // preToolCall: 串行, 任一阻止即短路
      try {
        const result = await this.runCommand(hook, stdinPayload, workDir);
        executed++;
        if (result.exitCode === 1 || result.exitCode === 2) {
          const reason = result.stderr?.trim() || `${hook.pluginName} preToolCall exit ${result.exitCode}`;
          cliLogger.warn('PLUGIN_HOOK', `[${hook.pluginName}] blocked ${toolName}: ${reason}`);
          return {
            executed,
            blocked: true,
            blockedBy: hook.pluginName,
            reason,
            alternateResult: result.exitCode === 2 ? result.stdout : undefined,
          };
        }
      } catch (err: any) {
        cliLogger.debug('PLUGIN_HOOK', `[${hook.pluginName}] preToolCall error: ${err?.message}`);
        // 单个 hook 执行失败不阻止工具调用
      }
    }

    return { executed, blocked: false };
  }

  private runCommand(
    hook: RegisteredPluginHook,
    stdinPayload: string,
    workDir: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        NEOX_PLUGIN_NAME: hook.pluginName,
        NEOX_HOOK_PHASE: hook.phase,
        NEOX_WORKSPACE: workDir,
      };

      // ENOENT 落成 exit 1 + 空 stdout (alternateResult 永远拿不到)。win 走 ComSpec cmd。
      const [shell, shellArgs] = process.platform === 'win32'
        ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', hook.command]]
        : ['/bin/sh', ['-c', hook.command]];
      const child = execFile(
        shell,
        shellArgs,
        {
          env,
          timeout: HOOK_TIMEOUT_MS,
          maxBuffer: HOOK_MAX_BUFFER,
          cwd: workDir,
        },
        (error, stdout, stderr) => {
          // Node execFile: error.code can be:
          //   - string like 'ETIMEDOUT' / 'ENOENT' (node-level error)
          //   - number (process exit code)
          // 另外 signal 终止时 error.signal 非空.
          let exitCode = 0;
          if (error) {
            const anyErr = error as any;
            if (anyErr.code === 'ETIMEDOUT' || anyErr.killed) {
              exitCode = 124;
            } else if (typeof anyErr.code === 'number') {
              exitCode = anyErr.code;
            } else if (typeof anyErr.status === 'number') {
              exitCode = anyErr.status;
            } else {
              exitCode = 1;
            }
          }
          resolve({ exitCode, stdout: stdout || '', stderr: stderr || '' });
        },
      );

      if (child.stdin) {
        /* 钩子提前退出时 EPIPE 是异步 'error' 事件, try/catch 接不住 —— 必须挂监听 */
        child.stdin.on('error', (err: NodeJS.ErrnoException) => {
          cliLogger.debug('PLUGIN_HOOK', `stdin write failed: ${err?.message}`);
        });
        child.stdin.write(stdinPayload);
        child.stdin.end();
      }
    });
  }
}

// ==================== 全局单例 ====================

export const pluginHookRegistry = new PluginHookRegistry();
