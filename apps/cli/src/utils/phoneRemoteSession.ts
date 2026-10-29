import { getCliEdition, type CliPhoneRemote } from '../edition/index.js';

export interface PhoneRemoteSessionDeps {
  getSessionId(): string;
  getWorkDir(): string;
  getModel(): string | undefined;
  /** 手机发来的话: 当作用户在终端里输入 */
  sendUserMessage(text: string): void;
  /** 手机回答了 ask_user: 跟终端里选完走同一条路径。返回 true = 终端正在等的那题被收起来了 */
  replyAskUser(requestId: string, answers: Record<string, string>): boolean;
  /** 手机点停止 */
  stop(): void;
  info(line: string): void;
  warn(line: string): void;
}

type RecentMessage = { role: 'user' | 'assistant'; text: string; ts?: number };

export class PhoneRemoteSession {
  private remote: CliPhoneRemote | null = null;
  /** 下一轮是不是手机发起的 (手机上标来源) */
  private nextTurnFromPhone = false;
  /** 手机上的会话标题: 会话库里的名字, 没有就用第一句话 */
  private title: string | null = null;

  constructor(private deps: PhoneRemoteSessionDeps) {}

  onRuntimeEvent(event: unknown): void {
    this.remote?.onRuntimeEvent(event);
  }

  /** 包住一轮对话: 手机上开始 / 结束 (出错带原因) */
  async runTurn<T>(userInput: string, run: () => Promise<T>): Promise<T> {
    const fromPhone = this.nextTurnFromPhone;
    this.nextTurnFromPhone = false;
    if (this.remote?.isOn() && !this.title) {
      this.title = userInput.trim().replace(/\s+/g, ' ').slice(0, 30) || null;
    }
    this.remote?.turnStart(userInput, fromPhone ? 'phone' : 'cli');
    try {
      const out = await run();
      this.remote?.turnEnd();
      return out;
    } catch (err) {
      this.remote?.turnEnd(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** 终端里先答了: 通知手机把对应卡片翻成已答 (远程没开时什么也不做) */
  askUserAnsweredLocally(requestId: string, answers: Record<string, string>): void {
    this.remote?.askUserAnswered(requestId, answers);
  }

  /** /rc: 开着就关, 关着就开 */
  async toggle(): Promise<void> {
    if (this.remote?.isOn()) {
      this.remote.stop();
      this.deps.info('📱 已从手机上撤下这个会话');
      return;
    }
    const factory = getCliEdition().phoneRemote;
    if (!factory) {
      this.deps.warn('手机远程需要登录 Neox 账号');
      return;
    }
    this.remote ??= factory();
    const res = await this.remote.start({
      getSession: () => ({
        id: this.deps.getSessionId(),
        title: this.title ?? '',
        workspacePath: this.deps.getWorkDir(),
        modelId: this.deps.getModel(),
      }),
      recentMessages: () => this.loadRecentMessages(),
      sendUserMessage: (text) => {
        this.nextTurnFromPhone = true;
        this.deps.sendUserMessage(text);
      },
      stop: () => this.deps.stop(),
      replyAskUser: (requestId, answers) => {
        const terminalPromptClosed = this.deps.replyAskUser(requestId, answers as Record<string, string>);
        /* 终端那边收了框并打了「已在手机上回答: …」, 这里不再补一行 —— 否则同一件事说两遍 */
        if (!terminalPromptClosed) this.deps.info('📱 已从手机回答 —— 电脑端继续');
      },
      notify: (line) => this.deps.info(line),
    });
    if (res.ok) this.deps.info(`📱 ${res.message}`);
    else this.deps.warn(`📱 ${res.message}`);
  }

  private async loadRecentMessages(): Promise<RecentMessage[]> {
    try {
      const { sessionStore } = await import('@neoxlabs/core/platform/sessionStore.js') as any;
      const s = await sessionStore.loadSession(this.deps.getSessionId());
      const msgs: any[] = Array.isArray(s?.messages) ? s.messages : [];
      /* 会话库的消息是 { role, text } (不是 content) —— 两种都认 */
      const text = (m: any): string => {
        const c = m?.content ?? m?.text;
        return typeof c === 'string' ? c
          : Array.isArray(c) ? c.map((p: any) => (p?.type === 'text' ? p.text : '')).join('') : '';
      };
      /* 会话库里的默认名是「Session session_2026…」, 手机上没意义 —— 用第一句话 */
      const name = typeof s?.name === 'string' ? s.name.trim() : '';
      const firstUser = msgs.find((m) => m?.role === 'user' && text(m).trim() && !text(m).startsWith('<'));
      this.title = name && !/^Session\s+session_/i.test(name)
        ? name
        : (firstUser ? text(firstUser).trim().replace(/\s+/g, ' ').slice(0, 30) : null);
      return msgs
        .filter((m) => m?.role === 'user' || m?.role === 'assistant')
        .map((m) => ({ role: m.role, text: text(m).trim(), ts: typeof m.timestamp === 'number' ? m.timestamp : undefined }))
        .filter((m) => m.text && !m.text.startsWith('<'))
        .slice(-60);
    } catch {
      return [];
    }
  }
}
