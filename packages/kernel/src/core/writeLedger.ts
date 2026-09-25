/**
 * WriteLedger — 「本轮改动」会员资格 SSOT.
 *
 * 判定句: 路径算 Agent 这轮作品 ⇔ 本轮有一条成功的 WriteDeclaration 显式点名它.
 * FS 时间窗 / git-guilt / 无进程绑定的磁盘推断 一律不决定 membership.
 *
 * evidence:
 *   - tool_ui_meta / tool_result_path — write/edit/delete/rename/create_slides 等
 *   - shell_declared — shell args.output_files（或结果 metadata.declared_paths）
 *   - shell_proc — 非仓储批量命令的 shell 存活期内、由执行器回收的进程树写（桌面侧填）
 */

export type WriteOp = 'write' | 'edit' | 'delete' | 'rename';

export type WriteEvidence =
  | 'tool_ui_meta'
  | 'tool_result_path'
  | 'shell_declared'
  | 'shell_proc';

export interface WriteDeclaration {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  op: WriteOp;
  paths: string[];
  /** rename: 旧路径 */
  from?: string;
  ts: number;
  evidence: WriteEvidence;
  /** 可选 turn 锚 (user_message id); 缺省时按 session + 时间窗 join */
  turnAnchorId?: string;
}

const ledgers = new Map<string, WriteDeclaration[]>();
const MAX_PER_SESSION = 2_000;

export function recordWriteDeclaration(decl: WriteDeclaration): void {
  if (!decl.sessionId || !Array.isArray(decl.paths) || decl.paths.length === 0) return;
  const paths = decl.paths.map((p) => String(p || '').trim()).filter(Boolean);
  if (paths.length === 0) return;
  const cleaned: WriteDeclaration = { ...decl, paths };
  const list = ledgers.get(decl.sessionId) ?? [];
  list.push(cleaned);
  if (list.length > MAX_PER_SESSION) list.splice(0, list.length - MAX_PER_SESSION);
  ledgers.set(decl.sessionId, list);
}

export function getWriteDeclarations(
  sessionId: string,
  opts?: { sinceTs?: number; untilTs?: number; turnAnchorId?: string },
): WriteDeclaration[] {
  const list = ledgers.get(sessionId) ?? [];
  return list.filter((d) => {
    if (opts?.turnAnchorId && d.turnAnchorId && d.turnAnchorId !== opts.turnAnchorId) return false;
    if (typeof opts?.sinceTs === 'number' && d.ts < opts.sinceTs) return false;
    if (typeof opts?.untilTs === 'number' && d.ts > opts.untilTs) return false;
    return true;
  });
}

export function clearWriteLedger(sessionId?: string): void {
  if (sessionId) ledgers.delete(sessionId);
  else ledgers.clear();
}

/** 测试 / 调试 */
export function getAllWriteDeclarations(): WriteDeclaration[] {
  const out: WriteDeclaration[] = [];
  for (const list of ledgers.values()) out.push(...list);
  return out;
}

/**
 * 仓储 / 安装类批量命令 — 关闭 shell_proc 自动回收.
 * 因果副作用不是「本轮作品」; 若真要展示必须显式 output_files.
 */
export function isBulkWorkspaceMutationCommand(command: string): boolean {
  const cmd = String(command ?? '').trim();
  if (!cmd) return false;
  const body = cmd.replace(/^\s*(cd\s+\S+\s*&&\s*)+/i, '').trim();
  const BULK = [
    /\bgit\s+(pull|fetch|clone|checkout|reset|merge|rebase|cherry-pick|submodule)\b/i,
    /\bnpm\s+(i|install|ci|update|uninstall)\b/i,
    /\bpnpm\s+(i|install|update|add|remove)\b/i,
    /\byarn\s+(install|add|remove|upgrade)\b/i,
    /\bbun\s+(install|add|remove|update)\b/i,
    /\bcargo\s+(build|fetch|install|update)\b/i,
    /\bpip3?\s+install\b/i,
    /\bpoetry\s+install\b/i,
    /\bcomposer\s+install\b/i,
    /\bbundle\s+install\b/i,
    /\bgo\s+mod\s+(download|tidy)\b/i,
  ];
  return BULK.some((re) => re.test(body));
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x)).filter((x): x is string => Boolean(x));
}

