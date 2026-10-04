import { describe, expect, it } from 'vitest';
import {
  convertStepPoints, coordConventionFor, coordHint, rememberShotSize, toWindowRatio,
} from '../computerCoords.js';
import { appNotesFor } from '../computerAppNotes.js';

describe('coordConventionFor', () => {
  it('Qwen3 / GLM / Gemini 用 0~1000 网格, Claude / GPT / 未知用像素', () => {
    expect(coordConventionFor('qwen3.8-max')).toBe('norm1000');
    expect(coordConventionFor('glm-5.3')).toBe('norm1000');
    expect(coordConventionFor('gemini-3-pro')).toBe('norm1000');
    expect(coordConventionFor('claude-opus-5-5')).toBe('pixels');
    expect(coordConventionFor('gpt-6-sol')).toBe('pixels');
    expect(coordConventionFor('deepseek-v4-flash-vision-exp')).toBe('pixels');
    expect(coordConventionFor(undefined)).toBe('pixels');
  });
  it('Qwen2.5-VL 训练时是像素', () => {
    expect(coordConventionFor('qwen2.5-vl-72b')).toBe('pixels');
  });
});

describe('toWindowRatio', () => {
  it('像素按实际交给模型的图折算, 越界夹到 0~1', () => {
    expect(toWindowRatio(640, 200, 'pixels', { width: 1280, height: 800 })).toEqual({ dx: 0.5, dy: 0.25 });
    expect(toWindowRatio(2000, -5, 'pixels', { width: 1280, height: 800 })).toEqual({ dx: 1, dy: 0 });
  });
  it('0~1000 网格不需要图尺寸', () => {
    expect(toWindowRatio(500, 250, 'norm1000')).toEqual({ dx: 0.5, dy: 0.25 });
  });
  it('像素约定但不知道图多大 → 换不了', () => {
    expect(toWindowRatio(10, 10, 'pixels')).toBeNull();
  });
});

describe('coordHint', () => {
  it('说明里写上图的尺寸 / 网格', () => {
    expect(coordHint('pixels', { width: 1280, height: 800 })).toMatch(/pixels of this 1280×800 image/);
    expect(coordHint('norm1000')).toMatch(/0-1000 grid/);
  });
});

describe('convertStepPoints', () => {
  it('x/y、x2/y2 换成 dx/dy; 老的 dx/dy 与编号步骤原样放行', () => {
    rememberShotSize('Figma', { width: 1000, height: 500 });
    const r = convertStepPoints({
      app: 'figma',
      steps: [
        { action: 'click_at', x: 250, y: 250 },
        { action: 'drag', x: 0, y: 0, x2: 1000, y2: 500 },
        { action: 'click_at', dx: 0.3, dy: 0.4 },
        { action: 'click', target: 7 },
      ],
    }, 'claude-opus-5-5');
    expect('args' in r && r.args.steps).toEqual([
      { action: 'click_at', dx: 0.25, dy: 0.5 },
      { action: 'drag', dx: 0, dy: 0, dx2: 1, dy2: 1 },
      { action: 'click_at', dx: 0.3, dy: 0.4 },
      { action: 'click', target: 7 },
    ]);
  });
  it('像素约定、这个应用还没截过图 → 报错让它先看', () => {
    const r = convertStepPoints({ app: 'NeverSeen', steps: [{ action: 'click_at', x: 1, y: 1 }] }, 'gpt-6-sol');
    expect('error' in r && r.error).toMatch(/computer_snapshot first/);
  });
  it('0~1000 网格不依赖截图', () => {
    const r = convertStepPoints({ app: 'NeverSeen', steps: [{ action: 'click_at', x: 100, y: 900 }] }, 'qwen3.8-max');
    expect('args' in r && r.args.steps[0]).toEqual({ action: 'click_at', dx: 0.1, dy: 0.9 });
  });
});

describe('appNotesFor', () => {
  it('只在命中的应用给经验', () => {
    expect(appNotesFor('演示文稿1 - WPS 2019')).toMatch(/DOCUMENT window title/);
    expect(appNotesFor('微信')).toMatch(/发送菜单/);
    expect(appNotesFor('Figma')).toBeUndefined();
  });
});
