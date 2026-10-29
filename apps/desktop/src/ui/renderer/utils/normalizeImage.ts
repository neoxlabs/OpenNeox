
/** 上游真正接受的图片格式 —— 三家一致, 不要凭感觉往里加。 */
export const UPSTREAM_SAFE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export type NormalizeResult =
  | { ok: true; dataUrl: string; converted: false }
  | { ok: true; dataUrl: string; converted: true; fromType: string }
  | { ok: false; reason: 'undecodable' | 'not-an-image'; fromType: string };

/** `data:image/bmp;base64,AAA…` → `image/bmp`; 拿不到返回 ''。 */
export function mediaTypeOf(dataUrl: string): string {
  const m = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return m ? m[1].toLowerCase().trim() : '';
}

/** 供 UI 显示的短名: `image/bmp` → `BMP`。 */
export function shortFormatName(mediaType: string): string {
  const sub = mediaType.split('/')[1] || mediaType;
  return sub.replace(/^x-/, '').split('+')[0].toUpperCase();
}

/**
 * 把 dataURL 归一化成上游收的格式。
 *
 * 只在渲染进程可用 (要 Image + canvas)。失败**不抛异常** —— 调用方拿 ok:false
 * 自己决定怎么提示, 免得一张贴错的图把整条附件流程炸掉。
 */
export async function normalizeImageDataUrl(dataUrl: string): Promise<NormalizeResult> {
  const fromType = mediaTypeOf(dataUrl);
  if (!fromType.startsWith('image/')) {
    return { ok: false, reason: 'not-an-image', fromType: fromType || '(unknown)' };
  }
  if (UPSTREAM_SAFE_IMAGE_TYPES.has(fromType)) {
    /* 已经安全 —— 原样走, 别碰。见文件头"只转必须转的"。 */
    return { ok: true, dataUrl, converted: false };
  }

  try {
    const img = await loadImage(dataUrl);
    /* naturalWidth 为 0 = 解码失败(某些格式 onload 也会触发, 但尺寸是空的) */
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return { ok: false, reason: 'undecodable', fromType };

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, reason: 'undecodable', fromType };
    ctx.drawImage(img, 0, 0);
    const out = canvas.toDataURL('image/png');
    /* toDataURL 在极端情况下会返回 "data:," —— 当失败处理, 不要把空图发出去 */
    if (!out.startsWith('data:image/png;base64,') || out.length < 32) {
      return { ok: false, reason: 'undecodable', fromType };
    }
    return { ok: true, dataUrl: out, converted: true, fromType };
  } catch {
    return { ok: false, reason: 'undecodable', fromType };
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode failed'));
    img.src = src;
  });
}

/** 附件阶段告诉用户"这张图为什么用不了" —— 要说得出他能做什么。 */
export function unsupportedImageMessage(fromType: string, isZh: boolean): string {
  const name = shortFormatName(fromType);
  return isZh
    ? `这张 ${name} 图片本机解不开, 没法发给模型。请另存为 PNG / JPEG 后再试。`
    : `This ${name} image can’t be decoded on your machine, so it can’t be sent. Save it as PNG or JPEG and try again.`;
}
