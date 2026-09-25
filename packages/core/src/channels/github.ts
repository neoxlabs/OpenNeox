import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Channel, IncomingMessage, OutgoingMessage, GithubChannelConfig, GithubChannelRepo } from '@neoxlabs/platform/channels/types.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import { resolveGithubToken } from '../tools/githubToken.js';
import { runCommand, type RunCommandResult } from '../tools/git/commandRunner.js';
import { isPluginCapabilityEnabled } from '../runtime/pluginCapabilityGate.js';

type OnMessage = (msg: IncomingMessage) => Promise<void>;

export const GITHUB_PR_AGENT_CAPABILITY = 'github-pr-agent';
const GATED_RECHECK_MS = 15_000;

/** 从 REST / webhook 两种来源归一出来的一条评论 */
export interface PrComment {
  repo: string;            // owner/repo
  number: number;          // PR 号
  commentId: number;
  kind: 'issue' | 'review';
  body: string;
  user: string;
  userType?: string;
  htmlUrl?: string;
  createdAt: string;
  /** 审查评论独有: 文件 / 行 / diff 片段 */
  path?: string;
  line?: number | null;
  diffHunk?: string;
}

export interface PrInfo {
  title: string;
  body: string;
  headRef: string;
  headSha: string;
  headRepo: string;
  baseRef: string;
  author: string;
  files: Array<{ filename: string; status: string; additions: number; deletions: number }>;
}

/** 落盘状态: 每个仓库的增量游标 + 见过的评论 id + 最近一次轮询 (设置页读它显示状态) */
export interface GithubChannelState {
  installedAt?: string;
  since?: Record<string, string>;
  seen?: number[];
  lastPollAt?: string;
  lastError?: string | null;
  login?: string;
  /** 已经开过会话的 PR (owner/repo#N → sessionId): 第二次评论不再重复塞 PR 描述 */
  prSessions?: Record<string, string>;
  recent?: Array<{ at: string; repo: string; number: number; user: string; status: 'started' | 'replied' | 'failed'; note?: string }>;
}

export const GITHUB_CHANNEL_STATE_FILE = neoxHome('channels', 'github.json');
const DEFAULT_MENTION = '@neox';
const MIN_POLL_MS = 10_000;
const DEFAULT_POLL_MS = 30_000;
const MAX_SEEN = 500;
const MAX_REPLY_CHARS = 60_000;
/** 我们自己回的评论都带这个 (HTML 注释, GitHub 不显示); 见到它就不再触发 */
export const REPLY_MARKER = '<!-- neox:reply -->';

/* ───────────────────────────── 纯函数 (可单测) ───────────────────────────── */

/** 评论里有没有召唤词 (整词匹配, 大小写不敏感): "@neox 改一下" ✓, "email@neoxmail.com" ✗ */
export function hasMention(body: string, mention: string = DEFAULT_MENTION): boolean {
  const m = mention.trim();
  if (!m) return false;
  const esc = m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w@])${esc}(?![\\w-])`, 'i').test(body);
}

/** 去掉召唤词后的指令正文 */
export function stripMention(body: string, mention: string = DEFAULT_MENTION): string {
  const esc = mention.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return body.replace(new RegExp(`(^|[^\\w@])${esc}(?![\\w-])`, 'gi'), '$1').trim();
}

/** 会话 id: 一个 PR 一个会话, 再来评论接着聊 */
export function prSessionId(repo: string, number: number): string {
  return `gh-${repo.replace(/[^A-Za-z0-9_-]+/g, '-')}-pr${number}`;
}

/** chatId 编码: 回到哪个 PR、要不要回在审查线程里 */
export function encodeChatId(c: Pick<PrComment, 'repo' | 'number' | 'kind' | 'commentId'>): string {
  return c.kind === 'review' ? `${c.repo}#${c.number}@rc:${c.commentId}` : `${c.repo}#${c.number}`;
}

