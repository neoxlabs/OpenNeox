
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface RunMarker {
  pid: number;
  /** 启动时刻 (毫秒), 用于去找这段时间窗内的 .ips */
  startedAt: number;
  app: string;
  version: string;
  /** 进程角色 (main / worker / process) */
  process: string;
}

const MARKER_NAME = /^run-(\d+)-[0-9a-f]+\.json$/;

/** 写本进程的运行标记, 返回文件路径 (拿不到就 null —— 补报能力降级, 不影响启动)。 */
export function writeRunMarker(dir: string, marker: RunMarker): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `run-${marker.pid}-${randomUUID().slice(0, 8)}.json`);
    fs.writeFileSync(file, JSON.stringify(marker), 'utf-8');
    return file;
  } catch {
    return null;
  }
}

/** 正常退出时调用。 */
export function clearRunMarker(file: string | null | undefined): void {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {
    /* 已经不在了 */
  }
}

/** pid 还在不在。EPERM = 存在但没权限发信号, 也算活着。 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** 读出目录里所有标记 (坏文件顺手删掉)。 */
export function readRunMarkers(dir: string): Array<{ file: string; marker: RunMarker }> {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => MARKER_NAME.test(n));
  } catch {
    return [];
  }
  const out: Array<{ file: string; marker: RunMarker }> = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const marker = JSON.parse(fs.readFileSync(file, 'utf-8')) as RunMarker;
      if (marker && typeof marker.pid === 'number') out.push({ file, marker });
      else clearRunMarker(file);
    } catch {
      clearRunMarker(file);
    }
  }
  return out;
}

export function detectAbnormalExits(
  dir: string,
  opts: { currentPid?: number } = {},
): Array<{ file: string; marker: RunMarker }> {
  const currentPid = opts.currentPid ?? process.pid;
  return readRunMarkers(dir).filter(({ marker }) => marker.pid !== currentPid && !isPidAlive(marker.pid));
}
