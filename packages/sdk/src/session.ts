/**
 * Neox Agent SDK · createSession / Session class
 *
 * 多轮会话 + 断点续跑。
 *
 * 此前 send / stream / resume 全是 stub(一调就抛 NotImplemented),
 * 但已经从 index.ts 导出 —— 用户 IDE 能补全出来, 调用即崩, 比没有更伤。这一版
 * 按 docs/NEOX_SDK_V1_API.md §2.3 补齐:
 *
 *   · 历史保存在内存, 每轮结束后可选落盘到 checkpointDir/<sessionId>.json
 *   · send/stream 把历史折进 prompt 交给 Agent —— SDK 侧只保证"多轮上下文连续",
 *     不承诺 kernel 级别的 memory 语义
 *   · resume 从 checkpointDir 读回历史; 缺文件即抛, 不静默返回空会话
 *
 * 刻意不做的: 跨进程并发写同一个 session 文件的加锁。SDK 定位是嵌入式,
 * 多进程共享会话属于 server 形态的活(见 v1 设计文档 §4)。
 */

import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { Agent, type AgentConfig, type AgentResult, type AgentStream } from './agent.js';
import type { Message } from './types.js';

export interface CreateSessionOptions extends AgentConfig {
  /** 持久化目录. 不指定则仅内存态,进程退出丢失 */
  checkpointDir?: string;
  /** 会话 id,不指定则自动生成 */
  sessionId?: string;
}

/** 落盘格式 —— 只存能重建会话的最小集合, 不存 provider(含 apiKey) */
interface SessionSnapshot {
  version: 1;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  systemPrompt?: string;
  turns: Turn[];
}

interface Turn {
  prompt: string;
  text: string;
}

export class Session {
  readonly id: string;
  readonly config: CreateSessionOptions;
  private readonly turns: Turn[] = [];
  private readonly _messages: Message[] = [];
  private readonly createdAt = new Date().toISOString();
  private current: Agent | null = null;

  constructor(options: CreateSessionOptions) {
    this.id = options.sessionId ?? generateSessionId();
    this.config = options;
  }

  /** 发送一轮消息,非流式. */
  async send(prompt: string): Promise<AgentResult> {
    const agent = this.spawn();
    const res = await agent.run(this.compose(prompt));
    this.record(prompt, res);
    await this.persist();
    return res;
  }

  /** 发送一轮消息,流式. 与 Agent.stream 同形: 可迭代, 也可 await result(). */
  stream(prompt: string): AgentStream {
    const agent = this.spawn();
    const inner = agent.stream(this.compose(prompt));
    /* 在 result() resolve 前完成持久化，调用方拿到结果时历史已经可恢复。 */
    const done = inner.result().then(async (res) => {
      this.record(prompt, res);
      await this.persist();
      return res;
    });
    done.catch(() => {});
    return {
      [Symbol.asyncIterator]: () => inner[Symbol.asyncIterator](),
      next: (...args) => inner.next(...(args as [])),
      return: (value?: unknown) => inner.return!(value as never),
      throw: (err?: unknown) => inner.throw!(err),
      result: () => done,
      abort: () => inner.abort(),
    };
  }

  /** 基于当前状态分叉出新 session. */
  fork(): Session {
    const next = new Session({ ...this.config, sessionId: generateSessionId() });
    next.turns.push(...this.turns);
    next._messages.push(...this._messages);
    return next;
  }

  /** 对话历史快照. */
  history(): Message[] {
    return [...this._messages];
  }

  /** 持久化 + 释放资源. */
  async close(): Promise<void> {
    await this.persist();
    this.current = null;
  }

  abort(): void {
    this.current?.abort();
  }

  /** 从 checkpointDir 恢复一个 session. */
  static async resume(
    sessionId: string,
    options: { checkpointDir: string } & Partial<AgentConfig>,
  ): Promise<Session> {
    const file = snapshotPath(options.checkpointDir, sessionId);
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      throw new Error(`[neox-sdk] session "${sessionId}" not found in ${options.checkpointDir}`);
    }
    const snap = JSON.parse(raw) as SessionSnapshot;
    /* provider 不落盘(含 apiKey), 恢复时由调用方重新给或走环境变量 */
    const session = new Session({
      ...(options as AgentConfig),
      model: options.model ?? snap.model,
      systemPrompt: options.systemPrompt ?? snap.systemPrompt,
      sessionId: snap.sessionId,
      checkpointDir: options.checkpointDir,
    });
    session.turns.push(...snap.turns);
    for (const t of snap.turns) {
      session._messages.push(
        { role: 'user', content: t.prompt } as unknown as Message,
        { role: 'assistant', content: t.text } as unknown as Message,
      );
    }
    return session;
  }

  // ----------------------------------------------------------------------

  /** 每轮起一个新 Agent —— Agent 是一次性的(abort 状态挂在实例上) */
  private spawn(): Agent {
    const { checkpointDir: _dir, sessionId: _id, ...agentConfig } = this.config;
    const agent = new Agent(agentConfig);
    this.current = agent;
    return agent;
  }

  /**
   * 把历史折进 prompt。
   * SDK 层不接 kernel 的持久 memory, 多轮靠拼接实现 —— 简单、可预期,
   * 代价是长会话 token 成本线性增长。需要压缩请自行截断 turns。
   */
  private compose(prompt: string): string {
    if (this.turns.length === 0) return prompt;
    const history = this.turns
      .map((t) => `User: ${t.prompt}\nAssistant: ${t.text}`)
      .join('\n\n');
    return `${history}\n\nUser: ${prompt}`;
  }

  private record(prompt: string, res: AgentResult): void {
    this.turns.push({ prompt, text: res.text });
    this._messages.push(
      { role: 'user', content: prompt } as unknown as Message,
      { role: 'assistant', content: res.text } as unknown as Message,
    );
  }

  private async persist(): Promise<void> {
    const dir = this.config.checkpointDir;
    if (!dir) return;
    const snapshot: SessionSnapshot = {
      version: 1,
      sessionId: this.id,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      model: this.config.model,
      systemPrompt:
        typeof this.config.systemPrompt === 'string' ? this.config.systemPrompt : undefined,
      turns: this.turns,
    };
    const file = snapshotPath(dir, this.id);
    await fsp.mkdir(dirname(file), { recursive: true });
    /* 先写临时文件再 rename —— 中途崩溃不会留下半个 JSON */
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  }
}

export async function createSession(options: CreateSessionOptions): Promise<Session> {
  const session = new Session(options);
  /* 指定了目录就先建出来, 免得第一轮跑完才发现路径不可写 */
  if (options.checkpointDir) await fsp.mkdir(options.checkpointDir, { recursive: true });
  return session;
}

function snapshotPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

function generateSessionId(): string {
  return 'neox-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}