export function decodeChatId(chatId: string): { repo: string; number: number; replyToReviewComment?: number } | null {
  const m = /^([^#\s]+\/[^#\s]+)#(\d+)(?:@rc:(\d+))?$/.exec(chatId);
  if (!m) return null;
  return { repo: m[1], number: Number(m[2]), ...(m[3] ? { replyToReviewComment: Number(m[3]) } : {}) };
}

export function prWorktreeDir(repo: string, number: number): string {
  return path.join(os.homedir(), '.neox-worktrees', repo.replace('/', '__'), `pr-${number}`);
}

/** agent 的本地分支名 —— 永远不碰用户 clone 里的分支, 推的时候 HEAD:refs/heads/<headRef> */
export function prLocalBranch(number: number): string {
  return `neox/pr-${number}`;
}

/** 把评论 + PR 上下文拼成 prompt */
export function buildPrPrompt(c: PrComment, pr: PrInfo, opts: { mention?: string; pushable: boolean; first: boolean }): string {
  const instruction = stripMention(c.body, opts.mention) || '(评论里没有具体指令, 按 PR 标题和描述判断要做什么)';
  const lines: string[] = [];
  lines.push(`GitHub PR 评论驱动的任务。仓库 ${c.repo}, PR #${c.number}「${pr.title}」(作者 @${pr.author}, 分支 ${pr.headRef} → ${pr.baseRef})。`);
  lines.push(`评论者 @${c.user}${c.htmlUrl ? ` (${c.htmlUrl})` : ''}:`);
  lines.push('');
  lines.push(instruction);
  lines.push('');
  if (c.kind === 'review' && c.path) {
    lines.push(`这条是审查评论, 挂在文件 \`${c.path}\`${typeof c.line === 'number' ? ` 第 ${c.line} 行` : ''}。相关 diff 片段:`);
    lines.push('```diff');
    lines.push((c.diffHunk ?? '').slice(0, 4000));
    lines.push('```');
    lines.push('');
  }
  if (opts.first) {
    if (pr.body?.trim()) {
      lines.push('PR 描述:');
      lines.push(pr.body.trim().slice(0, 3000));
      lines.push('');
    }
    if (pr.files.length) {
      lines.push(`PR 改动的文件 (${pr.files.length}):`);
      for (const f of pr.files.slice(0, 50)) lines.push(`- ${f.filename} (${f.status}, +${f.additions} −${f.deletions})`);
      if (pr.files.length > 50) lines.push(`- … 还有 ${pr.files.length - 50} 个`);
      lines.push('');
    }
  }
  lines.push('要求:');
  lines.push(`- 当前工作区已经签出这个 PR 的分支 (HEAD = ${pr.headSha.slice(0, 7)})。直接在这里改。`);
  lines.push('- 改完用 git 提交 (git add + git commit, 提交信息简洁说明做了什么)。**不要 push**, 系统会推。');
  if (!opts.pushable) lines.push('- 这个 PR 来自 fork, 提交推不回去; 把改动写成 diff 贴在回复里。');
  lines.push('- 你的最后一条回复会原样贴回 PR 评论区: 用 Markdown, 说清做了什么、改了哪些文件、有什么没做/需要人决定的; 不要寒暄。');
  return lines.join('\n');
}

/** GitHub webhook 签名校验 (X-Hub-Signature-256 = sha256=<hmac(rawBody)>) */
export function verifyGithubSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** webhook payload → PrComment (只认 PR 上 created 的评论; 别的事件 null) */
export function commentFromWebhook(event: string | undefined, body: any): PrComment | null {
  if (!body || body.action !== 'created') return null;
  const repo = body.repository?.full_name;
  if (typeof repo !== 'string') return null;
  const cm = body.comment;
  if (!cm || typeof cm.body !== 'string') return null;
  if (event === 'issue_comment') {
    if (!body.issue?.pull_request) return null;
    return {
      repo, number: Number(body.issue.number), commentId: Number(cm.id), kind: 'issue',
      body: cm.body, user: String(cm.user?.login ?? ''), userType: cm.user?.type, htmlUrl: cm.html_url, createdAt: cm.created_at,
    };
  }
  if (event === 'pull_request_review_comment') {
    return {
      repo, number: Number(body.pull_request?.number), commentId: Number(cm.id), kind: 'review',
      body: cm.body, user: String(cm.user?.login ?? ''), userType: cm.user?.type, htmlUrl: cm.html_url, createdAt: cm.created_at,
      path: cm.path, line: cm.line ?? cm.original_line ?? null, diffHunk: cm.diff_hunk,
    };
  }
  return null;
}

/** REST 列表项 → PrComment。issue 评论要靠 issue_url 拿 PR 号 (是不是 PR 由调用方再确认) */
export function commentFromRest(repo: string, kind: 'issue' | 'review', item: any): PrComment | null {
  if (!item || typeof item.body !== 'string') return null;
  let number: number | null = null;
  if (kind === 'issue') {
    const m = /\/issues\/(\d+)$/.exec(String(item.issue_url ?? ''));
    number = m ? Number(m[1]) : null;
  } else {
    const m = /\/pulls\/(\d+)$/.exec(String(item.pull_request_url ?? ''));
    number = m ? Number(m[1]) : null;
  }
  if (!number) return null;
  return {
    repo, number, commentId: Number(item.id), kind,
    body: item.body, user: String(item.user?.login ?? ''), userType: item.user?.type, htmlUrl: item.html_url, createdAt: item.created_at,
    ...(kind === 'review' ? { path: item.path, line: item.line ?? item.original_line ?? null, diffHunk: item.diff_hunk } : {}),
  };
}

export function loadGithubChannelState(file: string = GITHUB_CHANNEL_STATE_FILE): GithubChannelState {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as GithubChannelState; } catch { return {}; }
}

export function saveGithubChannelState(state: GithubChannelState, file: string = GITHUB_CHANNEL_STATE_FILE): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  } catch (err: any) {
    cliLogger.warn('GITHUB', `状态落盘失败: ${err?.message ?? err}`);
  }
}

