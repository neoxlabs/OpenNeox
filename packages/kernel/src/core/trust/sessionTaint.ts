
import type { ToolSideEffect } from './provenance.js';

export interface ExternalSource {
  /** 工具名 (web_fetch / browser_get_text / mcp:xxx …) */
  source: string;
  /** URL / 路径 / server 名; 没有就 undefined */
  ref?: string;
  /** 本地正则或分类器标过"含疑似指令" */
  suspect: boolean;
  at: number;
}

export interface TaintSnapshot {
  tainted: boolean;
  count: number;
  suspectCount: number;
  /** 去重后的来源引用, 给审批卡和芯片用, 最多 5 条 */
  refs: string[];
  /** 最早一次读进外部内容的时刻 —— 之后才出现的文件不是用户原有的数据 (删它不算破坏) */
  firstAt?: number;
}

export class SessionTaint {
  private sources: ExternalSource[] = [];

  add(src: Omit<ExternalSource, 'at'> & { at?: number }): void {
    this.sources.push({ ...src, at: src.at ?? Date.now() });
  }

  isTainted(): boolean {
    return this.sources.length > 0;
  }

  list(): readonly ExternalSource[] {
    return this.sources;
  }

  snapshot(): TaintSnapshot {
    const refs: string[] = [];
    for (const s of this.sources) {
      const r = displayRef(s);
      if (r && !refs.includes(r)) refs.push(r);
      if (refs.length >= 5) break;
    }
    return {
      tainted: this.sources.length > 0,
      count: this.sources.length,
      suspectCount: this.sources.filter((s) => s.suspect).length,
      refs,
      firstAt: this.sources.length > 0 ? Math.min(...this.sources.map((s) => s.at)) : undefined,
    };
  }

  /** 审批理由用的一句话。中文给用户看, 跟审批卡其它文案同语言。 */
  describe(sideEffect: ToolSideEffect, toolName: string): string {
    const snap = this.snapshot();
    const where = snap.refs.length > 0 ? snap.refs.join('、') : `${snap.count} 个外部来源`;
    const action = sideEffect === 'outbound' ? '对外发送 / 提交' : '不可逆删除';
    const sus = snap.suspectCount > 0 ? `; 其中 ${snap.suspectCount} 处含疑似指令` : '';
    return `本会话读过 ${where}${sus}, 现在 ${toolName} 要${action}。外部内容里的指令不算数, 请确认这是你要的。`;
  }

  clear(): void {
    this.sources = [];
  }
}

/** 给人看的来源: URL 只留主机名, 路径只留文件名, 其余原样。 */
export function displayRef(s: Pick<ExternalSource, 'source' | 'ref'>): string {
  const ref = s.ref?.trim();
  if (!ref) return s.source;
  try {
    if (/^https?:\/\//i.test(ref)) return new URL(ref).hostname;
  } catch { /* 不是合法 URL, 往下走 */ }
  if (ref.includes('/') || ref.includes('\\')) {
    const base = ref.split(/[\\/]/).filter(Boolean).pop();
    if (base) return base;
  }
  return ref.length > 40 ? `${ref.slice(0, 37)}…` : ref;
}
