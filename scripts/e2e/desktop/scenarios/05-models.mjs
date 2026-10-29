/* 模型切换: 打开模型菜单, 结构正确, 不报错 (不真发消息)。 */
import { openModelMenu, closeModelMenu, currentModelLabel, bodyText } from '../lib/ui.mjs';
import { assert, waitFor } from '../lib/assert.mjs';

export default {
  id: 'models',
  title: '模型切换',
  scenarios: [
    {
      id: 'model.current-label',
      title: '输入框模型按钮显示当前模型名',
      run: async ({ page }) => {
        const label = await currentModelLabel(page);
        assert(label.includes('当前模型'), `模型按钮 aria-label 异常: 「${label}」`);
      },
    },
    {
      id: 'model.menu-open',
      title: '打开模型菜单: 有切换模型 / 模型设置入口',
      run: async ({ page }) => {
        await openModelMenu(page);
        const text = await page.evaluate(() => document.querySelector('.atl-model__menu')?.innerText ?? '');
        /* 「推理强度」只对支持推理的模型出现 (BYOK 模型没有), 不能写死; 只钉恒有的入口 */
        assert(text.includes('切换模型'), `模型菜单缺少「切换模型」(实际: ${text.replace(/\n/g, '|').slice(0, 120)})`);
        assert(
          text.includes('模型设置') || text.includes('按量模型') || text.includes('订阅'),
          `模型菜单缺少模型分组/设置入口 (实际: ${text.replace(/\n/g, '|').slice(0, 120)})`,
        );
        await closeModelMenu(page);
      },
    },
    {
      id: 'model.menu-close-no-error',
      title: '开关模型菜单不报错',
      run: async ({ page }) => {
        await openModelMenu(page);
        await closeModelMenu(page);
        await waitFor(
          async () => (await page.evaluate(() => !!document.querySelector('.atl-model__menu'))) === false,
          { what: '模型菜单关闭' },
        );
        const text = await bodyText(page);
        assert(!text.includes('Cannot read propert'), '开关模型菜单出现报错');
      },
    },
  ],
};
