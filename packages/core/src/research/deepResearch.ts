
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { createContextualResult, createSummarizedResult } from '@neoxlabs/kernel/core/types/toolResult.js';
import fs from 'fs/promises';
import path from 'path';
import type { ExploreProviderInfo } from '../runtime/agent/exploreModelPolicy.js';
import { createLedger, loadLedger, saveLedger, ledgerStats, researchDir, type ResearchLedger } from './ledger.js';
import { synthesizeNarrative } from './synthesis.js';
import { renderReportMarkdown } from './report.js';
import { buildWorkerPrompt } from './prompts.js';
import { resolveResearchModels, describeModelPlan } from './models.js';
import { buildCardPayload } from './cardPayload.js';
import { registerDeepResearch, getActiveDeepResearch, researchRanThisTurn, markResearchRanThisTurn } from './activeRuns.js';

export const MAX_FOLLOW_UPS_PER_WORKER = 1;

/** 一轮最多几个起始角度 —— 模型一次塞 12 个角度进来, 规模档就形同虚设 */
export const MAX_SEEDS: Record<ScaleName, number> = { simple: 2, compare: 5, deep: 7 };
/* 开跑前探一次搜索能不能用 —— 调研完全依赖它, 搜不了就别开跑 (见下面 step 0 的注释) */
import { webSearch } from '../tools/webTools.js';
import {
  runSlidingWindow, SCALE_PRESETS,
  type ScaleName, type SubQuestion, type WorkerOutcome, type SchedulerLimits,
} from './scheduler.js';

export interface DeepResearchDeps {
  workDir: string;
  /** 派子 agent 用的工具本体 (跟 do_online_task 同一个路子) */
  agentTool: Tool;
  /** 当前会话跑在哪 —— leader 就是它 */
  sessionProviderId: string;
  sessionModelName: string;
  /** 子 agent 并发硬上限 (backgroundAgent 的那道闸, 超了会直接派不出去) */
  getMaxConcurrentAgents: () => number;
  abortSignal?: AbortSignal;
  /** 当前会话 —— 登记进 activeRuns, 让 list_agents 看得见、stop_agent 停得了 */
  sessionId?: string;
  onTaskAgentEvent?: (agentId: string, event: Record<string, unknown>) => void;
  /** 测试注入; 不传就调用时现查 ProviderStore */
  lookupProvider?: (providerId: string) => { provider: ExploreProviderInfo | null; apiKey?: string };
  /**
   * 开跑前探一次"这条渠道能不能联网搜" —— 不传就真调一次 web_search。
   * 单测必须注入桩, 否则每个用例都会打真网络。
   */
  searchProbe?: () => Promise<{ ok: boolean; error?: string }>;
}

/**
 * 查当前 provider 的模型清单和 key —— **调用时现查, 不在建工具时定死**。
 *
 * 理由跟 getTaskAgentRoute 那条注释同源: 工具随 host 建、host 按 sessionId 缓存复用,
 * 建工具时取值的话, 用户会话中途换了 provider, 本会话直到重开都还在按旧的算模型。
 *
 * apiKey 只用于判"是不是订阅"(=== 'neox-managed'), 不外传、不入日志。
 * ProviderStore.getProviders() 出口已经 unwrap 过, 这里不需要自己解密。
 */
