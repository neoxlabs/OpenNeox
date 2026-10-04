
export type CoordConvention = 'pixels' | 'norm1000';

/** 0~1000 网格的家族; 其余 (Claude / GPT / Kimi / DeepSeek / 未知) 按截图像素 —— 说明里写明了图多大, 最不容易误解 */
const NORM1000_FAMILIES = /qwen|qwq|glm|gemini|ui-?tars|doubao|seed/i;

export function coordConventionFor(modelName?: string): CoordConvention {
  const name = String(modelName ?? '');
  // Qwen2.5-VL 训练时用的是绝对像素, 只有 Qwen3 起才改成 0~1000
  if (/qwen2\.5-vl/i.test(name)) return 'pixels';
  return NORM1000_FAMILIES.test(name) ? 'norm1000' : 'pixels';
}

export interface ShotSize { width: number; height: number }

/** 模型报的点 → 桥要的窗口内比例 (夹到 0~1)。尺寸未知且是像素约定时换不了, 返回 null */
export function toWindowRatio(
  x: number, y: number, conv: CoordConvention, shot?: ShotSize,
): { dx: number; dy: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  if (conv === 'norm1000') return { dx: clamp(x / 1000), dy: clamp(y / 1000) };
  if (!shot || !(shot.width > 0) || !(shot.height > 0)) return null;
  return { dx: clamp(x / shot.width), dy: clamp(y / shot.height) };
}

/** 截图说明里告诉模型怎么报坐标 —— 跟 toWindowRatio 用同一个约定 */
export function coordHint(conv: CoordConvention, shot?: ShotSize): string {
  const size = shot ? `${shot.width}×${shot.height}` : '';
  return conv === 'norm1000'
    ? `To click something you see, pass x/y on a 0-1000 grid over this image (0,0 top-left, 1000,1000 bottom-right).`
    : `To click something you see, pass x/y in pixels of this ${size} image (0,0 top-left).`;
}

/* 同一个应用最近一张交给模型的截图多大 —— computer_run 换算像素坐标用。
 * 按应用记而不是全局一张: 模型可能先看 A 再操作 B。 */
const lastShotSize = new Map<string, ShotSize>();

export function rememberShotSize(app: string | undefined, size: ShotSize): void {
  lastShotSize.set(String(app ?? '').toLowerCase(), size);
}

export function lastShotSizeFor(app: string | undefined): ShotSize | undefined {
  return lastShotSize.get(String(app ?? '').toLowerCase());
}

/**
 * computer_run 的步骤: 模型按自己的坐标系报的 x/y (x2/y2) → 桥要的窗口内比例 dx/dy。
 * 老写法 (直接给 dx/dy 比例) 原样放行。像素约定但还没见过这个应用的截图 → 换不了, 报错让它先看一眼。
 */
export function convertStepPoints(args: any, modelName: string | undefined): { args: any } | { error: string } {
  if (!Array.isArray(args?.steps)) return { args };
  const conv = coordConventionFor(modelName);
  const shot = lastShotSizeFor(args.app);
  const steps = [];
  for (const [i, raw] of (args.steps as any[]).entries()) {
    const step = { ...raw };
    for (const [xk, yk, dxk, dyk] of [['x', 'y', 'dx', 'dy'], ['x2', 'y2', 'dx2', 'dy2']] as const) {
      if (typeof step[xk] !== 'number' || typeof step[yk] !== 'number') continue;
      const r = toWindowRatio(step[xk], step[yk], conv, shot);
      if (!r) return { error: `Step ${i + 1}: x/y are pixels of the last screenshot, but there is no screenshot of ${args.app ?? 'this app'} yet — call computer_snapshot first.` };
      step[dxk] = r.dx;
      step[dyk] = r.dy;
      delete step[xk];
      delete step[yk];
    }
    steps.push(step);
  }
  return { args: { ...args, steps } };
}
