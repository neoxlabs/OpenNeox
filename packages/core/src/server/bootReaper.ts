
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getDescendantPidsAsync } from '@neoxlabs/platform/platform/processTree.js';

export function scheduleServiceInstanceReconcile(): void {
  setTimeout(() => {
    void runBootReaper().catch((err) => {
      cliLogger.warn('SERVER', `boot reaper failed: ${err?.message ?? err}`);
    });
  }, 200);
}

async function runBootReaper(): Promise<void> {
  const { listRunningInstances, markInstanceExited, gcInstances } =
    await import('@neoxlabs/platform/platform/serviceInstanceStore.js');
  const { getProcessStartTimeMs } = await import('@neoxlabs/platform/platform/processTree.js');

  const records = listRunningInstances();
  let reaped = 0;
  let alreadyDead = 0;
  let pidReused = 0;
  let skippedAdopted = 0;

  for (const rec of records) {
    if ((rec as any).origin === 'adopted') {
      markInstanceExited(rec.pid, rec.startTime, 'killed');
      skippedAdopted++;
      continue;
    }

    let alive = false;
    try {
      process.kill(rec.pid, 0);
      alive = true;
    } catch (err: any) {
      alive = err?.code !== 'ESRCH'; /* EPERM 也算活 (跨 user 看不到也别当死的) */
    }
    if (!alive) {
      markInstanceExited(rec.pid, rec.startTime, 'killed');
      alreadyDead++;
      continue;
    }

    /* pid 复用校验 —— 见函数头说明. 拿不到启动时间 (ps 不可用) 时保守放过, 宁可漏杀不误杀. */
    const actualStart = getProcessStartTimeMs(rec.pid);
    if (actualStart !== undefined && Math.abs(actualStart - rec.startTime) > 2_000) {
      markInstanceExited(rec.pid, rec.startTime, 'killed');
      pidReused++;
      continue;
    }

    try {
      const descendants = await getDescendantPidsAsync(rec.pid);
      for (const p of [rec.pid, ...descendants].reverse()) {
        try { process.kill(p, 'SIGKILL'); } catch { /* 已死 */ }
      }
      reaped++;
    } catch { /* 枚举失败: 至少杀 root */
      try { process.kill(rec.pid, 'SIGKILL'); reaped++; } catch { /* ignore */ }
    }
    markInstanceExited(rec.pid, rec.startTime, 'killed');
  }

  const purged = gcInstances();
  if (reaped > 0 || records.length > 0) {
    cliLogger.info('SVC_REAPER',
      `boot reaper: reaped=${reaped} already-dead=${alreadyDead} pid-reused=${pidReused} ` +
      `adopted-skipped=${skippedAdopted} gc=${purged} (scanned=${records.length})`);
  }
}
