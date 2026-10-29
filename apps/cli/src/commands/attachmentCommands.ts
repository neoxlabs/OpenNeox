import { L } from '../i18n/index.js';

interface AttachmentCommandDeps {
  logInfo: (message: string, details?: string) => void;
  addPendingAttachment: (value: string) => Promise<void>;
  listPendingAttachments: () => void;
  clearPendingAttachments: () => void;
  removePendingAttachment: (index: number) => void;
}

export async function handleAttachCommand(
  args: string[],
  deps: AttachmentCommandDeps,
): Promise<void> {
  if (!args.length) {
    deps.logInfo(L('用法', 'Usage'), L('/attach <图片路径或 URL>', '/attach <image path or URL>'));
    return;
  }
  if (args[0].toLowerCase() === 'clear') {
    deps.clearPendingAttachments();
    return;
  }
  await deps.addPendingAttachment(args.join(' '));
}

export function handleAttachmentsCommand(
  args: string[],
  deps: AttachmentCommandDeps,
): void {
  if (!args.length || args[0].toLowerCase() === 'list') {
    deps.listPendingAttachments();
    return;
  }
  if (args[0].toLowerCase() === 'clear') {
    deps.clearPendingAttachments();
    return;
  }
  if (args[0].toLowerCase() === 'remove') {
    const index = parseInt(args[1], 10);
    if (isNaN(index) || index < 1) {
      deps.logInfo(L('用法', 'Usage'), L('/attachments remove <编号>', '/attachments remove <number>'));
      return;
    }
    deps.removePendingAttachment(index - 1);
    return;
  }
  deps.logInfo(L('用法', 'Usage'), L('/attachments [list|clear|remove <编号>]', '/attachments [list|clear|remove <number>]'));
}

export async function handleAttachmentCommandRouting(
  cmd: string,
  args: string[],
  deps: AttachmentCommandDeps,
): Promise<boolean> {
  if (cmd === '/attach') {
    await handleAttachCommand(args, deps);
    return true;
  }
  if (cmd === '/attachments') {
    handleAttachmentsCommand(args, deps);
    return true;
  }
  return false;
}
