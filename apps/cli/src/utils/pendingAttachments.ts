import * as fs from 'fs';
import * as path from 'path';
import type { HostAttachment } from '@neoxlabs/core/runtime/runtimeTypes.js';
import { colors, IMAGE_MIME_BY_EXT } from '../constants.js';
import { cliPrintln } from './output.js';

type LogInfoFn = (message: string, details?: string) => void;

export async function addPendingAttachmentToQueue(
  pendingAttachments: HostAttachment[],
  value: string,
  logInfo: LogInfoFn,
): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) {
    logInfo('附件无效', '请输入本地图片路径或 https 链接');
    return;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      pendingAttachments.push({ type: 'url', data: trimmed, name: parsed.hostname });
      logInfo('已添加链接附件', trimmed);
    } catch {
      logInfo('无效的 URL', trimmed);
    }
    return;
  }

  const absolutePath = path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
  if (!fs.existsSync(absolutePath)) {
    logInfo('文件不存在', absolutePath);
    return;
  }

  const ext = path.extname(absolutePath).toLowerCase();
  const mime = IMAGE_MIME_BY_EXT[ext];
  if (!mime) {
    logInfo('仅支持图片附件', `允许的类型: ${Object.keys(IMAGE_MIME_BY_EXT).join(', ')}`);
    return;
  }

  try {
    const buffer = await fs.promises.readFile(absolutePath);
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    pendingAttachments.push({ type: 'image', data: dataUrl, name: path.basename(absolutePath) });
    logInfo('已添加图片附件', path.basename(absolutePath));
  } catch (error: any) {
    logInfo('读取附件失败', error?.message || '无法读取文件');
  }
}

export function listPendingAttachmentsFromQueue(
  pendingAttachments: HostAttachment[],
  logInfo: LogInfoFn,
): void {
  if (pendingAttachments.length === 0) {
    logInfo('附件列表', '没有待发送的附件。');
    return;
  }
  cliPrintln('');
  cliPrintln(colors.highlight('  Pending attachments:'));
  pendingAttachments.forEach((attachment, index) => {
    const label = attachment.type === 'url' ? attachment.data : attachment.name || `Image ${index + 1}`;
    cliPrintln(colors.dim(`  ${index + 1}. `) + colors.info(label));
  });
  cliPrintln('');
}

export function clearPendingAttachmentsQueue(
  pendingAttachments: HostAttachment[],
  logInfo: LogInfoFn,
): HostAttachment[] {
  if (pendingAttachments.length === 0) {
    logInfo('附件列表', '没有可清除的附件。');
    return pendingAttachments;
  }
  logInfo('附件已清除', '所有待发送附件已移除。');
  return [];
}

export function removePendingAttachmentFromQueue(
  pendingAttachments: HostAttachment[],
  index: number,
  logInfo: LogInfoFn,
): void {
  if (index < 0 || index >= pendingAttachments.length) {
    logInfo('附件索引无效', `当前共有 ${pendingAttachments.length} 个附件。`);
    return;
  }
  const [removed] = pendingAttachments.splice(index, 1);
  const label = removed.type === 'url' ? removed.data : removed.name || `Attachment #${index + 1}`;
  logInfo('已移除附件', label);
}
