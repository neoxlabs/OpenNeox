#!/usr/bin/env node
import { createRequire } from 'node:module';
import fs from 'node:fs';

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=')[1] : d;
};
const PORT = Number(arg('port', 41999));
const KEEP = process.argv.includes('--keep-session');

const REPO_REQUIRE = createRequire(new URL('../../../packages/core/package.json', import.meta.url));
const { chromium } = REPO_REQUIRE('playwright-core');

const app = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
let page;
for (const ctx of app.contexts()) for (const p of ctx.pages()) if (p.url().includes(':5180')) page = p;
if (!page) { console.log(`renderer 未找到 (CDP :${PORT})`); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/* ── 一次性会话 ──────────────────────────────────────────────────────────── */
async function newThrowawaySession() {
  await page.locator('.neox-sidebar__quick-action--primary').first().click({ timeout: 10000 });
  await sleep(2000);
  const sid = await page.evaluate(() => window.__neoxTestActiveSession?.());
  if (!sid) throw new Error('拿不到会话 id — dev 注入口没装上? (需 import.meta.env.DEV 构建)');
  return sid;
}
async function deleteSession(id) {
  return page.evaluate(async (sid) => {
    try { await window.neox.deleteSession(sid); return true; } catch { return false; }
  }, id);
}

/* ── 探针 ────────────────────────────────────────────────────────────────── */
const gapToBottom = () => page.evaluate(() => {
  const f = document.querySelector('.atl-feed');
  if (!f) return null;
  return Math.round(f.scrollHeight - f.clientHeight - f.scrollTop);
});
const scrollTopNow = () => page.evaluate(() => Math.round(document.querySelector('.atl-feed')?.scrollTop ?? -1));

async function appendTool(sid, i) {
  await page.evaluate(([sessionId, idx]) => {
    window.__neoxTestAppend({
      id: `sf-tool-${idx}`, type: 'tool_call', toolName: 'read_file', title: 'read_file',
      detail: `/synthetic/file_${idx}.ts`, output: 'x'.repeat(400), timestamp: Date.now(),
    }, sessionId);
  }, [sid, i]);
}
async function appendAssistant(sid, i) {
  await page.evaluate(([sessionId, idx]) => {
    window.__neoxTestAppend({
      id: `sf-msg-${idx}`, type: 'assistant_message', detail: '开始回答。',
      timestamp: Date.now(), pending: true, messageId: `sf-m-${idx}`,
    }, sessionId);
  }, [sid, i]);
}
/** 模拟 token 逐步长高 —— 这是最考验跟底的一步 */
async function growAssistant(sid, i, chunks) {
  for (let c = 1; c <= chunks; c++) {
    await page.evaluate(([sessionId, idx, n]) => {
      window.__neoxTestUpdate(`sf-msg-${idx}`, {
        detail: Array.from({ length: n }, (_, k) => `第 ${k + 1} 段流式输出内容, 用来把这条消息撑高。`).join('\n\n'),
      }, sessionId);
    }, [sid, i, c]);
    await sleep(70);
  }
}

const results = {};
let sid = null;
try {
  log('新建一次性会话…');
  sid = await newThrowawaySession();
  log(`  → ${sid}`);
  await page.evaluate(() => window.__neoxTestSetStreaming?.(true));

  /* 先铺够内容 —— 否则场景2 上滚会直接撞到 scrollTop=0, latch 假过
   * (第一版就栽在这: "用户停在 0 → 追加后 0", 看着漂移 0 其实根本没滚动余量)。 */
  /* 用 user/assistant 消息对铺高度 —— 连续同类 tool_call 会被折叠成 activity 摘要行,
   * 60 条只折出几百 px, 第二版就栽在这 (hasRoom=false)。消息行不折叠, 才撑得起滚动余量。 */
  log('铺垫 40 轮消息…');
  await page.evaluate((sessionId) => {
    const body = '这是用于撑开 timeline 高度的合成正文段落, 需要足够长才能产生真实滚动余量。'.repeat(6);
    for (let i = 0; i < 40; i++) {
      window.__neoxTestAppend({
        id: `sf-seed-u-${i}`, type: 'user_message', detail: `合成提问 ${i}`,
        timestamp: Date.now() - (200 - i) * 1000,
      }, sessionId);
      window.__neoxTestAppend({
        id: `sf-seed-a-${i}`, type: 'assistant_message', detail: `${body}\n\n段落二: ${body}`,
        timestamp: Date.now() - (200 - i) * 1000 + 1, messageId: `sf-seed-m-${i}`,
      }, sessionId);
    }
  }, sid);
  await sleep(2500);
  const seededRange = await page.evaluate(() => {
    const f = document.querySelector('.atl-feed');
    return f ? Math.round(f.scrollHeight - f.clientHeight) : 0;
  });
  log(`  可滚动余量 ${seededRange}px`);

  /* 场景1: 流式跟底 —— 追加 + 原地长高, 视口必须一直贴底 */
  log('\n[1/4] 流式跟底');
  const gaps = [];
  for (let i = 0; i < 8; i++) {
    await appendTool(sid, i);
    await sleep(120);
    await appendAssistant(sid, i);
    await growAssistant(sid, i, 5);
    await sleep(180);
    gaps.push(await gapToBottom());
  }
  results.follow = { gaps, maxGap: Math.max(...gaps.filter((g) => g != null)) };
  log(`  gap 序列: ${gaps.join(', ')}   最大 ${results.follow.maxGap}px`);

  /* 场景2: 用户上滚后必须 latch —— 新内容不许把视口拽回去 */
  log('\n[2/4] 上滚 latch (新内容不许抢视口)');
  await page.evaluate(() => {
    const f = document.querySelector('.atl-feed');
    f.scrollTop = Math.max(0, f.scrollTop - 1200);
  });
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, -240); /* 真实 wheel 才会 latch */
  await sleep(300);
  const afterUserScroll = await scrollTopNow();
  /* 必须真的有滚动余量, 否则这条闸是假的 */
  const hasRoom = afterUserScroll > 400;
  for (let i = 20; i < 24; i++) { await appendTool(sid, i); await sleep(150); }
  await sleep(400);
  const afterNewContent = await scrollTopNow();
  results.latch = { afterUserScroll, afterNewContent, drift: afterNewContent - afterUserScroll, hasRoom };
  log(`  用户停在 ${afterUserScroll} → 追加 4 条后 ${afterNewContent}  (漂移 ${results.latch.drift}px)`);

  /* 场景3: 空闲 >4.5s 自动回底 (产品行为, 不能被我改坏) */
  log('\n[3/4] 空闲自动回底 (等 6s)');
  await sleep(6200);
  results.idleReturn = { gap: await gapToBottom() };
  log(`  gap = ${results.idleReturn.gap}px`);

  /* 场景4: 停止流式后不漂 */
  log('\n[4/4] 停流后不漂');
  await page.evaluate(() => window.__neoxTestSetStreaming?.(false));
  await sleep(500);
  const t0 = await scrollTopNow();
  await sleep(2000);
  const t1 = await scrollTopNow();
  results.noDrift = { t0, t1, drift: t1 - t0 };
  log(`  ${t0} → ${t1}  (漂移 ${results.noDrift.drift}px)`);
} finally {
  if (sid && !KEEP) {
    const ok = await deleteSession(sid);
    log(`\n清理一次性会话: ${ok ? '已删' : '删除失败, 请手动删'} (${sid})`);
  }
}

const gates = {
  /* 流式期任意时刻离底不超过一行高度 */
  followsBottom: results.follow.maxGap <= 80,
  /* 用户上滚后, 新内容造成的漂移必须为 0 */
  /* hasRoom 一并进闸: 没有滚动余量时这条不算通过 (防假过) */
  latchHolds: results.latch.hasRoom && Math.abs(results.latch.drift) <= 2,
  /* 空闲超时后回到底部 */
  idleReturns: results.idleReturn.gap != null && results.idleReturn.gap <= 80,
  /* 停流后静止 */
  noDriftAfterStop: Math.abs(results.noDrift.drift) <= 2,
};
const out = { pass: Object.values(gates).every(Boolean), gates, results };
fs.writeFileSync('/tmp/neox-timeline-stream-follow.json', JSON.stringify(out, null, 2));
log('\n' + JSON.stringify({ pass: out.pass, gates }, null, 2));
/* connectOverCDP 下绝不能 app.close() — 会关掉整个 Electron */
process.exit(out.pass ? 0 : 2);
