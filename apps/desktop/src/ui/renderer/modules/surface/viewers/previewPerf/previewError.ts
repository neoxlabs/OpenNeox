/* 预览失败的「原因」归类 —— 给用户一句人话, 原始报错折成小字。
 *
 * S-12: 失败时要给三个出口: 原因 + 重试 + 用系统应用打开。
 * 归类放在这里 (纯函数), 四个 viewer 共用, 也方便单测。
 */

export type PreviewErrorKind =
  | 'too-large'
  | 'missing'
  | 'denied'
  | 'corrupt'
  | 'unsupported'
  | 'bridge'
  | 'unknown';

export interface PreviewErrorCopy {
  kind: PreviewErrorKind;
  title: string;
  hint: string;
}

interface CopyPair { zh: string; en: string }

const COPY: Record<PreviewErrorKind, { title: CopyPair; hint: CopyPair }> = {
  'too-large': {
    title: { zh: '文件太大，暂时无法预览', en: 'File is too large to preview' },
    hint: {
      zh: '超过了预览上限。用系统应用打开可以看到完整内容。',
      en: 'It exceeds the preview limit. Open it in a system app to see everything.',
    },
  },
  missing: {
    title: { zh: '这个文件已经不在了', en: 'This file is gone' },
    hint: {
      zh: '可能被删掉或挪走了。重试一次，或者用系统应用打开。',
      en: 'It may have been deleted or moved. Retry, or open it in a system app.',
    },
  },
  denied: {
    title: { zh: '没有读取权限', en: 'No permission to read' },
    hint: {
      zh: '这个文件在当前工作区之外，或者被系统限制访问。重试一次试试。',
      en: 'The file is outside the current workspace or blocked by the system. Try retrying.',
    },
  },
  corrupt: {
    title: { zh: '文件内容无法解析', en: 'The file could not be parsed' },
    hint: {
      zh: '文件可能不完整、已经损坏，或者并不是它扩展名声称的格式。重新生成一份，或用系统应用打开。',
      en: 'It may be incomplete, corrupted, or not the format its extension claims. Regenerate it, or open it in a system app.',
    },
  },
  unsupported: {
    title: { zh: '这个文件暂时不能这样预览', en: 'This file cannot be previewed here' },
    hint: {
      zh: '可以换一种方式打开，或者用系统应用查看。',
      en: 'Try opening it another way, or view it in a system app.',
    },
  },
  bridge: {
    title: { zh: '预览服务没有就绪', en: 'Preview service is not ready' },
    hint: {
      zh: '桌面端没有连上预览通道。重试一次；还不行就重启客户端。',
      en: 'The desktop app is not connected to the preview bridge. Retry once; if it persists, restart the app.',
    },
  },
  unknown: {
    title: { zh: '预览失败', en: 'Preview failed' },
    hint: {
      zh: '可以重试一次，或者用系统应用打开。',
      en: 'Retry once, or open it in a system app.',
    },
  },
};

const RULES: Array<{ kind: PreviewErrorKind; re: RegExp }> = [
  { kind: 'too-large', re: /too large|file is too large|文件过大|exceeds? (?:the )?(?:size|limit)|MAX_BYTES/i },
  { kind: 'missing', re: /ENOENT|no such file|not found|does not exist|不存在|已经不在/i },
  { kind: 'denied', re: /EACCES|EPERM|access denied|outside workspace|permission denied|没有权限|拒绝访问/i },
  { kind: 'bridge', re: /bridge (?:\u4e0d\u53ef\u7528|unavailable|not available)|surfaceReadFile|is not a function|undefined is not/i },
  { kind: 'unsupported', re: /仅支持|only supports?|unsupported|not supported/i },
  { kind: 'corrupt', re: /not a valid|invalid|corrupt|bad zip|unzip|central directory|unexpected end|OOXML|premature|无法解析|损坏/i },
];

export function classifyPreviewError(raw: string | null | undefined): PreviewErrorKind {
  if (!raw) return 'unknown';
  for (const rule of RULES) {
    if (rule.re.test(raw)) return rule.kind;
  }
  return 'unknown';
}

export function previewErrorCopy(raw: string | null | undefined, isZh: boolean): PreviewErrorCopy {
  const kind = classifyPreviewError(raw);
  const entry = COPY[kind];
  return {
    kind,
    title: isZh ? entry.title.zh : entry.title.en,
    hint: isZh ? entry.hint.zh : entry.hint.en,
  };
}

/** 失败态里显示的原始报错 —— 太长就截断, 不把整段栈糊在界面上。 */
export function briefErrorDetail(raw: string | null | undefined, max = 240): string {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}
