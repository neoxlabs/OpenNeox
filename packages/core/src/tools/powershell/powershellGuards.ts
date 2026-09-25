/**
 * PowerShell 命令守卫 — 沙箱验证 + 风险评估
 *
 * 参考 Claude Code: gitSafety.ts + readOnlyValidation.ts
 */

import type { PlatformLogger } from '@neoxlabs/platform/platform/services.js';
import {
  resolveToCanonical,
  isReadOnlyCommand,
  analyzePowerShellSecurity,
  getDestructiveCommandWarning,
  isGitInternalPath,
} from './powershellSecurity.js';

// ============================================================================
// 沙箱模式白名单
// ============================================================================

/** PowerShell 沙箱模式安全 cmdlet */
const PS_SANDBOX_SAFE_CMDLETS = new Set([
  // 获取类
  'get-childitem', 'get-content', 'get-item', 'get-itemproperty',
  'get-location', 'get-process', 'get-service', 'get-date',
  'get-host', 'get-member', 'get-command', 'get-help', 'get-alias',
  'get-variable', 'get-history', 'get-culture', 'get-module',
  'get-psdrive', 'get-psprovider', 'get-computerinfo', 'get-timezone',
  'get-hotfix', 'get-counter', 'get-eventlog', 'get-winevent',
  'get-netadapter', 'get-netipaddress', 'get-netroute',
  'get-disk', 'get-volume', 'get-partition',
  // 测试类
  'test-path', 'test-connection', 'test-netconnection',
  // 搜索/过滤
  'select-string', 'select-object', 'select-xml',
  'where-object', 'foreach-object', 'sort-object',
  'group-object', 'measure-object', 'compare-object',
  // 格式化/输出
  'format-list', 'format-table', 'format-wide', 'format-hex', 'format-custom',
  'out-string', 'out-null', 'out-host',
  'write-output', 'write-host', 'write-verbose', 'write-debug', 'write-warning',
  // 转换
  'convertto-json', 'convertfrom-json', 'convertto-csv', 'convertfrom-csv',
  'convertto-xml', 'convertto-html',
  // 路径操作
  'split-path', 'join-path', 'resolve-path', 'convert-path',
  // 常用别名
  'ls', 'dir', 'cat', 'type', 'pwd', 'cd', 'echo',
  'ps', 'sls', 'where', 'sort', 'measure', 'select', 'group',
  'fl', 'ft', 'fw',
]);

// ============================================================================
// 公共接口
// ============================================================================

/**
 * 验证 PowerShell 命令在沙箱模式下是否安全
 *
 * @returns 错误消息（如不安全）或 null（安全）
 */
export function validatePowerShellForSandbox(
  command: string,
  sandboxEnabled: boolean,
): string | null {
  if (!sandboxEnabled) return null;

  // 子表达式在沙箱中禁止
  if (/\$\(/.test(command)) {
    return '🚫 沙箱模式禁止使用子表达式 $()';
  }

  // 变量赋值在沙箱中禁止 (可能改变状态)
  if (/\$\w+\s*=/.test(command) || /\$env:\w+\s*=/.test(command)) {
    return '🚫 沙箱模式禁止变量赋值';
  }

  // 逐段验证 cmdlet
  const segments = command.split(/[;|]/).map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const tokens = seg.split(/\s+/);
    const cmdName = tokens[0];
    if (!cmdName) continue;

    const canonical = resolveToCanonical(cmdName);

    // 先检查白名单
    if (!PS_SANDBOX_SAFE_CMDLETS.has(canonical) && !PS_SANDBOX_SAFE_CMDLETS.has(cmdName.toLowerCase())) {
      const safeList = [...PS_SANDBOX_SAFE_CMDLETS].filter(c => c.startsWith('get-') || c.startsWith('test-')).slice(0, 10);
      return `🚫 沙箱模式不允许执行: ${cmdName}\n允许的 cmdlet: ${safeList.join(', ')} ...\n提示: 使用 /sandbox off 关闭沙箱模式`;
    }
  }

  return null;
}

/**
 * 检查后台命令的潜在问题
 */
export function warnPowerShellBackgroundSyntax(
  command: string,
  background: boolean,
  logger: PlatformLogger,
): void {
  if (!background) return;

  // Start-Job 在后台模式下冗余
  if (/\bstart-job\b/i.test(command)) {
    logger.info('POWERSHELL', '提示: run_in_background=true 已经处理后台运行，无需使用 Start-Job');
  }

  // 交互式 cmdlet 在后台无法工作
  const interactiveCmdlets = ['read-host', 'get-credential', 'out-gridview', 'pause'];
  for (const cmdlet of interactiveCmdlets) {
    if (command.toLowerCase().includes(cmdlet)) {
      logger.warn('POWERSHELL', `警告: 后台模式下 ${cmdlet} 无法交互，命令会挂起`);
    }
  }
}

/**
 * PowerShell 命令的安全预检查
 *
 * @returns 如果有安全问题，返回描述性消息; 否则返回 null
 */
export function preCheckPowerShellCommand(command: string): string | null {
  // 安全分析
  const result = analyzePowerShellSecurity(command);
  if (result.behavior === 'deny') {
    return `🚫 PowerShell 命令被拒绝: ${result.reason}`;
  }

  // 破坏性警告 (仅提示，不阻止)
  const warning = getDestructiveCommandWarning(command);
  if (warning) {
    return `⚠️ 注意: ${warning}`;
  }

  return null;
}

/**
 * 深度风险评估
 */
export interface PowerShellCommandRisk {
  command: string;
  risks: string[];
}

export function analyzePowerShellRisks(command: string): PowerShellCommandRisk[] {
  const results: PowerShellCommandRisk[] = [];
  const segments = command.split(/[;|]/).map(s => s.trim()).filter(Boolean);

  for (const seg of segments) {
    const risks: string[] = [];
    const tokens = seg.split(/\s+/);
    const cmdName = tokens[0];
    if (!cmdName) continue;

    const canonical = resolveToCanonical(cmdName);

    // 重定向到系统路径
    if (tokens.some(t => /^[>]/.test(t)) &&
        tokens.some(t => /^(C:\\Windows|\\\\|\/etc\/)/i.test(t))) {
      risks.push('重定向到系统路径');
    }

    // Git 内部路径
    for (let i = 1; i < tokens.length; i++) {
      if (isGitInternalPath(tokens[i])) {
        risks.push(`写入 Git 内部路径: ${tokens[i]}`);
      }
    }

    // 管道到执行类
    if (canonical === 'invoke-expression') {
      risks.push('Invoke-Expression (代码注入风险)');
    }

    // 递归删除
    if (['remove-item'].includes(canonical) &&
        tokens.some(t => /^-recurse$/i.test(t))) {
      risks.push('递归删除');
    }

    if (risks.length > 0) {
      results.push({ command: seg, risks });
    }
  }

  return results;
}
