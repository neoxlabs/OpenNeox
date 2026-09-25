
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { ToolResult } from '@neoxlabs/kernel/core/types/toolResult.js';
import { createContextualResult } from '@neoxlabs/kernel/core/types/toolResult.js';
import { createSessionScopedStore } from '@neoxlabs/kernel';
import { getBrowserSession } from './browserSession.js';
import { IMAGE_RESULT_PREFIX, buildImageToolResult, parseImageResultImages } from '../../tools/image/imageProcessor.js';
import { RADIO_GROUPS_FN } from './browserChoose.js';
import {
  healingVariants, loadRecipe, saveRecipe, listRecipes,
  type Recipe, type RecipeAnchor, type RecipeStep,
} from './browserRecipes.js';

const runStatsStore = createSessionScopedStore<{ calls: number; totalSteps: number; lastAt: number }>(
  () => ({ calls: 0, totalSteps: 0, lastAt: 0 }),
  { inherit: false },
);

function usageAdvice(stepCount: number): string | undefined {
  const s = runStatsStore.get();
  const now = Date.now();
  /* 隔了 2 分钟以上视为新任务, 重新计 */
  if (now - s.lastAt > 120_000) { s.calls = 0; s.totalSteps = 0; }
  s.calls += 1;
  s.totalSteps += stepCount;
  s.lastAt = now;
  if (s.calls < 3) return undefined;
  const avg = s.totalSteps / s.calls;
  if (avg >= 3) return undefined;
  return `⚠️ 你这一轮已经调了 ${s.calls} 次 browser_run, 平均每次只有 ${avg.toFixed(1)} 步 —— `
    + `这等于把脚本工具当单步工具用, 每次都要付一整个模型往返 (~20 秒), `
    + `而脚本内一个动作只要 ~14ms。接下来请**一次把剩下的动作全写完**: `
    + `把导航、点击、输入、等待、断言、读取结果排成一串 steps 交上来, 中途不要回来。 `
    + `不确定页面结构就先用 query/get_aria_tree 看一眼, 然后写长脚本。`;
}

export interface ChangeAssertion {
  /** 看什么变: url / 某个选择器命中的元素数 + 首条文本 / 任意 JS 表达式的值 */
  watch: 'url' | 'title' | { selector: string } | { expression: string };
  /** 等多久 (ms), 默认 8000 */
  timeoutMs?: number;
}

/** 脚本里的一条指令 —— 名字直接对应现有 browser_* 工具, 不另造一套语义。 */
export interface BrowserStep {
  /** 要跑哪个动作。等价于原来的工具名去掉 browser_ 前缀。 */
  action:
    | 'navigate' | 'click' | 'type' | 'fill_form' | 'press_key' | 'scroll' | 'hover'
    | 'select_option' | 'wait_for' | 'wait_for_navigation' | 'expect' | 'eval'
    | 'get_text' | 'query' | 'screenshot' | 'get_aria_tree' | 'back' | 'forward' | 'reload'
    /* 诊断类 —— 排错时要跟动作穿插着跑 (点一下, 看看控制台报了什么), 拆出去就是一次往返 */
    | 'get_console_logs' | 'get_network' | 'get_bbox' | 'sync_daily_logins'
    /* 逐题作答 (Jev 选, 光标滑过去点) —— 见 browserChoose.ts */
    | 'choose'
    /* 批量 —— 见 repeat 的说明。列表页上这一个动作顶几十次往返 */
    | 'repeat';
  /** 透传给对应工具的参数。 */
  args?: Record<string, unknown>;
  /**
   * 这一步做完必须发生的变化。**强烈建议每个会改变页面的动作都带上**:
   * 没有它, "点了但没反应" 会被当成成功, 后面的步骤全建在一个错误前提上。
   */
  expectChange?: ChangeAssertion;
  /** 这一步失败时是否继续往下 (默认 false = 停下来回报)。探测性步骤可以设 true。 */
  optional?: boolean;
  /** 给人看的标签, 会出现在时间线和失败回报里。 */
  label?: string;
  /** 录制回放专用: 主定位失效时按顺序试的备用定位方式 (见 browserRecipes.healingVariants)。 */
  anchors?: RecipeAnchor[];

  /* ─── repeat 专用 (见 runRepeat 的说明) ─────────────────────────────────
   * 「把 do 这几步反复做, 直到 untilGone 指的东西一个都不剩」。
   *
   * 脚本是**静态**的, 而列表页是**动态**的: 关掉一条整张表就重绘, 后面写好的步骤
   * 连同 ref 全部失效 —— 所以模型只能一条一条做, 每条一次完整往返。基准里
   * urgent-page2 四轮都卡在 230 秒, 而手写下限用这个模式 698ms 跑完。 */
  do?: BrowserStep[];
  /** 重复到这个选择器一个都不剩为止 */
  untilGone?: string;
  /** 最多做几轮 (默认 20, 上限 50)。到顶不算失败, 但回执里会说清楚还剩多少 */
  maxRounds?: number;
}

export interface BrowserRunArgs {
  steps: BrowserStep[];
  /** 整段脚本的总时限 (ms)。默认 60s —— 防止一段脚本把整轮拖死。 */
  timeoutMs?: number;
  /** 失败时是否附截图 (默认 true)。成功时**从不**附 —— 成功不需要看图, 那是白烧 token。 */
  screenshotOnFailure?: boolean;
  /**
   * 录下来, 存成一个可复跑的技能 (~/.neox/skills/<name>/SKILL.md)。
   * **只在整段跑成功时才存** —— 存一段半路失败的脚本, 下次复跑只会再失败一次。
   */
  record?: string;
  /** 录制的一句话说明, 会写进 SKILL.md 的标题和 description。 */
  recordDescription?: string;
}

export interface RecordReceipt {
  name: string;
  path: string;
  steps: number;
  /** 回放时自愈改写了几步, 并且已经写回文件 */
  healed?: number;
}

export interface StepOutcome {
  index: number;
  action: string;
  label?: string;
  ok: boolean;
  ms: number;
  output?: string;
  error?: string;
  /** 这一步明显偏慢时给的提醒 —— 模型得知道自己哪一步在烧时间。 */
  slowHint?: string;
  /** 主定位失效、靠备用定位救回来了。**必须报出去** —— 页面结构变了这件事本身值钱。 */
  healed?: string;

  /** 这一步弹出的原生对话框 + 我们怎么答的 + 要答的话怎么写 */
  dialog?: { type: string; message: string; handled: string; text?: string; hint?: string };
  /** 这一步期间的失败请求 (HTTP ≥ 400 / 网络失败) 和控制台报错, 一条一行 */
  signals?: string[];
  /** 这一步之后页面上**新出现**的文字 (toast / 校验提示 / 错误横幅), 截 160 字 */
  appeared?: string;
}

export interface PageSnapshot {
  url?: string;
  title?: string;
  /** 可交互元素, 已编号。形如 `3: button "保存"` —— 那个 3 可以直接当 `ref: 3` 用。 */
  actionable?: string[];
  /** 给模型的一句话: 这些编号怎么用。不写的话它不知道编号能引用, 会自己去拼选择器。 */
  refHint?: string;
  /** 表格/列表的行数 —— 搜索结果类页面最常问的就是这个。 */
  rows?: number;
  structure?: {
    /** 形如 `#tbl · 10 行 · [ID|标题|状态] · 每行操作: button.assign, button.close` */
    tables?: string[];
    /** 分页控件 + 一句页码信息 */
    paging?: string;
    /** 筛选/搜索控件, 带当前值和可选项 */
    filters?: string[];
  };
  /** 正文摘要 (前 300 字), 让模型知道"页面大概在说什么"。 */
  digest?: string;
  /** 页面上有成组的单选题时: 几道、答了几道, 以及"直接 choose"的提示。 */
  quiz?: string;
  dataApis?: string[];
  /** 失败时才带截图。 */
  screenshot?: string;
}

export interface BrowserRunResult {
  ok: boolean;
  ranSteps: number;
  totalSteps: number;
  totalMs: number;
  /** 失败在第几步 (0-based)。全成功时 undefined。 */
  failedAt?: number;
  steps: StepOutcome[];
  page?: PageSnapshot;
  recorded?: RecordReceipt;
  images?: Array<{ base64: string; mediaType: string; label?: string }>;
}

/** 会真的产生输入事件的动作 —— 这些要先给接管遮罩开放行窗, 否则会被自己人拦到超时。 */
const INPUT_ACTIONS = new Set<BrowserStep['action']>([
  'click', 'type', 'fill_form', 'press_key', 'hover', 'select_option', 'scroll',
]);

/** 不改页面的动作 —— 它们上面的 expectChange 一律跳过 (见执行循环里的说明)。 */
const READ_ONLY_ACTIONS = new Set<BrowserStep['action']>([
  'wait_for', 'wait_for_navigation', 'expect', 'get_text', 'query', 'screenshot',
  'get_aria_tree', 'get_console_logs', 'get_network', 'get_bbox',
]);

/** 放行窗时长: 够一个动作用完, 又短到用户几乎不可能在这个缝里误点。 */
const GUARD_PAUSE_MS = 1500;

