/**
 * 断言与轮询 —— 走真实界面, 所以断言都要「等到它成立」而不是立刻判死。
 */

/** 轮询直到 fn() 返回真值; 超时抛错并带上最后一次的值 */
export async function waitFor(fn, { timeout = 10_000, interval = 200, what = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`等不到 ${what} (最后一次: ${JSON.stringify(last)})`);
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export async function assertText(page, text, { selector = 'body', timeout = 10_000 } = {}) {
  const read = () =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.innerText : '';
    }, selector);
  await waitFor(async () => (await read()).includes(text), {
    timeout,
    what: `「${text}」出现在 ${selector}`,
  });
}

export async function assertNoText(page, text, { selector = 'body', timeout = 5_000 } = {}) {
  await waitFor(
    async () => {
      const body = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.innerText : '';
      }, selector);
      return !body.includes(text);
    },
    { timeout, what: `「${text}」消失` },
  );
}

/** 可见 (允许被裁切, 只要占位) */
export async function visible(page, selector, { timeout = 10_000, what } = {}) {
  const loc = page.locator(selector).filter({ visible: true }).first();
  await waitFor(async () => (await loc.count()) > 0 || (await loc.isVisible().catch(() => false)), {
    timeout,
    what: what ?? `可见元素 ${selector}`,
  }).catch(async () => {
    if (!(await loc.isVisible().catch(() => false))) {
      throw new Error(`等不到可见元素 ${selector}`);
    }
  });
  return loc;
}

export async function hidden(page, selector, { timeout = 10_000, what } = {}) {
  await waitFor(async () => (await page.locator(selector).filter({ visible: true }).count()) === 0, {
    timeout,
    what: what ?? `${selector} 消失`,
  });
}

/** 界面上的错误浮层 / 报错文案 —— 出现就算场景失败 */
const ERROR_SIGNS = ['Uncaught', 'Unhandled', 'Cannot read propert', 'is not a function', '错误：', '出错了'];

export async function assertNoErrorOverlay(page) {
  const text = await page.evaluate(() => document.body.innerText);
  for (const sign of ERROR_SIGNS) {
    if (text.includes(sign)) throw new Error(`界面出现错误文案「${sign}」`);
  }
  const toast = await page.locator('.neox-toast--error, .neox-error-toast, .error-boundary').count();
  if (toast > 0) throw new Error('界面出现错误浮层');
}
