/**
 * GitHub channel 纯函数 + 轮询/回复主链 (fetch 全 mock, 不碰网络, 不碰 git)
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHmac } from 'node:crypto';
import {
  prWorktreeDir,
  hasMention, stripMention, prSessionId, encodeChatId, decodeChatId, buildPrPrompt,
  verifyGithubSignature, commentFromWebhook, commentFromRest, GithubChannel, loadGithubChannelState,
} from '../github.js';

vi.mock('../../tools/githubToken.js', () => ({ resolveGithubToken: () => 'tok', resetGithubTokenCache: () => {} }));
/* 轮询前会从盘上重读配置 (设置页热更新的机制); 测试里用这个盒子代替 config.json */
const diskConfig: { channels?: { github?: any } } = {};
vi.mock('@neoxlabs/platform/utils/config.js', () => ({ loadConfig: () => diskConfig }));

describe('召唤词', () => {
  it('整词匹配, 不分大小写', () => {
    expect(hasMention('@neox 改一下')).toBe(true);
    expect(hasMention('please @NEOX fix')).toBe(true);
    expect(hasMention('mail me at a@neox.dev')).toBe(false);
    expect(hasMention('@neoxbot hi')).toBe(false);
    expect(hasMention('no mention here')).toBe(false);
    expect(hasMention('@bot do', '@bot')).toBe(true);
  });
  it('去掉召唤词剩指令', () => {
    expect(stripMention('@neox 把 any 改成具体类型')).toBe('把 any 改成具体类型');
    expect(stripMention('前面 @neox 后面')).toBe('前面  后面');
  });
});

describe('worktree 落点', () => {
  it('不在 ~/.neox 下 (那里被文件工具的敏感路径检查整个拒绝)', () => {
    const wt = prWorktreeDir('a/b', 3);
    expect(wt).toBe(path.join(os.homedir(), '.neox-worktrees', 'a__b', 'pr-3'));
    expect(wt.includes(`${path.sep}.neox${path.sep}`)).toBe(false);
  });
});

describe('id 编解码', () => {
  it('session / chatId 往返', () => {
    expect(prSessionId('lmk1010/neox-os', 12)).toBe('gh-lmk1010-neox-os-pr12');
    const issue = encodeChatId({ repo: 'a/b', number: 3, kind: 'issue', commentId: 9 });
    const review = encodeChatId({ repo: 'a/b', number: 3, kind: 'review', commentId: 9 });
    expect(decodeChatId(issue)).toEqual({ repo: 'a/b', number: 3 });
    expect(decodeChatId(review)).toEqual({ repo: 'a/b', number: 3, replyToReviewComment: 9 });
    expect(decodeChatId('garbage')).toBeNull();
  });
});

describe('webhook', () => {
  const secret = 's3cret';
  it('签名对得上才认', () => {
    const raw = '{"a":1}';
    const sig = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    expect(verifyGithubSignature(raw, sig, secret)).toBe(true);
    expect(verifyGithubSignature(raw + ' ', sig, secret)).toBe(false);
    expect(verifyGithubSignature(raw, undefined, secret)).toBe(false);
  });
  it('只认 PR 上 created 的评论', () => {
    const base = { action: 'created', repository: { full_name: 'a/b' }, comment: { id: 1, body: '@neox x', user: { login: 'u' }, created_at: 't' } };
    expect(commentFromWebhook('issue_comment', { ...base, issue: { number: 5 } })).toBeNull();
    expect(commentFromWebhook('issue_comment', { ...base, issue: { number: 5, pull_request: {} } })?.number).toBe(5);
    expect(commentFromWebhook('pull_request_review_comment', { ...base, pull_request: { number: 7 }, comment: { ...base.comment, path: 'f.ts', line: 3, diff_hunk: '@@' } })).toMatchObject({ number: 7, kind: 'review', path: 'f.ts', line: 3 });
    expect(commentFromWebhook('issue_comment', { ...base, action: 'edited', issue: { number: 5, pull_request: {} } })).toBeNull();
  });
});

