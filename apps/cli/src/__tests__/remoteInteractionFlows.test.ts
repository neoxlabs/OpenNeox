import { describe, expect, it, vi } from 'vitest';
import { handleRemoteApprovalEventFlow } from '../utils/remoteInteractionFlows.js';

describe('handleRemoteApprovalEventFlow', () => {
  it('skips prompt/reply when request is already cancelled', async () => {
    const promptSelect = vi.fn();
    const replyPermission = vi.fn();

    await handleRemoteApprovalEventFlow({
      event: { requestId: 'req-1', toolName: 'run_shell_command' },
      sdkClient: { replyPermission },
      promptSelect,
      logInfo: vi.fn(),
      isRequestCancelled: () => true,
    });

    expect(promptSelect).not.toHaveBeenCalled();
    expect(replyPermission).not.toHaveBeenCalled();
  });

  it('skips reply when request is cancelled during prompt', async () => {
    const promptSelect = vi.fn(async () => 'allow_once');
    const replyPermission = vi.fn();
    let checks = 0;

    await handleRemoteApprovalEventFlow({
      event: { requestId: 'req-2', toolName: 'run_shell_command' },
      sdkClient: { replyPermission },
      promptSelect,
      logInfo: vi.fn(),
      isRequestCancelled: () => {
        checks += 1;
        return checks > 1;
      },
    });

    expect(promptSelect).toHaveBeenCalledTimes(1);
    expect(replyPermission).not.toHaveBeenCalled();
  });

  it('replies when request stays active', async () => {
    const promptSelect = vi.fn(async () => 'allow_once');
    const replyPermission = vi.fn();

    await handleRemoteApprovalEventFlow({
      event: { requestId: 'req-3', toolName: 'run_shell_command' },
      sdkClient: { replyPermission },
      promptSelect,
      logInfo: vi.fn(),
      isRequestCancelled: () => false,
    });

    expect(promptSelect).toHaveBeenCalledTimes(1);
    expect(replyPermission).toHaveBeenCalledTimes(1);
    expect(replyPermission).toHaveBeenCalledWith('req-3', true, undefined, false);
  });
});
