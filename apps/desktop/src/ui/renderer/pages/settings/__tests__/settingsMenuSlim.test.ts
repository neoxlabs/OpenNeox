import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ADVANCED_ONLY_TABS } from '../../../state/settingsLevel';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, '..', rel), 'utf8');
const page = read('SettingsPage.tsx');
const theme = read('tabs/ThemeTab.tsx');
const conv = read('tabs/ConversationTab.tsx');

describe('桌宠独立成页', () => {
  it('ThemeTab 不再 import / 内嵌 PetTab', () => {
    expect(theme).not.toMatch(/from '\.\/PetTab'/);
    expect(theme).not.toMatch(/<PetTab/);
    expect(theme).not.toMatch(/theme-pet-section/);
  });

  it('设置页有自己的「桌宠」导航项和渲染分支', () => {
    expect(page).toMatch(/activeTab === 'pet' && <LazyPetTab \/>/);
    expect(page).toMatch(/setActiveTab\('pet'\)/);
  });

  it('不再把 pet 深链改写成 theme —— 那条迁移正是"点桌宠落到主题页"的来源', () => {
    expect(page).not.toMatch(/=== 'pet'\)\s*return 'theme'/);
  });

  it('搜索「宠物」进的是自己这一页, 不是主题页的锚点', () => {
    expect(page).toMatch(/\{ tab: 'pet', zh: '宠物'/);
    expect(page).toMatch(/\{ tab: 'pet', zh: '选择宠物'[^}]*anchor: 'setting-mascot'/);
    expect(page).not.toMatch(/tab: 'theme', zh: '(桌宠|宠物|桌面伙伴)'/);
  });
});

describe('默认档只留常用页', () => {
  /* 判据 (settingsLevel.ts 头部): 只在排障/一次性维护时用, 或全页都要内部名词才解释得清。
   * 功能一个没删 —— 打开「显示高级设置」全都回来, 由下面「不许误伤」那条守住边界。 */
  it.each(['editor', 'keymap', 'codeindex', 'storage', 'tts', 'websearch', 'routing', 'modelprofile', 'orchestrator', 'context', 'experimental', 'cloud-agent'])(
    '%s 在默认档下不出现', (tab) => { expect(ADVANCED_ONLY_TABS.has(tab)).toBe(true); },
  );

  it('不许误伤: 这些是普通用户天天用的, 任何时候都必须在导航里', () => {
    for (const keep of ['theme', 'conversation', 'notify', 'agent', 'pet', 'providers', 'mcp', 'skills', 'memory', 'mobile', 'about', 'account', 'subscription', 'usage']) {
      expect(ADVANCED_ONLY_TABS.has(keep), `${keep} 不该被藏`).toBe(false);
    }
  });

  it('导航扁平常驻 —— 不许再有折叠头 / 组副标题', () => {
    expect(page).not.toMatch(/settings-nav__group-head/);
    expect(page).not.toMatch(/settings-nav__group-sub/);
    expect(page).toMatch(/settings-nav__group-label/);
  });
});

describe('对话区预览不是卡中卡', () => {
  it('预览块自己不画底色和边框 —— 它长在字号卡里', () => {
    expect(conv).toMatch(/<div className="cv-preview" style=\{previewVars\}>/);
    const css = readFileSync(resolve(HERE, '../../../styles/settings-core/layout/settings-page/layout-nav.css'), 'utf8');
    const rule = css.slice(css.indexOf('.cv-preview {'), css.indexOf('}', css.indexOf('.cv-preview {')));
    expect(rule.length).toBeGreaterThan(10);
    expect(rule).not.toMatch(/background/);
    expect(rule).not.toMatch(/border:/);
  });
});

