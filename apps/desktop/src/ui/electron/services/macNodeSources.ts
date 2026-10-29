import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const FS = '\u001F';
const RS = '\u001E';

function osa(script: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script, '--', ...args], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const msg = String(stderr || err.message || '');
      if (msg.includes('-1743')) reject(new Error('没有授权: 系统设置 › 隐私与安全性 › 自动化 里允许 Neox 访问'));
      else if (msg.includes('-1712') || (err as { killed?: boolean }).killed) reject(new Error('读取超时 (可能在等系统授权框)'));
      else reject(new Error(msg.trim().slice(0, 200) || 'osascript 失败'));
    });
  });
}

function rows(raw: string): string[][] {
  return raw.split(RS).map((r) => r.replace(/^\n+|\n+$/g, '')).filter((r) => r.length > 0).map((r) => r.split(FS));
}

/* ───────── 日历 ───────── */

export interface MacCalendarEvent { uid: string; title: string; start: number; end: number; calendar: string; location: string; allDay: boolean }

const CALENDAR_SCRIPT = `
on run argv
  set nowRef to current date
  set d1 to nowRef + ((item 1 of argv) as integer)
  set d2 to nowRef + ((item 2 of argv) as integer)
  set FS to (ASCII character 31)
  set RS to (ASCII character 30)
  set out to ""
  tell application "Calendar"
    repeat with c in calendars
      set calName to name of c
      try
        set evRef to a reference to (every event of c whose start date is greater than or equal to d1 and start date is less than or equal to d2)
        set uids to uid of evRef
        if (count of uids) > 0 then
          set sums to summary of evRef
          set sds to start date of evRef
          set eds to end date of evRef
          set locs to location of evRef
          set ads to allday event of evRef
          repeat with i from 1 to count of uids
            set s to item i of sums
            if s is missing value then set s to ""
            set l to item i of locs
            if l is missing value then set l to ""
            set out to out & (item i of uids) & FS & s & FS & (((item i of sds) - nowRef) as integer) & FS & (((item i of eds) - nowRef) as integer) & FS & calName & FS & l & FS & (item i of ads) & RS
          end repeat
        end if
      end try
    end repeat
  end tell
  return out
end run
`;

/** 往前 backDays 天、往后 aheadDays 天的日程 (重复日程只认原始那一次 —— Calendar 的脚本接口不展开重复) */
export async function readMacCalendar(backDays: number, aheadDays: number): Promise<MacCalendarEvent[]> {
  const base = Date.now();
  const raw = await osa(CALENDAR_SCRIPT, [String(-backDays * 86400), String(aheadDays * 86400)], 180_000);
  return rows(raw).filter((f) => f.length >= 7 && f[0]).map((f) => ({
    uid: f[0], title: f[1] || '(无标题)', start: base + Number(f[2]) * 1000, end: base + Number(f[3]) * 1000,
    calendar: f[4], location: f[5], allDay: f[6] === 'true',
  }));
}

/* ───────── 提醒事项 ───────── */

export interface MacReminder { id: string; title: string; due: number | null; list: string; notes: string }

const REMINDERS_SCRIPT = `
on run argv
  set nowRef to current date
  set FS to (ASCII character 31)
  set RS to (ASCII character 30)
  set out to ""
  tell application "Reminders"
    repeat with l in lists
      set listName to name of l
      try
        set rRef to a reference to (reminders of l whose completed is false)
        set ids to id of rRef
        if (count of ids) > 0 then
          set nms to name of rRef
          set dds to due date of rRef
          set bds to body of rRef
          repeat with i from 1 to count of ids
            set d to item i of dds
            set dt to ""
            if d is not missing value then set dt to ((d - nowRef) as integer) as string
            set b to item i of bds
            if b is missing value then set b to ""
            set out to out & (item i of ids) & FS & (item i of nms) & FS & dt & FS & listName & FS & b & RS
          end repeat
        end if
      end try
    end repeat
  end tell
  return out
end run
`;

/** 没做完的提醒 (做完的从这里消失, 同步器据此标成已完成) */
export async function readMacReminders(): Promise<MacReminder[]> {
  const base = Date.now();
  const raw = await osa(REMINDERS_SCRIPT, [], 120_000);
  return rows(raw).filter((f) => f.length >= 5 && f[0]).map((f) => ({
    id: f[0], title: f[1], due: f[2] ? base + Number(f[2]) * 1000 : null, list: f[3], notes: f[4].slice(0, 2000),
  }));
}

/* ───────── 通讯录 ───────── */

