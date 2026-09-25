/**
 * 下限跑分 —— 每个任务用**手写脚本**一次跑完, 0 次模型往返。
 *
 * 这是物理下限: 一个完全知道该怎么做的执行者需要多少时间。
 * agent 再聪明也快不过它, 所以它是"还差多少"的那把尺子。
 *
 * 用法: node runner/floor.mjs        (需要 app 已在跑)
 */
import { chromium } from '/Users/exampleuser/AI/OpenNeox/node_modules/playwright-core/index.mjs';
import { TASKS, BASE, reset } from '../tasks/tasks.mjs';

const t0 = () => process.hrtime.bigint();
const ms = (a) => Number(process.hrtime.bigint() - a) / 1e6;

/** 每个任务的"理想路径" —— 知道答案的人会怎么点 */
const SCRIPTS = {
  async login(page) {
    await page.goto(`${BASE}/`);
    await page.fill('#u', 'admin');
    await page.fill('#p', 'neox2026');
    await page.click('#submit');
    await page.waitForURL('**/tickets');
  },
  async 'close-one'(page) {
    await page.goto(`${BASE}/tickets`);
    await page.waitForSelector('#tbl');
    await page.click('tr[data-id="3"] button.close');
    await page.click('#yes');
    await page.waitForFunction(() => !document.querySelector('tr[data-id="3"] button.close:not([disabled])'));
  },
  async 'assign-search'(page) {
    await page.goto(`${BASE}/tickets`);
    await page.waitForSelector('#tbl');
    await page.fill('#q', '导出 CSV');
    /* 第一条就是 ID 最小的 (列表本来就按 id 升序) */
    const id = await page.locator('#tbl tbody tr').first().getAttribute('data-id');
    page.once('dialog', (d) => d.accept('赵六'));
    await page.click(`tr[data-id="${id}"] button.assign`);
    await page.waitForFunction((i) => document.querySelector(`tr[data-id="${i}"]`)?.textContent.includes('赵六'), id);
  },
  async 'urgent-page2'(page) {
    await page.goto(`${BASE}/tickets`);
    await page.waitForSelector('#tbl');
    await page.selectOption('#pr', 'urgent');
    await page.selectOption('#st', 'open');
    /* 筛完之后反复关第一条, 直到列表空 —— 关一条它就从"未关闭"里消失 */
    for (let i = 0; i < 30; i++) {
      const rows = await page.locator('#tbl tbody tr').count().catch(() => 0);
      if (!rows) break;
      const id = await page.locator('#tbl tbody tr').first().getAttribute('data-id');
      await page.click(`tr[data-id="${id}"] button.close`);
      await page.click('#yes');
      await page.waitForFunction((i2) => !document.querySelector(`tr[data-id="${i2}"]`), id, { timeout: 3000 })
        .catch(() => {});
    }
  },
  async 'locked-trap'(page) {
    await page.goto(`${BASE}/tickets`);
    await page.waitForSelector('#tbl');
    await page.click('tr[data-id="7"] button.close');
    await page.click('#yes');
    await page.waitForSelector('#toast', { state: 'visible' });
    /* 理想执行者会读 toast 拿到真实原因, 而不是假设成功了 */
    return { report: await page.textContent('#toast') };
  },
  async report(page) {
    await page.goto(`${BASE}/tickets`);
    await page.waitForSelector('#tbl');
    return {
      report: await page.evaluate(() => {
        const a = window.__all;
        return `共 ${a.length} 条, 已关闭 ${a.filter((t) => t.status === 'closed').length} 条, `
          + `未分配 ${a.filter((t) => !t.assignee).length} 条`;
      }),
    };
  },
};

const b = await chromium.launch();
const out = [];
for (const task of TASKS) {
  await reset();
  const page = await b.newPage();
  if (task.needsLogin) {
    await page.goto(`${BASE}/`);
    await page.fill('#u', 'admin'); await page.fill('#p', 'neox2026');
    await page.click('#submit'); await page.waitForURL('**/tickets');
  }
  const s = t0();
  let extra = {}; let err = null;
  try { extra = (await SCRIPTS[task.id](page)) ?? {}; } catch (e) { err = e.message?.slice(0, 90); }
  const took = ms(s);
  const v = err ? { ok: false, why: err } : await task.verify();
  out.push({ id: task.id, level: task.level, ms: Math.round(took), ok: v.ok, why: v.why, ...extra });
  await page.close();
}
await b.close();

console.log('任务'.padEnd(16) + '档   耗时      结果');
console.log('─'.repeat(52));
for (const r of out) {
  console.log(
    r.id.padEnd(16) + r.level.padEnd(5) +
    `${String(r.ms).padStart(5)} ms  ` +
    (r.ok ? '✓' : `✗ ${r.why ?? ''}`) +
    (r.report ? `  「${r.report.trim().slice(0, 40)}」` : ''),
  );
}
const total = out.reduce((n, r) => n + r.ms, 0);
console.log('─'.repeat(52));
console.log(`合计 ${total} ms · ${out.filter((r) => r.ok).length}/${out.length} 通过 · 模型往返 0 次`);
process.exit(0);
