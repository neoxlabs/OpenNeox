import type { ToolApprovalRequest } from '@neoxlabs/kernel/core/runner.js';
import { L } from '../i18n/index.js';

type UiApprovalCallbacks = {
  updateStatus: (message: string, status: any) => void;
  addInfo: (message: string, details?: string) => void;
};

type CliApprovalCallbacks = {
  println: (text?: string) => void;
  colors: {
    warning: (value: string) => string;
    dim: (value: string) => string;
    info: (value: string) => string;
  };
};

export async function handleToolApprovalRequestFlow(params: {
  request: ToolApprovalRequest;
  formatArgs: (args: Record<string, any>) => string;
  promptYesNo: (question: string, initialYes?: boolean) => Promise<boolean>;
  logInfo: (message: string, details?: string) => void;
  uiCallbacks?: UiApprovalCallbacks;
  cliCallbacks: CliApprovalCallbacks;
}): Promise<boolean> {
  const { request, formatArgs, promptYesNo, logInfo, uiCallbacks, cliCallbacks } = params;

  const argsPreview = formatArgs(request.args || {});
  const question = L(`允许执行 ${request.name}${argsPreview}?`, `Allow ${request.name}${argsPreview}?`);

  let argsDetail = '';
  try {
    argsDetail = JSON.stringify(request.args, null, 2);
    if (argsDetail.length > 600) {
      argsDetail = `${argsDetail.slice(0, 600)} ...`;
    }
  } catch {
    argsDetail = '';
  }

  if (uiCallbacks) {
    uiCallbacks.updateStatus(`${L('需要审批', 'Needs approval')}: ${request.name}`, 'thinking');
    uiCallbacks.addInfo(`${L('审批请求', 'Approval request')} · ${request.name}`, argsDetail || undefined);
  } else {
    cliCallbacks.println('');
    cliCallbacks.println(cliCallbacks.colors.warning(`⚠  ${L('需要审批', 'Needs approval')}: ${request.name}${argsPreview}`));
    if (argsDetail) {
      cliCallbacks.println(cliCallbacks.colors.dim(argsDetail));
    }
    cliCallbacks.println('');
  }

  const approvedText = `${L('已批准', 'Approved')} ${request.name}`;
  const deniedText = `${L('已拒绝', 'Denied')} ${request.name}`;
  try {
    const approved = await promptYesNo(question, false);
    if (uiCallbacks) {
      uiCallbacks.addInfo(approved ? `[v] ${approvedText}` : `✗ ${deniedText}`);
    } else {
      cliCallbacks.println(cliCallbacks.colors.info(approved ? approvedText : deniedText));
    }
    return approved;
  } catch (error: any) {
    if (error?.message !== 'cancelled') {
      logInfo(L('审批提示失败', 'Approval prompt failed'), error?.message);
    }
    if (uiCallbacks) {
      uiCallbacks.addInfo(`✗ ${deniedText}`, L('审批被取消', 'Approval cancelled'));
    } else {
      cliCallbacks.println(cliCallbacks.colors.warning(`${L('审批已取消', 'Approval cancelled')}: ${request.name}`));
    }
    return false;
  }
}
