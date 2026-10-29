import { describe, test, expect } from 'vitest';
import { shouldShowActivityChildHead } from '../activityChildHead';

describe('activity 子行 head 显隐', () => {
  test('用户点开的 cluster(读取文件 ×16) 必须保留 head —— 否则收不回去', () => {
    expect(shouldShowActivityChildHead({
      expanded: true, contentOwnsChrome: true, expandLive: false, userToggled: true, kind: 'cluster',
    })).toBe(true);
  });

  test('用户点开的单行 Explore 也要保留 head', () => {
    expect(shouldShowActivityChildHead({
      expanded: true, contentOwnsChrome: true, expandLive: false, userToggled: true, kind: 'single',
    })).toBe(true);
  });

  test('运行中自动展开的 cluster 仍保留 head (它是 N 个卡片的总开关, 不是重复的头)', () => {
    expect(shouldShowActivityChildHead({
      expanded: true, contentOwnsChrome: true, expandLive: true, userToggled: null, kind: 'cluster',
    })).toBe(true);
  });

  test('运行中自动展开的单行 Explore 才藏 head (避免双层头, 且它会自己收)', () => {
    expect(shouldShowActivityChildHead({
      expanded: true, contentOwnsChrome: true, expandLive: true, userToggled: null, kind: 'single',
    })).toBe(false);
  });

  test('非 Explore 内容一律保留 head', () => {
    expect(shouldShowActivityChildHead({
      expanded: true, contentOwnsChrome: false, expandLive: true, userToggled: null, kind: 'single',
    })).toBe(true);
  });

  test('折叠态永远有 head', () => {
    for (const kind of ['single', 'cluster']) {
      expect(shouldShowActivityChildHead({
        expanded: false, contentOwnsChrome: true, expandLive: false, userToggled: null, kind,
      })).toBe(true);
    }
  });

  test('只有一次思考时不画子行头 —— 头和 details 是同一段字', () => {
    for (const expanded of [true, false]) {
      expect(shouldShowActivityChildHead({
        expanded, contentOwnsChrome: false, expandLive: false, userToggled: null,
        kind: 'single', soleThinkingChild: true,
      })).toBe(false);
    }
  });

  test('用户手动切过也照样不画 —— 折叠入口在外层活动头上, 不会丢', () => {
    expect(shouldShowActivityChildHead({
      expanded: true, contentOwnsChrome: false, expandLive: false, userToggled: true,
      kind: 'single', soleThinkingChild: true,
    })).toBe(false);
  });

  test('不传这个标志时行为与以前**逐位一致** (回归护栏)', () => {
    /* 新参数是可选的; 老调用点一个都没改就该保持原判。这里把上面每条用例的输入
     * 再跑一遍显式 soleThinkingChild:false, 结果必须跟不传时相同。 */
    const cases = [
      { expanded: true, contentOwnsChrome: true, expandLive: false, userToggled: true, kind: 'cluster' },
      { expanded: true, contentOwnsChrome: true, expandLive: false, userToggled: true, kind: 'single' },
      { expanded: true, contentOwnsChrome: true, expandLive: true, userToggled: null, kind: 'cluster' },
      { expanded: true, contentOwnsChrome: true, expandLive: true, userToggled: null, kind: 'single' },
      { expanded: true, contentOwnsChrome: false, expandLive: true, userToggled: null, kind: 'single' },
      { expanded: false, contentOwnsChrome: true, expandLive: false, userToggled: null, kind: 'single' },
    ] as const;
    for (const c of cases) {
      expect(shouldShowActivityChildHead({ ...c, soleThinkingChild: false }))
        .toBe(shouldShowActivityChildHead({ ...c }));
    }
  });
});

describe('跟外层说同一件事的唯一子行', () => {
  test('藏头', () => {
    expect(shouldShowActivityChildHead({
      expanded: true, contentOwnsChrome: false, expandLive: false, userToggled: null, kind: 'single', soleRedundantChild: true,
    })).toBe(false);
  });
  test('藏头的同时 details 被强制展开 —— 不然内容没人能点开', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../ActivityRow.tsx'), 'utf8');
    expect(src).toMatch(/\|\| soleThinkingChild[\s\S]{0,200}\|\| soleRedundantChild/);
  });
});
