/* 模式切换 —— Work / Code / Pilot, 切完输入框还在、无报错。 */
import { activeMode, switchMode, visibleCount, SEL, bodyText } from '../lib/ui.mjs';
import { assert, waitFor } from '../lib/assert.mjs';

export default {
  id: 'modes',
  title: '模式切换',
  scenarios: [
    {
      id: 'modes.to-work',
      title: '切到 Work 模式',
      run: async ({ page }) => {
        await switchMode(page, 'Work');
        await waitFor(async () => (await activeMode(page)) === 'Work', { what: 'Work 成为当前模式' });
        assert((await visibleCount(page, SEL.composer)) >= 1, '切 Work 后输入框消失');
      },
    },
    {
      id: 'modes.to-code',
      title: '切到 Code 模式',
      run: async ({ page }) => {
        await switchMode(page, 'Code');
        await waitFor(async () => (await activeMode(page)) === 'Code', { what: 'Code 成为当前模式' });
        assert((await visibleCount(page, SEL.composer)) >= 1, '切 Code 后输入框消失');
      },
    },
    {
      id: 'modes.to-pilot',
      title: '切到 Pilot 模式 (未开通则该账号不显示)',
      run: async ({ page }) => {
        const labels = await page.evaluate(() =>
          [...document.querySelectorAll('.neox-mode-seg__btn')].map((e) => e.textContent.trim()),
        );
        if (!labels.includes('Pilot')) return; /* 未开通能力的账号没有 Pilot */
        await switchMode(page, 'Pilot');
        await waitFor(async () => (await activeMode(page)) === 'Pilot', { what: 'Pilot 成为当前模式' });
      },
    },
    {
      id: 'modes.roundtrip',
      title: 'Work → Code → Work 来回切后状态正常',
      run: async ({ page }) => {
        await switchMode(page, 'Work');
        await switchMode(page, 'Code');
        await switchMode(page, 'Work');
        assert((await activeMode(page)) === 'Work', '来回切后没有回到 Work');
        assert((await visibleCount(page, SEL.composer)) >= 1, '来回切后输入框消失');
        const text = await bodyText(page);
        assert(!text.includes('Cannot read propert'), '切换过程中出现报错');
      },
    },
    {
      id: 'modes.notice-dismiss',
      title: '首次切模式的说明卡可以关掉',
      run: async ({ page }) => {
        /* switchMode 内部会 dismissModeNotice; 这里断言切完后没有残留说明卡挡着 */
        await switchMode(page, 'Code');
        await switchMode(page, 'Work');
        assert((await visibleCount(page, SEL.modeNotice)) === 0, '模式说明卡没有被关掉');
      },
    },
  ],
};