function parseJsonObject(output: unknown): Record<string, unknown> | null {
  if (typeof output === 'object' && output && !Array.isArray(output)) {
    return output as Record<string, unknown>;
  }
  if (typeof output !== 'string') return null;
  const t = output.trim();
  if (!t.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(t);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function normalizeToolName(name: string): string {
  return String(name || '').toLowerCase().trim();
}

function isShellToolName(name: string): boolean {
  const n = normalizeToolName(name);
  return n === 'execute_shell' || n === 'execute_bash' || n === 'shell' || n === 'bash';
}

function isSuccessStatus(status: unknown, successFlag: boolean): boolean {
  if (!successFlag) return false;
  if (status === 'error') return false;
  return true;
}

export type ExtractToolWriteArgs = {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  success: boolean;
  args?: unknown;
  output?: unknown;
  uiMeta?: {
    file_path?: string;
    status?: string;
    metadata?: Record<string, unknown>;
  };
  ts?: number;
  turnAnchorId?: string;
};

/**
 * 从一次成功的 tool_call_complete 抽出 0..n 条 WriteDeclaration.
 * 供 NeoxEventNormalizer / 测试 / 桌面从 timeline 回放共用.
 */
export function extractWriteDeclarationsFromToolComplete(
  input: ExtractToolWriteArgs,
): WriteDeclaration[] {
  const {
    sessionId,
    toolCallId,
    toolName,
    success,
    args,
    output,
    uiMeta,
    ts = Date.now(),
    turnAnchorId,
  } = input;

  if (!sessionId || !toolCallId || !success) return [];
  if (uiMeta?.status === 'error') return [];

  let parsedArgs = args;
  if (typeof parsedArgs === 'string') {
    try { parsedArgs = JSON.parse(parsedArgs); } catch { parsedArgs = {}; }
  }
  const a = asRecord(parsedArgs) ?? {};
  const out = parseJsonObject(output);
  const meta = uiMeta?.metadata ?? (asRecord(out?.metadata) ?? {});
  const name = normalizeToolName(toolName);
  const base = { sessionId, toolCallId, toolName: name, ts, turnAnchorId };

  /* ── Shell: output_files / metadata.declared_paths ── */
  if (isShellToolName(name)) {
    const declared = [
      ...strList(a.output_files),
      ...strList(a.outputFiles),
      ...strList(meta.declared_paths),
      ...strList(meta.declaredPaths),
      ...strList(meta.affected_paths),
    ];
    const uniq = Array.from(new Set(declared));
    if (uniq.length === 0) return [];
    return [{
      ...base,
      op: 'write',
      paths: uniq,
      evidence: 'shell_declared',
    }];
  }

  /* ── rename / move ── */
  if (name === 'rename_file' || name === 'move_file') {
    const from =
      str(meta.from) || str(a.source_path) || str(a.old_path) || str(a.from) || str(a.source);
    const to =
      str(uiMeta?.file_path)
      || str(out?.file_path)
      || str(meta.to)
      || str(a.destination_path)
      || str(a.new_path)
      || str(a.to)
      || str(a.destination)
      || str(a.path);
    if (!from || !to) return [];
    if (!isSuccessStatus(out?.status ?? uiMeta?.status, success)) return [];
    return [{
      ...base,
      op: 'rename',
      paths: [to],
      from,
      evidence: uiMeta?.file_path ? 'tool_ui_meta' : 'tool_result_path',
    }];
  }

  /* ── delete ── */
  if (name === 'delete_file') {
    const p =
      str(uiMeta?.file_path)
      || str(out?.file_path)
      || str(a.path)
      || str(a.file_path);
    if (!p) return [];
    if (out?.status === 'error') return [];
    return [{
      ...base,
      op: 'delete',
      paths: [p],
      evidence: uiMeta?.file_path ? 'tool_ui_meta' : 'tool_result_path',
    }];
  }

  /* ── create_slides (非标准 ToolResult shape: {success, path}) ── */
  if (name === 'create_slides') {
    const p =
      str(out?.path)
      || str(out?.file_path)
      || str(uiMeta?.file_path)
      || str(a.outputPath)
      || str(a.output_path)
      || str(a.path);
    if (!p) return [];
    if (out && out.success === false) return [];
    return [{
      ...base,
      op: 'write',
      paths: [p],
      evidence: 'tool_result_path',
    }];
  }

  /* ── write / edit ── */
  if (
    name === 'write_file' || name === 'write'
    || name === 'edit_file' || name === 'edit'
  ) {
    const p =
      str(uiMeta?.file_path)
      || str(out?.file_path)
      || str(a.file_path)
      || str(a.filePath)
      || str(a.path);
    if (!p) return [];
    if (out?.status === 'error') return [];
    const op: WriteOp = (name === 'edit_file' || name === 'edit') ? 'edit' : 'write';
    return [{
      ...base,
      op,
      paths: [p],
      evidence: uiMeta?.file_path ? 'tool_ui_meta' : 'tool_result_path',
    }];
  }

  /* ── 通用: uiMeta.file_path 成功写工具兜底 ── */
  if (str(uiMeta?.file_path) && (uiMeta?.status === 'success' || uiMeta?.status === 'already_done' || !uiMeta?.status)) {
    /* 避免把 read 类误记 — 仅当 name 暗示写 */
    if (/write|edit|delete|rename|move|slides|mkdir|create/.test(name)) {
      return [{
        ...base,
        op: /edit/.test(name) ? 'edit' : /delete/.test(name) ? 'delete' : 'write',
        paths: [str(uiMeta!.file_path)!],
        evidence: 'tool_ui_meta',
      }];
    }
  }

  return [];
}

/** 把声明折叠成 path → 最终 op (后写覆盖). */
export function foldWriteDeclarations(
  decls: WriteDeclaration[],
): Map<string, { op: WriteOp; from?: string; evidence: WriteEvidence; toolCallId: string; toolName: string }> {
  const map = new Map<string, { op: WriteOp; from?: string; evidence: WriteEvidence; toolCallId: string; toolName: string }>();
  for (const d of decls) {
    if (d.op === 'rename' && d.from) {
      map.delete(d.from);
      const to = d.paths[0];
      if (to) {
        map.set(to, {
          op: 'rename',
          from: d.from,
          evidence: d.evidence,
          toolCallId: d.toolCallId,
          toolName: d.toolName,
        });
      }
      continue;
    }
    for (const p of d.paths) {
      map.set(p, {
        op: d.op,
        evidence: d.evidence,
        toolCallId: d.toolCallId,
        toolName: d.toolName,
      });
    }
  }
  return map;
}
