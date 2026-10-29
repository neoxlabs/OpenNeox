/* 设置页: 打开关闭 / 全部子分区能打开不报错 / 外观 / 关于。 */
import {
  openSettings,
  closeSettings,
  settingsVisible,
  settingsNavLabels,
  gotoSettingsSection,
  activeSettingsSection,
  settingsBodyText,
  bodyText,
} from '../lib/ui.mjs';
import { assert, waitFor } from '../lib/assert.mjs';

export default {
  id: 'settings',
  title: '设置页',
  scenarios: [
    {
      id: 'settings.open-close',
      title: '设置面板可以打开和关闭',
      run: async ({ page }) => {
        await openSettings(page);
        assert((await settingsVisible(page)) === true, '设置没有打开');
        const navs = await settingsNavLabels(page);
        assert(navs.length >= 10, `分区导航太少 (${navs.length})`);
        await closeSettings(page);
        assert((await settingsVisible(page)) === false, '设置没有关闭');
      },
    },
    {
      id: 'settings.all-sections',
      title: '逐个打开全部分区都不报错且有内容',
      timeoutMs: 120_000,
      run: async ({ page }) => {
        await openSettings(page);
        const navs = await settingsNavLabels(page);
        assert(navs.length >= 10, '分区不足');
        for (const nav of navs) {
          await gotoSettingsSection(page, nav);
          const active = await activeSettingsSection(page);
          assert(active === nav, `点「${nav}」后高亮是「${active}」`);
          const txt = await settingsBodyText(page);
          assert(txt.trim().length > 0, `分区「${nav}」内容为空`);
          for (const sign of ['Cannot read propert', 'is not a function', 'Uncaught']) {
            assert(!txt.includes(sign), `分区「${nav}」出现报错「${sign}」`);
          }
        }
        await closeSettings(page);
      },
    },
    {
      id: 'settings.appearance',
      title: '外观分区有主题卡 (浅陶 / 夜陶)',
      run: async ({ page }) => {
        await openSettings(page);
        await gotoSettingsSection(page, '外观');
        const text = await settingsBodyText(page);
        assert(text.includes('浅陶') && text.includes('夜陶'), '外观分区没有主题卡');
        await closeSettings(page);
      },
    },
    {
      id: 'settings.about-version',
      title: '关于分区显示版本号',
      run: async ({ page }) => {
        await openSettings(page);
        await gotoSettingsSection(page, '关于');
        const text = await settingsBodyText(page);
        assert(/v?\d+\.\d+\.\d+/.test(text), '关于页没有版本号');
        await closeSettings(page);
      },
    },
  ],
};
