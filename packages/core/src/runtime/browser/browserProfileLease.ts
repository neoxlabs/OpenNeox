import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

export interface BrowserProfileLease {
  profileDir: string;
  release(): void;
}

function isProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Unknown owners (including another hostname or a reused PID) are never evicted. */
function hasChromeOwner(profileDir: string): boolean {
  try {
    const target = fs.readlinkSync(path.join(profileDir, 'SingletonLock'));
    const separator = target.lastIndexOf('-');
    const host = target.slice(0, separator);
    const pid = Number(target.slice(separator + 1));
    return host !== os.hostname() || !Number.isSafeInteger(pid) || pid <= 1 || !isProcessGone(pid);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function tryClaim(profileDir: string): BrowserProfileLease | null {
  const ownersDir = path.join(profileDir, '.neox-owners');
  fs.mkdirSync(ownersDir, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const record = JSON.stringify({ host: os.hostname(), pid: process.pid, token });

  // Dead owners remain as immutable generations. Unlinking another owner's
  // stale lock would let concurrent reclaimers accidentally remove a NEW lock.
  for (let generation = 0; generation < 4096; generation++) {
    const ownerPath = path.join(ownersDir, `${generation}.json`);
    let fd: number;
    try {
      fd = fs.openSync(ownerPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
        if (owner.host === os.hostname() && Number.isSafeInteger(owner.pid)
            && owner.pid > 1 && isProcessGone(owner.pid)) continue;
      } catch (readError) {
        // A normal release raced our read: retry the same generation.
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') {
          generation--;
          continue;
        }
      }
      // Empty/partial records can belong to a process still writing its claim.
      return null;
    }
    try {
      fs.writeFileSync(fd, record, 'utf8');
    } catch (error) {
      fs.closeSync(fd);
      fs.unlinkSync(ownerPath);
      throw error;
    }
    fs.closeSync(fd);
    let released = false;
    const lease: BrowserProfileLease = {
      profileDir,
      release() {
        if (released) return;
        released = true;
        try {
          if (fs.readFileSync(ownerPath, 'utf8') === record) fs.unlinkSync(ownerPath);
        } catch { /* A retained claim is safe; never remove an unknown owner. */ }
      },
    };
    if (hasChromeOwner(profileDir)) {
      lease.release();
      return null;
    }
    return lease;
  }
  return null;
}

/**
 * Persistent slots retain their logins. A manager remembers its selected slot
 * across turns; other processes/threads cannot reserve it concurrently.
 * Chrome's own lock is still authoritative for non-Neox/older launchers.
 */
export function acquireBrowserProfile(
  baseDir: string,
  preferredDir?: string,
  excluded: ReadonlySet<string> = new Set(),
): BrowserProfileLease {
  const base = path.resolve(baseDir);
  const candidates = new Set<string>();
  if (preferredDir) candidates.add(path.resolve(preferredDir));
  candidates.add(base);
  for (let slot = 1; slot <= 32; slot++) candidates.add(`${base}-instance-${slot}`);
  // Even an unusually large number of concurrent instances must be able to start.
  candidates.add(`${base}-instance-${randomUUID()}`);
  for (const candidate of candidates) {
    if (excluded.has(candidate)) continue;
    const lease = tryClaim(candidate);
    if (lease) return lease;
  }
  throw new Error('Unable to reserve an available browser profile');
}

export function isBrowserProfileConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ProcessSingleton|SingletonLock|Opening in existing browser session|exitCode=21\b|user data directory is already in use|profile (?:is (?:already )?|appears to be )in use/i.test(message);
}
