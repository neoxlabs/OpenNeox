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
    deps.logInfo('用法', '/attach <图片路径或 URL>');
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
      deps.logInfo('用法', '/attachments remove <编号>');
      return;
    }
    deps.removePendingAttachment(index - 1);
    return;
  }
  deps.logInfo('用法', '/attachments [list|clear|remove <编号>]');
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