/** 给接管遮罩开一小段放行窗。横幅不在 (还没注入 / 已关) 时静默跳过。 */
async function pauseTakeoverGuard(tools: Map<string, Tool>, signal?: AbortSignal): Promise<void> {
  const evalTool = tools.get('browser_eval');
  if (!evalTool) return;
  try {
    await evalTool.function(
      { expression: `(()=>{try{window.__neoxTakeoverGuard&&window.__neoxTakeoverGuard.pause(${GUARD_PAUSE_MS});return 1}catch(e){return 0}})()` } as never,
      { signal } as never,
    );
  } catch { /* 放行失败不该让整条脚本停下来 */ }
}

const WAIT_STEP_DEFAULT_MS = 6_000;
const WAIT_STEP_MAX_MS = 8_000;

/** action → 现有工具名。保持一一对应, 不做别名魔法。 */
/** repeat 不是一个工具 —— 它在 dispatch 里展开成对 do 的反复执行, 所以不在这张表里 */
const ACTION_TO_TOOL: Record<Exclude<BrowserStep['action'], 'repeat'>, string> = {
  navigate: 'browser_navigate',
  click: 'browser_click',
  type: 'browser_type',
  fill_form: 'browser_fill_form',
  press_key: 'browser_press_key',
  scroll: 'browser_scroll',
  hover: 'browser_hover',
  select_option: 'browser_select_option',
  wait_for: 'browser_wait_for',
  wait_for_navigation: 'browser_wait_for_navigation',
  expect: 'browser_expect',
  eval: 'browser_eval',
  get_text: 'browser_get_text',
  query: 'browser_query',
  screenshot: 'browser_screenshot',
  get_aria_tree: 'browser_get_aria_tree',
  back: 'browser_back',
  forward: 'browser_forward',
  reload: 'browser_reload',
  get_console_logs: 'browser_get_console_logs',
  get_network: 'browser_get_network',
  get_bbox: 'browser_get_bbox',
  sync_daily_logins: 'browser_sync_daily_logins',
  choose: 'browser_choose',
};

/**
 * 执行一段脚本。
 *
 * @param tools 现有的 browser_* 工具表 (name → Tool)。这里**不**直接 import 具体实现,
 *   一是避免循环依赖, 二是让测试能塞假工具进来量调度开销本身。
 */
export async function runBrowserScript(
  args: BrowserRunArgs,
  tools: Map<string, Tool>,
  ctx?: { signal?: AbortSignal; sessionId?: string },
): Promise<BrowserRunResult> {
  // Internal probes and receipts must inherit cancellation too, not only action steps.
  if (ctx?.signal || ctx?.sessionId) {
    tools = new Map([...tools].map(([name, tool]) => [name, {
      ...tool,
      function: (input, context) => tool.function(input, {
        ...context,
        signal: ctx.signal ?? context?.signal,
        sessionId: ctx.sessionId ?? context?.sessionId,
      }),
    }]));
  }
  const steps = Array.isArray(args.steps) ? args.steps : [];
  const budgetMs = args.timeoutMs ?? 60_000;
  const startedAt = Date.now();
  const outcomes: StepOutcome[] = [];
  /* 有没有哪一步导航过 —— 决定快照前的稳定窗要多长 (见 settlePage) */
  let sawNavigation = false;

  for (const [i, step] of steps.entries()) {
    if (ctx?.signal?.aborted) {
      return finish(false, i, '用户中断');
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed > budgetMs) {
      outcomes.push({ index: i, action: step.action, label: step.label, ok: false, ms: 0,
        error: `脚本总时限 ${budgetMs}ms 用完 (已跑 ${i} 步)` });
      return finish(false, i);
    }

    /* repeat 在这里就地展开 —— 它不对应任何单个工具 (见 ComputerFreeStep 上的说明)。
     * 放在预算检查之后、工具解析之前: 它自己会一轮一轮跑, 每轮都受总时限约束。 */
    if (step.action === 'repeat') {
      const ra = (step.args ?? {}) as { untilGone?: unknown; do?: unknown; maxRounds?: unknown };
      if (step.untilGone === undefined && typeof ra.untilGone === 'string') step.untilGone = ra.untilGone;
      if (step.do === undefined && Array.isArray(ra.do)) step.do = ra.do as BrowserStep[];
      if (step.maxRounds === undefined && typeof ra.maxRounds === 'number') step.maxRounds = ra.maxRounds;
      const t0r = Date.now();
      const r = await runRepeat(step, tools, ctx, () => Date.now() - startedAt > budgetMs);
      outcomes.push({ index: i, action: 'repeat', label: step.label, ok: r.ok,
        ms: Date.now() - t0r, output: r.summary, error: r.error });
      if (!r.ok && !step.optional) return finish(false, i);
      continue;
    }

    const toolName = ACTION_TO_TOOL[step.action as Exclude<BrowserStep['action'], 'repeat'>];
    const tool = toolName ? tools.get(toolName) : undefined;
    if (!tool) {
      outcomes.push({ index: i, action: step.action, label: step.label, ok: false, ms: 0,
        error: `未知动作 "${step.action}" —— 可用的是: ${Object.keys(ACTION_TO_TOOL).join(', ')}` });
      return finish(false, i);
    }

    const sleepMs = detectHardSleep(step);
    if (sleepMs !== null && sleepMs > 800) {
      outcomes.push({
        index: i, action: step.action, label: step.label, ok: false, ms: 0,
        error: `这一步里写了 ${sleepMs}ms 的固定睡眠 —— 别这么等。`
          + ` 用 expectChange 代替: 它每 40ms 轮询一次, 页面一变立刻继续, 通常几十毫秒就过了,`
          + ` 而且"等不到"会明确报错而不是傻等完继续往下。`
          + ` 例: { action: "click", args: {...}, expectChange: { watch: "url" } }`
          + ` 或 expectChange: { watch: { selector: "tbody tr" } }。`,
      });
      if (!step.optional) return finish(false, i);
      continue;
    }

    if (step.action === 'wait_for' || step.action === 'wait_for_navigation') {
      const a = step.args as { timeout?: unknown } | undefined;
      const given = Number(a?.timeout ?? 0);
      const capped = Math.min(given > 0 ? given : WAIT_STEP_DEFAULT_MS, WAIT_STEP_MAX_MS);
      step.args = { ...(step.args ?? {}), timeout: capped };
    }

    if (INPUT_ACTIONS.has(step.action)) {
      await pauseTakeoverGuard(tools, ctx?.signal);
    }

    if (step.expectChange && typeof step.expectChange === 'object' && !('watch' in step.expectChange)) {
      const ec = step.expectChange as unknown as Record<string, unknown>;
      const watch: ChangeAssertion['watch'] | undefined =
        typeof ec.selector === 'string' ? { selector: ec.selector }
        : typeof ec.expression === 'string' ? { expression: ec.expression }
        : ec.url === true || ec.watch === 'url' ? 'url'
        : ec.title === true ? 'title'
        : typeof ec.url === 'string' && ec.url === 'url' ? 'url'
        : undefined;
      step.expectChange = watch
        ? { watch, ...(typeof ec.timeoutMs === 'number' ? { timeoutMs: ec.timeoutMs } : {}) }
        : undefined;
    }

    const t0 = Date.now();
    try {
      /* 变化断言的基线必须在动作**之前**取 —— 之后再取就永远"没变" */
      const baseline = step.expectChange
        ? await readSignature(tools, step.expectChange.watch)
        : undefined;
      /* "之后新出现了什么字"也要先取基线 —— 只对会改页面的动作取, 只读动作不花这一眼 */
      const textBefore = INPUT_ACTIONS.has(step.action) ? await readVisibleText(tools) : null;

      let raw = await tool.function(step.args ?? {}, { signal: ctx?.signal } as never);
      let output = typeof raw === 'string' ? raw : JSON.stringify(raw);
      if (step.action === 'navigate' || step.action === 'back' || step.action === 'forward' || step.action === 'reload'
        || output.includes('"navigated":true')) sawNavigation = true;
      let failure = detectStepFailure(raw, output);
      let healed: string | undefined;

      /* ─── 自愈: 主定位失效时试录制时存下的备用定位 ─────────────────────────
       * 只对"找不到元素"这类失败自愈。**其它失败一律不重试** —— 比如点了但页面报错、
       * 表单校验没过, 换个选择器再点一遍只会把同一个错误做两遍, 还可能真的点到别的东西。 */
      if (failure && step.anchors?.length && looksLikeLocatorMiss(failure)) {
        for (const variant of healingVariants(step as RecipeStep)) {
          const r2 = await tool.function(variant, { signal: ctx?.signal } as never);
          const o2 = typeof r2 === 'string' ? r2 : JSON.stringify(r2);
          if (detectStepFailure(r2, o2)) continue;
          healed = `原定位失效, 改用 ${JSON.stringify(variant.selector ?? variant.name ?? variant.text)} 成功`;
          /* 把生效的定位写回这一步 —— 调用方 (回放) 会把它存回 SKILL.md,
           * 否则下一次复跑还要再自愈一遍, 等于每次都白付一次失败的超时。 */
          step.args = variant;
          raw = r2; output = o2; failure = null;
          break;
        }
      }

      /* 这一步"发生了什么": 对话框 / 失败请求 / 新出现的文字 —— 成功失败都带 */
      const happened = await collectStepHappenings(tools, step, raw, t0, textBefore);

      /* 弹了 confirm/prompt 而这一步没给答案 → 我们替它取消了 → 这一步**其实没做成**。
       * 报 ok:true 的话模型会以为删了/填了。只有它明确给了 dialog 答案才按它的意思算。 */
      if (!failure && happened.dialog && happened.dialog.handled === 'dismissed'
        && !(step.args as { dialog?: unknown } | undefined)?.dialog) {
        failure = `页面弹了 ${happened.dialog.type}("${clip(happened.dialog.message, 80)}"), 这一步没给答案, 已替你取消 —— 所以什么也没发生。`
          + ` 要确定/填写的话这一步加 args.dialog: {accept:true${happened.dialog.type === 'prompt' ? ', text:"…"' : ''}} 再来一次。`;
      }

      if (failure) {
        outcomes.push({ index: i, action: step.action, label: step.label, ok: false,
          ms: Date.now() - t0, output: clipStep(step.action, output), error: failure, ...happened });
        if (!step.optional) return finish(false, i);
        continue;
      }

      const navigateArrived = step.action === 'navigate' && (step.expectChange?.watch === 'url' || step.expectChange?.watch === 'title');
      if (step.expectChange && !READ_ONLY_ACTIONS.has(step.action) && !navigateArrived) {
        const verdict = await awaitChange(tools, step.expectChange, baseline, { since: t0, textBefore });
        outcomes.push({ index: i, action: step.action, label: step.label, ok: verdict.changed,
          ms: Date.now() - t0, output: clipStep(step.action, output), healed,
          error: verdict.changed ? undefined : verdict.reason, ...happened });
        if (!verdict.changed && !step.optional) return finish(false, i);
        continue;
      }

      const spent = Date.now() - t0;
      outcomes.push({
        index: i, action: step.action, label: step.label,
        ok: true, ms: spent, output: clipStep(step.action, output), healed, ...happened,
        /* 慢步骤当场点破 —— 不点破的话模型不知道自己哪一步在烧时间, 下次照写。
         * 阈值 1.5s: 正常动作几十~几百毫秒, 超过这个数基本是"等待写错了"。 */
        slowHint: spent > 1500 && !SLOW_BY_NATURE.has(step.action)
          ? `这一步花了 ${(spent / 1000).toFixed(1)}s —— 正常动作只要几十到几百毫秒。`
            + ` 多半是等待条件写得不对 (等了个永远不成立的东西), 或者在 eval 里睡了固定时长。`
            + ` 改用 expectChange 让它一变就走。`
          : undefined,
      });
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      outcomes.push({ index: i, action: step.action, label: step.label, ok: false,
        ms: Date.now() - t0, error });
      if (!step.optional) return finish(false, i);
    }
  }

  return finish(true);

  async function finish(ok: boolean, failedAt?: number, note?: string): Promise<BrowserRunResult> {
    const result: BrowserRunResult = {
      ok,
      ranSteps: outcomes.length,
      totalSteps: steps.length,
      totalMs: Date.now() - startedAt,
      failedAt,
      steps: outcomes,
    };
    if (note && outcomes.length) outcomes[outcomes.length - 1]!.error ??= note;
    /* 失败才收集现场 —— 成功路径一个字节都不多花 */
    await settlePage(tools, { navigated: sawNavigation });
    result.page = await collectPageSnapshot(tools, !ok && args.screenshotOnFailure !== false, startedAt);
    liftImages(result);
    const failed = failedAt !== undefined ? outcomes[failedAt] : undefined;
    if (failed?.appeared && failed.error && result.page?.actionable?.length) {
      const segments = new Set(failed.appeared.split(' | ').map((s) => s.trim()));
      const fresh = result.page.actionable.filter((a) => {
        const label = /"([^"]+)"/.exec(a)?.[1];
        return !!label && segments.has(label);
      }).slice(0, 6);
      if (fresh.length) failed.error += ` 新出现的可点: ${fresh.join(', ')} —— 下一步直接 args:{ref:N}。`;
    }
    /* 录制只在**整段成功**时落盘。存一段半路失败的脚本, 下次复跑只会再失败一次,
     * 而用户会以为自己手里有一个能用的技能。 */
    if (ok && args.record) {
      try {
        const now = new Date().toISOString();
        const recipe: Recipe = {
          name: args.record,
          description: args.recordDescription || args.record,
          createdAt: now, updatedAt: now,
          steps: await Promise.all(steps.map((st) => withAnchors(st, tools))),
        };
        const path = saveRecipe(recipe);
        result.recorded = { name: recipe.name, path, steps: recipe.steps.length };
      } catch (e: any) {
        cliLogger.warn('BROWSER_RUN', `录制存盘失败 (不影响这次执行): ${e?.message}`);
      }
    }
    cliLogger.info('BROWSER_RUN',
      `${ok ? 'ok' : `failed@${failedAt}`} ${outcomes.length}/${steps.length} 步 ${result.totalMs}ms`);
    return result;
  }
}