export interface MacContact { id: string; name: string; phones: string[]; emails: string[]; birthday: string | null; org: string }

const CONTACTS_SCRIPT = `
on run argv
  set FS to (ASCII character 31)
  set RS to (ASCII character 30)
  set GS to (ASCII character 29)
  set out to ""
  tell application "Contacts"
    set ids to id of people
    set nms to name of people
    set phs to value of phones of people
    set ems to value of emails of people
    set bds to birth date of people
    set ogs to organization of people
  end tell
  repeat with i from 1 to count of ids
    set n to item i of nms
    if n is missing value then set n to ""
    set o to item i of ogs
    if o is missing value then set o to ""
    set pt to ""
    repeat with p in (item i of phs)
      set pt to pt & p & GS
    end repeat
    set et to ""
    repeat with e in (item i of ems)
      set et to et & e & GS
    end repeat
    set bd to item i of bds
    set bt to ""
    if bd is not missing value then set bt to ((month of bd) as integer) & "-" & (day of bd)
    set out to out & (item i of ids) & FS & n & FS & pt & FS & et & FS & bt & FS & o & RS
  end repeat
  return out
end run
`;

export async function readMacContacts(): Promise<MacContact[]> {
  const raw = await osa(CONTACTS_SCRIPT, [], 300_000);
  const list = (s: string) => s.split('\u001D').map((x) => x.trim()).filter(Boolean);
  return rows(raw).filter((f) => f.length >= 6 && f[0]).map((f) => {
    const [m, d] = f[4] ? f[4].split('-').map(Number) : [];
    return {
      id: f[0], name: f[1] || f[5], phones: list(f[2]), emails: list(f[3]),
      birthday: m && d ? `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null, org: f[5],
    };
  }).filter((c) => c.name);
}

/** 电话号码比较用: 去掉空格横线和国家码 +86 */
export function normPhone(s: string): string {
  const d = s.replace(/[^\d+]/g, '');
  return d.replace(/^\+?86(?=1\d{10}$)/, '').replace(/^\+/, '');
}

/* ───────── 信息 (iMessage / 短信) ───────── */

export interface MacMessage { rowid: number; guid: string; at: number; fromMe: boolean; handle: string; service: string; text: string; chat: string }

export const CHAT_DB = join(homedir(), 'Library', 'Messages', 'chat.db');

function appleTime(v: number | bigint | null): number {
  const n = Number(v ?? 0);
  const secs = n > 1e12 ? n / 1e9 : n;
  return Math.round((secs + 978307200) * 1000);
}

/** 新系统把正文只存在 attributedBody (NSAttributedString 的 typedstream) 里: 取第一段 NSString */
export function decodeAttributedBody(buf: Buffer | null | undefined): string {
  if (!buf || !buf.length) return '';
  const at = buf.indexOf('NSString');
  if (at < 0) return '';
  let i = buf.indexOf(0x2b, at); /* '+' 之后是长度 */
  if (i < 0 || i - at > 16) return '';
  i += 1;
  let len = buf[i];
  i += 1;
  if (len === 0x81) { len = buf.readUInt16LE(i); i += 2; }
  else if (len === 0x82) { len = buf.readUInt32LE(i); i += 4; }
  return buf.subarray(i, i + len).toString('utf8');
}

export class MessagesAccessError extends Error {}

type Db = { prepare(sql: string): { all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown }; close(): void };

async function openChatDb(): Promise<Db> {
  if (!existsSync(CHAT_DB)) throw new MessagesAccessError('这台电脑没开「信息」');
  const mod = await import('better-sqlite3');
  const Database = (mod as unknown as { default: new (p: string, o: object) => Db }).default;
  try {
    return new Database(CHAT_DB, { readonly: true, fileMustExist: true });
  } catch (err: any) {
    if (/EPERM|EACCES|authoriz|not permitted|SQLITE_CANTOPEN/i.test(String(err?.message ?? err) + String(err?.code ?? ''))) {
      throw new MessagesAccessError('需要「完全磁盘访问」: 系统设置 › 隐私与安全性 › 完全磁盘访问 里打开 Neox');
    }
    throw err;
  }
}

/** rowid 之后的新消息 (最多 limit 条, 旧 → 新)。sinceMs: 首次同步只要最近这段 */
export async function readMacMessages(afterRowid: number, sinceMs: number, limit = 2000): Promise<MacMessage[]> {
  const db = await openChatDb();
  try {
    const since2001ns = BigInt(Math.max(0, Math.floor(sinceMs / 1000) - 978307200)) * 1_000_000_000n;
    let list: any[];
    try {
      list = db.prepare(`
        SELECT m.ROWID AS rowid, m.guid, m.date, m.is_from_me, m.text, m.attributedBody, m.service,
               h.id AS handle, c.display_name AS chat_name, c.chat_identifier AS chat_id
        FROM message m
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        LEFT JOIN chat c ON c.ROWID = cmj.chat_id
        WHERE m.ROWID > ? AND m.date >= ? AND m.item_type = 0
        ORDER BY m.ROWID ASC LIMIT ?`).all(afterRowid, since2001ns, limit);
    } catch (err: any) {
      if (/authoriz|not permitted|unable to open/i.test(String(err?.message ?? err))) {
        throw new MessagesAccessError('需要「完全磁盘访问」: 系统设置 › 隐私与安全性 › 完全磁盘访问 里打开 Neox');
      }
      throw err;
    }
    return list.map((r) => ({
      rowid: Number(r.rowid),
      guid: String(r.guid),
      at: appleTime(r.date),
      fromMe: r.is_from_me === 1,
      handle: String(r.handle ?? r.chat_id ?? ''),
      service: String(r.service ?? ''),
      text: (r.text ?? decodeAttributedBody(r.attributedBody) ?? '').replace(/￼/g, '').trim(),
      chat: String(r.chat_name || ''),
    })).filter((m) => m.text);
  } finally {
    db.close();
  }
}

/** 现在最大的 rowid —— 只同步「从今往后」时用 */
export async function latestMacMessageRowid(): Promise<number> {
  const db = await openChatDb();
  try { return Number((db.prepare('SELECT MAX(ROWID) AS n FROM message').get() as { n: number | null })?.n ?? 0); }
  finally { db.close(); }
}

/* ───────── 银行短信 → 一笔账 ───────── */

export interface BankTxn { kind: 'expense' | 'income'; amount: number; currency: string; bank: string; merchant: string; card: string; balance: number | null }

/* 信用卡「还款」整条不算 (见 parseBankSms): 消费那一笔已经记过, 还款再记就重了 */
const EXPENSE_WORDS = /(消费|支出|支付|扣款|扣费|转出|取现|付款)/;
const INCOME_WORDS = /(收入|入账|存入|转入|退款|到账|工资|代发)/;

/**
 * 「【招商银行】您账户1234于10月14日12:30在美团消费人民币36.50元，余额2,001.30」这类。
 * 只认明确有「银行 / 信用卡」署名 + 金额 + 收支动词的; 验证码、营销、账单提醒 (本期应还) 一律不算。
 */
export function parseBankSms(text: string): BankTxn | null {
  const sig = /【([^】]{2,16}?(?:银行|信用卡|银联|农信|信用社))】|\[([^\]]{2,16}?银行)\]/.exec(text);
  if (!sig) return null;
  if (/验证码|校验码|动态码|应还|账单日|还款|优惠|活动|退订|回复TD/i.test(text)) return null;
  const bank = (sig[1] ?? sig[2]).replace(/信用卡$/, '');
  /* 金额要带币种字样或「元」—— 光秃的数字可能是卡号尾号 / 日期; 余额那段先挖掉 */
  const money = /(?:人民币|RMB|CNY|￥|¥|美元|USD)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*元/.exec(text.replace(/(?:可用)?余额[^，,。;；]*/g, ''));
  const raw = money?.[1] ?? money?.[2];
  if (!raw) return null;
  const amount = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return null;
  const isIn = INCOME_WORDS.test(text) && !/退款失败/.test(text);
  const isOut = EXPENSE_WORDS.test(text);
  if (!isIn && !isOut) return null;
  const kind = isIn && !/(消费|支付|扣款|扣费|转出|取现|付款)/.test(text) ? 'income' : 'expense';
  const merchant = (/在(.{1,24}?)(?:消费|支付|扣款|付款)/.exec(text)?.[1]
    ?? /[向给](.{1,20}?)(?:转账|付款|转出)/.exec(text)?.[1]
    ?? /\(([^)]{1,24})\)/.exec(text)?.[1]
    ?? '').replace(/[，,。\s]/g, '');
  const card = /(?:尾号|账户|卡)\s*\*?(\d{4})/.exec(text)?.[1] ?? '';
  const bal = /余额[:：]?\s*(?:人民币|RMB|￥|¥)?\s*([\d,]+(?:\.\d{1,2})?)/.exec(text)?.[1];
  return {
    kind, amount, currency: /美元|USD|\$/.test(text) ? 'USD' : 'CNY', bank, merchant, card,
    balance: bal ? Number(bal.replace(/,/g, '')) : null,
  };
}
