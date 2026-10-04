import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  EDITOR_PROTOCOL_VERSION, EditorRpcErrorCode, FORWARDED_EVENT_TYPES, MAX_EVENT_STRING_CHARS, PLATFORM_PROVIDER_ID,
  type ApprovalMode, type EditorClientInfo, type EditorEvent, type EditorHostMethod, type EditorHostRequests,
  type EditorNotificationMethod, type EditorNotifications,
  type EditorRpcMethod, type EditorRpcMethods, type EditorRpcParams, type EditorRpcResult,
  type HistoryItem, type ModelEntry, type ModelRef,
} from '@neoxlabs/editor-protocol';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { getCliEdition } from '../edition/index.js';
import { stopCapturingEarlyInput } from './earlyInputCapture.js';

const CLOUD_PROVIDER_ID = 'neox-cloud';
const FORWARDED = new Set<string>(FORWARDED_EVENT_TYPES);

type Json = Record<string, unknown>;

class RpcError extends Error {
  constructor(public code: number, message: string) { super(message); }
}

/** 方法表: 每个协议方法一个实现。入参来自管道, 类型上是 Partial —— 各方法自己校验必填项。 */
type Handlers = { [M in EditorRpcMethod]: (p: Partial<EditorRpcParams<M>>) => Promise<EditorRpcResult<M>> };

