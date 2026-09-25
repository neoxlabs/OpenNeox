/**
 * NeoxEventNormalizer — 统一事件规范化层
 *
 * 职责：把 agentLoop callbacks 里的原始事件转换为标准 runtime_event 格式，
 * 同时处理所有需要"解析 output 补发"的工具事件（edit_file_stream, write_file_stream）。
 *
 * 设计原则：
 * - 一个事件只走一条路
 * - sessionId 永远随事件携带，不依赖外部猜测
 * - 工具特殊事件（edit/write）在这里集中处理，而不是在各处打补丁
 */

import {
  extractWriteDeclarationsFromToolComplete,
  recordWriteDeclaration,
} from '@neoxlabs/kernel/core/writeLedger.js';
import { getGlobalUserHookRunner } from '../../core/userHooks.js';

/** 语言映射表 */
const EXT_LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', vue: 'vue', svelte: 'svelte',
  json: 'json', yaml: 'yaml', yml: 'yaml',
  md: 'markdown', sql: 'sql', sh: 'bash', rb: 'ruby', swift: 'swift',
};

function inferLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return EXT_LANG_MAP[ext] || ext;
}

export type NormalizedEventEmitter = (agentId: string, event: Record<string, any>) => void;

export class NeoxEventNormalizer {
  private readonly sessionId: string;
  private readonly agentId: string;
  private readonly emit: NormalizedEventEmitter;
  private toolStartTimes: Map<string, number> = new Map();
  private toolArgsById: Map<string, any> = new Map();

  constructor(sessionId: string, agentId: string, emit: NormalizedEventEmitter) {
    this.sessionId = sessionId;
    this.agentId = agentId;
    this.emit = emit;
  }

  // ── 文本流 ──────────────────────────────────────────────────────────────────

  onTextDelta(delta: string): void {
    this.emit(this.agentId, {
      type: 'text',
      delta,
      sessionId: this.sessionId,
    });
  }

  onReasoningDelta(delta: string): void {
    this.emit(this.agentId, {
      type: 'reasoning_delta',
      delta,
      sessionId: this.sessionId,
    });
  }

  onTextComplete(): void {
    this.emit(this.agentId, {
      type: 'text_complete',
      sessionId: this.sessionId,
    });
  }

  onReasoningComplete(): void {
    this.emit(this.agentId, {
      type: 'reasoning_complete',
      sessionId: this.sessionId,
    });
  }

  // ── 工具调用 ─────────────────────────────────────────────────────────────────

  onToolCallStreaming(toolName: string, toolCallId: string): void {
    this.emit(this.agentId, {
      type: 'tool_call_streaming',
      toolName,
      toolCallId,
      sessionId: this.sessionId,
    });
  }

  onToolCallStreamingUpdate(data: any): void {
    this.emit(this.agentId, {
      type: 'tool_call_streaming_update',
      toolCallId: data.toolCallId,
      toolName: data.toolName,
      phase: data.phase,
      partialContent: data.partialContent,
      filePath: data.filePath,
      argsLength: data.argsLength,
      /* open_surface streaming 专用字段 */
      surfaceKind: data.surfaceKind,
      surfaceTitle: data.surfaceTitle,
      surfacePinned: data.surfacePinned,
      sessionId: this.sessionId,
    });
  }

  onToolCallStart(id: string, name: string, args: any): void {
    this.toolStartTimes.set(id, Date.now());
    this.toolArgsById.set(id, args);
    this.emit(this.agentId, {
      type: 'tool_call_start',
      id,
      name,
      arguments: args,
      sessionId: this.sessionId,
    });
  }