describe('prompt', () => {
  it('带 PR 上下文和不许 push 的要求', () => {
    const p = buildPrPrompt(
      { repo: 'a/b', number: 1, commentId: 1, kind: 'review', body: '@neox 这里改成 const', user: 'u', createdAt: 't', path: 'src/x.ts', line: 10, diffHunk: '@@ -1 +1 @@' },
      { title: 'T', body: 'B', headRef: 'feat', headSha: 'abcdef1234', headRepo: 'a/b', baseRef: 'main', author: 'me', files: [{ filename: 'src/x.ts', status: 'modified', additions: 1, deletions: 1 }] },
      { pushable: true, first: true },
    );
    expect(p).toContain('这里改成 const');
    expect(p).toContain('src/x.ts');
    expect(p).toContain('第 10 行');
    expect(p).toContain('不要 push');
    expect(p).not.toContain('@neox');
  });
});

/* ── 轮询主链: mock fetch, 看它拉哪些接口、过滤谁、给 onMessage 什么 ── */
function mkChannel(opts: { comments?: any[]; reviews?: any[]; pulls?: Record<number, any>; onMessage?: (m: any) => Promise<void>; enabled?: boolean; pluginInstalled?: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghch-'));
  const stateFile = path.join(dir, 'state.json');
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: any) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const u = new URL(url);
    const p = u.pathname;
    const json = (v: any, status = 200) => ({ ok: status < 400, status, json: async () => v, text: async () => JSON.stringify(v) });
    if (p === '/user') return json({ login: 'me' });
    if (p.endsWith('/issues/comments')) return json(opts.comments ?? []);
    if (p.endsWith('/pulls/comments')) return json(opts.reviews ?? []);
    const m = /\/pulls\/(\d+)$/.exec(p);
    if (m) { const pr = opts.pulls?.[Number(m[1])]; return pr ? json(pr) : json({ message: 'nf' }, 404); }
    if (/\/pulls\/\d+\/files$/.test(p)) return json([]);
    if (/\/issues\/\d+\/comments$/.test(p) && init?.method === 'POST') return json({ id: 99 });
    return json({ message: `unhandled ${p}` }, 500);
  }) as unknown as typeof fetch;
  const onMessage = opts.onMessage ?? (async () => {});
  diskConfig.channels = { github: { enabled: opts.enabled ?? true, repos: [{ repo: 'a/b', path: dir }] } };
  const ch = new GithubChannel(
    { enabled: opts.enabled ?? true, repos: [{ repo: 'a/b', path: dir }] },
    onMessage,
    { stateFile, apiBase: 'https://x.test', fetchImpl, capabilityCheck: () => opts.pluginInstalled ?? true },
  );
  return { ch, calls, stateFile, dir };
}

