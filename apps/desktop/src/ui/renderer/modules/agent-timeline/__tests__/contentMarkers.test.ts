/* 渲染期内容标记 —— 这些属性是 agent-timeline.css 替代 `:has()` 的判据 (work:M-03)。
 * 只要标记算错，卡片样式会静默变样，所以每个分支都钉一遍。 */
import { describe, it, expect } from 'vitest';
import { contentDataMarkers } from '../cells/contentMarkers';
import type { StepContent } from '../types';

describe('contentDataMarkers', () => {
  it('turn_summary / plan 走 data-content-type', () => {
    expect(contentDataMarkers({ type: 'turn_summary' } as StepContent))
      .toMatchObject({ 'data-content-type': 'turn_summary' });
    expect(contentDataMarkers({ type: 'plan', goal: '', steps: [] } as unknown as StepContent))
      .toMatchObject({ 'data-content-type': 'plan' });
  });

  it('普通错误卡不当作浏览器结果', () => {
    const markers = contentDataMarkers({ type: 'error', message: 'boom' } as StepContent);
    expect(markers['data-content-type']).toBe('error');
    expect(markers['data-browser-result']).toBeUndefined();
  });

  it('浏览器错误卡带 browser-result 标记', () => {
    const markers = contentDataMarkers({
      type: 'error',
      message: 'BROWSER_TIMEOUT timeout',
      isBrowser: true,
    } as StepContent);
    expect(markers['data-browser-result']).toBe('1');
  });

  it('code 里的 __IMG__ 行打 has-image', () => {
    const withImage = contentDataMarkers({
      type: 'code',
      lines: [{ text: 'text' }, { text: '__IMG__data:image/png;base64,xx' }],
    } as StepContent);
    expect(withImage['data-has-image']).toBe('1');

    const plain = contentDataMarkers({ type: 'code', lines: [{ text: 'text' }] } as StepContent);
    expect(plain['data-has-image']).toBeUndefined();
  });

  it('浏览器 code 结果的成功态与 --success 视觉档一致', () => {
    const success = contentDataMarkers({
      type: 'code',
      isBrowser: true,
      lines: [{ text: '✓ https://example.com 打开完成' }],
    } as StepContent);
    expect(success['data-browser-result']).toBe('1');
    expect(success['data-browser-success']).toBe('1');

    const failure = contentDataMarkers({
      type: 'code',
      isBrowser: true,
      lines: [{ text: 'Timeout 3000ms exceeded calling locator.click' }],
    } as StepContent);
    expect(failure['data-browser-result']).toBe('1');
    expect(failure['data-browser-success']).toBeUndefined();
  });

  it('askUser 的结算标记不在这里算 (shell 上要连 dockOwns 一起判)', () => {
    expect(contentDataMarkers({
      type: 'askUser', status: 'answered', questions: [],
    } as StepContent)['data-ask-settled']).toBeUndefined();
  });

  it('log / 富卡 / 定时卡的内容类型可直接选', () => {
    expect(contentDataMarkers({ type: 'log', level: 'info', message: 'x' } as StepContent)['data-content-type'])
      .toBe('log');
    expect(contentDataMarkers({ type: 'neox_card', kind: 'weather', body: {} } as unknown as StepContent)['data-content-type'])
      .toBe('neox_card');
    expect(contentDataMarkers({ type: 'timer_card' } as unknown as StepContent)['data-content-type'])
      .toBe('timer_card');
  });
});
