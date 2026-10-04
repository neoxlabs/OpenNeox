import type { Tool } from '../../types/index.js';
import type { ParsedToolArguments } from '../toolArgsParser.js';
import { resolveProvenance, resolveProvenanceRef, type ToolSideEffect } from './provenance.js';
import { SessionTaint, type ExternalSource, type TaintSnapshot } from './sessionTaint.js';

export interface TaintView {
  isTainted(): boolean;
  describe(sideEffect: ToolSideEffect, toolName: string): string;
  snapshot(): TaintSnapshot;
}

/** 本批次待落地的外部来源 + 它出自哪一个调用 (callKey) —— 过闸时那个调用自己的那条不算。 */
export type PendingExternalSource = ExternalSource & { callKey: string };

/** 同一个调用的身份: 工具名 + 入参。审批口拿不到 call id, 只有 (tool, args)。
 *  call_tool 是派发器, 过闸的是被包的真工具 (runner 的 checkNestedToolGate), 所以按里面那层算。 */
export function batchCallKey(name: string, args: Record<string, any> | undefined): string {
  if (name === 'call_tool' && typeof args?.name === 'string') return batchCallKey(args.name, args.args);
  try { return `${name}\u0000${JSON.stringify(args ?? {})}`; } catch { return name; }
}

/** 这一批里哪些调用会带回外部内容。 */
export function collectBatchExternalSources(input: {
  tools: Tool[];
  calls: Array<{ id: string; function?: { name?: string }; name?: string }>;
  parsedArgsByToolId: Map<string, ParsedToolArguments>;
  workspacePath?: string;
}): PendingExternalSource[] {
  const out: PendingExternalSource[] = [];
  for (const call of input.calls) {
    const name = call.function?.name ?? call.name ?? '';
    const tool = input.tools.find((t) => t.name === name);
    if (!tool) continue;
    const args = (input.parsedArgsByToolId.get(call.id)?.args ?? {}) as Record<string, any>;
    if (resolveProvenance(tool, args, { workspacePath: input.workspacePath }) !== 'external') continue;
    out.push({ source: name, ref: resolveProvenanceRef(tool, args), suspect: false, at: Date.now(), callKey: batchCallKey(name, args) });
  }
  return out;
}

export function withPendingSources(
  base: SessionTaint,
  pending: readonly PendingExternalSource[],
  self?: { name: string; args: Record<string, any> | undefined },
): TaintView {
  const selfKey = self ? batchCallKey(self.name, self.args) : undefined;
  const others = selfKey ? pending.filter((s) => s.callKey !== selfKey) : pending;
  if (others.length === 0) return base;
  const merged = new SessionTaint();
  for (const s of base.list()) merged.add(s);
  for (const { callKey: _k, ...s } of others) merged.add(s);
  return merged;
}
