/*
 * 发送 / 停止 / 运行中再发 (排队) —— 会真调模型 (订阅), 只在 --with-model 时跑。
 * 用最便宜的一句话任务; 总数控制在 3 个。
 */
import {
  newSession,
  sendMessage,
  userMessageCount,
  lastAssistantText,
  isRunning,
  clickStop,
  bodyText,
} from '../lib/ui.mjs';
import { assert, waitFor } from '../lib/assert.mjs';

export default {
  id: 'send',
  title: '发送 / 停止 / 排队',
  scenarios: [
    {
      id: 'send.basic',
      title: '发一句话 → 用户消息入流 → 助手有回复',
      model: true,
      timeoutMs: 180_000,
      run: async ({ page }) => {
        await newSession(page);
        await sendMessage(page, '只回复两个字：收到');
        await waitFor(async () => (await userMessageCount(page)) >= 1, { what: '用户消息入流', timeout: 20_000 });
        await waitFor(async () => (await lastAssistantText(page)).length > 0, {
          what: '助手开始回复',
          timeout: 150_000,
          interval: 500,
        });
        assert((await lastAssistantText(page)).length > 0, '助手没有回复');
      },
    },
    {
      id: 'send.stop',
      title: '发一个长任务 → 点停止 → 运行停下来',
      model: true,
      timeoutMs: 180_000,
      run: async ({ page }) => {
        await newSession(page);
        await sendMessage(page, '写一篇八百字的文章，主题是秋天');
        /* 等它真的跑起来 (停止按钮出现) */
        await waitFor(async () => await isRunning(page), { what: '进入生成中', timeout: 60_000, interval: 300 });
        await clickStop(page);
        await waitFor(async () => !(await isRunning(page)), {
          what: '停止后不再显示停止按钮',
          timeout: 30_000,
          interval: 300,
        });
        const text = await bodyText(page);
        assert(!text.includes('Cannot read propert'), '停止过程中出现报错');
      },
    },
    {
      id: 'send.queue-while-running',
      title: '运行中再发一条 → 第二条被接收 (排队)',
      model: true,
      timeoutMs: 180_000,
      run: async ({ page }) => {
        await newSession(page);
        await sendMessage(page, '数一下从 1 到 50');
        await waitFor(async () => await isRunning(page), { what: '进入生成中', timeout: 60_000, interval: 300 });
        const before = await userMessageCount(page);
        /* 运行中再发一条 */
        await sendMessage(page, '再加一句：谢谢').catch(() => {});
        /* 第二条要么入流 (计数 +1), 要么给出排队提示 —— 两者都算「接收」 */
        await waitFor(
          async () => {
            const n = await userMessageCount(page);
            if (n > before) return true;
            const t = await bodyText(page);
            return /排队|等待中|queued|发送中/.test(t);
          },
          { what: '第二条消息被接收', timeout: 60_000, interval: 400 },
        );
        await clickStop(page).catch(() => {});
      },
    },
  ],
};