async function lookupProviderInfo(providerId: string): Promise<{ provider: ExploreProviderInfo | null; apiKey?: string }> {
  try {
    const { ProviderStore } = await import('@neoxlabs/platform/utils/providerStore.js');
    const entry = new ProviderStore().getProvider(providerId);
    if (!entry) return { provider: null };
    return { provider: { models: entry.models ?? [], protocol: entry.protocol, baseUrl: entry.baseUrl }, apiKey: entry.apiKey };
  } catch {
    /* 查不到就按 BYOK 走 (默认全用当前模型) —— 比猜成订阅去降级安全 */
    return { provider: null };
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * worker 回传的解析
 * ══════════════════════════════════════════════════════════════════════════ */

interface WorkerReply {
  summary: string;
  followUps: Array<{ question: string; why: string }>;
}

/**
 * worker 被要求回严格 JSON, 但模型经常在外面裹一层话或 ``` 围栏。
 * 这里尽力抠出那个对象; **抠不出来不算失败** —— 证据已经写进账本了,
 * 丢掉的只是"新线索"这一条增量, 拿原文当 summary 继续走。
 */
function parseWorkerReply(raw: string): WorkerReply {
  const text = String(raw ?? '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const obj = JSON.parse(c.slice(start, end + 1));
      const followUps = Array.isArray(obj?.followUps)
        ? obj.followUps
          .filter((f: any) => f && typeof f.question === 'string' && f.question.trim())
          .map((f: any) => ({ question: String(f.question).trim(), why: String(f.why ?? '').trim() }))
        : [];
      const summary = typeof obj?.summary === 'string' && obj.summary.trim()
        ? obj.summary.trim()
        : text.slice(0, 300);
      return { summary, followUps };
    } catch { /* 换下一个候选 */ }
  }
  return { summary: text.slice(0, 300), followUps: [] };
}

/** agentTool 前台成功返回的是**纯文本**; 失败是 `[ERROR] …`; 转后台/撞重复派发闸是 JSON。 */
/**
 * 收尾归纳那个子 agent 的描述 —— **每次调用都不一样**。
 *
 * 重复派发闸 (findDuplicateRunning) 只认归一化后完全相同的 description/prompt。
 * 归纳的描述如果是个固定词, 同一会话里只要有一个旧的归纳 agent 还挂着 (上游请求
 * 挂起时它能挂很久), 后面每一轮的归纳都会被判成重复而根本派不出去。
 */
export function synthesisAgentDescription(slug: string): string {
  const topic = String(slug ?? '').slice(0, 24);
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `汇总调研结论: ${topic} · ${token}`;
}

function readAgentResult(raw: unknown): { ok: boolean; text: string; error?: string } {
  const s = String(raw ?? '');
  if (s.startsWith('[ERROR]')) return { ok: false, text: '', error: s.slice(7).trim() };
  if (s.trimStart().startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      /* auto_backgrounded / already_running: 结果拿不到了, 算这条没查成 */
      if (obj?.status && obj.status !== 'success') {
        return { ok: false, text: '', error: `子 agent 未同步返回 (${obj.status})` };
      }
    } catch { /* 不是 JSON, 当正文 */ }
  }
  return { ok: true, text: s };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 工具
 * ══════════════════════════════════════════════════════════════════════════ */

const SCALE_NAMES: ScaleName[] = ['simple', 'compare', 'deep'];

export function createDeepResearchTool(deps: DeepResearchDeps): Tool {
  return {
    name: 'deep_research',
    /* 跟外部网络和多个子 agent, 时间预算最长 25 分钟 —— 给足余量 */
    timeoutMs: 40 * 60_000,
    description: `Run a multi-angle web investigation and produce an evidence-backed report.

Parallel research workers each take one angle, and every conclusion they record must carry a VERBATIM quote that is checked literally against the archived page — a quote that cannot be found is rejected, so the report cannot contain invented citations. Sources that disagree are kept side by side as "disputed" rather than silently resolved.

Use it for: comparisons and selection decisions, prior-art surveys, "what is the current state of X", anything where being wrong is expensive. Do NOT use it for a single fact you can settle with one web_search.

YOU decompose the topic — pass the angles in \`questions\`:
- Non-overlapping. Two workers must not come back with the same pages.
- Each concrete about what to find and what counts as finding it. Not "look into X".
- For an A-vs-B comparison, split by DIMENSION, not by object — splitting by object makes each side get measured by a different yardstick.
- Fewer is better. One angle that can be answered is worth three that cannot.

Follow-up angles found mid-flight are queued automatically; you do not need to预留 them.`,
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'The overall research question, one sentence' },
        questions: {
          type: 'array',
          description: 'Non-overlapping angles, one per worker',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'What this worker should find out' },
              why: { type: 'string', description: 'Why it matters — goes into the worker prompt' },
            },
            required: ['question'],
          },
        },
        scale: {
          type: 'string',
          enum: SCALE_NAMES,
          description: 'simple = settle one fact · compare = weigh a few options · deep = open-ended dig. Controls concurrency, worker budget, follow-up depth and wall-clock. Default: compare.',
        },
        worker_model: {
          type: 'string',
          description: 'Optional: force the worker model. Omit to use the default policy (subscription downgrades to the same-family fast model; BYOK keeps your current model).',
        },
      },
      required: ['topic', 'questions'],
    },
    async function(args: any, context?: { signal?: AbortSignal }) {
      const topic = String(args?.topic || '').trim();
      const rawQuestions: any[] = Array.isArray(args?.questions) ? args.questions : [];
      const scale: ScaleName = SCALE_NAMES.includes(args?.scale) ? args.scale : 'compare';

      if (!topic) {
        return JSON.stringify(createSummarizedResult('deep_research', 'error', '没有给题目', {
          error: 'topic 是空的。', precondition: true,
        }));
      }
      if (deps.sessionId) {
        const running = getActiveDeepResearch(deps.sessionId);
        if (running) {
          return JSON.stringify(createSummarizedResult('deep_research', 'error', '已经有一轮调研在跑', {
            error: `「${running.topic}」这一轮还没结束, 不能再开一轮。等它回来, 用它的报告回答用户。`, precondition: true,
          }));
        }
        const done = researchRanThisTurn(deps.sessionId);
        if (done) {
          return JSON.stringify(createSummarizedResult('deep_research', 'error', '这句话已经调研过一轮', {
            error: `本轮已经调研过「${done.topic}」, 报告在 ${done.reportPath}。\n`
              + '直接读报告回答用户, 不要再开一轮, 也不要改派 agent / explore 去补查。'
              + '没查到的部分如实告诉用户; 用户要继续深挖, 会在下一句话里说。',
            precondition: true,
          }));
        }
      }

      const allSeeds: SubQuestion[] = rawQuestions
        .map((q: any, i: number) => ({
          id: `Q${i + 1}`,
          question: String(q?.question || '').trim(),
          why: String(q?.why || '').trim() || undefined,
          depth: 0,
        }))
        .filter((q) => q.question);
      if (allSeeds.length === 0) {
        return JSON.stringify(createSummarizedResult('deep_research', 'error', '没有给角度', {
          error: 'questions 是空的 —— 先把题目拆成几个互不重叠的角度再调这个工具。', precondition: true,
        }));
      }
      /* 角度按档封顶, 多出来的不查 (回执里说明) —— 否则规模档只管得住追问, 管不住开局 */
      const seeds = allSeeds.slice(0, MAX_SEEDS[scale]);
      const droppedSeeds = allSeeds.slice(seeds.length);

      const probe = deps.searchProbe
        ? await deps.searchProbe()
        : await (async () => {
          const raw = JSON.parse(String(await (webSearch.function as any)({ query: topic, max_results: 3 }, {})));
          return { ok: raw?.status !== 'error', error: String(raw?.error ?? raw?.summary ?? '') };
        })();
      if (!probe.ok) {
        return JSON.stringify(createSummarizedResult('deep_research', 'error', '这条渠道搜不了网, 调研没法开始', {
          error: `深度调研完全依赖联网搜索, 而当前渠道搜不了:\n${probe.error ?? ''}\n\n`
            + '两条路任选一条 (告诉用户, 不要自己改用猜 URL + web_fetch —— 实测那样十分钟也查不到东西):\n'
            + '· 换一个自带搜索的渠道 (DeepSeek 官方 / Claude / GPT / Grok / Kimi / NeoxCloud 订阅)\n'
            + '· 或在 设置 → 工具 → 联网搜索 里配「博查 Bocha」或「Serper」的 Key —— 配了之后所有渠道都能搜',
          precondition: true,
        }));
      }

      const ledger = await createLedger(deps.workDir, topic);
      const reportPath = path.join(researchDir(deps.workDir, ledger.slug), 'report.md');
      /* 真开跑了才记 (搜索探测失败那种没花钱的不算) —— 中断 / 失败也算跑过一轮 */
      if (deps.sessionId) markResearchRanThisTurn(deps.sessionId, { topic, reportPath });

      /* 2. 模型 */
      const pinfo = deps.lookupProvider
        ? deps.lookupProvider(deps.sessionProviderId)
        : await lookupProviderInfo(deps.sessionProviderId);
      const plan = resolveResearchModels({
        sessionProviderId: deps.sessionProviderId,
        sessionModelName: deps.sessionModelName,
        provider: pinfo.provider,
        providerApiKey: pinfo.apiKey,
        overrideWorkerModelName: String(args?.worker_model || '').trim() || undefined,
        overrideWorkerProviderId: String(args?.worker_model || '').trim() ? deps.sessionProviderId : undefined,
      });

      /* 3. 并发夹在子 agent 硬闸之下 —— 超了 agentTool 会直接拒派, 那是白白浪费一格 */
      const preset = SCALE_PRESETS[scale];
      const hardCap = Math.max(1, deps.getMaxConcurrentAgents());
      const limits: SchedulerLimits = { ...preset, concurrency: Math.min(preset.concurrency, hardCap) };

      /* 4. 滑动窗口 */
      const harvested: string[] = [];
      /* 最近一次从账本读到的统计 —— onOutcome 是同步的, 不在那里再读盘 */
      let latestStats = ledgerStats(ledger);

      const angleById = new Map<string, string>();
      const angleOf = (sub: { id: string; question: string; parentId?: string }): string => {
        const inherited = sub.parentId ? angleById.get(sub.parentId) : undefined;
        const angle = inherited ?? sub.question;
        angleById.set(sub.id, angle);
        return angle;
      };

      type WorkerView = { id: string; question: string; status: 'queued' | 'running' | 'done' | 'failed'; summary?: string };
      const workerViews = new Map<string, WorkerView>();
      for (const s of seeds) workerViews.set(s.id, { id: s.id, question: s.question, status: 'queued' });
      const emit = (phase: 'start' | 'tick' | 'done', extra: Record<string, unknown> = {}) => {
        /* 计数从 workerViews 推, 保证**每一条**事件形状一致 ——
         * 界面拿到任何一条都能直接画, 不用先判断"这条是派兵还是收割"。
         * 收割那一刻调度器有更准的数 (它管着队列), 靠 extra 覆盖掉这里的推算。 */
        const views = [...workerViews.values()];
        const tally = (s: WorkerView['status']) => views.filter((v) => v.status === s).length;
        deps.onTaskAgentEvent?.('deep-research', {
          type: 'research_progress',
          phase,
          topic,
          scale,
          concurrency: limits.concurrency,
          maxWorkers: limits.maxWorkers,
          sources: latestStats.sources,
          domains: latestStats.domains,
          claims: latestStats.claims,
          disputed: latestStats.disputed,
          singleSource: latestStats.singleSource,
          /* 每条进度都带着产物路径 —— 中断时界面就靠它告诉用户"查到的东西在这儿" */
          reportPath,
          slug: ledger.slug,
          workers: views,
          completed: tally('done'),
          failed: tally('failed'),
          inFlight: tally('running'),
          queued: tally('queued'),
          dispatched: views.length - tally('queued'),
          ...extra,
        });
      };
      emit('start', { seeds: seeds.length, questions: seeds.map((s) => s.question) });

      const abortBox = { aborted: false };
      const runAbort = new AbortController();
      let stopReasonText = '';
      const stopRun = (reason: string) => {
        abortBox.aborted = true;
        if (!stopReasonText) stopReasonText = reason;
        if (!runAbort.signal.aborted) runAbort.abort(new Error(`deep_research 已停止: ${reason}`));
      };
      const onAbort = () => stopRun('调用方中断');
      /* 会话信号是随工具建的, 可能是上一轮留下的、早就 aborted 的那个 ——
       * 开跑那一刻就已经 aborted 的不作数, 否则一次停止之后所有调研都会秒停。 */
      const externalSignals = [context?.signal, deps.abortSignal]
        .filter((s): s is AbortSignal => !!s && !s.aborted);
      for (const s of externalSignals) s.addEventListener('abort', onAbort, { once: true });
      const unregisterRun = deps.sessionId
        ? registerDeepResearch(deps.sessionId, { topic, startedAt: Date.now(), stop: stopRun })
        : () => {};

      let followUpsAdmitted = 0;
      try {
        const run = await runSlidingWindow(seeds, limits, {
          signal: abortBox,
          admitFollowUp: (_c, st) => {
            if (followUpsAdmitted >= seeds.length) return false;
            if (st.dispatched + st.queued >= limits.maxWorkers) return false;
            followUpsAdmitted += 1;
            return true;
          },
          /* 线索一进队列就登记成"排队中" —— 在这之前只有派出去的才上界面,
           * 于是一轮查了几十条角度, 用户只看得见同时在跑的那三四个 (用户点名的那件事)。 */
          onQueued: (q) => {
            if (workerViews.has(q.id)) return;
            workerViews.set(q.id, { id: q.id, question: q.question, status: 'queued' });
            emit('tick', { phaseHint: 'queued' });
          },
          onOutcome: (outcome, st) => {
            emit('tick', {
              dispatched: st.dispatched,
              completed: st.completed,
              failed: st.failed,
              inFlight: st.inFlight,
              queued: st.queued,
              lastSummary: outcome.summary.slice(0, 120),
              lastOk: outcome.ok,
            });
          },
          dispatch: async (sub): Promise<WorkerOutcome> => {
            /* 线索派生出来的角度一开始不在 seeds 里, 这里补登记 */
            workerViews.set(sub.id, { id: sub.id, question: sub.question, status: 'running' });
            emit('tick', { phaseHint: 'dispatch' });
            /* 每次派兵前重读账本 —— worker 们一直在往里写, 新派的要看得到前面查到了什么。
             * 这正是滑动窗口相对波次的好处, 别把它优化掉。 */
            const fresh = (await loadLedger(deps.workDir, ledger.slug)) ?? ledger;
            latestStats = ledgerStats(fresh);

            try {
              await fs.writeFile(
                path.join(researchDir(deps.workDir, fresh.slug), 'report.md'),
                renderReportMarkdown(fresh),
                'utf-8',
              );
            } catch { /* 落盘失败不该毁掉正在跑的调研 */ }
            const prompt = buildWorkerPrompt({
              topic,
              sub,
              ledger: fresh,
              knownHosts: [...new Set(fresh.sources.map((s) => s.hostname))],
              harvestedSoFar: harvested.slice(-8),
            });

            const workerTimeoutMs = Math.max(90_000, Math.round(limits.wallClockMs / 2));
            const workerAbort = new AbortController();
            const onRunStop = () => {
              if (!workerAbort.signal.aborted) workerAbort.abort(runAbort.signal.reason);
            };
            if (runAbort.signal.aborted) onRunStop();
            else runAbort.signal.addEventListener('abort', onRunStop, { once: true });
            let timer: ReturnType<typeof setTimeout> | undefined;
            const raw = await Promise.race([
              (deps.agentTool.function as any)({
                type: 'research_worker',
                description: `调研: ${sub.question.slice(0, 60)}`,
                /* slug 和 angle 都是 research_record 的必填项, 放在一起给 ——
                 * angle 决定这条结论进报告的哪一章 (见 recordTool 里的说明)。 */
                prompt: `${prompt}\n\n## research_record 要用的两个值 (原样照抄)\n`
                  + `slug: ${ledger.slug}\nangle: ${angleOf(sub)}`,
                model: plan.worker.modelName,
                run_in_background: false,
                workDir: deps.workDir,
              }, { signal: workerAbort.signal }),
              new Promise<string>((resolve) => {
                timer = setTimeout(() => {
                  workerAbort.abort(new Error(`角度超时 (${Math.round(workerTimeoutMs / 1000)}s)`));
                  resolve(`[ERROR] 这条角度超时 (${Math.round(workerTimeoutMs / 1000)}s) —— 已中止, 继续下一个`);
                }, workerTimeoutMs);
              }),
            ]).finally(() => {
              if (timer) clearTimeout(timer);
              runAbort.signal.removeEventListener('abort', onRunStop);
              /* 这条角度收割了就把它的信号拉断 —— 正常结束时是 no-op, 但保证不会有东西
               * 挂着这个信号继续跑 (比如 agentTool 转了后台、或者有漏收的子调用)。 */
              if (!workerAbort.signal.aborted) workerAbort.abort(new Error('这条角度已收割'));
            });

            const res = readAgentResult(raw);
            if (!res.ok) {
              workerViews.set(sub.id, { id: sub.id, question: sub.question, status: 'failed', summary: res.error });
              return { subQuestionId: sub.id, ok: false, summary: '', sourcesAdded: 0, claimsAdded: 0, error: res.error };
            }
            const reply = parseWorkerReply(res.text);
            workerViews.set(sub.id, { id: sub.id, question: sub.question, status: 'done', summary: reply.summary.slice(0, 120) });
            harvested.push(reply.summary);
            return {
              subQuestionId: sub.id,
              ok: true,
              summary: reply.summary,
              /* 真实增量从账本算, 不听 worker 自报 */
              sourcesAdded: 0,
              claimsAdded: 0,
              followUps: reply.followUps.slice(0, MAX_FOLLOW_UPS_PER_WORKER),
            };
          },
        });

        /* 5. 报告 —— 纯投影, 不过模型 */
        const finalLedger: ResearchLedger = (await loadLedger(deps.workDir, ledger.slug)) ?? ledger;

        let synthesisNote = '';
        /* 被叫停就不归纳了: 用户要的是"停", 再起一个 leader 模型跑三分钟是反着来。
         * 报告照样用账本投影写出来 —— 查到的东西不丢。 */
        if (abortBox.aborted) synthesisNote = `调研被停止 (${stopReasonText}), 没做收尾归纳`;
        else try {
          const syn = await synthesizeNarrative(finalLedger, {
            model: plan.leader.modelName,
            runLeader: async (p: string) => {
              const SYNTH_TIMEOUT_MS = 180_000;
              let timer: ReturnType<typeof setTimeout> | undefined;
              const call = (deps.agentTool.function as any)({
                type: 'plan',
                description: synthesisAgentDescription(finalLedger.slug),
                prompt: p,
                model: plan.leader.modelName,
                run_in_background: false,
                workDir: deps.workDir,
                raw_output: true,
              }, { signal: runAbort.signal });
              const out = await Promise.race([
                call,
                new Promise<string>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error(`归纳超时 (${Math.round(SYNTH_TIMEOUT_MS / 1000)}s)`)),
                    SYNTH_TIMEOUT_MS,
                  );
                }),
              ]).finally(() => { if (timer) clearTimeout(timer); });
              const r = readAgentResult(out);
              if (!r.ok) throw new Error(r.error || '归纳没有返回内容');
              return r.text;
            },
          });
          if (syn.narrative) {
            finalLedger.narrative = syn.narrative;
            await saveLedger(deps.workDir, finalLedger);
          } else {
            synthesisNote = syn.error || '没能归纳出内容';
            if (finalLedger.narrative) {
              finalLedger.narrative = { ...finalLedger.narrative, stale: true };
              await saveLedger(deps.workDir, finalLedger);
            }
          }
        } catch (e) {
          synthesisNote = (e as Error)?.message || '归纳调用抛异常';
        }

        const st = ledgerStats(finalLedger);
        latestStats = st;
        emit('done', {
          dispatched: run.state.dispatched,
          completed: run.state.completed,
          failed: run.state.failed,
          stopReason: run.stopReason,
          unexplored: run.unexplored.length,
        });
        /* reportPath 在开工时就算好了 (见上面), 这里只管把最终版写进去 */
        await fs.writeFile(reportPath, renderReportMarkdown(finalLedger), 'utf-8');

        const stopNote: Record<string, string> = {
          converged: '查到没有新线索为止',
          'worker-cap': `撞到 worker 上限 (${limits.maxWorkers})`,
          'time-budget': `撞到时间预算 (${Math.round(limits.wallClockMs / 60000)} 分钟)`,
          aborted: '被中断',
        };

        const lines = [
          `题目: ${topic}`,
          `模型: ${describeModelPlan(plan)}`,
          `规模: ${scale} · 并发 ${limits.concurrency}${limits.concurrency < preset.concurrency ? ` (被子 agent 并发闸夹到 ${hardCap})` : ''}`,
          `派出 ${run.state.dispatched} 个调研员, ${run.state.completed} 成 ${run.state.failed} 败 · ${stopNote[run.stopReason]}`,
          '',
          `证据: ${st.sources} 个来源 / ${st.domains} 个站点 · ${st.claims} 条结论`,
          `  有分歧 ${st.disputed} · 多来源支持 ${st.supported} · 单一来源 ${st.singleSource} · 未核实 ${st.unverified}`,
          '',
          `报告: ${reportPath}`,
          /* 归纳没跑成要**说出来** —— 否则用户只看到报告里没有结论分析, 却不知道为什么 */
          ...(synthesisNote ? [`⚠︎ 收尾归纳没跑成 (${synthesisNote}) —— 摘要回落成算出来的那版`] : []),
          `账本: ${path.join(researchDir(deps.workDir, finalLedger.slug), 'ledger.json')} (原文快照在同目录 archive/)`,
        ];
        if (droppedSeeds.length > 0) {
          lines.push('', `${scale} 档一轮最多 ${MAX_SEEDS[scale]} 个角度, 这些没有查: ${droppedSeeds.map((s) => s.question).join(' / ')}`);
        }
        if (run.unexplored.length > 0) {
          lines.push('', `另有 ${run.unexplored.length} 条追问没查 (调研卡片上列给用户了)。`);
        }
        lines.push('', '这一轮调研到此结束: 读报告, 直接回答用户。不要再调 deep_research, 也不要派 agent / explore 补查;'
          + ' 没查清的如实说, 用户想继续深挖会自己开口。');
        if (st.disputed > 0) {
          lines.push('', `⚠︎ 有 ${st.disputed} 条结论存在来源分歧 —— 报告里并排列出了两边原话, 转述给用户时别只挑一边。`);
        }

        return JSON.stringify(createContextualResult(
          'deep_research', 'success',
          `调研完成: ${st.claims} 条结论 / ${st.sources} 个来源${st.disputed > 0 ? ` · ${st.disputed} 条有分歧` : ''}`,
          lines.join('\n'),
          {
            metadata: {
              topic, slug: finalLedger.slug, scale, report_path: reportPath,
              stop_reason: run.stopReason, dispatched: run.state.dispatched,
              leader_model: plan.leader.modelName, worker_model: plan.worker.modelName,
              model_source: plan.source, model_kind: plan.kind,
              ...st,
              deep_research: buildCardPayload({
                topic, scale, stats: st, ledger: finalLedger,
                stopReason: run.stopReason,
                dispatched: run.state.dispatched,
                leaderModel: plan.leader.modelName,
                workerModel: plan.worker.modelName,
                modelKind: plan.kind,
                reportPath,
                unexplored: run.unexplored.map((u) => u.question),
              }),
            },
          },
        ));
      } finally {
        for (const s of externalSignals) s.removeEventListener('abort', onAbort);
        unregisterRun();
        if (!runAbort.signal.aborted) runAbort.abort(new Error('deep_research 已结束'));
      }
    },
  };
}
