import React, { useMemo } from 'react';
import type { CodeLine } from '../types';
import { useI18n } from '../../../hooks/useI18n';

/* ---------- browser tool result ---------- */
const BROWSER_IMAGE_PREFIX = '__NEOX_IMAGE_RESULT__';

function stripAnsiText(input: string): string {
  return input
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\[[0-9;]+m/g, '')
    .trim();
}


function extractJsonObjectText(input: string): string | undefined {
  const start = input.search(/[\[{]/);
  if (start < 0) return undefined;
  const open = input[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth += 1;
    if (ch === close) {
      depth -= 1;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  return input.slice(start).trim();
}

function collectBrowserImages(payload: any): Array<{ src: string; alt?: string }> {
  const images: Array<{ src: string; alt?: string }> = [];
  const visit = (value: any, indexHint = images.length): void => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, index));
      return;
    }
    if (typeof value !== 'object') return;
    const data = typeof value.data === 'string'
      ? value.data
      : (typeof value.base64 === 'string' ? value.base64 : '');
    if (data) {
      const mime = typeof value.mimeType === 'string'
        ? value.mimeType
        : (typeof value.mime === 'string'
          ? value.mime
          : (typeof value.format === 'string' ? `image/${value.format}` : 'image/png'));
      const src = data.startsWith('data:') ? data : `data:${mime};base64,${data}`;
      images.push({ src, alt: value.alt || value.name || `Browser screenshot ${indexHint + 1}` });
    }
    if (value.image) visit(value.image, indexHint);
    if (value.images) visit(value.images, indexHint);
  };
  visit(payload);
  return images;
}

function parseBrowserImagesFromText(input: string): Array<{ src: string; alt?: string }> {
  const text = stripAnsiText(input || '').trim();
  if (!text) return [];
  const inlineImages = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('__IMG__'))
    .map((line, index) => ({ src: line.slice(7), alt: `Browser screenshot ${index + 1}` }))
    .filter((img) => img.src.startsWith('data:image/'));
  if (inlineImages.length > 0) return inlineImages;

  const imageIndex = text.indexOf(BROWSER_IMAGE_PREFIX);
  if (imageIndex < 0) return [];
  const payloadText = extractJsonObjectText(text.slice(imageIndex + BROWSER_IMAGE_PREFIX.length));
  if (!payloadText) return [];
  try {
    return collectBrowserImages(JSON.parse(payloadText));
  } catch {
    return [];
  }
}

type BrowserActionKind = 'click' | 'type' | 'navigate' | 'screenshot' | 'aria' | 'eval' | 'other';

function browserActionKind(title?: string): BrowserActionKind {
  const raw = (title || '').replace(/^browser[_\s-]*/i, '').trim().toLowerCase();
  if (raw === 'click') return 'click';
  if (raw === 'type' || raw === 'fill') return 'type';
  if (raw === 'navigate') return 'navigate';
  if (raw === 'screenshot') return 'screenshot';
  if (raw === 'get_aria_tree' || raw === 'aria') return 'aria';
  if (raw === 'eval') return 'eval';
  return 'other';
}

