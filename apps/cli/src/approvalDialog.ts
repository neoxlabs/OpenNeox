/**
 * CLI Approval Dialog - 工具权限审批对话框
 *
 * 提供三个选项：
 * 1. Allow Once - 仅本次允许
 * 2. Always Allow - 不再询问，总是允许
 * 3. Deny - 拒绝
 */

import type { ApprovalRequest, ApprovalResult } from '@neoxlabs/kernel/core/permissions/index.js';
import type { SelectionChoice } from './cliTypes.js';

type ApprovalPrompt = (
  question: string,
  choices: SelectionChoice[],
  defaultValue?: string,
  hint?: string
) => Promise<string>;

let approvalPrompt: ApprovalPrompt | null = null;

/**
 * 设置审批提示器（由 main.ts 提供，带 prompt 锁）
 */
export function setApprovalPrompt(prompt: ApprovalPrompt | null): void {
  approvalPrompt = prompt;
}

function getApprovalPrompt(): ApprovalPrompt {
  if (!approvalPrompt) {
    throw new Error('Approval prompt is not configured');
  }
  return approvalPrompt;
}

/* 用户友好工具名 + 关键参数预览. 内部 toolName (execute_shell / write_file...)
 * 对最终用户没意义, 且 tool card 已经在上面显完整调用了 — 这里只要简短"做什么". */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  execute_shell: 'Bash',
  execute_bash: 'Bash',
  execute_python: 'Python',
  execute_javascript: 'JS',
  write_file: 'Write',
  edit_file: 'Edit',
  delete_file: 'Delete',
  read_file: 'Read',
  list_directory: 'List',
  search_files: 'Search',
  fetch_url: 'Fetch',
  build_index: 'Index',
};

function getDisplayLabel(toolName: string, args: Record<string, unknown>): string {
  const name = TOOL_DISPLAY_NAMES[toolName] || toolName;
  /* 命令/路径类 — 拼到 label 后, 一眼能看清"在审什么", 不再显 (command) 这种 key 名 */
  if (toolName === 'execute_shell' || toolName === 'execute_bash') {
    const cmd = String(args.command || '').slice(0, 60);
    return cmd ? `${name}: ${cmd}` : name;
  }
  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'delete_file') {
    const p = String(args.path || args.file_path || '').slice(0, 60);
    return p ? `${name}: ${p}` : name;
  }
  if (toolName === 'fetch_url') {
    const u = String(args.url || '').slice(0, 60);
    return u ? `${name}: ${u}` : name;
  }
  return name;
}

/**
 * 显示审批对话框
 */
export async function showApprovalDialog(request: ApprovalRequest): Promise<ApprovalResult> {
  const { toolName, args, reason, allowRemember, risk } = request;
  const prompt = getApprovalPrompt();

  const label = getDisplayLabel(toolName, args);
  const message = `允许执行 ${label}?`;
  const isHighRisk = risk && (risk.level === 'high' || risk.level === 'critical');
  const riskHint = isHighRisk ? `Risk ${risk.level.toUpperCase()}: ${risk.summary}` : undefined;
  /* 当 always allow 被风险等级屏蔽时, 顺手告知用户为什么 — 防"为啥没有 always 选项" 困惑.
   * 用户嫌烦可以全局切 /approve → yolo 一劳永逸 (跟桌面端 yolo 同). */
  const suppressionHint = !allowRemember && isHighRisk
    ? '高风险工具每次都需确认; 若要全跳过审批: /approve → yolo'
    : undefined;
  const hint = [riskHint, reason ? `Warning: ${reason}` : '', suppressionHint].filter(Boolean).join(' | ') || undefined;

  const choices: SelectionChoice[] = [
    {
      label: 'Allow Once',
      value: 'allow_once',
      description: 'Allow this tool call only this time',
    },
  ];

  if (allowRemember) {
    choices.push({
      label: 'Always Allow',
      value: 'always_allow',
      description: `Don't ask again for "${toolName}" — 后续同工具自动放行`,
    });
  }

  choices.push({
    label: 'Deny',
    value: 'deny',
    description: 'Reject this tool call',
  });

  const decision = await prompt(message, choices, 'allow_once', hint);

  switch (decision) {
    case 'allow_once':
      return {
        approved: true,
        remember: false,
      };
    case 'always_allow':
      return {
        approved: true,
        remember: true,
      };
    case 'deny':
      return {
        approved: false,
        remember: false,
      };
    default:
      return {
        approved: false,
        remember: false,
      };
  }
}

/**
 * 简化版审批对话框（仅用于快速确认，不支持记忆）
 */
export async function showQuickApprovalDialog(
  toolName: string,
  message?: string
): Promise<boolean> {
  const prompt = getApprovalPrompt();
  const hint = message ? `Warning: ${message}` : undefined;
  const choices: SelectionChoice[] = [
    { label: 'Approve', value: 'approve' },
    { label: 'Deny', value: 'deny' },
  ];
  const decision = await prompt(`Allow tool ${toolName}?`, choices, 'approve', hint);
  return decision === 'approve';
}
