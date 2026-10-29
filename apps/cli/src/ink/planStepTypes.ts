/** CLI 计划步骤的共享类型 —— 阶段 (work:Q-09) 与预计耗时 (work:Q-07)。
 *
 * 单独一个文件, 是因为 InkRuntime / InkUIAdapter 都已过两千行,
 * 文件大小闸不允许再往里堆类型定义。
 */
export interface CliPlanStep {
  step: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  phase?: '读材料' | '核对' | '产出' | '自检';
  estimateSec?: number;
}