describe('语音输入是真开关, 不是死字段', () => {
  const composer = readFileSync(resolve(HERE, '../../../modules/agent-timeline/TimelineComposer.tsx'), 'utf8');
  const tts = read('tabs/voice/VoiceInputSection.tsx');
  const handlers = readFileSync(resolve(HERE, '../../../../electron/ipc/featureConfigHandlers.ts'), 'utf8');

  /* config.stt.enabled 2026-07 就存在, 注释还写着"默认 true", 但**全仓零消费方** ——
   * 麦克风按钮无条件渲染, 设置页也从没露过这个开关。三处必须同时在, 少一处就又变回死字段。 */
  it('主进程把 enabled 读出来也写得回去', () => {
    expect(handlers).toMatch(/enabled: stt\.enabled !== false/);
    expect(handlers).toMatch(/stt:set-config[\s\S]{0,120}enabled\?: boolean/);
  });

  it('设置页有这个开关', () => {
    expect(tts).toMatch(/checked=\{cfg\.enabled\}/);
    expect(tts).toMatch(/neox:stt-config-changed/);
  });

  it('输入框按它显隐 —— 按钮 / 「+」菜单项 / ⌘⇧M 三个入口都要跟着关', () => {
    /* 标准态 / 简约态两处麦克风都走 renderMicButton, 显隐判断收在它里面 */
    expect(composer).toMatch(/const renderMicButton = \(iconSize: number\) => \(voiceInputOn \? \(/);
    expect(composer).toMatch(/hideVoice=\{!voiceInputOn\}/);
    const keyBlock = composer.slice(composer.indexOf("e.key === 'm' || e.key === 'M'"));
    expect(keyBlock.slice(0, 600)).toMatch(/if \(!voiceInputOn\) return;/);
    const guardAt = keyBlock.indexOf('if (!voiceInputOn) return;');
    const actionAt = keyBlock.indexOf('toggleMic()');
    expect(guardAt).toBeGreaterThan(-1);
    expect(actionAt).toBeGreaterThan(guardAt);
    /* 默认关: useState(false) 且只有 === true 才置真 */
    expect(composer).toMatch(/const \[voiceInputOn, setVoiceInputOn\] = useState\(false\)/);
    expect(composer).toMatch(/setVoiceInputOn\(r\.enabled === true\)/);
  });
});

describe('字号: 右侧内容不许比左侧导航大', () => {
  const css = (rel: string) => readFileSync(resolve(HERE, '../../../styles', rel), 'utf8');
  const material = css('settings-core/material.css');
  const soft = css('settings-core/settings-soft.css');
  const nav = css('settings-core/layout/settings-page/layout-nav.css');

  it('settings 阶梯引用全局 --neox-fs-*, 不再自己写死 px', () => {
    const block = material.slice(material.indexOf('--nx-fs-page'), material.indexOf('--nx-fs-group') + 60);
    for (const v of ['--nx-fs-section', '--nx-fs-row-title', '--nx-fs-row-desc', '--nx-fs-group']) {
      expect(block, `${v} 必须引用全局阶梯`).toMatch(new RegExp(`${v}:\\s*var\\(--neox-fs-`));
    }
    expect(block).toMatch(/--nx-fs-row-title:\s*var\(--neox-fs-md\)/);
    expect(block).toMatch(/--nx-fs-row-desc:\s*var\(--neox-fs-sm\)/);
    /* 左右同号: 导航项必须跟条目名一个档位 */
    expect(nav).toMatch(/\.nav-item \{[\s\S]*?font-size: var\(--neox-fs-md/);
  });

  it('后几代 CSS 不许再把这几个值写死回去 —— 它们特异度更高, 写死就把变量架空', () => {
    /* 这三条以前分别是 22px / var(--neox-fs-sm,13px) / var(--neox-fs-md,14px) */
    expect(soft).toMatch(/\.settings-page \.nx-page-title__title \{\s*\n\s*font-size: var\(--nx-fs-page\)/);
    expect(nav).toMatch(/\.setting-label \{\s*\n\s*font-size: var\(--nx-fs-row-title\)/);
    expect(nav).toMatch(/\.setting-desc \{\s*\n\s*font-size: var\(--nx-fs-row-desc\)/);
  });
});

describe('页标题下面不许再挂一句复述标题的副标', () => {
  const TABS = ['ProcessesTab'];
  it.each(TABS)('%s 的 PageTitle 没有 subtitle', (t) => {
    const src = read(`tabs/${t}.tsx`);
    const i = src.indexOf('<PageTitle');
    expect(i).toBeGreaterThan(-1);
    const head = src.slice(i, src.indexOf('/>', i) + 2);
    expect(head).not.toMatch(/subtitle=/);
  });
});

describe('空态: 三页一个长相', () => {
  const base = (f: string) => readFileSync(resolve(HERE, '../../../components/settings-base', f), 'utf8');

  it('EmptyState 是共用件, 不是各页各写一份', () => {
    expect(base('EmptyState.tsx')).toMatch(/nx-empty__title/);
    expect(base('index.ts')).toMatch(/export \{ EmptyState \}/);
  });

  it('技能页用共用空态', () => {
    const src = read('tabs/SkillsTab.tsx');
    expect(src).toMatch(/<EmptyState/);
    expect(src).toContain('还没有技能');
  });

  it('技能页不再有自己那份 skills-empty-hero', () => {
    expect(read('tabs/SkillsTab.tsx')).not.toMatch(/skills-empty-hero/);
  });

  it('MCP 页空的时候只给一个"添加第一个"入口', () => {
    const src = read('tabs/McpTab.tsx');
    expect(src).toMatch(/mcpServers\.length === 0 \? \(\s*<button type="button" className="mcp2-empty" onClick=\{openAdd\}>/);
  });

  it('记忆页空的时候: 出"还没记住"文案, 没有清空按钮', () => {
    const src = read('tabs/MemoryTab.tsx');
    expect(src).toMatch(/const pageEmpty = memories !== null && memories\.length === 0 && sessions\.length === 0/);
    expect(src).toContain('还没记住任何东西');
    expect(src).toMatch(/\{!isWork && !pageEmpty && \(/);                     /* 清空 */
  });

  it('记忆首页列表: 段控件切换, 默认前 5 条, 其余可展开', () => {
    const src = read('tabs/MemoryTab.tsx');
    expect(src).toMatch(/const PREVIEW_ROWS = 5/);
    expect(src).toMatch(/list\.slice\(0, PREVIEW_ROWS\)/);
    expect(src).toMatch(/展开其余 \$\{hiddenCount\} 条|展开其余 \{hiddenCount\} 条/);
    expect(src).toMatch(/key: 'remembered'/);
    expect(src).toMatch(/key: 'recent'/);
    expect(src).toMatch(/setTab\(s\.key\)/);
  });

  it('空态按钮一律 sm —— 跟工具栏同号', () => {
    for (const tab of ['SkillsTab']) {
      const src = read(`tabs/${tab}.tsx`);
      const block = src.slice(src.indexOf('<EmptyState'), src.indexOf('/>', src.indexOf('actions=')) + 400);
      for (const m of block.matchAll(/<NeoxButton([^>]*)>/g)) {
        expect(m[1], `${tab}: 空态按钮少了 size="sm"`).toMatch(/size="sm"/);
      }
    }
  });
});

describe('按钮高度按档钉死', () => {
  const btnCss = readFileSync(resolve(HERE, '../../../styles/settings-core/settings-base.css'), 'utf8');
  it('三档各有一个固定 height, 不靠 padding 推算', () => {
    expect(btnCss).toMatch(/--nx-control-h: 32px;/);
    expect(btnCss).toMatch(/--nx-control-h-sm: 28px;/);
    expect(btnCss).toMatch(/\.nx-btn \{[\s\S]*?height: var\(--nx-control-h\);[\s\S]*?line-height: 1;/);
    expect(btnCss).toMatch(/\.nx-btn--sm \{ height: var\(--nx-control-h-sm\);/);
    expect(btnCss).toMatch(/\.nx-btn--lg \{ height: var\(--nx-control-h-lg\);/);
    expect(btnCss).toMatch(/input\.nx-input \{\s*height: var\(--nx-control-h\);/);
  });
});

describe('下拉一律用我们自己的', () => {
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  const dir = resolve(HERE, '../tabs');
  const files = readdirSync(dir).filter(f => f.endsWith('.tsx'));

  it.each(files)('%s 里没有 <datalist> / 原生 <select>', (f) => {
    const src = readFileSync(resolve(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/<datalist/);
    expect(src).not.toMatch(/<select[\s>]/);
  });
});

describe('作用域文案统一 (2026-08-27 · 一致性轮)', () => {
  const FILES = ['tabs/SkillEditForm.tsx', 'tabs/McpEditForm.tsx', 'tabs/SkillsTab.tsx'];

  it.each(FILES)('%s 的作用域标签统一成「所有项目 / 仅当前项目」', (rel) => {
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).toMatch(/'所有项目' : 'All projects'/);
    expect(src).toMatch(/'仅当前项目' : 'This project only'/);
  });

  it.each(FILES)('%s 里不再有「工作区」「用户级」这两个内部词', (rel) => {
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/工作区/);
    expect(src).not.toMatch(/用户级/);
  });

  it('英文侧一起改了 —— 中文说「所有项目」而英文还说 User 就是另一种不一致', () => {
    for (const rel of FILES) {
      const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '');
      expect(src, rel).not.toMatch(/'User' : |label: zh \? '[^']*' : 'Workspace'/);
    }
  });
});
