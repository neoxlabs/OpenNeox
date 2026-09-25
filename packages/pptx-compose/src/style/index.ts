/**
 * style — PPT 风格系统 (StyleSpec + 形态语言)
 *
 * 用法 (阶段一跑一次, 阶段二只读):
 *     const spec = pickStyleForBrief('给客户的产品发布汇报');   // 不问也能跑
 *     const mark = titleMark(spec);                            // 拿这个风格的签名图形
 */
export * from './styleSpec.js';
export * from './motif.js';
