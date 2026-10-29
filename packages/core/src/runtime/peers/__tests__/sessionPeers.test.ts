import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/* socket 路径受内核 sun_path 长度限制 (macOS 104 字节)。测试机的 TMPDIR 可能很长
 * (CI / 沙箱会把会话临时目录套在 TMPDIR 下面), 超长时内核静默截断, 两个不同 endpoint
 * 会撞成同一个 socket —— 所以这里用尽量短的根, 不跟 TMPDIR 长度赌博。 */
const root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'peers-'));
vi.mock('@neoxlabs/kernel/platform/neoxHome.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  neoxHome: (...parts: string[]) => join(root, ...parts),
}));

const peers = await import('../sessionPeers.js');

const sender = { sessionId: 'sender-1', name: 'API 重构', cwd: '/w/api', client: 'cli' as const };

describe('sessionPeers', () => {
  const received: any[] = [];
  let host: Awaited<ReturnType<typeof peers.startSessionPeerHost>>;

  beforeAll(async () => {
    host = await peers.startSessionPeerHost('desktop', (req) => {
      if (!host.has(req.to)) return { ok: false, error: 'not here' };
      received.push(req);
      return { ok: true, state: 'started' };
    });
  });
  afterAll(() => {
    host.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('登记的会话写进清单, 列得出来', async () => {
    host.touch('sess-aaaaaaaa', { name: '前端', cwd: '/w/web', busy: true, lastActiveAt: 2 });
    host.touch('sess-bbbbbbbb', { name: '文档', cwd: '/w/docs', busy: false, lastActiveAt: 1 });
    await new Promise(r => setTimeout(r, 400));
    const list = peers.listPeerSessions();
    expect(list.map(e => e.sessionId)).toEqual(['sess-aaaaaaaa', 'sess-bbbbbbbb']);
    expect(list[0]).toMatchObject({ name: '前端', busy: true, client: 'desktop', pid: process.pid });
  });

  it('关掉的会话从清单里消失', async () => {
    host.touch('sess-cccccccc', { name: '临时', cwd: '/w/tmp' });
    host.remove('sess-cccccccc');
    await new Promise(r => setTimeout(r, 400));
    expect(peers.listPeerSessions().some(e => e.sessionId === 'sess-cccccccc')).toBe(false);
  });

  it('死进程的清单被清掉', () => {
    const dir = peers.peersDir();
    writeFileSync(join(dir, '999999-0.json'), JSON.stringify({
      v: 1, pid: 999999, endpoint: join(dir, '999999-0.sock'), client: 'cli', startedAt: 0,
      sessions: [{ sessionId: 'ghost', name: 'ghost', cwd: '/', busy: false, lastActiveAt: 9 }],
    }));
    expect(peers.listPeerSessions().some(e => e.sessionId === 'ghost')).toBe(false);
    expect(existsSync(join(dir, '999999-0.json'))).toBe(false);
  });

  it('按 id / 前缀 / 名字认人, 认不准就不猜', () => {
    const list = peers.listPeerSessions();
    expect('entry' in peers.resolvePeerTarget(list, 'sess-aaaaaaaa')).toBe(true);
    expect((peers.resolvePeerTarget(list, 'sess-bbbb') as any).entry?.name).toBe('文档');
    expect((peers.resolvePeerTarget(list, '前端') as any).entry?.sessionId).toBe('sess-aaaaaaaa');
    const amb = peers.resolvePeerTarget(list, 'sess-');
    expect('error' in amb).toBe(true);
    expect('error' in peers.resolvePeerTarget(list, '不存在')).toBe(true);
  });

  it('同进程的会话互发不绕 socket, 照样拿到回执', async () => {
    const entry = peers.listPeerSessions().find(e => e.sessionId === 'sess-aaaaaaaa')!;
    const res = await peers.deliverToPeer(entry, {
      op: 'deliver', to: 'sess-aaaaaaaa', from: sender, text: '接口改好了, 你那边可以联调了',
    });
    expect(res).toEqual({ ok: true, state: 'started' });
    expect(received.at(-1)).toMatchObject({ to: 'sess-aaaaaaaa', text: '接口改好了, 你那边可以联调了' });
  });

  it('socket 层: 连上真 socket 发一行 JSON', async () => {
    const { connect } = await import('node:net');
    const reply = await new Promise<string>((resolve, reject) => {
      const s = connect(host.endpoint);
      let buf = '';
      s.setEncoding('utf8');
      s.on('connect', () => s.write(JSON.stringify({ op: 'deliver', to: 'sess-bbbbbbbb', from: sender, text: 'hi' }) + '\n'));
      s.on('data', (c: string) => { buf += c; });
      s.on('end', () => resolve(buf));
      s.on('error', reject);
    });
    expect(JSON.parse(reply)).toEqual({ ok: true, state: 'started' });
    expect(received.at(-1).to).toBe('sess-bbbbbbbb');
  });

  it('坏请求不崩, 回 bad request', async () => {
    const { connect } = await import('node:net');
    const reply = await new Promise<string>((resolve) => {
      const s = connect(host.endpoint);
      let buf = '';
      s.setEncoding('utf8');
      s.on('connect', () => s.write('not json\n'));
      s.on('data', (c: string) => { buf += c; });
      s.on('end', () => resolve(buf));
    });
    expect(JSON.parse(reply).error).toBe('bad request');
  });

  it('对方进程已经没了: 说清楚没送到', async () => {
    const res = await peers.deliverToPeer({
      sessionId: 'x', name: 'x', cwd: '/', busy: false, lastActiveAt: 0, pid: 1, client: 'cli',
      endpoint: join(peers.peersDir(), 'nobody.sock'),
    }, { op: 'deliver', to: 'x', from: sender, text: 'hi' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/closed/);
  });

  it('XML: 正文转义, 带信任规则, 子标签无属性', () => {
    const xml = peers.buildSessionMessageXml(sender, 'a <b> & c');
    expect(xml.startsWith('<session-message>')).toBe(true);
    expect(xml).toContain('<body>a &lt;b&gt; &amp; c</body>');
    expect(xml).toContain('<from>API 重构</from>');
    expect(xml).toContain('not from your user');
  });

  it('stop 清掉自己的清单和 socket', () => {
    const mine = () => readdirSync(peers.peersDir()).filter(f => f.startsWith(`${process.pid}-`));
    expect(mine().sort()).toEqual([`${process.pid}-0.json`, `${process.pid}-0.sock`]);
    const h2 = new peers.SessionPeerHost('cli', () => ({ ok: true }));
    h2.stop();
    host.stop();
    expect(mine()).toEqual([]);
  });
});
