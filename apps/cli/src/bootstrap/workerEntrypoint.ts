export async function runExecuteShellWorkerIfNeeded(): Promise<number | null> {
  /* 服务重构: 删除 execute_shell worker 分支 (连同 core 的
     executeShellWorker.ts / shellExecWorkerEntry.ts) — daemon 时代遗物, 全仓无人再
     spawn NEOX_WORKER=execute_shell; 它发的 shell_output_stream 不带 pid, 真被走到
     只会造成"日志永远空"。in-process shell (inProcessShell.ts) 是唯一执行路径。

      SH2 已删 command_exec / command_helper 两个 worker 自分发分支。 */
  return null;
}