  onToolCallComplete(
    id: string,
    name: string,
    output: any,
    success: boolean,
    uiMeta?: import('@neoxlabs/kernel/core/types/toolResult.js').ToolUiMeta,
  ): void {
    const startedAt = this.toolStartTimes.get(id);
    this.toolStartTimes.delete(id);
    const originalArgs = this.toolArgsById.get(id);
    this.toolArgsById.delete(id);
    const durationMs = typeof startedAt === 'number' ? Date.now() - startedAt : undefined;

    // 基础 tool_output 事件
    let parsedArgs = originalArgs;
    if (typeof originalArgs === 'string') {
      try { parsedArgs = JSON.parse(originalArgs); } catch { parsedArgs = {}; }
    }
    // uiMeta.file_path 优先 (来自工具自声明的 ToolResult),fallback 到 args 推断
    const targetPath = uiMeta?.file_path
      || parsedArgs?.file_path || parsedArgs?.filePath || parsedArgs?.path
      || parsedArgs?.directory || '';
    this.emit(this.agentId, {
      type: 'tool_output',
      id,
      name,
      output,
      success,
      duration: durationMs,
      targetPath: targetPath || undefined,
      args: parsedArgs,
      sessionId: this.sessionId,
      // 双轨道分离 —— uiMeta 字段扁平化展开给下游 UI 消费.
      // 工具返回 ToolResult 时这些字段有值,否则 undefined.
      summary: uiMeta?.summary,
      toolStatus: uiMeta?.status,
      toolKind: uiMeta?.kind,
      toolError: uiMeta?.error,
      metadata: uiMeta?.metadata,
    });

    /* PostToolUseFailure —— 只在失败时触发。
     *
     * 为什么接在这里而不是 kernel: kernel 的 hook stage 只有 postSuccess (成功路径),
     * 失败路径没有钩子, 而加一个要改 kernel 的公共接口 (影响所有 host)。
     * 这一层拿得到 success 标志, 且**不会跟成功路径重复** —— 成功那半边由
     * runtimeBuilder 接的 kernel postSuccess 负责。
     * 通知式, 不 await: 工具失败已经够让人等的了, 不该再排一个用户脚本。 */
    if (!success) {
      void (async () => {
        try {
          const hooks = getGlobalUserHookRunner();
          if (!hooks?.hasHooksFor('PostToolUseFailure')) return;
          await hooks.fire('PostToolUseFailure', {
            toolName: name,
            toolArgs: parsedArgs as Record<string, any>,
            toolResult: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
            payload: { session_id: this.sessionId, error: uiMeta?.error, duration_ms: durationMs },
          });
        } catch { /* 通知式: hook 出错不影响任何事 */ }
      })();
    }

    // WriteLedger: 成功写意图 → 账本 + agent_wrote_path（本轮改动 membership SSOT）
    if (success && this.sessionId) {
      this._recordWriteDeclarations(id, name, output, parsedArgs, uiMeta);
    }

    // edit_file：解析结果，补发 edit_file_stream（diff 卡片）
    const normalizedName = (name || '').toLowerCase();
    if ((normalizedName === 'edit_file' || normalizedName === 'edit') && success) {
      this._tryEmitEditFileStream(id, output, parsedArgs);
    }

    // write_file：补发 write_file_stream
    if ((normalizedName === 'write_file' || normalizedName === 'write') && success) {
      this._tryEmitWriteFileStream(name, output, originalArgs);
    }

    // update_plan 在 assistant 模式下需要显式补发 plan_update，供 UI 渲染计划卡片
    this._tryEmitPlanUpdate(name, originalArgs, output, success);
  }

  // ── 原始 chunk（透传给 token_usage 处理） ────────────────────────────────────

  onRawChunk(chunk: any): void {
    this.emit(this.agentId, {
      type: 'raw_response_event',
      data: chunk,
      sessionId: this.sessionId,
    });
  }

  onUsage(usage: any): void {
    this.emit(this.agentId, {
      type: 'token_usage',
      usage,
      sessionId: this.sessionId,
    });
  }

  onError(message: string): void {
    this.emit(this.agentId, {
      type: 'error',
      message,
      sessionId: this.sessionId,
    });
  }

  onGracefulError(text: string): void {
    // 降级回复像正常文本一样流到 UI
    this.onTextDelta(text);
  }

  // ── 私有工具方法 ───────────────────────────────────────────────────────────

  private _recordWriteDeclarations(
    toolCallId: string,
    name: string,
    output: any,
    parsedArgs: any,
    uiMeta?: import('@neoxlabs/kernel/core/types/toolResult.js').ToolUiMeta,
  ): void {
    try {
      const decls = extractWriteDeclarationsFromToolComplete({
        sessionId: this.sessionId,
        toolCallId,
        toolName: name,
        success: true,
        args: parsedArgs,
        output,
        uiMeta,
        ts: Date.now(),
      });
      for (const d of decls) {
        recordWriteDeclaration(d);
        this.emit(this.agentId, {
          type: 'agent_wrote_path',
          sessionId: d.sessionId,
          toolCallId: d.toolCallId,
          toolName: d.toolName,
          op: d.op,
          paths: d.paths,
          from: d.from,
          evidence: d.evidence,
          timestamp: d.ts,
        });
      }
    } catch {
      /* 账本失败绝不能打断 tool_output 主路径 */
    }
  }

  private _tryEmitPlanUpdate(name: string, args: any, output: any, success: boolean): void {
    if (!success) return;

    // 不是对象。需要先 parse，否则 payload.plan 永远是 undefined → plan_update 永远不发射。
    let parsedArgs = args;
    if (typeof args === 'string') {
      try {
        parsedArgs = JSON.parse(args);
      } catch {
        return; // 参数无法解析，跳过
      }
    }

    const normalizedName = (name || '').toLowerCase();
    let payload: any = null;

    if (normalizedName === 'update_plan') {
      payload = parsedArgs;
    } else if (normalizedName === 'call_tool' && parsedArgs?.name === 'update_plan') {
      payload = parsedArgs?.args;
    }

    if (!payload || !Array.isArray(payload.plan)) {
      return;
    }

    if (typeof output === 'string') {
      try {
        const parsed = JSON.parse(output);
        if (parsed && typeof parsed === 'object' && parsed.success === false) {
          return;
        }
      } catch {
        // output 非 JSON 或不可解析时忽略，按 success=true 继续
      }
    }

    const plan = payload.plan
      .map((step: any) => {
        const content = typeof step?.step === 'string'
          ? step.step
          : (typeof step?.content === 'string' ? step.content : '');
        const status = step?.status;
        if (!content) return null;
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
          return null;
        }
        return { step: content, status };
      })
      .filter((step: any): step is { step: string; status: 'pending' | 'in_progress' | 'completed' } => Boolean(step));

