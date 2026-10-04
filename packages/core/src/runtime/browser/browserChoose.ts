/**
 * browser_choose — answer on-page multiple-choice questions one by one, the way a person does:
 * scroll to the question, read it, move the mouse to the option, click, next.
 *
 * Why Jev and not the main model: picking one option from a short list is a classification,
 * which Jev answers in well under a second with a confidence. The main model instead scrapes
 * every question into one eval, the output gets cut, and it starts hunting the site's APIs.
 * Here all questions go to Jev in parallel, then the clicks happen in order with the cursor
 * gliding between them. Anything below minConfidence is left unanswered and handed back to the
 * main model with its text, so hard questions still get real reasoning.
 */
import { getBrowserManager } from './browserManager.js';
import { moveAgentCursor } from './browserTakeoverController.js';
import { TAKEOVER_GUARD_PAUSE_EXPR } from './agentTakeoverBanner.js';
import { askJev, readJevSettings } from '../jev/jevClient.js';

export interface BrowserChooseArgs {
  surfaceId?: string;
  /** Selector matching every question container. Omit both selectors to auto-detect radio groups. */
  questions?: string;
  /** Selector, inside one question, matching its options in order. */
  options?: string;
  /** Picks below this are not clicked and come back for the main model. Default 0.6. */
  minConfidence?: number;
  /** At most this many questions this call (from the first match). Default all, cap 150. */
  limit?: number;
  /** Selector of shared material (e.g. a reading passage) prepended to every question. */
  context?: string;
  /** Also run Jev over questions already answered and report where it disagrees. Changes nothing. */
  recheck?: boolean;
}

/** `cur` = the option picked on the page now (-1 = unanswered). */
interface Item { index: number; stem: string; options: string[]; images: number; cur: number }
interface Picked extends Item { pick?: number; confidence?: number; error?: string }

/**
 * In-page function (plain JS, no regex so it embeds anywhere) returning the page's radio groups,
 * each an array of radio elements in order. A group is one question:
 *   · inputs sharing a name;
 *   · unnamed inputs (common on Angular / React pages): the nearest ancestor holding two or
 *     more radios, i.e. the option list;
 *   · [role=radio] without an input inside: its radiogroup, else the same ancestor rule.
 * Also used by browser_run's page snapshot, so `page.quiz` counts what choose will find.
 */
export const RADIO_GROUPS_FN = `function nxRadioGroups() {
  var SEL = 'input[type=radio], [role=radio]';
  var groups = [], keys = [];
  document.querySelectorAll(SEL).forEach(function (r) {
    if (r.tagName !== 'INPUT' && r.querySelector('input[type=radio]')) return;
    var key;
    if (r.tagName === 'INPUT' && r.name) key = 'name:' + r.name;
    else {
      key = r.closest('[role=radiogroup]');
      if (!key) {
        var c = r.parentElement;
        while (c && c.querySelectorAll(SEL).length < 2) c = c.parentElement;
        key = c || r;
      }
    }
    var at = keys.indexOf(key);
    if (at < 0) { at = keys.length; keys.push(key); groups.push([]); }
    groups[at].push(r);
  });
  return groups.filter(function (g) { return g.length >= 2; });
}
function nxChecked(r) { return r.checked === true || r.getAttribute('aria-checked') === 'true'; }`;

/* Auto mode: every radio group is one question. The option is the clickable row around the
 * radio (label / li / role=radio); the question is the nearest ancestor that also holds the
 * stem, never one that reaches into another group. Answered groups are skipped so a half-done
 * paper resumes; with recheck they are tagged too. Tags the page with data-nx-q / data-nx-o
 * for the locators below. */