export async function runServeStdio(opts: { cliVersion: string }): Promise<void> {
  /* ── stdout 只留给协议 ── */
  const rawWrite = process.stdout.write.bind(process.stdout);
  const toStderr = (...args: unknown[]) => {
    process.stderr.write(args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ') + '\n');
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  (process.stdout as any).write = (chunk: unknown, ...rest: unknown[]) =>
    (process.stderr.write as any)(chunk, ...rest);
  const send = (msg: Json) => { rawWrite(JSON.stringify(msg) + '\n'); };
  const notify = <N extends EditorNotificationMethod>(method: N, params: EditorNotifications[N]) =>
    send({ jsonrpc: '2.0', method, params });

  /* ── 引擎 → 插件的请求 (编辑器能力): id 用 "h<n>" 跟插件发来的数字 id 分开 ── */
  let hostSeq = 0;
  const hostPending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const hostRequest = <M extends EditorHostMethod>(method: M, params: EditorHostRequests[M]['params'], timeoutMs = 10_000) =>
    new Promise<EditorHostRequests[M]['result']>((resolve, reject) => {
      const id = `h${++hostSeq}`;
      const timer = setTimeout(() => { hostPending.delete(id); reject(new Error(`editor did not answer ${method} in ${timeoutMs}ms`)); }, timeoutMs);
      hostPending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });
  let client: EditorClientInfo | null = null;

  const workDir = process.cwd();
  const account = getCliEdition().account;
  try { const uid = account?.currentUserId(); if (uid) { const { setCurrentUserId } = await import('@neoxlabs/platform/utils/config.js'); setCurrentUserId(uid); } } catch { /* 没登录 */ }

  const { loadConfig } = await import('@neoxlabs/platform/utils/config.js');
  const { ProviderStore } = await import('@neoxlabs/platform/utils/providerStore.js');
  const { getDatabase } = await import('@neoxlabs/platform/platform/database.js');
  const store = () => new ProviderStore(loadConfig());

  /* ── 引擎: 懒连 —— 没登录 / 没配模型时插件只会问状态, 不必先把运行时拉起来 ── */
  let adapter: import('@neoxlabs/core/sdk/localRuntimeAdapter.js').LocalRuntimeAdapter | null = null;
  const connecting: { p: Promise<void> | null } = { p: null };
  const ensureEngine = async () => {
    if (adapter) return adapter;
    if (!connecting.p) {
      connecting.p = (async () => {
        if (account) await account.prepareRouting();
        /* 编辑器能力: 插件声明能给诊断, read_lints 就上桌, 执行时问插件要 VS Code 的「问题」 */
        const editor = client?.capabilities?.diagnostics
          ? { diagnostics: async (q: { paths?: string[]; limit?: number }) => (await hostRequest('editor/diagnostics', { paths: q.paths, limit: q.limit })).items }
          : undefined;
        const { LocalRuntimeAdapter } = await import('@neoxlabs/core/sdk/localRuntimeAdapter.js');
        const a = new LocalRuntimeAdapter(workDir, join(homedir(), NEOX_HOME_DIRNAME), account?.deviceFp() ?? '', { editor, noAudioOutput: true });
        await a.connect();
        a.onEvent((event: any) => forwardEvent(event));
        adapter = a;
      })().finally(() => { connecting.p = null; });
    }
    await connecting.p;
    return adapter!;
  };

  /* ── 当前模型: 插件没指定时用 CLI 的默认 (同 print 模式的取法) ── */
  const cloudFallback: { model?: string } = {};
  /* 选了「按量」: 记在插件自己的家里 (editor-payg.json), 只对这个插件生效; 换成别的模型就删 */
  const paygFile = join(homedir(), NEOX_HOME_DIRNAME, 'editor-payg.json');
  const readPayg = (): string | null => {
    try { const v = JSON.parse(readFileSync(paygFile, 'utf8')); return typeof v?.model === 'string' && v.model ? v.model : null; } catch { return null; }
  };
  const writePayg = (model: string | null) => {
    try {
      if (model) writeFileSync(paygFile, JSON.stringify({ model }));
      else if (existsSync(paygFile)) unlinkSync(paygFile);
    } catch { /* 写不了就只是下次不记得按量 */ }
  };
  const currentModel = (): ModelRef | null => {
    const p = store().getDefaultProvider();
    if (!p) return null;
    const payg = p.id === CLOUD_PROVIDER_ID && account?.isLoggedIn() ? readPayg() : null;
    if (payg) return { providerId: PLATFORM_PROVIDER_ID, modelName: payg };
    /* 云端 (订阅) provider 自己不存模型列表, 模型由账号那边按套餐定 (同交互 CLI 启动时的取法) */
    const managed = p.id === CLOUD_PROVIDER_ID ? account?.resolveManagedInitialModel(p) : undefined;
    const name = managed ?? p.lastSelectedModel ?? p.defaultModel ?? (typeof p.models?.[0] === 'string' ? p.models[0] : (p.models?.[0] as any)?.name)
      ?? (p.id === CLOUD_PROVIDER_ID ? cloudFallback.model : undefined);
    return name ? { providerId: p.id, modelName: name } : null;
  };
  /* 订阅用户从没选过模型、会员缓存也还是冷的: 取套餐里第一个模型顶上 (只在内存里, 不替用户写配置) */
  const ensureModel = async (): Promise<ModelRef | null> => {
    if (currentModel() || !account?.isLoggedIn() || store().getDefaultProvider()?.id !== CLOUD_PROVIDER_ID) return currentModel();
    try {
      const r = await account.listCloudModels({ cloudOnly: false });
      cloudFallback.model = r.models[0]?.id;
    } catch { /* 拉不到就保持 null, 界面让用户自己选 */ }
    return currentModel();
  };

  /* ── 事件转发: 只要主 agent 的; 子 agent 会以镜像再来一份 (同 print 模式的三道闸) ── */
  const forwardEvent = (ev: any) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.__subAgentMirror || (typeof ev.sourceLabel === 'string' && ev.sourceLabel !== 'Main') || ev.taskAgentId) return;
    if (!FORWARDED.has(ev.type)) return;
    const sessionId = typeof ev.sessionId === 'string' ? ev.sessionId : undefined;
    if (ev.type === 'session_title_generated' && sessionId && typeof ev.title === 'string') {
      try { getDatabase().updateSessionField(sessionId, 'name', ev.title.trim()); } catch { /* 标题写不进去不影响对话 */ }
    }
    notify('event', { sessionId, event: slimEvent(ev) as unknown as EditorEvent });
  };

  /* ── 方法表 ── */
  const loginAbort: { ctrl: AbortController | null } = { ctrl: null };
  const methods: Handlers = {
    async initialize(p) {
      if (p.client && typeof p.client === 'object') client = p.client;
      return {
        protocol: EDITOR_PROTOCOL_VERSION,
        cliVersion: opts.cliVersion,
        workDir,
        workspaceName: basename(workDir),
        account: { supported: !!account, loggedIn: account?.isLoggedIn() ?? false, email: account?.accountEmail() ?? null },
        model: await ensureModel(),
        hasProvider: store().getProviders().length > 0,
      };
    },

    async 'auth.login'() {
      if (!account) throw new RpcError(EditorRpcErrorCode.NoAccount, 'This build has no Neox account login. Add your own API key instead.');
      loginAbort.ctrl?.abort();
      const ctrl = new AbortController();
      loginAbort.ctrl = ctrl;
      try {
        const { email } = await account.loginHeadless({ signal: ctrl.signal, onUrl: (url, opened) => notify('auth/url', { url, opened }) });
        return { email, model: await ensureModel() };
      } finally {
        if (loginAbort.ctrl === ctrl) loginAbort.ctrl = null;
      }
    },
    async 'auth.cancelLogin'() { loginAbort.ctrl?.abort(); return {}; },
    async 'auth.logout'() {
      if (!account) return { serverRevokeFailed: false };
      return account.logoutHeadless();
    },

    /* 三组, 选择器按 source 分开画 (计费完全不同): 订阅 (带权益 / 消耗速度) / 按量 (官方价 + 余额) / 自己的 Key */
    async 'models.list'() {
      const out: ModelEntry[] = [];
      const errors: string[] = [];
      let plan: string | null = null;
      let platform: { balanceUsd: number; usable: boolean; blockedReason: 'extra_usage_off' | 'no_balance' | null } | null = null;
      if (account?.isLoggedIn()) {
        const cat = await account.listCloudCatalog();
        plan = cat.plan;
        for (const m of cat.subscription) {
          out.push({
            providerId: CLOUD_PROVIDER_ID, providerName: 'Neox', model: m.id, source: 'cloud', displayName: m.displayName,
            allowed: m.allowed, included: m.included, relativeCost: m.relativeCost, ...(m.vision != null ? { vision: m.vision } : {}),
          });
        }
        if (cat.platform) {
          const { models, ...balance } = cat.platform;
          platform = balance;
          for (const m of models) {
            out.push({
              providerId: PLATFORM_PROVIDER_ID, providerName: 'Neox', model: m.id, source: 'platform', displayName: m.displayName,
              relativeCost: m.relativeCost, price: { inputPerMtok: m.inputPerMtok, outputPerMtok: m.outputPerMtok },
            });
          }
        }
        errors.push(...cat.errors);
      }
      for (const p of store().getProviders()) {
        if (p.id === CLOUD_PROVIDER_ID) continue;
        for (const m of p.models ?? []) {
          const name = typeof m === 'string' ? m : m?.name;
          if (name) out.push({ providerId: p.id, providerName: p.name || p.id, model: name, source: 'byok' });
        }
      }
      return { models: out, current: currentModel(), errors, plan, platform };
    },
    async 'model.set'(p) {
      const providerId = str(p.providerId);
      const modelName = str(p.modelName);
      if (!providerId || !modelName) throw new RpcError(EditorRpcErrorCode.InvalidParams, 'providerId and modelName are required');
      const s = store();
      /* 按量不是 config 里的 provider (是 neox-cloud 加计费头): 默认 provider 记 neox-cloud, 按量这件事记在插件自己的文件里 */
      const payg = providerId === PLATFORM_PROVIDER_ID;
      const realId = payg ? CLOUD_PROVIDER_ID : providerId;
      s.setDefaultProvider(realId);
      s.setLastSelectedModel(realId, modelName);
      writePayg(payg ? modelName : null);
      return { model: currentModel() };
    },
    async 'providers.add'(p) {
      const name = str(p.name);
      const apiKey = str(p.apiKey);
      const protocol = p.protocol === 'anthropic' || p.protocol === 'openai-responses' ? p.protocol : 'openai';
      const baseUrl = str(p.baseUrl) || undefined;
      const models = Array.isArray(p.models) ? p.models.filter((m): m is string => typeof m === 'string' && !!m.trim()) : [];
      if (!name || !apiKey || models.length === 0) throw new RpcError(EditorRpcErrorCode.InvalidParams, 'name, apiKey and at least one model are required');
      const entry = store().addProvider({ name, apiKey, protocol, baseUrl, models, defaultModel: models[0], setAsDefault: true });
      store().setLastSelectedModel(entry.id, models[0]);
      return { model: currentModel() };
    },

    async 'sessions.list'() {
      const rows = getDatabase().listSessions(workDir) as Array<{ id: string; name: string; updatedAt: number }>;
      return {
        sessions: rows
          .filter((r) => !String(r.id).startsWith('print-'))
          .slice(0, 100)
          .map((r) => ({ id: r.id, title: r.name, updatedAt: r.updatedAt })),
      };
    },
    async 'session.history'(p) {
      const sessionId = str(p.sessionId);
      if (!sessionId) throw new RpcError(EditorRpcErrorCode.InvalidParams, 'sessionId is required');
      return { items: readHistory(getDatabase(), sessionId) };
    },
    async 'session.delete'(p) {
      const sessionId = str(p.sessionId);
      if (sessionId) getDatabase().deleteSession(sessionId);
      return {};
    },

    async 'chat.send'(p) {
      const prompt = str(p.prompt);
      if (!prompt.trim()) throw new RpcError(EditorRpcErrorCode.InvalidParams, 'prompt is required');
      const model = (str(p.providerId) && str(p.modelName)) ? { providerId: str(p.providerId), modelName: str(p.modelName) } : await ensureModel();
      if (!model) throw new RpcError(EditorRpcErrorCode.NoModel, 'No model configured. Sign in or add your own API key first.');
      const db = getDatabase();
      let sessionId = str(p.sessionId);
      if (!sessionId || !db.getSession(sessionId)) {
        const { generateSessionId } = await import('@neoxlabs/kernel/types/session.js');
        sessionId = sessionId || generateSessionId();
        const now = Date.now();
        db.upsertSession({
          id: sessionId, name: prompt.replace(/\s+/g, ' ').slice(0, 40), modelId: model.modelName, workspacePath: workDir,
          createdAt: now, updatedAt: now, totalTokens: 0, contextUsed: 0,
        });
      }
      const eng = await ensureEngine();
      const mode = approvalModeOf(p.approvalMode);
      if (mode) await setSessionApprovalMode(eng, sessionId, mode);
      /* 不 await 整轮: 立刻把 sessionId 还给插件, 过程和结束都走事件, 以 run_result 收尾 */
      void eng.chat({ sessionId, prompt, mode: 'agentic', providerId: model.providerId, modelName: model.modelName } as any)
        .catch((err: unknown) => {
          notify('event', { sessionId, event: { type: 'error', message: errMsg(err) } });
          notify('event', { sessionId, event: { type: 'run_result', failed: true } });
        });
      return { sessionId };
    },
    async 'chat.abort'(p) {
      const sessionId = str(p.sessionId);
      if (adapter && sessionId) await adapter.abort(sessionId);
      return {};
    },
    async 'approvalMode.set'(p) {
      const sessionId = str(p.sessionId);
      const mode = approvalModeOf(p.mode);
      if (!sessionId || !mode) throw new RpcError(EditorRpcErrorCode.InvalidParams, 'sessionId and mode (auto | manual | dangerous) are required');
      await setSessionApprovalMode(await ensureEngine(), sessionId, mode);
      return { mode };
    },
    async 'approval.reply'(p) {
      const eng = await ensureEngine();
      eng.getBridge()?.replyPermission(str(p.requestId), p.approved === true, undefined, p.remember === true);
      return {};
    },
    async 'askUser.reply'(p) {
      const eng = await ensureEngine();
      const answers = (p.answers && typeof p.answers === 'object') ? p.answers : {};
      const r = await eng.getBridge()?.replyAskUser?.(str(p.requestId), answers);
      return { status: (r as any)?.status ?? 'resolved' };
    },
  };

  /* ── 读请求 ── */
  const early = stopCapturingEarlyInput();
  (process.stdin as { ref?: () => void }).ref?.();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const handleLine = async (line: string) => {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: EditorRpcErrorCode.ParseError, message: 'Parse error' } }); return; }
    if (msg?.id === undefined) return; // 协议里插件 → 引擎没有通知
    /* 插件对引擎请求的响应 (没有 method) */
    if (msg.method === undefined) {
      const p = hostPending.get(String(msg.id));
      if (!p) return;
      hostPending.delete(String(msg.id));
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'editor error'));
      else p.resolve(msg.result);
      return;
    }
    const fn = Object.prototype.hasOwnProperty.call(methods, msg?.method) ? (methods as any)[msg.method] as (p: Json) => Promise<unknown> : null;
    if (!fn) { send({ jsonrpc: '2.0', id: msg.id, error: { code: EditorRpcErrorCode.MethodNotFound, message: `Unknown method ${msg?.method}` } }); return; }
    try {
      const result = await fn((msg.params ?? {}) as Json);
      send({ jsonrpc: '2.0', id: msg.id, result: result ?? {} });
    } catch (err) {
      const code = err instanceof RpcError ? err.code : EditorRpcErrorCode.Internal;
      send({ jsonrpc: '2.0', id: msg.id, error: { code, message: errMsg(err) } });
    }
  };
  if (early && early.length) for (const l of early.toString('utf8').split('\n')) void handleLine(l);
  rl.on('line', (l) => { void handleLine(l); });

  notify('ready', { protocol: EDITOR_PROTOCOL_VERSION });

  await new Promise<void>((resolve) => rl.on('close', () => resolve()));
  loginAbort.ctrl?.abort();
  /* adapter 在闭包里赋值, TS 流分析看不到 —— 这里按声明类型读 */
  try { (adapter as { dispose(): void } | null)?.dispose(); } catch { /* 退出途中 */ }
  /* process.stdout.write 已被指到 stderr, 调用方的 drainStdout 排不到这里 —— 自己用真 write 等排空 */
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 2000);
    t.unref?.();
    try { rawWrite('', () => { clearTimeout(t); resolve(); }); } catch { clearTimeout(t); resolve(); }
  });
}

