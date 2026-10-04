/**
 * Default Guardrails - 默认安全防护
 *
 * 提供开箱即用的安全防护，解决常见问题：
 * 1. 防止重复写入同一文件
 * 2. 大文件分块写入检查
 * 3. 危险命令检测
 * 4. 路径冲突检测
 */

import type {
  ToolInputGuardrail,
  ToolOutputGuardrail,
  InputGuardrail,
  OutputGuardrail,
  ToolInputGuardrailData,
  GuardrailFunctionOutput,
} from '../types/guardrails.js';

import {
  allowToolGuardrail,
  rejectToolGuardrail,
  raiseExceptionToolGuardrail,
} from '../types/guardrails.js';

import {
  getSessionState,
  findSimilarPath,
  recordFileWrite,
  recordFileEdit,
  isFileWritten,
  getWrittenFileInfo,
  checkDuplicateEdit,
  getEditHistory,
  getFileReadCache,
  getRecentToolCalls,
} from './sessionState.js';

import { cliLogger } from '../platform/cliLogger.js';
import { getKernelConfig } from './kernelConfigBridge.js';
import { evaluateToolRisk, isHighRiskLevel } from './toolRiskEvaluator.js';

import { createHash } from 'crypto';

function parseBooleanFlag(raw: string | undefined): boolean | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function isGuardrailsCompatModeEnabled(): boolean {
  const envFlag = parseBooleanFlag(process.env.NEOX_GUARDRAILS_COMPAT_MODE);
  if (typeof envFlag === 'boolean') {
    return envFlag;
  }

  try {
    return getKernelConfig().experimental?.guardrailsCompatMode === true;
  } catch (err: any) {
    cliLogger.debug('GUARDRAIL', `Config load for compat mode failed: ${err?.message}`);
    return false;
  }
}

const GUARDRAILS_COMPAT_MODE = isGuardrailsCompatModeEnabled();
if (GUARDRAILS_COMPAT_MODE) {
  cliLogger.warn('GUARDRAIL', 'Compatibility mode enabled: dangerous guardrails are disabled in default profile');
}

// ============================================================================
// Tool Input Guardrails
// ============================================================================

/**
 * 防止重复写入同一文件
 *
 * 检测同一会话中对同一文件的重复 write_file 调用，
 * 建议使用 edit 进行增量修改。
 */
export const preventDuplicateWriteGuardrail: ToolInputGuardrail = {
  name: 'prevent_duplicate_write',
  guardrail_function: async (data: ToolInputGuardrailData) => {
    const { tool_name, tool_input } = data.tool_context;

    if (tool_name !== 'write_file') {
      return allowToolGuardrail();
    }

    const filePath = tool_input.file_path as string;
    if (!filePath) {
      return allowToolGuardrail();
    }

    const context = data.context;

    // 检查是否已写入过
    if (isFileWritten(context, filePath)) {
      const info = getWrittenFileInfo(context, filePath);
      const timeSince = info ? Math.round((Date.now() - info.timestamp) / 1000) : 0;

      return rejectToolGuardrail(
        `文件 "${filePath}" 已在本次会话中创建（${timeSince}秒前，${info?.lines || '?'}行）。\n` +
        `请使用 edit 进行修改，而不是重复 write_file。\n` +
        `提示：先用 readfile(path) 看清要改的原文，再用 edit(file_path, old_string, new_string) —— old_string 逐字符照抄文件里的原文。`,
        {
          existing_file: filePath,
          existing_checksum: info?.checksum,
          existing_lines: info?.lines,
          suggestion: 'use edit instead',
        }
      );
    }

    return allowToolGuardrail();
  }
};

/**
 *  edit 前置检查（内容寻址）
 *
 * edit 已改内容寻址: old_string 命中本身就是安全网 —— old_string 存在就直接放行
 * (对不上 edit 自己会报 string_not_found, 不需要门禁拦)。
 * 只有"纯行号桥接"(只发 start_line/end_line, 无 old_string) 才依赖之前读过的账本; 没读过
 * edit 自己会报 need_old_string 引导重读。这里保持不阻断, 只在可疑时记一条日志。
 */