/**
 * 这条失败是不是"没找到元素"。
 *
 * 判据故意收得很窄: 自愈会**换一个定位再点一次**, 而"点了但业务报错"那类失败重试一遍
 * 是有副作用的 (可能真的点到别的东西, 也可能把同一个提交做两遍)。宁可少救几次,
 * 也不能在不该重试的地方重试。
 */
function looksLikeLocatorMiss(reason: string): boolean {
  return /not found|no element|没找到|找不到|resolved to 0|strict mode violation|Timeout .*exceeded|waiting for locator/i
    .test(reason);
}


type StepHappenings = Pick<StepOutcome, 'dialog' | 'signals' | 'appeared'>;

/** 页面可见文字 (截 20k 字, 够 diff 用)。拿不到就 null —— 那这一步就没有 appeared。 */
async function readVisibleText(tools: Map<string, Tool>): Promise<string | null> {
  const evalTool = tools.get('browser_eval');
  if (!evalTool) return null;
  try {
    const raw = await evalTool.function(
      { expression: '(document.body && document.body.innerText || "").slice(0, 20000)' } as never, {} as never);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return typeof parsed?.result === 'string' ? parsed.result : null;
  } catch { return null; }
}

/**
 * 等页面文字稳下来: 连续两次采样 (间隔 120ms) 一样就算稳, 最多等 maxMs。
 * 用 innerText 长度 + 简单哈希, 一次 eval 亚毫秒级。拿不到 eval 就直接返回。
 */
async function settlePage(tools: Map<string, Tool>, opts: { navigated: boolean }, maxMs = 1500): Promise<void> {
  const evalTool = tools.get('browser_eval');
  if (!evalTool) return;
  /* 签名 = 文字长度:哈希:是否还挂着"加载中"字样 */
  const sig = async (): Promise<{ key: string; loading: boolean } | null> => {
    try {
      const raw = await evalTool.function({ expression:
        '(()=>{const t=(document.body&&document.body.textContent)||"";let h=0;for(let i=0;i<t.length;i++){h=(h*31+t.charCodeAt(i))|0}'
        + 'return t.length+":"+(h>>>0)+":"+(/加载中|正在加载|载入中|loading/i.test(t)?1:0)})()',
      } as never, {} as never);
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (typeof parsed?.result !== 'string') return null;
      return { key: parsed.result, loading: parsed.result.endsWith(':1') };
    } catch { return null; }
  };
  /* 刚导航过的页面常见「先画壳、setTimeout 后再拉数据」—— 靶站就是 200ms。120ms 的静止窗
   * 看不出来, 所以导航后至少观察 450ms; 文字里还挂着"加载中"就继续等到上限。 */
  const started = Date.now();
  const deadline = started + maxMs;
  const minQuiet = opts.navigated ? 450 : 120;
  let prev = await sig();
  if (prev === null) return;
  let quietSince = started;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 120));
    const now = await sig();
    if (now === null) return;
    if (now.key !== prev.key) { quietSince = Date.now(); prev = now; continue; }
    if (!now.loading && Date.now() - quietSince >= minQuiet) return;
  }
}

/** after 里有而 before 里没有的行 —— 就是"新出现的字" */
export function diffAppeared(before: string, after: string, max = 160): string | undefined {
  const seen = new Set(before.split('\n').map((l) => l.trim()).filter(Boolean));
  const fresh: string[] = [];
  for (const line of after.split('\n')) {
    const t = line.trim();
    if (t && !seen.has(t)) { seen.add(t); fresh.push(t); }
  }
  if (!fresh.length) return undefined;
  const joined = fresh.join(' | ');
  return joined.length > max ? joined.slice(0, max - 1) + '…' : joined;
}