/* ───────────────────────────── channel 本体 ───────────────────────────── */

interface JobCtx {
  worktree: string;
  headRef: string;
  pushable: boolean;
  repoPath: string;
}

export class GithubChannel implements Channel {
  readonly id = 'github';
  readonly type = 'github' as const;
  enabled: boolean;

  private config: GithubChannelConfig;
  private onMessage: OnMessage;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private state: GithubChannelState;
  private stateFile: string;
  private seen: Set<number>;
  private jobs = new Map<string, JobCtx>();
  /** 串行处理: 同一时刻只跑一条评论, 免得两个 PR 同时抢一个 clone 的 fetch */
  private queue: Promise<void> = Promise.resolve();
  private started = 0;
  private apiBase: string;
  private fetchImpl: typeof fetch;
  /** 插件装了没有 (测试可注入; 默认读插件注册表) */
  private capabilityOn: () => boolean;
  /** 上一轮是不是在工作 (插件开 && 开关开)。null = 启动后还没轮过 */
  private lastActive: boolean | null = null;

  /** 评论边界挪到现在: 客户端过滤 (installedAt) + 服务端游标 (since) 一起挪 */
  private acceptFromNow(): void {
    const now = new Date().toISOString();
    this.state.installedAt = now;
    this.state.since = Object.fromEntries(this.repos.map((r) => [r.repo, now]));
    cliLogger.info('GITHUB', `GitHub channel 重新打开: 只处理 ${now} 之后的评论`);
  }

  constructor(
    config: GithubChannelConfig,
    onMessage: OnMessage,
    opts?: { stateFile?: string; apiBase?: string; fetchImpl?: typeof fetch; capabilityCheck?: () => boolean },
  ) {
    this.config = config;
    this.enabled = config.enabled;
    this.onMessage = onMessage;
    this.stateFile = opts?.stateFile ?? GITHUB_CHANNEL_STATE_FILE;
    this.apiBase = opts?.apiBase ?? 'https://api.github.com';
    this.fetchImpl = opts?.fetchImpl ?? fetch;
    this.capabilityOn = opts?.capabilityCheck ?? (() => isPluginCapabilityEnabled(GITHUB_PR_AGENT_CAPABILITY));
    this.state = loadGithubChannelState(this.stateFile);
    this.seen = new Set(this.state.seen ?? []);
  }

  /** 设置页改完配置直接热更新 —— 每次轮询前从盘上重读 (真相源 ~/.neox/config.json), 不靠任何 IPC 通知 */
  updateConfig(config: GithubChannelConfig): void {
    this.config = config;
    this.enabled = config.enabled === true;
  }

