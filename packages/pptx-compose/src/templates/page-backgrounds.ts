import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { ZStack, Image } from '../compose/dsl.js';
import { activeSpec } from './theme.js';
import { STYLE_BACKGROUNDS, type BackgroundRole } from '../assets/backgrounds.generated.js';

export type { BackgroundRole };
/** 背景来源: 本地路径 / URL (订阅用户现出的图) 或 data URL (内置) */
export type BackgroundSource = { uri: string } | { dataUrl: string };

/** 当前风格内置的那张背景; 风格没有内置素材时返回 undefined */
export function builtinBackground(role: BackgroundRole, styleId?: string): BackgroundSource | undefined {
  const id = styleId ?? activeSpec()?.id;
  const dataUrl = id ? STYLE_BACKGROUNDS[id]?.[role] : undefined;
  return dataUrl ? { dataUrl } : undefined;
}

/** 满出血画一张背景图, 在最底层 —— 必须在模板之前调 (z 序就是调用序) */
export function pageBackground(slide: Slide, source: BackgroundSource): void {
  render(slide, ZStack({ align: 'start', width: 1280, height: 720 }, [
    Image(source as never, { bleed: true, fit: 'cover', width: 1280, height: 720 }),
  ]), { bounds: { x: 0, y: 0, width: 1280, height: 720 }, assertNoOverlap: false, fit: false });
}
