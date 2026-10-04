
import { randomUUID } from 'crypto';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getBackgroundTaskNotifier } from './backgroundTaskNotifier.js';
import { getScheduledWakeupRegistry } from './scheduledWakeupRegistry.js';
/* 同属"重启后还认得"的那一组, 从这里一并导出 (server/main.ts 一行 import 拿全) */
export { PersistentChatMetaMap } from './watcherStore.js';

export type MonitorTrigger =
  | { type: 'output'; pid: number; pattern: string }
  | { type: 'poll'; command: string; intervalSeconds: number; until: 'success' | 'match' | 'change'; pattern?: string }
  | { type: 'file'; path: string };

export interface MonitorSpec {
  sessionId: string;
  /** 一句话说在盯什么, 系统通知标题和列表里都用它 */
  label: string;
  /** 命中时 agent 要做什么 */
  prompt: string;
  trigger: MonitorTrigger;
  maxFires?: number;
  timeoutSeconds?: number;
  /** poll 命令的工作目录 */
  cwd?: string;
}

export interface MonitorInfo {
  id: string;
  sessionId: string;
  label: string;
  prompt: string;
  trigger: MonitorTrigger;
  fires: number;
  maxFires: number;
  createdAt: number;
  expiresAt: number;
  lastFiredAt?: number;
  /** poll 命令的工作目录 (重启后接着跑要用) */
  cwd?: string;
}

/** 外部能力 —— 注入进来, 单测不碰真进程 / 真文件系统 */
export interface MonitorDeps {
  onProcessOutput(cb: (pid: number, text: string) => void): () => void;
  onProcessEnd(cb: (pid: number) => void): () => void;
  isProcessRunning(pid: number): boolean;
  runCommand(command: string, cwd: string | undefined): Promise<{ exitCode: number; output: string }>;
  watchPath(path: string, onChange: (file: string | null) => void): { close(): void };
  /** 落盘 —— 不给就是纯内存 (CLI / 单测) */
  store?: { load(): MonitorInfo[]; save(all: MonitorInfo[]): void };
}

/* 列表变了就广播 (界面药丸靠它) —— 模块级, 注册顺序跟 registry 何时建出来无关 */
const changeListeners = new Set<(sessionId: string, list: MonitorInfo[]) => void>();
export function onMonitorsChanged(cb: (sessionId: string, list: MonitorInfo[]) => void): () => void {
  changeListeners.add(cb);
  return () => { changeListeners.delete(cb); };
}

export const MAX_PER_SESSION = 10;
export const MAX_FIRES = 50;
export const DEFAULT_TIMEOUT_SECONDS = 1800;
export const MAX_TIMEOUT_SECONDS = 86400;
export const MIN_POLL_SECONDS = 10;
export const MAX_POLL_SECONDS = 3600;
const OUTPUT_COALESCE_MS = 2000;
export const FIRE_COOLDOWN_MS = 60_000;
const FILE_DEBOUNCE_MS = 1500;
const MAX_DETAIL_LINES = 20;
const MAX_LINE_CHARS = 2000;
const FILE_IGNORE = /(^|[\\/])(node_modules|\.git|\.DS_Store)([\\/]|$)/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

interface Live extends MonitorInfo {
  cleanup: Array<() => void>;
  /* output: 半行缓存 + 待合并的命中行 */
  carry: string;
  pendingLines: string[];
  coalesceTimer?: NodeJS.Timeout;
  /* poll: 上一次条件是否成立 / 上一次输出 (change 用) */
  lastHolds?: boolean;
  baseline?: string;
  polling?: boolean;
  /* file: 这一批改动的文件 */
  changed: Set<string>;
  debounceTimer?: NodeJS.Timeout;
}

export class MonitorRegistry {
  private monitors = new Map<string, Live>();

  constructor(private readonly deps: MonitorDeps) {
    if (deps.store) this.restore(deps.store.load());
  }