/** 这段时间里的失败请求 (HTTP ≥ 400 / 网络失败) 和控制台报错, 一条一行。 */
async function collectSignals(tools: Map<string, Tool>, since: number): Promise<string[]> {
  const signals: string[] = [];
  try {
    const net = tools.get('browser_get_network');
    if (net) {
      const raw2 = await net.function({ since, failedOnly: true, limit: 5 } as never, {} as never);
      const parsed = typeof raw2 === 'string' ? JSON.parse(raw2) : raw2;
      for (const r of (parsed?.requests ?? []) as Array<{ method?: string; url?: string; status?: number; failedReason?: string }>) {
        let path = r.url ?? '';
        try { const u = new URL(path); path = u.pathname + u.search; } catch { /* 不是绝对 URL 就原样 */ }
        /* favicon 404 是每个站都有的噪音, 跟这一步无关 */
        if (/favicon\.ico$/i.test(path)) continue;
        if (r.failedReason && /ERR_ABORTED/.test(r.failedReason)) continue;
        signals.push(r.failedReason
          ? `${r.method ?? ''} ${path} 网络失败: ${r.failedReason}`
          : `HTTP ${r.status} ${r.method ?? ''} ${path}`);
      }
    }
  } catch { /* 没有网络记录就没有这一条 */ }
  try {
    const con = tools.get('browser_get_console_logs');
    if (con) {
      const raw3 = await con.function({ since, level: 'error', limit: 5 } as never, {} as never);
      const parsed = typeof raw3 === 'string' ? JSON.parse(raw3) : raw3;
      for (const l of (parsed?.logs ?? []) as Array<{ text?: string }>) {
        const t = String(l.text ?? '').trim();
        if (!t) continue;
        /* 浏览器对每个 4xx/5xx 都会打一条 "Failed to load resource" —— 网络那条已经说了,
         * 没说的 (favicon) 是刻意滤掉的噪音。这条永远不单独报。 */
        if (/^Failed to load resource/.test(t)) continue;
        signals.push(`console.error: ${clip(t, 160)}`);
      }
    }
  } catch { /* 同上 */ }
  return signals;
}

/**
 * "等的东西没变"时, 页面有没有已经说出原因: 失败请求, 或新冒出来的文字 (确认框/提示)。
 * 有就返回一句可读的解释, 没有返回 null (继续等)。
 */
async function explainStall(
  tools: Map<string, Tool>,
  since: number,
  textBefore: string | null,
): Promise<{ kind: 'request' | 'appeared'; text: string } | null> {
  const signals = await collectSignals(tools, since);
  const bad = signals.find((s) => /^HTTP [45]\d\d|网络失败/.test(s));
  if (bad) {
    return { kind: 'request', text: `等的目标没变, 因为请求被拒了: ${bad}`
      + ' —— 这不是选择器的问题, 是服务端/网络说不行。看 appeared 里页面怎么说, 再决定换条路还是如实回报。' };
  }
  if (textBefore !== null) {
    const after = await readVisibleText(tools);
    const appeared = after !== null ? diffAppeared(textBefore, after, 120) : undefined;
    if (appeared) {
      return { kind: 'appeared', text: `等的目标没变, 但页面出现了新内容: 「${appeared}」`
        + ' —— 多半是弹了确认框/提示, 先处理它 (点确认按钮) 再等原来的变化。' };
    }
  }
  return null;
}

async function collectStepHappenings(
  tools: Map<string, Tool>,
  step: BrowserStep,
  raw: unknown,
  since: number,
  textBefore: string | null,
): Promise<StepHappenings> {
  const out: StepHappenings = {};

  /* ① 对话框: 工具回执里带出来的 (只有会产生输入的动作才可能弹) */
  try {
    const parsed = typeof raw === 'string' ? (raw.trim().startsWith('{') ? JSON.parse(raw) : null) : raw;
    const d = (parsed as { dialog?: { type?: string; message?: string; handled?: string; text?: string } } | null)?.dialog;
    if (d && typeof d.type === 'string' && typeof d.message === 'string') {
      const answered = !!(step.args as { dialog?: unknown } | undefined)?.dialog;
      out.dialog = {
        type: d.type, message: clip(d.message, 200), handled: d.handled ?? '',
        ...(d.text !== undefined ? { text: d.text } : {}),
        ...(answered ? {} : {
          hint: d.type === 'alert'
            ? '这是 alert, 已替你点掉。'
            : `没给答案时 ${d.type} 一律取消。要确定的话在这一步的 args 里加 dialog: {accept:true${d.type === 'prompt' ? ', text:"要填的内容"' : ''}}。`,
        }),
      };
    }
  } catch { /* 回执不是 JSON 就没有对话框信息 */ }

  /* ② 失败请求 + 控制台报错。只看这一步开始之后的。 */
  const signals = await collectSignals(tools, since);
  if (signals.length) out.signals = signals;

  /* ③ 新出现的文字 */
  if (textBefore !== null) {
    const after = await readVisibleText(tools);
    if (after !== null) {
      const appeared = diffAppeared(textBefore, after);
      if (appeared) out.appeared = appeared;
    }
  }
  return out;
}

function detectStepFailure(raw: unknown, output: string): string | null {
  /* 工具经 wrap() 出来的一律是 **JSON 字符串** (`JSON.stringify(result)`), 不是对象 ——
   * 只判对象等于什么都没判。这里先把它解回来。 */
  let envelope: unknown = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('{')) { try { envelope = JSON.parse(t); } catch { envelope = null; } }
    else envelope = null;
  }
  if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
    const env = envelope as {
      ok?: unknown; error?: unknown; success?: unknown; precondition?: unknown; guidance?: unknown;
      message?: unknown; actual?: unknown;
    };
    if (env.ok === false || env.success === false) {
      const why = env.error ?? env.message ?? env.guidance ?? env.precondition;
      const actual = env.actual !== undefined && env.actual !== null && !String(why ?? '').includes(String(env.actual))
        ? ` (实际: ${clip(String(env.actual), 120)})` : '';
      return why ? `${String(why)}${actual}` : `工具返回 ok:false (无原因)${actual}`;
    }
    /* 没有 ok 字段但带 error 的形态也算失败 —— 工具们的信封并不完全统一 */
    if (env.ok === undefined && env.success === undefined && typeof env.error === 'string' && env.error) {
      return env.error;
    }
  }
  return /^(Error|error:|❌|Failed)/.test(output.trim()) ? clip(output) : null;
}

function detectHardSleep(step: BrowserStep): number | null {
  const args = step.args ?? {};
  if (step.action === 'eval') {
    const src = String((args as { expression?: unknown }).expression ?? '');
    const m = /(?:setTimeout|waitForTimeout|sleep|delay)[^)]{0,80}?(\d{3,6})/.exec(src);
    if (m) return Number.parseInt(m[1]!, 10);
    return null;
  }
  if (step.action === 'wait_for') {
    const kind = String((args as { kind?: unknown }).kind ?? '');
    if (kind === 'timeout' || kind === 'sleep' || kind === 'delay') {
      const ms = Number((args as { ms?: unknown; timeout?: unknown }).ms
        ?? (args as { timeout?: unknown }).timeout ?? 0);
      return Number.isFinite(ms) ? ms : null;
    }
  }
  return null;
}

/**
 * 取一次"页面签名"。签名的要求只有一条: **同一页面重复取要稳定, 页面变了要不同**。
 * 取不到 (选择器不存在 / 表达式抛错) 返回 null —— 调用方必须把 null 当**失败**,
 * 不能当"没变": 这两者在诊断时是完全不同的两件事。
 */
async function readSignature(
  tools: Map<string, Tool>,
  watch: ChangeAssertion['watch'],
): Promise<string | null> {
  const evalTool = tools.get('browser_eval');
  if (!evalTool) return null;
  let expr: string;
  if (watch === 'url') expr = 'location.pathname + location.search';
  else if (watch === 'title') expr = 'document.title';
  else if ('selector' in watch) {
    const sel = JSON.stringify(watch.selector);
    expr = `(()=>{const n=[...document.querySelectorAll(${sel})];`
      + `const all=n.slice(0,50).map(e=>(e.innerText||e.value||'')).join('\\u0001');`
      + `let h=0;for(let i=0;i<all.length;i++){h=(h*31+all.charCodeAt(i))|0}`
      + `return n.length+':'+(h>>>0).toString(36)+':'+n.slice(0,3).map(e=>(e.innerText||'').replace(/\\s+/g,' ').slice(0,30)).join('|')})()`;
  } else expr = `(()=>{try{return String(${watch.expression})}catch(e){return '__ERR__'}})()`;

  try {
    const raw = await evalTool.function({ expression: expr } as never, {} as never);
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (text.includes('__ERR__')) return null;
    return text.slice(0, 200);
  } catch {
    return null;
  }
}

