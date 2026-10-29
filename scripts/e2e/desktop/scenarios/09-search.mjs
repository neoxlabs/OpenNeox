/* 搜索: 打开输入关闭 / 空态 / 命中会话。 */
import {
  SEL,
  openSearch,
  closeSearch,
  newSession,
  visibleCount,
  activeSessionTitle,
  bodyText,
} from '../lib/ui.mjs';
import { assert, waitFor } from '../lib/assert.mjs';

export default {
  id: 'search',
  title: '搜索',
  scenarios: [
    {
      id: 'search.open-close',
      title: '搜索面板打开 / 输入 / Esc 关闭',
      run: async ({ page }) => {
        await openSearch(page);
        assert((await visibleCount(page, SEL.searchInput)) >= 1, '搜索输入框不可见');
        await closeSearch(page);
        await waitFor(async () => (await visibleCount(page, SEL.searchInput)) === 0, { what: '搜索关闭' });
      },
    },
    {
      id: 'search.empty-state',
      title: '搜不存在的关键词显示空态',
      run: async ({ page }) => {
        await openSearch(page);
        await page.locator(SEL.searchInput).first().fill('zzz-绝对不存在的会话-zzz');
        await waitFor(async () => (await visibleCount(page, SEL.searchEmpty)) >= 1, {
          what: '空态出现',
        });
        await closeSearch(page);
      },
    },
    {
      id: 'search.match-session',
      title: '能搜到刚建的会话',
      run: async ({ page }) => {
        await newSession(page);
        const title = await activeSessionTitle(page);
        assert(title.length > 0, '新建会话没有标题');
        await openSearch(page);
        await page.locator(SEL.searchInput).first().fill(title);
        await page.waitForTimeout(800);
        const text = await bodyText(page);
        assert(text.includes(title), `搜索结果里没有「${title}」`);
        await closeSearch(page);
      },
    },
  ],
};
