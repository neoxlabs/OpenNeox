import {
  newSession,
  sendMessage,
  clickVisible,
  isRunning,
  clickStop,
  bodyText,
} from '../lib/ui.mjs';
import { assert, waitFor } from '../lib/assert.mjs';

const SEL_PILL = '.nx-dock__pill[data-pill-id="plan"] .nx-dock__pill-main';
const SEL_ROWS = '.nx-dock__panel .atl-planbar__row';

/** 计划行里的某个按钮 (按文字, 真实点击前先悬停 —— 按钮默认 opacity:0) */
async function clickRowAction(page, rowIndex, label) {
  const box = await page.evaluate(
    ([sel, i, text]) => {
      const rows = [...document.querySelectorAll(sel)];
      const row = rows[i];
      if (!row) return null;
      const btn = [...row.querySelectorAll('.atl-planbar__act')].find((b) =>
        (b.innerText || '').trim().includes(text),
      );
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    [SEL_ROWS, rowIndex, label],
  );
  if (!box) throw new Error(`第 ${rowIndex + 1} 步上没有「${label}」按钮`);
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(150);
  await page.mouse.click(box.x, box.y);
}

async function rowStates(page) {
  return page.evaluate((sel) =>
    [...document.querySelectorAll(sel)].map((el) => ({
      text: (el.innerText || '').trim(),
      cls: el.className,
    })),
  SEL_ROWS);
}

/** 等计划药丸出现并展开面板 —— 计划面板是 Q-06 唯一的交互入口 */
async function openPlanPanel(page) {
  await waitFor(() => page.evaluate((s) => !!document.querySelector(s), SEL_PILL), {
    what: '输入框上方出现计划药丸',
    timeout: 180_000,
    interval: 500,
  });
  if (!(await page.evaluate(s => !!document.querySelector(s), SEL_ROWS))) {
    await clickVisible(page, SEL_PILL);
  }
  await waitFor(async () => (await rowStates(page)).length >= 3, {
    what: '计划面板列出 3 步',
    timeout: 20_000,
    interval: 300,
  });
}

const PLAN_PROMPT =
  '先用 update_plan 建一个三步计划（1 收集素材 2 写初稿 3 排版），然后只回复“计划已建好”。' +
  '不要执行任何工具，也不要真的做这三步。';

export default {
  id: 'plan',
  title: '计划可点可改 / 中断后继续',
  scenarios: [
    {
      id: 'plan.edit-skip',
      title: '计划面板点「跳过」→ 那一步变 skipped',
      model: true,
      timeoutMs: 240_000,
      run: async ({ page, shot }) => {
        await newSession(page);
        await sendMessage(page, PLAN_PROMPT);
        await openPlanPanel(page);
        await shot('panel');

        const before = await rowStates(page);
        const target = before.findIndex((r) => r.text.includes('写初稿'));
        assert(target >= 0, `计划里没有「写初稿」: ${before.map((r) => r.text).join(' | ')}`);
        assert(!before[target].cls.includes('is-skip'), '跳过前不该是 skipped');

        await clickRowAction(page, target, '跳过');
        await waitFor(async () => (await rowStates(page))[target]?.cls.includes('is-skip'), {
          what: '那一步变成 skipped',
          timeout: 10_000,
          interval: 200,
        });
        await shot('after-skip');

        /* 计划条不能因此永远停在 N-1/N —— 跳过的步算“不做了” */
        const t = await bodyText(page);
        assert(!/Cannot read propert|Maximum update depth/.test(t), '界面上出现渲染异常');
      },
    },
    {
      id: 'plan.rename-and-focus',
      title: '计划面板「改名」+「先做」都生效',
      model: true,
      timeoutMs: 240_000,
      run: async ({ page, shot }) => {
        await newSession(page);
        await sendMessage(page, PLAN_PROMPT);
        await openPlanPanel(page);

        const before = await rowStates(page);
        const target = before.findIndex((r) => r.text.includes('排版'));
        assert(target >= 0, '计划里没有「排版」');

        await clickRowAction(page, target, '改名');
        const input = page.locator(SEL_ROWS + ' .atl-planbar__edit').first();
        await input.waitFor({ state: 'visible', timeout: 5_000 });
        await input.fill('定稿排版');
        await input.press('Enter');
        await waitFor(async () => (await rowStates(page))[target]?.text.includes('定稿排版'), {
          what: '标题改成「定稿排版」',
          timeout: 10_000,
          interval: 200,
        });

        await clickRowAction(page, target, '先做');
        await waitFor(async () => (await rowStates(page))[target]?.cls.includes('is-running'), {
          what: '那一步变成当前步',
          timeout: 10_000,
          interval: 200,
        });
        await shot('after-rename-focus');
      },
    },
    {
      id: 'plan.resume-after-stop',
      title: '播停 → 出现「停在第 N 步 · 继续」→ 点一下接着跑',
      model: true,
      timeoutMs: 300_000,
      run: async ({ page, shot }) => {
        await newSession(page);
        /* 一条 prompt 里把计划 + 长输出都安排好。
         *
         * 不能分两步发 (第二版就是这么挂的): 计划建好但没做完时, 应用会自动续跑几轮,
         * 那几轮之间发送按钮是隐藏的, 第二次 sendMessage 直接找不到元素。
         *
         * 模型偶尔会忘了调 update_plan 直接开始写 —— 那就重来一次 (最多两次)。 */
        const prompt =
          '必须先用 update_plan 工具建立这个三步计划（1 收集素材 2 写初稿 3 排版，主题「秋天的街道」），' +
          '不能只用文字描述。工具返回之后再开始写 2000 字初稿，一直写，不要停下来问我。';
        let hasPlan = false;
        for (let attempt = 0; attempt < 2 && !hasPlan; attempt++) {
          await sendMessage(page, attempt === 0 ? prompt : '请先调用 update_plan 建立上面那三步计划，然后再写。');
          try {
            await waitFor(() => page.evaluate((s) => !!document.querySelector(s), SEL_PILL), {
              what: '计划药丸出现',
              timeout: 90_000,
              interval: 300,
            });
            hasPlan = true;
          } catch {
            /* 这一轮没建计划 (模型直接写了) —— 等它收尾再试一次 */
            await waitFor(async () => !(await isRunning(page)), {
              what: '未建计划的那一轮收尾',
              timeout: 120_000,
              interval: 500,
            });
          }
        }
        assert(hasPlan, '两次都没等到 update_plan 建立的计划');
        await waitFor(() => isRunning(page), { what: '还在生成中', timeout: 30_000, interval: 300 });
        await clickStop(page);
        await waitFor(async () => !(await isRunning(page)), {
          what: '停下来',
          timeout: 30_000,
          interval: 300,
        });

        const resumeSel = '.nx-dock__pill[data-pill-id="resume-turn"]';
        await waitFor(() => page.evaluate((s) => !!document.querySelector(s), resumeSel), {
          what: '出现「继续这一轮」药丸',
          timeout: 30_000,
          interval: 300,
        });
        const text = await page.evaluate(
          (s) => document.querySelector(s)?.innerText?.trim() ?? '',
          resumeSel,
        );
        assert(/停在第 \d+ 步/.test(text), `药丸文案不是「停在第 N 步」: ${text}`);
        assert(/继续/.test(text), `药丸上没有「继续」: ${text}`);
        await shot('resume-pill');

        await clickVisible(page, resumeSel + ' .nx-dock__pill-main');
        await waitFor(() => isRunning(page), {
          what: '点继续后从断点接着跑',
          timeout: 60_000,
          interval: 300,
        });
        await shot('resumed');
        await clickStop(page).catch(() => {});
      },
    },
  ],
};