/* ── helpers ── */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
function safeStringify(v: unknown): string { try { return JSON.stringify(v); } catch { return String(v); } }

const approvalModeOf = (v: unknown): ApprovalMode | null =>
  (v === 'auto' || v === 'manual' || v === 'dangerous' ? v : null);

/** 审批档只落到这个会话 —— 不传 scope 时 bridge 缺省是 global, 会把全机的 CLI / 桌面一起改掉并落盘
 *  (同 printMode.ts 的说明)。dangerous 由插件那边先弹确认, 这里带上两个确认位。 */
async function setSessionApprovalMode(eng: { getBridge(): any }, sessionId: string, mode: ApprovalMode): Promise<void> {
  await eng.getBridge()?.setApprovalMode?.(sessionId, mode, {
    scope: 'agent', scopeKey: sessionId,
    ...(mode === 'dangerous' ? { dangerousConfirmation: { acknowledgeNoApproval: true, acknowledgeHighRiskExecution: true } } : {}),
  });
}

/** 工具回执拆信封: search / web_* / git_* / run_tests / write_file 等回的是
 *  {type,status,tool,summary,content?,...} 的 JSON 字符串, bash_output 回 {command,status,exit_code,content,...}。
 *  必须在截断之前拆 —— 先截断的话 JSON 就坏了, 插件只能把半截 JSON 原样摆出来 (web_search 动辄上万字)。
 *  拆出来: output = 正文 (content), summary = 信封里的一句话, exitCode = 后台命令的退出码。 */
