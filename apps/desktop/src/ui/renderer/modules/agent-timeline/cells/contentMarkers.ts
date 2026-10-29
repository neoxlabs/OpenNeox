/* 渲染期内容标记 —— 替代 agent-timeline.css 里"看子节点类型决定样式"的 `:has()`。
 *
 *   `:has()` 会让祖先在任意后代 class 变化时参与失效重算; 而这些结论在渲染时
 *   本来就知道 (content.type / isBrowser / 行首 __IMG__)。改成 data-* 属性后,
 *   选择器只剩一个属性判断, 滚动期不再有祖先失效条件 (work:M-03)。
 *
 *   属性名与 CSS 里的取值是契约, 改动要同步 agent-timeline.css 与
 *   __tests__/scrollHasFree.test.ts。
 */
import type { StepContent } from '../types';
import { browserResultIsSuccess } from './BrowserResultView';

export type ContentMarkers = Record<string, string>;

const IMAGE_LINE_PREFIX = '__IMG__';

/** 与 StepContentRenderer 传给 BrowserResultView 的 lines 对齐 —— 类型判定不读标题/上下文。 */
function browserResultLines(content: StepContent): { text: string }[] {
  if (content.type === 'code') return content.lines;
  if (content.type === 'error') {
    return [{ text: [content.code, content.message].filter(Boolean).join(' ') }];
  }
  return [];
}

export function contentDataMarkers(content: StepContent | undefined): ContentMarkers {
  if (!content) return {};
  const markers: ContentMarkers = { 'data-content-type': content.type };

  if (content.type === 'code') {
    if (content.lines.some((line) => line.text.startsWith(IMAGE_LINE_PREFIX))) {
      markers['data-has-image'] = '1';
    }
  }

  if ((content.type === 'code' || content.type === 'error') && content.isBrowser) {
    markers['data-browser-result'] = '1';
    if (browserResultIsSuccess(browserResultLines(content))) {
      markers['data-browser-success'] = '1';
    }
  }

  return markers;
}