/** 轮询等签名变化。轮询在**宿主**这边, 每次 eval 是亚毫秒级, 40ms 一轮完全不心疼。 */
async function awaitChange(
  tools: Map<string, Tool>,
  assertion: ChangeAssertion,
  baseline: string | null | undefined,
  ctx?: { since: number; textBefore: string | null },
): Promise<{ changed: boolean; reason?: string }> {
  if (baseline === null) {
    return { changed: false, reason: '取基线失败: 要观察的目标不存在 (选择器写错? 页面还没渲染?)' };
  }
  const budget = assertion.timeoutMs ?? 8000;
  const started = Date.now();
  let last: string | null = baseline ?? null;
  let nextPeek = started + 600;
  let sawAppeared = false;
  while (Date.now() - started < budget) {
    const now = await readSignature(tools, assertion.watch);
    if (now !== null && now !== baseline) return { changed: true };
    last = now;
    if (ctx && Date.now() >= nextPeek) {
      nextPeek = Date.now() + 600;
      const why = await explainStall(tools, ctx.since, ctx.textBefore);
      /* 请求被拒: 立刻停。新文字: 要连续两次看到且目标仍没变才停 —— 「加载中…」这种
       * 过渡文字之后目标往往会变, 多等一拍 (600ms) 比误判便宜。 */
      if (why?.kind === 'request') return { changed: false, reason: why.text };
      if (why?.kind === 'appeared') {
        if (sawAppeared) return { changed: false, reason: why.text };
        sawAppeared = true;
      } else sawAppeared = false;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  if (typeof assertion.watch === 'object' && 'selector' in assertion.watch
      && String(last ?? '').startsWith('0:')) {
    return {
      changed: false,
      reason: `选择器 ${JSON.stringify(assertion.watch.selector)} 从头到尾没命中任何元素`
        + ' —— 多半是选择器写错了, 或者这个区域还没渲染。先用 query / get_aria_tree 看一眼真实结构。',
    };
  }
  return {
    changed: false,
    reason: `等了 ${budget}ms 没有变化 (仍是 ${JSON.stringify(String(last).slice(0, 60))})`
      + ' —— 动作没生效: 点到的是折叠菜单组(只展开不跳转)? 命中了不可点的元素? 请求失败了?',
  };
}

async function collectPageSnapshot(
  tools: Map<string, Tool>,
  withShot: boolean,
  since?: number,
): Promise<PageSnapshot> {
  const out: PageSnapshot = {};
  if (since !== undefined) {
    try {
      const net = tools.get('browser_get_network');
      if (net) {
        const raw = await net.function({ since, statusGte: 200, statusLte: 299, limit: 30 } as never, {} as never);
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const seen = new Set<string>();
        const apis: string[] = [];
        for (const r of (parsed?.requests ?? []) as Array<{ method?: string; url?: string; status?: number; resourceType?: string }>) {
          if (r.resourceType !== 'fetch' && r.resourceType !== 'xhr') continue;
          let path = r.url ?? '';
          try { const u = new URL(path); path = u.pathname + u.search; } catch { /* 原样 */ }
          if (/\.(js|css|png|jpe?g|gif|svg|woff2?|ico|map)(\?|$)/i.test(path)) continue;
          const line = `${r.method ?? 'GET'} ${path} → ${r.status}`;
          if (seen.has(line)) continue;
          seen.add(line); apis.push(line);
          if (apis.length >= 5) break;
        }
        if (apis.length) out.dataApis = apis;
      }
    } catch { /* 没有网络记录就没有这一条 */ }
  }
  const evalTool = tools.get('browser_eval');
  if (evalTool) {
    try {
      const expr = `(() => {
        const vis = (e) => { const r = e.getBoundingClientRect();
          return r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < innerHeight * 2; };
        const label = (e) => (e.innerText || e.value || e.getAttribute('aria-label')
          || e.getAttribute('placeholder') || e.title || '').replace(/\\s+/g,' ').trim().slice(0, 28);
        /* 上一次快照留下的编号先清掉 —— 留着的话页面变了之后旧号还指着旧元素,
         * 模型照着点就是点错东西 (比"找不到"糟得多)。 */
        document.querySelectorAll('[data-neox-ref]').forEach((e) => e.removeAttribute('data-neox-ref'));
        const items = [...document.querySelectorAll(
          'button,a[href],input,select,textarea,[role=button],[role=link],[role=menuitem],[class*=menu-item]')]
          .filter(vis).slice(0, 40)
          .map((e, i) => { e.setAttribute('data-neox-ref', String(i + 1));
            /* 表格里的按钮带上所在行 (前两格文字) —— 没有它模型只看到一串「关闭」「分配」,
             * 不知道哪个是第 7 行的, 先 eval 读一遍行再点 (2026-09-10 往返分析, 每个列表任务一次)。 */
            const tr = e.closest('tr');
            const cells = tr ? [...tr.children].slice(0, 2).map((c) => (c.innerText || '').replace(/\\s+/g,' ').trim()).filter(Boolean) : [];
            const row = cells.length ? ' @行(' + cells.join(' ').slice(0, 24).replace(/["()]/g, ' ') + ')' : '';
            return i + 1 + ': ' + e.tagName.toLowerCase() + (label(e) ? ' "' + label(e) + '"' : '') + row; });
        /* ─── 页面结构 (2026-09-10 第四刀) ────────────────────────────────
         * 扁平的 actionable 清单说不出"这是一张表、有几行、分几页、筛选器在哪" ——
         * 而这恰恰是写脚本前最要紧的信息。基准里 urgent-page2 (筛选+分页+批量)
         * 四轮都卡在 230 秒不动: 模型看不出这是个列表页, 只能一条一条试。
         *
         * 只给**能直接指导写脚本**的那几样, 不给整棵 DOM —— 给多了又把 token 吃回去。 */
        const sel = (e) => e.id ? '#' + e.id
          : (e.name ? e.tagName.toLowerCase() + '[name="' + e.name + '"]'
            : (e.className && typeof e.className === 'string'
              ? e.tagName.toLowerCase() + '.' + e.className.trim().split(/\\s+/)[0] : e.tagName.toLowerCase()));

        /* 表格: 行数 + 表头 + 每行有哪些操作按钮 (按钮的类名才是能写进脚本的东西) */
        const tables = [...document.querySelectorAll('table')].filter(vis).slice(0, 3).map((t) => {
          const rows = t.querySelectorAll('tbody tr');
          const headers = [...t.querySelectorAll('thead th')].map((h) => h.innerText.trim().slice(0, 12));
          const acts = [...new Set([...(rows[0] ? rows[0].querySelectorAll('button,a[href]') : [])]
            .map((b) => sel(b)))];
          return { sel: sel(t), rows: rows.length, headers,
            rowActions: acts, rowSel: sel(t) + ' tbody tr' };
        });

        /* 分页: 找"上一页/下一页/第 N 页"这类控件, 外加一句人读的页码信息 */
        const pageWords = /上一页|下一页|prev|next|首页|末页|第\\s*\\d+\\s*[\\/页]/i;
        const pagers = [...document.querySelectorAll('button,a[href],[role=button]')].filter(vis)
          .filter((e) => pageWords.test(e.innerText || e.getAttribute('aria-label') || ''))
          .slice(0, 6).map((e) => sel(e) + ' "' + label(e) + '"' + (e.disabled ? ' (禁用)' : ''));
        const pageInfo = [...document.querySelectorAll('span,div,p,li')].filter(vis)
          .map((e) => (e.childElementCount === 0 ? e.innerText || '' : '').trim())
          .find((t) => t && t.length < 40 && /第\\s*\\d+|共\\s*\\d+|\\d+\\s*\\/\\s*\\d+/.test(t));

        /* 筛选/搜索控件: 写脚本时要先动它们, 得知道各自的选择器和当前值 */
        const filters = [...document.querySelectorAll('input:not([type=hidden]),select,textarea')]
          .filter(vis).slice(0, 12).map((e) => {
            const opts = e.tagName === 'SELECT'
              ? ' [' + [...e.options].slice(0, 6).map((o) => o.value || o.text).join('|') + ']' : '';
            return sel(e) + (label(e) ? ' "' + label(e) + '"' : '') + opts
              + (e.value ? ' =' + String(e.value).slice(0, 16) : '');
          });

        return {
          url: location.href,
          title: document.title,
          actionable: items,
          rows: document.querySelectorAll('tbody tr').length,
          tables: tables,
          pagers: pagers,
          pageInfo: pageInfo || '',
          filters: filters,
          digest: (document.body.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 300),
          quiz: (function () {
            ${RADIO_GROUPS_FN}
            var groups = nxRadioGroups();
            var a = groups.filter(function (g) { return g.some(nxChecked); }).length;
            return groups.length >= 3 ? groups.length + '/' + a : '';
          })(),
        };
      })()`;
      const raw = await evalTool.function({ expression: expr } as never, {} as never);
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      /* 工具返回的是包了一层的 JSON 字符串, 挑出我们要的字段即可 —— 解析失败不该
       * 影响主流程, 所以每个字段各自 try。 */
      const pick = (k: string): string | undefined =>
        new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text)?.[1];
      out.url = pick('url');
      out.refHint = '上面这些编号可以直接用: 下一次 browser_run 里写 {action:"click", args:{ref:3}} '
        + '就是点第 3 个, 不用自己拼选择器。编号每次结果都会重发, 用最新的那一份。';
      out.title = pick('title');
      out.digest = pick('digest');
      const quiz = /^(\d+)\/(\d+)$/.exec(pick('quiz') ?? '');
      if (quiz) {
        const total = Number(quiz[1]), done = Number(quiz[2]);
        out.quiz = `这一页有 ${total} 道选择题, 已答 ${done} 道。直接 {action:"choose", args:{}} ——`
          + ' 不用找选择器、不用自己读题, 它会自动识别题目、跳过已答的、逐题滑过去点; 只有它交回的题才需要你看。'
          + (done > 0
            ? ` 已答的 ${done} 道是之前做过的: 要不要核对你来定, 核对用 {action:"choose", args:{recheck:true}} (只报 Jev 不同意的, 不改)。`
            : '');
      }
      const rows = /"rows"\s*:\s*(\d+)/.exec(text)?.[1];
      if (rows) out.rows = Number(rows);

      /* 结构那几段。抠不出来就没有 —— 它是锦上添花, 绝不能让解析失败盖过真正的结果。 */
      const strArr = (k: string): string[] | undefined => {
        const raw = new RegExp(`"${k}"\\s*:\\s*\\[(.*?)\\]`, 's').exec(text)?.[1];
        if (!raw) return undefined;
        const xs = [...raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\"/g, '"'));
        return xs.length ? xs : undefined;
      };
      const tablesRaw = /"tables"\s*:\s*\[(.*?)\]\s*,\s*"pagers"/s.exec(text)?.[1];
      const tables: string[] = [];
      if (tablesRaw) {
        for (const m of tablesRaw.matchAll(/\{(.*?)\}/gs)) {
          const seg = m[1]!;
          const g = (k: string): string => new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(seg)?.[1] ?? '';
          const n = /"rows"\s*:\s*(\d+)/.exec(seg)?.[1] ?? '?';
          const heads = [...(/"headers"\s*:\s*\[(.*?)\]/s.exec(seg)?.[1] ?? '')
            .matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
          const acts = [...(/"rowActions"\s*:\s*\[(.*?)\]/s.exec(seg)?.[1] ?? '')
            .matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
          if (!g('sel')) continue;
          tables.push(`${g('sel')} · ${n} 行`
            + (heads.length ? ` · [${heads.join('|')}]` : '')
            + (acts.length ? ` · 每行操作: ${acts.join(', ')}` : '')
            + ` · 行选择器 ${g('rowSel')}`);
        }
      }
      const pagers = strArr('pagers');
      const pageInfo = pick('pageInfo');
      const filters = strArr('filters');
      const paging = [pageInfo, pagers?.join('  ')].filter(Boolean).join(' · ');
      if (tables.length || paging || filters) {
        out.structure = {
          ...(tables.length ? { tables } : {}),
          ...(paging ? { paging } : {}),
          ...(filters ? { filters } : {}),
        };
      }
      const arr = /"actionable"\s*:\s*\[(.*?)\]/s.exec(text)?.[1];
      if (arr) {
        out.actionable = [...arr.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
          .map((m) => m[1]!.replace(/\\"/g, '"')).slice(0, 40);
      }
    } catch { /* 现状收集失败不该盖过真正的错误 */ }
  }
  if (withShot) {
    try {
      const shot = tools.get('browser_screenshot');
      if (shot) {
        const raw = await shot.function({}, {} as never);
        /* Kept whole: liftImages moves the picture into the image channel. */
        out.screenshot = typeof raw === 'string' ? raw : JSON.stringify(raw);
      }
    } catch { /* 同上 */ }
  }
  return out;
}

async function runRepeat(
  step: BrowserStep,
  tools: Map<string, Tool>,
  ctx: { signal?: AbortSignal } | undefined,
  outOfBudget: () => boolean,
): Promise<{ ok: boolean; summary: string; error?: string }> {
  const body = Array.isArray(step.do) ? step.do : [];
  const until = typeof step.untilGone === 'string' ? step.untilGone.trim() : '';
  if (body.length === 0) return { ok: false, summary: '', error: 'repeat 需要 do: [...] —— 要反复做的那几步' };
  if (!until) return { ok: false, summary: '', error: 'repeat 需要 untilGone: "选择器" —— 做到这个东西一个都不剩为止' };

  const maxRounds = Math.min(Math.max(Number(step.maxRounds) || 20, 1), 50);
  const queryTool = tools.get('browser_query');
  const countLeft = async (): Promise<number> => {
    if (!queryTool) return -1;
    try {
      const raw = await queryTool.function({ selector: until, limit: 1 }, {} as never);
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      return Number(/"count"\s*:\s*(\d+)/.exec(text)?.[1] ?? -1);
    } catch { return -1; }
  };

  let rounds = 0;
  let before = await countLeft();
  const started = before;
  if (before === 0) return { ok: true, summary: `目标一开始就是 0 个, 没什么可做的 (${until})` };

  while (rounds < maxRounds) {
    if (ctx?.signal?.aborted) return { ok: false, summary: `做了 ${rounds} 轮`, error: '用户中断' };
    if (outOfBudget()) return { ok: false, summary: `做了 ${rounds} 轮`, error: '脚本总时限用完' };

    for (const [j, sub] of body.entries()) {
      const name = ACTION_TO_TOOL[sub.action as Exclude<BrowserStep['action'], 'repeat'>];
      const tool = name ? tools.get(name) : undefined;
      if (!tool) return { ok: false, summary: `做了 ${rounds} 轮`, error: `repeat.do 第 ${j + 1} 步是未知动作 "${sub.action}"` };
      let raw: unknown;
      try {
        raw = await tool.function((sub.args ?? {}) as Record<string, unknown>, { signal: ctx?.signal } as never);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (sub.optional) continue;
        return { ok: false, summary: `做了 ${rounds} 轮`, error: `第 ${rounds + 1} 轮的第 ${j + 1} 步抛错: ${clip(msg, 160)}` };
      }
      const out = typeof raw === 'string' ? raw : JSON.stringify(raw);
      const failed = detectStepFailure(raw, out);
      if (failed && !sub.optional) {
        return { ok: false, summary: `做了 ${rounds} 轮`, error: `第 ${rounds + 1} 轮的第 ${j + 1} 步失败: ${clip(failed, 160)}` };
      }
    }
    rounds++;

    let after = await countLeft();
    const settleUntil = Date.now() + 1500;
    while (after >= 0 && before >= 0 && after >= before && Date.now() < settleUntil) {
      await new Promise((r) => setTimeout(r, 100));
      after = await countLeft();
    }
    if (after === 0) return { ok: true, summary: `做了 ${rounds} 轮, ${until} 已经一个不剩 (开始时 ${started} 个)` };
    /* 一轮下来没少 —— 再来一遍也是一样, 停下来让模型换个写法, 别把无效操作重复 20 次 */
    if (after >= 0 && before >= 0 && after >= before) {
      return {
        ok: false,
        summary: `做了 ${rounds} 轮`,
        error: `这一轮之后 ${until} 还是 ${after} 个 (之前 ${before} 个) —— 一轮下来一个都没少, `
          + `说明 do 里那几步没真的改变它。停下来了, 免得把同一个无效操作重复 ${maxRounds} 次。`
          + ` 先看一眼现在的页面 (回执里的 page)。`,
      };
    }
    before = after;
  }
  return {
    ok: true,
    summary: `做满 ${maxRounds} 轮就停了, ${until} 还剩 ${before} 个 (开始时 ${started} 个) —— 还没做完, 可以再来一次`,
  };
}

/* A screenshot's time is spent encoding, choose's on Jev and cursor glides: no waiting to fix. */
const SLOW_BY_NATURE = new Set<string>(['screenshot', 'choose']);

/** Moves every screenshot out of the step outputs (and the failure shot) into result.images. */
function liftImages(result: BrowserRunResult): void {
  const images: NonNullable<BrowserRunResult['images']> = [];
  const lift = (raw: string | undefined, label: string): string | undefined => {
    if (!raw?.startsWith(IMAGE_RESULT_PREFIX)) return undefined;
    const found = parseImageResultImages(raw);
    if (!found) return undefined;
    const first = images.length + 1;
    for (const img of found) images.push({ ...img, label: img.label ? `${label} · ${img.label}` : label });
    return found.length === 1 ? `[截图 → 附图 ${first}]` : `[截图 → 附图 ${first}-${images.length}]`;
  };
  for (const s of result.steps) {
    const note = lift(s.output, `第 ${s.index + 1} 步截图${s.label ? ` (${s.label})` : ''}`);
    if (note) s.output = note;
  }
  if (result.page?.screenshot) {
    result.page.screenshot = lift(result.page.screenshot, '失败时的页面截图') ?? clip(result.page.screenshot, 400);
  }
  if (images.length) result.images = images;
}

function clip(s: string, max = 600): string {
  return s.length <= max ? s : `${s.slice(0, max)}…(${s.length} chars)`;
}

const READ_OUTPUT_ACTIONS = new Set<string>(['eval', 'get_text', 'query', 'get_aria_tree', 'get_console_logs', 'get_network', 'choose']);
const READ_OUTPUT_MAX = 6000;

function clipStep(action: string, s: string): string {
  /* A picture stays whole until liftImages takes it out; clipped, it cannot be decoded. */
  if (s.startsWith(IMAGE_RESULT_PREFIX)) return s;
  if (!READ_OUTPUT_ACTIONS.has(action)) return clip(s);
  if (s.length <= READ_OUTPUT_MAX) return s;
  return `${s.slice(0, READ_OUTPUT_MAX)}…(cut at ${READ_OUTPUT_MAX} of ${s.length} chars — read the rest in a`
    + ` following step, e.g. the next slice of the same list)`;
}

/** 给模型看的工具定义。参数 schema 刻意写得啰嗦 —— 它要照着这个写脚本。 */
export function makeBrowserRunTool(getTools: () => Map<string, Tool>): Tool {
  return {
    name: 'browser_run',
    description:
      'Run a SEQUENCE of browser actions in ONE call. This is the DEFAULT way to drive the browser — '
      + 'calling individual browser_* tools one at a time costs a full model round-trip per action '
      + '(~20s each), while a whole script runs locally in well under a second (measured: 39 actions '
      + 'on a real admin site = 547ms total, 14ms per action). Plan MANY steps ahead. '
      + 'CRITICAL: give every page-changing step an `expectChange` — otherwise "clicked but nothing '
      + 'happened" is reported as success and every later step builds on a false premise. '
      + 'Real failures this catches (measured on a live site): clicking a collapsible MENU GROUP that '
      + 'only expands instead of navigating; waiting on a spinner the page does not have; assertions '
      + 'like `location.pathname.length > 1` that are always true. '
      + 'On failure you get the exact step, the reason, and the page context — earlier steps are NOT re-run. '
      + 'EVERY result (success too) already carries `page`: current url/title, the NUMBERED list of '
      + 'actionable elements, table row count, and a text digest. So do NOT spend another call just to '
      + '"look at the page" — read `page` and put the NEXT batch of steps into your next browser_run. '
      + 'Those numbers are REFS you can use directly: `3: button "Submit"` → next step '
      + '{action:"click", args:{ref:3}}. Prefer refs over hand-written selectors — they point at the '
      + 'exact element you just saw, and a stale one fails loudly instead of clicking the wrong thing. '
      + '`page.structure` gives you the page LAYOUT — tables (row count, headers, per-row action '
      + 'selectors, row selector), paging controls, and filter/search inputs with their current values. '
      + 'Read it BEFORE writing a script for a list page: it tells you the row selector to use with '
      + '`repeat`, and which filter to set instead of paging through everything by hand. '
      + 'Each step result also says WHAT HAPPENED: `dialog` (a native alert/confirm/prompt the action '
      + 'opened and how it was answered — unanswered confirm/prompt is CANCELLED and the step fails; '
      + 'answer it with args.dialog:{accept:true, text:"…"}), `signals` (HTTP >= 400 responses and '
      + 'console errors during the step) and `appeared` (text that newly showed up — toasts, validation '
      + 'messages). Read these before assuming a click "did nothing". '
      + 'THE PATTERN THAT FINISHES IN 3 TURNS: (1) one call with just navigate — its result already '
      + 'waits for the page to settle and gives you refs + structure; (2) ONE call with the whole job, '
      + 'ending with `expect`/`get_text` steps that PROVE the outcome (e.g. the row is gone, the toast '
      + 'says 已关闭); (3) answer. Do not call browser_list_surfaces first (navigate opens the browser), '
      + 'do not add a separate wait_for call after navigate, and do not re-read the page after a script '
      + 'whose final expect passed. '
      + '`page.dataApis` lists the JSON endpoints the page itself fetched (e.g. "GET /api/tickets → 200"): '
      + 'when the job is counting/extracting/summarising a data table, fetch that endpoint inside ONE eval '
      + 'step and compute there instead of paging through the table. '
      + 'That is for DATA tables only. When the task is to USE the page the way a person does — answer '
      + 'questions, fill a form, play, check out — work through the visible page: read what is shown, '
      + 'then click/type on it. Do not fetch the site\'s internal APIs or dig hidden data (answer keys, '
      + 'raw responses) to shortcut it. '
      + 'Multiple-choice questions on the page (quiz, exam, survey; `page.quiz` says so): do NOT read '
      + 'or solve them yourself and do NOT probe the DOM — ONE step {action:"choose", args:{}} finds the '
      + 'questions itself (radio groups), skips answered ones and answers the rest in order with the '
      + 'cursor moving like a person. Only the questions it hands back (low confidence, images) are '
      + 'yours. For a figure, a screenshot step on its `question` selector comes back as an IMAGE '
      + 'you see directly: look, decide, click. No OCR, no sub-agents, no drawing it in text. '
      + 'Questions answered before (a paper done earlier) are left alone and reported; recheck them '
      + 'with {action:"choose", args:{recheck:true}} when it is worth it — it lists where Jev '
      + 'disagrees and you decide. Pass questions/options selectors only when the page has no radio inputs.'
      + ' JSON hygiene: any JS you embed lives inside a JSON string — use SINGLE quotes in the JS '
      + '(\'h1\' not "h1") and keep each expression on ONE line, or the whole call fails to parse.',
    group: 'execute',
    parallelSafety: 'unsafe',
    isReadOnly: false,
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description:
            'Actions in order. Each: {action, args, optional?, label?}. '
            + 'action is a browser_* tool name without the prefix (navigate/click/type/fill_form/'
            + 'press_key/scroll/hover/select_option/wait_for/wait_for_navigation/expect/eval/'
            + 'get_text/query/screenshot/get_aria_tree/back/forward/reload/'
            + 'get_console_logs/get_network/get_bbox/choose); '
            + 'SPECIAL: `repeat` runs `do: [...steps]` over and over until `untilGone` (a selector) '
            + 'matches nothing — THE way to do "close/delete/select every row that ...". '
            + 'A list page re-renders after each action, so writing N clicks up front does not work: '
            + 'act on the FIRST matching row, and let repeat handle the rest. '
            + 'e.g. {action:"repeat", untilGone:"#tbl tbody tr", do:[{action:"click", args:{selector:"#tbl tbody tr:first-child .close"}}]}. '
            + 'It stops early if a round changes nothing, so it cannot spin. '
            + 'args are that tool\'s own arguments. Put wait_for/expect between actions instead of '
            + 'ending the script early — that is the whole point.',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string' },
              args: { type: 'object' },
              expectChange: {
                type: 'object',
                description:
                  'What MUST change after this step. Baseline is captured BEFORE the action, then polled. '
                  + 'watch: "url" | "title" | {selector} (element count + first row text) | {expression} (any JS). '
                  + 'Use it on every click/type/navigate that should change the page. '
                  + 'If the watched target does not exist the step FAILS (not "unchanged") — that distinction '
                  + 'is what tells you "my selector is wrong" apart from "the click did nothing".',
                properties: {
                  watch: { description: '"url" | "title" | {"selector": "..."} | {"expression": "..."}' },
                  timeoutMs: { type: 'number', description: 'default 8000' },
                },
                required: ['watch'],
              },
              optional: { type: 'boolean', description: 'true = failure does not stop the script' },
              label: { type: 'string', description: 'short human label, shown in the timeline' },
            },
            required: ['action'],
          },
        },
        timeoutMs: { type: 'number', description: 'Whole-script budget, default 60000.' },
        screenshotOnFailure: { type: 'boolean', description: 'Attach a screenshot on failure. Default true.' },
        record: {
          type: 'string',
          description:
            'Save this script as a REPLAYABLE skill under this name (only if every step succeeds). '
            + 'Use it whenever the user says this is something they do repeatedly ("every morning", '
            + '"each week", "again tomorrow"). Replaying later costs ZERO tokens — no looking at the '
            + 'page, no writing selectors again. The file is a plain SKILL.md the user can edit.',
        },
        recordDescription: {
          type: 'string',
          description: 'One line describing what the recorded script does. Shown as the skill title.',
        },
      },
      required: ['steps'],
    },
    function: async (a: Record<string, unknown>, c?: { signal?: AbortSignal; sessionId?: string }) => {
      const args = a as unknown as BrowserRunArgs;
      /* One activity for the whole script: every step is its own tool call, and without
       * this the count fell to 0 between steps, so the takeover pill flickered between
       * "working" and "waiting" and the vignette blinked on every step. */
      const res = await getBrowserSession().withActivity(
        'browser_run', undefined, () => runBrowserScript(args, getTools(), c), c?.signal, c?.sessionId,
      );
      const advice = usageAdvice(Array.isArray(args?.steps) ? args.steps.length : 0);
      const { images: _images, ...rest } = res;
      const payload = advice ? { ...rest, usageAdvice: advice } : rest;
      return withBrowserUiMeta('browser_run', args, res, payload);
    },
  } as unknown as Tool;
}

function withBrowserUiMeta(
  tool: string,
  args: BrowserRunArgs,
  res: BrowserRunResult,
  payload: unknown,
): ToolResult {
  const steps = res.steps.map((s) => ({
    action: s.action, label: s.label, ok: s.ok, ms: s.ms,
    error: s.error, healed: s.healed,
    /* 定位参数留一份给卡片显示"点了哪个" —— 步骤本身在 args 里, 结果里没有 */
    args: (args.steps?.[s.index]?.args ?? {}) as Record<string, unknown>,
  }));
  const url = res.page?.url;
  let site = '';
  try { if (url) site = new URL(url).hostname; } catch { /* 不是合法 URL 就不显示站点 */ }

  return createContextualResult(
    tool,
    res.ok ? 'success' : 'error',
    res.ok
      ? `${site || '浏览器'} · ${res.ranSteps}/${res.totalSteps} 步 ${res.totalMs}ms`
      : `${site || '浏览器'} · 第 ${(res.failedAt ?? 0) + 1} 步失败`,
    /* With screenshots the content is an image result whose text is the usual JSON, so the
     * kernel attaches the pictures and the model still reads every step. */
    res.images?.length ? buildImageToolResult(res.images, JSON.stringify(payload)) : JSON.stringify(payload),
    {
      metadata: {
        browser: {
          kind: 'run', site, url, title: res.page?.title,
          steps, totalMs: res.totalMs, ranSteps: res.ranSteps, totalSteps: res.totalSteps,
          screenshot: res.page?.screenshot,
          recorded: res.recorded?.name,
        },
      },
      /* 「这一步没点动」不是故障, 跟 computer_run 同一条理由: 用户帮不上忙, agent
       * 换个做法接着干就是了。异常区据此不弹, 时间线据此不顶红标签。 */
      precondition: !res.ok,
    },
  );
}

/** 复跑一段录好的脚本。跟 browser_run 分开是故意的 —— 它的参数只有一个名字。 */
export function makeBrowserReplayTool(getTools: () => Map<string, Tool>): Tool {
  return {
    name: 'browser_replay',
    description:
      'Replay a browser script that was recorded earlier (browser_run with `record`). '
      + 'Costs ZERO tokens for the page work: no aria tree, no screenshots, no writing selectors — '
      + 'the steps are already known. Use this INSTEAD of rebuilding a script the user has done before. '
      + 'If a selector has rotted, it self-heals from the fallbacks captured at record time and writes '
      + 'the working locator back to the file, so the next replay is clean. '
      + 'Call with no name to list what has been recorded; all:true replays EVERY recording and returns a pass/fail table (a regression run).',
    group: 'execute',
    parallelSafety: 'unsafe',
    isReadOnly: false,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Recorded script name. Omit to list everything recorded. "*" replays ALL of them.' },
        all: { type: 'boolean', description: 'true = replay every recording in sequence and return a pass/fail table (regression run, zero page tokens).' },
        timeoutMs: { type: 'number', description: 'Whole-script budget, default 60000.' },
      },
    },
    function: async (a: Record<string, unknown>, c?: { signal?: AbortSignal; sessionId?: string }) => {
      const name = typeof a?.name === 'string' ? a.name.trim() : '';
      /* 一次跑全部录制 = 回归测试。0 token 做页面工作, 只回一张通过表。 */
      if (a?.all === true || name === '*') {
        const report = await replayAll(getTools(), {
          signal: c?.signal,
          sessionId: c?.sessionId,
          timeoutMs: typeof a?.timeoutMs === 'number' ? a.timeoutMs : undefined,
        });
        return JSON.stringify(report);
      }
      if (!name) {
        const all = listRecipes();
        return JSON.stringify({
          ok: true, recorded: all,
          note: all.length
            ? '调 browser_replay({name}) 复跑其中一个。'
            : '还没有录过。想录: browser_run 里加 record:"名字" —— 只有整段成功才会存下来。',
        });
      }
      const res = await replayRecipe(name, getTools(), {
        signal: c?.signal,
        sessionId: c?.sessionId,
        timeoutMs: typeof a?.timeoutMs === 'number' ? a.timeoutMs : undefined,
      });
      if (!('steps' in res) || !res.images?.length) return JSON.stringify(res);
      const { images, ...rest } = res;
      return buildImageToolResult(images, JSON.stringify(rest));
    },
  } as unknown as Tool;
}