  /** 校验 + 登记。返回 error 字符串 = 没开成 (参数不对 / 超上限), 调用方原样告诉模型。 */
  start(spec: MonitorSpec): { id: string; info: MonitorInfo } | { error: string } {
    const label = String(spec.label ?? '').trim();
    const prompt = String(spec.prompt ?? '').trim();
    if (!label) return { error: 'label is required (one line: what you are watching for).' };
    if (!prompt) return { error: 'prompt is required (what to do when it fires).' };
    if (this.listForSession(spec.sessionId).length >= MAX_PER_SESSION) {
      return { error: `This session already has ${MAX_PER_SESSION} active monitors. Stop one with monitor_stop first.` };
    }
    const trig = spec.trigger;
    let regex: RegExp | undefined;
    if (trig.type === 'output' || (trig.type === 'poll' && trig.until === 'match')) {
      const pattern = String(trig.pattern ?? '');
      if (!pattern) return { error: 'pattern is required for this trigger.' };
      try { regex = new RegExp(pattern, 'i'); } catch (e: any) {
        return { error: `pattern is not a valid regular expression: ${e?.message ?? e}` };
      }
    }
    if (trig.type === 'output') {
      if (!Number.isInteger(trig.pid) || trig.pid <= 0) return { error: 'pid must be the pid of a running background process.' };
      if (!this.deps.isProcessRunning(trig.pid)) {
        return { error: `Process ${trig.pid} is not running (it may have exited already — read it with bash_output instead).` };
      }
    }
    if (trig.type === 'poll' && !String(trig.command ?? '').trim()) return { error: 'command is required for a poll trigger.' };
    if (trig.type === 'file' && !String(trig.path ?? '').trim()) return { error: 'path is required for a file trigger.' };

    const now = Date.now();
    const timeout = clamp(spec.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, 60, MAX_TIMEOUT_SECONDS);
    const normalized: MonitorTrigger = trig.type === 'poll'
      ? { ...trig, intervalSeconds: clamp(trig.intervalSeconds ?? 60, MIN_POLL_SECONDS, MAX_POLL_SECONDS) }
      : trig;
    const m = toLive({
      id: `mon-${randomUUID().slice(0, 8)}`,
      sessionId: spec.sessionId,
      label,
      prompt,
      trigger: normalized,
      fires: 0,
      maxFires: clamp(spec.maxFires ?? 1, 1, MAX_FIRES),
      createdAt: now,
      expiresAt: now + timeout * 1000,
      cwd: spec.cwd,
    });
    const err = this.activate(m, regex);
    if (err) return { error: `Could not start the monitor: ${err}` };
    cliLogger.info('MONITOR', `start ${m.id} session=${m.sessionId} ${describeTrigger(normalized)} — ${label.slice(0, 60)}`);
    return { id: m.id, info: publicInfo(m) };
  }

  /** 登记 + 挂到期计时 + 开始盯。返回错误文案 = 没开成 (已撤掉) */
  private activate(m: Live, regex: RegExp | undefined): string | null {
    this.monitors.set(m.id, m);
    const expiry = setTimeout(() => this.expire(m.id), Math.max(0, m.expiresAt - Date.now()));
    expiry.unref?.();
    m.cleanup.push(() => clearTimeout(expiry));
    try {
      const t = m.trigger;
      if (t.type === 'output') this.armOutput(m, t.pid, regex!);
      else if (t.type === 'poll') this.armPoll(m, t, regex, m.cwd);
      else this.armFile(m, t.path);
    } catch (e: any) {
      /* 路径不存在等 —— 没开成就如实说, 不假装在盯 */
      this.dispose(m, 'arm failed');
      return String(e?.message ?? e);
    }
    this.changed(m.sessionId);
    return null;
  }

  /** 应用重启后接着盯 (见文件头"重启") */
  private restore(saved: MonitorInfo[]): void {
    const now = Date.now();
    for (const info of saved) {
      const note = (detail: string): void => {
        getBackgroundTaskNotifier().enqueueMessageForSession(info.sessionId,
          buildMonitorXml(toLive(info), detail, 'ended', 'timeout'),
          { kind: 'monitor', command: `monitor: ${info.label.slice(0, 60)}`, noAutoResume: true });
      };
      if (info.expiresAt <= now) {
        if (info.fires === 0) note('Expired while Neox was closed — the condition was never seen.');
        continue;
      }
      if (info.trigger.type === 'output') {
        note(`Stopped: Neox restarted and the output of pid ${info.trigger.pid} can no longer be followed. Start a new monitor if you still need it.`);
        continue;
      }
      const t = info.trigger;
      const regex = t.type === 'poll' && t.until === 'match' && t.pattern ? safeRegex(t.pattern) : undefined;
      const err = this.activate(toLive(info), regex);
      cliLogger.info('MONITOR', `restore ${info.id} ${err ? `failed: ${err}` : 'ok'}`);
    }
    this.persist();
  }

