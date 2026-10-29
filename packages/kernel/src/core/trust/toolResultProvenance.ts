/**
 * 一条工具结果的来源判定 (runner 收口点调用, 抽出来是因为 runner.ts 撞了体积棘轮)。
 *
 *   · 按工具声明 (provenance / provenanceRef) 判是不是外部内容; call_tool 自己委派给被包的真工具
 *   · 失败的调用不算读过
 *   · 分类器 (Jev 等) 只能把 suspect 从 false 改成 true; 失败 / 超时当没问, memory 里的本地正则照扫
 */
import type { Tool } from '../../types/index.js';
import type { ToolResultProvenance } from '../../memory/shortterm.js';
import { cliLogger } from '../../platform/cliLogger.js';
import { resolveProvenance, resolveProvenanceRef } from './provenance.js';

export type ExternalContentClassifier = (
  text: string,
  meta: { toolName: string; ref?: string },
) => Promise<boolean | null>;

export async function resolveToolResultProvenance(input: {
  tool: Tool | undefined;
  toolName: string;
  args: Record<string, any>;
  success: boolean;
  /** 进历史的那份文本 (截断后), 分类器看这份 */
  text: string;
  workspacePath?: string;
  classify?: ExternalContentClassifier;
}): Promise<ToolResultProvenance | undefined> {
  if (!input.success) return undefined;
  if (resolveProvenance(input.tool, input.args, { workspacePath: input.workspacePath }) !== 'external') return undefined;
  const provenance: ToolResultProvenance = { external: true, ref: resolveProvenanceRef(input.tool, input.args) };
  if (input.classify) {
    try {
      const verdict = await input.classify(input.text, { toolName: input.toolName, ref: provenance.ref });
      if (verdict === true) provenance.suspect = true;
    } catch (err: any) {
      cliLogger.warn('TRUST', `external content classifier failed for ${input.toolName}: ${err?.message ?? err}`);
    }
  }
  return provenance;
}

/* runner 只想 import 一行 (体积棘轮): 批次预染色也从这里出 */
export { collectBatchExternalSources, withPendingSources } from './batchTaint.js';