/**
 * 给一步补上备用定位 —— 录制时做一次, 回放时用。
 *
 * 主定位是 selector 的话就去读一次它的可见文字: 选择器最常见的失效方式是**类名变了**
 * (构建出来的 hash 类名、改版换了结构), 而按钮上的字往往一个字没动。反过来也成立,
 * 所以文字定位的步骤把 selector 留着当备选。
 *
 * 读不到就算了 —— 录制不该因为"补不上备选"而失败, 没有备选只是不能自愈而已。
 */
async function withAnchors(step: BrowserStep, tools: Map<string, Tool>): Promise<RecipeStep> {
  const a = (step.args ?? {}) as Record<string, unknown>;
  const anchors: RecipeAnchor[] = [];
  if (typeof a.selector === 'string' && a.selector) {
    const q = tools.get('browser_query');
    if (q) {
      try {
        const raw = await q.function({ selector: a.selector, limit: 1, surfaceId: a.surfaceId }, {} as never);
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const text = String(parsed?.texts?.[0] ?? '').trim();
        /* 太长的整段文字当定位没意义 (会连着一整块内容), 太短的又容易撞车 */
        if (text && text.length <= 40) anchors.push({ text });
      } catch { /* 补不上就没有备选 */ }
    }
  }
  if (typeof a.role === 'string' && typeof a.name === 'string' && a.name) {
    anchors.push({ text: a.name });
  }
  if (typeof a.text === 'string' && a.text && typeof a.selector === 'string') {
    anchors.push({ selector: a.selector });
  }
  return {
    action: step.action, args: step.args, expectChange: step.expectChange,
    optional: step.optional, label: step.label,
    ...(anchors.length ? { anchors } : {}),
  };
}

