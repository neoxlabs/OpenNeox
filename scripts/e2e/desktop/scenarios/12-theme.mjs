/* 深色 / 浅色切换: 顶栏主题按钮 + 设置→外观主题卡 + 刷新保持。 */
import {
  SEL,
  themeAttr,
  clickVisible,
  openSettings,
  closeSettings,
  gotoSettingsSection,
  settingsBodyText,
  activeThemeCard,
  clickThemeCard,
  resetToShell,
} from '../lib/ui.mjs';
import { assert, waitFor } from '../lib/assert.mjs';

export default {
  id: 'theme',
  title: '深色浅色',
  scenarios: [
    {
      /* 顶栏没有主题入口 (图标轨 .neox-rail 当前布局 display:none, 顶栏那颗也没有挂上去),
       * 真实的切换路径就是设置→外观去点卡片。这里验的是卡片选中态 + 「当前」角标 + 刷新保持。 */
      id: 'theme.card-selected-state',
      title: '设置→外观: 点另一张主题卡后选中态 + 「当前」角标, 刷新仍保持',
      timeoutMs: 90_000,
      run: async ({ page }) => {
        await openSettings(page);
        await gotoSettingsSection(page, '外观');
        const before = await activeThemeCard(page);
        assert(before, '外观分区没有标出当前主题卡');

        /* 找一张名字不同的卡点下去 */
        const target = await page.evaluate((cur) => {
          const roots = [...document.querySelectorAll('.settings-overlay, .neox-embedded-settings')];
          const vis = roots.find((el) => el.offsetWidth > 0 && el.offsetHeight > 0);
          if (!vis) return '';
          const card = [...vis.querySelectorAll('.theme-pack-card')].find((e) => {
            const name = (e.querySelector('.theme-pack-card__name')?.innerText || '').trim();
            return name && name !== cur;
          });
          const name = (card?.querySelector('.theme-pack-card__name')?.innerText || '').trim();
          if (!card) return '';
          card.click();
          return name;
        }, before);
        assert(target && target !== before, `找不到可切换的主题卡 (当前: ${before})`);
        await waitFor(async () => (await activeThemeCard(page)) === target, {
          what: `「${target}」变成当前主题`,
        });
        assert(['light', 'dark'].includes(await themeAttr(page)), `切主题后 data-theme 异常: ${await themeAttr(page)}`);
        const badge = await page.evaluate(() => {
          const roots = [...document.querySelectorAll('.settings-overlay, .neox-embedded-settings')];
          const vis = roots.find((el) => el.offsetWidth > 0 && el.offsetHeight > 0);
          return (vis?.querySelector('.theme-pack-card.is-active .theme-pack-card__badge')?.innerText || '').trim();
        });
        assert(badge.includes('当前'), `选中的主题卡没有「当前」角标 (实际: 「${badge}」)`);
        await closeSettings(page);

        /* 刷新后仍然是这张 */
        await resetToShell(page);
        await openSettings(page);
        await gotoSettingsSection(page, '外观');
        assert((await activeThemeCard(page)) === target, '刷新后主题卡选择没有保持');

        /* 切回原主题, 不给后面的场景留状态 */
        assert(await clickThemeCard(page, before), `切不回原主题「${before}」`);
        await waitFor(async () => (await activeThemeCard(page)) === before, { what: '主题已切回' });
        await closeSettings(page);
      },
    },
    {
      id: 'theme.settings-dark',
      title: '设置→外观→夜陶 → data-theme=dark',
      run: async ({ page }) => {
        await openSettings(page);
        await gotoSettingsSection(page, '外观');
        const text = await settingsBodyText(page);
        assert(text.includes('夜陶'), '外观分区没有夜陶主题卡');
        const ok = await page.evaluate(() => {
          const roots = [...document.querySelectorAll('.settings-overlay, .neox-embedded-settings')];
          const vis = roots.find((el) => el.offsetWidth > 0 && el.offsetHeight > 0);
          if (!vis) return false;
          const card = [...vis.querySelectorAll('.theme-pack-card')].find((e) => e.innerText.includes('夜陶'));
          if (!card) return false;
          card.click();
          return true;
        });
        assert(ok, '点不到夜陶主题卡');
        await waitFor(async () => (await themeAttr(page)) === 'dark', { what: '切到深色' });
        await closeSettings(page);
      },
    },
    {
      id: 'theme.settings-light',
      title: '设置→外观→浅陶 → data-theme=light',
      run: async ({ page }) => {
        await openSettings(page);
        await gotoSettingsSection(page, '外观');
        const ok = await page.evaluate(() => {
          const roots = [...document.querySelectorAll('.settings-overlay, .neox-embedded-settings')];
          const vis = roots.find((el) => el.offsetWidth > 0 && el.offsetHeight > 0);
          if (!vis) return false;
          const card = [...vis.querySelectorAll('.theme-pack-card')].find((e) => e.innerText.includes('浅陶'));
          if (!card) return false;
          card.click();
          return true;
        });
        assert(ok, '点不到浅陶主题卡');
        await waitFor(async () => (await themeAttr(page)) === 'light', { what: '切到浅色' });
        await closeSettings(page);
      },
    },
    {
      id: 'theme.persist-reload',
      title: '切换主题后刷新仍然保持',
      run: async ({ page }) => {
        await openSettings(page);
        await gotoSettingsSection(page, '外观');
        const target = (await themeAttr(page)) === 'dark' ? '浅陶' : '夜陶';
        const expected = target === '夜陶' ? 'dark' : 'light';
        await page.evaluate((label) => {
          const roots = [...document.querySelectorAll('.settings-overlay, .neox-embedded-settings')];
          const vis = roots.find((el) => el.offsetWidth > 0 && el.offsetHeight > 0);
          const card = [...vis.querySelectorAll('.theme-pack-card')].find((e) => e.innerText.includes(label));
          if (card) card.click();
        }, target);
        await waitFor(async () => (await themeAttr(page)) === expected, { what: `切到 ${expected}` });
        await closeSettings(page);
        await resetToShell(page);
        assert((await themeAttr(page)) === expected, '刷新后主题没有保持');
      },
    },
  ],
};
