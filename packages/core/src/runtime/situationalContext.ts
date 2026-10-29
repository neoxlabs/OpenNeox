
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { getUnfinishedPlanSteps } from '../tools/updatePlan.js';
import { listDevicePresence, type DevicePresence } from './devicePresence.js';
import { listPendingConfirmations, type PendingConfirmation } from './pendingConfirmations.js';
import { InterruptedRunStore, type InterruptedRunRecord } from './store/InterruptedRunStore.js';

export type SituationalLang = 'zh' | 'en';

type DeviceKind = DevicePresence['kind'];

/** 快要被塞进 <open-loops> 的一条。 */
export interface OpenLoopView {
  state: 'running' | 'waiting' | 'blocked';
  /** 一句话说清在做什么 / 在等什么 */
  title: string;
  detail?: string;
  ageMs?: number;
}

/** 测试 / 宿主可直接给源, 不传就从注册表和库里读。 */
export interface OpenLoopSources {
  planSteps?: string[];
  pending?: PendingConfirmation[];
  interrupted?: InterruptedRunRecord | null;
}

const MAX_DEVICES = 4;
const MAX_LOOPS = 5;
const TITLE_MAX = 80;
const DETAIL_MAX = 120;

/* ────────────────────────── 格式化 ────────────────────────── */

/** `<device-state>` 段; 没有任何设备信息时返回 ''。 */
export function formatDeviceStateBlock(
  devices: DevicePresence[],
  lang: SituationalLang = 'zh',
  now: number = Date.now(),
): string {
  if (!devices || devices.length === 0) return '';
  const en = lang === 'en';
  const lines = devices.slice(0, MAX_DEVICES).map((d) => {
    const label = deviceLabel(d, en);
    const facts: string[] = [d.online ? (en ? 'online' : '在线') : offlineText(d, now, en)];
    if (d.online && typeof d.batteryPct === 'number') {
      facts.push(en ? `battery ${d.batteryPct}%${d.charging ? ' (charging)' : ''}` : `电量 ${d.batteryPct}%${d.charging ? '（充电中）' : ''}`);
    }
    if (d.online && d.network) facts.push(networkText(d.network, en));
    return `- ${label}: ${facts.join(' · ')}`;
  });
  const note = en
    ? 'Note: do not send work to a device that is offline — say plainly that it is not connected.'
    : '注: 不在线的设备派不了活, 直接跟用户说它没连着。';
  return [`<device-state>`, ...lines, note, `</device-state>`].join('\n');
}

/** `<open-loops>` 段; 没有未完成的事时返回 ''。 */
export function formatOpenLoopsBlock(
  loops: OpenLoopView[],
  lang: SituationalLang = 'zh',
): string {
  if (!loops || loops.length === 0) return '';
  const en = lang === 'en';
  const lines = loops.slice(0, MAX_LOOPS).map((loop) => {
    const label = en
      ? ({ running: 'in progress', waiting: 'waiting for you', blocked: 'blocked' } as const)[loop.state]
      : ({ running: '进行中', waiting: '等你确认', blocked: '卡住了' } as const)[loop.state];
    const title = clip(loop.title, TITLE_MAX);
    const bits: string[] = [title];
    if (loop.ageMs && loop.ageMs > 60_000) {
      bits.push(en ? `${formatAge(loop.ageMs, true)} ago` : `${formatAge(loop.ageMs, false)}前`);
    }
    if (loop.detail) bits.push(`(${clip(loop.detail, DETAIL_MAX)})`);
    return `- ${label}: ${bits.join(' ')}`;
  });
  const note = en
    ? 'Note: if the user is chasing one of these, pick it up; otherwise do not bring them up unprompted.'
    : '注: 用户如果是在催上面某件事, 接着做; 跟当前话无关就不要主动提。';
  return [`<open-loops>`, ...lines, note, `</open-loops>`].join('\n');
}

/** 两块拼一起 (空缺的块自动跳过); 全部为空时返回 ''。 */
export function buildSituationalBlock(
  input: { devices?: DevicePresence[]; loops?: OpenLoopView[] },
  lang: SituationalLang = 'zh',
  now: number = Date.now(),
): string {
  return [
    formatDeviceStateBlock(input.devices ?? [], lang, now),
    formatOpenLoopsBlock(input.loops ?? [], lang),
  ].filter(Boolean).join('\n\n');
}

/* ────────────────────────── 采集 ────────────────────────── */