export const requireReadBeforeEditGuardrail: ToolInputGuardrail = {
  name: 'require_read_before_edit',
  guardrail_function: async (data: ToolInputGuardrailData) => {
    const { tool_name, tool_input } = data.tool_context;

    if (tool_name !== 'edit_file' && tool_name !== 'edit') {
      return allowToolGuardrail();
    }

    // old_string 直接给了 → 内容寻址自带安全网, 放行。
    const hasOldString = typeof (tool_input.old_string ?? tool_input.old) === 'string'
      || (Array.isArray(tool_input.hunks) && tool_input.hunks.length > 0);
    if (hasOldString) {
      return allowToolGuardrail();
    }

    // 刚写入的文件也放行 — LLM 知道内容。
    const filePath = tool_input.file_path as string;
    if (filePath && isFileWritten(data.context, filePath)) {
      return allowToolGuardrail();
    }

    // 纯行号桥接且没 old_string: 不阻断 (edit 会从读账本切或报 need_old_string), 记一条日志便于调试。
    if (filePath) {
      cliLogger.warn('GUARDRAIL', `Edit without old_string (line-number bridge): ${filePath}`);
    }

    return allowToolGuardrail();
  }
};

/**
 *  防止重复/幻觉编辑
 *
 * 检测以下 LLM 幻觉模式：
 * 1. 完全相同的编辑（重复调用）
 * 2. 尝试编辑已被修改的内容（old_string 已不存在）
 * 3. 目标内容已存在（new_string 已应用）
 *
 * 这是解决 "edit already applied" 导致无限重试的关键防护。
 */
export const preventDuplicateEditGuardrail: ToolInputGuardrail = {
  name: 'prevent_duplicate_edit',
  guardrail_function: async (data: ToolInputGuardrailData) => {
    const { tool_name, tool_input } = data.tool_context;

    if (tool_name !== 'edit_file' && tool_name !== 'edit') {
      return allowToolGuardrail();
    }
    if (typeof tool_input.patch === 'string' && tool_input.patch.trim().length > 0) {
      return allowToolGuardrail();
    }

    const filePath = tool_input.file_path as string;
    const oldString = tool_input.old_string as string;
    const newString = tool_input.new_string as string;

    if (!filePath || !oldString || !newString) {
      return allowToolGuardrail();
    }

    const context = data.context;

    // 检查是否为重复/幻觉编辑
    const check = checkDuplicateEdit(context, filePath, oldString, newString);

    if (check.isDuplicate) {
      const timeSince = check.previousEdit
        ? Math.round((Date.now() - check.previousEdit.timestamp) / 1000)
        : 0;

      cliLogger.warn('GUARDRAIL', `Blocked duplicate edit on ${filePath}: ${check.reason}`);

      return rejectToolGuardrail(
        `🚫 编辑被阻止 - ${check.reason}\n\n` +
        `文件: ${filePath}\n` +
        `时间: ${timeSince} 秒前\n\n` +
        `💡 建议:\n` +
        `1. 使用 readfile 重新读取文件内容\n` +
        `2. 确认当前文件状态后再决定是否需要编辑\n` +
        `3. 如果目标状态已达成，无需再次编辑`,
        {
          file_path: filePath,
          reason: check.reason,
          previous_edit: check.previousEdit ? {
            old_string: check.previousEdit.oldString.substring(0, 100),
            new_string: check.previousEdit.newString.substring(0, 100),
            timestamp: check.previousEdit.timestamp,
            success: check.previousEdit.success,
          } : undefined,
          suggestion: 'readfile to check current state',
        }
      );
    }

    return allowToolGuardrail();
  }
};

