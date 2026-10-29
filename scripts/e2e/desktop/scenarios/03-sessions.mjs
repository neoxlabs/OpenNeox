/* 会话: 新建 / 切换 / 删除 / 刷新后还在。 */
import {
  newSession,
  activeSessionId,
  deleteActiveSession,
  resetToShell,
  sendMessage,
  waitForUserText,
} from '../lib/ui.mjs';
import { assert, waitFor } from '../lib/assert.mjs';

export default {
  id: 'sessions',
  title: '会话管理',
  scenarios: [
    {
      id: 'session.new',
      title: '新建任务: 生成新会话并自动选中',
      run: async ({ page }) => {
        const beforeId = await activeSessionId(page);
        const id = await newSession(page);
        assert(id && id !== beforeId, '新建后激活会话 id 没有变化');
        assert((await page.locator('.atl-composer__input').count()) >= 1, '新建后输入框不可见');
      },
    },
    {
      id: 'session.delete',
      title: '删除会话: 右键菜单 → 删除 → 确认 → 行消失',
      run: async ({ page }) => {
        await newSession(page);
        const id = await activeSessionId(page);
        assert(id, '新建后没有会话 id');
        await deleteActiveSession(page);
        await waitFor(
          async () =>
            await page.evaluate(
              (sid) =>
                !document.querySelector(
                  `.neox-wb-row[data-session-id="${sid}"], .neox-session-item[data-session-id="${sid}"]`,
                ),
              id,
            ),
          { what: '被删会话从侧栏消失' },
        );
      },
    },
    {
      id: 'session.persist-reload',
      title: '新建会话后刷新, 会话还在',
      run: async ({ page }) => {
        const id = await newSession(page);
        assert(id, '新建后没有会话 id');
        await resetToShell(page);
        const stillThere = await page.evaluate(
          (sid) =>
            !!document.querySelector(
              `.neox-wb-row[data-session-id="${sid}"], .neox-session-item[data-session-id="${sid}"]`,
            ),
          id,
        );
        assert(stillThere, '刷新后会话不见了');
      },
    },
    {
      /* 草稿空会话全局只有一个 (新建会替换当前空会话), 要两个能并存的会话必须有真实内容 —— 所以这个场景需要模型 */
      id: 'session.switch-and-persist',
      title: '两个有内容的会话可来回切换, 刷新后都还在',
      model: true,
      timeoutMs: 240_000,
      run: async ({ page }) => {
        await newSession(page);
        const a = await activeSessionId(page);
        await sendMessage(page, '只回复两个字：甲');
        await waitForUserText(page, '只回复两个字：甲');
        /* 等这条落库 (助手开始/结束) */
        await waitFor(async () => (await page.locator('.atl-msg.is-assistant').count()) >= 1, {
          what: 'A 有助手回复',
          timeout: 150_000,
          interval: 500,
        });

        await newSession(page);
        const b = await activeSessionId(page);
        assert(a && b && a !== b, '两次新建应是不同会话');
        await sendMessage(page, '只回复两个字：乙');
        await waitForUserText(page, '只回复两个字：乙');

        /* 切回 A, 应看到 A 的那条消息 */
        await page.evaluate((sid) => {
          const el = document.querySelector(
            `.neox-wb-row[data-session-id="${sid}"], .neox-session-item[data-session-id="${sid}"]`,
          );
          if (el) el.click();
        }, a);
        await waitFor(async () => (await activeSessionId(page)) === a, { what: '切回会话 A' });
        await waitForUserText(page, '只回复两个字：甲');

        /* 刷新后两个会话都还在 */
        await resetToShell(page);
        const ids = await page.evaluate(() =>
          [...document.querySelectorAll('.neox-wb-row, .neox-session-item')].map((e) =>
            e.getAttribute('data-session-id'),
          ),
        );
        assert(ids.includes(a) && ids.includes(b), '刷新后有内容的会话不全 (期望 A、B 都在)');
      },
    },
  ],
};
