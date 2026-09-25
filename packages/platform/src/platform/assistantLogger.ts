
import fs from 'fs';
import path from 'path';
import os from 'os';
import { isDiagLogEnabled } from '@neoxlabs/kernel/platform/diagLogGate.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

class AssistantDebugLogger {
  private logDir: string;
  private logFile: string;
  /** null = 没人显式设过, 每次现算 env; true/false = setEnabled 的显式覆盖 */
  private override: boolean | null = null;
  private stream: fs.WriteStream | null = null;
  private startTime: number;

  constructor() {
    this.logDir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'logs');
    this.logFile = path.join(this.logDir, 'assistant-debug.log');
    this.startTime = Date.now();
  }

  private get enabled(): boolean {
    if (this.override !== null) return this.override;
    if (process.env.NEOX_ASSISTANT_DEBUG === '0') return false;
    if (process.env.NEOX_ASSISTANT_DEBUG === '1') return true;
    return isDiagLogEnabled('assistant-debug');
  }

  /** 运行时启用/禁用 */
  setEnabled(enabled: boolean): void {
    this.override = enabled;
    if (!enabled && this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  get logFilePath(): string {
    return this.logFile;
  }

  private ensureStream(): fs.WriteStream | null {
    if (!this.enabled) return null;
    if (this.stream) return this.stream;

    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
      // 限制文件大小：超过 10MB 截断
      try {
        const stat = fs.statSync(this.logFile);
        if (stat.size > 10 * 1024 * 1024) {
          fs.writeFileSync(this.logFile, `[TRUNCATED at ${new Date().toISOString()}]\n`);
        }
      } catch { /* 文件不存在，正常 */ }

      /* 0600: 里面是这台机器上的会话诊断, 同机其他账号不该读得到
       * (neoxLogger / auditLog 早就是 0600)。mode 只在创建时生效, 旧文件补一次 chmod。 */
      this.stream = fs.createWriteStream(this.logFile, { flags: 'a', mode: 0o600 });
      try { fs.chmodSync(this.logFile, 0o600); } catch { /* 非本人所有 — 无所谓 */ }
      this.stream.on('error', () => {
        this.stream = null;
      });
      return this.stream;
    } catch {
      return null;
    }
  }

  private now(): string {
    const d = new Date();
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
  }

  private elapsed(): string {
    return `+${((Date.now() - this.startTime) / 1000).toFixed(1)}s`;
  }

  private write(level: string, tag: string, msg: string, data?: Record<string, any>): void {
    if (!this.enabled) return;
    const stream = this.ensureStream();
    if (!stream) return;

    const dataStr = data ? ' ' + JSON.stringify(data) : '';
    const line = `${this.now()} ${this.elapsed()} [${level}] [${tag}] ${msg}${dataStr}\n`;
    stream.write(line);
  }

  // ==================== Turn 生命周期 ====================

  /** Turn 开始 */
  turnStart(turnId: string, type: string, prompt: string): void {
    this.write('TURN', 'START', `${turnId} type=${type} prompt="${prompt.substring(0, 80)}"`, {
      promptLen: prompt.length,
    });
  }

  /** Turn 中断 */
  turnAbort(turnId: string, partialLen: number, reason: string): void {
    this.write('TURN', 'ABORT', `${turnId} partial=${partialLen}chars reason=${reason}`);
  }

  /** Turn 完成 */
  turnComplete(turnId: string, outputLen: number, durationMs: number): void {
    this.write('TURN', 'DONE', `${turnId} output=${outputLen}chars duration=${durationMs}ms`);
  }

  /** Turn 错误 */
  turnError(turnId: string, error: string): void {
    this.write('TURN', 'ERROR', `${turnId} ${error}`);
  }


  /**
   * 记录 Ledger 状态快照 — 每次 fireTurn 开始时调用
   * 用于诊断第二轮 LLM 看到的历史消息是否正确
   */
  ledgerSnapshot(turnId: string, params: {
    ledgerSize: number;
    historyMessageCount: number;
    lastMsg?: { role: string; contentPreview: string };
    bufferSize: number;
  }): void {
    this.write('DIAG', 'LEDGER', `${turnId} ledger=${params.ledgerSize} historyMsgs=${params.historyMessageCount} buffer=${params.bufferSize}`, {
      lastMsgRole: params.lastMsg?.role,
      lastMsgPreview: params.lastMsg?.contentPreview,
    });
  }

  /**
   * 记录 agentLoop 入口状态 — agentLoop 开始前调用
   * 关键：能不能看到第二轮的消息列表
   */
  agentLoopEnter(turnId: string, params: {
    messageCount: number;
    toolCount: number;
    lastMsgRole: string;
    lastMsgPreview: string;
    provider: string;
    model: string;
    bufferHasMessages: boolean;
  }): void {
    this.write('LOOP', 'ENTER', `${turnId} msgs=${params.messageCount} tools=${params.toolCount} lastRole=${params.lastMsgRole} bufferHasMsg=${params.bufferHasMessages}`, {
      lastMsgPreview: params.lastMsgPreview.substring(0, 100),
      provider: params.provider,
      model: params.model,
    });
  }

  /**
   * 记录 agentLoop 退出状态
   */
  agentLoopExit(turnId: string, params: {
    exitReason: string;
    llmCalls: number;
    toolCalls: number;
    textLen: number;
    durationMs: number;
    lastError?: string;
  }): void {
    this.write('LOOP', 'EXIT', `${turnId} reason=${params.exitReason} llmCalls=${params.llmCalls} toolCalls=${params.toolCalls} text=${params.textLen}chars ${params.durationMs}ms`, {
      lastError: params.lastError,
    });
  }

  /**
   * 记录 Provider 解析结果 — 用于诊断第二轮 provider 是否丢失
   */
  providerResolved(turnId: string, params: {
    providerId: string;
    model: string;
    hasProvider: boolean;
    maxInputTokens?: number;
  }): void {
    this.write('DIAG', 'PROVIDER', `${turnId} providerId=${params.providerId} model=${params.model} hasProvider=${params.hasProvider} maxTokens=${params.maxInputTokens ?? 'unknown'}`);
  }

  /**
   * 记录 Triage 结果
   */
  triageResult(turnId: string, params: {
    type: string;
    lane: string;
    reason: string;
    durationMs: number;
  }): void {
    this.write('DIAG', 'TRIAGE', `${turnId} type=${params.type} lane=${params.lane} reason=${params.reason} ${params.durationMs}ms`);
  }

  /**
   * 记录消息列表结构摘要（诊断第二轮消息组装）
   */
  messagesSummary(turnId: string, messages: Array<{ role: string; content: any }>): void {
    const summary = messages.map((m, i) => {
      const preview = typeof m.content === 'string'
        ? m.content.substring(0, 40).replace(/\n/g, '↵')
        : '[non-string]';
      return `[${i}]${m.role}:"${preview}"`;
    }).join(' | ');
    this.write('DIAG', 'MESSAGES', `${turnId} count=${messages.length} | ${summary}`);
  }

  /**
   * 记录 onFinalMessages 回调收到的工具调用对数量
   */
  finalMessagesReceived(turnId: string, params: {
    totalMessages: number;
    toolPairsFound: number;
    assistantMessages: number;
    toolMessages: number;
  }): void {
    this.write('DIAG', 'FINAL_MSGS', `${turnId} total=${params.totalMessages} toolPairs=${params.toolPairsFound} assistant=${params.assistantMessages} tool=${params.toolMessages}`);
  }

  // ==================== 上下文组装 ====================

  /** 上下文组装进度 */
  contextBuild(turnId: string, phase: string, durationMs: number, detail?: string): void {
    this.write('CTX', phase, `${turnId} ${durationMs}ms ${detail || ''}`);
  }

  // ==================== LLM 请求 ====================

  /** LLM 请求开始 */
  llmRequest(turnId: string, provider: string, model: string): void {
    this.write('LLM', 'REQUEST', `${turnId} provider=${provider} model=${model}`);
  }

  /** LLM 第一个 token */
  llmFirstToken(turnId: string, latencyMs: number): void {
    this.write('LLM', 'FIRST_TOKEN', `${turnId} latency=${latencyMs}ms`);
  }

  /** LLM 完成 */
  llmComplete(turnId: string, tokens: number, durationMs: number): void {
    this.write('LLM', 'COMPLETE', `${turnId} tokens=${tokens} duration=${durationMs}ms`);
  }

  // ==================== Worker 事件 ====================


  timing(scope: string, stage: string, durationMs: number, detail?: string, data?: Record<string, any>): void {
    this.write('PERF', scope, `${stage} ${durationMs}ms${detail ? ` ${detail}` : ''}`, data);
  }

  mark(scope: string, stage: string, detail?: string, data?: Record<string, any>): void {
    this.write('MARK', scope, `${stage}${detail ? ` ${detail}` : ''}`, data);
  }

  /** Worker 结果 */
  workerResult(agentId: string, status: string, outputLen: number): void {
    this.write('WORKER', 'RESULT', `${agentId} status=${status} output=${outputLen}chars`);
  }

  // ==================== 通用 ====================

  /** 通用日志 */
  info(tag: string, msg: string, data?: Record<string, any>): void {
    this.write('INFO', tag, msg, data);
  }

  warn(tag: string, msg: string, data?: Record<string, any>): void {
    this.write('WARN', tag, msg, data);
  }

  error(tag: string, msg: string, data?: Record<string, any>): void {
    this.write('ERR', tag, msg, data);
  }

  /** 分隔符 */
  separator(label?: string): void {
    if (!this.enabled) return;
    const stream = this.ensureStream();
    if (!stream) return;
    stream.write(`${'═'.repeat(60)} ${label || ''}\n`);
  }

  close(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}

/** 全局单例 */
export const assistantLog = new AssistantDebugLogger();