  private refreshConfigFromDisk(): void {
    try {
      const fresh = (loadConfig() as { channels?: { github?: GithubChannelConfig } }).channels?.github;
      this.updateConfig(fresh ?? { enabled: false });
    } catch { /* 读不到就沿用内存里的 */ }
  }

  get mention(): string { return (this.config.mention ?? DEFAULT_MENTION).trim() || DEFAULT_MENTION; }
  get pollIntervalMs(): number { return Math.max(MIN_POLL_MS, this.config.pollIntervalMs ?? DEFAULT_POLL_MS); }
  get repos(): GithubChannelRepo[] {
    return (this.config.repos ?? []).filter((r) => r && typeof r.repo === 'string' && /^[^/\s]+\/[^/\s]+$/.test(r.repo) && typeof r.path === 'string' && r.path);
  }

  async start(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.started = Date.now();
    const pluginOn = this.capabilityOn();
    if (pluginOn && !this.state.installedAt) this.state.installedAt = new Date().toISOString();
    if (pluginOn && this.enabled) await this.resolveLogin();
    cliLogger.info('GITHUB', pluginOn
      ? `GitHub channel 就绪: ${this.enabled ? '开' : '关'}, ${this.repos.length} 个仓库, 每 ${this.pollIntervalMs / 1000}s 拉一次, 召唤词 ${this.mention}`
      : 'GitHub channel 待命: 没装 GitHub PR Agent 插件, 不拉评论');
    this.timer = setTimeout(() => void this.poll(), 1500);
  }

  /** token 对应的账号 —— 用来忽略自己发的评论; 没 token 就把原因写进状态给设置页看 */
  private async resolveLogin(): Promise<void> {
    const token = resolveGithubToken();
    if (!token) {
      this.state.lastError = '没有 GitHub token: 设 GITHUB_TOKEN 或先 `gh auth login`';
      this.persist();
      return;
    }
    try {
      const me = await this.api<{ login: string }>('GET', '/user');
      this.state.login = me.login;
      this.state.lastError = null;
    } catch (err: any) {
      this.state.lastError = `token 无效: ${err?.message ?? err}`;
    }
    this.persist();
  }

