
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { connect, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import {
  publishComputerPointer,
  type ComputerPointerEvent,
} from '@neoxlabs/platform/shared/computerPointerBus.js';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';
import { onComputerAbort, abortComputerSession } from './computerAbort.js';

export interface BridgeElement {
  id: number;
  role: string;
  subrole?: string;
  /** 内容标签 (title/desc/value/help)。**变化断言只认这个**。 */
  label: string;
  /** 角色描述 ("close button")。只用来兜显示名 —— AXGroup 的是 "group", 混进签名会毁掉断言。 */
  roleDesc?: string;
  value?: string;
  x: number; y: number; w: number; h: number;
  actionable: boolean;
  actions: string[];
  enabled: boolean;
  focused: boolean;
}

export interface BridgePrivilege {
  integrity?: string;
  elevated?: boolean;
  uiAccess?: boolean;
  securePath?: boolean;
  canDriveElevated?: boolean;
  uac?: string;
}

export function elevatedBridgeReadyPath(): string {
  return join(tmpdir(), 'neox-os-bridge-elevated.json');
}

/** 就绪文件还在、但仓库里的桥已经更新 —— 接上会把新 dump/动作丢掉. */
export function elevatedBridgeIsStale(): boolean {
  const p = elevatedBridgeReadyPath();
  if (!existsSync(p)) return false;
  const bin = resolveBridgeBinary();
  if (!bin) return false;
  try {
    return statSync(bin).mtimeMs > statSync(p).mtimeMs + 1000;
  } catch {
    return false;
  }
}

/** Neox 退出时把会话级管理员桥一起带走, 别留一个 High IL 孤儿。 */
export function killElevatedBridgeIfAny(): void {
  if (process.platform !== 'win32') return;
  const p = elevatedBridgeReadyPath();
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { pid?: number };
    if (typeof j.pid === 'number' && j.pid > 0) {
      try { process.kill(j.pid); } catch { /* already gone */ }
    }
    rmSync(p, { force: true });
  } catch { /* 没有就绪文件 */ }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface BridgeDump {
  ok: true;
  app: string;
  pid: number;
  epoch: number;
  ms: number;
  window?: { x: number; y: number; w: number; h: number };
  visited: number;
  elements: BridgeElement[];
  /** AX/UIA/JAB 树是空的 —— 原生自绘 UI (微信/游戏/Qt)。这种情况必须改走截图 + 坐标。 */
  axBlind: boolean;
  /** Windows: "uia" | "jab"。Java 窗接到 JAB 时是 jab, 编号语义与 UIA 相同。 */
  treeSource?: string;
  jabHint?: string;
  note?: string;
  privilege?: BridgePrivilege;
  targetIntegrity?: string;
  otherWindows?: Array<{ title?: string; pid?: number; name?: string }>;
  /** 实际扫的窗口标题。弹层开着时是弹层名, 不是主窗。 */
  windowTitle?: string;
  windowClass?: string;
  /** true: 当前 dump 是对话框/弹层, 不是主窗。 */
  dialog?: boolean;
  /* ─── 增量 dump (桥在 since 命中时给) ──────────────────────────────────
   * incremental=true 时 elements 只装**新增和变了的**, 没变的在 unchanged 里只有编号,
   * 消失的在 removed 里。调用方必须拿它跟上一份合并 (mergeIncrementalDump), 直接用
   * 会得到一份只有几个元素的残缺视图。 */
  incremental?: boolean;
  unchanged?: number[];
  removed?: number[];
}

export interface BridgeError {
  ok: false;
  error: string;
  /** 机器可判的原因码: not_trusted / app_not_found / no_window / stale_handle / … */
  code: string;
  hint?: string;
}

export type BridgeReply = BridgeDump | BridgeError | ({ ok: true } & Record<string, any>);

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * dev 下从当前文件往上找仓库根 —— 用 fileURLToPath 而不是 URL.pathname:
 * Windows 上 pathname 是 `/E:/code/...` (盘符前多一个斜杠), existsSync 认不出来,
 * 于是 dev 环境永远找不到桥, 而报错是“找不到可执行文件” —— 离真因很远。
 */
function repoDirs(): string[] {
  const out: string[] = [];
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    out.push(dir);
    dir = dirname(dir);
  }
  return out;
}