/**
 * 检测相似路径冲突
 *
 * 检测类似 WorkHoursTimer vs WorkHourTimer 的命名不一致问题。
 */
export const similarPathDetectionGuardrail: ToolInputGuardrail = {
  name: 'similar_path_detection',
  guardrail_function: async (data: ToolInputGuardrailData) => {
    const { tool_name, tool_input } = data.tool_context;

    if (tool_name !== 'write_file') {
      return allowToolGuardrail();
    }

    const filePath = tool_input.file_path as string;
    if (!filePath) {
      return allowToolGuardrail();
    }

    const similarPath = findSimilarPath(filePath, data.context);
    if (similarPath) {
      return rejectToolGuardrail(
        `发现相似路径 "${similarPath}"。\n` +
        `当前尝试创建: "${filePath}"\n` +
        `请确认是否拼写错误。如果是同一个文件，请使用 edit 修改现有文件。`,
        {
          attempted_path: filePath,
          similar_path: similarPath,
          suggestion: 'verify path or use edit',
        }
      );
    }

    return allowToolGuardrail();
  }
};

/**
 * 大文件分块写入检查
 *
 * 超过 300 行的文件应该分块写入，避免 token 限制截断。
 */
export const largeFileChunkingGuardrail: ToolInputGuardrail = {
  name: 'large_file_chunking',
  guardrail_function: async (data: ToolInputGuardrailData) => {
    const { tool_name, tool_input } = data.tool_context;

    if (tool_name !== 'write_file') {
      return allowToolGuardrail();
    }

    const content = tool_input.content as string;
    if (!content) {
      return allowToolGuardrail();
    }

    const lines = content.split('\n').length;
    const MAX_LINES = 300;

    if (lines > MAX_LINES) {
      const message =
        `文件超过 ${MAX_LINES} 行（当前 ${lines} 行）。\n` +
        `建议分块写入：先写骨架，再用 edit 按 200 行以内填充。`;

      cliLogger.warn('GUARDRAIL', 'large_file_chunking soft-allow', {
        file_path: tool_input.file_path,
        lines,
        max_lines: MAX_LINES,
        tool_call_id: data.tool_context.tool_call_id,
        agent: data.agent_name,
      });

      // 仅警告，不再硬阻断，避免 Agent 死循环；仍反馈提示信息
      return allowToolGuardrail({
        warning: 'large_file_chunking',
        message,
        actual_lines: lines,
        max_lines: MAX_LINES,
        suggestion: 'write skeleton first, then use edit to fill in',
      });
    }

    return allowToolGuardrail();
  }
};

/**
 * 危险命令检测
 *
 * 检测并阻止可能造成系统损害的命令。
 */
export const dangerousCommandGuardrail: ToolInputGuardrail = {
  name: 'dangerous_command',
  guardrail_function: async (data: ToolInputGuardrailData) => {
    const { tool_name, tool_input } = data.tool_context;

    if (tool_name !== 'execute_shell') {
      return allowToolGuardrail();
    }

    const command = tool_input.command as string;
    if (!command) {
      return allowToolGuardrail();
    }

    const risk = evaluateToolRisk({
      toolName: tool_name,
      args: tool_input as Record<string, any>,
    });
    const shellSignal = risk.signals.find((signal) => signal.domain === 'shell' && isHighRiskLevel(signal.level));
    if (shellSignal) {
      //  使用 reject（软阻断）而非 raiseException（硬终止）
      // raiseException 会杀死整个运行，LLM 无法恢复
      // reject 会把原因反馈给 LLM，让它换一种安全的方式执行
      const isCritical = shellSignal.level === 'critical';
      if (isCritical) {
        // critical 级别（rm -rf /、fork bomb 等）仍然硬阻断
        return raiseExceptionToolGuardrail({
          reason: '检测到危险命令',
          description: shellSignal.message,
          command: command,
          risk_level: shellSignal.level,
          risk_code: shellSignal.code,
        });
      }
      // high 级别（git reset --hard、force push 等）软阻断，给 LLM 反馈
      return rejectToolGuardrail(
        `⚠️ 命令被安全策略阻止: ${shellSignal.message}\n` +
        `命令: ${command.substring(0, 200)}\n` +
        `风险级别: ${shellSignal.level} (${shellSignal.code})\n\n` +
        `请使用更安全的替代方案。如果确实需要执行此操作，请向用户确认。`,
        {
          risk_level: shellSignal.level,
          risk_code: shellSignal.code,
          description: shellSignal.message,
        }
      );
    }

    return allowToolGuardrail();
  }
};

