import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(resolve(HERE, '../pages/onboarding/OnboardingPage.tsx'), 'utf8');
const cssIndex = readFileSync(resolve(HERE, '../styles/editor-core/onboarding.css'), 'utf8');
const polish = readFileSync(resolve(HERE, '../styles/editor-core/onboarding/step-polish.css'), 'utf8');

describe('引导页步骤', () => {
  it('步骤序列只按模式分, 不靠偷偷扫一遍决定 migrate 露不露脸', () => {
    const m = page.match(/const seq: OnboardingStep\[\] = selectedAgentMode === 'work'\s*\?\s*\[([^\]]+)\]\s*:\s*\[([^\]]+)\];/);
    expect(m, '没找到 steps 定义').toBeTruthy();
    const parse = (x: string) => x.split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean);
    expect(parse(m![1])).toEqual(['theme', 'mode', 'connect', 'mobile']);
    expect(parse(m![2])).toEqual(['theme', 'mode', 'migrate', 'connect', 'mobile']);
  });

  it('最后一步的「继续」就是完成, 按钮写「开始使用」', () => {
    expect(page).toMatch(/if \(nextIndex < steps\.length\) \{[\s\S]{0,80}\} else \{\s*handleCompleteRef\.current\?\.\(\);/);
    expect(page).toMatch(/isLast=\{isLastStep\}/);
  });

  it('手机端那一屏只在有账号体系的发行版出现 (推的是我们的 APK)', () => {
    expect(page).toMatch(/getEditionHook\('hasAccount'\) \? seq : seq\.filter\(\(s\) => s !== 'mobile'\)/);
  });

  it('进引导时已能用 (已登录 / 已配 BYOK) 就不出接模型那一步; 人正在那一步时不许把它抽掉', () => {
    expect(page).toMatch(/const \[readyAtStart, setReadyAtStart\] = useState\(false\)/);
    expect(page).toMatch(/readyAtStart && currentStep !== 'connect' \? withMobile\.filter\(\(s\) => s !== 'connect'\) : withMobile/);
  });

  it('**不许主动扫** —— 扫描只能由用户点按钮触发', () => {
    /* 挂载即扫的形状: useEffect 里调 migrateScan。回来一次就是又替用户做了决定。 */
    expect(page).not.toMatch(/useEffect\([\s\S]{0,400}?api\?\.migrateScan\(\)/);
    /* 必须有一个显式的触发函数, 且挂在按钮的 onClick 上 */
    expect(page).toMatch(/const runMigrateScan = useCallback/);
    expect(page).toMatch(/onClick=\{\(\) => \{ void runMigrateScan\(\); \}\}/);
    /* 未扫 / 扫描中 / 已扫要分得开 —— 空态和"还没点过"不是一回事 */
    expect(page).toMatch(/migrateScanned/);
  });

  it('未扫时不许整屏空白 —— 不能用 `if (!scan) return null` 早返', () => {
    const fn = page.slice(page.indexOf('const renderMigrateStep'), page.indexOf('const renderConnectScan'));
    expect(fn).not.toMatch(/if \(!scan\) return null;/);
    /* 四个态都要在: 未扫 / 扫描中 / 空 / 有结果 */
    expect(fn).toMatch(/!migrateScanned && !migrateBusy/);
    expect(fn).toMatch(/migrateBusy && !migrateScanned/);
  });

  it('结果分三列 (技能 / MCP / 会话), 不是竖着堆三段', () => {
    expect(page).toMatch(/migrate-cols/);
    /* 三列各自的图标 —— 用户点名要 logo */
    for (const icon of ['IconSkill', 'IconMcp', 'IconSession']) {
      expect(page, `缺 ${icon}`).toMatch(new RegExp(icon));
    }
  });

  it('「从本机导入」在 BYOK 里面, 不是并列的第三种接入方式', () => {
    expect(page).toMatch(/byok-import-entry/);
    /* 它曾经是 connect-mode-grid 里的第三张卡 —— 那一版被用户否了 */
    expect(page).not.toMatch(/connect-mode-card--scan/);
  });

  it('不再有"纯宣传"的功能介绍步, 也不再为选语言单开一屏', () => {
    expect(page).not.toMatch(/renderFeaturesStep|renderLanguageStep/);
    /* 语言选择本身必须还在 (并到了外观步), 否则等于把功能删了 */
    expect(page).toMatch(/lang-switch__btn/);
    expect(page).toMatch(/handleLanguageSelect/);
  });

  it('顶部导航只有「上一步」—— 前进箭头是跟主 CTA 重复的旁路', () => {
    const open = /<div className="onboarding-nav"[^>]*>/.exec(page);
    expect(open, '找不到 .onboarding-nav 这个容器').toBeTruthy();
    const from = open!.index;
    const nav = page.slice(from, page.indexOf('</div>', from) + 6);
    expect(nav).toMatch(/goPrev/);
    expect(nav).not.toMatch(/goNext/);
  });
});