const AUTO_TAG = (recheck: boolean): string => `(() => {
  ${RADIO_GROUPS_FN}
  document.querySelectorAll('[data-nx-q]').forEach(function (e) { e.removeAttribute('data-nx-q'); });
  document.querySelectorAll('[data-nx-o]').forEach(function (e) { e.removeAttribute('data-nx-o'); });
  var groups = nxRadioGroups();
  var all = [];
  groups.forEach(function (g) { g.forEach(function (r) { all.push(r); }); });
  function optionOf(r) {
    return r.closest('label, li, [role=radio]')
      || (r.id && document.querySelector('label[for="' + CSS.escape(r.id) + '"]'))
      || r.parentElement;
  }
  function foreign(el, group) {
    return all.some(function (x) { return group.indexOf(x) < 0 && el.contains(x); });
  }
  var q = 0, answered = 0;
  groups.forEach(function (group) {
    var cur = -1;
    group.forEach(function (r, i) { if (cur < 0 && nxChecked(r)) cur = i; });
    if (cur >= 0) { answered++; if (!${recheck}) return; }
    var opts = group.map(optionOf);
    var c = opts[0].parentElement;
    while (c && !opts.every(function (o) { return c.contains(o); })) c = c.parentElement;
    if (!c) return;
    var optLen = opts.reduce(function (s, o) { return s + (o.innerText || '').length; }, 0);
    for (var k = 0; k < 6 && c.parentElement && (c.innerText || '').length < optLen + 6 && !foreign(c.parentElement, group); k++) c = c.parentElement;
    c.setAttribute('data-nx-q', String(q++));
    opts.forEach(function (o) { o.setAttribute('data-nx-o', ''); });
  });
  return q + '/' + answered;
})()`;

/** "12. 单选题 …" → "12"; falls back to the position among this call's questions. */
function label(it: Item): string {
  return /^\s*(\d{1,3})[.、．\s]/.exec(it.stem)?.[1] ?? `#${it.index + 1}`;
}

const JEV_CONCURRENCY = 8;
const LETTERS = 'ABCDEFGHIJ';

const IMAGE_QUESTION = '题目或选项是图片, Jev 看不到。用 screenshot 截 question 这个选择器 —— 截图会作为图片直接给你看, 看图作答后点 options 里对应的那项。';

async function pickOne(it: Picked, settings: NonNullable<ReturnType<typeof readJevSettings>>, contextText: string, signal?: AbortSignal): Promise<Picked> {
  if (it.options.length < 2) { it.error = 'fewer than two options found'; return it; }
  /* Jev reads text only. A figure in the stem, or options that are just letters (the
   * choices are pictures), would be a blind guess: hand these back instead. */
  if (it.images > 0 || it.options.every(o => o.replace(/^[A-J][.、．:：]?\s*/, '').trim().length === 0)) {
    it.error = IMAGE_QUESTION; return it;
  }
  const keys = it.options.slice(0, LETTERS.length).map((_, i) => LETTERS[i]);
  const criteria = Object.fromEntries(keys.map((k, i) => [k, `${k}. ${it.options[i]}`]));
  const state = (contextText ? `材料：\n${contextText}\n\n` : '') + `题目：\n${it.stem}`;
  try {
    const r = await askJev(settings, state, {
      q: { type: 'choice', instructions: '这道单选题的正确答案是哪一项？', criteria },
    }, { timeoutMs: 6000, signal });
    const a = r.answers.q as any;
    if (a?.type === 'choice' || a?.choice) {
      it.pick = keys.indexOf(String(a.choice));
      it.confidence = Number(a.confidence ?? 0);
      if (it.pick < 0) it.error = `unexpected pick ${a.choice}`;
    } else {
      it.error = 'no answer';
    }
  } catch (err: any) {
    it.error = err?.message ?? String(err);
  }
  return it;
}

/**
 * Starts Jev on every item, JEV_CONCURRENCY at a time in list order, and returns one promise per
 * item. The clicker awaits them in order, so the first question is clicked as soon as its own
 * pick is back instead of after every pick on the page.
 */
function startPicks(items: Item[], contextText: string, signal?: AbortSignal): Array<Promise<Picked>> {
  const settings = readJevSettings()!;
  const resolvers: Array<(p: Picked) => void> = [];
  const promises = items.map(() => new Promise<Picked>(r => { resolvers.push(r); }));
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      const it: Picked = { ...items[i] };
      if (signal?.aborted) { it.error = 'aborted'; resolvers[i](it); continue; }
      resolvers[i](await pickOne(it, settings, contextText, signal));
    }
  }
  for (let w = 0; w < Math.min(JEV_CONCURRENCY, items.length); w++) void worker();
  return promises;
}

