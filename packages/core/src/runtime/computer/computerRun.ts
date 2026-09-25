
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getOsBridge, type BridgeDump, type BridgeElement } from './osBridgeClient.js';
import { nextShotPath } from './shotStore.js';
import { guardComputerTarget } from './computerGuard.js';
import { publishComputerPointer } from '@neoxlabs/platform/shared/computerPointerBus.js';
import { checkComputerUsePolicy } from './computerPolicy.js';
import { withAppLock } from './computerLock.js';
import { beginComputerSession, mergeAbortSignals } from './computerAbort.js';

/** 这一步做完必须发生的变化。**每个会改界面的动作都该带上**。 */
export interface ComputerChangeAssertion {
  /**
   * 看什么变:
   *   'screen'         —— 正文文本签名 (最通用, 什么都不知道时用这个)
   *   {label:'xxx'}    —— 某个标签的元素出现 / 消失
   *   {count:'AXRow'}  —— 某个角色的元素数量变化
   */
  watch: 'screen' | { label: string; gone?: boolean } | { count: string };
  timeoutMs?: number;
}

export interface ComputerStep {
  action: 'launch' | 'click' | 'click_at' | 'hover' | 'double_click' | 'drag' | 'type' | 'key' | 'scroll' | 'press' | 'focus'
        | 'set_value' | 'show_menu' | 'select_text' | 'wait' | 'snapshot';
  /** launch 专用: 要启动的 App 名或 bundleId。不给就用脚本级的 app。 */
  app?: string;
  /** 元素编号 (snapshot 给的)。click/press/focus/set_value 需要。 */
  target?: number;
  text?: string;
  key?: string;
  modifiers?: string[];
  /** scroll 的滚动量; **click_at / hover / double_click / type 时是窗口内的相对位置 (0~1)**。 */
  dx?: number;
  dy?: number;
  /** drag 终点 (窗口内 0~1)。起点是 dx/dy。 */
  dx2?: number;
  dy2?: number;
  /** select_text 专用: 同一段文字在正文里出现多次时选第几个 (1 起, 默认 1)。 */
  occurrence?: number;
  expectChange?: ComputerChangeAssertion;
  optional?: boolean;
  label?: string;
}

export interface ComputerRunArgs {
  /** 目标 App 名 (或 bundleId)。不给就是当前前台 App。 */
  app?: string;
  steps: ComputerStep[];
  timeoutMs?: number;
}

export interface ComputerStepOutcome {
  index: number;
  action: string;
  label?: string;
  ok: boolean;
  ms: number;
  error?: string;
  hint?: string;
  slowHint?: string;
}

export interface ComputerRunResult {
  ok: boolean;
  app?: string;
  ranSteps: number;
  totalSteps: number;
  totalMs: number;
  failedAt?: number;
  steps: ComputerStepOutcome[];
  screen?: ComputerSnapshot;
}

export interface ComputerSnapshot {
  app: string;
  ms: number;
  /** axBlind 时附上窗口截图的路径 —— 读不到元素时, 眼睛是唯一的路。 */
  screenshot?: string;
  /** 编号后的可交互元素 —— 模型答"点 7 号", 不答"点 (834,219)"。 */
  actionable: string[];
  /** 正文文本摘要 */
  digest: string;
  elementCount: number;
  axBlind: boolean;
  /** Windows: uia | jab | jab-skipped。Java 接到 Access Bridge 时为 jab。 */
  treeSource?: string;
  /** 实际扫到的窗口标题。弹层开着时是弹层, 不是主窗。 */
  windowTitle?: string;
  windowClass?: string;
  /** true: 当前扫的是对话框/弹层, 不是主窗。 */
  dialog?: boolean;
  note?: string;
  privilege?: import('./osBridgeClient.js').BridgePrivilege;
  targetIntegrity?: string;
}

const DEFAULT_CHANGE_TIMEOUT = 6000;
/** 单步慢到这个程度就当场点破 —— 不点破模型不知道自己哪一步在烧时间。 */
const SLOW_STEP_MS = 2000;
const SCREEN_CHANGE_MIN_GONE = 1;

/** 'screen' 断言的基线: stable = 骨架 (两次采样的交集), seen = 两次里出现过的全部文本。 */
interface ScreenBaseline { stable: Set<string>; seen: Set<string> }