  async stop(): Promise<void> {
    this.polling = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** 回复: 先推代码 (有新提交且能推), 再把回复贴回 PR */
  async sendMessage(msg: OutgoingMessage): Promise<void> {
    const target = decodeChatId(msg.chatId);
    if (!target) { cliLogger.warn('GITHUB', `chatId 不认识: ${msg.chatId}`); return; }
    const job = this.jobs.get(msg.chatId);
    this.jobs.delete(msg.chatId);
    let footer = '';
    if (job) {
      try {
        const pushed = await this.pushIfNeeded(job);
        if (pushed.count > 0) {
          footer = pushed.pushed
            ? `\n\n---\n已推送 ${pushed.count} 个提交到 \`${job.headRef}\`:\n${pushed.log}`
            : `\n\n---\n有 ${pushed.count} 个提交没有推送 (${pushed.reason}):\n${pushed.log}`;
        }
      } catch (err: any) {
        footer = `\n\n---\n推送失败: ${err?.message ?? err}`;
      }
    }
    let body = (msg.text || '(没有回复内容)').trim();
    if (body.length > MAX_REPLY_CHARS) body = body.slice(0, MAX_REPLY_CHARS) + '\n\n… (已截断)';
    body += footer + `\n\n${REPLY_MARKER}`;
    const [owner, repo] = target.repo.split('/');
    try {
      if (target.replyToReviewComment) {
        await this.api('POST', `/repos/${owner}/${repo}/pulls/${target.number}/comments/${target.replyToReviewComment}/replies`, { body });
      } else {
        await this.api('POST', `/repos/${owner}/${repo}/issues/${target.number}/comments`, { body });
      }
      this.note(target.repo, target.number, this.state.login ?? '', 'replied');
    } catch (err: any) {
      this.note(target.repo, target.number, this.state.login ?? '', 'failed', `回评论失败: ${err?.message ?? err}`);
      throw err;
    }
  }

  /** server 模式 webhook 入口 (registry.handleWebhook 调)。返回 'accepted' | 'ignored' */
  async handleIncoming(rawBody: string, headers: { signature?: string; event?: string }): Promise<string> {
    if (!this.capabilityOn()) throw new Error('没装 GitHub PR Agent 插件, 不收');
    if (!this.config.secret) throw new Error('GitHub webhook 没配 secret, 不收');
    if (!verifyGithubSignature(rawBody, headers.signature, this.config.secret)) throw new Error('Invalid webhook signature');
    const body = JSON.parse(rawBody);
    const c = commentFromWebhook(headers.event, body);
    if (!c) return 'ignored';
    if (!this.repos.some((r) => r.repo.toLowerCase() === c.repo.toLowerCase())) return 'ignored';
    this.enqueue(c);
    return 'accepted';
  }

  /* ───────────── 轮询 ───────────── */

  private async poll(): Promise<void> {
    if (!this.polling) return;
    const pluginOn = this.capabilityOn();
    if (pluginOn) this.refreshConfigFromDisk();
    const active = pluginOn && this.enabled;
    /* 关 → 开 (插件刚装上 / 刚启用 / 开关刚打开): 从这一刻起算"新评论"。
     * 用户明确关着的那段时间里的评论不补跑 —— 关一周再打开, 不该一口气冒出一串过期任务。
     * 应用只是没开着 (lastActive=null, 启动后第一轮) 不算"关": 那期间的评论照常处理, 那是排队的指令。 */
    if (active && this.lastActive === false) this.acceptFromNow();
    this.lastActive = active;
    /* 插件闸: 没装 / 停用了插件 → 什么都不做 (不发请求、不写状态), 过一会儿再看一眼注册表 */
    if (!pluginOn) {
      this.timer = setTimeout(() => void this.poll(), GATED_RECHECK_MS);
      return;
    }
    if (!this.state.installedAt) this.state.installedAt = new Date().toISOString();
    try {
      if (this.enabled && resolveGithubToken()) {
        if (!this.state.login) await this.resolveLogin();
        for (const r of this.repos) await this.pollRepo(r);
        this.state.lastPollAt = new Date().toISOString();
        this.state.lastError = null;
      }
    } catch (err: any) {
      this.state.lastError = err?.message ?? String(err);
      cliLogger.warn('GITHUB', `轮询失败: ${this.state.lastError}`);
    }
    this.persist();
    if (this.polling) this.timer = setTimeout(() => void this.poll(), this.pollIntervalMs);
  }

  private async pollRepo(r: GithubChannelRepo): Promise<void> {
    const [owner, repo] = r.repo.split('/');
    const since = this.state.since?.[r.repo] ?? this.state.installedAt ?? new Date(this.started).toISOString();
    let maxUpdated = since;
    const q = `since=${encodeURIComponent(since)}&sort=updated&direction=asc&per_page=100`;
    const issueComments = await this.api<any[]>('GET', `/repos/${owner}/${repo}/issues/comments?${q}`);
    const reviewComments = await this.api<any[]>('GET', `/repos/${owner}/${repo}/pulls/comments?${q}`);
    const candidates: PrComment[] = [];
    for (const it of issueComments) {
      if (typeof it?.updated_at === 'string' && it.updated_at > maxUpdated) maxUpdated = it.updated_at;
      const c = commentFromRest(r.repo, 'issue', it);
      if (c) candidates.push(c);
    }
    for (const it of reviewComments) {
      if (typeof it?.updated_at === 'string' && it.updated_at > maxUpdated) maxUpdated = it.updated_at;
      const c = commentFromRest(r.repo, 'review', it);
      if (c) candidates.push(c);
    }
    for (const c of candidates) {
      if (this.seen.has(c.commentId)) continue;
      if (c.createdAt && this.state.installedAt && c.createdAt < this.state.installedAt) { this.markSeen(c.commentId); continue; }
      if (!this.accepts(c)) { this.markSeen(c.commentId); continue; }
      if (c.kind === 'issue') {
        /* issues/comments 把 issue 和 PR 的评论混在一起; 不是 PR 的不要 */
        const isPr = await this.isPullRequest(owner, repo, c.number);
        if (!isPr) { this.markSeen(c.commentId); continue; }
      }
      this.enqueue(c);
    }
    this.state.since = { ...(this.state.since ?? {}), [r.repo]: maxUpdated };
  }

  private accepts(c: PrComment): boolean {
    if (!hasMention(c.body, this.mention)) return false;
    if (c.userType === 'Bot') return false;
    if (c.body.includes(REPLY_MARKER)) return false;
    const allowed = (this.config.allowedUsers ?? []).map((u) => u.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.includes(c.user.toLowerCase())) return false;
    return true;
  }

  private async isPullRequest(owner: string, repo: string, number: number): Promise<boolean> {
    try { await this.api('GET', `/repos/${owner}/${repo}/pulls/${number}`); return true; } catch { return false; }
  }

  private enqueue(c: PrComment): void {
    if (this.seen.has(c.commentId)) return;
    this.markSeen(c.commentId);
    this.persist();
    this.queue = this.queue.then(() => this.processComment(c)).catch((err) => {
      cliLogger.error('GITHUB', `处理评论 ${c.repo}#${c.number} 失败: ${err?.message ?? err}`);
      this.note(c.repo, c.number, c.user, 'failed', err?.message ?? String(err));
    });
  }

  /* ───────────── 一条评论 → 一个会话 ───────────── */

  private async processComment(c: PrComment): Promise<void> {
    const repoCfg = this.repos.find((r) => r.repo.toLowerCase() === c.repo.toLowerCase());
    if (!repoCfg) return;
    const [owner, repo] = c.repo.split('/');
    cliLogger.info('GITHUB', `${c.repo}#${c.number} @${c.user}: ${c.body.slice(0, 80).replace(/\n/g, ' ')}`);
    this.note(c.repo, c.number, c.user, 'started');

    const pr = await this.api<any>('GET', `/repos/${owner}/${repo}/pulls/${c.number}`);
    const filesRaw = await this.api<any[]>('GET', `/repos/${owner}/${repo}/pulls/${c.number}/files?per_page=100`).catch(() => []);
    const info: PrInfo = {
      title: String(pr.title ?? ''),
      body: String(pr.body ?? ''),
      headRef: String(pr.head?.ref ?? ''),
      headSha: String(pr.head?.sha ?? ''),
      headRepo: String(pr.head?.repo?.full_name ?? ''),
      baseRef: String(pr.base?.ref ?? ''),
      author: String(pr.user?.login ?? ''),
      files: filesRaw.map((f) => ({ filename: String(f.filename), status: String(f.status), additions: Number(f.additions ?? 0), deletions: Number(f.deletions ?? 0) })),
    };
    const pushable = info.headRepo.toLowerCase() === c.repo.toLowerCase() && pr.state === 'open';

    const worktree = await this.prepareWorktree(repoCfg, c.number, info, pushable);
    const chatId = encodeChatId(c);
    const sessionId = prSessionId(c.repo, c.number);
    /* 第一次进这个 PR 才把描述/文件清单塞进 prompt; 记在状态文件里, 不往 worktree 里丢标记文件 (会变成 untracked 干扰 agent) */
    const prKey = `${c.repo}#${c.number}`;
    const first = !(this.state.prSessions?.[prKey]);
    this.state.prSessions = { ...(this.state.prSessions ?? {}), [prKey]: sessionId };
    this.persist();
    this.jobs.set(chatId, { worktree, headRef: info.headRef, pushable: pushable && this.config.autoPush !== false, repoPath: repoCfg.path });

    await this.onMessage({
      channelId: this.id,
      chatId,
      text: buildPrPrompt(c, info, { mention: this.mention, pushable, first }),
      from: { id: c.user, name: c.user },
      timestamp: Date.now(),
      raw: c,
      sessionId,
      workspacePath: worktree,
      sessionName: `PR #${c.number} · ${info.title}`.slice(0, 80),
      agentMode: 'code',
      ...(this.config.providerId ? { providerId: this.config.providerId } : {}),
      ...(this.config.modelName ? { modelName: this.config.modelName } : {}),
    });
  }

  /** 把 PR 分支签出到独立 worktree: 用户 clone 只做 fetch, 分支/工作树都不动 */
  private async prepareWorktree(repoCfg: GithubChannelRepo, number: number, pr: PrInfo, pushable: boolean): Promise<string> {
    const clone = repoCfg.path;
    if (!fs.existsSync(path.join(clone, '.git'))) throw new Error(`本机 clone 不是 git 仓库: ${clone}`);
    const wt = prWorktreeDir(repoCfg.repo, number);
    const branch = prLocalBranch(number);
    /* 同仓 PR 取分支 (推得回去); fork PR 取 refs/pull/N/head (只读) */
    const remoteRef = pushable || pr.headRepo.toLowerCase() === repoCfg.repo.toLowerCase()
      ? `+refs/heads/${pr.headRef}:refs/remotes/origin/${pr.headRef}`
      : `+refs/pull/${number}/head:refs/remotes/neox-pr/${number}`;
    const startPoint = remoteRef.split(':')[1];
    await this.git(clone, ['fetch', '--no-tags', 'origin', remoteRef]);

    const alive = fs.existsSync(path.join(wt, '.git'));
    if (!alive) {
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      await this.git(clone, ['worktree', 'prune']).catch(() => null);
      await this.git(clone, ['worktree', 'add', '-B', branch, wt, startPoint]);
    } else {
      const st = await this.git(wt, ['status', '--porcelain']);
      if (!st.stdout.trim()) {
        await this.git(wt, ['merge', '--ff-only', startPoint]).catch((e) => cliLogger.warn('GITHUB', `worktree 快进失败 (保留现状): ${e?.message ?? e}`));
      }
    }
    return wt;
  }

  private async pushIfNeeded(job: JobCtx): Promise<{ count: number; pushed: boolean; log: string; reason?: string }> {
    const upstream = `origin/${job.headRef}`;
    const cnt = await this.git(job.worktree, ['rev-list', '--count', `${upstream}..HEAD`]).catch(() => null);
    const count = cnt ? Number(cnt.stdout.trim()) || 0 : 0;
    if (count === 0) return { count: 0, pushed: false, log: '' };
    const logRes = await this.git(job.worktree, ['log', '--format=- `%h` %s', `${upstream}..HEAD`]);
    const log = logRes.stdout.trim();
    if (!job.pushable) return { count, pushed: false, log, reason: 'fork PR 或已关闭, 推不回去' };
    await this.git(job.worktree, ['push', 'origin', `HEAD:refs/heads/${job.headRef}`], 120_000);
    /* 推完把远端跟踪引用对齐, 下次 rev-list 才算得准 */
    await this.git(job.repoPath, ['fetch', '--no-tags', 'origin', `+refs/heads/${job.headRef}:refs/remotes/origin/${job.headRef}`]).catch(() => null);
    return { count, pushed: true, log };
  }

  private async git(cwd: string, args: string[], timeoutMs = 60_000): Promise<RunCommandResult> {
    const r = await runCommand('git', args, cwd, { timeoutMs });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} 失败 (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
    return r;
  }

  /* ───────────── GitHub API ───────────── */

  private async api<T = any>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
    const token = resolveGithubToken();
    if (!token) throw new Error('没有 GitHub token');
    const res = await this.fetchImpl(`${this.apiBase}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'neox-github-channel',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub ${method} ${route} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  /* ───────────── 状态 ───────────── */

  private markSeen(id: number): void {
    this.seen.add(id);
    if (this.seen.size > MAX_SEEN) {
      const arr = Array.from(this.seen);
      this.seen = new Set(arr.slice(arr.length - MAX_SEEN));
    }
  }

  private note(repo: string, number: number, user: string, status: 'started' | 'replied' | 'failed', noteText?: string): void {
    const recent = this.state.recent ?? [];
    const entry = { at: new Date().toISOString(), repo, number, user, status, ...(noteText ? { note: noteText.slice(0, 300) } : {}) };
    /* started → replied/failed 是同一件事的两个阶段, 合成一条; 设置页看到的是"这条评论现在什么状态" */
    const last = recent[recent.length - 1];
    if (status !== 'started' && last && last.status === 'started' && last.repo === repo && last.number === number) recent[recent.length - 1] = entry;
    else recent.push(entry);
    this.state.recent = recent.slice(-20);
    this.persist();
  }

  private persist(): void {
    this.state.seen = Array.from(this.seen);
    saveGithubChannelState(this.state, this.stateFile);
  }
}