describe('GithubChannel 轮询', () => {
  it('只对带召唤词、非机器人、非自己回复、PR 上的评论触发; 结果落状态文件', async () => {
    const got: any[] = [];
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 1000).toISOString();
    const { ch, calls, stateFile } = mkChannel({
      comments: [
        { id: 1, body: '@neox 改', user: { login: 'alice' }, created_at: later, updated_at: later, issue_url: 'https://x/repos/a/b/issues/10' },
        { id: 2, body: '没召唤', user: { login: 'alice' }, created_at: later, updated_at: later, issue_url: 'https://x/repos/a/b/issues/10' },
        { id: 3, body: '@neox 机器人', user: { login: 'bot', type: 'Bot' }, created_at: later, updated_at: later, issue_url: 'https://x/repos/a/b/issues/10' },
        { id: 4, body: '@neox 我自己回的\n\n<!-- neox:reply -->', user: { login: 'me' }, created_at: later, updated_at: later, issue_url: 'https://x/repos/a/b/issues/10' },
        { id: 5, body: '@neox 不是 PR', user: { login: 'alice' }, created_at: later, updated_at: later, issue_url: 'https://x/repos/a/b/issues/11' },
      ],
      pulls: { 10: { title: 'T', body: '', head: { ref: 'feat', sha: 'abc', repo: { full_name: 'a/b' } }, base: { ref: 'main' }, user: { login: 'o' }, state: 'open' } },
      onMessage: async (m) => { got.push(m); },
    });
    /* 不真跑 git: 把 worktree 准备换成假的 */
    (ch as any).prepareWorktree = async () => '/tmp/fake-wt';
    (ch as any).state.installedAt = now;
    await ch.start();
    await (ch as any).poll();
    await (ch as any).queue;
    await ch.stop();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ chatId: 'a/b#10', sessionId: 'gh-a-b-pr10', workspacePath: '/tmp/fake-wt', agentMode: 'code' });
    expect(got[0].text).toContain('改');
    expect(calls.some((c) => c.includes('/repos/a/b/issues/comments?since='))).toBe(true);
    expect(calls.some((c) => c.includes('/repos/a/b/pulls/comments?since='))).toBe(true);
    const st = loadGithubChannelState(stateFile);
    expect(st.seen).toEqual(expect.arrayContaining([1, 2, 3, 4, 5]));
    expect(st.login).toBe('me');
    expect(st.since?.['a/b']).toBe(later);
    expect(st.recent?.[0]).toMatchObject({ repo: 'a/b', number: 10, user: 'alice', status: 'started' });
    expect(st.prSessions).toEqual({ 'a/b#10': 'gh-a-b-pr10' });
  });

  it('没装插件: 开关开着也一次请求都不发、不写状态文件', async () => {
    const later = new Date(Date.now() + 1000).toISOString();
    const got: any[] = [];
    const { ch, calls, stateFile } = mkChannel({
      pluginInstalled: false,
      comments: [{ id: 1, body: '@neox 改', user: { login: 'alice' }, created_at: later, updated_at: later, issue_url: 'https://x/repos/a/b/issues/10' }],
      onMessage: async (m) => { got.push(m); },
    });
    await ch.start();
    await (ch as any).poll();
    await ch.stop();
    expect(calls).toHaveLength(0);
    expect(got).toHaveLength(0);
    expect(fs.existsSync(stateFile)).toBe(false);
    await expect(ch.handleIncoming('{}', { signature: 'x', event: 'issue_comment' })).rejects.toThrow(/插件/);
  });

  it('关着那段时间的评论, 重新打开后不补跑; 打开之后的照常处理', async () => {
    let installed = false;
    const got: any[] = [];
    const past = new Date(Date.now() - 60_000).toISOString();
    const comments: any[] = [
      { id: 1, body: '@neox 关着时发的', user: { login: 'alice' }, created_at: past, updated_at: past, issue_url: 'https://x/repos/a/b/issues/10' },
    ];
    const { ch } = mkChannel({
      comments,
      pulls: { 10: { title: 'T', body: '', head: { ref: 'feat', sha: 'abc', repo: { full_name: 'a/b' } }, base: { ref: 'main' }, user: { login: 'o' }, state: 'open' } },
      onMessage: async (m) => { got.push(m); },
    });
    (ch as any).capabilityOn = () => installed;
    (ch as any).prepareWorktree = async () => '/tmp/fake-wt';
    (ch as any).state.installedAt = new Date(Date.now() - 3_600_000).toISOString();
    await ch.start();
    await (ch as any).poll();            // 插件没装: 待命
    installed = true;
    await (ch as any).poll();            // 刚装上: 边界挪到现在, 关着时那条不处理
    await (ch as any).queue;
    expect(got).toHaveLength(0);
    const later = new Date(Date.now() + 1000).toISOString();
    comments.push({ id: 2, body: '@neox 装上之后发的', user: { login: 'alice' }, created_at: later, updated_at: later, issue_url: 'https://x/repos/a/b/issues/10' });
    await (ch as any).poll();
    await (ch as any).queue;
    await ch.stop();
    expect(got.map((m) => m.raw.commentId)).toEqual([2]);
  });

  it('关着时什么都不拉', async () => {
    const { ch, calls } = mkChannel({ enabled: false, comments: [{ id: 1, body: '@neox', user: { login: 'a' } }] });
    await ch.start();
    await (ch as any).poll();
    await ch.stop();
    expect(calls.filter((c) => c.includes('/comments'))).toHaveLength(0);
  });

  it('回复贴到 PR; 没有 job 时不碰 git', async () => {
    const { ch, calls } = mkChannel({});
    await ch.sendMessage({ chatId: 'a/b#10', text: '做完了' });
    expect(calls).toContain('POST https://x.test/repos/a/b/issues/10/comments');
  });
});
