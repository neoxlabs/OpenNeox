
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
  if (process.env.NEOX_KEEP_ORPHANS === '1') {
    cliLogger.info('SVC_REAPER', 'boot reaper skipped (NEOX_KEEP_ORPHANS=1)');
    return;
  }

  const { listRunningInstances, markInstanceExited, gcInstances } =
    await import('@neoxlabs/platform/platform/serviceInstanceStore.js');
  const { listBackgroundProcessEntries } =
    await import('@neoxlabs/platform/platform/backgroundProcessRegistry.js');
  const { classifyRecordedProcess } =
    await import('@neoxlabs/platform/platform/orphanReaper.js');

  /* 一次读完登记目录 → Map, 别在循环里对每条记录重新 readdir + parse 一遍 */
  const entryByKey = new Map<string, { ownerPid: number; ownerStartTime: number }>();
  for (const e of listBackgroundProcessEntries()) {
    entryByKey.set(`${e.pid}-${e.startTime}`, { ownerPid: e.ownerPid, ownerStartTime: e.ownerStartTime });
  }

  const records = listRunningInstances();
  let reaped = 0;
  let alreadyDead = 0;
  let pidReused = 0;
  let skippedAdopted = 0;
  let skippedAliveOwner = 0;
  let skippedUnverifiable = 0;

  for (const rec of records) {
    if ((rec as any).origin === 'adopted') {
      markInstanceExited(rec.pid, rec.startTime, 'killed');
      skippedAdopted++;
      continue;
    }

    /* sqlite 里没有 owner 信息; run/ 登记里有. 查不到 (老版本写入的记录) 时按孤儿处理,
     * 跟这个函数原来的语义一致。 */
    const entry = entryByKey.get(`${rec.pid}-${rec.startTime}`);
    const verdict = await classifyRecordedProcess({
      pid: rec.pid,
      startTime: rec.startTime,
      command: rec.command,
      ownerPid: entry?.ownerPid,
      ownerStartTime: entry?.ownerStartTime,
    });

    if (verdict === 'owner-alive') {
      /* 另一个 Neox 实例正在用它 —— 不碰, 记录也保留为 running. */
      skippedAliveOwner++;
      continue;
    }
    if (verdict === 'dead' || verdict === 'pid-reused' || verdict === 'command-mismatch') {
      markInstanceExited(rec.pid, rec.startTime, 'killed');
      if (verdict === 'dead') alreadyDead++;
      else pidReused++;
      continue;
    }
    if (verdict === 'unverifiable') {
      /* 拿不到启动时间 / 命令行: 宁可漏杀. */
      skippedUnverifiable++;
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
      `adopted-skipped=${skippedAdopted} owner-alive-skipped=${skippedAliveOwner} ` +
      `unverifiable-skipped=${skippedUnverifiable} gc=${purged} (scanned=${records.length})`);
  }
}
