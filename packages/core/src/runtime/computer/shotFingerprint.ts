/**
 * 截图指纹 —— 判"这张跟上一张是不是同一个画面", 是就不再把图发给模型。
 *
 * 一张窗口截图进上下文是一千多 token; 连着几步都在同一个界面上时 (输入框里打字、
 * 点了个没反应的按钮), 新图跟上一张一模一样, 再发一遍只是把同一张图塞两次。
 *
 * 比法: 缩成 96×60 灰度, 逐格比亮度。光标闪烁/时钟跳一下只动一两格, 而勾选框、
 * 弹出菜单、新消息这种真变化至少动好几格 —— 门槛按这个定。宁可多发一张, 不可漏发:
 * 拿不到指纹 (sharp 不在 / 图坏了) 一律当"不同"。
 */

const W = 96;
const H = 60;
/** 一格亮度差超过这个才算"这格变了" (0~255) */
const CELL_DELTA = 12;
/** 变了的格子不超过这么多, 才算同一个画面 */
const MAX_CHANGED_CELLS = 3;

export type ShotFingerprint = Uint8Array;

export async function shotFingerprint(buf: Buffer): Promise<ShotFingerprint | null> {
  try {
    const sharp = (await import('sharp')).default;
    const raw = await sharp(buf).resize(W, H, { fit: 'fill' }).greyscale().raw().toBuffer();
    return raw.length === W * H ? new Uint8Array(raw) : null;
  } catch {
    return null;
  }
}

export function sameShot(a: ShotFingerprint | null | undefined, b: ShotFingerprint | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i]! - b[i]!) > CELL_DELTA && ++changed > MAX_CHANGED_CELLS) return false;
  }
  return true;
}
