import * as fs from 'fs';
import * as path from 'path';
import type { HostAttachment, RuntimeMetadata } from '@neoxlabs/core/runtime/runtimeTypes.js';
import type { InteractionMode } from '../cliTypes.js';

type InputImage = {
  path?: string;
  name?: string;
  mediaType?: string;
  data?: string;
};

interface BuildInputMetadataOptions {
  pendingAttachments: HostAttachment[];
  images?: InputImage[];
  interactionMode: InteractionMode;
  imageMimeByExt: Record<string, string>;
  addInfo: (message: string, details?: string) => void;
}

interface BuildInputMetadataResult {
  consumedPendingAttachments: boolean;
  metadata: RuntimeMetadata | undefined;
}

export function buildInputMetadata(options: BuildInputMetadataOptions): BuildInputMetadataResult {
  const attachmentsToSend = options.pendingAttachments.length ? [...options.pendingAttachments] : [];
  const consumedPendingAttachments = attachmentsToSend.length > 0;

  if (options.images && options.images.length > 0) {
    for (const img of options.images) {
      try {
        let dataUrl: string;

        if (img.mediaType && img.data) {
          dataUrl = `data:${img.mediaType};base64,${img.data}`;
        } else if (img.path) {
          const imageBuffer = fs.readFileSync(img.path);
          const ext = path.extname(img.path).toLowerCase();
          const mime = options.imageMimeByExt[ext] || 'image/png';
          dataUrl = `data:${mime};base64,${imageBuffer.toString('base64')}`;
        } else {
          throw new Error('Invalid image format: missing path or data');
        }

        attachmentsToSend.push({
          type: 'image',
          data: dataUrl,
          path: img.path,
          name: img.name,
        });
      } catch (error: any) {
        options.addInfo(`[x] Failed to read image: ${img.name}`, error?.message);
      }
    }

    if (attachmentsToSend.some((attachment) => attachment.type === 'image')) {
      options.addInfo(`[i] ${options.images.length} image(s) attached`);
    }
  }

  const metadata: RuntimeMetadata | undefined = (
    attachmentsToSend.length > 0 || options.interactionMode !== 'agent'
  )
    ? {
      mode: options.interactionMode,
      attachments: attachmentsToSend.length > 0 ? attachmentsToSend : undefined,
    }
    : undefined;

  return {
    consumedPendingAttachments,
    metadata,
  };
}