function unwrapToolOutput(ev: any): void {
  if (ev?.type !== 'tool_call_end' || typeof ev.output !== 'string') return;
  const t = ev.output.trimStart();
  if (!t.startsWith('{')) return;
  let j: any;
  try { j = JSON.parse(t); } catch { return; }
  if (!j || typeof j !== 'object') return;
  if (typeof j.content === 'string') ev.output = j.content;
  else if (typeof j.summary === 'string') ev.output = j.summary;
  else return;
  const summaryIsJson = typeof ev.summary !== 'string' || ev.summary.trimStart().startsWith('{');
  if (typeof j.summary === 'string' && summaryIsJson) ev.summary = j.summary;
  /* bash_output 的信封没有 summary: 用状态顶上 (completed / running) */
  else if (summaryIsJson) ev.summary = typeof j.status === 'string' ? j.status : undefined;
  if (typeof j.exit_code === 'number') ev.exitCode = j.exit_code;
}

/** 转给插件的事件: 去掉大字段 (工具输出 / 参数里的长字符串截断、图片 base64 丢掉)。
 *  discardedText 不截 —— 插件按它从正文尾部精确撤字。 */
function slimEvent(src: any): Json {
  const ev = { ...src };
  unwrapToolOutput(ev);
  const clip = (v: unknown): unknown =>
    (typeof v === 'string' && v.length > MAX_EVENT_STRING_CHARS ? v.slice(0, MAX_EVENT_STRING_CHARS) + '\n…' : v);
  const out: Json = {};
  for (const [k, v] of Object.entries(ev)) {
    if (k.startsWith('__') || k === 'images' || k === 'screenshot' || k === 'iterationPerf') continue;
    if (k === 'discardedText') out[k] = v;
    else if (k === 'args' && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = Object.fromEntries(Object.entries(v as Json).map(([ak, av]) => [ak, clip(av)]));
    } else out[k] = clip(v);
  }
  return out;
}