/**
 * 复跑一段录好的脚本 —— 0 token: 不看页面、不写选择器、不问模型。
 *
 * 自愈生效时会把新的定位**写回 SKILL.md**: 不写回的话下一次复跑还要再自愈一遍,
 * 每次都要先白付一次失败的超时。写回时 healCount +1, 用户能看出这份录制漂得厉害不厉害。
 */
export async function replayRecipe(
  name: string,
  tools: Map<string, Tool>,
  ctx?: { signal?: AbortSignal; sessionId?: string; timeoutMs?: number },
): Promise<BrowserRunResult | { ok: false; error: string; available?: string[] }> {
  const recipe = loadRecipe(name);
  if (!recipe) {
    return {
      ok: false,
      error: `没有叫 "${name}" 的录制 (或者它的 SKILL.md 里那个 ${'```'}neox-browser-recipe 块被改坏了)。`,
      available: listRecipes().map((r) => r.name),
    };
  }
  const before = JSON.stringify(recipe.steps);
  const res = await runBrowserScript(
    { steps: recipe.steps as BrowserStep[], timeoutMs: ctx?.timeoutMs },
    tools, ctx,
  );
  const healed = res.steps.filter((s) => s.healed).length;
  if (healed > 0 && JSON.stringify(recipe.steps) !== before) {
    try {
      recipe.updatedAt = new Date().toISOString();
      recipe.healCount = (recipe.healCount ?? 0) + healed;
      const path = saveRecipe(recipe);
      res.recorded = { name: recipe.name, path, steps: recipe.steps.length, healed };
    } catch {  }
  }
  return res;
}