/**
 * SQL 危险操作检测
 */
export const dangerousSqlGuardrail: ToolInputGuardrail = {
  name: 'dangerous_sql',
  guardrail_function: async (data: ToolInputGuardrailData) => {
    const { tool_name, tool_input } = data.tool_context;

    /* 只有 execute_shell —— execute_sql / run_query 从来没被注册成工具, 见
     * toolRiskEvaluator 同处的说明。SQL 都是通过 shell 里的 mysql/psql 等客户端跑的。 */
    const sqlToolNames = ['execute_shell'];
    if (!sqlToolNames.includes(tool_name)) {
      return allowToolGuardrail();
    }

    const content = (tool_input.command || tool_input.query || tool_input.sql || '') as string;
    if (!content) {
      return allowToolGuardrail();
    }

    const risk = evaluateToolRisk({
      toolName: tool_name,
      args: tool_input as Record<string, any>,
    });
    const sqlSignal = risk.signals.find((signal) => signal.domain === 'sql' && isHighRiskLevel(signal.level));
    if (sqlSignal) {
      //  SQL 同理：critical 硬阻断，high 软阻断
      const isCritical = sqlSignal.level === 'critical';
      if (isCritical) {
        return raiseExceptionToolGuardrail({
          reason: '检测到危险 SQL 操作',
          description: sqlSignal.message,
          content: content.substring(0, 200),
          risk_level: sqlSignal.level,
          risk_code: sqlSignal.code,
        });
      }
      return rejectToolGuardrail(
        `⚠️ SQL 操作被安全策略阻止: ${sqlSignal.message}\n` +
        `内容: ${content.substring(0, 200)}\n` +
        `风险级别: ${sqlSignal.level} (${sqlSignal.code})\n\n` +
        `请添加 WHERE 子句或使用更安全的操作。`,
        {
          risk_level: sqlSignal.level,
          risk_code: sqlSignal.code,
          description: sqlSignal.message,
        }
      );
    }

    return allowToolGuardrail();
  }
};

// ============================================================================
// Tool Output Guardrails
// ============================================================================

/**
 * 记录文件写入/编辑状态
 *
 * 在 write_file/edit 成功后记录状态，供后续 Guardrails 使用。
 * 这是一个"透传"型 Guardrail，不阻止任何操作。
 */
export const recordWriteStateGuardrail: ToolOutputGuardrail = {
  name: 'record_write_state',
  guardrail_function: async (data) => {
    const { tool_name, tool_input } = data.tool_context;
    const output = data.output;

    // 尝试解析输出获取状态
    let status = 'unknown';
    try {
      const parsed = JSON.parse(typeof output === 'string' ? output : JSON.stringify(output));
      status = parsed.status || 'unknown';
    } catch (err: any) {
      cliLogger.debug('GUARDRAIL', `Tool output JSON parse failed: ${err?.message}`);
      status = 'success';
    }

    if (tool_name === 'write_file') {
      const filePath = tool_input.file_path as string;
      const content = tool_input.content as string;

      if (status === 'success' && filePath && content) {
        const checksum = createHash('sha256')
          .update(content)
          .digest('hex')
          .substring(0, 16);
        const lines = content.split('\n').length;

        recordFileWrite(data.context, filePath, checksum, lines);
      }
    }

    //  记录 edit 详情（用于检测重复/幻觉编辑）
    if (tool_name === 'edit_file' || tool_name === 'edit') {
      if (typeof tool_input.patch === 'string' && tool_input.patch.trim().length > 0) {
        return {
          output_info: { recorded: true },
          behavior: { type: 'allow' },
        };
      }
      const filePath = tool_input.file_path as string;
      const oldString = tool_input.old_string as string;
      const newString = tool_input.new_string as string;

      if (filePath && oldString !== undefined && newString !== undefined) {
        const success = status === 'success';
        recordFileEdit(data.context, filePath, oldString, newString, success);

        if (success) {
          cliLogger.debug('GUARDRAIL', `Recorded edit: ${filePath} (${oldString.length} -> ${newString.length} chars)`);
        }
      }
    }

    return {
      output_info: { recorded: true },
      behavior: { type: 'allow' },
    };
  }
};