/** 历史回放: 用户消息 / 助手文字 / 工具调用 (名字 + 一行摘要 + 参数), 按库里的顺序 */
function readHistory(db: { getMessages(id: string, limit?: number): Array<{ itemType: string; itemData: any }> }, sessionId: string): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const row of db.getMessages(sessionId, 1000)) {
    if (row.itemType !== 'message') continue;
    const d = row.itemData as { role?: string; content?: unknown; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } | null;
    const text = contentText(d?.content).trim();
    if (d?.role === 'user') {
      if (!text || text.startsWith('<')) continue;
      const clean = text.replace(/(\s*<([a-z][a-z0-9-]*)>[\s\S]*?<\/\2>)+\s*$/, '').trim();
      const last = items[items.length - 1];
      if (last?.kind === 'user' && last.text === clean) continue;
      items.push({ kind: 'user', text: clean });
    } else if (d?.role === 'assistant') {
      if (text) items.push({ kind: 'assistant', text });
      for (const tc of d.tool_calls ?? []) {
        const name = tc.function?.name ?? 'tool';
        /* 参数一并带上 (长字符串截断) —— 插件回放时改文件的那行还能点开看红绿改动 */
        const args = parseArgs(tc.function?.arguments);
        items.push({ kind: 'tool', name, text: summarizeArgs(args), args: args ? (slimEvent({ args }).args as Json) : undefined });
      }
    }
  }
  return items;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('');
  return '';
}

function parseArgs(raw: string | undefined): Json | null {
  if (!raw) return null;
  try {
    const a = JSON.parse(raw);
    return a && typeof a === 'object' && !Array.isArray(a) ? a as Json : null;
  } catch { return null; }
}

function summarizeArgs(a: Json | null): string {
  if (!a) return '';
  const v = a.path ?? a.file_path ?? a.command ?? a.pattern ?? a.query ?? a.url;
  return typeof v === 'string' ? v.slice(0, 160) : '';
}
