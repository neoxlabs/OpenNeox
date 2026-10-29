/* Surface: 打开 / 新建文件面板 / 关标签 / 布局按钮。 */
import {
  SEL,
  visibleCount,
  surfaceOpen,
  toggleSurface,
  ensureSurfaceOpen,
  ensureSurfaceClosed,
  newSurfaceTab,
  clickVisible,
  bodyText,
} from '../lib/ui.mjs';
import { assert, waitFor } from '../lib/assert.mjs';

export default {
  id: 'surface',
  title: 'Surface',
  scenarios: [
    {
      id: 'surface.toggle-open',
      title: '点 Surface 开关 → 面板出现, 再点关闭',
      run: async ({ page }) => {
        /* 面板开合会跨场景保留, 先归到「关」再测开合 */
        await ensureSurfaceClosed(page);
        await toggleSurface(page);
        assert(await surfaceOpen(page), 'Surface 面板没有出现');
        await toggleSurface(page);
        await waitFor(async () => !(await surfaceOpen(page)), { what: 'Surface 面板关闭' });
      },
    },
    {
      id: 'surface.open-files',
      title: '从 Surface 菜单新建「文件」面板 → 出现标签',
      timeoutMs: 60_000,
      run: async ({ page }) => {
        await ensureSurfaceOpen(page);
        const before = await visibleCount(page, SEL.surfaceTab);
        await newSurfaceTab(page, '文件');
        await waitFor(async () => (await visibleCount(page, SEL.surfaceTab)) > before, {
          what: '新建的 Surface 标签出现',
          timeout: 15_000,
        });
      },
    },
    {
      id: 'surface.close-tab',
      title: '关闭 Surface 标签 → 标签消失',
      timeoutMs: 60_000,
      run: async ({ page }) => {
        await ensureSurfaceOpen(page);
        if ((await visibleCount(page, SEL.surfaceTab)) === 0) await newSurfaceTab(page, '文件');
        await waitFor(async () => (await visibleCount(page, SEL.surfaceTab)) > 0, {
          what: 'Surface 标签出现',
          timeout: 15_000,
        });
        const before = await visibleCount(page, SEL.surfaceTab);
        await clickVisible(page, SEL.surfaceTabClose);
        await waitFor(async () => (await visibleCount(page, SEL.surfaceTab)) < before, {
          what: '关闭后标签减少',
          timeout: 15_000,
        });
      },
    },
    {
      id: 'surface.layout-buttons',
      title: 'Surface 布局按钮 (停靠 / 悬浮 / 展开) 可点',
      run: async ({ page }) => {
        await ensureSurfaceOpen(page);
        const labels = await page.evaluate(() =>
          [...document.querySelectorAll('.sfc-chrome__layout-btn')].map((e) => (e.innerText || e.getAttribute('title') || '').trim()),
        );
        assert(labels.length >= 2, `Surface 布局按钮不足 (${labels.join(',')})`);
        await clickVisible(page, '.sfc-chrome__layout-btn');
        const text = await bodyText(page);
        assert(!text.includes('Cannot read propert'), '点布局按钮出现报错');
      },
    },
  ],
};
