
import * as fs from 'node:fs';
import * as path from 'node:path';

export type OfficeApp = 'Excel' | 'Word' | 'PowerPoint' | 'WPS' | 'LibreOffice';

const APP_BY_EXT: Record<string, OfficeApp> = {
  '.xlsx': 'Excel', '.xls': 'Excel', '.xlsm': 'Excel', '.xlsb': 'Excel', '.csv': 'Excel',
  '.docx': 'Word', '.doc': 'Word', '.rtf': 'Word',
  '.pptx': 'PowerPoint', '.ppt': 'PowerPoint',
};

/** 会被当成"占用"的 errno —— 其余错误原样上抛, 不改写原有报错 */
const LOCK_ERRNO = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'ETXTBSY']);

export interface OfficeLockInfo {
  locked: boolean;
  /** 检测到的锁定文件 (Office 的 `~$x` / LibreOffice 的 `.~lock.x#`) */
  lockFile?: string;
  /** 按扩展名推测是哪个程序开着 */
  app?: OfficeApp;
  /** 没有锁定文件, 但文件被别的进程以独占方式打开 */
  exclusive?: boolean;
}

/**
 * 检出文件是否正被 Office 类程序打开。
 * 不存在的文件 (新建 / 另存) 永远返回未锁定; 只读文件也不当作占用。
 */
export function detectOfficeLock(filePath: string): OfficeLockInfo {
  const app = APP_BY_EXT[path.extname(filePath).toLowerCase()];
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  /* Office 的锁定文件名: `~$` + 原文件名; 文件名超过 8 个字符时前两个字符被吃掉,
   * 所以 `~$` + slice(1) / slice(2) 也要查, 否则长文件名永远检不出来。 */
  const candidates = [
    path.join(dir, `~$${base}`),
    path.join(dir, `~$${base.slice(1)}`),
    path.join(dir, `~$${base.slice(2)}`),
    path.join(dir, `.~lock.${base}#`),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return {
        locked: true,
        lockFile: candidate,
        app: candidate.includes('.~lock.') ? 'LibreOffice' : app,
      };
    }
  }
  if (probeExclusiveLock(filePath)) {
    return { locked: true, app, exclusive: true };
  }
  return { locked: false };
}

function probeExclusiveLock(filePath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;   // 文件不存在 = 没人占用, 正常新建
  }
  if (!stat.isFile()) return false;
  /* 没有写权限位 = 只读文件, 不是被程序打开 —— 交给写盘时的 EACCES 原样报 (E-08) */
  if ((stat.mode & 0o222) === 0) return false;
  try {
    const fd = fs.openSync(filePath, 'r+');
    fs.closeSync(fd);
    return false;
  } catch (e: any) {
    const code = String(e?.code ?? '');
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
  }
}

/** 写盘失败时判断是不是"占用"这一类 */
export function isOfficeLockError(error: unknown): boolean {
  const code = String((error as any)?.code ?? '');
  return LOCK_ERRNO.has(code);
}

export class OfficeFileLockedError extends Error {
  readonly code = 'file_locked';
  readonly filePath: string;
  readonly app?: OfficeApp;
  readonly lockFile?: string;
  readonly attempts: number;

  constructor(
    filePath: string,
    info: OfficeLockInfo | undefined,
    attempts: number,
    options: { staleLock?: boolean } = {},
  ) {
    super(formatOfficeLockedMessage(filePath, info, { attempts, staleLock: options.staleLock }));
    this.name = 'OfficeFileLockedError';
    this.filePath = filePath;
    this.app = info?.app;
    this.lockFile = info?.lockFile;
    this.attempts = attempts;
  }
}

/** 给用户 / 模型看的中文说明 —— 一句话说清"谁占着、先做什么、再点哪里" */
export function formatOfficeLockedMessage(
  filePath: string,
  info: OfficeLockInfo | undefined,
  opts: { attempts?: number; staleLock?: boolean } = {},
): string {
  const app = info?.app ?? '其他程序';
  const lockName = info?.lockFile ? path.basename(info.lockFile) : '';
  const why = info?.lockFile
    ? `检测到 ${app} 打开着它 (锁定文件 ${lockName})`
    : `文件被${app === '其他程序' ? '其他程序' : ` ${app} `}以独占方式打开`;
  const lines = [
    `文件被占用: ${filePath}`,
    `${why}${opts.attempts && opts.attempts > 1 ? `, 已重试 ${opts.attempts - 1} 次` : ''}。`,
    `下一步: 先关掉 ${app === '其他程序' ? '占用它的程序' : app}, 然后说「重试」; `
      + `或者让我另存到新路径 (save_as / outputPath), 不要覆盖原文件。`,
  ];
  if (opts.staleLock && lockName) {
    lines.push(`如果 ${app} 其实已经关了, ${lockName} 可能是上次异常退出留下的, 删掉它再重试。`);
  }
  return lines.join('\n');
}

export interface OfficeWriteRetryOptions {
  /** 首次之外的额外重试次数, 默认 3 */
  retries?: number;
  /** 每次重试前等多久 (ms); 短于次数时重复最后一个值 */
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 带占用检测的重试写盘。`write` 里做真正的落盘 (tmp + rename 由调用方决定)。
 * 非占用类错误立刻原样抛出, 不改写既有报错。
 */
export async function withOfficeWriteRetry<T>(
  filePath: string,
  write: () => T | Promise<T>,
  opts: OfficeWriteRetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const delays = opts.delaysMs ?? [100, 300, 800];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastInfo: OfficeLockInfo | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const info = detectOfficeLock(filePath);
    if (info.locked) {
      lastInfo = info;
      if (attempt === retries) break;
      await sleep(delays[Math.min(attempt, delays.length - 1)] ?? 0);
      continue;
    }
    try {
      return await write();
    } catch (error) {
      if (!isOfficeLockError(error)) throw error;
      lastInfo = { locked: true, app: APP_BY_EXT[path.extname(filePath).toLowerCase()] };
      if (attempt === retries) break;
      await sleep(delays[Math.min(attempt, delays.length - 1)] ?? 0);
    }
  }
  throw new OfficeFileLockedError(filePath, lastInfo ?? { locked: true }, retries + 1, {
    staleLock: !!lastInfo?.lockFile,
  });
}