/**
 * 敏感信息输出检测
 *
 * 检测工具输出中的敏感信息（API Keys、密码等）。
 */
export const sensitiveOutputGuardrail: ToolOutputGuardrail = {
  name: 'sensitive_output',
  guardrail_function: async (data) => {
    const output = typeof data.output === 'string'
      ? data.output
      : JSON.stringify(data.output);

    const sensitivePatterns: Array<{ pattern: RegExp; type: string }> = [
      { pattern: /sk-[a-zA-Z0-9]{20,}/, type: 'OpenAI API Key' },
      { pattern: /AKIA[A-Z0-9]{16}/, type: 'AWS Access Key' },
      { pattern: /ghp_[a-zA-Z0-9]{36}/, type: 'GitHub Token' },
      { pattern: /xox[baprs]-[a-zA-Z0-9-]+/, type: 'Slack Token' },
      { pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/, type: 'Private Key' },
    ];

    for (const { pattern, type } of sensitivePatterns) {
      if (pattern.test(output)) {
        return {
          output_info: {
            warning: `检测到可能的 ${type}`,
            suggestion: '请确保不要在输出中暴露敏感凭证',
          },
          behavior: {
            type: 'reject_content',
            message: `[输出已过滤：检测到可能的 ${type}]`,
          },
        };
      }
    }

    return {
      output_info: { clean: true },
      behavior: { type: 'allow' },
    };
  }
};

// ============================================================================
// Input Guardrails
// ============================================================================

/**
 * 输入长度限制
 */
export const inputLengthGuardrail: InputGuardrail = {
  name: 'input_length_limit',
  guardrail_function: async (context, agentName, input): Promise<GuardrailFunctionOutput> => {
    const inputText = typeof input === 'string' ? input : JSON.stringify(input);
    const MAX_LENGTH = 100_000; // 100KB

    if (inputText.length > MAX_LENGTH) {
      return {
        tripwire_triggered: true,
        output_info: {
          reason: '输入过长',
          actual_length: inputText.length,
          max_length: MAX_LENGTH,
          suggestion: '请分批提交或简化输入',
        }
      };
    }

    return { tripwire_triggered: false };
  }
};

/**
 * 敏感信息输入检测
 */
export const sensitiveInputGuardrail: InputGuardrail = {
  name: 'sensitive_input_detector',
  guardrail_function: async (context, agentName, input): Promise<GuardrailFunctionOutput> => {
    const inputText = typeof input === 'string' ? input : JSON.stringify(input);

    // 检测 API Keys 模式
    const apiKeyPatterns: Array<{ pattern: RegExp; type: string }> = [
      { pattern: /sk-[a-zA-Z0-9]{20,}/, type: 'OpenAI API Key' },
      { pattern: /AKIA[A-Z0-9]{16}/, type: 'AWS Access Key' },
      { pattern: /ghp_[a-zA-Z0-9]{36}/, type: 'GitHub Token' },
    ];

    for (const { pattern, type } of apiKeyPatterns) {
      if (pattern.test(inputText)) {
        return {
          tripwire_triggered: true,
          output_info: {
            reason: `检测到可能的 ${type}`,
            suggestion: '请勿在对话中暴露敏感凭证',
          }
        };
      }
    }

    return { tripwire_triggered: false };
  }
};