function browserActionLabel(title: string | undefined, isZh: boolean): string {
  const raw = (title || '').replace(/^browser[_\s-]*/i, '').trim().toLowerCase();
  if (!raw) return 'Browser';
  const zhMap: Record<string, string> = {
    click: '点击',
    type: '输入',
    fill: '输入',
    navigate: '打开页面',
    screenshot: '截图',
    get_aria_tree: '读取页面结构',
    aria: '读取页面结构',
    eval: '执行脚本',
  };
  const enMap: Record<string, string> = {
    click: 'Click',
    type: 'Type',
    fill: 'Type',
    navigate: 'Navigate',
    screenshot: 'Screenshot',
    get_aria_tree: 'Read ARIA tree',
    aria: 'Read ARIA tree',
    eval: 'Run script',
  };
  const map = isZh ? zhMap : enMap;
  return map[raw] || raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function browserTargetFromText(input?: string): string | undefined {
  const text = stripAnsiText(input || '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;

  const roleName = text.match(/getByRole\([^)]*?name:\s*['"]([^'"]+)['"]/i)?.[1];
  if (roleName) return roleName;
  const label = text.match(/getByLabel\(['"]([^'"]+)['"]/i)?.[1];
  if (label) return label;
  const placeholder = text.match(/getByPlaceholder\(['"]([^'"]+)['"]/i)?.[1];
  if (placeholder) return placeholder;
  const textSelector = text.match(/getByText\(['"]([^'"]+)['"]/i)?.[1];
  if (textSelector) return textSelector;
  const quotedName = text.match(/name:\s*['"]([^'"]+)['"]/i)?.[1];
  if (quotedName) return quotedName;

  // 常见 desc/meta 形态："手机号"、"去结算"、"text=登录"、"selector: #phone"。
  const compact = text
    .replace(/^Browser\s+\w+\s*[:：-]?\s*/i, '')
    .replace(/^(点击|输入|打开页面|截图|执行脚本|读取页面结构)\s*[:：-]?\s*/i, '')
    .replace(/^(selector|locator|target|name|text|value)\s*[:：=]\s*/i, '')
    .trim();
  if (compact && compact.length <= 48 && !/^\d+(\.\d+)?\s*(B|KB|MB|字符|工具|tok)$/i.test(compact)) return compact;
  return undefined;
}

function browserSuccessDetail(actionKind: BrowserActionKind, context: string | undefined, isZh: boolean): string {
  const cleanContext = stripAnsiText(context || '').replace(/\s+/g, ' ').trim();
  if (cleanContext) {
    if (/^已(输入|点击|打开|截图|处理)/.test(cleanContext)) return cleanContext;
    if (/^输入/.test(cleanContext)) return cleanContext.replace(/^输入/, '已输入');
    if (/^点击/.test(cleanContext)) return cleanContext.replace(/^点击/, '已点击');
    if (/^打开/.test(cleanContext)) return cleanContext.replace(/^打开/, '已打开');
  }

  const target = browserTargetFromText(context);
  if (!target) return isZh ? '操作完成' : 'Action complete';
  if (isZh) {
    if (actionKind === 'click') return `已点击「${target}」`;
    if (actionKind === 'type') return `已输入「${target}」`;
    if (actionKind === 'navigate') return `已打开「${target}」`;
    return `已处理「${target}」`;
  }
  if (actionKind === 'click') return `Clicked "${target}"`;
  if (actionKind === 'type') return `Typed into "${target}"`;
  if (actionKind === 'navigate') return `Opened "${target}"`;
  return `Handled "${target}"`;
}

type BrowserParsedResult =
  | { kind: 'empty'; action: string }
  | { kind: 'success'; action: string; detail?: string; url?: string; title?: string }
  | { kind: 'image'; action: string; images: Array<{ src: string; alt?: string }> }
  | { kind: 'error'; action: string; code?: string; summary: string; locator?: string; timeout?: string; raw: string }
  | { kind: 'text'; action: string; text: string };

function parseBrowserResult(lines: CodeLine[], title: string | undefined, context: string | undefined, isZh: boolean): BrowserParsedResult {
  const action = browserActionLabel(title, isZh);
  const kind = browserActionKind(title);
  const raw = stripAnsiText(lines.map(l => l.text).join('\n')).trim();
  if (!raw) return { kind: 'empty', action };

  const parsedImages = parseBrowserImagesFromText(raw);
  if (parsedImages.length > 0) return { kind: 'image', action, images: parsedImages };

  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (oneLine === '✓' || oneLine === '✔' || oneLine === 'ok' || oneLine === 'OK') {
    return { kind: 'success', action, detail: browserSuccessDetail(kind, context, isZh) };
  }

  const successNav = oneLine.match(/^[✓✔]\s*[·•-]?\s*(https?:\/\/\S+)?\s*(?:[·•-]\s*)?(.*)$/i);
  if (successNav && (successNav[1] || successNav[2])) {
    return {
      kind: 'success',
      action,
      detail: successNav[2]?.trim() || (isZh ? '操作完成' : 'Action complete'),
      url: successNav[1],
      title: successNav[2]?.trim(),
    };
  }

  const timeout = oneLine.match(/Timeout\s+(\d+ms)\s+exceeded/i)?.[1];
  const locator = oneLine.match(/waiting for\s+(.+?)(?:\s*$|\s+\[[0-9;]+m)/i)?.[1]?.trim();
  const code = oneLine.match(/\b(BROWSER_[A-Z_]+)\b/)?.[1];
  if (/Timeout\s+\d+ms\s+exceeded|\bBROWSER_[A-Z_]+\b|locator\./i.test(oneLine)) {
    const summary = oneLine
      .replace(/\bBROWSER_[A-Z_]+\b\s*/g, '')
      .replace(/Call log:\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      kind: 'error',
      action,
      code,
      summary: summary || (isZh ? '浏览器操作失败' : 'Browser action failed'),
      locator: locator || browserTargetFromText(oneLine),
      timeout,
      raw: oneLine,
    };
  }

  return { kind: 'text', action, text: raw };
}

/** 给上层打渲染期标记用 (替代 CSS `:has(.atl-browser-result--success)`)。
 *  kind 只由内容决定, 与标题/语言无关 —— 语言参数仅影响展示文案。 */
export function browserResultIsSuccess(lines: CodeLine[]): boolean {
  const kind = parseBrowserResult(lines, undefined, undefined, false).kind;
  return kind === 'success' || kind === 'empty';
}


const BrowserProgress: React.FC<{ progress: number; progressText?: string }> = ({ progress, progressText }) => {
  const { isZh } = useI18n();
  return (
  <div className="atl-progress">
    <div className="atl-progress__head">
      <span>{progressText ?? (isZh ? '执行中' : 'Running')}</span>
      <span className="atl-progress__pct">{Math.round(progress)}%</span>
    </div>
    <div
      className="atl-progress__bar"
      aria-valuenow={progress}
      aria-valuemin={0}
      aria-valuemax={100}
      role="progressbar"
    >
      <div
        className="atl-progress__fill"
        style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
      />
    </div>
  </div>
  );
};

export const BrowserResultView: React.FC<{ lines: CodeLine[]; title?: string; context?: string; progress?: number; progressText?: string }> = ({ lines, title, context, progress, progressText }) => {
  const { isZh } = useI18n();
  const result = useMemo(() => parseBrowserResult(lines, title, context, isZh), [lines, title, context, isZh]);

  if (result.kind === 'image') {
    return (
      <div className="atl-browser-result atl-browser-result--image">
        <div className="atl-browser-result__head">
          <span className="atl-browser-result__status is-success">{isZh ? '截图已生成' : 'Screenshot ready'}</span>
          <span className="atl-browser-result__action">{result.action}</span>
        </div>
        <div className="atl-browser-result__images">
          {result.images.map((img, i) => (
            <img key={i} className="atl-browser-result__image" src={img.src} alt={img.alt || 'Browser screenshot'} />
          ))}
        </div>
      </div>
    );
  }

  if (result.kind === 'success' || result.kind === 'empty') {
    return (
      <div className="atl-browser-result atl-browser-result--success">
        <span className="atl-browser-result__check" aria-hidden="true">✓</span>
        <div className="atl-browser-result__main">
          <div className="atl-browser-result__title">{isZh ? `${result.action}完成` : `${result.action} done`}</div>
          {'detail' in result && result.detail && <div className="atl-browser-result__detail">{result.detail}</div>}
          {'url' in result && result.url && <div className="atl-browser-result__url">{result.url}</div>}
        </div>
      </div>
    );
  }

  if (result.kind === 'error') {
    return (
      <div className="atl-browser-result atl-browser-result--error">
        <div className="atl-browser-result__head">
          <span className="atl-browser-result__status is-error">{result.code || 'BROWSER_ERROR'}</span>
          <span className="atl-browser-result__action">{isZh ? `${result.action}失败` : `${result.action} failed`}</span>
          {result.timeout && <span className="atl-browser-result__pill">{result.timeout}</span>}
        </div>
        <div className="atl-browser-result__summary">{result.summary}</div>
        {result.locator && (
          <div className="atl-browser-result__locator">
            <span>{isZh ? '目标' : 'Target'}</span>
            <code>{result.locator}</code>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="atl-browser-result atl-browser-result--text">
      <div className="atl-browser-result__head">
        <span className="atl-browser-result__status">{result.action}</span>
      </div>
      <pre className="atl-browser-result__pre">{result.text}</pre>
      {typeof progress === 'number' && <BrowserProgress progress={progress} progressText={progressText} />}
    </div>
  );
};

