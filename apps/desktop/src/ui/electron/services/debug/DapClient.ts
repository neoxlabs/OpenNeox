/**
 * DapClient — Node 侧 DAP 协议客户端.
 *
 * 拉一个子进程, 通过 stdio 跑 DAP. 帧格式: `Content-Length: N\r\n\r\n<json>`.
 * 不绑定具体后端 — JvmDapBackend / 未来 Python DAP 都能复用.
 *
 * 线程模型: stdin/stdout 都是单 stream, request 用 seq 配对到 response.
 * stdout 进 parser → 分帧 → request 是事件、response 走 pending callback.
 */

import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface DapMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
}

export interface DapRequest extends DapMessage {
  type: 'request';
  command: string;
  arguments?: unknown;
}

export interface DapResponse extends DapMessage {
  type: 'response';
  request_seq: number;
  command: string;
  success: boolean;
  message?: string;
  body?: unknown;
}

export interface DapEvent extends DapMessage {
  type: 'event';
  event: string;
  body?: unknown;
}

export interface DapClientOptions {
  /** 可执行文件 — 通常是 `java` 路径 */
  command: string;
  /** 完整参数 (包含 --add-modules, -jar, jar 路径等) */
  args: string[];
  /** 子进程 cwd; 默认 process.cwd() */
  cwd?: string;
  /** 环境变量 (跟 process.env merge); 默认透传 */
  env?: Record<string, string>;
  /** stderr 转发回调; 默认打到 console.error */
  onStderr?: (chunk: string) => void;
  /** 默认 30s; request 超时报错 */
  requestTimeoutMs?: number;
}

export class DapClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private nextSeq = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<
    number,
    { resolve: (body: unknown) => void; reject: (err: Error) => void; timeout: NodeJS.Timeout }
  >();
  private readonly options: Required<Pick<DapClientOptions, 'requestTimeoutMs'>> & DapClientOptions;
  private terminated = false;

  constructor(options: DapClientOptions) {
    super();
    this.options = { requestTimeoutMs: 30_000, ...options };
  }

  /** spawn 子进程, 准备收发. 不发任何 DAP 消息 — initialize 是上层职责. */
  start(): void {
    if (this.proc) throw new Error('DapClient already started');
    this.proc = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (this.options.onStderr) this.options.onStderr(text);
      else process.stderr.write(`[dap-stderr] ${text}`);
    });

    this.proc.on('error', (err) => {
      this.fatal(err);
    });
    this.proc.on('exit', (code, signal) => {
      this.terminated = true;
      this.emit('exit', { code, signal });
      const err = new Error(`DAP process exited (code=${code}, signal=${signal})`);
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(err);
      }
      this.pending.clear();
    });
  }

  isAlive(): boolean {
    return !!this.proc && !this.terminated;
  }

  /** 发 request, 等 response.body. 失败 (success=false) 抛 Error. */
  async sendRequest(command: string, args?: unknown): Promise<unknown> {
    if (!this.proc || this.terminated) throw new Error('DAP client not running');
    const seq = this.nextSeq++;
    const req: DapRequest = { seq, type: 'request', command, arguments: args };
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(seq)) {
          reject(new Error(`DAP request '${command}' timed out after ${this.options.requestTimeoutMs}ms`));
        }
      }, this.options.requestTimeoutMs);
      this.pending.set(seq, { resolve, reject, timeout });
      this.writeFrame(req).catch((err) => {
        if (this.pending.delete(seq)) {
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  /** 主动关停. terminate=true 杀进程; 否则发 disconnect 让对方自己退. */
  async stop(terminate = false): Promise<void> {
    if (!this.proc || this.terminated) return;
    if (!terminate) {
      try {
        await this.sendRequest('disconnect', { restart: false, terminateDebuggee: false });
      } catch {
        // 忽略 — 可能进程已经在退
      }
    }
    if (this.proc && !this.terminated) {
      this.proc.kill(terminate ? 'SIGKILL' : 'SIGTERM');
    }
  }

  // ─── 内部 ─────────────────────────────────────────────────────────────

  private async writeFrame(payload: DapMessage): Promise<void> {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    return new Promise<void>((resolve, reject) => {
      this.proc!.stdin!.write(Buffer.concat([header, body]), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const sepIdx = this.buffer.indexOf('\r\n\r\n');
      if (sepIdx < 0) return;
      const headerStr = this.buffer.subarray(0, sepIdx).toString('ascii');
      let length = -1;
      for (const line of headerStr.split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        if (line.substring(0, colon).trim().toLowerCase() === 'content-length') {
          length = Number(line.substring(colon + 1).trim());
        }
      }
      if (length < 0) {
        this.fatal(new Error(`DAP: missing Content-Length in header: ${headerStr}`));
        return;
      }
      const totalNeeded = sepIdx + 4 + length;
      if (this.buffer.length < totalNeeded) return; // body 还没到齐, 等下一块
      const body = this.buffer.subarray(sepIdx + 4, totalNeeded);
      this.buffer = this.buffer.subarray(totalNeeded);
      try {
        const msg = JSON.parse(body.toString('utf8')) as DapMessage;
        this.dispatch(msg);
      } catch (err) {
        this.fatal(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }
  }

  private dispatch(msg: DapMessage): void {
    if (msg.type === 'response') {
      const r = msg as DapResponse;
      const pending = this.pending.get(r.request_seq);
      if (!pending) {
        // 大概率是超时已经移除
        return;
      }
      this.pending.delete(r.request_seq);
      clearTimeout(pending.timeout);
      if (r.success) pending.resolve(r.body);
      else pending.reject(new Error(`DAP '${r.command}' failed: ${r.message ?? 'unknown'}`));
    } else if (msg.type === 'event') {
      this.emit('event', msg as DapEvent);
    }
  }

  private fatal(err: Error): void {
    if (this.terminated) return;
    this.terminated = true;
    this.emit('error', err);
    if (this.proc) this.proc.kill('SIGKILL');
  }
}
