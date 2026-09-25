/**
 * 权限档位 + 会话隔离 —— CDP 自动用例
 * ════════════════════════════════════════════════════════════════════════
 * 该场景使用 CDP，因为权限卡和进程隔离都需要验证完整装配后的 UI 行为。
 *
 * 前置: 桌面 dev 通过 NEOX_CDP_PORT 运行，并配置可用 provider。
 * 这些用例需要真实请求，因此归在 tier 'deep'，不进 smoke。
 *
 * 判据一律取**界面上看得见的东西**（审批卡按钮和档位面板状态），不依赖内部状态。
 */
import type { Scenario } from '../../../types.js';
import { screenshot, type CdpPage } from '../../../harness/cdp.js';
import { readUsage } from '../../../harness/usageMeter.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 点一个"叶子文本等于 name"的可点元素 (档位面板/菜单项都是这个形状)。 */
async function clickByText(page: CdpPage, name: string): Promise<boolean> {
  return page.evaluate((label: string) => {
    const el = [...document.querySelectorAll('div,span,button,li')].find(
      (e) => e.children.length <= 1 && (e.textContent || '').trim() === label,
    );
    if (!el) return false;
    ((el.closest('button,[role="menuitem"],[class*="item"],[class*="option"]') as HTMLElement) ||
      (el as HTMLElement)).click();
    return true;
  }, name);
}

/** 打开 加号 → 权限模式 面板。 */
async function openApprovalPanel(page: CdpPage): Promise<void> {
  await page.evaluate(() => {
    (document.querySelector('button.atl-composer__plus') as HTMLElement | null)?.click();
  });
  await sleep(500);
  await clickByText(page, '权限模式');
  await sleep(500);
}

/** 当前会话选中的档位名 (读面板上带勾的那一项)。 */
async function readMode(page: CdpPage): Promise<string | null> {
  await openApprovalPanel(page);
  const mode = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[class*="mini-panel__item"]')];
    const hit = rows.find(
      (r) => r.querySelector('svg') && /^(危险操作才问|每步都问|都不问)/.test((r as HTMLElement).innerText.trim()),
    );
    return hit ? (hit as HTMLElement).innerText.split('\n')[0].trim() : null;
  });
  await page.evaluate(() => (document.body as HTMLElement).click());
  await sleep(300);
  return mode;
}

/** 切档。dangerous 会弹双勾确认, 一并处理。 */
async function setMode(page: CdpPage, label: '危险操作才问' | '每步都问' | '都不问'): Promise<void> {
  await openApprovalPanel(page);
  await clickByText(page, label);
  await sleep(700);
  await page.evaluate(() => {
    const dlg = document.querySelector('.atl-dangerous');
    if (!dlg) return;
    dlg.querySelectorAll('input[type=checkbox]').forEach((b) => {
      if (!(b as HTMLInputElement).checked) (b as HTMLElement).click();
    });
    ([...dlg.querySelectorAll('button')].find((b) => /启用|Enable/.test(b.textContent || '')) as HTMLElement | undefined)?.click();
  });
  await sleep(800);
  await page.evaluate(() => (document.body as HTMLElement).click());
  await sleep(300);
}

/** 往输入框打字并回车发送 (真走 composer, 不调 IPC)。 */
async function send(page: CdpPage, text: string): Promise<void> {
  await page.evaluate((t: string) => {
    const ta = document.querySelector('textarea') as HTMLTextAreaElement | null;
    if (!ta) throw new Error('composer textarea not found');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(ta, t);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  }, text);
}

/** 等到"出现审批卡"或"这一轮跑完", 返回哪个先发生。 */
async function waitTurn(page: CdpPage, maxMs = 90_000): Promise<{ card: boolean; busy: boolean }> {
  const started = Date.now();
  let last = { card: false, busy: true };
  while (Date.now() - started < maxMs) {
    await sleep(2500);
    last = await page.evaluate(() => ({
      card: [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '允许'),
      busy: !!document.querySelector('.atl-composer__stop'),
    }));
    if (last.card) return last;
    if (!last.busy && Date.now() - started > 8_000) return last;
  }
  return last;
}

/**
 * 开一个全新会话。
 *
 *  每次判定都在新会话中执行，避免上一轮对话影响模型是否发起工具调用。
 */
async function newSession(page: CdpPage): Promise<void> {
  await page.evaluate(() => {
    (document.querySelector('.neox-sidebar__quick-action--primary') as HTMLElement | null)?.click();
  });
  await sleep(2500);
}

