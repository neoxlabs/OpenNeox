/**
 * 启动性能 Profiler — 采样式低开销。
 *
 *  - 0.5% 采样率，未采样时不记录阶段数据
 *  - perf.mark() 标记启动阶段
 *  - 阶段耗时自动计算
 *  - 可通过 NEOX_PROFILE_STARTUP=1 强制启用
 */

const SAMPLE_RATE = 0.005; // 0.5%
const FORCE_PROFILING = process.env.NEOX_PROFILE_STARTUP === '1';
const SHOULD_PROFILE = FORCE_PROFILING || Math.random() < SAMPLE_RATE;

const marks: Array<{ name: string; time: number }> = [];
const startTime = Date.now();

/**
 * 标记启动检查点 — 非采样用户零开销（直接 return）
 */
export function profileCheckpoint(name: string): void {
  if (!SHOULD_PROFILE) return;
  const elapsed = Date.now() - startTime;
  marks.push({ name, time: elapsed });

  if (FORCE_PROFILING) {
    // 强制模式下直接输出到 stderr（不干扰 stdout）
    process.stderr.write(`[PROFILE] +${elapsed}ms ${name}\n`);
  }
}

/**
 * 获取所有检查点（用于上报）
 */
export function getProfileMarks(): Array<{ name: string; time: number }> {
  return marks;
}

/**
 * 计算两个检查点之间的耗时
 */
export function getPhaseTime(startMark: string, endMark: string): number | null {
  const start = marks.find(m => m.name === startMark);
  const end = marks.find(m => m.name === endMark);
  if (!start || !end) return null;
  return end.time - start.time;
}

/**
 * 输出启动 profile 摘要
 */
export function printProfileSummary(): void {
  if (!SHOULD_PROFILE || marks.length === 0) return;

  const lines = ['\n=== Neox Startup Profile ==='];
  let prev = 0;
  for (const mark of marks) {
    const delta = mark.time - prev;
    lines.push(`  +${String(mark.time).padStart(5)}ms (Δ${String(delta).padStart(4)}ms) ${mark.name}`);
    prev = mark.time;
  }
  lines.push(`  Total: ${marks[marks.length - 1].time}ms`);
  lines.push('===========================\n');

  process.stderr.write(lines.join('\n'));
}

/** 是否正在 profiling */
export const isProfiling = SHOULD_PROFILE;
