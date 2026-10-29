import * as fs from 'node:fs';
import * as path from 'node:path';

import { neoxDataDir } from '../services/localSecretCipher.js';
import { bridgeLog } from './log.js';

/** 心跳间隔 —— 持有者刷新自己的存活与状态。 */
const HEARTBEAT_MS = 15_000;
/** 超过这个时间没心跳视为死 —— 给足 3 个心跳周期, 免得系统卡顿误判。 */
const STALE_MS = 45_000;

interface OwnerRecord {
  /** 持有者进程 pid。 */
  pid: number;
  /** 持有者启动时刻 (本进程内的时间戳, 只用于排障)。 */
  startedAt: number;
  /** 最近一次心跳时刻 (Date.now())。 */
  heartbeatAt: number;
  /** 持有者那条中继连接是否真的连着 —— 待命实例上报 presence 时要用。 */
  relayConnected: boolean;
}

export const RELAY_OWNER_FILE = 'cloud-relay-owner.json';

export function relayOwnerFilePath(): string {
  return path.join(neoxDataDir(), RELAY_OWNER_FILE);
}

function readRecord(): OwnerRecord | null {
  const file = relayOwnerFilePath();
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as OwnerRecord;
    if (typeof parsed?.pid !== 'number' || typeof parsed?.heartbeatAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    /* EPERM = 进程在, 但不是我能发信号的用户 (极罕见) —— 按活着算, 别去抢。 */
    return e?.code === 'EPERM';
  }
}

/** 记录是否"活着且不是我自己"。文件读不出来时按 mtime 兜底, 宁可保守。 */
function isRecordLive(rec: OwnerRecord | null): boolean {
  if (!rec) return false;
  if (Date.now() - rec.heartbeatAt > STALE_MS) return false;
  return pidAlive(rec.pid);
}

/** 文件存在但解析不出来 (写坏 / 正在被替换) —— 用 mtime 判断新不新, 新就当成有人在用。 */
function isUnparsableButFresh(): boolean {
  try {
    const st = fs.statSync(relayOwnerFilePath());
    return Date.now() - st.mtimeMs <= STALE_MS;
  } catch {
    return false;
  }
}

/**
 * 机器上有没有别的实例正持有中继 (且它的连接是通的)。
 * 给 presence capabilities 用: 待命实例自己没连, 但手机看到的"这台电脑远程能不能连"
 * 应该是**这台机器**的状态 —— 通道在别的实例手里, 手机照样连得上。
 */
export function relayOwnedElsewhereAndConnected(): boolean {
  const rec = readRecord();
  if (!rec || rec.pid === process.pid) return false;
  return isRecordLive(rec) && rec.relayConnected === true;
}

/** 机器上有没有别的实例正持有中继 (不关心它连没连上)。 */
export function isRelayOwnedElsewhere(): boolean {
  const rec = readRecord();
  if (!rec || rec.pid === process.pid) return false;
  return isRecordLive(rec);
}

/**
 * 抢所有权。返回 true = 现在归我 (调用方可以拨中继了)。
 *
 * 已经是我自己持有的 (重复调用) 直接返 true —— 上层 ensure/start 都是幂等的, 这里跟着幂等。
 */
export function tryAcquireRelayOwnership(): boolean {
  const file = relayOwnerFilePath();
  const existing = readRecord();
  if (existing?.pid === process.pid && isRecordLive(existing)) return true;
  if (isRecordLive(existing)) return false;
  /* 记录不可解析但很新 —— 可能是别的实例刚写下/正在写。保守不抢。 */
  if (!existing && isUnparsableButFresh()) return false;

  const payload: OwnerRecord = {
    pid: process.pid,
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
    relayConnected: false,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch { /* 目录已存在 / 权限问题在下面 writeFile 会暴露 */ }

  /* 两轮: 第一轮 wx 独占建; EEXIST 且判定为死记录 → 删掉再来一次。
   * 两个待命实例同时抢时, 只有一个的 wx 会成功, 另一个 EEXIST 后看到活记录 → 让位。 */
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(payload));
      } finally {
        fs.closeSync(fd);
      }
      bridgeLog('cloud-relay:owner', `acquired (pid=${process.pid})`);
      return true;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') {
        /* 写不进去 (权限 / 磁盘 / 路径异常) —— **降级为没有这把锁的旧行为**, 不能因为
         * 一把协调用的锁把远程连接整个打死: 那种情况下最坏也只是回到"两个实例互顶",
         * 而拒绝拨号是 100% 连不上。设备身份目录写不了本身会有其它报错提示。 */
        bridgeLog('cloud-relay:owner', `acquire failed (${e?.code ?? e?.message}), proceeding without lock`);
        return true;
      }
      const cur = readRecord();
      if (isRecordLive(cur) || (!cur && isUnparsableButFresh())) return false;
      try { fs.unlinkSync(file); } catch { /* 别人先删了也一样 */ }
    }
  }
  return false;
}

/** 心跳 —— 持有者定期刷。relayConnected 让待命实例能如实上报机器状态。 */
export function refreshRelayOwnership(relayConnected: boolean): void {
  const file = relayOwnerFilePath();
  const rec = readRecord();
  /* 锁被别的实例抢走了 (理论上不该发生) —— 别去把它写回来。 */
  if (rec && rec.pid !== process.pid && isRecordLive(rec)) return;
  const payload: OwnerRecord = {
    pid: process.pid,
    startedAt: rec?.pid === process.pid ? rec.startedAt : Date.now(),
    heartbeatAt: Date.now(),
    relayConnected,
  };
  try {
    fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  } catch { /* 心跳失败不该影响中继本身, 下个周期再来 */ }
}

/** 主动让出 —— 停掉中继 (登出 / 用户显式停用 / 没有配对手机) 时调。 */
export function releaseRelayOwnership(): void {
  const rec = readRecord();
  if (rec && rec.pid !== process.pid) return;
  try {
    fs.unlinkSync(relayOwnerFilePath());
    bridgeLog('cloud-relay:owner', 'released');
  } catch { /* 本来就没有 */ }
}

export const RELAY_OWNER_HEARTBEAT_MS = HEARTBEAT_MS;
