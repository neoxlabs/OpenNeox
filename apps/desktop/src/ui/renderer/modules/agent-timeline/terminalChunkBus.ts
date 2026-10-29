type ChunkListener = (chunk: string) => void;

type LogEntry = {
  /* 顺序保留的 chunk 段, join 起来就是字节级历史. 单段不切分, 切分会破坏 ANSI 多字节序列. */
  chunks: string[];
  bytes: number;
};

const MAX_BYTES_PER_TOOL = 256 * 1024;

/* 主索引: toolId → LogEntry / listeners. 老 timeline 卡片 (shell tool result) 走这条. */
const listenersByTool = new Map<string, Set<ChunkListener>>();
const log = new Map<string, LogEntry>();

/* 辅助索引: pid → toolId. emit 时如果 event 带 pid 就建立映射, 给 by-pid 订阅反查 buffer.
 * 一个 PTY 子进程 OS pid 在生命周期内对应一个 toolId, 1:1 不会冲突. */
const pidToTool = new Map<number, string>();
const listenersByPid = new Map<number, Set<ChunkListener>>();

function appendToLog(toolId: string, delta: string): void {
  let entry = log.get(toolId);
  if (!entry) {
    entry = { chunks: [], bytes: 0 };
    log.set(toolId, entry);
  }
  entry.chunks.push(delta);
  entry.bytes += delta.length;
  /* 超上限就从头丢段, 保留最近 256KB. while + length > 1 防止把唯一一段丢空. */
  while (entry.bytes > MAX_BYTES_PER_TOOL && entry.chunks.length > 1) {
    const dropped = entry.chunks.shift()!;
    entry.bytes -= dropped.length;
  }
  /* 单段就超上限 (npm install 一行 10MB 这种极端情况): 截尾保留最后 256KB.
   * 字节切割可能切到多字节 UTF-8 中间, xterm 容忍坏字节. ANSI 序列被切是小概率灾难,
   * 不在主线场景里, 接受这个代价换内存上限保证. */
  if (entry.chunks.length === 1 && entry.bytes > MAX_BYTES_PER_TOOL) {
    entry.chunks[0] = entry.chunks[0].slice(-MAX_BYTES_PER_TOOL);
    entry.bytes = entry.chunks[0].length;
  }
}

export function emitTerminalChunk(toolId: string, delta: string, pid?: number): void {
  if (!toolId || !delta) return;
  appendToLog(toolId, delta);
  if (typeof pid === 'number' && pid > 0) {
    pidToTool.set(pid, toolId);
  }
  const tlist = listenersByTool.get(toolId);
  if (tlist) for (const fn of tlist) {
    try { fn(delta); } catch { /* listener 自己负责不抛 */ }
  }
  if (typeof pid === 'number' && pid > 0) {
    const plist = listenersByPid.get(pid);
    if (plist) for (const fn of plist) {
      try { fn(delta); } catch { /* listener 自己负责不抛 */ }
    }
  }
}

/**
 * 订阅 toolId 的字节流. 订阅瞬间 sync 把已有 ring buffer 全量重放给 fn 一次
 * (一整段合并 string), 之后每条新 chunk 单独调 fn.
 */
export function subscribeTerminalChunk(toolId: string, fn: ChunkListener): () => void {
  if (!toolId) return () => { /* noop */ };
  const existing = log.get(toolId);
  if (existing && existing.bytes > 0) {
    try { fn(existing.chunks.join('')); } catch { /* listener 自己负责不抛 */ }
  }
  let set = listenersByTool.get(toolId);
  if (!set) {
    set = new Set();
    listenersByTool.set(toolId, set);
  }
  set.add(fn);
  return () => {
    const s = listenersByTool.get(toolId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) listenersByTool.delete(toolId);
  };
}

/**
 * 按 PTY pid 订阅. 服务面板 ShellConsole 用 — 用户在左栏选中一个 service (pid 已知),
 * 右下 xterm 直接 subscribe(pid) 看实时输出.
 *
 * 订阅瞬间从 pidToTool 反查 toolId 拿到 buffer 一次性 replay, 之后 live emit.
 * 如果还没有任何 chunk 到 (PTY 刚 spawn, daemon 还没推流), buffer 是空, replay 一次也是
 * 空字符串 — 后续真有 chunk 来时 emit 路径会同时推到 by-pid listeners, 不丢序列.
 */
export function subscribeTerminalChunkByPid(pid: number, fn: ChunkListener): () => void {
  if (!pid || pid <= 0) return () => { /* noop */ };
  const toolId = pidToTool.get(pid);
  if (toolId) {
    const existing = log.get(toolId);
    if (existing && existing.bytes > 0) {
      try { fn(existing.chunks.join('')); } catch { /* listener 自己负责不抛 */ }
    }
  }
  let set = listenersByPid.get(pid);
  if (!set) {
    set = new Set();
    listenersByPid.set(pid, set);
  }
  set.add(fn);
  return () => {
    const s = listenersByPid.get(pid);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) listenersByPid.delete(pid);
  };
}

/** 显式清理某个 toolId 的 ring buffer. timeline entry 被永久删除时可以调.
 *  目前没主动调用点 — 整个 renderer 占用上限 = 活跃 toolId 数 × 256KB, 可接受. */
export function clearTerminalChunkLog(toolId: string): void {
  log.delete(toolId);
}
