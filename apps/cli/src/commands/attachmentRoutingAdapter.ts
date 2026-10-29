import type { HostAttachment } from '@neoxlabs/core/runtime/runtimeTypes.js';
import {
  addPendingAttachmentToQueue,
  listPendingAttachmentsFromQueue,
  clearPendingAttachmentsQueue,
  removePendingAttachmentFromQueue,
} from '../utils/pendingAttachments.js';
import { buildAttachmentCommandRoutingDeps } from './commandRoutingDepBuilders.js';

export type AttachmentRoutingDepsFromMain = {
  logInfo: (message: string, details?: string) => void;
  addPendingAttachment: (value: string) => Promise<void>;
  listPendingAttachments: () => void;
  clearPendingAttachments: () => void;
  removePendingAttachment: (index: number) => void;
};

export function buildAttachmentCommandRoutingDepsFromMain(params: {
  getPendingAttachments: () => HostAttachment[];
  setPendingAttachments: (attachments: HostAttachment[]) => void;
  logInfo: (message: string, details?: string) => void;
}): AttachmentRoutingDepsFromMain {
  const { getPendingAttachments, setPendingAttachments, logInfo } = params;
  return buildAttachmentCommandRoutingDeps({
    logInfo,
    addPendingAttachment: async (value: string) => {
      await addPendingAttachmentToQueue(
        getPendingAttachments(),
        value,
        logInfo,
      );
    },
    listPendingAttachments: () => {
      listPendingAttachmentsFromQueue(getPendingAttachments(), logInfo);
    },
    clearPendingAttachments: () => {
      setPendingAttachments(
        clearPendingAttachmentsQueue(getPendingAttachments(), logInfo),
      );
    },
    removePendingAttachment: (index: number) => {
      removePendingAttachmentFromQueue(getPendingAttachments(), index, logInfo);
    },
  });
}
