import type { Scenario } from '../../../types.js';

export const surface: Scenario[] = [
  {
    id: 'desktop.surface.no-flash',
    module: 'desktop.surface',
    surface: 'desktop',
    tier: 'core',
    priority: 'P0',
    title: 'BrowserView 与覆盖层 suppress 无闪白',
    why: '覆盖层体验',
    mode: 'manual',
    codeHint: 'useSuppressBrowserView',
    steps: [
      { action: '打开 browser surface 再开设置/弹层', expect: '无整屏闪白' },
    ],
  },
  {
    id: 'desktop.surface.html-open',
    module: 'desktop.surface',
    surface: 'desktop',
    tier: 'core',
    priority: 'P1',
    title: 'HTML surface 打开不白屏',
    why: '预览主路径',
    mode: 'manual',
    steps: [
      { action: '打开 workspace 内 html', expect: '内容渲染，控制台无致命错' },
    ],
  },
  {
    id: 'desktop.surface.code-open',
    module: 'desktop.surface',
    surface: 'desktop',
    tier: 'core',
    priority: 'P1',
    title: 'Code surface 打开可滚动高亮',
    why: 'IDE 侧栏',
    mode: 'manual',
    codeHint: 'CodeSurfaceViewer',
    steps: [
      { action: '打开较大源码文件', expect: '高亮正常，滚动流畅' },
    ],
  },
  {
    id: 'desktop.surface.image-open',
    module: 'desktop.surface',
    surface: 'desktop',
    tier: 'core',
    priority: 'P2',
    title: '图片 surface 可预览',
    why: 'ImageSurfaceViewer',
    mode: 'manual',
    steps: [
      { action: '打开 png/jpg', expect: '图片显示，可缩放或适应' },
    ],
  },
];

export const plugins: Scenario[] = [
  {
    id: 'desktop.plugins.marketplace-install',
    module: 'desktop.plugins',
    surface: 'desktop',
    tier: 'nightly',
    priority: 'P1',
    title: 'Marketplace 安装插件',
    why: '插件面主路径',
    mode: 'manual',
    codeHint: 'usePluginManager',
    steps: [
      { action: '安装示例/本地插件', expect: '已安装列表出现' },
      { action: '启用', expect: '状态 on，无报错 toast' },
    ],
  },
  {
    id: 'desktop.plugins.disable-uninstall',
    module: 'desktop.plugins',
    surface: 'desktop',
    tier: 'nightly',
    priority: 'P1',
    title: '禁用与卸载干净',
    why: '残留报错',
    mode: 'manual',
    steps: [
      { action: '禁用再卸载', expect: '列表移除，重启后仍无幽灵' },
    ],
  },
];

export const diff: Scenario[] = [
  {
    id: 'desktop.diff.review',
    module: 'desktop.diff',
    surface: 'desktop',
    tier: 'core',
    priority: 'P1',
    title: 'EditDiff 展示并可 Review',
    why: '改码验收',
    mode: 'manual',
    codeHint: 'EditDiffCard',
    steps: [
      { action: '让 agent 改文件产生 diff', expect: '卡片显示增删行' },
      { action: 'Review/打开文件', expect: '与磁盘内容一致' },
    ],
  },
  {
    id: 'desktop.diff.revert',
    module: 'desktop.diff',
    surface: 'desktop',
    tier: 'core',
    priority: 'P1',
    title: 'Revert 恢复文件',
    why: '误改回滚',
    mode: 'manual',
    steps: [
      { action: 'Revert 一次 edit', expect: '文件回到改前，UI 标记取消/已还原' },
    ],
  },
];

export const composer: Scenario[] = [
  {
    id: 'desktop.composer.send-empty',
    module: 'desktop.composer',
    surface: 'desktop',
    tier: 'smoke',
    priority: 'P1',
    title: '空输入不能发送',
    why: '误触',
    mode: 'manual',
    steps: [
      { action: 'composer 空时点发送/Enter', expect: '不发空 turn' },
    ],
  },
  {
    id: 'desktop.composer.stop-button',
    module: 'desktop.composer',
    surface: 'desktop',
    tier: 'core',
    priority: 'P0',
    title: '运行中 Stop 按钮可用且生效',
    why: '与 CLI Esc 对等',
    mode: 'manual',
    steps: [
      { action: '长任务点 Stop', expect: '流停，可再发' },
    ],
  },
  {
    id: 'desktop.composer.mode-switch',
    module: 'desktop.composer',
    surface: 'desktop',
    tier: 'core',
    priority: 'P1',
    title: 'Agent mode（ask/code 等）切换生效',
    why: '模式残留',
    mode: 'manual',
    steps: [
      { action: '切到限制写文件的模式再要求改文件', expect: '行为符合模式（拒写或要批）' },
    ],
  },
  {
    id: 'desktop.composer.attach-image',
    module: 'desktop.composer',
    surface: 'desktop',
    tier: 'nightly',
    priority: 'P2',
    title: '附图发送（若支持）',
    why: '多模态入口',
    mode: 'manual',
    steps: [
      { action: '粘贴/选择图片发送', expect: '气泡含图，模型有响应或明确不支持' },
    ],
  },
];

export const settings: Scenario[] = [
  {
    id: 'desktop.settings.open-tabs',
    module: 'desktop.settings',
    surface: 'desktop',
    tier: 'smoke',
    priority: 'P1',
    title: '设置各 Tab 可打开不白屏',
    why: '设置壳',
    mode: 'manual',
    steps: [
      { action: '打开 Providers / 通用 / 插件等 Tab', expect: '每页有内容，无空白崩溃' },
    ],
  },
  {
    id: 'desktop.settings.language',
    module: 'desktop.settings',
    surface: 'desktop',
    tier: 'core',
    priority: 'P2',
    title: '语言切换后关键文案更新',
    why: 'i18n 残留英文块',
    mode: 'manual',
    steps: [
      { action: '切 zh/en', expect: '侧栏/设置/常见按钮语言一致' },
    ],
  },
];
