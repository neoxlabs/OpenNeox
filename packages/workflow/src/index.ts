/**
 * @openneox/workflow — 编排层
 *
 * 目标 → 节点图, 以及运行中改图。只产出/修改 cluster 的 NodeSpec[], **不执行**。
 *
 * 依赖单向: 模板(数据) → workflow → cluster → core。
 * 边界由 __tests__/boundary.test.ts 强制 (不许 runSession / 不许 import core /
 * templates 不含逻辑)。
 *
 * 架子已摆, 内容待设计 —— 下面的导出随设计落地逐条补上。
 */

export const WORKFLOW_VERSION = '0.1.0';