    if (plan.length === 0) return;

    this.emit(this.agentId, {
      type: 'plan_update',
      explanation: typeof payload.explanation === 'string' ? payload.explanation : undefined,
      plan,
      sessionId: this.sessionId,
      timestamp: Date.now(),
    });
  }

  private _tryEmitEditFileStream(toolId: string, output: any, toolArgs?: any): void {
    try {
      const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
      const result = JSON.parse(outputStr);
      if (result.status === 'success' && result.file_path) {
        const savedArgs = toolArgs || {};
        const argOldStr = savedArgs?.old_string || savedArgs?.old_str || '';
        const argNewStr = savedArgs?.new_string || savedArgs?.new_str || '';
        const metadataHunks = Array.isArray(result.metadata?.hunks) ? result.metadata.hunks : [];
        const hunksPayload = metadataHunks
          .map((hunk: any) => ({
            oldString: typeof hunk?.old_preview === 'string' ? hunk.old_preview : argOldStr,
            newString: typeof hunk?.new_preview === 'string' ? hunk.new_preview : argNewStr,
            startLine: typeof hunk?.start_line === 'number'
              ? hunk.start_line
              : (result.metadata?.start_line || savedArgs?.start_line || 1),
            oldLineCount: typeof hunk?.old_preview_lines === 'number'
              ? hunk.old_preview_lines
              : (typeof hunk?.old_line_count === 'number' ? hunk.old_line_count : undefined),
            newLineCount: typeof hunk?.new_preview_lines === 'number'
              ? hunk.new_preview_lines
              : (typeof hunk?.new_line_count === 'number' ? hunk.new_line_count : undefined),
            oldCharCount: typeof hunk?.old_preview_chars === 'number' ? hunk.old_preview_chars : undefined,
            newCharCount: typeof hunk?.new_preview_chars === 'number' ? hunk.new_preview_chars : undefined,
            previewTruncated: Boolean(hunk?.preview_truncated),
          }))
          .filter((hunk: any) => typeof hunk.startLine === 'number');
        const firstHunk = hunksPayload[0];
        const oldStr = firstHunk?.oldString ?? argOldStr;
        const newStr = firstHunk?.newString ?? argNewStr;
        const startLine = firstHunk?.startLine ?? result.metadata?.start_line ?? savedArgs?.start_line ?? 1;
        const previewTruncated = Boolean(
          result.metadata?.preview_truncated
          || hunksPayload.some((hunk: any) => Boolean(hunk?.previewTruncated))
        );
        const hunksOmitted = Number.isFinite(Number(result.metadata?.hunks_omitted))
          ? Math.max(0, Number(result.metadata?.hunks_omitted))
          : 0;

        this.emit(this.agentId, {
          type: 'edit_file_stream',
          toolId,
          filePath: result.file_path,
          oldString: oldStr,
          newString: newStr,
          startLine,
          previewTruncated,
          hunksOmitted,
          hunks: hunksPayload.length > 0 ? hunksPayload : undefined,
          isComplete: true,
          language: inferLanguage(result.file_path),
          sessionId: this.sessionId,
          timestamp: Date.now(),
        });
      }
    } catch {
      // 解析失败不影响流程，edit 卡片降级为 tool_output 显示
    }
  }

  private _tryEmitWriteFileStream(name: string, output: any, originalArgs?: any): void {
    try {
      const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
      const result = JSON.parse(outputStr);
      if (result.status === 'success' && result.file_path) {
        // agentLoop 传入的 args 是 JSON 字符串（tc.function.arguments），需要 parse
        let parsedArgs = originalArgs;
        if (typeof originalArgs === 'string') {
          try { parsedArgs = JSON.parse(originalArgs); } catch { parsedArgs = null; }
        }
        const content = parsedArgs?.content || result.content || result.new_content;
        if (content) {
          this.emit(this.agentId, {
            type: 'write_file_stream',
            filePath: result.file_path,
            content,
            isComplete: true,
            language: inferLanguage(result.file_path),
            sessionId: this.sessionId,
            timestamp: Date.now(),
          });
        }
      }
    } catch {
      // 忽略，write_file_stream 是可选增强
    }
  }
}
