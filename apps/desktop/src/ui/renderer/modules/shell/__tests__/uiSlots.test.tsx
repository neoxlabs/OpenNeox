/**
 * 插槽契约的守门测试。
 *
 * 这套机制的价值全在"公开构建不注册时行为跟没有插槽一模一样", 以及"注册方能干净地
 * 接管和退出"。两条都不是看代码能一眼确认的, 所以钉在测试里。
 *
 * 用 renderToStaticMarkup 而不是 DOM testing 库: 这里要验的是"选中哪个组件",
 * 一次纯渲染就能答, 不值得为此引入一整套 DOM 测试依赖。
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { UiSlot, registerUiSlot, getUiSlot, type UiSlotName } from '../uiSlots';

const Fallback: React.FC = () => <div id="fallback">local</div>;

describe('UiSlot', () => {
  it('没有注册时渲染兜底内容', () => {
    const html = renderToStaticMarkup(
      <UiSlot name="sidebar.footer" props={{}}><Fallback /></UiSlot>,
    );
    expect(html).toContain('id="fallback"');
  });

  it('注册后由实现接管, 并拿到挂载点给的 props', () => {
    const unregister = registerUiSlot('sidebar.footer', ({ onOpenSettings }) => (
      <button type="button" id="impl" disabled={!onOpenSettings}>account</button>
    ));
    try {
      const html = renderToStaticMarkup(
        <UiSlot name="sidebar.footer" props={{ onOpenSettings: () => {} }}><Fallback /></UiSlot>,
      );
      expect(html).toContain('id="impl"');
      expect(html).not.toContain('id="fallback"');
      /* props 真的透传到了实现: 没拿到回调这颗按钮会是 disabled */
      expect(html).not.toContain('disabled');
    } finally {
      unregister();
    }
  });

  it('取消注册后退回兜底 —— 发行版卸载自己的实现不该把这一行变成空白', () => {
    registerUiSlot('sidebar.footer', () => <div id="impl" />)();
    const html = renderToStaticMarkup(
      <UiSlot name="sidebar.footer" props={{}}><Fallback /></UiSlot>,
    );
    expect(html).toContain('id="fallback"');
  });

  it('重复注册以最后一次为准, 且旧实现的 unregister 不会误删新实现', () => {
    const undoA = registerUiSlot('iconrail.footer', () => <div id="a" />);
    const undoB = registerUiSlot('iconrail.footer', () => <div id="b" />);
    undoA();
    try {
      expect(getUiSlot('iconrail.footer')).toBeTruthy();
      const html = renderToStaticMarkup(
        <UiSlot name="iconrail.footer" props={{}}><Fallback /></UiSlot>,
      );
      expect(html).toContain('id="b"');
    } finally {
      undoB();
    }
  });
});

describe('editionSlots', () => {
  /* 公开构建那条断言是"注册完仍是空的" —— 本仓是带账号体系的发行版, 注册入口
   * 会挂上账户行, 所以这里钉的是相反的事实: 注册必须真的生效, 且只碰它该碰的插槽。
   * 两个发行版共用同一份挂载点与 props 契约, 差异只在这一个文件。 */
  /* 公开树里 edition/ 整个不存在: 注册完所有插槽都该是空的, 由兜底内容接管 */
  const hasEdition = existsSync(join(__dirname, '..', 'edition', 'index.tsx'));

  it('注册入口把账户行挂上 sidebar.footer (公开树: 保持为空)', async () => {
    const { registerEditionSlots } = await import('../editionSlots');
    registerEditionSlots();
    if (hasEdition) expect(getUiSlot('sidebar.footer')).toBeTruthy();
    else expect(getUiSlot('sidebar.footer')).toBeUndefined();
  });

  it('账号相关的挂载点都有实现, 没有实现的插槽保持为空由兜底内容接管', async () => {
    const { registerEditionSlots } = await import('../editionSlots');
    registerEditionSlots();
    const registered: UiSlotName[] = [
      'iconrail.footer',
      'auth.login',
      'app.overlays',
      'topbar.notifications',
      'sidebar.session.badge',
      'settings.tab.account',
      'settings.tab.subscription',
      'settings.usage.subscription',
      'settings.data-stale',
      'settings.about.sections',
    ];
    for (const name of registered) {
      if (hasEdition) expect(getUiSlot(name), name).toBeTruthy();
      else expect(getUiSlot(name), name).toBeUndefined();
    }
    /* 消耗倍率角标这版还没做 —— 契约留着, 注册方没有 */
    expect(getUiSlot('composer.model.badge')).toBeUndefined();
  });

  it('入口是 glob 找发行版目录, 不是静态 import —— 公开树删掉 edition/ 也照样编译', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '..', 'editionSlots.ts'), 'utf8');
    expect(src).toMatch(/import\.meta\.glob<EditionEntry>\('\.\/edition\/index\.tsx'/);
    expect(src, 'editionSlots.ts 不许静态 import edition/ —— 目录不在时编译直接失败')
      .not.toMatch(/from ['"]\.\/edition\//);
  });
});
