import type { StepContent } from './types';
import type { TimelineEntry } from '../../utils/workspaceUtils';
import type { Row } from './timelineRows';
import { rowStepToTimelineStep } from './timelineRows';
import { stripToolHintHeader } from './toolResultHint';

const SEEN_IMAGES_PREFIX = '__NEOX_SEEN_IMAGES__';

export type SeenImage = Extract<StepContent, { type: 'seen_images' }>['images'][number];

export function parseSeenImages(out: string | undefined): SeenImage[] | undefined {
  if (!out || typeof out !== 'string' || !out.includes(SEEN_IMAGES_PREFIX)) return undefined;
  let text = out;
  const trimmed = stripToolHintHeader(out.trim());
  if (trimmed.startsWith('{')) {
    try {
      const env = JSON.parse(trimmed);
      if (env && typeof env.content === 'string') text = env.content;
    } catch { /* 不是完整 JSON, 按位置找 */ }
  }
  const idx = text.indexOf(SEEN_IMAGES_PREFIX);
  if (idx < 0) return undefined;
  try {
    const parsed = JSON.parse(text.slice(idx + SEEN_IMAGES_PREFIX.length));
    const images: SeenImage[] = (Array.isArray(parsed?.images) ? parsed.images : [])
      .filter((img: any) => typeof img?.path === 'string' && img.path)
      .map((img: any) => ({ path: img.path as string, ...(typeof img.label === 'string' && img.label ? { label: img.label as string } : {}) }));
    return images.length > 0 ? images : undefined;
  } catch {
    return undefined;
  }
}

export function buildSeenImagesContent(entry: TimelineEntry): StepContent | undefined {
  if (entry.type !== 'tool_result' && entry.type !== 'tool_call') return undefined;
  const images = parseSeenImages(entry.output) ?? parseSeenImages(entry.detail);
  return images ? { type: 'seen_images', images } : undefined;
}

/**
 * 这些行里模型看过的图, 按出现顺序 —— 折叠头上那一排缩略图用。
 * 一轮做完会整段折成一行 (turn_fold), agent 截图验证的那几张就跟着折进去了;
 * 用户要的是不点开也能看见它看到了什么。
 */
export function rowsSeenImages(rows: Row[]): SeenImage[] {
  const out: SeenImage[] = [];
  const fromStep = (s: Parameters<typeof rowStepToTimelineStep>[0]) => {
    const c = rowStepToTimelineStep(s).content;
    if (c?.type === 'seen_images') out.push(...c.images);
  };
  const walk = (rs: Row[]) => {
    for (const r of rs) {
      if (r.kind === 'single') fromStep(r.step);
      else if (r.kind === 'group' || r.kind === 'cluster') r.items.forEach(fromStep);
      else if (r.kind === 'activity' || r.kind === 'turn_fold') walk(r.rows);
    }
  };
  walk(rows);
  return out;
}