export async function browserChoose(args: BrowserChooseArgs & { surfaceId: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!readJevSettings()) {
    return { ok: false, error: 'Jev 没开 (设置 › 实验功能)。改为自己读题, 用 click 逐题作答。' };
  }
  const t0 = Date.now();
  const page = await getBrowserManager().resolvePage(args.surfaceId);
  if (!page) return { ok: false, error: '浏览器页面不存在' };
  const auto = !args.questions || !args.options;
  const recheck = args.recheck === true;
  /* Without recheck, auto mode does not tag answered questions, so count them from the tagger. */
  let untaggedDone = 0;
  if (auto) {
    const tagged = String(await page.evaluate(AUTO_TAG(recheck)).catch(() => '0/0'));
    const done = Number(tagged.split('/')[1] ?? 0);
    if (!recheck) untaggedDone = done;
    if (tagged.startsWith('0/')) {
      return done
        ? { ok: true, total: done, answered: 0, note: `这一页 ${done} 道单选题都已经答过了。要核对就 {action:"choose", args:{recheck:true}}。` }
        : { ok: false, error: '没认出题目 (页面上没有成组的单选框)。传 questions / options 两个选择器再试。' };
    }
  }
  const questionsSel = auto ? '[data-nx-q]' : args.questions!;
  const optionsSel = auto ? '[data-nx-o]' : args.options!;
  const qs = page.locator(questionsSel);
  if (!(await qs.count())) return { ok: false, error: `questions 选择器 "${questionsSel}" 一道题都没匹配到` };
  const minConfidence = Math.min(1, Math.max(0, args.minConfidence ?? 0.6));

  /* These run in the page; core has no DOM lib, hence the `any`. `cur` works for any markup:
   * the option that is, or holds, a checked radio. */
  const read: Array<Omit<Item, 'index'>> = await qs.evaluateAll((els: any[], optSel: any) => els.map((el: any) => {
    const opts: any[] = Array.from(el.querySelectorAll(optSel));
    const on = (o: any) => o.matches(':checked, [aria-checked=true]') || !!o.querySelector(':checked, [aria-checked=true]');
    return {
      stem: (el.innerText || '').trim().slice(0, 4000),
      options: opts.map((o: any) => (o.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400)),
      images: el.querySelectorAll('img, svg image, canvas').length,
      cur: opts.findIndex(on),
    };
  }), optionsSel);
  const all: Item[] = read.map((r, index) => ({ index, ...r }));
  const open = all.filter(it => it.cur < 0);
  const done = all.filter(it => it.cur >= 0);
  const count = Math.min(open.length, Math.max(0, Math.floor(args.limit ?? open.length)), 150);
  const toAnswer = open.slice(0, count);
  const toCheck = recheck ? done.slice(0, 150) : [];
  const contextText = args.context
    ? ((await page.locator(args.context).first().innerText({ timeout: 1500 }).catch(() => '')) || '').slice(0, 8000)
    : '';

  /* Answers first: they gate the clicks. The recheck picks run behind them. */
  const pending = startPicks([...toAnswer, ...toCheck], contextText, signal);

  const answered: string[] = [];
  const handBack: Picked[] = [];
  for (let n = 0; n < toAnswer.length; n++) {
    if (signal?.aborted) break;
    const it = await pending[n];
    if (it.pick === undefined || it.pick < 0 || (it.confidence ?? 0) < minConfidence) { handBack.push(it); continue; }
    const option = qs.nth(it.index).locator(optionsSel).nth(it.pick);
    /* Scroll like a person: smooth, question centred, then let it settle before moving. */
    const scrolled = await option.evaluate((el: any) => {
      const r = el.getBoundingClientRect();
      if (r.top >= 60 && r.bottom <= (globalThis as any).innerHeight - 90) return false;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    }).catch(() => false);
    /* A smooth scroll runs for a variable time; reading the box while it still moves clicks the
     * neighbouring option. Wait until two reads agree. */
    let box = await option.boundingBox({ timeout: 800 }).catch(() => null);
    if (scrolled) {
      for (let i = 0; i < 20 && box; i++) {
        await new Promise(r => setTimeout(r, 60));
        const again = await option.boundingBox({ timeout: 800 }).catch(() => null);
        const settled = !!again && Math.abs(again.y - box.y) < 1 && Math.abs(again.x - box.x) < 1;
        box = again;
        if (settled) break;
      }
    }
    if (!box) { handBack.push({ ...it, error: 'option not on the page' }); continue; }
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    await page.evaluate(TAKEOVER_GUARD_PAUSE_EXPR(3000)).catch(() => {});
    await moveAgentCursor(page, x, y, true);
    await page.mouse.click(x, y);
    await moveAgentCursor(page, x, y);
    answered.push(`${label(it)}${LETTERS[it.pick]}`);
    await new Promise(r => setTimeout(r, 40));
  }

  /* Recheck reports, it never changes an answer: the model (or the person) decides. */
  const checked = await Promise.all(pending.slice(toAnswer.length));
  const disagree = checked.filter(it => it.pick !== undefined && it.pick >= 0 && it.pick !== it.cur && (it.confidence ?? 0) >= minConfidence);
  const cannotCheck = checked.filter(it => it.pick === undefined || it.pick < 0);

  const doneCount = done.length + untaggedDone;
  return {
    ok: true,
    total: all.length + untaggedDone,
    ...(doneCount ? {
      alreadyAnswered: doneCount,
      ...(recheck ? {} : { history: `有 ${doneCount} 道之前就答过了 (多半是上次做的), 这次没动。想核对: {action:"choose", args:{recheck:true}} —— Jev 把它们重判一遍, 列出跟现有答案不一致的, 改不改你定。` }),
    } : {}),
    attempted: toAnswer.length,
    answered: answered.length,
    picks: answered.join(' '),
    ...(recheck ? {
      recheck: {
        checked: checked.length,
        agree: checked.length - disagree.length - cannotCheck.length,
        /* Jev is confident and differs from what is on the page. Not proof either way: read the
         * question, and if Jev is right click `options >> nth=<0-based>`. */
        disagree: disagree.slice(0, 12).map(it => ({
          no: label(it),
          now: LETTERS[it.cur],
          jev: LETTERS[it.pick!],
          confidence: Number((it.confidence ?? 0).toFixed(2)),
          options: `${questionsSel} >> nth=${it.index} >> ${optionsSel}`,
          stem: it.stem.slice(0, 200),
          choices: it.options.map((o, i) => `${LETTERS[i]}. ${o.slice(0, 60)}`),
        })),
        ...(disagree.length > 12 ? { alsoDisagree: disagree.slice(12).map(label) } : {}),
        ...(cannotCheck.length ? { cannotCheck: cannotCheck.map(label).join(' '), cannotCheckWhy: '带图或选项读不出, Jev 判不了; 要核对就截图自己看' } : {}),
      },
    } : {}),
    /* The main model's part: read these and answer them with click. Kept short so the result
     * fits the step budget; the rest are listed by number only. `question` and `options` are
     * ready-made selectors: screenshot the first, click `${options} >> nth=<0-based>`. */
    handBack: handBack.slice(0, 8).map(it => ({
      no: label(it),
      question: `${questionsSel} >> nth=${it.index}`,
      options: `${questionsSel} >> nth=${it.index} >> ${optionsSel}`,
      stem: it.stem.slice(0, 300),
      choices: it.options.map((o, i) => `${LETTERS[i]}. ${o.slice(0, 80)}`),
      ...(it.pick !== undefined && it.pick >= 0 ? { jevGuess: LETTERS[it.pick], confidence: Number((it.confidence ?? 0).toFixed(2)) } : {}),
      ...(it.error ? { error: it.error } : {}),
    })),
    ...(handBack.length > 8 ? { alsoUnanswered: handBack.slice(8).map(label) } : {}),
    ms: Date.now() - t0,
  };
}
