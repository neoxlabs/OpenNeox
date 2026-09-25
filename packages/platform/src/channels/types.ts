/**
 * Channel 适配器类型定义
 */

export type ChannelType = 'telegram' | 'webhook' | 'wechat' | 'slack' | 'github';

export interface IncomingMessage {
  channelId: string;
  chatId: string;
  text: string;
  from: { id: string; name: string };
  timestamp: number;
  /** 原始平台数据（可选） */
  raw?: unknown;
  /* ── 会话落点 (GitHub channel) ──
   * 默认使用 `ch-<channel>-<chat>` 会话和 runtime workDir。
   * GitHub PR 任务需要在对应仓库的 PR 分支工作，因此 channel 可以覆盖会话、工作区和模式；
   * 未提供覆盖项时继续使用默认落点。 */
  /** 指定会话 id (不给 = ch-<channelId>-<chatId>) */
  sessionId?: string;
  /** 会话工作区 (不给 = runtime workDir) */
  workspacePath?: string;
  /** 侧栏显示的会话名 (只在会话第一次被建出来时用) */
  sessionName?: string;
  /** 会话模式 */
  agentMode?: 'assistant' | 'work' | 'code';
  /** 用哪个 provider / 模型跑 (不给 = server 默认) */
  providerId?: string;
  modelName?: string;
}

export interface OutgoingMessage {
  chatId: string;
  text: string;
  /** 可选的富文本格式 */
  format?: 'text' | 'markdown' | 'html';
}

export interface Channel {
  readonly id: string;
  readonly type: ChannelType;
  enabled: boolean;

  /** 启动 channel（开始监听消息） */
  start(): Promise<void>;
  /** 停止 channel */
  stop(): Promise<void>;
  /** 发送消息到指定 chat */
  sendMessage(msg: OutgoingMessage): Promise<void>;
}

export interface ChannelConfig {
  telegram?: TelegramChannelConfig;
  webhook?: WebhookChannelConfig;
  github?: GithubChannelConfig;
}

/** 一个被 GitHub channel 盯着的仓库 */
export interface GithubChannelRepo {
  /** owner/repo */
  repo: string;
  /** 本机 clone 的路径 —— PR 分支会以 worktree 形式从这里签出 */
  path: string;
}

/**
 * GitHub channel configuration.
 *
 * Desktop uses REST polling with an incremental `since` cursor because it does not expose a public
 * webhook endpoint. Server hosts may additionally handle `POST /webhook/github` with
 * `X-Hub-Signature-256` verification. Authentication is read from `GITHUB_TOKEN`, `GH_TOKEN`, or
 * `gh auth token` and is not persisted by the channel.
 */
export interface GithubChannelConfig {
  enabled: boolean;
  /** 盯哪些仓库 + 本机 clone 在哪 */
  repos?: GithubChannelRepo[];
  /** 评论里要带的召唤词, 默认 "@neox" (大小写不敏感) */
  mention?: string;
  /** 轮询间隔 ms, 默认 30000, 最小 10000 */
  pollIntervalMs?: number;
  /** webhook 校验密钥 (只有 server 模式的 /webhook/github 用) */
  secret?: string;
  /** agent 提交了新 commit 就推到 PR 分支, 默认 true (fork 来的 PR 推不了, 只回评论) */
  autoPush?: boolean;
  /** 只认这些 GitHub 用户的评论 (空 = 仓库里谁都行) */
  allowedUsers?: string[];
  /** 跑 PR 任务用的模型 (不给 = 默认 provider) */
  providerId?: string;
  modelName?: string;
}

export interface TelegramChannelConfig {
  enabled: boolean;
  botToken: string;
  /** 允许的 chat ID 列表（空 = 允许所有） */
  allowedChatIds?: string[];
  /** 轮询间隔 ms（默认 3000） */
  pollingInterval?: number;
}

export interface WebhookChannelConfig {
  enabled: boolean;
  /** Webhook 验证密钥 */
  secret?: string;
}
