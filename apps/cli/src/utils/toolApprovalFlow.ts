import type { ToolApprovalRequest } from '@neoxlabs/kernel/core/runner.js';

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
  const question = `允许执行 ${request.name}${argsPreview}?`;

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
    uiCallbacks.updateStatus(`需要审批: ${request.name}`, 'thinking');
    uiCallbacks.addInfo(`审批请求 · ${request.name}`, argsDetail || undefined);
  } else {
    cliCallbacks.println('');
    cliCallbacks.println(cliCallbacks.colors.warning(`⚠  需要审批: ${request.name}${argsPreview}`));
    if (argsDetail) {
      cliCallbacks.println(cliCallbacks.colors.dim(argsDetail));
    }
    cliCallbacks.println('');
  }

  try {
    const approved = await promptYesNo(question, false);
    if (uiCallbacks) {
      uiCallbacks.addInfo(
        approved ? `[v] 已批准 ${request.name}` : `✗ 已拒绝 ${request.name}`
      );
    } else {
      cliCallbacks.println(cliCallbacks.colors.info(approved ? `已批准 ${request.name}` : `已拒绝 ${request.name}`));
    }
    return approved;
  } catch (error: any) {
    if (error?.message !== 'cancelled') {
      logInfo('审批提示失败', error?.message);
    }
    if (uiCallbacks) {
      uiCallbacks.addInfo(`✗ 已拒绝 ${request.name}`, '审批被取消');
    } else {
      cliCallbacks.println(cliCallbacks.colors.warning(`审批已取消: ${request.name}`));
    }
    return false;
  }
}
