/**
 * Init Command — /init 项目记忆初始化
 *
 * /init           — 交互式选择
 * /init project   — 只生成 project.md
 * /init deep      — project.md + 所有模块
 * /init module <path> — 指定目录
 */

import type { SelectionChoice } from '../cliTypes.js';
import type { ActionLogService } from '@neoxlabs/core/platform/actionLog/index.js';
import { runInit, type InitScope } from '@neoxlabs/core/memory/moduleContext.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ============================================================================
// 类型
// ============================================================================

export interface InitCommandContext {
  workDir: string;
  actionLog: ActionLogService;
  promptSelect: (
    question: string,
    choices: SelectionChoice[],
    defaultValue?: string,
    hint?: string,
  ) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
  /** LLM 调用（由运行时注入） */
  llmCall: (prompt: string, systemPrompt: string) => Promise<string>;
  /** explore 任务 Agent（可选，deep 模式用） */
  exploreRunner?: (prompt: string) => Promise<string>;
  /** 更新底部状态栏文字 */
  setStatusText?: (text: string) => void;
}

// ============================================================================
// 命令入口
// ============================================================================

export async function handleInitCommand(
  ctx: InitCommandContext,
  scopeArg?: string,
  modulePathArg?: string,
): Promise<void> {
  let scope: InitScope;
  let modulePath: string | undefined;

  if (scopeArg === 'project' || scopeArg === 'deep' || scopeArg === 'module') {
    scope = scopeArg;
    modulePath = modulePathArg;
  } else if (scopeArg) {
    // /init <path> — 当作 module 模式
    scope = 'module';
    modulePath = scopeArg;
  } else {
    // 交互式选择
    try {
      const selected = await ctx.promptSelect(
        '项目记忆初始化',
        [
          {
            label: '● 快速初始化 (project)',
            value: 'project',
            description: '只生成 .neox/project.md，1 次 LLM 调用',
          },
          {
            label: '● 深度初始化 (deep)',
            value: 'deep',
            description: '生成 project.md + 所有模块上下文，多次 LLM 调用',
          },
        ],
        'project',
        '↑↓ 选择, Enter 确认, ESC 取消',
      );
      scope = selected as InitScope;
    } catch {
      return;
    }
  }

  if (scope === 'module' && !modulePath) {
    ctx.logInfo('请指定目录路径', '用法: /init module <path>');
    return;
  }

  ctx.logInfo(`开始 ${scope} 初始化...`);
  ctx.setStatusText?.(`/init ${scope} — 初始化中...`);

  try {
    const result = await runInit({
      workDir: ctx.workDir,
      scope,
      modulePath: modulePath ? resolveModulePath(ctx.workDir, modulePath) : undefined,
      llmCall: ctx.llmCall,
      exploreDir: ctx.exploreRunner
        ? async (dirPath: string) => {
            return await ctx.exploreRunner!(
              `分析目录 ${dirPath} 的代码结构：列出关键文件、核心类/函数、导出接口、依赖关系`,
            );
          }
        : undefined,
      maxParallel: 3,
      onProgress: (step, current, total) => {
        ctx.logInfo(`[${current}/${total}] ${step}`);
        ctx.setStatusText?.(`/init ${scope} — [${current}/${total}] ${step}`);
      },
    });

    // 完成后清空 statusline
    ctx.setStatusText?.('');

    // 输出结果
    const lines: string[] = [];
    if (result.projectMdPath) {
      lines.push(`✓ ${result.projectMdPath}`);
    }
    for (const p of result.modulePaths) {
      lines.push(`✓ ${p}`);
    }
    for (const e of result.errors) {
      lines.push(`✗ ${e}`);
    }

    const summary = result.errors.length > 0
      ? `完成（${result.modulePaths.length} 个模块，${result.errors.length} 个错误）`
      : `完成（${result.projectMdPath ? 1 : 0} 个项目 + ${result.modulePaths.length} 个模块）`;

    ctx.logInfo(summary, lines.join('\n'));
  } catch (error: any) {
    ctx.setStatusText?.('');
    cliLogger.error('INIT_CMD', 'Init failed', { error: error.message });
    ctx.logInfo('初始化失败', error.message);
  }
}

function resolveModulePath(workDir: string, input: string): string {
  const { resolve, isAbsolute } = require('path');
  return isAbsolute(input) ? input : resolve(workDir, input);
}
