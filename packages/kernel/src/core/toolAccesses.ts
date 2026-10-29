/**
 * ToolAccesses — 工具资源访问声明 + 冲突检测 + 调度算法
 *
 * 解决静态白名单 (parallelSafeTools) 的局限:
 *   白名单只能回答"这个工具一般来说并行不并行安全", 不知道运行时具体哪个文件 /
 *   哪个 port. 例: `edit /a.ts` 和 `readfile /a.ts` 静态白名单视角 edit=write
 *   全串行, readfile=read 全并行, 但实际两者动同一文件有读写竞争.
 *
 * 这个模块用 **resource-level 声明** 让工具能精准说"我读 X / 我写 Y", 调度器算
 * 冲突图, 同一批次内**任意两个不冲突**才放进去并行, 互冲突放下一批次串行.
 *
 * 设计原则:
 *   - 纯函数, 无 I/O, 无状态 — 调用方决定何时 schedule + 怎么传 access set
 *   - resource 是字符串 ID, 调用方负责 normalize (路径绝对化 / port 数字化等)
 *   - 调度算法贪心 (graph coloring NP-hard, 贪心够用 + 稳定顺序)
 *
 * 集成方式 (后续接入 toolOrchestration/batch.ts 时):
 *   1. Tool 接口加 `getAccessSet?(args): ToolAccessSet`
 *   2. batch.ts 收到 tool calls 后 → 算 access sets → scheduleByAccess → 按 batch 跑
 *   3. 不实现 getAccessSet 的 tool fallback 到 parallelSafeTools 静态白名单
 */

// ============================================================================
// 类型
// ============================================================================

export type AccessKind =
  | 'read'       // 读. 多个 read 同 resource 不冲突.
  | 'write'      // 写 / 修改. 任意其它访问同 resource 冲突.
  | 'exclusive'; // 独占. 任意其它访问 (read/write/exclusive) 同 resource 冲突.

export interface ResourceAccess {
  kind: AccessKind;
  /**
   * 资源 ID. 调用方决定语义:
   *   - 文件: 用绝对路径或 workspace 相对路径 (调用前 normalize)
   *   - 端口: `port:8080` / `port:tcp:8080`
   *   - 锁: `lock:db-migration` / `lock:npm-install`
   *   - 网络: `host:api.example.com`
   *
   * 完全相同字符串才算同资源 — 大小写敏感, 不做语义判等.
   */
  resource: string;
}

export interface ToolAccessSet {
  /** 工具运行期访问的所有资源 (可空 — 视为无访问声明, 与任何 set 都不冲突). */
  accesses: ResourceAccess[];
}

// ============================================================================
// 冲突判定
// ============================================================================

/**
 * 两条 access 是否冲突.
 *
 * 不同 resource → false (无关).
 * 同 resource → 看 kind 组合:
 *   - read+read = false
 *   - 其它任意组合 = true
 */
export function accessesConflict(a: ResourceAccess, b: ResourceAccess): boolean {
  if (a.resource !== b.resource) return false;
  if (a.kind === 'read' && b.kind === 'read') return false;
  return true;
}

/**
 * 两个 access set 是否冲突. 笛卡尔积扫描, 任一对冲突即 true.
 * 空 set 跟任何 set 都不冲突.
 */
export function setsConflict(a: ToolAccessSet, b: ToolAccessSet): boolean {
  if (a.accesses.length === 0 || b.accesses.length === 0) return false;
  for (const ax of a.accesses) {
    for (const bx of b.accesses) {
      if (accessesConflict(ax, bx)) return true;
    }
  }
  return false;
}

// ============================================================================
// 调度
// ============================================================================

/**
 * 按 access 冲突把 items 分批: 同 batch 内任意两个不冲突 (可并行), 不同 batch 串行.
 *
 * 贪心算法 (稳定顺序):
 *   按 input 顺序遍历, 对每 item, 找第一个不跟其冲突的现有 batch 放入;
 *   找不到就开新 batch (append 到末尾).
 *
 * 时间复杂度 O(n² × m) 最坏, m=每个 set 平均 access 数. 一轮 tool call 数通常 ≤10,
 * 完全够用. 不追求最少 batch 数 (那是 NP-hard, 贪心已 work).
 *
 * 例:
 *   items = [readA, readA, writeA, readB]
 *   batches = [[readA, readA, readB], [writeA]]
 *   readA × 2 + readB 同 batch (互不冲突), writeA 单独 (跟 readA 冲突)
 *
 * @param items 待调度的对象 (任意类型, 调用方知道是 tool call 还是别的)
 * @param getSet 从 item 拿 access set 的函数. 返 {accesses:[]} 表示无声明, 跟谁都不冲突
 * @returns 二维数组, 外层=串行 batch 顺序, 内层=该 batch 内可并行的 items (保持输入相对顺序)
 */
export function scheduleByAccess<T>(
  items: T[],
  getSet: (item: T) => ToolAccessSet,
): T[][] {
  if (items.length === 0) return [];

  const batches: Array<{ items: T[]; combinedSet: ToolAccessSet }> = [];

  for (const item of items) {
    const itemSet = getSet(item);
    let placed = false;

    for (const batch of batches) {
      if (!setsConflict(batch.combinedSet, itemSet)) {
        batch.items.push(item);
        /* 合并 set 进 batch 累积 (后续比对快速判断) */
        batch.combinedSet = {
          accesses: [...batch.combinedSet.accesses, ...itemSet.accesses],
        };
        placed = true;
        break;
      }
    }

    if (!placed) {
      batches.push({ items: [item], combinedSet: { accesses: [...itemSet.accesses] } });
    }
  }

  return batches.map((b) => b.items);
}

// ============================================================================
// 辅助 — 构造常用 access set
// ============================================================================

/** 快捷: 单读. */
export function read(resource: string): ResourceAccess {
  return { kind: 'read', resource };
}

/** 快捷: 单写. */
export function write(resource: string): ResourceAccess {
  return { kind: 'write', resource };
}

/** 快捷: 单独占. */
export function exclusive(resource: string): ResourceAccess {
  return { kind: 'exclusive', resource };
}

/** 快捷: 空 set (任意工具默认值, 跟谁都不冲突). */
export const EMPTY_ACCESS_SET: ToolAccessSet = { accesses: [] };

/** 快捷: 构造 access set. */
export function accessSet(...accesses: ResourceAccess[]): ToolAccessSet {
  return { accesses };
}