  private changed(sessionId: string): void {
    this.persist();
    const list = this.listForSession(sessionId);
    for (const cb of changeListeners) { try { cb(sessionId, list); } catch { /* 监听方的问题不影响监控 */ } }
  }

  private persist(): void {
    try { this.deps.store?.save(this.listAll()); } catch (e: any) {
      cliLogger.warn('MONITOR', `persist failed: ${e?.message ?? e}`);
    }
  }

  stop(id: string): boolean {
    const m = this.monitors.get(id);
    if (!m) return false;
    this.dispose(m, 'stopped');
    return true;
  }

  listForSession(sessionId: string): MonitorInfo[] {
    return [...this.monitors.values()].filter((m) => m.sessionId === sessionId).map(publicInfo);
  }

  listAll(): MonitorInfo[] {
    return [...this.monitors.values()].map(publicInfo);
  }

  cancelAllForSession(sessionId: string): number {
    let n = 0;
    for (const m of [...this.monitors.values()]) {
      if (m.sessionId === sessionId) { this.dispose(m, 'session ended'); n++; }
    }
    return n;
  }

  // ── 三种触发 ──────────────────────────────────────────────

  private armOutput(m: Live, pid: number, regex: RegExp): void {
    m.cleanup.push(this.deps.onProcessOutput((p, text) => {
      if (p !== pid || !this.monitors.has(m.id)) return;
      const lines = (m.carry + text).split(/\r?\n/);
      m.carry = lines.pop() ?? '';
      if (m.carry.length > MAX_LINE_CHARS) m.carry = m.carry.slice(-MAX_LINE_CHARS);
      for (const raw of lines) {
        const line = raw.replace(ANSI, '').slice(0, MAX_LINE_CHARS);
        if (!regex.test(line)) continue;
        if (m.pendingLines.length < MAX_DETAIL_LINES) m.pendingLines.push(line);
        if (!m.coalesceTimer) {
          m.coalesceTimer = setTimeout(() => {
            m.coalesceTimer = undefined;
            const hit = m.pendingLines.splice(0);
            if (hit.length) this.fire(m, `Matched ${hit.length} line(s) in the output of pid ${pid}:\n${hit.join('\n')}`);
          }, Math.max(OUTPUT_COALESCE_MS, cooldownLeft(m)));
        }
      }
    }));
    /* 进程没了 → 这个监控也就没意义了。进程退出本身总线会另发一条 process 事件, 这里不重复叫醒。 */
    m.cleanup.push(this.deps.onProcessEnd((p) => {
      if (p !== pid || !this.monitors.has(m.id)) return;
      /* 最后半行 + 合并窗口里还没发的, 先发掉再停 */
      if (m.carry && regex.test(m.carry.replace(ANSI, ''))) m.pendingLines.push(m.carry.replace(ANSI, ''));
      const hit = m.pendingLines.splice(0);
      if (hit.length) this.fire(m, `Matched ${hit.length} line(s) in the output of pid ${pid}:\n${hit.join('\n')}`);
      if (this.monitors.has(m.id)) this.dispose(m, 'process exited');
    }));
    m.cleanup.push(() => { if (m.coalesceTimer) clearTimeout(m.coalesceTimer); });
  }

