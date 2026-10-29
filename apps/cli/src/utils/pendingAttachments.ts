import * as fs from 'fs';
import * as path from 'path';
import type { HostAttachment } from '@neoxlabs/core/runtime/runtimeTypes.js';
import { IMAGE_MIME_BY_EXT } from '../constants.js';
import { L } from '../i18n/index.js';

type LogInfoFn = (message: string, details?: string) => void;

export async function addPendingAttachmentToQueue(
  pendingAttachments: HostAttachment[],
  value: string,
  logInfo: LogInfoFn,
): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) {
    logInfo(L('附件无效', 'Invalid attachment'), L('请输入本地图片路径或 https 链接', 'Give a local image path or an https link'));
    return;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      pendingAttachments.push({ type: 'url', data: trimmed, name: parsed.hostname });
      logInfo(L('已添加链接附件', 'Link attached'), trimmed);
    } catch {
      logInfo(L('无效的 URL', 'Invalid URL'), trimmed);
    }
    return;
  }

  const absolutePath = path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
  if (!fs.existsSync(absolutePath)) {
    logInfo(L('文件不存在', 'File not found'), absolutePath);
    return;
  }

  const ext = path.extname(absolutePath).toLowerCase();
  const mime = IMAGE_MIME_BY_EXT[ext];
  if (!mime) {
    logInfo(L('仅支持图片附件', 'Only images can be attached'), `${L('允许的类型', 'Allowed')}: ${Object.keys(IMAGE_MIME_BY_EXT).join(', ')}`);
    return;
  }

  try {
    const buffer = await fs.promises.readFile(absolutePath);
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    pendingAttachments.push({ type: 'image', data: dataUrl, name: path.basename(absolutePath) });
    logInfo(L('已添加图片附件', 'Image attached'), path.basename(absolutePath));
  } catch (error: any) {
    logInfo(L('读取附件失败', 'Couldn’t read the attachment'), error?.message || L('无法读取文件', 'unreadable file'));
  }
}

export function listPendingAttachmentsFromQueue(
  pendingAttachments: HostAttachment[],
  logInfo: LogInfoFn,
): void {
  const title = L('附件列表', 'Attachments');
  if (pendingAttachments.length === 0) {
    logInfo(title, L('没有待发送的附件。', 'Nothing attached.'));
    return;
  }
  const lines = pendingAttachments.map((attachment, index) => {
    const label = attachment.type === 'url' ? attachment.data : attachment.name || L(`图片 ${index + 1}`, `Image ${index + 1}`);
    return `${index + 1}. ${label}`;
  });
  logInfo(title, lines.join('\n'));
}

export function clearPendingAttachmentsQueue(
  pendingAttachments: HostAttachment[],
  logInfo: LogInfoFn,
): HostAttachment[] {
  if (pendingAttachments.length === 0) {
    logInfo(L('附件列表', 'Attachments'), L('没有可清除的附件。', 'Nothing to clear.'));
    return pendingAttachments;
  }
  logInfo(L('附件已清除', 'Attachments cleared'), L('所有待发送附件已移除。', 'All pending attachments removed.'));
  return [];
}

export function removePendingAttachmentFromQueue(
  pendingAttachments: HostAttachment[],
  index: number,
  logInfo: LogInfoFn,
): void {
  if (index < 0 || index >= pendingAttachments.length) {
    logInfo(L('附件索引无效', 'Invalid attachment number'), L(`当前共有 ${pendingAttachments.length} 个附件。`, `There are ${pendingAttachments.length} attachments.`));
    return;
  }
  const [removed] = pendingAttachments.splice(index, 1);
  const label = removed.type === 'url' ? removed.data : removed.name || L(`附件 #${index + 1}`, `Attachment #${index + 1}`);
  logInfo(L('已移除附件', 'Attachment removed'), label);
}