export function resolveBridgeApp(): string | null {
  const candidates: string[] = [];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(join(resourcesPath, 'os-bridge', 'Neox Computer Use.app'));
  for (const dir of repoDirs()) {
    candidates.push(join(dir, 'apps/desktop/resources/os-bridge/Neox Computer Use.app'));
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

function socketPath(): string {
  const dir = neoxHome('run');
  try { mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
  return join(dir, 'os-bridge.sock');
}

export function resolveBridgeBinary(): string | null {
  const isWin = process.platform === 'win32';
  const candidates: string[] = [];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

  if (isWin) {
    /* Windows: 一只随包走的 exe —— 没有 .app / socket 那一套 (Windows 没有 TCC),
     * 也就不需要"独立身份"。桥的源码在 resources/win-os-bridge (Rust + UIA)。 */
    if (resourcesPath) candidates.push(join(resourcesPath, 'os-bridge', 'neox-os-bridge.exe'));
    for (const dir of repoDirs()) {
      /* 日常 exe 常被残留进程锁住, .next 是刚编出来的那份. */
      candidates.push(join(dir, 'apps/desktop/resources/win-os-bridge/neox-os-bridge.next.exe'));
      candidates.push(join(dir, 'apps/desktop/resources/win-os-bridge/neox-os-bridge.exe'));
    }
    return candidates.find((p) => existsSync(p)) ?? null;
  }

  if (resourcesPath) {
    candidates.push(join(resourcesPath, 'os-bridge', 'Neox Computer Use.app', 'Contents', 'MacOS', 'neox-os-bridge'));
    candidates.push(join(resourcesPath, 'os-bridge', 'NeoxOSBridge.app', 'Contents', 'MacOS', 'neox-os-bridge'));
    candidates.push(join(resourcesPath, 'os-bridge', 'neox-os-bridge'));
  }
  /* dev: 从当前文件往上找仓库根 */
  for (const dir of repoDirs()) {
    candidates.push(join(dir, 'apps/desktop/resources/os-bridge/Neox Computer Use.app/Contents/MacOS/neox-os-bridge'));
    candidates.push(join(dir, 'apps/desktop/resources/os-bridge/NeoxOSBridge.app/Contents/MacOS/neox-os-bridge'));
    candidates.push(join(dir, 'apps/desktop/resources/os-bridge/neox-os-bridge'));
    candidates.push(join(dir, 'apps/desktop/resources/win-os-bridge/neox-os-bridge.exe'));
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

interface Pending {
  resolve: (v: BridgeReply) => void;
  timer: NodeJS.Timeout;
}

class OsBridgeClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  /** socket 模式的连接 (由 open 拉起的 .app)。跟 child 互斥。 */
  private sock: Socket | null = null;
  private connecting: Promise<BridgeError | null> | null = null;
  private buffer = '';
  private seq = 0;
  private pending = new Map<number, Pending>();
  private lastStderr = '';
  private startFailure: string | null = null;
  private lastPrivilege: BridgePrivilege | null = null;
  private elevatedPid: number | null = null;
  private readonly _abortUnsub = onComputerAbort(() => {
    this.unlockInputFast();
    this.rejectAllPending('user_abort', '用户停止了操控');
    /* dump 卡在 JAB 工作线程时, stdin 上的 quit 要等超时才被读到。直接杀进程,
     * 下一轮 computer_run 会拉起新桥 —— overlay「停止」才能真的停。
     * 先给 120ms 让 unlock_user_input 把系统光标还原, 再杀 —— 否则 SIGKILL
     * 会跳过 shutdown, 用户鼠标箭头消失、点什么都没反应. */
    setTimeout(() => this.killHard(), 120);
  });

  private unlockInputFast(): void {
    const line = JSON.stringify({ id: ++this.seq, op: 'unlock_user_input' }) + '\n';
    try {
      if (this.sock) this.sock.write(line);
      else this.child?.stdin.write(line);
    } catch { /* 桥已经没了 */ }
  }

  private killHard(): void {
    const child = this.child;
    this.child = null;
    if (child?.pid) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* ignore */ }
    }
    const sock = this.sock;
    this.sock = null;
    if (sock) {
      try { sock.write(JSON.stringify({ id: ++this.seq, op: 'quit' }) + '\n'); } catch { /* ignore */ }
      try { sock.destroy(); } catch { /* ignore */ }
    }
    const ep = this.elevatedPid;
    this.elevatedPid = null;
    if (ep) {
      try { process.kill(ep, 'SIGKILL'); } catch { /* ignore */ }
    }
  }

  /** 桥活着吗。不主动拉起 —— 探测不该有副作用。 */
  isRunning(): boolean { return this.child !== null || this.sock !== null; }

  lastKnownPrivilege(): BridgePrivilege | null { return this.lastPrivilege; }

  /**
   * 起 socket 模式: `open -a <app> --args --serve <sock>` 然后连上去。
   *
   * 必须用 open 而不是 spawn —— 见 resolveBridgeApp 的说明: 只有 launchd 拉起的
   * .app 才有自己的 TCC 身份, 那条「Neox Computer Use」才会出现在辅助功能列表里。
   */
  private async startSocket(): Promise<BridgeError | null> {
    const app = resolveBridgeApp();
    if (!app) return { ok: false, code: 'bridge_app_missing', error: '找不到 Neox Computer Use.app' };
    const sock = socketPath();

    const tryConnect = (): Promise<Socket | null> => new Promise((resolve) => {
      const s = connect(sock);
      const timer = setTimeout(() => { s.destroy(); resolve(null); }, 400);
      s.once('connect', () => { clearTimeout(timer); resolve(s); });
      s.once('error', () => { clearTimeout(timer); s.destroy(); resolve(null); });
    });

    /* 先试连 —— 桥可能已经在跑 (上一个会话留下的), 那就别再 open 一次 */
    let s = await tryConnect();
    if (!s) {
      /* 残留的 socket 文件会让新桥 bind 失败, 先清掉 */
      try { rmSync(sock, { force: true }); } catch { /* ignore */ }
      await new Promise<void>((r) => {
        execFile('open', ['-a', app, '--args', '--serve', sock], () => r());
      });
      /* 冷启动要一会儿。轮询到连上为止, 别一次定死一个 sleep。 */
      for (let i = 0; i < 25 && !s; i++) {
        await new Promise((r) => setTimeout(r, 200));
        s = await tryConnect();
      }
    }
    if (!s) {
      return {
        ok: false, code: 'bridge_socket_timeout',
        error: '桥起来了但连不上 socket',
        hint: `socket=${sock}。可能是 Gatekeeper 挡了未签名的 app, 或者上一个桥进程没退干净。`,
      };
    }

    this.sock = s;
    this.buffer = '';
    s.setEncoding('utf-8');
    s.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        this.handleLine(line);
      }
    });
    const die = (why: string): void => {
      this.sock = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, code: 'bridge_died', error: `桥连接断了 (${why})` });
      }
      this.pending.clear();
    };
    s.on('error', (e) => { cliLogger.warn('OS_BRIDGE', `socket error: ${e.message}`); die(e.message); });
    s.on('close', () => die('连接关闭'));
    cliLogger.info('OS_BRIDGE', `socket 已连上 ${sock} (独立身份: Neox Computer Use)`);
    return null;
  }

  private start(): BridgeError | null {
    if (this.child) return null;
    const bin = resolveBridgeBinary();
    if (!bin) {
      return {
        ok: false, code: 'bridge_missing', error: '找不到 neox-os-bridge 可执行文件',
        hint: process.platform === 'win32'
          ? 'dev 环境先跑一次: node apps/desktop/resources/win-os-bridge/build.mjs'
          : 'dev 环境先跑一次: bash apps/desktop/resources/os-bridge/build.sh',
      };
    }
    try {
      this.child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return { ok: false, code: 'bridge_spawn_failed', error: `${(e as Error).message}` };
    }
    this.buffer = '';
    this.startFailure = null;
    this.child.stdout.setEncoding('utf-8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        this.handleLine(line);
      }
    });
    this.child.stderr.setEncoding('utf-8');
    this.child.stderr.on('data', (chunk: string) => {
      this.lastStderr = (this.lastStderr + chunk).slice(-2000);
      cliLogger.warn('OS_BRIDGE', `[swift stderr] ${chunk.trim().slice(0, 300)}`);
    });
    this.child.stdin.on('error', (e) => {
      cliLogger.warn('OS_BRIDGE', `stdin error: ${(e as Error).message}`);
    });
    this.child.on('exit', (code, signal) => {
      cliLogger.info('OS_BRIDGE', `bridge exited code=${code} signal=${signal} stderr=${this.lastStderr.slice(-200)}`);
      this.child = null;
      /* 在飞的请求要**当场结掉**, 不能让调用方等到超时 ——
       * 那 15 秒的静默会被误读成"桥很慢", 而不是"桥死了"。 */
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, code: 'bridge_died', error: `桥进程退出 (code=${code} signal=${signal})`,
                    hint: this.lastStderr ? `stderr: ${this.lastStderr.slice(-300)}` : undefined });
      }
      this.pending.clear();
    });
    cliLogger.info('OS_BRIDGE', `spawned ${bin}`);
    return null;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: { id?: number; event?: string } & Record<string, any>;
    try { msg = JSON.parse(trimmed); } catch {
      cliLogger.warn('OS_BRIDGE', `解不开这行: ${trimmed.slice(0, 200)}`);
      return;
    }
    if (msg.privilege && typeof msg.privilege === 'object') {
      this.lastPrivilege = msg.privilege as BridgePrivilege;
    }
    /* 事件行 (没有 id): 桥在动作发生的那一刻把"指针落在哪"发出来。
     * 不匹配任何 pending, 所以老宿主天然忽略它 —— 纯加法。
     * 用途是给人看的: 桌面端的"正在被操控"叠加层靠它画虚拟光标。 */
    if (msg.event === 'pointer') {
      publishComputerPointer(msg as unknown as ComputerPointerEvent);
      return;
    }
    if (msg.event === 'user_stop') {
      publishComputerPointer({ phase: 'done', action: 'user_stop' });
      try { abortComputerSession(); } catch { /* ignore */ }
      return;
    }
    /* id=0 是启动握手行 (带授权状态), 没有等它的人 */
    if (msg.id === 0) {
      if (msg.trusted === false) this.startFailure = 'not_trusted';
      if (msg.privilege && typeof msg.privilege === 'object') {
        this.lastPrivilege = msg.privilege as BridgePrivilege;
      }
      return;
    }
    const p = this.pending.get(msg.id ?? -1);
    if (!p) return;
    this.pending.delete(msg.id!);
    clearTimeout(p.timer);
    p.resolve(msg as BridgeReply);
  }

  /**
   * 保证有一条能说话的管子。**socket 优先**, 它才有独立的 TCC 身份。
   * socket 起不来 (没打包 .app / Gatekeeper 挡了) 才退回 stdio spawn ——
   * 那条路能用, 只是授权会记在责任进程 (dev 下是 Electron) 名下。
   */
  private async ensureConnected(): Promise<BridgeError | null> {
    if (this.sock || this.child) return null;
    /* 平台能力: mac 走 socket (独立 TCC 身份), Windows 只有 stdio (没有 TCC 这回事)。
     * 两条都走不通的平台直接说清楚 —— 不说的话调用方会等到超时, 那 15 秒的静默
     * 会被误读成"桥很慢"。 */
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      return { ok: false, code: 'unsupported_platform', error: 'OS 级操作目前只支持 macOS 与 Windows' };
    }
    /* 并发调用只连一次 —— 不然一轮脚本几个请求会同时 open 好几个桥 */
    if (!this.connecting) {
      this.connecting = (async () => {
        if (process.platform === 'win32') {
          const elevated = await this.tryAttachElevated();
          if (!elevated) return this.start();
          return null;
        }
        if (process.platform !== 'darwin') return this.start();
        const socketErr = await this.startSocket();
        if (!socketErr) return null;
        cliLogger.warn('OS_BRIDGE', `socket 模式起不来 (${socketErr.code}), 退回 stdio —— 授权会记在责任进程名下`);
        return this.start();
      })().finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  async request(req: Record<string, unknown>): Promise<BridgeReply> {
    const isShot = req.op === 'screenshot';
    if (isShot) {
      /* BitBlt 回退会把全屏 overlay 打进截图。PrintWindow 本来就不含别的窗,
       * 但 Win10 上它常失败。截图前把 overlay 透明度打到 0, 等主进程合成一帧再抓。 */
      publishComputerPointer({
        phase: 'move',
        action: '__capture_hide',
        app: typeof req.app === 'string' ? req.app : '',
      });
      await new Promise((r) => setTimeout(r, 80));
    }
    try {
      return await this.requestOnce(req);
    } finally {
      if (isShot) {
        publishComputerPointer({
          phase: 'move',
          action: '__capture_show',
          app: typeof req.app === 'string' ? req.app : '',
        });
      }
    }
  }

  private async requestOnce(req: Record<string, unknown>): Promise<BridgeReply> {
    const startErr = await this.ensureConnected();
    if (startErr) return startErr;
    const id = ++this.seq;
    const timeoutMs = req.op === 'elevate' ? 130_000 : REQUEST_TIMEOUT_MS;
    return new Promise<BridgeReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, code: 'bridge_timeout', error: `${req.op} 超过 ${timeoutMs}ms 没回` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      const line = JSON.stringify({ id, ...req }) + '\n';
      try {
        if (this.sock) this.sock.write(line);
        else this.child!.stdin.write(line);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, code: 'bridge_write_failed', error: `${(e as Error).message}` });
      }
    });
  }

  /** 授权探测。**不弹窗** —— 弹窗的时机该由 UI 决定, 不是被一次工具调用顺手触发。 */
  async probe(): Promise<{
    ok: boolean;
    trusted: boolean;
    screenRecording: boolean;
    privilege?: BridgePrivilege;
    error?: string;
    hint?: string;
  }> {
    const r = await this.request({ op: 'probe' }) as any;
    if (!r.ok) {
      return { ok: false, trusted: false, screenRecording: false, error: r.error, hint: r.hint };
    }
    const privilege = (r.privilege ?? this.lastPrivilege) as BridgePrivilege | undefined;
    if (privilege) this.lastPrivilege = privilege;
    return { ok: true, trusted: !!r.trusted, screenRecording: !!r.screenRecording, privilege };
  }

  /**
   * Windows: 请用户点一次 UAC, 把桥升到管理员完整性, 然后改连 127.0.0.1。
   * 已经是 High / UIAccess 则直接成功。mac 没有这件事。
   */
  async elevate(): Promise<BridgeReply> {
    if (process.platform !== 'win32') {
      return { ok: false, code: 'unsupported_platform', error: '只有 Windows 需要管理员完整性提权' };
    }
    const startErr = await this.ensureConnected();
    if (startErr) return startErr;
    const nonce = randomUUID();
    const r = await this.request({ op: 'elevate', nonce }) as any;
    if (!r.ok) return r;
    if (r.privilege) this.lastPrivilege = r.privilege as BridgePrivilege;
    if (r.alreadyElevated) return r;
    const port = Number(r.port);
    if (!Number.isFinite(port) || port <= 0) {
      return { ok: false, code: 'elevate_failed', error: '管理员桥起来了但没带回端口' };
    }
    this.detachStdio();
    const tcpErr = await this.startTcp(port);
    if (tcpErr) return tcpErr;
    return r;
  }

  stop(): void {
    if (this.sock) {
      try { this.sock.write(JSON.stringify({ id: ++this.seq, op: 'quit' }) + '\n'); } catch { /* 已经断了 */ }
      const s = this.sock;
      setTimeout(() => { try { s.destroy(); } catch { /* ignore */ } }, 300);
      this.sock = null;
      return;
    }
    this.detachStdio();
  }

  getStartFailure(): string | null { return this.startFailure; }

  private rejectAllPending(code: string, error: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, code, error });
    }
    this.pending.clear();
  }

  private detachStdio(): void {
    if (!this.child) return;
    try { this.child.stdin.write(JSON.stringify({ id: ++this.seq, op: 'quit' }) + '\n'); } catch { /* 已经死了 */ }
    const child = this.child;
    setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* ignore */ } }, 500);
    this.child = null;
  }

  private async tryAttachElevated(): Promise<boolean> {
    const p = elevatedBridgeReadyPath();
    if (!existsSync(p)) return false;
    let port = 0;
    let pid = 0;
    try {
      const j = JSON.parse(readFileSync(p, 'utf8')) as { port?: number; pid?: number; privilege?: BridgePrivilege };
      port = Number(j.port);
      pid = Number(j.pid);
      if (j.privilege) this.lastPrivilege = j.privilege;
      if (Number.isFinite(pid) && pid > 0) this.elevatedPid = pid;
    } catch {
      return false;
    }
    if (!Number.isFinite(port) || port <= 0 || !pidAlive(pid)) {
      try { rmSync(p, { force: true }); } catch { /* ignore */ }
      return false;
    }
    /* 日常编出来的桥比这份就绪文件新 → 管理员残留是旧二进制, 会把新 dump/动作吃掉.
     * 普通应用 (聊天/WPS) 不需要它, 改走 next.exe. */
    if (elevatedBridgeIsStale()) {
      cliLogger.info('OS_BRIDGE', `跳过旧管理员桥 pid ${pid}, 改用新桥`);
      return false;
    }
    const err = await this.startTcp(port);
    if (err) {
      try { rmSync(p, { force: true }); } catch { /* ignore */ }
      return false;
    }
    cliLogger.info('OS_BRIDGE', `已接上管理员桥 127.0.0.1:${port} (pid ${pid})`);
    return true;
  }

  private startTcp(port: number): Promise<BridgeError | null> {
    return new Promise((resolve) => {
      const s = connect({ host: '127.0.0.1', port });
      const timer = setTimeout(() => {
        s.destroy();
        resolve({ ok: false, code: 'bridge_socket_timeout', error: `连不上管理员桥 127.0.0.1:${port}` });
      }, 2000);
      s.once('connect', () => {
        clearTimeout(timer);
        this.sock = s;
        this.buffer = '';
        s.setEncoding('utf-8');
        s.on('data', (chunk: string) => {
          this.buffer += chunk;
          let idx: number;
          while ((idx = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, idx);
            this.buffer = this.buffer.slice(idx + 1);
            this.handleLine(line);
          }
        });
        const die = (why: string): void => {
          this.sock = null;
          this.rejectAllPending('bridge_died', `桥连接断了 (${why})`);
        };
        s.on('error', (e) => { cliLogger.warn('OS_BRIDGE', `tcp error: ${e.message}`); die(e.message); });
        s.on('close', () => die('连接关闭'));
        resolve(null);
      });
      s.once('error', (e) => {
        clearTimeout(timer);
        s.destroy();
        resolve({ ok: false, code: 'bridge_socket_timeout', error: `连不上管理员桥: ${e.message}` });
      });
    });
  }
}

let singleton: OsBridgeClient | null = null;

export function getOsBridge(): OsBridgeClient {
  singleton ??= new OsBridgeClient();
  return singleton;
}

/** 进程收尾时把桥一起带走 —— 留着它会一直占着辅助功能连接。 */
export function disposeOsBridge(): void {
  singleton?.stop();
  singleton = null;
}

/* 指针事件总线在共享层 (platform/shared/computerPointerBus): 生产者是本文件,
 * 消费者是桌面端主进程的叠加层。放共享层是为了不让桌面去深引 core 的内部路径
 * (见该文件头的说明)。这里只做"从桥的 stdout 拣出来 → 转发出去"。 */
