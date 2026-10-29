import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../log.js', () => ({ bridgeLog: () => {} }));

let dataDir = '';
vi.mock('../../services/localSecretCipher.js', () => ({
  neoxDataDir: () => dataDir,
}));

import {
  RELAY_OWNER_FILE,
  isRelayOwnedElsewhere,
  refreshRelayOwnership,
  relayOwnedElsewhereAndConnected,
  releaseRelayOwnership,
  tryAcquireRelayOwnership,
} from '../relayOwnerLock.js';

function ownerFile(): string {
  return path.join(dataDir, RELAY_OWNER_FILE);
}

function writeForeignRecord(over: Partial<{ pid: number; heartbeatAt: number; relayConnected: boolean }> = {}): void {
  fs.writeFileSync(ownerFile(), JSON.stringify({
    /* 用一个**真实存在**的 pid 当"别的实例": 1 号进程永远在, 而我们无权给它发信号
     * (EPERM), 正好把"活着但不是我的"这条分支走到。 */
    pid: 1,
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
    relayConnected: true,
    ...over,
  }));
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-relay-owner-'));
});
afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('relayOwnerLock — 机器级中继所有权', () => {
  it('没人持有时能抢到, 重复抢仍归自己 (幂等)', () => {
    expect(tryAcquireRelayOwnership()).toBe(true);
    expect(tryAcquireRelayOwnership()).toBe(true);
    expect(isRelayOwnedElsewhere()).toBe(false);
  });

  it('别的活进程持有时不抢 (否则又把对方的连接顶掉)', () => {
    writeForeignRecord();
    expect(tryAcquireRelayOwnership()).toBe(false);
    expect(isRelayOwnedElsewhere()).toBe(true);
  });

  it('持有者心跳过期 → 可以接管 (进程崩了 / 被 kill -9 的情况)', () => {
    writeForeignRecord({ heartbeatAt: Date.now() - 120_000 });
    expect(tryAcquireRelayOwnership()).toBe(true);
  });

  it('记录写坏但很新 → 保守不抢; 写坏且很旧 → 接管', () => {
    fs.writeFileSync(ownerFile(), '{ truncated…');
    expect(tryAcquireRelayOwnership()).toBe(false);

    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(ownerFile(), old, old);
    expect(tryAcquireRelayOwnership()).toBe(true);
  });

  it('心跳里带的中继状态决定"机器上远程通不通"', () => {
    writeForeignRecord({ relayConnected: true });
    expect(relayOwnedElsewhereAndConnected()).toBe(true);
    writeForeignRecord({ relayConnected: false });
    expect(relayOwnedElsewhereAndConnected()).toBe(false);
  });

  it('自己刷新心跳不会把别人的锁抢过来', () => {
    writeForeignRecord();
    refreshRelayOwnership(true);
    const rec = JSON.parse(fs.readFileSync(ownerFile(), 'utf-8'));
    expect(rec.pid).toBe(1);
  });

  it('让出之后别人能拿到', () => {
    expect(tryAcquireRelayOwnership()).toBe(true);
    releaseRelayOwnership();
    expect(fs.existsSync(ownerFile())).toBe(false);
    writeForeignRecord();
    expect(isRelayOwnedElsewhere()).toBe(true);
  });
});