  private armPoll(m: Live, trig: Extract<MonitorTrigger, { type: 'poll' }>, regex: RegExp | undefined, cwd: string | undefined): void {
    let timer: NodeJS.Timeout | undefined;
    const tick = async (): Promise<void> => {
      if (!this.monitors.has(m.id) || m.polling) return;
      m.polling = true;
      let res: { exitCode: number; output: string };
      try {
        res = await this.deps.runCommand(trig.command, cwd);
      } catch (e: any) {
        res = { exitCode: -1, output: String(e?.message ?? e) };
      } finally {
        m.polling = false;
      }
      if (!this.monitors.has(m.id)) return;
      const output = res.output.replace(ANSI, '');
      /* 冷却期内不触发, 也不挪基线 / 状态 —— 冷却一过, 下一次检查按当时的情况补发 */
      const cooling = cooldownLeft(m) > 0;
      if (trig.until === 'change') {
        if (m.baseline === undefined) m.baseline = output;
        else if (output !== m.baseline && !cooling) {
          m.baseline = output;
          this.fire(m, `Output of \`${trig.command}\` changed:\n${tail(output)}`);
        }
      } else {
        const holds = trig.until === 'success' ? res.exitCode === 0 : regex!.test(output);
        /* 只在"由假变真"那一下触发 —— 条件一直成立就不会每轮都叫 */
        const rising = holds && m.lastHolds !== true;
        if (rising && !cooling) {
          this.fire(m, `\`${trig.command}\` ${trig.until === 'success' ? 'succeeded (exit 0)' : 'output matched'}:\n${tail(output)}`);
        }
        if (!(rising && cooling)) m.lastHolds = holds;
      }
      if (this.monitors.has(m.id)) {
        timer = setTimeout(() => { void tick(); }, trig.intervalSeconds * 1000);
        timer.unref?.();
      }
    };
    m.cleanup.push(() => { if (timer) clearTimeout(timer); });
    void tick();
  }

  /** watchPath 抛错 (路径不存在等) 直接往上抛, start 会撤掉并返回 error */
  private armFile(m: Live, path: string): void {
    const watcher = this.deps.watchPath(path, (file) => {
      if (!this.monitors.has(m.id)) return;
      if (file && FILE_IGNORE.test(file)) return;
      if (file && m.changed.size < MAX_DETAIL_LINES) m.changed.add(file);
      if (m.debounceTimer) clearTimeout(m.debounceTimer);
      m.debounceTimer = setTimeout(() => {
        m.debounceTimer = undefined;
        const files = [...m.changed];
        m.changed.clear();
        this.fire(m, files.length ? `Changed under ${path}:\n${files.join('\n')}` : `Something changed under ${path}.`);
      }, Math.max(FILE_DEBOUNCE_MS, cooldownLeft(m)));
    });
    m.cleanup.push(() => { watcher.close(); if (m.debounceTimer) clearTimeout(m.debounceTimer); });
  }

  // ── 投递 ──────────────────────────────────────────────

  private fire(m: Live, detail: string): void {
    if (!this.monitors.has(m.id)) return;
    m.fires += 1;
    m.lastFiredAt = Date.now();
    const last = m.fires >= m.maxFires;
    const xml = buildMonitorXml(m, detail, last ? 'ended' : 'still watching', 'fired');
    getBackgroundTaskNotifier().enqueueMessageForSession(m.sessionId, xml, {
      kind: 'monitor',
      command: `monitor: ${m.label.slice(0, 60)}`,
      status: 'completed',
      osNotice: { title: `监控命中 · ${m.label}`, body: firstLine(detail), urgency: 'info' },
    });
    cliLogger.info('MONITOR', `fire ${m.id} (${m.fires}/${m.maxFires}) — ${firstLine(detail).slice(0, 80)}`);
    if (last) this.dispose(m, 'max fires reached');
    else this.changed(m.sessionId);
  }

  private expire(id: string): void {
    const m = this.monitors.get(id);
    if (!m) return;
    /* 一次都没命中就到点: 这本身就是信息 (等的东西没来), 叫醒 agent 说一声 */
    if (m.fires === 0) {
      const minutes = Math.round((m.expiresAt - m.createdAt) / 60000);
      const xml = buildMonitorXml(m, `Timed out after ${minutes} min — the condition never occurred.`, 'ended', 'timeout');
      getBackgroundTaskNotifier().enqueueMessageForSession(m.sessionId, xml, {
        kind: 'monitor',
        command: `monitor: ${m.label.slice(0, 60)}`,
        status: 'completed',
        osNotice: { title: `监控到期 · ${m.label}`, body: `${minutes} 分钟内没有出现`, urgency: 'warning' },
      });
    }
    this.dispose(m, 'timeout');
  }

  private dispose(m: Live, why: string): void {
    if (!this.monitors.delete(m.id)) return;
    for (const fn of m.cleanup) { try { fn(); } catch { /* ignore */ } }
    cliLogger.info('MONITOR', `end ${m.id} (${why})`);
    this.changed(m.sessionId);
  }
}

function toLive(info: MonitorInfo): Live {
  return { ...info, cleanup: [], carry: '', pendingLines: [], changed: new Set() };
}