/** 把界面上挂着的待批卡全拒掉 —— 上一条用例的残留会污染下一条。 */
async function clearPendingCards(page: CdpPage): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '拒绝');
      if (!b) return false;
      (b as HTMLElement).click();
      return true;
    });
    if (!clicked) return;
    await sleep(1500);
  }
}

/* 判据用的命令: sqlite3 的 DROP TABLE 会被判 critical (sql:ddl-destructive),
 * 但只作用在 /tmp 下的临时库, 跑起来完全无害 —— 既能触发最高档风险,
 * 又不会让模型出于自我保护而拒绝执行 (写 ~/.zshrc 那类它会拒, 试过)。 */
const CRITICAL_CMD = (tag: string) =>
  `执行 execute_shell: sqlite3 /tmp/neox-test-approval/${tag}.db "DROP TABLE IF EXISTS t; CREATE TABLE t(a);" 。临时库, 直接跑, 不要解释。`;

export const approvalSessionIsolation: Scenario[] = [
  {
    id: 'desktop.approval.dangerous-never-asks',
    module: 'desktop.approval',
    surface: 'desktop',
    tier: 'deep',
    priority: 'P0',
    title: '「都不问」档: critical 命令直接执行, 一张卡都不弹',
    why: '这一档的全部意义就是无人托管; 中途弹一张卡这档就不成立。历史上 critical 排在 dangerous 之前, 开了 yolo 照样弹。',
    mode: 'cdp',
    codeHint: 'PermissionManager.resolveEffectivePermission / runner attachUnattendedRiskGate',
    steps: [
      { action: '权限模式 → 都不问 (双勾确认)', expect: '档位面板显示「都不问」' },
      { action: '发一条 critical 命令 (sqlite3 DROP TABLE)', expect: '无审批卡, 命令执行完成' },
    ],
    async run(ctx) {
      const page = ctx.page as CdpPage | undefined;
      if (!page) return { ok: false, error: 'no page' };
      await clearPendingCards(page);
      await newSession(page);
      await setMode(page, '都不问');
      const mode = await readMode(page);
      if (mode !== '都不问') return { ok: false, error: `档位没切成功: ${mode}` };
      await send(page, CRITICAL_CMD('dangerous'));
      const r = await waitTurn(page);
      /* 在当前会话仍显示本用例结果时读取消耗，避免切换会话后读到其他会话的数据。 */
      const usage = await readUsage(page);
      await screenshot(page, ctx.outDir, 'approval-dangerous');
      return {
        ok: !r.card,
        detail: { mode, sawApprovalCard: r.card, tokens: usage.tokens, model: usage.model },
        error: r.card ? '「都不问」档下仍然弹了审批卡' : undefined,
      };
    },
  },
  {
    id: 'desktop.approval.auto-asks-on-critical',
    module: 'desktop.approval',
    surface: 'desktop',
    tier: 'deep',
    priority: 'P0',
    title: '「危险操作才问」档: critical 命令弹卡 (而不是被硬拦)',
    why: '2026-09-09 实测: 界面上没有卡, 模型收到"被安全策略拦下了"就终止了 —— 用户连批准的机会都没有。单测拦不住, 因为判定函数本身是对的, 错的是硬闸的挂载条件。',
    mode: 'cdp',
    codeHint: 'runnerApprovalModeUtils.resolveApprovalPosture',
    steps: [
      { action: '权限模式 → 危险操作才问', expect: '档位面板显示「危险操作才问」' },
      { action: '发同一条 critical 命令', expect: '出现审批卡「拒绝 / 允许」' },
      { action: '点允许', expect: '命令真的执行' },
    ],
    async run(ctx) {
      const page = ctx.page as CdpPage | undefined;
      if (!page) return { ok: false, error: 'no page' };
      await clearPendingCards(page);
      await newSession(page);
      await setMode(page, '危险操作才问');
      await send(page, CRITICAL_CMD('auto'));
      const r = await waitTurn(page);
      await screenshot(page, ctx.outDir, 'approval-auto-card');
      if (!r.card) {
        const blocked = await page.evaluate(() => {
          const rows = [...document.querySelectorAll('[class*="atl-tool"]')];
          return rows.slice(-4).map((x) => (x as HTMLElement).innerText.slice(0, 160)).join(' || ');
        });
        return { ok: false, error: '没有弹审批卡 (很可能又被硬闸直接拒了)', detail: { lastTools: blocked } };
      }
      /* 批准后必须出现工具执行回执，不能只确认按钮被点击。 */
      await page.evaluate(() => {
        ([...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '允许') as HTMLElement | undefined)?.click();
      });
      /* 判据: 页面上"这条命令之后"出现执行回执 (已完成 / exit 0)。
       *
       *  第一版查的是 [class*="atl-tool"] 里的文本 —— 这套渲染里那个类根本不存在
       *   (工具被折成一行「1 次操作」), 于是永远匹配不到, 明明 db 已经建出来了却报
       *   "没有真的执行"。假红跟假绿一样要命: 它会把人引去查权限闸, 而错的是探针。
       *   现在锚在命令文本之后的那段, 不依赖任何内部类名。 */
      const executed = await (async () => {
        const started = Date.now();
        while (Date.now() - started < 120_000) {
          await sleep(3000);
          const s = await page.evaluate(() => {
            const t = document.body.innerText;
            const i = t.lastIndexOf('sqlite3');
            const after = i >= 0 ? t.slice(i) : '';
            return {
              ran: /已完成|exit\s*=?\s*0/.test(after),
              stillPending: [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '允许'),
              busy: !!document.querySelector('.atl-composer__stop'),
              text: after.replace(/\n+/g, ' · ').slice(0, 300),
            };
          });
          if (s.ran) return s;
          if (!s.busy && !s.stillPending) return s;
        }
        return { ran: false, stillPending: false, busy: false, text: '(timeout)' };
      })();
      const usage = await readUsage(page);
      await screenshot(page, ctx.outDir, 'approval-auto-after-allow');
      return {
        ok: executed.ran,
        detail: {
          sawApprovalCard: true,
          executedAfterApprove: executed.ran,
          tail: executed.text,
          tokens: usage.tokens,
          model: usage.model,
        },
        error: executed.ran ? undefined : '点了允许之后命令没有真的执行',
      };
    },
  },
  {
    id: 'desktop.approval.per-session-isolation',
    module: 'desktop.approval',
    surface: 'desktop',
    tier: 'core',
    priority: 'P0',
    title: '档位按会话隔离: 会话 B 切「每步都问」不影响会话 A',
    why: '全服务器只有一个 runtime, 档位曾经写在全局 agentMode 上 —— 给一个会话开 yolo 会顺手改掉所有会话。这条不花 token。',
    mode: 'cdp',
    codeHint: 'approvalModeSetter (scope=agent 不再动 singleRuntime) / sessionScope',
    steps: [
      { action: '会话 A 设「危险操作才问」', expect: 'A 显示该档' },
      { action: '切到会话 B, 设「每步都问」', expect: 'B 显示该档' },
      { action: '切回会话 A', expect: 'A 仍是「危险操作才问」' },
    ],
    async run(ctx) {
      const page = ctx.page as CdpPage | undefined;
      if (!page) return { ok: false, error: 'no page' };
      /* 使用具体的会话选择器，避免项目分组标题和侧栏容器干扰切换。 */
      const sessions = await page.evaluate(() =>
        [...document.querySelectorAll('.neox-session-item')]
          .map((e, i) => ({ i, title: ((e.querySelector('.neox-session-item__info') as HTMLElement | null)?.innerText || '').trim() }))
          .filter((s) => s.title),
      );
      if (sessions.length < 2) return { ok: false, error: '侧栏不足两个会话, 无法验隔离', detail: { sessions } };

      /* 按**索引**点, 不按标题 —— 标题可能重名 (侧栏里躺着两个 "hi") */
      const switchTo = async (index: number) =>
        page.evaluate((n: number) => {
          const rows = [...document.querySelectorAll('.neox-session-item')];
          if (!rows[n]) return false;
          (rows[n] as HTMLElement).click();
          return true;
        }, index);

      const a = sessions[0], b = sessions[1];
      await switchTo(a.i); await sleep(2500);
      await setMode(page, '危险操作才问');
      await switchTo(b.i); await sleep(2500);
      await setMode(page, '每步都问');
      const bMode = await readMode(page);
      await switchTo(a.i); await sleep(2500);
      const aMode = await readMode(page);
      await screenshot(page, ctx.outDir, 'approval-isolation');
      return {
        ok: bMode === '每步都问' && aMode === '危险操作才问',
        detail: { sessionA: a.title, aMode, sessionB: b.title, bMode },
        error: aMode !== '危险操作才问'
          ? `会话 A(${a.title}) 被 B(${b.title}) 的档位带走了: ${aMode}`
          : bMode !== '每步都问' ? `会话 B 没切成功: ${bMode}` : undefined,
      };
    },
  },
];