export interface ReplayRow {
  name: string;
  ok: boolean;
  ms: number;
  steps: number;
  ranSteps: number;
  /** 失败在第几步 (1-based, 给人看) + 原因 */
  failedAt?: number;
  error?: string;
  healed?: number;
  /** 失败时页面的一句话现状 */
  page?: string;
}

export interface ReplayReport {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  totalMs: number;
  rows: ReplayRow[];
}

export async function replayAll(
  tools: Map<string, Tool>,
  ctx?: { signal?: AbortSignal; sessionId?: string; timeoutMs?: number; names?: string[] },
): Promise<ReplayReport> {
  const wanted = ctx?.names?.length ? new Set(ctx.names) : null;
  const all = listRecipes().filter((r) => !wanted || wanted.has(r.name));
  const rows: ReplayRow[] = [];
  const t0 = Date.now();
  for (const r of all) {
    if (ctx?.signal?.aborted) break;
    const started = Date.now();
    const res = await replayRecipe(r.name, tools, { signal: ctx?.signal, sessionId: ctx?.sessionId, timeoutMs: ctx?.timeoutMs });
    if ('steps' in res) {
      const failed = res.failedAt !== undefined ? res.steps[res.failedAt] : undefined;
      rows.push({
        name: r.name, ok: res.ok, ms: res.totalMs, steps: res.totalSteps, ranSteps: res.ranSteps,
        ...(res.failedAt !== undefined ? { failedAt: res.failedAt + 1 } : {}),
        ...(failed?.error ? { error: clip(failed.error, 200) } : {}),
        ...(res.recorded?.healed ? { healed: res.recorded.healed } : {}),
        ...(!res.ok && res.page?.digest ? { page: clip(res.page.digest, 120) } : {}),
      });
    } else {
      rows.push({ name: r.name, ok: false, ms: Date.now() - started, steps: r.steps, ranSteps: 0, error: res.error });
    }
  }
  const passed = rows.filter((x) => x.ok).length;
  return { ok: passed === rows.length, total: rows.length, passed, failed: rows.length - passed, totalMs: Date.now() - t0, rows };
}
