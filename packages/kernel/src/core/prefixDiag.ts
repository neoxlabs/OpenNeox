import { createHash } from 'crypto';
import { cliLogger } from '../platform/cliLogger.js';

export interface PrefixFingerprint {
  systemHash: string;
  toolsHash: string;
  msgSigs: string[];
  systemText: string;
}

export interface PrefixDiag {
  systemHash: string;
  toolsHash: string;
  msgCount: number;
  prevMsgCount: number;
  systemChanged: boolean;
  toolsChanged: boolean;
  firstDivergentMsgIdx: number;
  divergentRole?: string;
  sysDiff?: { at: number; prevLen: number; curLen: number; prevSnip: string; curSnip: string };
}

const digest = (value: unknown) => createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value))
  .digest('hex')
  .slice(0, 12);

const contentOf = (m: any): string => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''));

function msgSig(m: any): string {
  const c = contentOf(m);
  const tc = Array.isArray(m?.tool_calls) ? m.tool_calls.map((t: any) => `${t?.id}:${t?.function?.name}`).join(',') : '';
  return `${m?.role}|${c.length}|${c.slice(0, 48)}|${c.slice(-48)}|${tc}|${m?.tool_call_id ?? ''}`;
}

export function computePrefixDiag(
  prev: PrefixFingerprint | undefined,
  requestMessages: any[],
  tools: Array<{ name: string; description?: string; parameters?: unknown }>,
  logCtx: { sessionId?: string; model?: string; iteration: number },
): { diag: PrefixDiag; fp: PrefixFingerprint } {
  const systemText = requestMessages.filter((m) => m?.role === 'system').map(contentOf).join('\n\n');
  const systemHash = digest(systemText);
  const toolsHash = digest(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })));
  const msgSigs = requestMessages.map(msgSig);

  let firstDivergentMsgIdx = -1;
  if (prev) {
    const minLen = Math.min(prev.msgSigs.length, msgSigs.length);
    for (let i = 0; i < minLen; i++) {
      if (prev.msgSigs[i] !== msgSigs[i]) { firstDivergentMsgIdx = i; break; }
    }
    if (firstDivergentMsgIdx < 0 && msgSigs.length < prev.msgSigs.length) firstDivergentMsgIdx = msgSigs.length;
  }
  const systemChanged = prev ? prev.systemHash !== systemHash : false;
  let sysDiff: PrefixDiag['sysDiff'];
  if (systemChanged && prev) {
    const a = prev.systemText;
    const b = systemText;
    let d = 0;
    const min = Math.min(a.length, b.length);
    while (d < min && a[d] === b[d]) d++;
    sysDiff = {
      at: d, prevLen: a.length, curLen: b.length,
      prevSnip: a.slice(Math.max(0, d - 20), d + 60).replace(/\n/g, '\\n'),
      curSnip: b.slice(Math.max(0, d - 20), d + 60).replace(/\n/g, '\\n'),
    };
  }
  const diag: PrefixDiag = {
    systemHash, toolsHash, msgCount: msgSigs.length, prevMsgCount: prev?.msgSigs.length ?? -1,
    systemChanged,
    toolsChanged: prev ? prev.toolsHash !== toolsHash : false,
    firstDivergentMsgIdx,
    divergentRole: firstDivergentMsgIdx >= 0 ? requestMessages[firstDivergentMsgIdx]?.role : undefined,
    sysDiff,
  };
  if (process.env.NEOX_CACHE_PROBE === '1') {
    cliLogger.info('CACHE_BREAK', 'prefix divergence check', {
      ...logCtx, systemChanged, toolsChanged: diag.toolsChanged, firstDivergentMsgIdx,
      divergentRole: diag.divergentRole, msgCount: diag.msgCount, prevMsgCount: diag.prevMsgCount,
      toolNames: tools.map((t) => t.name), ...(sysDiff ? { sysDiff } : {}),
    });
  }
  return { diag, fp: { systemHash, toolsHash, msgSigs, systemText } };
}
