import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const composer = readFileSync(resolve(HERE, '../TimelineComposer.tsx'), 'utf8');
const ctxTabRaw = readFileSync(resolve(HERE, '../../../pages/settings/tabs/ContextTab.tsx'), 'utf8');
/* 注释里引用旧文案是在解释为什么改 —— 只看会渲染出去的声明 */
const ctxTab = ctxTabRaw.replace(/\/\*[\s\S]*?\*\//g, '');

describe('/clear', () => {
  it('两个入口都走同一个带确认的函数, 没有裸调 clearSession', () => {
    /* 裸调 = 不问就清 */
    expect(composer).not.toMatch(/api\.clearSession\(sid\)\.catch/);
    expect(composer).not.toMatch(/api\?\.clearSession\(sid\)\.catch/);
    const calls = [...composer.matchAll(/confirmAndClearSession\(sid, isZh\)/g)];
    expect(calls.length, '敲命令 + 面板选中, 两个入口').toBe(2);
  });

  it('那个函数里确实有 confirmAsync, 且失败会告诉用户', () => {
    const fn = composer.slice(composer.indexOf('async function confirmAndClearSession'),
                              composer.indexOf('/* / 补全条目'));
    expect(fn).toMatch(/confirmAsync\(/);
    expect(fn).toMatch(/variant: 'danger'/);
    expect(fn).toMatch(/dispatchOpFailedFromError/);
    expect(fn).not.toMatch(/console\.error/);
  });
});

describe('确认文案不许说假话', () => {
  it('不再承诺「消息记录会保留」—— clearMessages() 是真删', () => {
    expect(ctxTab).not.toMatch(/消息记录会保留/);
    expect(ctxTab).not.toMatch(/Message history is preserved/);
  });

  it('两处文案说的是同一件事', () => {
    for (const src of [composer, ctxTabRaw]) {
      expect(src).toMatch(/屏幕上的内容要到下次启动才消失/);
    }
  });
});
