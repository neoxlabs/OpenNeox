/* 启动与引导 —— 实例起来后主界面该有的东西都在, 且没有报错浮层。 */
import {
  SEL,
  bodyText,
  modeLabels,
  visibleCount,
  activeMode,
  openToolsPage,
  toolPageLabels,
  closeToolsPage,
} from '../lib/ui.mjs';
import { assert } from '../lib/assert.mjs';

export default {
  id: 'boot',
  title: '启动与引导',
  scenarios: [
    {
      id: 'boot.shell-ready',
      title: '启动后主界面就绪 (模式条 / 输入框 / 侧栏)',
      run: async ({ page }) => {
        assert((await visibleCount(page, SEL.modeBtn)) >= 2, '模式按钮不足两个');
        assert((await visibleCount(page, SEL.composer)) >= 1, '输入框不可见');
        assert((await visibleCount(page, SEL.newChat)) >= 1, '侧栏「新建任务」不可见');
        assert((await visibleCount(page, SEL.sidebar)) >= 1, '侧栏不可见');
      },
    },
    {
      id: 'boot.modes-present',
      title: 'Work / Code / Pilot 三个模式都在',
      run: async ({ page }) => {
        const labels = await modeLabels(page);
        for (const m of ['Work', 'Code']) assert(labels.includes(m), `缺少 ${m} 模式 (实际: ${labels.join(',')})`);
        /* Pilot 只对开通能力的账号出现, 只钉住恒有的两个 */
      },
    },
    {
      id: 'boot.default-mode',
      title: '启动后有且只有一个模式处于高亮',
      run: async ({ page }) => {
        const on = await visibleCount(page, SEL.modeOn);
        assert(on === 1, `高亮模式数量应为 1, 实际 ${on}`);
        assert((await activeMode(page)).length > 0, '当前模式文案为空');
      },
    },
    {
      id: 'boot.sidebar-tools',
      title: '侧栏「工具」→ 工具主页, 六张工具卡都在',
      run: async ({ page }) => {
        await openToolsPage(page);
        const labels = await toolPageLabels(page);
        for (const t of ['技能', 'MCP', '知识库', '图片', '插件', '团队']) {
          assert(labels.includes(t), `工具主页缺少「${t}」(实际: ${labels.join(',')})`);
        }
        await closeToolsPage(page);
      },
    },
    {
      id: 'boot.no-error-overlay',
      title: '启动后界面没有错误浮层 / 报错文案',
      run: async ({ page }) => {
        const text = await bodyText(page);
        for (const sign of ['Cannot read propert', 'is not a function', 'Uncaught', 'Unhandled']) {
          assert(!text.includes(sign), `界面出现报错「${sign}」`);
        }
        const toast = await page.locator('.error-boundary').count();
        assert(toast === 0, '出现 error-boundary');
      },
    },
  ],
};