// ============================================================================
// Output Guardrails
// ============================================================================

/**
 * 输出长度限制
 */
export const outputLengthGuardrail: OutputGuardrail = {
  name: 'output_length_limit',
  guardrail_function: async (context, agentName, output): Promise<GuardrailFunctionOutput> => {
    const outputText = typeof output === 'string' ? output : JSON.stringify(output);
    const MAX_LENGTH = 50_000; // 50KB

    if (outputText.length > MAX_LENGTH) {
      return {
        tripwire_triggered: true,
        output_info: {
          reason: '输出过长',
          actual_length: outputText.length,
          max_length: MAX_LENGTH,
        }
      };
    }

    return { tripwire_triggered: false };
  }
};

// ============================================================================
// Guardrail 预设组合
// ============================================================================

/**
 * 默认 Tool Input Guardrails
 *
 * 推荐用于生产环境的安全防护组合。
 */
export const DEFAULT_TOOL_INPUT_GUARDRAILS: ToolInputGuardrail[] = [
  // preventDuplicateWriteGuardrail,
  requireReadBeforeEditGuardrail, // 策略：必须先 readfile 才能 edit
  // preventDuplicateEditGuardrail,  // 防止重复/幻觉编辑
  // similarPathDetectionGuardrail,
  // largeFileChunkingGuardrail,
  //
  // dangerousCommandGuardrail / dangerousSqlGuardrail 不在默认集 —— 危险命令防线
  // 由两层机制承担:
  //   1. 有人值守: PermissionManager.resolveEffectivePermission — Auto/Manual 档下
  //      high·critical 走 ASK; dangerous 档一律放行。
  //   2. 无人值守 (Auto 模式/子 Agent, shouldAutoApprove=true): runner 挂 critical-only
  //      RiskEvaluator, gate stage A 硬拦 critical 并终止循环 —— dangerous 档下这条闸
  //      整个不挂 (runner.ts attachUnattendedRiskGate), 否则 yolo 还是跑不动。
  // 若把 guardrail 放回默认集, 它会在 gate stage B (permission 之前) 硬拦 critical,
  // 用户显式批准的通道就没了 — 保留用户最终控制权, 不走这条路。
];

/**
 * 默认 Tool Output Guardrails
 */
export const DEFAULT_TOOL_OUTPUT_GUARDRAILS: ToolOutputGuardrail[] = [
  // recordWriteStateGuardrail,
  // sensitiveOutputGuardrail,  // 可选，可能产生误报
];

/**
 * 默认 Input Guardrails
 */
export const DEFAULT_INPUT_GUARDRAILS: InputGuardrail[] = [
  // inputLengthGuardrail,
  // sensitiveInputGuardrail,  // 可选，可能产生误报
];

/**
 * 默认 Output Guardrails
 */
export const DEFAULT_OUTPUT_GUARDRAILS: OutputGuardrail[] = [
  outputLengthGuardrail,
];

/**
 * 严格模式 - 所有 Guardrails
 */
export const STRICT_GUARDRAILS = {
  inputGuardrails: [inputLengthGuardrail, sensitiveInputGuardrail],
  outputGuardrails: [outputLengthGuardrail],
  toolInputGuardrails: DEFAULT_TOOL_INPUT_GUARDRAILS,
  toolOutputGuardrails: [recordWriteStateGuardrail, sensitiveOutputGuardrail],
};

/**
 * 宽松模式 - 最小 Guardrails
 */
export const MINIMAL_GUARDRAILS = {
  inputGuardrails: [],
  outputGuardrails: [],
  toolInputGuardrails: [],
  toolOutputGuardrails: [recordWriteStateGuardrail],
};
