/* 通知: 打开 / 结构 / 关闭。 */
import { SEL, openNotifications, closeNotifications, visibleCount } from '../lib/ui.mjs';
import { assert, waitFor } from '../lib/assert.mjs';

export default {
  id: 'notifications',
  title: '通知',
  scenarios: [
    {
      id: 'notif.open-close',
      title: '通知面板打开 / Esc 关闭',
      run: async ({ page }) => {
        await openNotifications(page);
        assert((await visibleCount(page, SEL.notifPopover)) >= 1, '通知面板没有出现');
        await closeNotifications(page);
        await waitFor(async () => (await visibleCount(page, SEL.notifPopover)) === 0, {
          what: '通知面板关闭',
        });
      },
    },
    {
      id: 'notif.header',
      title: '通知面板有标题和「全部已读」',
      run: async ({ page }) => {
        await openNotifications(page);
        const text = await page.evaluate(
          () => document.querySelector('.neox-notif-popover')?.innerText ?? '',
        );
        assert(text.includes('通知'), '通知面板没有标题');
        assert(text.includes('全部已读'), '通知面板没有「全部已读」');
        await closeNotifications(page);
      },
    },
  ],
};