function safeRegex(pattern: string): RegExp | undefined {
  try { return new RegExp(pattern, 'i'); } catch { return undefined; }
}

// ── helpers ─────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

function cooldownLeft(m: { lastFiredAt?: number }): number {
  return m.lastFiredAt ? Math.max(0, m.lastFiredAt + FIRE_COOLDOWN_MS - Date.now()) : 0;
}

function tail(s: string): string {
  const lines = s.trimEnd().split('\n');
  return lines.slice(-MAX_DETAIL_LINES).map((l) => l.slice(0, MAX_LINE_CHARS)).join('\n');
}

function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim())?.trim() ?? '';
}

export function describeTrigger(t: MonitorTrigger): string {
  if (t.type === 'output') return `output of pid ${t.pid} matches /${t.pattern}/i`;
  if (t.type === 'poll') {
    const cond = t.until === 'success' ? 'exits 0' : t.until === 'match' ? `output matches /${t.pattern}/i` : 'output changes';
    return `every ${t.intervalSeconds}s run \`${t.command}\` until it ${cond}`;
  }
  return `files change under ${t.path}`;
}

function publicInfo(m: Live): MonitorInfo {
  return {
    id: m.id, sessionId: m.sessionId, label: m.label, prompt: m.prompt, trigger: m.trigger,
    fires: m.fires, maxFires: m.maxFires, createdAt: m.createdAt, expiresAt: m.expiresAt, lastFiredAt: m.lastFiredAt,
    cwd: m.cwd,
  };
}

export const MONITOR_EVENT_TAG = 'monitor-event';

function buildMonitorXml(m: Live, detail: string, state: 'ended' | 'still watching', outcome: 'fired' | 'timeout' | 'stopped'): string {
  return `<${MONITOR_EVENT_TAG}>
<monitor-id>${m.id}</monitor-id>
<label>${esc(m.label)}</label>
<outcome>${outcome}</outcome>
<watching>${esc(describeTrigger(m.trigger))}</watching>
<fire>${m.fires}/${m.maxFires} (${state})</fire>
<detail>${esc(detail)}</detail>
<prompt>${esc(m.prompt)}</prompt>
</${MONITOR_EVENT_TAG}>`;
}

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── singleton (deps 工厂由工具层 monitorTools 在加载时登记; 谁先用谁建) ─────────────────

let registry: MonitorRegistry | null = null;
let depsFactory: (() => MonitorDeps) | null = null;

export function setMonitorDepsFactory(f: () => MonitorDeps): void {
  depsFactory = f;
}

/** 建出来时会从磁盘恢复 (有 store 的话) —— 所以 runtime 启动时要主动调一次, 不能等第一次用工具 */
export function getMonitorRegistry(): MonitorRegistry | null {
  if (!registry && depsFactory) registry = new MonitorRegistry(depsFactory());
  return registry;
}

/** 挂到 runtime bridge 上的口 —— 界面列表 / 停止 / 删会话都经 bridge 落到跑 runtime 的那条线程 */
export const monitorBridgeMethods = {
  releaseSessionWatchers,
  listMonitors(sessionId: string): MonitorInfo[] {
    return getMonitorRegistry()?.listForSession(sessionId) ?? [];
  },
  stopMonitor(sessionId: string, id: string): boolean {
    const r = getMonitorRegistry();
    const info = r?.listForSession(sessionId).find((m) => m.id === id);
    if (!r || !info || !r.stop(id)) return false;
    getBackgroundTaskNotifier().enqueueMessageForSession(sessionId,
      buildMonitorXml(toLive(info), 'Stopped by the user from the UI. Do not restart it unless asked.', 'ended', 'stopped'),
      { kind: 'monitor', command: `monitor: ${info.label.slice(0, 60)}`, terminatedBy: 'user', noAutoResume: true });
    return true;
  },
};

/**
 * 会话关掉 / 删掉时: 它挂的监控和还没到点的唤醒一起撤。
 * 不撤的话会话都没了, 监控还在跑命令、到点还往一个不存在的会话里起一轮。
 */
export function releaseSessionWatchers(sessionId: string): void {
  registry?.cancelAllForSession(sessionId);
  getScheduledWakeupRegistry().cancelAllForSession(sessionId);
}

export function __resetMonitorRegistryForTest(): void {
  registry = null;
}