describe('接入模型步', () => {
  it('探测失败要说清楚原因 (复用设置页同一套 httpStatusHint), 不是一句"连接失败"', () => {
    expect(page).toMatch(/import \{ httpStatusHint \}/);
    expect(page).toMatch(/probeFailureMessage/);
  });

  it('保存前拉全量模型目录, 且选中的模型排第一 / 显式当默认', () => {
    expect(page).toMatch(/fetchProviderModels/);
    expect(page).toMatch(/defaultModel: model/);
  });

  it('三件事都在这一屏: 官方 logo / 测试连接 / 获取模型列表', () => {
    /* 官方 mark 走设置页同一个组件 (assets/provider-logos), 不是自绘图标 */
    expect(page).toMatch(/ProviderBrandLogo/);
    expect(page).toMatch(/connect-test-btn/);
    expect(page).toMatch(/handleFetchModels/);
  });

  it('输入框是无边框内嵌式 —— 卡片本身才是容器, 不再框中框', () => {
    expect(page).toMatch(/connect-field__input/);
    expect(polish).toMatch(/connect-field__input[\s\S]*?border: 0 !important/);
  });
});

describe('样式层', () => {
  it('step-polish.css 必须最后 import —— 它要压住前面几代同选择器的 !important', () => {
    const imports = [...cssIndex.matchAll(/@import '([^']+)'/g)].map(m => m[1]);
    expect(imports[imports.length - 1]).toBe('./onboarding/step-polish.css');
  });

  it('主题轨道保持"一屏 4 张 + 可见翻页", 不许再把滚动条藏成不可达', () => {
    expect(page).toMatch(/theme-rail-arrow/);
    expect(polish).toMatch(/theme-preset-option[\s\S]*?calc\(\(100% - 36px\) \/ 4\)/);
  });
});

describe('migrate 屏的样式钩子必须存在', () => {
  const css = [
    readFileSync(resolve(HERE, '../styles/editor-core/onboarding/migrate-step.css'), 'utf8'),
    readFileSync(resolve(HERE, '../styles/editor-core/onboarding/base.css'), 'utf8'),
    readFileSync(resolve(HERE, '../styles/editor-core/onboarding/step-polish.css'), 'utf8'),
  ].join('\n');

  it('主按钮沿用其它屏的 continue-btn, 不自造没有样式的类', () => {
    expect(page).toMatch(/className="continue-btn"[\s\S]{0,200}migratePicked/);
    expect(page).not.toMatch(/className="onboarding-cta"[\s\S]{0,120}migrateBusy/);
  });

  it('migrate 屏自己的类都有 CSS 定义 —— 写了类名却没样式等于没写', () => {
    for (const cls of ['migrate-actions', 'migrate-skip', 'migrate-row', 'migrate-list', 'migrate-groups']) {
      expect(css, `.${cls} 没有任何 CSS 定义`).toMatch(new RegExp(`\\.${cls}\\b`));
    }
  });

  /* 第二版翻车: 「稍后再说」被 flex 压成「稍后 / 再说」两行 */
  it('次要按钮不许换行 —— flex 子项默认会收缩到内容宽度以下', () => {
    const block = css.slice(css.indexOf('.migrate-skip'), css.indexOf('.migrate-skip') + 400);
    expect(block).toMatch(/white-space:\s*nowrap/);
    expect(block).toMatch(/flex:\s*none/);
  });

  it('两颗按钮的容器要有间距, 否则会挤成一团', () => {
    const block = css.slice(css.indexOf('.migrate-actions'), css.indexOf('.migrate-actions') + 220);
    expect(block).toMatch(/display:\s*flex/);
    expect(block).toMatch(/gap:\s*\d+px/);
  });
});

describe('引导里的跳过按钮', () => {
  it('不许再说「进入应用」—— 它进不去', () => {
    expect(page).not.toMatch(/'先进入应用'/);
    expect(page).not.toMatch(/'Enter app anyway'/);
  });
});

describe('接模型「稍后再说」不连问', () => {
  it('两个「稍后再说」都走 skipConnect, 不直接 goNext', () => {
    const connect = page.slice(page.indexOf('const renderConnectChoose'), page.indexOf('/* ── BYOK 子屏 1/2'));
    expect(connect).not.toMatch(/className="connect-skip" onClick=\{goNext\}/);
    /* 至少两颗 (选择屏 + 品牌列表); 结束标记是注释, 公开树会删开发注释, 截到的范围可能更大 —— 不按等号数 */
    expect((connect.match(/onClick=\{skipConnect\}/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it('没就绪直接结束引导, 就绪才往下走', () => {
    expect(page).toMatch(/if \(ready\) goNext\(\); else handleComplete\(\);/);
  });
});
