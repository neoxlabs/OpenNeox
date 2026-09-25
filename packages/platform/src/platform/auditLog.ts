/**
 * auditLog — 篡改链审计日志 (G1).
 *
 * 用途: 把"安全相关动作"按顺序写一个 append-only 文件, 每条记录 HMAC chain 链上一条.
 *       任一条被改 / 删 / 插会断链, 启动时 verify 能识别. IR / 合规审计必备地基.
 *
 * 设计:
 *   每条记录 JSON Line:
 *     {"i":<seq>,"ts":<unix_ms>,"t":<event_type>,"d":<details>,"p":"<prev_hmac_hex>","h":"<this_hmac_hex>"}
 *   this_hmac = HMAC-SHA256(auditKey, prev_hmac || serialize(i, ts, t, d))
 *
 *   auditKey = HKDF(dbMasterKey, "neox-audit-v1", 32)
 *     - 跟 db master key 同源, 不需要额外配置
 *     - Keychain key 拿不到 (Keychain 删了 / 没装 keytar) → audit log 自动停写,
 *       而不是用退化的 machine-id key 写 (防 P5 升级期 key 来回切, audit 链断)
 *
 * 文件位置:
 *   ~/Library/Application Support/Neox/audit.log (mac)
 *   APPDATA/Neox/audit.log (win)
 *   ~/.config/neox/audit.log (linux)
 *
 * 验证: verifyChain() 启动时调一次, 任何断链报 error log + 写一条 "chain.broken" entry.
 *       这种事件本身也 HMAC, 所以攻击者除非拿到 auditKey 否则无法伪造完整链.
 *
 *  当前不做文件轮转：
 *   直觉上"只追加不轮转"是个磁盘隐患, 但这个文件是**HMAC 链**: 每条记录都锚在上一条的
 *   hmac 上, 整条链才是防篡改的依据。随手 rename 成 .1 再开新文件 = 链从中间断掉,
 *   而 verifyChain() 恰恰会把断链当成"有人动过", 每次启动报 error + 写一条 chain.broken。
 *   也就是说"顺手加个轮转"会把一个安全机制直接搞坏, 且表现为持续误报。
 *
 *   真要轮转, 得连着做: 新文件的首条记录带上旧文件最后一条的 hmac, 且 verifyChain
 *   要能跨文件验。那是一整件事, 不是一个 if。
 *
 *   当前文件按安全事件追加写入，容量策略不应破坏链的连续性。需要轮转时，必须让新
 *   文件首条记录携带旧文件末条 HMAC，并让 verifyChain 跨文件验证；单独 rename 会
 *   把正常轮转误报为篡改。
 *
 * 限制:
 *   - 攻击者拿到 auditKey 可以重写完整链 (链是顺序计算的). G3 + 进程内存防护配合.
 *   - 文件可以被整个删除, 我们只检测"链断" not "文件缺失". 缺失就当首次启动开新链.
 *     若要防"删除", 得把 last_hmac 也存进 Keychain 或 db, 启动时 cross-check. (TODO)
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

function getAuditLogPath(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Neox', 'audit.log');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Neox', 'audit.log');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'neox', 'audit.log');
}

let _auditKey: Buffer | null = null;
let _lastHmac = '';
let _seq = 0;
let _initialized = false;

function deriveAuditKey(): Buffer | null {
  if (_auditKey) return _auditKey;
  try {
    const { deriveDbMasterKey } = _require('./dbCipher.js');
    const dbKey = deriveDbMasterKey() as Buffer | null;
    if (!dbKey) return null;
    _auditKey = Buffer.from(
      crypto.hkdfSync('sha256', dbKey, Buffer.alloc(0), 'neox-audit-v1', 32),
    );
    return _auditKey;
  } catch { return null; }
}

function computeEntryHmac(key: Buffer, prevHmac: string, seq: number, ts: number, type: string, details: unknown): string {
  const mac = crypto.createHmac('sha256', key);
  mac.update(prevHmac, 'utf8');
  mac.update('\n', 'utf8');
  mac.update(String(seq), 'utf8');
  mac.update('\n', 'utf8');
  mac.update(String(ts), 'utf8');
  mac.update('\n', 'utf8');
  mac.update(type, 'utf8');
  mac.update('\n', 'utf8');
  mac.update(JSON.stringify(details), 'utf8');
  return mac.digest('hex');
}

/** 启动早期调一次: 读现有 audit.log, 校验链 + 推进 seq/lastHmac.
 *  不会 throw — 链断只写诊断, 继续从断点接着写 (保留旧记录 + 一条 chain.broken 标记). */
export async function initAuditLog(): Promise<void> {
  if (_initialized) return;
  _initialized = true;
  const key = deriveAuditKey();
  if (!key) return; /* master key 没派出 → audit log 静默关停, 等 bootstrap 完再开 */
  const p = getAuditLogPath();
  if (!fs.existsSync(p)) {
    /* 首次, 写一条 audit.start */
    _seq = 0;
    _lastHmac = '';
    await appendEntry('audit.start', { version: 1 });
    return;
  }
  /* 读, 验链 */
  let lines: string[] = [];
  try { lines = fs.readFileSync(p, 'utf-8').split(/\n+/).filter(Boolean); } catch { lines = []; }
  let prev = '';
  let broken = false;
  let lastSeq = 0;
  for (const line of lines) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { broken = true; break; }
    const expected = computeEntryHmac(key, prev, entry.i, entry.ts, entry.t, entry.d);
    if (entry.p !== prev || entry.h !== expected) { broken = true; break; }
    prev = entry.h;
    lastSeq = entry.i;
  }
  _lastHmac = prev;
  _seq = lastSeq;
  if (broken) {
    /* 断链 — 写一条 chain.broken (用当前 lastHmac, 即最后一个合法记录), 之后接着写新事件 */
    await appendEntry('chain.broken', { at_seq: lastSeq + 1, total_lines: lines.length });
  }
}

/** 写一条审计记录. type 短串 (e.g. "db.opened", "key.rotated", "cert.pin.mismatch"). */
export async function appendEntry(type: string, details: unknown): Promise<void> {
  const key = deriveAuditKey();
  if (!key) return; /* audit key 还没派出, 静默丢 (启动早期 keychain 未 bootstrap 时常见) */
  _seq += 1;
  const ts = Date.now();
  const h = computeEntryHmac(key, _lastHmac, _seq, ts, type, details);
  const entry = { i: _seq, ts, t: type, d: details, p: _lastHmac, h };
  _lastHmac = h;
  const p = getAuditLogPath();
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(p, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch { /* best-effort, audit 失败不阻塞主流程 */ }
}

/** 测试用 — 重置内存状态. */
export function _resetAuditState(): void {
  _auditKey = null;
  _lastHmac = '';
  _seq = 0;
  _initialized = false;
}