function clip(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 便宜的字符串哈希 (FNV-1a)。签名只要"同界面稳定、异界面不同", 不需要密码学强度。 */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 界面上的内容文本集合 —— 'screen' 断言比的是它, 不是逐条顺序。 */
function contentLabels(dump: BridgeDump): Set<string> {
  const out = new Set<string>();
  for (const e of dump.elements) {
    if (e.label && !e.actionable) out.add(e.label.replace(/\s+/g, ' ').slice(0, 40));
  }
  return out;
}

/** 模型常把 expectChange 写成 `{watch:{}}` 或漏掉 watch。`'count' in undefined` 会整段脚本炸掉。 */
function resolveWatch(watch: unknown): ComputerChangeAssertion['watch'] | null {
  if (watch === 'screen') return 'screen';
  if (!watch || typeof watch !== 'object') return null;
  const o = watch as { count?: unknown; label?: unknown; gone?: unknown };
  if (typeof o.count === 'string' && o.count) return { count: o.count };
  if (typeof o.label === 'string' && o.label) {
    return o.gone === true ? { label: o.label, gone: true } : { label: o.label };
  }
  return null;
}

/** 界面签名: 同一界面重复取要稳定, 界面变了要不同。取不到返回 null (= 失败, 不是"没变")。 */
function signature(dump: BridgeDump, watch: ComputerChangeAssertion['watch']): string | null {
  const resolved = resolveWatch(watch);
  if (!resolved) return null;
  watch = resolved;
  if (watch === 'screen') {
    const texts = dump.elements
      .filter((e) => e.label && !e.actionable)
      .map((e) => e.label.replace(/\s+/g, ' ').slice(0, 40));
    return texts.length ? `${texts.length}:${hash(texts.join('|'))}` : null;
  }
  if ('count' in watch) {
    return String(dump.elements.filter((e) => e.role === watch.count).length);
  }
  const found = dump.elements.some((e) => e.label.includes(watch.label));
  return String(found);
}

/**
 * 编号 → 元素身份 (role + label)。**必须跨调用累积**, 不能每次 run 重建。
 *
 * 模型的用法天然是分两次调用的: 先 computer_snapshot 拿编号, 再 computer_run 用编号。
 * 这两次是两个不同的 dump。第一版把身份表建在 run 内部, 于是模型传进来的编号
 * 一律"不认识" —— 一个正确的调用被判成参数错误。
 *
 * 上限 5000: 长会话里一直 dump 会无限涨, 到顶按先进先出淘汰。
 */
const identityOf = new Map<number, string>();
const IDENTITY_CAP = 5000;

/** 元素身份 = 角色 + 内容标签 + 角色描述。界面重绘后靠它把旧编号认回来。 */
function identityKey(e: BridgeElement): string {
  return `${e.role}${e.label}${e.roleDesc ?? ''}`;
}

function rememberIdentities(d: BridgeDump): void {
  for (const e of d.elements) {
    identityOf.set(e.id, identityKey(e));
  }
  while (identityOf.size > IDENTITY_CAP) {
    const oldest = identityOf.keys().next().value;
    if (oldest === undefined) break;
    identityOf.delete(oldest);
  }
}

type SnapshotResult = BridgeDump | { ok: false; code: string; error: string; hint?: string };

const FRESH_ENOUGH_MS = 700;
/**
 * axBlind 没有元素句柄可过期, 模型想下一步那几秒屏幕也没人动。
 * 复用上一轮收尾 dump, 省掉 WPS 这类自绘窗每次 computer_run 开头再扫一遍空树。
 * 有编号的 App 绝不能走这条: 模型思考期间句柄会静默失效。
 */
const AXBLIND_REUSE_MS = 8_000;
/** 点开功能区/右键之后, 下一步再点菜单项。自绘窗没有树可等, 给一层展开时间. */
const OPEN_UI_SETTLE_MS = 280;
let lastDump: { app: string | undefined; at: number; result: BridgeDump } | null = null;
/** 最近一次 dump 的实际耗时 —— 轮询间隔按它自适应。 */
let lastDumpMs = 200;

/** 测试用: 清感知短缓存, 避免用例互相污染。 */
export function resetComputerPerceptionCache(): void {
  lastDump = null;
}

function firstSnapshotMaxAge(app?: string): number {
  if (lastDump && lastDump.app === app && lastDump.result.axBlind) return AXBLIND_REUSE_MS;
  return 0;
}

export function mergeIncrementalDump(prev: BridgeDump, inc: BridgeDump): BridgeDump {
  const byId = new Map<number, BridgeElement>();
  for (const e of prev.elements) byId.set(e.id, e);
  for (const id of inc.removed ?? []) byId.delete(id);
  for (const e of inc.elements) byId.set(e.id, e);
  const elements = [...byId.values()].sort((a, b) => a.id - b.id);
  return { ...inc, incremental: undefined, unchanged: undefined, removed: undefined, elements };
}

async function snapshot(app: string | undefined, opts?: { maxAgeMs?: number }): Promise<SnapshotResult> {
  const maxAge = opts?.maxAgeMs ?? 0;
  if (maxAge > 0 && lastDump && lastDump.app === app && Date.now() - lastDump.at < maxAge) {
    return lastDump.result;
  }
  const t0 = Date.now();
  const prev = lastDump && lastDump.app === app ? lastDump.result : null;
  const r = await getOsBridge().request({
    op: 'dump',
    ...(app ? { app } : {}),
    ...(prev ? { since: prev.epoch } : {}),
  });
  lastDumpMs = Date.now() - t0;
  if ((r as BridgeDump).ok) {
    let full = r as BridgeDump;
    if (full.incremental && prev) {
      full = mergeIncrementalDump(prev, full);
      cliLogger.info('COMPUTER_RUN',
        `增量 dump: 变 ${(r as BridgeDump).elements.length} / 没变 ${((r as BridgeDump).unchanged ?? []).length} / 消失 ${((r as BridgeDump).removed ?? []).length}`);
    } else if (full.incremental && !prev) {
      /* 桥说这是增量, 但我们手里没有可合并的上一份 —— 只能当它不完整, 下一次会拿全量。
       * 绝不能把残缺的当完整用: 模型会以为界面上只剩这几个元素。 */
      cliLogger.warn('COMPUTER_RUN', '收到增量但本地没有基线, 丢弃这次结果');
      return { ok: false, code: 'incremental_without_base', error: '增量对不上本地基线, 请重试 (下一次会取全量)' };
    }
    rememberIdentities(full);
    lastDump = { app, at: Date.now(), result: full };
    return full;
  }
  return r as SnapshotResult;
}

/** 轮询间隔: 至少 120ms, 但别比一次采集本身还密 —— 那只是把时间烧在重复采集上。 */
function pollDelay(): number {
  return Math.min(1200, Math.max(120, Math.round(lastProbeMs * 0.6)));
}

const sleep = (n: number): Promise<void> => new Promise((r) => { setTimeout(r, n); });

function isRatioPoint(step: ComputerStep): boolean {
  return typeof step.dx === 'number' && typeof step.dy === 'number'
    && step.dx >= 0 && step.dx <= 1 && step.dy >= 0 && step.dy <= 1;
}

function skipElementAssertion(dump: BridgeDump, step: ComputerStep): boolean {
  if (dump.axBlind || step.action === 'click_at' || step.action === 'hover'
    || step.action === 'double_click' || step.action === 'drag'
    || ((step.action === 'scroll' || step.action === 'show_menu' || step.action === 'type') && isRatioPoint(step))) return true;
  const jab = dump.treeSource === 'jab' || dump.treeSource === 'jab-skipped';
  if (jab && (step.action === 'key' || step.action === 'type')) return true;
  return false;
}

/** `alt+insert` / `ctrl+s` 写在 key 上时拆开, 桥两端都认 modifiers 数组。 */
function splitKeyChord(key: string | undefined, extra: string[]): { key: string; modifiers: string[] } {
  const raw = (key ?? '').trim();
  const mods = extra.map((m) => m.trim().toLowerCase()).filter(Boolean);
  if (!raw || raw === '+' || !raw.includes('+')) return { key: raw, modifiers: mods };
  const parts = raw.split('+').filter(Boolean);
  if (parts.length < 2) return { key: raw, modifiers: mods };
  const k = parts[parts.length - 1]!;
  for (const p of parts.slice(0, -1)) {
    const m = p.toLowerCase();
    if (!mods.includes(m)) mods.push(m);
  }
  return { key: k, modifiers: mods };
}

/** 桥支持 op=watch 吗。老桥不认这个 op, 探一次就记住, 之后一律纯睡眠。 */
let watchUsable = true;

async function pollGap(app?: string): Promise<void> {
  const ms = pollDelay();
  const sleep = (n: number): Promise<void> => new Promise((r) => { setTimeout(r, n); });
  if (!watchUsable) { await sleep(ms); return; }
  const t0 = Date.now();
  const r = await getOsBridge().request({ op: 'watch', budget: ms, ...(app ? { app } : {}) }) as any;
  if (r?.ok) return;
  /* 桥不认这个 op (旧版本) —— 退回纯睡眠, 并且别再问第二次。
   * 不补上剩余时间的话这里就成了一个不睡的空转循环, 会把 CPU 打满。 */
  watchUsable = false;
  const left = ms - (Date.now() - t0);
  if (left > 0) await sleep(left);
}

let lastProbeMs = 200;

interface SignatureProbe {
  texts: Set<string>;
  counts: Record<string, number>;
}

/**
 * 轻量签名采集 —— 变化断言专用, 只要文本和各角色计数。
 *
 * 跟完整 dump 的差别: 桥那边不构造元素、不进编号表、不问 actions, 回来的 JSON 也小一个量级。
 * 断言本来就只需要"界面变了没有", 付完整 dump 的钱纯属浪费 —— 而在 OS 这边那笔钱是
 * 0.6~3 秒 (浏览器那边 30ms, 所以同一套写法在这里直接爆炸)。
 */
async function signatureProbe(app: string | undefined): Promise<SignatureProbe | null> {
  const t0 = Date.now();
  const r = await getOsBridge().request({ op: 'signature', ...(app ? { app } : {}) }) as
    { ok?: boolean; texts?: string[]; counts?: Record<string, number> };
  lastProbeMs = Date.now() - t0;
  if (!r?.ok || !Array.isArray(r.texts)) return null;
  return { texts: new Set(r.texts), counts: r.counts ?? {} };
}

/** 用轻量签名算出跟 signature() 同口径的值。口径不一致会造出"这边说变了那边说没变"。 */
function signatureFromProbe(p: SignatureProbe, watch: ComputerChangeAssertion['watch']): string | null {
  const resolved = resolveWatch(watch);
  if (!resolved) return null;
  watch = resolved;
  if (watch === 'screen') {
    const texts = [...p.texts];
    return texts.length ? `${texts.length}:${hash(texts.join('|'))}` : null;
  }
  if ('count' in watch) return String(p.counts[watch.count] ?? 0);
  /* {label} 断言看的是"有没有这个文字" —— 轻量采集只收非可交互的内容文本,
   * 所以按钮上的字它看不到。这种情况回退到完整 dump 由调用方兜底 (返回 null)。 */
  for (const t of p.texts) if (t.includes(watch.label)) return 'true';
  return 'false';
}

/** 编号后的可交互元素 —— 模型答"点 7 号"。弹层面板能上百个, 截太短就会「点了表情却看不见微笑」。 */
const ACTIONABLE_LIST_CAP = 160;

function roleName(e: BridgeElement): string {
  return (e.role || '').replace(/^AX/, '');
}

function nameAdjacentSplitButtons(elements: BridgeElement[]): BridgeElement[] {
  const out = elements.map((e) => ({ ...e }));
  for (let i = 0; i < out.length; i++) {
    const cur = out[i]!;
    if (roleName(cur) !== 'Button' || (cur.label ?? '').trim()) continue;
    let left: BridgeElement | undefined;
    for (const other of out) {
      if (other === cur || roleName(other) !== 'Button') continue;
      const lab = (other.label ?? '').trim();
      if (!lab) continue;
      if (Math.abs((other.y ?? 0) - (cur.y ?? 0)) > 8) continue;
      if ((other.x ?? 0) >= (cur.x ?? 0)) continue;
      if ((other.x ?? 0) + (other.w ?? 0) + 12 < (cur.x ?? 0)) continue;
      left = other;
    }
    if (left) cur.label = `${(left.label ?? '').trim()}菜单`;
  }
  return out;
}

function isClickableRow(e: BridgeElement): boolean {
  if (e.enabled === false) return false;
  if (e.actionable) return true;
  const role = roleName(e);
  const label = (e.label ?? '').trim();
  if (!label) return false;
  if (role !== 'Text' && role !== 'Custom' && role !== 'StaticText') return false;
  const w = e.w ?? 0;
  const h = e.h ?? 0;
  return h >= 16 && h <= 88 && w >= 40;
}

function isPickerish(e: BridgeElement): boolean {
  const role = roleName(e);
  if (role === 'ListItem' || role === 'MenuItem' || role === 'TreeItem') return true;
  return /表情|emoji|微笑|菜单/i.test(`${e.label ?? ''} ${e.roleDesc ?? ''}`);
}

function toSnapshot(dump: BridgeDump): ComputerSnapshot {
  const elements = nameAdjacentSplitButtons(dump.elements);
  const clickable = elements.filter(isClickableRow);
  const picker = clickable.filter(isPickerish);
  const rest = clickable.filter((e) => !isPickerish(e));
  const ordered = [...picker, ...rest].slice(0, ACTIONABLE_LIST_CAP);
  const content = elements.filter((e) => (e.label ?? '').trim()).map((e) => e.label.trim());
  const digestBits = [...content.slice(0, 8), ...content.slice(-12)];
  const digest = clip([...new Set(digestBits)].join(' · '), 800);
  return {
    app: dump.app,
    ms: dump.ms,
    actionable: ordered.map((e) => `${e.id}. [${roleName(e)}] ${e.label || e.roleDesc || '(无标签)'}`),
    digest,
    elementCount: dump.elements.length,
    axBlind: dump.axBlind,
    note: dump.note,
    treeSource: dump.treeSource,
    windowTitle: dump.windowTitle,
    windowClass: dump.windowClass,
    dialog: dump.dialog,
    privilege: dump.privilege,
    targetIntegrity: dump.targetIntegrity,
  };
}

/** 每次感知都带窗口截图。树滞后时 (表情/@ 弹层) 编号表还是旧的, 没图就会卡死。 */
async function withBlindScreenshot(snap: ComputerSnapshot, app?: string): Promise<ComputerSnapshot> {
  const shot = await getOsBridge().request({
    op: 'screenshot', path: nextShotPath(), ...(app ? { app } : {}),
  }) as any;
  if (shot?.ok && shot.path) {
    snap.screenshot = shot.path;
    if (snap.axBlind) {
      snap.note = (snap.note ? snap.note + ' ' : '')
        + '已附窗口截图: 用 computer_run 的 click_at 按**比例**点 (dx/dy 是 0~1 的窗口内相对位置, '
        + '左上 0,0 右下 1,1) —— 别报绝对坐标, 窗口会被拖动。';
    } else {
      snap.note = (snap.note ? snap.note + ' ' : '')
        + '已附窗口截图。编号点得到就按编号; 弹层还没进表时按图 click_at (dx/dy 为窗口内 0~1)。';
    }
  } else if (snap.axBlind) {
    snap.note = (snap.note ? snap.note + ' ' : '')
      + `截图也没拿到 (${shot?.code ?? '未知原因'})，所以这个 App 现在既读不到元素也看不到画面。`
      + (shot?.code === 'no_screen_recording'
        ? ' 缺的是**屏幕录制**权限 —— 调 computer_check_access({prompt: true}) 把设置页开给用户,'
          + ' 它跟辅助功能是两个独立的权限。'
        : ' 如实告诉用户做不了, 别猜坐标。');
  }
  return snap;
}

/**
 * 跑一段脚本。
 *
 * 注意每一步之后**不主动重新 dump** —— 那要几百毫秒, 20 步就是好几秒。
 * 只有两种情况才重新 dump: ① 这一步带了 expectChange (要验) ② 脚本跑完 (给现状)。
 */
export async function runComputerScript(
  args: ComputerRunArgs,
  ctx?: { signal?: AbortSignal },
): Promise<ComputerRunResult> {
  const steps = Array.isArray(args.steps) ? args.steps : [];

  /* 目标边界 —— 脚本级的 app 和**每一个 launch 步骤**的 app 都要过一遍:
   * 只查脚本级的话, `{app:'Calculator', steps:[{action:'launch', app:'Terminal'}]}` 就绕过去了。
   * (桥那层还会再判一次, 这里只是早一步 + 给模型一句能照做的话。) */
  const refuse = (code: string, message: string): ComputerRunResult => ({
    ok: false, app: args.app, ranSteps: 0, totalSteps: steps.length, totalMs: 0, failedAt: 0,
    steps: [{ index: 0, action: 'guard', ok: false, ms: 0, error: `${code}: ${message}` }],
  });
  for (const target of [args.app, ...steps.map((s) => s?.app)]) {
    const denied = guardComputerTarget(target);
    if (denied) return refuse(denied.code, denied.message);
    const byPolicy = checkComputerUsePolicy(target);
    if (byPolicy) return refuse(byPolicy.code, byPolicy.message);
  }

  /* 同一个 App 上只跑一路 —— 元素表是全局一张, 两路并发会互相把编号作废 (见 computerLock) */
  const startedAt = Date.now();
  publishComputerPointer({
    phase: 'move',
    action: 'session_start',
    app: args.app,
    label: `${steps.length} 步`,
  });
  const signal = mergeAbortSignals(ctx?.signal, beginComputerSession());
  try {
    try { await getOsBridge().request({ op: 'lock_user_input', app: args.app }); } catch { /* mac 无此 op; 锁失败不挡操作 */ }
    return await withAppLock(args.app, 'computer_run', () => runComputerScriptLocked(args, steps, { signal }));
  } finally {
    const stopped = !!signal?.aborted;
    /* 先发收场再开锁: 叠加层必须在鼠标回到用户之前关掉.
     * 即使用户已经点了退出 (桥那边先开过锁), 这里再 unlock 一次也是幂等的. */
    publishComputerPointer({
      phase: 'done',
      action: stopped ? 'user_stop' : 'session_end',
      app: args.app,
      label: `${Date.now() - startedAt}ms`,
    });
    try { await getOsBridge().request({ op: 'unlock_user_input' }); } catch { /* ignore */ }
  }
}

async function runComputerScriptLocked(
  args: ComputerRunArgs,
  steps: ComputerStep[],
  ctx?: { signal?: AbortSignal },
): Promise<ComputerRunResult> {
  const startedAt = Date.now();
  const budgetMs = args.timeoutMs ?? 60_000;
  const outcomes: ComputerStepOutcome[] = [];
  const bridge = getOsBridge();

  /* 脚本第一步就是"打开这个 App"时, 得先打开再感知 —— 否则第一次 snapshot 必然
   * 报 app_not_found, 整段脚本还没开始就挂了。 */
  const firstStep = steps[0];
  if (firstStep?.action === 'launch') {
    await bridge.request({ op: 'launch', app: firstStep.app ?? args.app });
  }

  const first = await snapshot(args.app, { maxAgeMs: firstSnapshotMaxAge(args.app) });
  if (!first.ok) {
    return {
      ok: false, ranSteps: 0, totalSteps: steps.length, totalMs: Date.now() - startedAt,
      failedAt: 0,
      steps: [{ index: 0, action: 'snapshot', ok: false, ms: Date.now() - startedAt,
                error: first.error, hint: (first as any).hint }],
    };
  }
  let current: BridgeDump = first;
  const appName = current.app;

  let screenDirty = false;
  /** 表情/图库这类大弹层开着时, 点「发送」会把字打进搜索框。提交前先 ESC。 */
  let overlayPickerOpen = false;

  /** 界面变过之后把编号重定位到新元素上。返回新编号, 或者一句说清楚的失败原因。 */
  async function remapTarget(target: number): Promise<{ id: number; remapped: boolean } | { error: string }> {
    const identity = identityOf.get(target);
    if (!identity) {
      /* 认不出这个编号 (模型自己编的, 或者早到被淘汰了) —— 原样放行,
       * 让桥去判。桥的元素表才是权威, 它会明确报 stale_handle。 */
      return { id: target, remapped: false };
    }
    const fresh = await snapshot(appName);
    if (!fresh.ok) return { error: `界面变化后重新感知失败: ${fresh.error}` };
    current = fresh;
    const hit = fresh.elements.find((e) => identityKey(e) === identity);
    if (!hit) {
      return { error: `界面变化后找不到原来那个元素了 (${identity.trim()}) —— 它可能已经不在当前界面上。`
        + ` 先 computer_snapshot 看一眼现在有什么, 再决定下一步。` };
    }
    return { id: hit.id, remapped: hit.id !== target };
  }

  function looksLikePicker(step: ComputerStep, dump: BridgeDump): boolean {
    const bits = `${step.label ?? ''} ${step.text ?? ''}`;
    if (/表情|emoji|@|菜单|更多|picker|gallery/i.test(bits)) return true;
    if (step.action === 'type' && String(step.text ?? '').includes('@')) return true;
    if (step.target != null) {
      const el = dump.elements.find((e) => e.id === step.target);
      if (el && /表情|emoji|菜单/i.test(`${el.label ?? ''} ${el.roleDesc ?? ''}`)) return true;
    }
    return false;
  }

  function looksLikeOverlayPicker(step: ComputerStep, dump: BridgeDump): boolean {
    const bits = `${step.label ?? ''} ${step.text ?? ''}`;
    if (/表情|emoji|菜单|gallery|picker/i.test(bits)) return true;
    if (step.target != null) {
      const el = dump.elements.find((e) => e.id === step.target);
      if (el && /表情|emoji|菜单/i.test(`${el.label ?? ''} ${el.roleDesc ?? ''}`)) return true;
    }
    return false;
  }

  function looksLikeCommit(step: ComputerStep, dump: BridgeDump): boolean {
    if (step.action === 'key' && /^(return|enter)$/i.test(String(step.key ?? '').trim())) return true;
    const bits = `${step.label ?? ''}`;
    if (/发送|send/i.test(bits)) return true;
    if (step.target != null) {
      const el = dump.elements.find((e) => e.id === step.target);
      if (el && /发送|send/i.test(`${el.label ?? ''} ${el.roleDesc ?? ''}`)) return true;
    }
    return false;
  }

  async function waitUntilTreeGrows(app: string, before: number): Promise<boolean> {
    const deadline = Date.now() + 1200;
    while (Date.now() < deadline) {
      lastDump = null;
      const d = await snapshot(app, { maxAgeMs: 0 });
      if (d.ok) {
        current = d;
        if (d.elements.length >= before + 1) return true;
      }
      await sleep(80);
    }
    return current.elements.length >= before + 1;
  }

  for (const [i, step] of steps.entries()) {
    if (ctx?.signal?.aborted) {
      outcomes.push({ index: i, action: step.action, label: step.label, ok: false, ms: 0, error: '用户中断' });
      return finish(false, i);
    }
    if (Date.now() - startedAt > budgetMs) {
      outcomes.push({ index: i, action: step.action, label: step.label, ok: false, ms: 0,
        error: `整段脚本超过 ${budgetMs}ms 预算, 停在第 ${i} 步` });
      return finish(false, i);
    }

    const t0 = Date.now();

    let effective = step;
    let remapNote: string | undefined;
    if (screenDirty && step.target !== undefined) {
      const mapped = await remapTarget(step.target);
      if ('error' in mapped) {
        outcomes.push({ index: i, action: step.action, label: step.label, ok: false,
          ms: Date.now() - t0, error: mapped.error });
        if (!step.optional) return finish(false, i);
        continue;
      }
      if (mapped.remapped) {
        remapNote = `界面变过, 编号 ${step.target} 已重定位到 ${mapped.id}`;
        effective = { ...step, target: mapped.id };
      }
      screenDirty = false;
    }

    if (overlayPickerOpen && looksLikeCommit(effective, current)) {
      await bridge.request({ op: 'key', key: 'escape' });
      overlayPickerOpen = false;
      lastDump = null;
      remapNote = [remapNote, '弹层还开着, 先 ESC 再提交'].filter(Boolean).join(' · ');
      if (effective.target !== undefined) {
        const mapped = await remapTarget(effective.target);
        if ('error' in mapped) {
          outcomes.push({ index: i, action: step.action, label: step.label, ok: false,
            ms: Date.now() - t0, error: mapped.error, hint: remapNote });
          if (!step.optional) return finish(false, i);
          continue;
        }
        if (mapped.remapped) {
          remapNote = `${remapNote} · 编号 ${effective.target} 已重定位到 ${mapped.id}`;
          effective = { ...effective, target: mapped.id };
        }
      }
    }

    /* 基线必须在动作**之前**取 —— 之后再取就永远"没变" */
    const watch = step.expectChange ? resolveWatch(step.expectChange.watch) : null;
    if (step.expectChange && !watch) {
      outcomes.push({
        index: i, action: step.action, label: step.label, ok: false, ms: Date.now() - t0,
        error: 'expectChange.watch 必须是 "screen"、{"label":"..."} 或 {"count":"AXRow"}',
      });
      if (!step.optional) return finish(false, i);
      continue;
    }
    const assertion = watch ? { ...step.expectChange!, watch } : undefined;
    const skipAssert = !!(assertion && skipElementAssertion(current, step));
    const baseline = assertion && !skipAssert ? signature(current, assertion.watch) : undefined;
    /* 'screen' 断言额外取一份"稳定文本集": 见 stableBaseline 的说明 (活的 App 会自己变)。
     * 跳过断言时千万别先付这两次 dump —— Java 快捷键上那就是 8–24 秒白烧。 */
    const stable = assertion && !skipAssert && assertion.watch === 'screen' ? await stableBaseline(appName) : undefined;

    const reply = await dispatch(effective, appName);
    const ms = Date.now() - t0;

    if (!reply.ok) {
      outcomes.push({ index: i, action: step.action, label: step.label, ok: false, ms,
        error: `${(reply as any).code}: ${reply.error}`, hint: (reply as any).hint });
      if (!step.optional) return finish(false, i);
      continue;
    }

    if (looksLikePicker(effective, current)) {
      const before = current.elements.length;
      const grew = await waitUntilTreeGrows(appName, before);
      lastDump = null;
      if (grew && looksLikeOverlayPicker(effective, current) && current.elements.length >= before + 8) {
        overlayPickerOpen = true;
      }
    } else {
      const next = steps[i + 1];
      const openedUi = effective.action === 'click_at' || effective.action === 'show_menu'
        || effective.action === 'hover';
      const usesOpened = next && (
        next.action === 'click_at' || next.action === 'hover' || next.action === 'type'
        || next.action === 'double_click' || next.action === 'key' || next.action === 'show_menu'
        || next.action === 'scroll' || next.action === 'drag'
      );
      if (openedUi && usesOpened) await sleep(OPEN_UI_SETTLE_MS);
    }

    if (assertion && skipAssert) {
      /* Java 菜单/设置窗弹出要几百毫秒。80ms 就 dump 会拍到主窗, 模型以为和弦没生效。 */
      const jabby = current.treeSource === 'jab' || current.treeSource === 'jab-skipped';
      await sleep(jabby ? 400 : 80);
      screenDirty = true;
      lastDump = null;
      outcomes.push({
        index: i, action: step.action, label: step.label, ok: true, ms: Date.now() - t0,
        hint: current.axBlind || step.action === 'click_at' || step.action === 'hover'
          || step.action === 'double_click' || step.action === 'drag'
          || step.action === 'scroll' || step.action === 'show_menu'
          || (step.action === 'type' && isRatioPoint(step))
          ? 'axBlind/click_at/hover: 跳过元素树断言（界面看截图，不等 6–8 秒空转）'
          : 'Java/key: 跳过元素树断言（弹出层对不上 JAB 签名，不等 6–8 秒空转）',
      });
      continue;
    }

    if (assertion) {
      let verdict = await awaitChange(assertion, baseline, appName, stable);
      let retryNote: string | undefined;

      const RETRYABLE = new Set(['click', 'press', 'focus']);
      if (!verdict.changed && RETRYABLE.has(step.action) && effective.target !== undefined) {
        const again = await remapTarget(effective.target);
        if (!('error' in again)) {
          retryNote = `第一次没生效 (Electron 的 AX 树刷新滞后), 重定位到 ${again.id} 后重做了一次`;
          await dispatch({ ...effective, target: again.id }, appName);
          /* 重试的等待窗口收窄 —— 两次都等满默认 6 秒 = 12 秒才报失败, 那比失败本身更劝退 */
          verdict = await awaitChange(
            { ...assertion, timeoutMs: Math.min(assertion.timeoutMs ?? DEFAULT_CHANGE_TIMEOUT, 3000) },
            baseline, appName, stable,
          );
        }
      }

      current = verdict.dump ?? current;
      if (verdict.changed) screenDirty = true;
      outcomes.push({
        index: i, action: step.action, label: step.label, ok: verdict.changed,
        ms: Date.now() - t0, error: verdict.changed ? undefined : verdict.reason,
        hint: [remapNote, retryNote].filter(Boolean).join(' · ') || undefined,
      });
      if (!verdict.changed && !step.optional) return finish(false, i);
      continue;
    }

    /* 没带断言的动作也可能改了界面 —— 保守地当作改过, 下一步会重定位一次。
     * 多一次 dump (几十~几百毫秒) 换掉"拿死句柄点空气"那种假成功, 值。
     * click_at 没有 target: 漏标的话收尾会把点之前的截图当结果, 模型以为没点动,
     * WPS 上就会 20 多次短脚本空转 (主题点了界面卡还是白的)。 */
    if (effective.target !== undefined
      || effective.action === 'key'
      || effective.action === 'type'
      || effective.action === 'click_at'
      || effective.action === 'hover'
      || effective.action === 'double_click'
      || effective.action === 'drag'
      || effective.action === 'scroll'
      || effective.action === 'show_menu') {
      screenDirty = true;
      if (effective.action === 'click_at' || effective.action === 'hover'
        || effective.action === 'double_click' || effective.action === 'drag'
        || effective.action === 'scroll' || effective.action === 'show_menu'
        || (effective.action === 'type' && isRatioPoint(effective))) lastDump = null;
    }
    if ((effective.action === 'key' || effective.action === 'type')
      && (current.treeSource === 'jab' || current.treeSource === 'jab-skipped')) {
      await sleep(400);
    }

    outcomes.push({
      index: i, action: step.action, label: step.label, ok: true, ms, hint: remapNote,
      slowHint: ms > SLOW_STEP_MS
        ? `这一步花了 ${(ms / 1000).toFixed(1)}s —— AX 动作正常只要几十到一百多毫秒。`
          + ` 如果是 Electron 系 App (QQ/VS Code 这类), 感知本身就慢, 那就更该一次多写几步。`
        : undefined,
    });
  }

  return finish(true);

  async function dispatch(step: ComputerStep, app: string): Promise<{ ok: boolean; error?: string } & Record<string, any>> {
    switch (step.action) {
      case 'launch': {
        /* 启动完界面必然是新的, 后面的编号一律要重定位 */
        const r = await bridge.request({ op: 'launch', app: step.app ?? args.app ?? app }) as any;
        if (r.ok) {
          screenDirty = true;
          const d = await snapshot(step.app ?? args.app ?? app);
          if (d.ok) current = d;
        }
        return r;
      }
      case 'click':
        /* AX 动作优先 (不动光标/不抢焦点/不受遮挡影响), 不支持才退回坐标点击 */
        return pressOrClick(step);
      case 'press':
        return bridge.request({ op: 'act', target: step.target, action: 'press' }) as any;
      case 'focus':
        return bridge.request({ op: 'act', target: step.target, action: 'focus' }) as any;
      case 'set_value': {
        const r = await bridge.request({
          op: 'act', target: step.target, action: 'setValue', text: step.text,
        }) as any;
        if (r.ok || r.code !== 'unsupported_action') return r;
        /* Chromium / 自绘框经常没有 ValuePattern. 退到键入, 别让整段脚本卡在这一步. */
        return bridge.request({
          op: 'type',
          app: args.app,
          text: step.text,
          ...(step.target !== undefined ? { target: step.target } : {}),
        }) as any;
      }
      case 'type':
        /* 有编号先聚焦再打; 自绘框用 dx/dy 点下去后同一段前台会话里键入. */
        return bridge.request({
          op: 'type',
          app: args.app,
          text: step.text,
          ...(step.target !== undefined ? { target: step.target } : {}),
          ...(step.dx !== undefined ? { dx: step.dx } : {}),
          ...(step.dy !== undefined ? { dy: step.dy } : {}),
        }) as any;
      case 'key': {
        const parsed = splitKeyChord(step.key, step.modifiers ?? []);
        return bridge.request({ op: 'key', key: parsed.key, modifiers: parsed.modifiers }) as any;
      }
      case 'click_at':
        /* 视觉兜底: 自绘 UI 读不到元素, 看截图按比例点。Windows 上会移动真光标。 */
        return bridge.request({ op: 'click_at', app: args.app, dx: step.dx, dy: step.dy }) as any;
      case 'hover':
        /* 只把光标移过去。功能区/下拉图库常靠停住才展开, 点下去反而关上。 */
        return bridge.request({ op: 'hover', app: args.app, dx: step.dx, dy: step.dy }) as any;
      case 'double_click':
        return bridge.request({
          op: 'double_click',
          app: args.app,
          ...(step.target !== undefined ? { target: step.target } : {}),
          ...(step.dx !== undefined ? { dx: step.dx } : {}),
          ...(step.dy !== undefined ? { dy: step.dy } : {}),
        }) as any;
      case 'drag':
        return bridge.request({
          op: 'drag', app: args.app, dx: step.dx, dy: step.dy, dx2: step.dx2, dy2: step.dy2,
        }) as any;
      case 'scroll':
        return bridge.request({
          op: 'scroll',
          app: args.app,
          ...(step.target !== undefined ? { target: step.target } : {}),
          ...(step.dx !== undefined ? { dx: step.dx } : {}),
          ...(step.dy !== undefined ? { dy: step.dy } : {}),
        }) as any;
      case 'show_menu':
        /* 右键 / 上下文菜单。有编号走元素; 自绘窗用 dx/dy 比例落点. */
        return bridge.request({
          op: 'show_menu',
          app: args.app,
          ...(step.target !== undefined ? { target: step.target } : {}),
          ...(step.dx !== undefined ? { dx: step.dx } : {}),
          ...(step.dy !== undefined ? { dy: step.dy } : {}),
        }) as any;
      case 'select_text':
        /* 选中文本元素里的一段。text 不给 = 全选; occurrence 用来消歧 (同一段文字出现多次)。 */
        return bridge.request({
          op: 'select_text', target: step.target,
          ...(step.text ? { find: step.text } : {}),
          ...(step.occurrence ? { occurrence: step.occurrence } : {}),
        }) as any;
      case 'snapshot': {
        const d = await snapshot(app, { maxAgeMs: screenDirty ? 0 : FRESH_ENOUGH_MS });
        if (d.ok) current = d;
        return d as any;
      }
      case 'wait':
        return { ok: false, error: '没有 wait 这个动作 —— 用 expectChange 代替, 它每 250ms 轮询一次, 界面一变立刻继续' };
      default:
        return { ok: false, error: `未知动作 "${(step as ComputerStep).action}"` };
    }
  }

  async function pressOrClick(step: ComputerStep) {
    const r = await bridge.request({ op: 'act', target: step.target, action: 'press' }) as any;
    if (r.ok) return r;
    /* 元素还在但不支持 AXPress → 退回后台坐标点击。元素已经没了 (stale) 就别退了,
     * 那是编号过期, 退回去点的是一个空坐标。 */
    if (r.code === 'unsupported_action') {
      return bridge.request({ op: 'click', target: step.target }) as any;
    }
    return r;
  }

  async function stableBaseline(app: string): Promise<ScreenBaseline | null> {
    /* 第一次采样复用刚拿到的那份 —— 上一步刚 dump 过, 再来一次纯属重复 (一次 1 秒起) */
    const a = await snapshot(app, { maxAgeMs: FRESH_ENOUGH_MS });
    if (!a.ok) return null;
    await new Promise((r) => setTimeout(r, 120));
    const b = await snapshot(app);
    if (!b.ok) return null;
    current = b;
    const sa = contentLabels(a);
    const sb = contentLabels(b);
    const stable = new Set<string>();
    for (const s of sa) if (sb.has(s)) stable.add(s);
    /* seen = 两次采样里出现过的**全部**文本。判"新面孔"要拿它做底:
     * 只拿交集当底的话, 自己在跳的文本 (时钟/未读数) 每一轮都算新的。 */
    const seen = new Set<string>([...sa, ...sb]);
    return stable.size ? { stable, seen } : null;
  }

  async function awaitChange(
    assertion: ComputerChangeAssertion,
    baseline: string | null | undefined,
    app: string,
    base?: ScreenBaseline | null,
  ): Promise<{ changed: boolean; reason?: string; dump?: BridgeDump }> {
    if (assertion.watch === 'screen') {
      const stable = base?.stable;
      const seen = base?.seen ?? new Set<string>();
      if (!stable) {
        return { changed: false,
          reason: '取不到稳定的界面基线 (这个 App 的文本一直在自己变, 或者根本没有可读文本)。'
            + ' 换一个精确的观测目标: expectChange.watch = {"label":"某个只在目标界面才有的文字"} 或 {"count":"AXRow"}。' };
      }
      const deadline = Date.now() + (assertion.timeoutMs ?? DEFAULT_CHANGE_TIMEOUT);
      let bestGone = 0;
      /* 上一轮看到的"新面孔"。见下面 appeared 的说明。 */
      let lastNew: Set<string> = new Set();
      while (Date.now() < deadline) {
        if (ctx?.signal?.aborted) {
          return { changed: false, reason: '用户中断' };
        }
        /* 轮询走**轻量签名**, 不走完整 dump —— 断言只要文本, 而完整 dump 每轮要多付
         * 每节点一趟 actions IPC + 几百个元素的序列化 (QQ 上 0.6~3 秒一次)。 */
        const sig = await signatureProbe(app);
        if (sig) {
          let gone = 0;
          for (const s of stable) if (!sig.texts.has(s)) gone++;
          bestGone = Math.max(bestGone, gone);

          const fresh = new Set<string>();
          for (const t of sig.texts) if (!seen.has(t)) fresh.add(t);
          let confirmedNew = false;
          for (const t of fresh) if (lastNew.has(t)) { confirmedNew = true; break; }
          lastNew = fresh;

          if (gone >= SCREEN_CHANGE_MIN_GONE || confirmedNew) {
            return { changed: true };
          }
        }
        await pollGap(app);
      }
      return { changed: false,
        reason: `点了没反应: 界面上 ${stable.size} 条稳定文本一条没少, 也没出现新内容 (不是"找不到元素")。`
          + ` 常见真因: 界面本来就在目标状态 / 点的是只展开不跳转的菜单组 /`
          + ` 编号来自过时的 snapshot (Electron 系 App 重绘后旧句柄会**静默失效**: 动作报成功, 界面纹丝不动)。`
          + ` 先 computer_snapshot 看一眼现在是什么样。` };
    }
    if (baseline === null) {
      return { changed: false,
        reason: '动作前就取不到这个观测目标 (标签写错了, 或元素本来就不在) —— 这是"目标找不到", 不是"界面没变"。先 snapshot 看一眼再改。' };
    }
    const deadline = Date.now() + (assertion.timeoutMs ?? DEFAULT_CHANGE_TIMEOUT);
    while (Date.now() < deadline) {
      if (ctx?.signal?.aborted) {
        return { changed: false, reason: '用户中断' };
      }
      const sig = await signatureProbe(app);
      if (sig) {
        const now = signatureFromProbe(sig, assertion.watch);
        if (now !== null && now !== baseline) {
          /* 同上: 变了先记着, 完整 dump 留给真正要编号的地方 */
          return { changed: true };
        }
      }
      await pollGap(app);
    }
    return { changed: false,
      reason: `动作执行了, 但界面在 ${assertion.timeoutMs ?? DEFAULT_CHANGE_TIMEOUT}ms 内没有出现预期变化 —— 这是"点了没反应", 不是"元素找不到"。`
        + ` 常见真因: 点的是个折叠菜单组(只展开不跳转) / 界面本来就已经在目标状态 / 观测目标选错了 /`
        + ` 编号来自一次过时的 snapshot (Electron 系 App 重绘后旧句柄会**静默失效**: 动作报成功, 界面纹丝不动)。`
        + ` 先 computer_snapshot 看一眼现在是什么样, 再决定下一步。` };
  }

  async function finish(ok: boolean, failedAt?: number): Promise<ComputerRunResult> {
    const result: ComputerRunResult = {
      ok, app: appName, ranSteps: outcomes.length, totalSteps: steps.length,
      totalMs: Date.now() - startedAt, failedAt, steps: outcomes,
    };
    /* 收尾的现状允许复用 —— 断言通过的那一刻刚 dump 过, 再来一次就是白等一秒 */
    const final = await snapshot(appName, { maxAgeMs: screenDirty ? 0 : FRESH_ENOUGH_MS });
    if (final.ok) result.screen = await withBlindScreenshot(toSnapshot(final), appName);
    cliLogger.info('COMPUTER_RUN',
      `${ok ? 'ok' : `failed@${failedAt}`} ${outcomes.length}/${steps.length} 步 ${result.totalMs}ms`);
    return result;
  }
}

/** 单独的感知调用 —— 写脚本之前先看一眼。 */
export async function computerSnapshot(app?: string): Promise<ComputerSnapshot | { ok: false; error: string; code: string; hint?: string }> {
  const denied = guardComputerTarget(app);
  if (denied) return { ok: false, code: denied.code, error: denied.message };
  const byPolicy = checkComputerUsePolicy(app);
  if (byPolicy) return { ok: false, code: byPolicy.code, error: byPolicy.message };
  /* 锁: 感知也要排队 —— dump 会推进 epoch 把别人的编号作废, 它跟动作一样会互相踩.
   * snapshot 也要亮遮罩: 模型经常先看一眼再动手, 那几秒用户必须看见蓝罩. */
  publishComputerPointer({
    phase: 'move',
    action: 'session_start',
    app: app ?? '',
    label: 'snapshot',
  });
  /* 不发 session_end: 看一眼和随后的 computer_run 是同一段操控, 罩子保持 driving.
   * 收场只发生在 computer_run 结束 / 用户退出 — 立刻关罩, 不再改成可点. */
  return await withAppLock(app, 'computer_snapshot', () => computerSnapshotLocked(app));
}

async function computerSnapshotLocked(app?: string): Promise<ComputerSnapshot | { ok: false; error: string; code: string; hint?: string }> {
  const d = await snapshot(app);
  if (!d.ok) return d as any;
  /* AX 读不到元素 (自绘 UI / 模态窗卡住辅助功能) → **给眼睛**。
   * 不给的话模型只能回一句"这个应用不支持", 而它本来是能看图操作的。
   * 截图只在这种时候取: 能读元素时它既贵又没用。 */
  return withBlindScreenshot(toSnapshot(d), app);
}

export type { BridgeElement };