export function collectOpenLoops(
  sessionId: string,
  now: number = Date.now(),
  sources?: OpenLoopSources,
): OpenLoopView[] {
  if (!sessionId) return [];
  const loops: OpenLoopView[] = [];

  const planSteps = sources?.planSteps ?? safePlanSteps(sessionId);
  if (planSteps.length > 0) {
    const [first, ...rest] = planSteps;
    loops.push({
      state: 'running',
      title: first,
      detail: rest.length > 0 ? `还剩 ${planSteps.length} 步: ${planSteps.slice(0, 2).join(' / ')}` : undefined,
    });
  }

  const pending = sources?.pending ?? safePending(sessionId, now);
  for (const p of pending) {
    loops.push({
      state: 'waiting',
      title: p.title || (p.kind === 'approval' && p.toolName ? `是否允许 ${p.toolName}` : '等你回答一个问题'),
      detail: p.kind === 'approval' ? '点了同意才会继续' : undefined,
    });
  }

  const interrupted = sources ? sources.interrupted : readOpenTurn(sessionId);
  if (interrupted) {
    const title = excerptPrompt(interrupted.prompt);
    if (title) {
      loops.push({
        state: 'running',
        title,
        detail: interrupted.status === 'errored' ? '上次出错了, 没做完' : '上次没做完 (进程断了或被换掉)',
        ageMs: Math.max(0, now - (interrupted.lastHeartbeatAt || interrupted.startedAt)),
      });
    }
  }

  return loops;
}

/** 每轮主入口: 返回要追加到用户消息尾部的块 (没有就是 '')。 */
export function buildSituationalBlockForSession(
  sessionId: string,
  now: number = Date.now(),
): string {
  if (!sessionId) return '';
  const lang = resolveLang();
  const devices = listDevicePresence(now);
  const loops = collectOpenLoops(sessionId, now);
  return buildSituationalBlock({ devices, loops }, lang, now);
}

/**
 * 拼到用户消息尾部。**失败一律当作没有** —— 补上下文不能把正常对话拖死。
 * 注意: 主机 (runner) 会把注入版用户消息写回历史, 旧轮次的块会跟着历史保留;
 * 判重时由 kernel 的 stripInjectedTimeTail 一并剥掉。
 */
export function appendSituationalContext(prompt: string, sessionId: string): string {
  try {
    const block = buildSituationalBlockForSession(sessionId);
    return block ? `${prompt}\n\n${block}` : prompt;
  } catch {
    return prompt;
  }
}

/* ────────────────────────── 内部 ────────────────────────── */

function resolveLang(): SituationalLang {
  try { return (loadConfig() as { language?: string }).language === 'en' ? 'en' : 'zh'; } catch { return 'zh'; }
}

function safePlanSteps(sessionId: string): string[] {
  try { return getUnfinishedPlanSteps(sessionId); } catch { return []; }
}

function safePending(sessionId: string, now: number): PendingConfirmation[] {
  try { return listPendingConfirmations(sessionId, now); } catch { return []; }
}

/** 仅测试用: 替掉 interrupted_runs 读取, 避免单测去碰真实 ~/.neox 库。 */
let interruptedRunReaderForTesting: ((sessionId: string) => InterruptedRunRecord | null) | null = null;
export function __setInterruptedRunReaderForTesting(
  reader: ((sessionId: string) => InterruptedRunRecord | null) | null,
): void {
  interruptedRunReaderForTesting = reader;
}

function readOpenTurn(sessionId: string): InterruptedRunRecord | null {
  try {
    if (interruptedRunReaderForTesting) return interruptedRunReaderForTesting(sessionId);
    /* workDir 只是 findStaleRunning 的过滤条件, findOpenTurn 用不到; 传空串避免额外依赖 */
    return new InterruptedRunStore(getDatabase(), '').findOpenTurn(sessionId);
  } catch {
    /* CLI / 测试 / db 未初始化 —— 没有持久化信号就不注入这一条 */
    return null;
  }
}

export function excerptPrompt(prompt: string): string {
  const clean = String(prompt ?? '')
    .replace(/\s*<current-time>[^<]*<\/current-time>\s*/g, '\n')
    .replace(/\s*<(device-state|open-loops)>[\s\S]*?<\/\1>\s*/g, '\n')
    .replace(/\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '\n')
    .trim();
  const firstLine = clean.split(/\n+/).map((l) => l.trim()).filter(Boolean)[0] ?? '';
  return clip(firstLine, 60);
}

function deviceLabel(d: DevicePresence, en: boolean): string {
  const fallback = d.kind === 'desktop' ? (en ? 'computer' : '电脑') : (en ? 'phone' : '手机');
  if (!d.name) return fallback;
  return `${fallback} ${clip(d.name, 40)}`;
}

function offlineText(d: DevicePresence, now: number, en: boolean): string {
  const age = Math.max(0, now - d.lastSeenAt);
  if (age < 60_000) return en ? 'offline' : '离线';
  return en ? `offline, last seen ${formatAge(age, true)} ago` : `离线, ${formatAge(age, false)}前还连着`;
}

function networkText(network: string, en: boolean): string {
  const table: Record<string, string> = en
    ? { wifi: 'Wi-Fi', cellular: 'cellular', ethernet: 'ethernet', offline: 'no network', online: 'network up' }
    : { wifi: 'Wi-Fi', cellular: '移动网络', ethernet: '有线网络', offline: '没网', online: '有网' };
  return table[network] ?? clip(network, 20);
}

function formatAge(ms: number, en: boolean): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return en ? `${Math.max(1, min)} min` : `${Math.max(1, min)} 分钟`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return en ? `${hours} h` : `${hours} 小时`;
  return en ? `${Math.floor(hours / 24)} d` : `${Math.floor(hours / 24)} 天`;
}

function clip(text: string, max: number): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}
